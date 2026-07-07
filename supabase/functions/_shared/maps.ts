/**
 * Shared maps foundation (Layer 0) — travel times + origin resolution.
 * ----------------------------------------------------------------------------
 * Used by the `get_travel_time` agent tool (Layer A, individual) and, later,
 * the group venue-feasibility pipeline (Layer B). Driving-only for v1.
 *
 * Provider: Google Distance Matrix (legacy). One request returns an N×M matrix
 * of durations. With `departureEpochSec` set, Google returns traffic-aware
 * `duration_in_traffic`. Origins/destinations may be "lat,lon" strings OR
 * address/place-name strings (Distance Matrix geocodes them).
 *
 * Key: GOOGLE_MAPS_API_KEY, falling back to GOOGLE_PLACES_API_KEY (works only
 * if that key is unrestricted / also allowed to call Distance Matrix).
 * The Distance Matrix API must be ENABLED on the Google Cloud project.
 * ----------------------------------------------------------------------------
 */

// @ts-nocheck Deno edge runtime
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const MAPS_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY') ?? Deno.env.get('GOOGLE_PLACES_API_KEY');

export type TravelMode = 'driving' | 'walking' | 'transit' | 'bicycling';

export function mapsConfigured(): boolean {
  return !!MAPS_KEY;
}

/** Decode a base-32 geohash to its cell-centre lat/lon (Deno-side copy). */
const GH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
export function decodeGeohash(hash: string): { lat: number; lon: number } {
  let evenBit = true;
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  for (let i = 0; i < hash.length; i++) {
    const idx = GH_BASE32.indexOf(hash[i]);
    if (idx < 0) throw new Error(`Invalid geohash char: ${hash[i]}`);
    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1;
      if (evenBit) {
        const mid = (lonMin + lonMax) / 2;
        if (bit === 1) lonMin = mid; else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit === 1) latMin = mid; else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}

/**
 * Travel-time matrix in SECONDS. result[i][j] = origin i → destination j.
 * Unreachable / errored pairs come back as Infinity.
 */
export async function travelTimes(
  origins: string[],
  destinations: string[],
  opts: { mode?: TravelMode; departureEpochSec?: number } = {},
): Promise<number[][]> {
  if (!MAPS_KEY) throw new Error('maps_not_configured');
  if (origins.length === 0 || destinations.length === 0) return [];

  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  url.searchParams.set('origins', origins.join('|'));
  url.searchParams.set('destinations', destinations.join('|'));
  url.searchParams.set('mode', opts.mode ?? 'driving');
  url.searchParams.set('units', 'metric');
  if (opts.departureEpochSec) {
    // Enables duration_in_traffic. Must be now or future.
    url.searchParams.set('departure_time', String(Math.max(opts.departureEpochSec, Math.floor(Date.now() / 1000))));
  }
  url.searchParams.set('key', MAPS_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`distance_matrix_http_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as {
    status: string;
    error_message?: string;
    rows?: Array<{ elements?: Array<{ status: string; duration?: { value: number }; duration_in_traffic?: { value: number } }> }>;
  };
  if (data.status !== 'OK') throw new Error(`distance_matrix_${data.status}: ${data.error_message ?? ''}`);

  return (data.rows ?? []).map((row) =>
    (row.elements ?? []).map((el) => {
      if (el.status !== 'OK') return Infinity;
      const secs = el.duration_in_traffic?.value ?? el.duration?.value;
      return typeof secs === 'number' ? secs : Infinity;
    }),
  );
}

/**
 * Resolve a user's current origin as a "lat,lon" string.
 * Priority: most-recent behavioral ping (freshest "where you are now") →
 * home place centroid → null. Reads the user's own rows (RLS-safe under their JWT).
 */
export async function resolveOrigin(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  // 1) latest ping
  const { data: ping } = await supabase
    .from('behavioral_pings')
    .select('geohash_8, captured_at')
    .eq('user_id', userId)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ping?.geohash_8) {
    const { lat, lon } = decodeGeohash(ping.geohash_8);
    return `${lat},${lon}`;
  }

  // 2) home place centroid
  const { data: home } = await supabase
    .from('places')
    .select('centroid_lat, centroid_lon')
    .eq('user_id', userId)
    .not('centroid_lat', 'is', null)
    .or('category.eq.home,user_label.ilike.home')
    .limit(1)
    .maybeSingle();
  if (home?.centroid_lat != null && home?.centroid_lon != null) {
    return `${home.centroid_lat},${home.centroid_lon}`;
  }

  return null;
}
