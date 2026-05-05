/**
 * Behavioral summary algorithm — pure, no I/O.
 *
 *   pings + places + routines  →  one-row summary the agent can read directly
 *
 * Outputs:
 *   - chronotype:        early_bird | night_owl | intermediate | null
 *   - waketime_minute:   avg minute-of-day of first ping each day  (proxy)
 *   - bedtime_minute:    avg minute-of-day of last ping each day   (proxy)
 *   - weekly_workout_count: sum of `consistency` over gym-category routines
 *   - avg_daily_steps:   placeholder (filled by HealthKit/Fit in Step 5)
 *   - data_quality:      none | low | medium | high
 *   - archetype_text:    one-line description for the agent system prompt
 *
 * Note on bedtime/waketime: GPS alone can't distinguish "asleep" from "still
 * at home, awake". These minute values are best-effort proxies — the user
 * leaves home for the day at ~waketime, comes home for the night at ~bedtime.
 * Step 5 (HealthKit/Fit) replaces these with real sleep data.
 */

export type SummaryPing = { captured_at: string };
export type SummaryPlace = { category: string | null; visit_count: number };
export type SummaryRoutine = {
  category: string | null;
  consistency: number;
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
): BehavioralSummary {
  // First and last ping minute-of-day, per local day.
  const perDay = new Map<string, { first: number; last: number }>();
  for (const p of pings) {
    const day = localDayKey(p.captured_at);
    const m = minuteOfDay(p.captured_at);
    const cur = perDay.get(day);
    if (!cur) perDay.set(day, { first: m, last: m });
    else {
      if (m < cur.first) cur.first = m;
      if (m > cur.last)  cur.last  = m;
    }
  }

  const distinctDays = perDay.size;
  const data_quality = computeDataQuality(distinctDays, places.length);

  let waketime_minute: number | null = null;
  let bedtime_minute: number | null = null;
  if (distinctDays > 0) {
    const firsts = Array.from(perDay.values()).map((v) => v.first);
    const lasts  = Array.from(perDay.values()).map((v) => v.last);
    waketime_minute = Math.round(average(firsts));
    bedtime_minute  = Math.round(average(lasts));
  }

  const chronotype = computeChronotype(waketime_minute, bedtime_minute);

  // Weekly workout count: sum consistency across gym-category routines.
  // A 1.0-consistency Tue routine + 1.0-consistency Thu routine = 2 workouts/week.
  const gymRoutines = routines.filter((r) => r.category === 'gym');
  const weekly_workout_count =
    gymRoutines.length > 0
      ? Math.round(
          gymRoutines.reduce((s, r) => s + r.consistency, 0) * 10,
        ) / 10
      : null;

  const partial = {
    chronotype,
    bedtime_minute,
    waketime_minute,
    weekly_workout_count,
    avg_daily_steps: null as number | null,
    data_quality,
  };

  return {
    ...partial,
    archetype_text: buildArchetypeText(partial),
  };
}
