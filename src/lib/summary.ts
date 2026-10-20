/**
 * Behavioral summary (sleep window, chronotype, steps, workouts) is built on
 * the server now — `rebuild-summaries`, every 6 hours, for every active user —
 * so it's current even for people who rarely open the app. The algorithm lives
 * in supabase/functions/_shared/{sleep-inference,summary-algo}.ts. No-op here
 * so the pipeline shape is intact.
 */
export async function recomputeBehavioralSummaryForCurrentUser(): Promise<{
  pingsRead: number;
  placesRead: number;
  routinesRead: number;
  error?: string;
}> {
  return { pingsRead: 0, placesRead: 0, routinesRead: 0 };
}
