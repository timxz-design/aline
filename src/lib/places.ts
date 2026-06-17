/**
 * Place clustering pipeline.
 *
 *   behavioral_pings  →  DBSCAN clusters  →  places (upsert) + auto-labelling
 *
 * Every clustering run also:
 *   - computes real visit_count (session count, not raw ping count) by
 *     walking pings in time order and counting entry transitions
 *   - runs the time-of-day inference (place-inference.ts) to auto-label
 *     'Home' and 'Work / school' clusters with a confidence score
 *   - preserves user-confirmed/corrected labels; only auto-fills the name,
 *     category, and confidence for places that are still 'pending'
 *   - flags one-off outings as is_hidden when first inserted (user can
 *     unhide them via Profile)
 *
 * Parameters:
 *   PING_WINDOW_DAYS = 30   → rolling window of pings to consider
 *   EPSILON_METERS   = 100  → "the same place" radius
 *   MIN_PINGS        = 5    → must be observed 5+ times to count as a place
 */

import {
  centroidOf,
  dbscan,
  decodeGeohash,
  encodeGeohash,
  type GeoPoint,
} from './clustering';
import {
  inferPlaceLabel,
  statusFromConfidence,
  type PlaceInferencePing,
} from './place-inference';
import { supabase } from './supabase';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;

const PING_WINDOW_DAYS = 30;
const EPSILON_METERS = 100;
const MIN_PINGS = 5;

type RawPing = { captured_at: string; geohash_8: string };

export type ClusterPlaceRow = {
  geohash7: string;
  geohash5: string;
  centroidLat: number;
  centroidLon: number;
  visitCount: number;        // real session count (entry transitions)
  pingCount: number;          // raw assigned pings
  firstSeen: string;
  lastSeen: string;
  // From inferPlaceLabel — we still write these even though they may be
  // overridden later by resolve-places (Google match wins).
  inferredName: string | null;
  inferredCategory: string | null;
  inferredConfidence: number;
  hideAsOuting: boolean;
};

/**
 * Walk pings in time order. For each cluster compute:
 *   - visit count (number of entries — a new visit starts when the user
 *     enters the cluster after being elsewhere or in noise)
 *   - total dwell SECONDS = sum across visits of (last ping in visit −
 *     first ping in visit). Single-ping visits contribute 0 dwell.
 *
 * `clusterByPing[i]` holds the cluster index for ping `i`, or -1 for noise.
 * `pingTimes[i]` is the ISO timestamp for ping `i` (ascending order assumed).
 */
function countVisitsAndDwell(
  clusterByPing: number[],
  pingTimes: string[],
  clusterCount: number,
): { visits: number[]; dwellSeconds: number[] } {
  const visits = new Array<number>(clusterCount).fill(0);
  const dwellSeconds = new Array<number>(clusterCount).fill(0);

  let openCluster = -1;       // cluster idx of the currently-open visit, or -1
  let visitStartMs = 0;       // start time of currently-open visit
  let lastInClusterMs = 0;    // time of most recent ping in the open cluster

  const closeOpenVisit = () => {
    if (openCluster >= 0) {
      dwellSeconds[openCluster] += Math.max(0, (lastInClusterMs - visitStartMs) / 1000);
    }
    openCluster = -1;
  };

  for (let i = 0; i < clusterByPing.length; i++) {
    const curr = clusterByPing[i];
    const t = new Date(pingTimes[i]).getTime();

    if (curr < 0) {
      // Noise ping — closes any open visit.
      closeOpenVisit();
      continue;
    }

    if (curr !== openCluster) {
      // Transition into a new (or different) cluster — close the previous
      // open visit, start a new one, increment visit count.
      closeOpenVisit();
      openCluster = curr;
      visitStartMs = t;
      lastInClusterMs = t;
      visits[curr]++;
    } else {
      // Continuing inside the same cluster — just extend the open visit.
      lastInClusterMs = t;
    }
  }
  closeOpenVisit();

  return { visits, dwellSeconds };
}

