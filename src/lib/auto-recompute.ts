/**
 * Auto-recompute the behavioral pipeline on app open, throttled.
 *
 * The pipeline:
 *   pings → DBSCAN clusters (places) → Google Places labels (resolve) →
 *   routines → behavioral_summary
 *
 * Without this, the user has to manually tap four buttons in Profile to
 * see fresh inferences. With this, ALINE keeps itself current as long as
 * the user opens the app at least every few hours.
 *
 * Throttle: at most one full run per 24 hours per device. The underlying
 * data only meaningfully changes day-over-day — pings accumulate slowly,
 * routines need 2+ weeks to form, archetypes shift over weeks. Anything
 * more aggressive is wasteful Supabase round-trips.
 *
 * Behaviour:
 *   - Runs in the background — never blocks UI.
 *   - All errors swallowed silently. A failed recompute must not crash
 *     the app. Each step has its own internal error handling on top.
 *   - Steps run in order; if one fails, downstream steps are skipped
 *     (because they depend on its output).
 *
 * To force a fresh run from the UI, pass `force: true`.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { recomputePlacesForCurrentUser, resolvePlaceIdentities } from './places';
import { recomputeRoutinesForCurrentUser } from './routines';
import { recomputeBehavioralSummaryForCurrentUser } from './summary';

const STORAGE_KEY = '@aline/last_recompute_at';
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

type RecomputeStep =
  | 'cluster'
  | 'resolve'
  | 'routines'
  | 'summary';

type RecomputeResult = {
  ran: boolean;             // false if throttled
  reason?: 'throttled' | 'no_pings';
  steps?: Partial<Record<RecomputeStep, { ok: boolean; error?: string }>>;
};

async function readLastRunMs(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function writeLastRunMs(ms: number): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, String(ms));
  } catch {
    // ignore — worst case we run again sooner than throttle target
  }
}

/**
 * Run the full pipeline if the throttle window has elapsed.
 * Safe to call multiple times in quick succession — only the first call
 * within the window will actually run.
 *
 * Set `force: true` to skip the throttle check (e.g. after the user
 * pulls-to-refresh or asks the agent something time-sensitive).
 */
export async function maybeRecompute(opts: { force?: boolean } = {}): Promise<RecomputeResult> {
  const now = Date.now();

  if (!opts.force) {
    const last = await readLastRunMs();
    if (last && now - last < MIN_INTERVAL_MS) {
      return { ran: false, reason: 'throttled' };
    }
  }

  const steps: NonNullable<RecomputeResult['steps']> = {};

  // Step 1 — cluster pings into places
  try {
    const r = await recomputePlacesForCurrentUser();
    if (r.error) {
      steps.cluster = { ok: false, error: r.error };
    } else {
      steps.cluster = { ok: true };
      // If there were no pings at all, no point continuing.
      if (r.pingsRead === 0) {
        await writeLastRunMs(now);
        return { ran: true, reason: 'no_pings', steps };
      }
    }
  } catch (e) {
    steps.cluster = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Step 2 — resolve places via Google Places (only places with no google_place_id yet)
  // This is the only step that costs money. The edge function is idempotent
  // and skips already-resolved places, so we can call it freely.
  try {
    const r = await resolvePlaceIdentities();
    steps.resolve = r.error ? { ok: false, error: r.error } : { ok: true };
  } catch (e) {
    steps.resolve = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Step 3 — detect routines from pings × places
  try {
    const r = await recomputeRoutinesForCurrentUser();
    steps.routines = r.error ? { ok: false, error: r.error } : { ok: true };
  } catch (e) {
    steps.routines = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Step 4 — collapse everything into the agent-facing archetype text
  try {
    const r = await recomputeBehavioralSummaryForCurrentUser();
    steps.summary = r.error ? { ok: false, error: r.error } : { ok: true };
  } catch (e) {
    steps.summary = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  await writeLastRunMs(now);
  return { ran: true, steps };
}

/**
 * Clear the throttle state. Useful for tests or after sign-out.
 */
export async function clearRecomputeThrottle(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {}
}
