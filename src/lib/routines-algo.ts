/**
 * Pure routine-detection algorithm. No I/O, no React, no Supabase — fully
 * testable in plain Node. Imported by routines.ts which adds the Supabase
 * read/write pipeline on top.
 */

import { decodeGeohash, haversineMeters } from './clustering';

export const ROUTINE_EPSILON_METERS = 100;
export const ROUTINE_MIN_WEEKS = 2;
export const ROUTINE_MIN_VISITS_PER_CLUSTER = 3;
export const ROUTINE_TIME_CLUSTER_EPS_MIN = 60;
export const ROUTINE_TIME_PADDING_MIN = 15;

export type RoutinePing = { captured_at: string; geohash_8: string };
export type RoutinePlace = { id: string; geohash_7: string; category: string | null };

export type DetectedRoutine = {
  place_id: string;
  category: string | null;
  day_of_week: number;
  start_minute: number;
  end_minute: number;
  consistency: number;
  last_observed: string;
  visit_count: number;
};

// ---------- time helpers ----------------------------------------------------

function minuteOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function dayOfWeek(iso: string): number {
  return new Date(iso).getDay();
}

/** ISO-week key, e.g. "2026-W18". Two pings in the same week
 *  produce the same key regardless of day. */
function weekKey(iso: string): string {
  const d = new Date(iso);
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---------- 1D minute clustering -------------------------------------------

function clusterMinutes(minutes: number[], epsMin: number): number[][] {
  if (minutes.length === 0) return [];
  const sorted = [...minutes].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1];
    if (sorted[i] - last[last.length - 1] <= epsMin) last.push(sorted[i]);
    else clusters.push([sorted[i]]);
  }
  return clusters;
}

// ---------- ping → place assignment -----------------------------------------

function assignPingsToPlaces(
  pings: RoutinePing[],
  places: RoutinePlace[],
): (string | null)[] {
  const placeCoords = places.map((p) => {
    const c = decodeGeohash(p.geohash_7);
    return { id: p.id, lat: c.lat, lon: c.lon };
  });

  return pings.map((ping) => {
    const c = decodeGeohash(ping.geohash_8);
    let bestId: string | null = null;
    let bestDist = Infinity;
    for (const p of placeCoords) {
      const d = haversineMeters(c.lat, c.lon, p.lat, p.lon);
      if (d <= ROUTINE_EPSILON_METERS && d < bestDist) {
        bestDist = d;
        bestId = p.id;
      }
    }
    return bestId;
  });
}

// ---------- core algorithm --------------------------------------------------

export function detectRoutines(
  pings: RoutinePing[],
  places: RoutinePlace[],
): DetectedRoutine[] {
  if (pings.length === 0 || places.length === 0) return [];

  const placeAssignments = assignPingsToPlaces(pings, places);
  const totalWeeks = new Set(pings.map((p) => weekKey(p.captured_at))).size;
  if (totalWeeks === 0) return [];

  const placeMap = new Map(places.map((p) => [p.id, p]));

  type Bucket = { ping: RoutinePing; minute: number; week: string };
  const grouped: Record<string, Bucket[]> = {};
  pings.forEach((ping, idx) => {
    const placeId = placeAssignments[idx];
    if (!placeId) return;
    const dow = dayOfWeek(ping.captured_at);
    const key = `${placeId}|${dow}`;
    (grouped[key] ||= []).push({
      ping,
      minute: minuteOfDay(ping.captured_at),
      week: weekKey(ping.captured_at),
    });
  });

  const routines: DetectedRoutine[] = [];

  for (const [key, bucket] of Object.entries(grouped)) {
    const [placeId, dowStr] = key.split('|');
    const dow = parseInt(dowStr, 10);

    const minutes = bucket.map((b) => b.minute);
    const minuteClusters = clusterMinutes(minutes, ROUTINE_TIME_CLUSTER_EPS_MIN);

    for (const cluster of minuteClusters) {
      if (cluster.length < ROUTINE_MIN_VISITS_PER_CLUSTER) continue;

      const clusterMin = cluster[0];
      const clusterMax = cluster[cluster.length - 1];
      const members = bucket.filter(
        (b) => b.minute >= clusterMin && b.minute <= clusterMax,
      );

      const weeksSeen = new Set(members.map((m) => m.week));
      if (weeksSeen.size < ROUTINE_MIN_WEEKS) continue;

      const startMin = Math.max(0, clusterMin - ROUTINE_TIME_PADDING_MIN);
      const endMin = Math.min(1439, clusterMax + ROUTINE_TIME_PADDING_MIN);
      const lastObserved = members.map((m) => m.ping.captured_at).sort().pop()!;

      routines.push({
        place_id: placeId,
        category: placeMap.get(placeId)?.category ?? null,
        day_of_week: dow,
        start_minute: startMin,
        end_minute: endMin,
        consistency: weeksSeen.size / totalWeeks,
        last_observed: lastObserved,
        visit_count: members.length,
      });
    }
  }

  return routines;
}