export async function recomputePlacesForCurrentUser(): Promise<{
  pingsRead: number;
  clustersFound: number;
  placesUpserted: number;
  newPlacesCreated: number;
  error?: string;
}> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return {
      pingsRead: 0, clustersFound: 0, placesUpserted: 0, newPlacesCreated: 0,
      error: 'not signed in',
    };
  }

  // ---- 1. fetch pings from rolling window ----------------------------------
  const since = new Date(Date.now() - PING_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: pings, error: pingErr } = await supabase
    .from('behavioral_pings')
    .select('captured_at, geohash_8')
    .eq('user_id', session.user.id)
    .gte('captured_at', since)
    .order('captured_at', { ascending: true });

  if (pingErr) {
    return {
      pingsRead: 0, clustersFound: 0, placesUpserted: 0, newPlacesCreated: 0,
      error: pingErr.message,
    };
  }
  if (!pings || pings.length === 0) {
    return { pingsRead: 0, clustersFound: 0, placesUpserted: 0, newPlacesCreated: 0 };
  }

  const typedPings: RawPing[] = pings as RawPing[];

  // ---- 2. decode + cluster -------------------------------------------------
  const points: GeoPoint[] = typedPings.map((p) => {
    const { lat, lon } = decodeGeohash(p.geohash_8);
    return { lat, lon, meta: p.captured_at };
  });

  const clusters = dbscan(points, EPSILON_METERS, MIN_PINGS);

  if (clusters.length === 0) {
    return {
      pingsRead: typedPings.length, clustersFound: 0, placesUpserted: 0,
      newPlacesCreated: 0,
    };
  }

  // ---- 3. compute per-ping cluster index for visit counting ----------------
  const clusterByPing = new Array<number>(typedPings.length).fill(-1);
  for (let ci = 0; ci < clusters.length; ci++) {
    for (const pingIdx of clusters[ci].indices) {
      clusterByPing[pingIdx] = ci;
    }
  }
  const pingTimes = typedPings.map((p) => p.captured_at);
  const { visits: visitCounts, dwellSeconds } = countVisitsAndDwell(
    clusterByPing,
    pingTimes,
    clusters.length,
  );

  // ---- 4. build candidate place rows + run inference -----------------------
  const candidates: ClusterPlaceRow[] = clusters.map((c, ci) => {
    const memberPoints = c.indices.map((i) => points[i]);
    const memberPings: PlaceInferencePing[] = c.indices.map((i) => ({
      captured_at: String(points[i].meta),
    }));
    const memberTimes = memberPings.map((p) => p.captured_at).sort();
    const { lat, lon } = centroidOf(memberPoints);
    const totalDwellMinutes = dwellSeconds[ci] / 60;

    const inference = inferPlaceLabel({
      pings: memberPings,
      google: null, // Google data, if any, comes via resolve-places afterwards
      first_seen: memberTimes[0],
      last_seen: memberTimes[memberTimes.length - 1],
      total_dwell_minutes: totalDwellMinutes,
      visits_count: visitCounts[ci] ?? 0,
    });

    return {
      geohash7: encodeGeohash(lat, lon, 7),
      geohash5: encodeGeohash(lat, lon, 5),
      centroidLat: lat,
      centroidLon: lon,
      visitCount: visitCounts[ci] ?? 0,
      pingCount: c.indices.length,
      firstSeen: memberTimes[0]!,
      lastSeen: memberTimes[memberTimes.length - 1]!,
      inferredName: inference.name,
      inferredCategory: inference.category,
      inferredConfidence: inference.confidence,
      hideAsOuting: inference.hide_as_outing,
    };
  });

  // ---- 5. read existing places (preserve user-confirmed / corrected) ------
  const { data: existing, error: existErr } = await supabase
    .from('places')
    .select('id, geohash_7, first_seen, inference_status, user_label, name, category, confidence')
    .eq('user_id', session.user.id);

  if (existErr) {
    return {
      pingsRead: typedPings.length, clustersFound: clusters.length, placesUpserted: 0,
      newPlacesCreated: 0, error: existErr.message,
    };
  }

  const byHash = new Map(existing?.map((r) => [r.geohash_7, r]) ?? []);

  // ---- 6. upsert ----------------------------------------------------------
  let upserted = 0;
  let created = 0;

  for (const row of candidates) {
    const prior = byHash.get(row.geohash7);

    if (prior) {
      // Update path: always refresh stats. Only overwrite the inferred labels
      // for places that are still 'pending' (not user-confirmed or corrected).
      const settled =
        prior.inference_status === 'confirmed' ||
        prior.inference_status === 'corrected';

      // The user has expressed an opinion only when they corrected the label
      // OR set a user_label. A high-confidence auto-confirmed Google match
      // is NOT a user opinion — we still want to be able to hide it as a
      // drive-by when the dwell rule fires.
      const userTouched =
        prior.inference_status === 'corrected' ||
        (prior as { user_label?: string | null }).user_label != null;

      const update: Record<string, unknown> = {
        visit_count: row.visitCount,
        ping_count: row.pingCount,
        last_seen: row.lastSeen,
        first_seen: prior.first_seen ?? row.firstSeen,
        centroid_lat: row.centroidLat,
        centroid_lon: row.centroidLon,
        updated_at: new Date().toISOString(),
      };

      if (!settled) {
        // Auto-labelling can refine pending places freely.
        update.name = row.inferredName ?? prior.name;
        update.category = row.inferredCategory ?? prior.category;
        update.confidence = row.inferredConfidence;
        update.inference_status = statusFromConfidence(row.inferredConfidence);
      }

      // Backfill is_hidden whenever the user has NOT explicitly relabelled.
      // This lets the new dwell-time rule retroactively hide drive-by places
      // that got auto-confirmed via Google match in the past.
      if (!userTouched) {
        update.is_hidden = row.hideAsOuting;
      }

      const { error } = await supabase.from('places').update(update).eq('id', prior.id);
      if (!error) upserted++;
    } else {
      // Insert path: write inference_status from confidence, hide outings.
      const { error } = await supabase.from('places').insert({
        user_id: session.user.id,
        geohash_7: row.geohash7,
        geohash_5: row.geohash5,
        centroid_lat: row.centroidLat,
        centroid_lon: row.centroidLon,
        visit_count: row.visitCount,
        ping_count: row.pingCount,
        first_seen: row.firstSeen,
        last_seen: row.lastSeen,
        name: row.inferredName,
        category: row.inferredCategory,
        confidence: row.inferredConfidence,
        is_hidden: row.hideAsOuting,
        inference_status: statusFromConfidence(row.inferredConfidence),
      });
      if (!error) {
        upserted++;
        created++;
      }
    }
  }

  return {
    pingsRead: typedPings.length,
    clustersFound: clusters.length,
    placesUpserted: upserted,
    newPlacesCreated: created,
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
