/**
 * Behavioral summary algorithm — pure, no I/O.
 *
 *   places + routines + sleep inference  →  one-row summary for the agent
 *
 * Outputs:
 *   - chronotype:        early_bird | night_owl | intermediate | null
 *   - waketime_minute:   median wake time across days (from app_sessions)
 *   - bedtime_minute:    median bedtime across days   (from app_sessions)
 *   - weekly_workout_count: sum of `consistency` over gym-category routines
 *   - avg_daily_steps:   measured (pedometer step_counts), else null
 *   - data_quality:      none | low | medium | high
 *   - archetype_text:    one-line description for the agent system prompt
 *
 * Sleep inference (waketime/bedtime/chronotype) comes from sleep-inference.ts
 * which uses app_sessions — much more reliable than GPS gaps. We still
 * compute place-based data_quality from clusters + days observed.
 */

export type SummaryPing = { captured_at: string };
export type SummaryPlace = { category: string | null; visit_count: number };
export type SummaryRoutine = {
  category: string | null;
  consistency: number;
};

/** Sleep inference result, slotted in from sleep-inference.ts. */
export type SummarySleep = {
  bedtime_minute: number | null;
  waketime_minute: number | null;
  chronotype: 'early_bird' | 'night_owl' | 'balanced' | null;
  data_quality: 'low' | 'medium' | 'high';
  days_observed: number;
};

export type BehavioralSummary = {
  chronotype: 'early_bird' | 'night_owl' | 'intermediate' | null;
  bedtime_minute: number | null;
  waketime_minute: number | null;
  weekly_workout_count: number | null;
  avg_daily_steps: number | null;
  data_quality: 'none' | 'low' | 'medium' | 'high';
  archetype_text: string;
};

// ---------- helpers ---------------------------------------------------------

function localDayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function minuteOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function average(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function formatMinute(m: number): string {
  // Wrap >=24:00 back to its display form (e.g. 1500 → 01:00)
  const norm = m % (24 * 60);
  return `${String(Math.floor(norm / 60)).padStart(2, '0')}:${String(norm % 60).padStart(2, '0')}`;
}

// ---------- chronotype ------------------------------------------------------

function computeChronotype(
  waketime: number | null,
  bedtime: number | null,
): BehavioralSummary['chronotype'] {
  if (waketime === null || bedtime === null) return null;

  // If bedtime is "after midnight" (0..06:00), shift by +24h for ordering math.
  const adjBedtime = bedtime < 6 * 60 ? bedtime + 24 * 60 : bedtime;

  if (waketime <= 7 * 60 && adjBedtime <= 23 * 60) return 'early_bird';
  if (waketime >= 9 * 60 || adjBedtime >= 24 * 60) return 'night_owl';
  return 'intermediate';
}

// ---------- archetype text --------------------------------------------------

function buildArchetypeText(s: Omit<BehavioralSummary, 'archetype_text'>): string {
  const parts: string[] = [];

  if (s.chronotype === 'early_bird') parts.push('early bird');
  else if (s.chronotype === 'night_owl') parts.push('night owl');
  else if (s.chronotype === 'intermediate') parts.push('intermediate chronotype');

  if (s.waketime_minute !== null) parts.push(`${formatMinute(s.waketime_minute)} riser`);
  if (s.bedtime_minute !== null) parts.push(`${formatMinute(s.bedtime_minute)} sleeper`);

  if (s.weekly_workout_count !== null && s.weekly_workout_count >= 0.5) {
    const r = Math.round(s.weekly_workout_count * 10) / 10;
    parts.push(`${r}× weekly gym`);
  }

  if (parts.length === 0) return 'not enough data yet';
  return parts.join(', ');
}

// ---------- data quality ----------------------------------------------------

function computeDataQuality(
  distinctDays: number,
  placeCount: number,
): BehavioralSummary['data_quality'] {
  if (distinctDays < 3) return 'none';
  if (distinctDays < 7 || placeCount < 2) return 'low';
  if (distinctDays < 14) return 'medium';
  return 'high';
}

// ---------- main ------------------------------------------------------------

export function computeSummary(
  pings: SummaryPing[],
  places: SummaryPlace[],
  routines: SummaryRoutine[],
  sleep: SummarySleep | null,
  /** Measured signals (pedometer, HealthKit) — override the inferred ones. */
  measured: { avg_daily_steps?: number | null; weekly_workout_count?: number | null } = {},
): BehavioralSummary {
  // Distinct days still derived from pings (drives data_quality alongside
  // place count). Days observed via app sessions is a separate signal.
  const perDay = new Set<string>();
  for (const p of pings) {
    perDay.add(localDayKey(p.captured_at));
  }
  const distinctDays = perDay.size;
  const data_quality = computeDataQuality(distinctDays, places.length);

  // Sleep stats come from the new session-based inference. Map the new
  // chronotype enum to the legacy one (balanced → intermediate) for
  // backwards-compatible DB writes.
  let waketime_minute: number | null = sleep?.waketime_minute ?? null;
  let bedtime_minute: number | null = sleep?.bedtime_minute ?? null;
  let chronotype: BehavioralSummary['chronotype'] = null;
  if (sleep?.chronotype === 'early_bird') chronotype = 'early_bird';
  else if (sleep?.chronotype === 'night_owl') chronotype = 'night_owl';
  else if (sleep?.chronotype === 'balanced') chronotype = 'intermediate';

  // Only surface sleep stats if the session-based inference is "high"
  // confidence (≥7 days of sessions). Otherwise clear them — better to show
  // nothing than to show wrong numbers.
  const sleepConfident = sleep?.data_quality === 'high';
  if (!sleepConfident) {
    waketime_minute = null;
    bedtime_minute = null;
    chronotype = null;
  }

  // Weekly workout count: sum consistency across gym-category routines.
  // A 1.0-consistency Tue routine + 1.0-consistency Thu routine = 2 workouts/week.
  const gymRoutines = routines.filter((r) => r.category === 'gym');
  const weekly_workout_count =
    measured.weekly_workout_count != null
      ? measured.weekly_workout_count
      : gymRoutines.length > 0
      ? Math.round(
          gymRoutines.reduce((s, r) => s + r.consistency, 0) * 10,
        ) / 10
      : null;

  const partial = {
    chronotype,
    bedtime_minute,
    waketime_minute,
    weekly_workout_count,
    avg_daily_steps: measured.avg_daily_steps ?? null,
    data_quality,
  };

  return {
    ...partial,
    archetype_text: buildArchetypeText(partial),
  };
}
