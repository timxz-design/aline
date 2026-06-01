/**
 * Sleep/wake inference from `app_sessions` timestamps.
 *
 * Replaces the broken GPS-gap heuristic. GPS pauses when the user is
 * stationary (couch, desk, sleeping) so it cannot distinguish "asleep" from
 * "stationary." App sessions are unambiguous: the user actively opened the
 * app, therefore they were awake at that moment.
 *
 *   wake time  = first session of a local day after a ≥4h gap, not before 4am
 *   bedtime    = last session before a ≥4h gap, not after 3am
 *   chronotype = derived from medians
 *
 * Pure module — no I/O, no Supabase. Composable into the summary pipeline.
 */
export type SleepInferenceSession = {
  opened_at: string; // ISO UTC
};

export type SleepInferenceInput = {
  sessions: SleepInferenceSession[];
  /** IANA timezone name (e.g. 'Europe/Ljubljana'). Falls back to UTC. */
  timezone: string;
};

export type SleepInferenceResult = {
  bedtime_minute: number | null; // minute-of-day, user's local time
  waketime_minute: number | null;
  chronotype: 'early_bird' | 'night_owl' | 'balanced' | null;
  data_quality: 'low' | 'medium' | 'high';
  days_observed: number;
};

// ---------- thresholds (exported for tests) -------------------------------

export const SLEEP_INFERENCE_THRESHOLDS = {
  /** Min hours of gap between sessions to be considered "slept through". */
  min_sleep_gap_hours: 4,
  /** Wake time must be after this hour (filters all-nighter 3am sessions). */
  earliest_wake_hour: 4,
  /** Bedtime must be before this hour (filters middle-of-night opens). */
  latest_bedtime_hour: 3, // wraps over midnight; minute < 3*60 or minute >= some-bed-start
  /** Days required for each data_quality bucket. */
  days_for_medium: 3,
  days_for_high: 7,
} as const;

// ---------- helpers --------------------------------------------------------

/**
 * Returns the local YYYY-MM-DD key for an ISO timestamp in a given timezone.
 * Uses Intl to avoid pulling in a timezone library.
 */
function localDayKey(iso: string, timezone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // en-CA returns 'YYYY-MM-DD'
    return fmt.format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * Returns minute-of-day (0-1439) in the user's local time.
 */
function localMinuteOfDay(iso: string, timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(iso));
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
    return h * 60 + m;
  } catch {
    const d = new Date(iso);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

// ---------- main -----------------------------------------------------------

export function inferSleep(input: SleepInferenceInput): SleepInferenceResult {
  const T = SLEEP_INFERENCE_THRESHOLDS;
  const { sessions, timezone } = input;

  if (sessions.length === 0) {
    return {
      bedtime_minute: null,
      waketime_minute: null,
      chronotype: null,
      data_quality: 'low',
      days_observed: 0,
    };
  }

  // Sort ascending by opened_at.
  const sorted = [...sessions].sort(
    (a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime(),
  );

  // Annotate each session with its local-day key + local minute.
  type Annotated = {
    ts: number;
    day: string;
    minute: number;
  };
  const ann: Annotated[] = sorted.map((s) => ({
    ts: new Date(s.opened_at).getTime(),
    day: localDayKey(s.opened_at, timezone),
    minute: localMinuteOfDay(s.opened_at, timezone),
  }));

  const gapMs = T.min_sleep_gap_hours * 3600_000;

  // Wake candidates: a session is a "wake" if it's the first after a ≥gap
  // hours pause AND its local minute is past earliest_wake_hour.
  // Bedtime candidates: the LAST session before a ≥gap pause AND its local
  // minute is before latest_bedtime_hour (wraps — 22:00-02:59 acceptable).
  const wakeMinutes: number[] = [];
  const bedMinutes: number[] = [];
  const daysSeen = new Set<string>();

  for (let i = 0; i < ann.length; i++) {
    const cur = ann[i];
    daysSeen.add(cur.day);

    const prevGap = i > 0 ? cur.ts - ann[i - 1].ts : Infinity;
    const nextGap = i < ann.length - 1 ? ann[i + 1].ts - cur.ts : Infinity;

    // Wake: first session after a long gap
    if (prevGap >= gapMs && cur.minute >= T.earliest_wake_hour * 60) {
      wakeMinutes.push(cur.minute);
    }

    // Bedtime: last session before a long gap. "Before bedtime_hour" wraps
    // through midnight: accept any minute >= 18:00 OR < 03:00.
    if (nextGap >= gapMs) {
      const isLateEvening = cur.minute >= 18 * 60;
      const isPastMidnight = cur.minute < T.latest_bedtime_hour * 60;
      if (isLateEvening || isPastMidnight) {
        bedMinutes.push(cur.minute);
      }
    }
  }

  const days_observed = daysSeen.size;
  const data_quality: SleepInferenceResult['data_quality'] =
    days_observed >= T.days_for_high
      ? 'high'
      : days_observed >= T.days_for_medium
        ? 'medium'
        : 'low';

  const waketime_minute = wakeMinutes.length > 0 ? median(wakeMinutes) : null;
  const bedtime_minute = bedMinutes.length > 0 ? median(bedMinutes) : null;

  let chronotype: SleepInferenceResult['chronotype'] = null;
  if (waketime_minute !== null && bedtime_minute !== null) {
    const earlyWake = waketime_minute < 7 * 60;
    const earlyBed = bedtime_minute < 23 * 60 && bedtime_minute >= 12 * 60;
    const lateWake = waketime_minute > 9 * 60 + 30;
    const lateBed = bedtime_minute < 4 * 60; // past midnight (00:00-03:59)
    if (earlyWake && earlyBed) chronotype = 'early_bird';
    else if (lateWake || lateBed) chronotype = 'night_owl';
    else chronotype = 'balanced';
  }

  return {
    bedtime_minute,
    waketime_minute,
    chronotype,
    data_quality,
    days_observed,
  };
}
