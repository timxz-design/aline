/**
 * Uploads the two iOS-recorded day signals (native: modules/day-signals):
 *
 *  - Visits: arrivals/departures iOS detects even while ALINE is closed or the
 *    phone is unplugged. Each becomes a `visit` ping at the arrival time and
 *    one at the departure time, which `build_visits` turns into stays — the
 *    gaps between periodic samples stop being guesses.
 *  - Motion history: ~7 days of stationary/walking/running/cycling/driving
 *    that iOS keeps on its own, collapsed into segments in `motion_activity`.
 *    Backfilled on each open, so motion is known even for hours the app slept.
 *
 * Both are safe to call often: visits stay queued natively until an upload
 * succeeds, pings get deterministic ids (re-uploads are no-ops), and motion
 * segments upsert on (user, start).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import {
  ackVisits,
  isMotionActivityAvailable,
  pendingVisits,
  queryMotionActivity,
  startVisitMonitoring,
  type MotionSample,
} from '../../modules/day-signals';
import { encodeGeohash } from './clustering';
import { getDeviceId } from './device-id';
import { supabase } from './supabase';

const MOTION_SYNCED_KEY = 'aline_motion_synced_until_ms';
const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
const MIN_SEGMENT_MS = 2 * 60 * 1000;

/** Arm iOS visit monitoring (needs "Always" location). Idempotent. */
export async function ensureVisitMonitoring(): Promise<boolean> {
  try {
    const { status } = await Location.getBackgroundPermissionsAsync();
    if (status !== 'granted') return false;
    return startVisitMonitoring();
  } catch {
    return false;
  }
}

/** Stable UUID from a string, so the same visit edge always maps to one ping. */
async function stableId(key: string): Promise<string> {
  const h = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

let visitSyncInFlight: Promise<number> | null = null;

/** Upload queued iOS visits as pings. Returns how many visits were uploaded. */
export function syncVisits(): Promise<number> {
  visitSyncInFlight ??= syncVisitsNow().finally(() => {
    visitSyncInFlight = null;
  });
  return visitSyncInFlight;
}

async function syncVisitsNow(): Promise<number> {
  try {
    const visits = pendingVisits();
    if (visits.length === 0) return 0;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return 0;
    const device_id = await getDeviceId();

    const rows = [];
    for (const v of visits) {
      const cell = encodeGeohash(v.lat, v.lon, 8);
      for (const at of [v.arrival, v.departure]) {
        if (at == null || !Number.isFinite(at)) continue;
        rows.push({
          id: await stableId(`${session.user.id}|visit|${cell}|${Math.round(at / 1000)}`),
          user_id: session.user.id,
          captured_at: new Date(at).toISOString(),
          geohash_8: cell,
          motion_state: 'stationary',
          source: 'visit',
          device_id,
        });
      }
    }
    if (rows.length > 0) {
      const { error } = await supabase.from('behavioral_pings').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
      if (error) {
        console.warn('[ALINE visits] upload failed:', error.message);
        return 0; // keep them queued
      }
    }
    ackVisits(visits.length);
    return visits.length;
  } catch (e) {
    console.warn('[ALINE visits] sync failed:', e);
    return 0;
  }
}

/** Collapse iOS's activity-change samples into [start, end) segments. */
function toSegments(samples: MotionSample[], untilMs: number) {
  const sorted = [...samples].sort((a, b) => a.start - b.start);
  const out: { kind: Exclude<MotionSample['kind'], 'unknown'>; start: number; end: number; confidence: number }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const end = i + 1 < sorted.length ? sorted[i + 1].start : untilMs;
    if (s.kind === 'unknown' || end <= s.start) continue;
    const prev = out[out.length - 1];
    if (prev && prev.kind === s.kind && prev.end >= s.start - 1000) {
      prev.end = end;
      prev.confidence = Math.max(prev.confidence, s.confidence);
    } else {
      out.push({ kind: s.kind, start: s.start, end, confidence: s.confidence });
    }
  }
  return out.filter((seg) => seg.end - seg.start >= MIN_SEGMENT_MS);
}

/** Backfill the iOS motion history since the last sync (max 7 days). */
export async function syncMotionActivity(): Promise<number> {
  try {
    if (!isMotionActivityAvailable()) return 0;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return 0;

    const now = Date.now();
    const raw = await AsyncStorage.getItem(MOTION_SYNCED_KEY);
    const syncedUntil = raw ? parseInt(raw, 10) : 0;
    // Re-read the last hour so the still-open segment gets its real end.
    const from = Math.max(now - SEVEN_DAYS_MS + 60_000, (Number.isFinite(syncedUntil) ? syncedUntil : 0) - 3600_000);
    const samples = await queryMotionActivity(from, now);
    const segments = toSegments(samples, now);
    if (segments.length === 0) return 0;

    const device_id = await getDeviceId();
    const rows = segments.map((seg) => ({
      user_id: session.user.id,
      device_id,
      started_at: new Date(seg.start).toISOString(),
      ended_at: new Date(seg.end).toISOString(),
      kind: seg.kind,
      confidence: seg.confidence,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from('motion_activity')
        .upsert(rows.slice(i, i + 500), { onConflict: 'user_id,started_at' });
      if (error) {
        console.warn('[ALINE motion] upload failed:', error.message);
        return 0;
      }
    }
    // Next time, start from the last segment's start (it may still be going).
    await AsyncStorage.setItem(MOTION_SYNCED_KEY, String(segments[segments.length - 1].start));
    return rows.length;
  } catch (e) {
    console.warn('[ALINE motion] sync failed:', e);
    return 0;
  }
}
