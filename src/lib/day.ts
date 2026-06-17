/**
 * Timezone-aware day helpers shared across the day-strip and any view that
 * needs to reason about "today in the user's local timezone". Extracted from
 * the former MorningPanel.
 */

/** Returns 'YYYY-MM-DD' for `date` in `timezone`. */
export function localDayKey(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Format a UTC ISO time as a short local-time string (e.g. "14:30"). */
export function shortTime(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

/** Offset of `timezone` (in minutes) from UTC for the given instant. */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  try {
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
  } catch {
    return 0;
  }
}

/** UTC ISO bounds [start, end) for "today in `timezone`", given its day key. */
export function localDayBoundsIso(dayKey: string, timezone: string): {
  startIso: string;
  endIso: string;
} {
  const naive = new Date(`${dayKey}T00:00:00Z`);
  const offsetMin = tzOffsetMinutes(naive, timezone);
  const startIso = new Date(naive.getTime() - offsetMin * 60_000).toISOString();
  const endIso = new Date(new Date(startIso).getTime() + 86_400_000).toISOString();
  return { startIso, endIso };
}
