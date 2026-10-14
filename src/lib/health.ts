/**
 * HealthKit → ALINE evidence ledger.
 *
 * Imports measured workouts (AirPods Pro 3, Apple Watch, or any app that writes
 * HKWorkout) and hands them to the server reconciler, which marks planned goal
 * sessions done or creates a retroactive block for unplanned ones.
 *
 * Also imports sleep analysis (Apple Watch, or the iPhone Sleep schedule) into
 * health_sleep — measured asleep/in-bed intervals that replace guessing
 * bed/wake times from app opens, and mark when someone is unavailable.
 *
 * Why this exists: home/solo sessions can't be verified from location, so goals
 * sat at `unknown` forever unless the user manually reported them — which they
 * didn't. A measured workout is evidence, not a claim.
 *
 * TWO-LEDGER RULE: everything written from here lands with
 * confirmed_by='healthkit'. Manual taps stay confirmed_by='user'. Only the
 * former may ever feed matching.
 *
 * SAFETY: the native module crashes the app if you query a type you haven't
 * requested authorization for. Every entry point below is guarded — wrong
 * platform, module missing, or un-authorized all return quietly instead.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { breadcrumb, captureException } from './sentry';
import { supabase } from './supabase';
import type { Database } from '../types/database';

type HealthWorkoutInsert = Database['public']['Tables']['health_workouts']['Insert'];

// v2: the read set grew (sleep) — a v1 grant must re-prompt for the new type.
const AUTH_KEY = '@aline/healthkit_authorized_v2';
const LAST_SYNC_KEY = '@aline/healthkit_last_sync';
const LAST_SLEEP_SYNC_KEY = '@aline/healthkit_last_sleep_sync';

/** How far back to look on the very first import. */
const FIRST_IMPORT_DAYS = 30;
/** Re-scan window on every later sync — catches workouts edited after the fact. */
const OVERLAP_HOURS = 48;

/** Read-only scopes. Keep this list in sync with what we actually query:
 *  querying an un-requested type is what crashes the native module. */
const READ_TYPES = [
  'HKWorkoutTypeIdentifier',
  'HKQuantityTypeIdentifierHeartRate',
  'HKQuantityTypeIdentifierActiveEnergyBurned',
  'HKQuantityTypeIdentifierDistanceWalkingRunning',
  'HKCategoryTypeIdentifierSleepAnalysis',
] as const;

// HKCategoryValueSleepAnalysis → health_sleep.stage
const SLEEP_STAGE: Record<number, string> = {
  0: 'in_bed',
  1: 'asleep', // asleepUnspecified (pre-iOS 16 / third-party apps)
  2: 'awake',
  3: 'core',
  4: 'deep',
  5: 'rem',
};

// HKWorkoutActivityType enum → the families the reconciler matches goals on.
const ACTIVITY_FAMILY: Record<number, string> = {
  9: 'other',       // climbing
  11: 'strength',   // crossTraining
  13: 'cycling',
  16: 'other',      // elliptical
  20: 'strength',   // functionalStrengthTraining
  37: 'running',
  46: 'swimming',
  50: 'strength',   // traditionalStrengthTraining
  52: 'walking',
  57: 'yoga',
  59: 'strength',   // coreTraining
  63: 'hiit',       // highIntensityIntervalTraining
};

type HKModule = typeof import('@kingstinct/react-native-healthkit');
let modulePromise: Promise<HKModule | null> | null = null;

/** Load the native module lazily. iOS-only, and a failure here must never
 *  take the app down — it just means health sync is unavailable. */
async function getHK(): Promise<HKModule | null> {
  if (Platform.OS !== 'ios') return null;
  if (!modulePromise) {
    modulePromise = import('@kingstinct/react-native-healthkit').catch((e) => {
      console.warn('[health] native module unavailable:', e);
      return null;
    });
  }
  return modulePromise;
}

/** Is HealthKit usable on this device at all? */
export async function isHealthAvailable(): Promise<boolean> {
  try {
    const hk = await getHK();
    if (!hk) return false;
    return hk.isHealthDataAvailable();
  } catch {
    return false;
  }
}

/** Has the user already granted us read access in this install? */
export async function hasHealthAuthorization(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(AUTH_KEY)) === '1';
  } catch {
    return false;
  }
}

