/**
 * Place clustering pipeline.
 *
 *   behavioral_pings  →  DBSCAN clusters  →  places (upsert)
 *
 * Read-modify-write: we recompute clusters from the most recent N days of
 * pings each run, then upsert the resulting places. Idempotent — a place
 * that's already in the table gets its `last_seen` and `visit_count`
 * refreshed, not duplicated.
 *
 * Parameters baked in for the prototype:
 *   PING_WINDOW_DAYS = 30   → rolling window of pings to consider
 *   EPSILON_METERS   = 100  → "the same place" radius
 *   MIN_PINGS        = 5    → must be observed 5+ times to count as a place
 *
 * These will become user-tunable later.
 */

import {
  centroidOf,
  dbscan,
  decodeGeohash,
  encodeGeohash,
  type GeoPoint,
} from './clustering';
import { supabase } from './supabase';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;

const PING_WINDOW_DAYS = 30;
const EPSILON_METERS = 100;
const MIN_PINGS = 5;

export type ClusterPlaceMatch = {
  /** geohash-7 used as the dedup key for upsert. */
  geohash7: string;
  geohash5: string;
  centroidLat: number;
  centroidLon: number;
  visitCount: number;
  firstSeen: string; // ISO
  lastSeen: string;  // ISO
};

/**
 * Run the clustering pipeline for the current user.
 *
 * Returns a summary the caller (UI) can show. Inserts/updates rows in
 * `places` as a side-effect.
 */
export async function recomputePlacesForCurrentUser(): Promise<{
  pingsRead: number;
  clustersFound: number;
  placesUpserted: number;
  error?: string;
}> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { pingsRead: 0, clustersFound: 0, placesUpserted: 0, error: 'not signed in' };

  // 1. fetch pings from the rolling window
  const since = new Date(Date.now() - PING_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: pings, error: pingErr } = await supabase
    .from('behavioral_pings')
    .select('captured_at, geohash_8')
    .eq('user_id', session.user.id)
    .gte('captured_at', since)
    .order('captured_at', { ascending: true });

  if (pingErr) return { pingsRead: 0, clustersFound: 0, placesUpserted: 0, error: pingErr.message };
  if (!pings || pings.length === 0) {
    return { pingsRead: 0, clustersFound: 0, placesUpserted: 0 };
  }

  // 2. decode geohashes → lat/lon points (carry timestamp via meta)
  const points: GeoPoint[] = pings.map((p) => {
    const { lat, lon } = decodeGeohash(p.geohash_8);
    return { lat, lon, meta: p.captured_at };
  });

  // 3. cluster
  const clusters = dbscan(points, EPSILON_METERS, MIN_PINGS);

  // 4. build place rows
  const places: ClusterPlaceMatch[] = clusters.map((c) => {
    const memberPoints = c.indices.map((i) => points[i]);
    const memberTimes = c.indices.map((i) => String(points[i].meta));
    const { lat, lon } = centroidOf(memberPoints);
    memberTimes.sort();
    return {
      geohash7: encodeGeohash(lat, lon, 7),
      geohash5: encodeGeohash(lat, lon, 5),
      centroidLat: lat,
      centroidLon: lon,
      visitCount: memberPoints.length,
      firstSeen: memberTimes[0]!,
      lastSeen: memberTimes[memberTimes.length - 1]!,
    };
  });

  if (places.length === 0) {
    return { pingsRead: pings.length, clustersFound: 0, placesUpserted: 0 };
  }

  // 5. upsert by (user_id, geohash_7) — geohash_7 ≈ 150 m cell, stable enough
  //    to be the natural dedup key for "same place across re-runs"
  const upsertRows = places.map((p) => ({
    user_id: session.user.id,
    geohash_7: p.geohash7,
    geohash_5: p.geohash5,
    visit_count: p.visitCount,
    first_seen: p.firstSeen,
    last_seen: p.lastSeen,
    inference_status: 'pending' as const,
  }));

  // We don't have a unique constraint on (user_id, geohash_7) yet.
  // For the prototype: read existing places for this user, merge, write back.
  const { data: existing, error: existErr } = await supabase
    .from('places')
    .select('id, geohash_7, visit_count, first_seen')
    .eq('user_id', session.user.id);

  if (existErr) return { pingsRead: pings.length, clustersFound: clusters.length, placesUpserted: 0, error: existErr.message };

  const byHash = new Map(existing?.map((r) => [r.geohash_7, r]) ?? []);

  let upserted = 0;
  for (const row of upsertRows) {
    const prior = byHash.get(row.geohash_7);
    if (prior) {
      // merge: keep earliest first_seen, take latest visit_count
      const { error } = await supabase
        .from('places')
        .update({
          visit_count: row.visit_count,
          last_seen: row.last_seen,
          first_seen: prior.first_seen ?? row.first_seen,
          updated_at: new Date().toISOString(),
        })
        .eq('id', prior.id);
      if (!error) upserted++;
    } else {
      const { error } = await supabase.from('places').insert(row);
      if (!error) upserted++;
    }
  }

  return {
    pingsRead: pings.length,
    clustersFound: clusters.length,
    placesUpserted: upserted,
  };
}

/**
 * Call the `resolve-places` Edge Function to label any unresolved places
 * with Google Places identity (name, type, category, sensitive flag).
 */
export async function resolvePlaceIdentities(): Promise<{
  resolved: number;
  total: number;
  error?: string;
}> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { resolved: 0, total: 0, error: 'not signed in' };

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/resolve-places`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    if (!res.ok) return { resolved: 0, total: 0, error: body?.error ?? `HTTP ${res.status}` };
    return { resolved: body.resolved ?? 0, total: body.total ?? 0 };
  } catch (e) {
    return {
      resolved: 0,
      total: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
