/**
 * Auto-recompute the behavioral pipeline.
 *
 *   pings → DBSCAN clusters (places) → Google Places resolve → routines →
 *   behavioral_summary
 *
 * Each stage has its own throttle, tracked per-device in AsyncStorage:
 *
 *   cluster   — every 24 h. Pings accumulate slowly day-over-day.
 *   resolve   — event-driven. Runs immediately after cluster IF a new place
 *               was created this run. The edge function is idempotent
 *               (skips already-resolved places), so calling it freely is
 *               cheap.
 *   routines  — every 7 days. Routines need ≥ 2 weeks of pings to even form
 *               and barely change once formed.
 *   summary   — daily for the first 14 days of usage (data quality changing
 *               rapidly), then on a 7-day clock once data_quality reaches
 *               'high'. (Implementation: we always attempt summary if
 *               cluster ran; the function itself is cheap.)
 *
 * The agent should not surface this; the user should never have to think
 * about a "refresh". This file is the entire interaction surface.
 *
 * Errors: each stage is wrapped in try/catch. Failures are recorded into
 * the same AsyncStorage state map (last_*_error) and surfaced via
 * Sentry.captureException. They never crash the app and never block
 * downstream stages other than for the strict cluster→resolve dependency.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { recomputePlacesForCurrentUser, resolvePlaceIdentities } from './places';
import { recomputeRoutinesForCurrentUser } from './routines';
import { breadcrumb, captureException } from './sentry';
import { recomputeBehavioralSummaryForCurrentUser } from './summary';

const STORAGE_KEY = '@aline/pipeline_state';

const DAY_MS = 24 * 60 * 60 * 1000;
const STAGE_INTERVALS = {
  cluster:  1 * DAY_MS,   // 24h
  routines: 7 * DAY_MS,   // 7 days
  summary:  1 * DAY_MS,   // 24h (early-period; mature users see less change)
} as const;

export type RecomputeStage = 'cluster' | 'resolve' | 'routines' | 'summary';

type StageStatus = {
  last_ran_at: number | null;   // ms epoch, null = never
  last_ok: boolean | null;      // null = never run, true/false = last attempt result
  last_error: string | null;
};

type PipelineState = Record<RecomputeStage, StageStatus>;

const EMPTY_STAGE: StageStatus = { last_ran_at: null, last_ok: null, last_error: null };
const EMPTY_STATE: PipelineState = {
  cluster:  { ...EMPTY_STAGE },
  resolve:  { ...EMPTY_STAGE },
  routines: { ...EMPTY_STAGE },
  summary:  { ...EMPTY_STAGE },
};

async function readState(): Promise<PipelineState> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_STATE };
    const parsed = JSON.parse(raw) as Partial<PipelineState>;
    return {
      cluster:  { ...EMPTY_STAGE, ...(parsed.cluster  ?? {}) },
      resolve:  { ...EMPTY_STAGE, ...(parsed.resolve  ?? {}) },
      routines: { ...EMPTY_STAGE, ...(parsed.routines ?? {}) },
      summary:  { ...EMPTY_STAGE, ...(parsed.summary  ?? {}) },
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

async function writeState(state: PipelineState): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore — worst case we run again sooner than throttle target
  }
}

function isThrottled(stage: keyof typeof STAGE_INTERVALS, status: StageStatus): boolean {
  if (status.last_ran_at == null) return false;
  return Date.now() - status.last_ran_at < STAGE_INTERVALS[stage];
}

function markRan(state: PipelineState, stage: RecomputeStage, ok: boolean, error?: string) {
  state[stage] = {
    last_ran_at: Date.now(),
    last_ok: ok,
    last_error: ok ? null : (error ?? 'unknown'),
  };
}

// ---------- public API -----------------------------------------------------

export type RecomputeResult = {
  ranAny: boolean;
  state: PipelineState;
};

/**
 * Run any pipeline stages whose individual throttle has elapsed. Safe to
 * call multiple times in quick succession — most calls will no-op.
 *
 * `force: true` skips ALL throttles and runs every stage.
 */
export async function maybeRecompute(opts: { force?: boolean } = {}): Promise<RecomputeResult> {
  const state = await readState();
  let ranAny = false;
  const force = opts.force === true;

  // ---- cluster (also drives whether resolve runs) ----
  let newPlaces = 0;
  let clusterRan = false;
  if (force || !isThrottled('cluster', state.cluster)) {
    breadcrumb('pipeline.cluster start');
    try {
      const r = await recomputePlacesForCurrentUser();
      if (r.error) {
        markRan(state, 'cluster', false, r.error);
        captureException(new Error(`cluster: ${r.error}`));
      } else {
        markRan(state, 'cluster', true);
        clusterRan = true;
        newPlaces = r.newPlacesCreated ?? 0;
        // No pings yet → don't run downstream stages.
        if (r.pingsRead === 0) {
          await writeState(state);
          return { ranAny: true, state };
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markRan(state, 'cluster', false, msg);
      captureException(e);
    }
    ranAny = true;
  }

  // ---- resolve ----
  // The edge function is idempotent — it only does work for places whose
  // google_place_id IS NULL. So firing it every time cluster ran is cheap
  // and ensures any unresolved places (existing or new) eventually get
  // looked up. No reason to gate on newPlaces.
  //
  // Failed resolves get re-tried independently on a 6h clock, so a transient
  // Google API hiccup doesn't leave the place unresolved indefinitely.
  const RESOLVE_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const shouldRetryResolve =
    state.resolve.last_ok === false &&
    state.resolve.last_ran_at !== null &&
    Date.now() - state.resolve.last_ran_at >= RESOLVE_RETRY_INTERVAL_MS;
  const shouldResolve = force || clusterRan || shouldRetryResolve;
  if (shouldResolve) {
    breadcrumb('pipeline.resolve start', { newPlaces, retry: shouldRetryResolve });
    try {
      const r = await resolvePlaceIdentities();
      if (r.error) {
        markRan(state, 'resolve', false, r.error);
        captureException(new Error(`resolve: ${r.error}`));
      } else {
        markRan(state, 'resolve', true);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markRan(state, 'resolve', false, msg);
      captureException(e);
    }
    ranAny = true;
  }

  // ---- routines (weekly clock) ----
  if (force || !isThrottled('routines', state.routines)) {
    breadcrumb('pipeline.routines start');
    try {
      const r = await recomputeRoutinesForCurrentUser();
      if (r.error) {
        markRan(state, 'routines', false, r.error);
        captureException(new Error(`routines: ${r.error}`));
      } else {
        markRan(state, 'routines', true);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markRan(state, 'routines', false, msg);
      captureException(e);
    }
    ranAny = true;
  }

  // ---- summary (daily clock) ----
  if (force || !isThrottled('summary', state.summary)) {
    breadcrumb('pipeline.summary start');
    try {
      const r = await recomputeBehavioralSummaryForCurrentUser();
      if (r.error) {
        markRan(state, 'summary', false, r.error);
        captureException(new Error(`summary: ${r.error}`));
      } else {
        markRan(state, 'summary', true);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markRan(state, 'summary', false, msg);
      captureException(e);
    }
    ranAny = true;
  }

  await writeState(state);
  return { ranAny, state };
}

/**
 * Read-only — used by the PipelineStatus strip to render "last refreshed N
 * hours ago" + a warning glyph if the most recent attempt errored.
 */
export async function getPipelineState(): Promise<PipelineState> {
  return readState();
}

/** Clear all per-stage throttles. Use sparingly. */
export async function clearRecomputeThrottle(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {}
}