/**
 * Ask for read access. Must be called (and resolve) before any query — this is
 * the call whose absence crashes the module. Safe to call repeatedly; iOS shows
 * its sheet once and silently resolves afterwards.
 */
export async function requestHealthAuthorization(): Promise<boolean> {
  try {
    const hk = await getHK();
    if (!hk || !hk.isHealthDataAvailable()) return false;

    await hk.requestAuthorization({ toRead: READ_TYPES });
    await AsyncStorage.setItem(AUTH_KEY, '1');

    // Tell the server we're connected — push_workout_start() only nudges users
    // who can actually act on the nudge.
    const { data: u } = await supabase.auth.getUser();
    if (u?.user?.id) {
      await supabase.from('profiles').update({ health_connected: true }).eq('id', u.user.id);
    }
    breadcrumb('health.authorized');
    return true;
  } catch (e) {
    console.warn('[health] authorization failed:', e);
    captureException(e);
    return false;
  }
}

export type HealthSyncResult = {
  imported: number;
  planned: number;
  unplanned: number;
  ambiguous: number;
  skipped: number;
  error?: string;
};

const EMPTY: HealthSyncResult = {
  imported: 0, planned: 0, unplanned: 0, ambiguous: 0, skipped: 0,
};

/**
 * Pull workouts since the last sync, store them, and reconcile against goals.
 * No-ops quietly when unavailable or un-authorized — never throws at the caller.
 */
