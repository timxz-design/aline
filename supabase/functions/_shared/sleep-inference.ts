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

  // Annotate each session with its gap to the previous / next session (global
  // ordering), then group by local day. Taking ONE wake + ONE bedtime per day
  // is the key correctness fix: the old version flagged EVERY session after a
  // ≥4h gap, so an ordinary midday app-gap (open at 9, next at 13:00) was
  // misread as "waking up" and dragged the wake median into the afternoon.
  const withGaps = ann.map((a, i) => ({
    ...a,
    prevGap: i > 0 ? a.ts - ann[i - 1].ts : Infinity,
    nextGap: i < ann.length - 1 ? ann[i + 1].ts - a.ts : Infinity,
  }));

  const byDay = new Map<string, typeof withGaps>();
  for (const a of withGaps) {
    const list = byDay.get(a.day);
    if (list) list.push(a);
    else byDay.set(a.day, [a]);
  }

  for (const [day, list] of byDay) {
    daysSeen.add(day);

    // Wake = the FIRST open of the day that's past earliest_wake_hour AND
    // follows a real (≥gap) overnight break. `list` is ascending, so find()
    // returns the earliest qualifier — one per day.
    const wake = list.find(
      (a) => a.minute >= T.earliest_wake_hour * 60 && a.prevGap >= gapMs,
    );
    if (wake) wakeMinutes.push(wake.minute);

    // Bedtime = the LAST evening/night open before a ≥gap break (wraps midnight:
    // minute >= 18:00 OR < 03:00). One per day.
    const beds = list.filter(
      (a) =>
        a.nextGap >= gapMs &&
        (a.minute >= 18 * 60 || a.minute < T.latest_bedtime_hour * 60),
    );
    if (beds.length > 0) bedMinutes.push(beds[beds.length - 1].minute);
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
    // First app-open LAGS true wake (people wake, then open the app a while
    // later), so the "late riser" cutoff is generous — ~10:30 first-open, not
    // 9:30 — to avoid over-labelling ordinary mornings as night-owl.
    const lateWake = waketime_minute > 10 * 60 + 30;
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

// ---------- HealthKit sleep (measured) ---------------------------------------

export type HealthSleepInterval = {
  stage: string; // in_bed | asleep | awake | core | deep | rem
  started_at: string; // ISO UTC
  ended_at: string;
};

const ASLEEP_STAGES = new Set(['asleep', 'core', 'deep', 'rem']);

/**
 * Bed/wake from HealthKit sleep analysis — measured, so it outranks the
 * app-session guess whenever it exists.
 *
 *   night     = intervals grouped by local day of (start − 12h), so one night
 *               spanning midnight stays together; starts between 12:00 and
 *               18:00 are naps and ignored
 *   bed/wake  = earliest asleep start / latest asleep end per night (falls
 *               back to in_bed when a source only records time in bed)
 *   medians   = bedtime median taken around noon so 23:30 and 00:30 average
 *               to midnight, not midday
 *
 * Quality is by nights, with lower bars than app sessions because each night
 * is a direct measurement: ≥3 nights high, ≥1 medium.
 */
export function inferSleepFromHealth(
  intervals: HealthSleepInterval[],
  timezone: string,
): SleepInferenceResult {
  type Night = { asleep: [number, number][]; inBed: [number, number][] };
  const nights = new Map<string, Night>();

  for (const iv of intervals) {
    const startMin = localMinuteOfDay(iv.started_at, timezone);
    if (startMin >= 12 * 60 && startMin < 18 * 60) continue; // daytime nap
    const start = new Date(iv.started_at).getTime();
    const end = new Date(iv.ended_at).getTime();
    if (!(end > start)) continue;
    const key = localDayKey(new Date(start - 12 * 3600_000).toISOString(), timezone);
    const n = nights.get(key) ?? { asleep: [], inBed: [] };
    if (ASLEEP_STAGES.has(iv.stage)) n.asleep.push([start, end]);
    else if (iv.stage === 'in_bed') n.inBed.push([start, end]);
    nights.set(key, n);
  }

  const bedFromNoon: number[] = [];
  const wakeMinutes: number[] = [];
  for (const n of nights.values()) {
    const spans = n.asleep.length > 0 ? n.asleep : n.inBed;
    if (spans.length === 0) continue;
    const bed = Math.min(...spans.map((s) => s[0]));
    const wake = Math.max(...spans.map((s) => s[1]));
    if (wake - bed < 2 * 3600_000) continue; // not a night's sleep
    bedFromNoon.push((localMinuteOfDay(new Date(bed).toISOString(), timezone) + 12 * 60) % 1440);
    wakeMinutes.push(localMinuteOfDay(new Date(wake).toISOString(), timezone));
  }

  const nightsObserved = wakeMinutes.length;
  if (nightsObserved === 0) {
    return { bedtime_minute: null, waketime_minute: null, chronotype: null, data_quality: 'low', days_observed: 0 };
  }

  const bedtime_minute = (median(bedFromNoon) + 12 * 60) % 1440;
  const waketime_minute = median(wakeMinutes);

  // Measured wake has no app-open lag, so the late-riser cutoff is 9:30.
  const earlyWake = waketime_minute < 7 * 60;
  const earlyBed = bedtime_minute < 23 * 60 && bedtime_minute >= 12 * 60;
  const lateWake = waketime_minute > 9 * 60 + 30;
  const lateBed = bedtime_minute < 4 * 60;
  const chronotype: SleepInferenceResult['chronotype'] =
    earlyWake && earlyBed ? 'early_bird' : lateWake || lateBed ? 'night_owl' : 'balanced';

  return {
    bedtime_minute,
    waketime_minute,
    chronotype,
    data_quality: nightsObserved >= 3 ? 'high' : 'medium',
    days_observed: nightsObserved,
  };
}

export type MotionSegment = { kind: string; started_at: string; ended_at: string };

/**
 * Bed/wake from the iOS motion history, for everyone without Health sleep
 * data (no Apple Watch / no sleep schedule). Per night: the longest stretch
 * the phone lay still (iOS splits ≤ 2 min merged), ≥ 3 h, covering part of
 * 01:00–05:00 local. A still phone is a phone on the nightstand — or on a
 * table all evening — so bedtime moves past any app use inside the stretch
 * before 05:00. Wake = first movement, which is sharp.
 *
 * Quality: 'high' from 7 nights (shown), 'medium' from 4 (kept hidden).
 */
export function inferSleepFromMotion(
  segments: MotionSegment[],
  sessions: SleepInferenceSession[],
  timezone: string,
): SleepInferenceResult {
  const still = segments
    .filter((s) => s.kind === 'stationary')
    .map((s) => [Date.parse(s.started_at), Date.parse(s.ended_at)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of still) {
    const last = merged[merged.length - 1];
    // Only bridge iOS's own seconds-long splits. Any longer gap is the phone
    // being picked up — bridging 20 min chained evening, night and next day
    // into one multi-day "night".
    if (last && a - last[1] <= 2 * 60_000) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }

  const opens = sessions.map((s) => Date.parse(s.opened_at)).filter(Number.isFinite);
  const minuteAt = (ms: number) => localMinuteOfDay(new Date(ms).toISOString(), timezone);
  const coversDeepNight = ([a, b]: [number, number]) => {
    for (let t = a; t <= b; t += 15 * 60_000) {
      const m = minuteAt(t);
      if (m >= 60 && m <= 300) return true;
    }
    return false;
  };

  // longest qualifying stretch per night (night = local day of start − 12 h)
  const best = new Map<string, [number, number]>();
  for (const block of merged) {
    if (block[1] - block[0] < 3 * 3600_000 || !coversDeepNight(block)) continue;
    let [bed, wake] = block;
    // app use inside the stretch before 05:00 local → not asleep yet
    for (const o of opens) {
      if (o > bed && o < wake && (minuteAt(o) >= 18 * 60 || minuteAt(o) < 5 * 60)) bed = o;
    }
    if (wake - bed < 3 * 3600_000) continue;
    const key = localDayKey(new Date(bed - 12 * 3600_000).toISOString(), timezone);
    const prev = best.get(key);
    if (!prev || wake - bed > prev[1] - prev[0]) best.set(key, [bed, wake]);
  }

  const nights: HealthSleepInterval[] = [...best.values()].map(([a, b]) => ({
    stage: 'asleep',
    started_at: new Date(a).toISOString(),
    ended_at: new Date(b).toISOString(),
  }));
  const r = inferSleepFromHealth(nights, timezone);
  // A week of still nights is as solid as a week of app opens (the summary
  // only shows 'high'); fewer nights stay hidden.
  return { ...r, data_quality: r.days_observed >= 7 ? 'high' : r.days_observed >= 4 ? 'medium' : 'low' };
}
