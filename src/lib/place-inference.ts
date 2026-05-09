/**
 * Place inference — combine three signal sources into a single
 * (name, category, confidence) tuple per place.
 *
 *   1. Google Places match — name + primary_type. High confidence (0.95) when
 *      Google returns a result.
 *   2. Time-of-day distribution — overnight / weekday-9-to-5 / mixed pattern.
 *      Heuristic categories: home, work, other.
 *   3. Frequency / span — small one-off clusters get suppressed (`is_hidden=true`)
 *      so the user doesn't get nagged about places that turned out not to be
 *      part of their life.
 *
 * Pure module — no I/O, no Supabase. Composable into both the on-device
 * clustering pipeline and the resolve-places edge function. The caller
 * supplies inputs; we return what to write.
 *
 * Confidence thresholds tuned conservatively for v1:
 *   ≥ 0.85 → auto-confirm (inference_status='confirmed', user never asked)
 *   0.4 - 0.85 → pending, surface in curiosity card with "I think this is X"
 *   < 0.4  → pending, surface as "What is this place?"
 */

export type PlaceInferencePing = {
  /** ISO timestamp. */
  captured_at: string;
};

export type PlaceInferenceInput = {
  pings: PlaceInferencePing[];
  /** Optional Google Places match. If present, it dominates the inference. */
  google?: {
    name: string | null;
    primary_type: string | null;
    /** Stable category (gym/food/home/etc) computed from primary_type. */
    category: string | null;
  } | null;
  /** First time we saw any ping at this place (UTC ISO). */
  first_seen?: string | null;
  /** Most recent ping at this place (UTC ISO). */
  last_seen?: string | null;
};

export type PlaceInferenceResult = {
  /** Best-guess display name. May be null if we genuinely have no idea. */
  name: string | null;
  /** Stable category bucket. */
  category: string | null;
  /** 0..1 confidence in the (name, category) pair. */
  confidence: number;
  /** Where the label came from (for debugging / agent context). */
  label_source: 'google' | 'time_of_day' | 'low_signal' | 'none';
  /** True if this is a one-off cluster (small + short span); should be hidden. */
  hide_as_outing: boolean;
};

// ---------- thresholds (exported for tests) -------------------------------

export const PLACE_INFERENCE_THRESHOLDS = {
  /** Pings at a "home" pattern — dominant during overnight hours. */
  home_overnight_ratio: 0.6,
  home_min_distinct_days: 5,
  /** Pings at a "work / school" pattern — weekdays 9-17. */
  work_weekday_business_ratio: 0.5,
  work_min_weekdays: 3,
  /** Anything below this is too small a sample to label confidently. */
  min_pings_for_inference: 5,
  /** Outing detection: short span + few pings = ignore. */
  outing_max_span_days: 3,
  outing_max_distinct_days: 2,
  /** Confidence floors. */
  confirm_threshold: 0.85,
  pending_threshold: 0.4,
  /** Boosts. */
  google_match_confidence: 0.95,
  time_pattern_confidence: 0.75,
  weak_signal_confidence: 0.5,
} as const;

// ---------- helpers --------------------------------------------------------

function hourOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours();
}

function dayOfWeek(iso: string): number {
  // 0 = Sun ... 6 = Sat. Local-time, matches our routine code.
  return new Date(iso).getDay();
}

function localDayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function distinctLocalDays(pings: PlaceInferencePing[]): number {
  const set = new Set<string>();
  for (const p of pings) set.add(localDayKey(p.captured_at));
  return set.size;
}

function distinctWeekdays(pings: PlaceInferencePing[]): number {
  const set = new Set<number>();
  for (const p of pings) {
    const dow = dayOfWeek(p.captured_at);
    if (dow >= 1 && dow <= 5) set.add(dow); // Mon..Fri
  }
  return set.size;
}

function spanDays(first: string | null | undefined, last: string | null | undefined): number {
  if (!first || !last) return 0;
  const ms = new Date(last).getTime() - new Date(first).getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

function ratio(matching: number, total: number): number {
  return total === 0 ? 0 : matching / total;
}

// Time-of-day buckets. Local hours.
function isOvernight(h: number): boolean { return h >= 22 || h < 7; }
function isBusinessHours(h: number, dow: number): boolean {
  return dow >= 1 && dow <= 5 && h >= 9 && h < 17;
}

// ---------- main -----------------------------------------------------------

export function inferPlaceLabel(input: PlaceInferenceInput): PlaceInferenceResult {
  const T = PLACE_INFERENCE_THRESHOLDS;
  const pings = input.pings;
  const total = pings.length;

  // Outing check first — if it looks like a one-off trip, suppress it.
  const span = spanDays(input.first_seen, input.last_seen);
  const distinctDays = distinctLocalDays(pings);
  const isOuting =
    span <= T.outing_max_span_days &&
    distinctDays <= T.outing_max_distinct_days &&
    !input.google; // a Google-matched place is real even if visited once

  // Helpers for time-of-day pattern analysis.
  const overnightCount = pings.filter((p) => isOvernight(hourOfDay(p.captured_at))).length;
  const businessCount = pings.filter((p) => {
    const d = new Date(p.captured_at);
    return isBusinessHours(d.getHours(), d.getDay());
  }).length;
  const overnightRatio = ratio(overnightCount, total);
  const businessRatio = ratio(businessCount, total);
  const weekdayCount = distinctWeekdays(pings);

  // ---- 1. Google match dominates (when present) -------------------------
  if (input.google && (input.google.name || input.google.category)) {
    const name = input.google.name ?? null;
    const category = input.google.category ?? null;
    return {
      name,
      category,
      confidence: T.google_match_confidence,
      label_source: 'google',
      hide_as_outing: isOuting,
    };
  }

  // Below this point, no Google match. Fall back to time-of-day inference.

  // Not enough data to make any call.
  if (total < T.min_pings_for_inference) {
    return {
      name: null,
      category: null,
      confidence: 0,
      label_source: 'low_signal',
      hide_as_outing: isOuting,
    };
  }

  // ---- 2. Time-of-day inference ------------------------------------------
  const isHomePattern =
    overnightRatio >= T.home_overnight_ratio && distinctDays >= T.home_min_distinct_days;
  if (isHomePattern) {
    return {
      name: 'Home',
      category: 'home',
      confidence: T.time_pattern_confidence,
      label_source: 'time_of_day',
      hide_as_outing: false,
    };
  }

  const isWorkPattern =
    businessRatio >= T.work_weekday_business_ratio && weekdayCount >= T.work_min_weekdays;
  if (isWorkPattern) {
    return {
      name: 'Work / school',
      category: 'work',
      confidence: T.time_pattern_confidence,
      label_source: 'time_of_day',
      hide_as_outing: false,
    };
  }

  // ---- 3. Weak signal — surface as "what is this?" ------------------------
  // We have enough pings to know it's a real place but no clear pattern.
  // Confidence below pending threshold means the curiosity card will ask
  // "What is this place?" rather than "I think this is X".
  return {
    name: null,
    category: null,
    confidence: T.weak_signal_confidence,
    label_source: 'low_signal',
    hide_as_outing: isOuting,
  };
}

/** Helper: pick inference_status from confidence. */
export function statusFromConfidence(
  confidence: number,
): 'confirmed' | 'pending' {
  return confidence >= PLACE_INFERENCE_THRESHOLDS.confirm_threshold
    ? 'confirmed'
    : 'pending';
}