export async function syncHealthWorkouts(): Promise<HealthSyncResult> {
  try {
    const hk = await getHK();
    if (!hk || !hk.isHealthDataAvailable()) return EMPTY;

    // Hard gate: never query without authorization (native crash otherwise).
    if (!(await hasHealthAuthorization())) return EMPTY;

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) return EMPTY;

    // Window: first run reaches back a month, later runs overlap so workouts
    // that were edited or written late still get picked up.
    let since: Date;
    const lastRaw = await AsyncStorage.getItem(LAST_SYNC_KEY);
    if (lastRaw) {
      since = new Date(Number(lastRaw) - OVERLAP_HOURS * 3600 * 1000);
    } else {
      since = new Date(Date.now() - FIRST_IMPORT_DAYS * 24 * 3600 * 1000);
    }

    breadcrumb('health.sync start', { since: since.toISOString() });

    const proxies = await hk.queryWorkoutSamples({
      filter: { date: { startDate: since } },
      limit: 0,
      ascending: true,
    });

    const rows: HealthWorkoutInsert[] = [];
    for (const proxy of proxies) {
      try {
        // Heart rate is a per-workout statistic. Best-effort: AirPods Pro 3 and
        // Watch supply it, a bare phone workout won't.
        let avgHr: number | null = null;
        let maxHr: number | null = null;
        try {
          const hr = await proxy.getStatistic('HKQuantityTypeIdentifierHeartRate');
          avgHr = hr?.averageQuantity?.quantity ?? null;
          maxHr = hr?.maximumQuantity?.quantity ?? null;
        } catch {
          /* no HR for this workout — expected without a wearable */
        }

        const w = proxy.toJSON();
        const started = new Date(w.startDate);
        const ended = new Date(w.endDate);
        const durationSec = w.duration?.quantity ?? (ended.getTime() - started.getTime()) / 1000;

        rows.push({
          user_id: userId,
          source: 'healthkit',
          external_id: String(w.uuid),
          activity_type: ACTIVITY_FAMILY[Number(w.workoutActivityType)] ?? 'other',
          raw_activity_type: String(w.workoutActivityType),
          started_at: started.toISOString(),
          ended_at: ended.toISOString(),
          duration_min: Math.round((durationSec / 60) * 10) / 10,
          energy_kcal: w.totalEnergyBurned?.quantity ?? null,
          distance_m: w.totalDistance?.quantity ?? null,
          avg_heart_rate: avgHr != null ? Math.round(avgHr) : null,
          max_heart_rate: maxHr != null ? Math.round(maxHr) : null,
          device: (w as { device?: { name?: string } }).device?.name ?? null,
        });
      } catch (e) {
        console.warn('[health] skipping unreadable workout:', e);
      } finally {
        // Release the native object; we only keep the plain row.
        try { proxy.dispose(); } catch { /* already gone */ }
      }
    }

    let imported = 0;
    if (rows.length > 0) {
      // onConflict on (user_id, external_id) makes re-imports idempotent, so the
      // overlap window above can never create duplicates.
      const { error: upErr } = await supabase
        .from('health_workouts')
        .upsert(rows, { onConflict: 'user_id,external_id', ignoreDuplicates: true });
      if (upErr) {
        captureException(new Error(`health upsert: ${upErr.message}`));
        return { ...EMPTY, error: upErr.message };
      }
      imported = rows.length;
    }

    const { data: rec, error: recErr } = await supabase.rpc('reconcile_health_workouts', {
      _max: 100,
    });
    if (recErr) {
      captureException(new Error(`health reconcile: ${recErr.message}`));
      return { ...EMPTY, imported, error: recErr.message };
    }

    await AsyncStorage.setItem(LAST_SYNC_KEY, String(Date.now()));

    const r = (rec ?? {}) as Record<string, number>;
    breadcrumb('health.sync done', { imported, ...r });
    return {
      imported,
      planned: r.planned ?? 0,
      unplanned: r.unplanned ?? 0,
      ambiguous: r.ambiguous ?? 0,
      skipped: r.skipped ?? 0,
    };
  } catch (e) {
    console.warn('[health] sync failed:', e);
    captureException(e);
    return { ...EMPTY, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Pull sleep intervals since the last sync (first run: a month back; later
 * runs overlap 48h for late-written nights). Same guards as workouts.
 */
export async function syncHealthSleep(): Promise<{ imported: number; error?: string }> {
  try {
    const hk = await getHK();
    if (!hk || !hk.isHealthDataAvailable()) return { imported: 0 };
    if (!(await hasHealthAuthorization())) return { imported: 0 };

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) return { imported: 0 };

    const lastRaw = await AsyncStorage.getItem(LAST_SLEEP_SYNC_KEY);
    const since = lastRaw
      ? new Date(Number(lastRaw) - OVERLAP_HOURS * 3600 * 1000)
      : new Date(Date.now() - FIRST_IMPORT_DAYS * 24 * 3600 * 1000);

    const samples = await hk.queryCategorySamples('HKCategoryTypeIdentifierSleepAnalysis', {
      filter: { date: { startDate: since } },
      limit: 0,
      ascending: true,
    });

    const rows = samples
      .map((smp) => {
        const stage = SLEEP_STAGE[Number(smp.value)];
        if (!stage) return null;
        return {
          user_id: userId,
          external_id: String(smp.uuid),
          stage,
          started_at: new Date(smp.startDate).toISOString(),
          ended_at: new Date(smp.endDate).toISOString(),
          source_name: smp.sourceRevision?.source?.name ?? null,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from('health_sleep')
        .upsert(rows.slice(i, i + 500), { onConflict: 'user_id,external_id', ignoreDuplicates: true });
      if (error) {
        captureException(new Error(`health sleep upsert: ${error.message}`));
        return { imported: 0, error: error.message };
      }
    }
    await AsyncStorage.setItem(LAST_SLEEP_SYNC_KEY, String(Date.now()));
    breadcrumb('health.sleep sync done', { imported: rows.length });
    return { imported: rows.length };
  } catch (e) {
    console.warn('[health] sleep sync failed:', e);
    captureException(e);
    return { imported: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Workouts + sleep, in the app-lifecycle slot. Never throws. */
export async function syncHealth(): Promise<void> {
  await syncHealthWorkouts();
  await syncHealthSleep();
}

/** Last successful sync, for the settings UI. */
export async function lastHealthSyncAt(): Promise<Date | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_SYNC_KEY);
    return raw ? new Date(Number(raw)) : null;
  } catch {
    return null;
  }
}

/** Forget authorization locally (iOS permissions themselves live in Settings). */
export async function disconnectHealth(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([AUTH_KEY, LAST_SYNC_KEY, LAST_SLEEP_SYNC_KEY]);
    const { data: u } = await supabase.auth.getUser();
    if (u?.user?.id) {
      await supabase.from('profiles').update({ health_connected: false }).eq('id', u.user.id);
    }
  } catch { /* ignore */ }
}
