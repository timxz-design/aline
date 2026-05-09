/**
 * Shared timezone helpers for Supabase Edge Functions.
 *
 * Used by both agent-respond and agent-daily-scan to interpret naive
 * ISO datetimes ("2026-04-29T14:00:00") as wall-clock time in a specific
 * user timezone, then convert to UTC for storage. This is what we mean
 * by "the user said tomorrow at 2pm" — they meant their local 2pm,
 * not UTC 2pm.
 */

/** Detect whether an ISO datetime string already carries a timezone suffix.
 *  Matches `Z` or `+HH:MM` / `-HH:MM` (with or without the colon). */
export function hasTimezoneSuffix(iso: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso.trim());
}

/** Compute a timezone's UTC offset (in minutes) for a given instant.
 *  E.g. for Europe/Ljubljana on 2026-07-15 → 120 (CEST = UTC+2). */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const o: Record<string, string> = {};
  for (const p of parts) o[p.type] = p.value;
  const asUtc = Date.UTC(
    +o.year,
    +o.month - 1,
    +o.day,
    +(o.hour === '24' ? '0' : o.hour),
    +o.minute,
    +o.second,
  );
  return (asUtc - date.getTime()) / 60_000;
}

/** Convert a naive ISO datetime ("2026-04-29T14:00:00") interpreted as
 *  wall-clock time in `timezone`, into a UTC ISO string. */
export function naiveLocalToUtcIso(naiveISO: string, timezone: string): string {
  const seed = new Date(naiveISO + (naiveISO.endsWith('Z') ? '' : 'Z'));
  const offsetMin = tzOffsetMinutes(seed, timezone);
  const realUtc = new Date(seed.getTime() - offsetMin * 60_000);
  return realUtc.toISOString();
}

/** Normalize whatever the agent gave us into a valid UTC ISO string.
 *   - If the string carries Z or ±HH:MM → trust the offset, normalize via Date.
 *   - If the string is naive (no offset) → interpret it as local time in the
 *     user's timezone. This is almost always what they meant by "2pm tomorrow".
 *   - Returns null on unparseable input. */
export function normalizeIsoToUtc(raw: string, userTimezone: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    if (hasTimezoneSuffix(trimmed)) {
      const d = new Date(trimmed);
      if (isNaN(d.getTime())) return null;
      return d.toISOString();
    }
    return naiveLocalToUtcIso(trimmed, userTimezone);
  } catch {
    return null;
  }
}
