/**
 * Behavioral summary — Supabase pipeline wrapper.
 *
 *   pings + places + routines  →  computeSummary()  →  behavioral_summary row
 *
 * Pure algorithm lives in summary-algo.ts. This file is the React Native bridge.
 */

import { computeSummary, type BehavioralSummary } from './summary-algo';
import { supabase } from './supabase';

const PING_WINDOW_DAYS = 30;

export type { BehavioralSummary };
export { computeSummary };

export async function recomputeBehavioralSummaryForCurrentUser(): Promise<{
  summary?: BehavioralSummary;
  pingsRead: number;
  placesRead: number;
  routinesRead: number;
  error?: string;
}> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return { pingsRead: 0, placesRead: 0, routinesRead: 0, error: 'not signed in' };
  }

  const since = new Date(Date.now() - PING_WINDOW_DAYS * 86_400_000).toISOString();

  const [pingsRes, placesRes, routinesRes] = await Promise.all([
    supabase
      .from('behavioral_pings')
      .select('captured_at')
      .eq('user_id', session.user.id)
      .gte('captured_at', since),
    supabase
      .from('places')
      .select('category, visit_count')
      .eq('user_id', session.user.id)
      .eq('is_hidden', false),
    supabase
      .from('routines')
      .select('category, consistency')
      .eq('user_id', session.user.id)
      .eq('active', true),
  ]);

  if (pingsRes.error) return { pingsRead: 0, placesRead: 0, routinesRead: 0, error: pingsRes.error.message };
  if (placesRes.error) return { pingsRead: 0, placesRead: 0, routinesRead: 0, error: placesRes.error.message };
  if (routinesRes.error) return { pingsRead: 0, placesRead: 0, routinesRead: 0, error: routinesRes.error.message };

  const pings = pingsRes.data ?? [];
  const places = placesRes.data ?? [];
  const routines = routinesRes.data ?? [];

  const summary = computeSummary(pings, places, routines);

  // Upsert into behavioral_summary (PK = user_id)
  const { error: upsertErr } = await supabase
    .from('behavioral_summary')
    .upsert(
      {
        user_id: session.user.id,
        archetype_text: summary.archetype_text,
        chronotype: summary.chronotype,
        bedtime_minute: summary.bedtime_minute,
        waketime_minute: summary.waketime_minute,
        weekly_workout_count: summary.weekly_workout_count,
        avg_daily_steps: summary.avg_daily_steps,
        data_quality: summary.data_quality,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

  if (upsertErr) {
    return {
      pingsRead: pings.length,
      placesRead: places.length,
      routinesRead: routines.length,
      error: upsertErr.message,
    };
  }

  return {
    summary,
    pingsRead: pings.length,
    placesRead: places.length,
    routinesRead: routines.length,
  };
}
