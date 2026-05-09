/**
 * Calendar slot finder — pure, no I/O. The brain of the choreography logic.
 *
 *   findOpenSlots(events, window, duration_minutes, preferences)
 *     → ranked array of slots, each with conflict classification
 *
 * A slot is a contiguous time range of `duration_minutes` length within
 * `window`. The classification tells the agent whether the slot is genuinely
 * empty (`none`), conflicts only with movable events (`flexible` — can be
 * reshuffled), or conflicts with events that must not move (`fixed`).
 *
 * The agent then decides:
 *   - `none` slots → propose a simple `create` operation
 *   - `flexible` slots → propose `move` + `create` operations together
 *   - `fixed` slots → skip; can't be made to fit without user intervention
 */

export type CalendarEventLite = {
  id: string;
  start_at: string;  // ISO UTC
  end_at: string;    // ISO UTC
  title: string | null;
  event_type: string | null;
  is_movable: boolean;
};

export type SlotConflictKind = 'none' | 'flexible' | 'fixed';

export type Slot = {
  start_at: string;          // ISO UTC
  end_at: string;            // ISO UTC
  conflict: SlotConflictKind;
  /** Events that overlap this slot (only filled if conflict !== 'none'). */
  conflicting_events: CalendarEventLite[];
  /** A score for ranking. Higher = better fit for the user's preferences. */
  score: number;
};

export type TimePreference = 'morning' | 'afternoon' | 'evening' | 'any';

export type FindOpenSlotsArgs = {
  events: CalendarEventLite[];
  /** UTC window to search within. */
  earliest: string;
  latest: string;
  /** Slot duration in minutes. */
  duration_minutes: number;
  /** User's timezone — the time-of-day preference is evaluated in local time. */
  user_timezone: string;
  /** Bias toward this part of the day. `any` accepts all. */
  time_preference?: TimePreference;
  /** Step size for slot scanning in minutes. Default 30. */
  step_minutes?: number;
  /** Cap the number of returned slots. Default 5. */
  max_results?: number;
  /** Earliest hour-of-day (local) to consider. Default 8. */
  earliest_hour?: number;
  /** Latest hour-of-day (local) to BEGIN a slot. Default 22 (slot can end at 23 or so). */
  latest_hour?: number;
};

// ---------- helpers ---------------------------------------------------------

function parseUtc(iso: string): number {
  return new Date(iso).getTime();
}

/** Hour-of-day in the given local timezone, 0–23. */
function localHour(utcMs: number, timezone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false,
  });
  const h = parseInt(dtf.format(new Date(utcMs)), 10);
  return Number.isFinite(h) ? h : 0;
}

function preferenceScore(localStartHour: number, pref: TimePreference): number {
  // 0 = bad fit, 1 = great fit. Used as a multiplier on the slot's base score.
  switch (pref) {
    case 'morning':
      if (localStartHour >= 6 && localStartHour < 11) return 1.0;
      if (localStartHour >= 11 && localStartHour < 13) return 0.6;
      return 0.2;
    case 'afternoon':
      if (localStartHour >= 13 && localStartHour < 17) return 1.0;
      if (localStartHour >= 11 && localStartHour < 13) return 0.7;
      if (localStartHour >= 17 && localStartHour < 19) return 0.7;
      return 0.2;
    case 'evening':
      if (localStartHour >= 18 && localStartHour < 22) return 1.0;
      if (localStartHour >= 17 && localStartHour < 18) return 0.7;
      if (localStartHour >= 22 && localStartHour < 24) return 0.6;
      return 0.2;
    case 'any':
    default:
      return 1.0;
  }
}

/** Returns events that overlap [start, end]. */
function overlappingEvents(
  events: CalendarEventLite[],
  startMs: number,
  endMs: number,
): CalendarEventLite[] {
  return events.filter((ev) => {
    const evStart = parseUtc(ev.start_at);
    const evEnd = parseUtc(ev.end_at);
    return evStart < endMs && evEnd > startMs;
  });
}

function classifyConflict(events: CalendarEventLite[]): SlotConflictKind {
  if (events.length === 0) return 'none';
  // Any non-movable conflict makes the entire slot 'fixed'.
  if (events.some((ev) => !ev.is_movable)) return 'fixed';
  return 'flexible';
}

// ---------- main ------------------------------------------------------------

export function findOpenSlots(args: FindOpenSlotsArgs): Slot[] {
  const {
    events,
    earliest,
    latest,
    duration_minutes,
    user_timezone,
    time_preference = 'any',
    step_minutes = 30,
    max_results = 5,
    earliest_hour = 8,
    latest_hour = 22,
  } = args;

  const earliestMs = parseUtc(earliest);
  const latestMs = parseUtc(latest);
  const stepMs = step_minutes * 60_000;
  const durationMs = duration_minutes * 60_000;

  if (latestMs - earliestMs < durationMs) return [];

  const slots: Slot[] = [];

  for (let startMs = earliestMs; startMs + durationMs <= latestMs; startMs += stepMs) {
    const endMs = startMs + durationMs;
    const startHour = localHour(startMs, user_timezone);
    if (startHour < earliest_hour || startHour > latest_hour) continue;

    const conflicts = overlappingEvents(events, startMs, endMs);
    const kind = classifyConflict(conflicts);

    // Skip fixed-conflict slots entirely — agent can't choreograph around them.
    if (kind === 'fixed') continue;

    const prefScore = preferenceScore(startHour, time_preference);
    if (prefScore === 0) continue;

    // Base scoring:
    //   - empty slot is best (1.0)
    //   - movable conflict halves the score (0.5) — agent has to do work
    //   - preference multiplier always applies
    const baseScore = kind === 'none' ? 1.0 : 0.5;
    const score = baseScore * prefScore;

    slots.push({
      start_at: new Date(startMs).toISOString(),
      end_at: new Date(endMs).toISOString(),
      conflict: kind,
      conflicting_events: kind === 'none' ? [] : conflicts,
      score,
    });
  }

  // Rank and dedupe similar slots — if we have many "8:00, 8:30, 9:00..."
  // adjacent empty slots, return the highest-scoring representative.
  slots.sort((a, b) => b.score - a.score);
  const picked: Slot[] = [];
  const minGapMs = durationMs;
  for (const s of slots) {
    const sStart = parseUtc(s.start_at);
    const tooClose = picked.some((p) => Math.abs(parseUtc(p.start_at) - sStart) < minGapMs);
    if (!tooClose) picked.push(s);
    if (picked.length >= max_results) break;
  }

  return picked;
}
