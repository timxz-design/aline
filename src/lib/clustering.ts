/**
 * On-device geo-clustering primitives for ALINE.
 *
 * Pure functions only — no I/O, no React, no Supabase. Trivially testable.
 *
 * Pipeline:
 *   1. behavioral_pings stores geohash-8 (~38 m precision, no raw coords).
 *   2. decodeGeohash() recovers approximate lat/lon (cell centroid).
 *   3. dbscan() groups nearby points into clusters using haversine distance.
 *   4. centroidOf() computes a single representative point per cluster.
 *   5. Caller (places.ts) maps clusters to rows in the `places` table.
 *
 * DBSCAN parameter recommendations for "places someone visits":
 *   - epsilon: ~100 m  (most "places" — gym, café, classroom — fit in this radius)
 *   - minPoints: 5     (visited at least 5 distinct samples to be a place;
 *                       cancels out single drive-bys and GPS jitter)
 */

// ---------- geohash codec ---------------------------------------------------

const GH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Decode a base-32 geohash to its cell-centre lat/lon. */
export function decodeGeohash(hash: string): { lat: number; lon: number } {
  let evenBit = true;
  let latMin = -90, latMax = 90;
  let lonMin = -180, lonMax = 180;

  for (let i = 0; i < hash.length; i++) {
    const idx = GH_BASE32.indexOf(hash[i]);
    if (idx < 0) throw new Error(`Invalid geohash char: ${hash[i]}`);

    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1;
      if (evenBit) {
        const mid = (lonMin + lonMax) / 2;
        if (bit === 1) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit === 1) latMin = mid;
        else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }

  return {
    lat: (latMin + latMax) / 2,
    lon: (lonMin + lonMax) / 2,
  };
}

/** Encode lat/lon to a base-32 geohash of `precision` characters. */
export function encodeGeohash(lat: number, lon: number, precision: number): string {
  let idx = 0, bit = 0;
  let evenBit = true;
  let latMin = -90, latMax = 90;
  let lonMin = -180, lonMax = 180;
  let hash = '';

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { idx = idx * 2 + 1; lonMin = mid; }
      else            { idx = idx * 2;     lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { idx = idx * 2 + 1; latMin = mid; }
      else            { idx = idx * 2;     latMax = mid; }
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      hash += GH_BASE32[idx];
      bit = 0; idx = 0;
    }
  }
  return hash;
}

// ---------- great-circle distance -------------------------------------------

/** Haversine distance in metres between two lat/lon points. */
export function haversineMeters(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 6_371_000; // earth radius, m
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------- DBSCAN ----------------------------------------------------------

export type GeoPoint = {
  lat: number;
  lon: number;
  /** Optional opaque identifier the caller wants preserved through clustering. */
  meta?: unknown;
};

export type Cluster = {
  /** Indices into the input array that belong to this cluster. */
  indices: number[];
  /** Cluster centroid (mean lat/lon of member points). */
  centroid: { lat: number; lon: number };
  /** Member count — useful for visit_count on places. */
  size: number;
};

/**
 * Density-Based Spatial Clustering of Applications with Noise.
 *
 * Returns the clusters. Points that are not part of any cluster (noise) are
 * silently dropped — those are the drive-bys and stray GPS samples we don't
 * want polluting the `places` table.
 *
 * Complexity: O(n²) — fine for n in the low thousands which is what we expect
 * (a year of 15-min pings ≈ 35 k points, but we only ever cluster the most
 * recent ~30 days = ~3 k points). If we ever need more, swap in a kd-tree.
 */
export function dbscan(
  points: GeoPoint[],
  epsilonMeters: number,
  minPoints: number,
): Cluster[] {
  const n = points.length;
  const visited = new Array<boolean>(n).fill(false);
  const assigned = new Array<boolean>(n).fill(false);
  const clusters: Cluster[] = [];

  const regionQuery = (idx: number): number[] => {
    const out: number[] = [];
    const { lat: la, lon: lo } = points[idx];
    for (let j = 0; j < n; j++) {
      if (j === idx) continue;
      if (haversineMeters(la, lo, points[j].lat, points[j].lon) <= epsilonMeters) {
        out.push(j);
      }
    }
    return out;
  };

  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    visited[i] = true;

    const neighbours = regionQuery(i);
    if (neighbours.length + 1 < minPoints) continue; // noise

    // Start a new cluster, expand it via density-reachability.
    const memberSet = new Set<number>([i]);
    assigned[i] = true;

    const queue = [...neighbours];
    while (queue.length) {
      const j = queue.shift()!;
      if (!visited[j]) {
        visited[j] = true;
        const jNeighbours = regionQuery(j);
        if (jNeighbours.length + 1 >= minPoints) {
          for (const k of jNeighbours) if (!memberSet.has(k)) queue.push(k);
        }
      }
      if (!assigned[j]) {
        assigned[j] = true;
        memberSet.add(j);
      }
    }

    const indices = Array.from(memberSet).sort((a, b) => a - b);
    clusters.push({
      indices,
      centroid: centroidOf(indices.map((idx) => points[idx])),
      size: indices.length,
    });
  }

  return clusters;
}

/** Mean lat/lon of a set of points. Naive — fine for any cluster < ~10 km wide. */
export function centroidOf(points: GeoPoint[]): { lat: number; lon: number } {
  if (points.length === 0) return { lat: 0, lon: 0 };
  let sLat = 0, sLon = 0;
  for (const p of points) { sLat += p.lat; sLon += p.lon; }
  return { lat: sLat / points.length, lon: sLon / points.length };
}
