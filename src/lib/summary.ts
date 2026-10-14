/**
 * Behavioral summary — Supabase pipeline wrapper.
 *
 *   pings + places + routines  →  computeSummary()  →  behavioral_summary row
 *
 * Pure algorithm lives in summary-algo.ts. This file is the React Native bridge.
 */

import { inferSleep, inferSleepFromHealth } from './sleep-inference';
import { computeSummary, type BehavioralSummary } from './summary-algo';
import { supabase } from './supabase';

const PING_WINDOW_DAYS = 30;
const SESSION_WINDOW_DAYS = 30;
const HEALTH_SLEEP_DAYS = 21;
const STEPS_DAYS = 14;
const WORKOUT_WEEKS = 4;

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

  const sincePings = new Date(Date.now() - PING_WINDOW_DAYS * 86_400_000).toISOString();
  const sinceSessions = new Date(Date.now() - SESSION_WINDOW_DAYS * 86_400_000).toISOString();

  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const [pingsRes, placesRes, routinesRes, sessionsRes, profileRes, sleepRes, stepsRes, workoutsRes] = await Promise.all([
    supabase
      .from('behavioral_pings')
      .select('captured_at')
      .eq('user_id', session.user.id)
      .gte('captured_at', sincePings),
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
    supabase
      .from('app_sessions')
      .select('opened_at')
      .eq('user_id', session.user.id)
      .gte('opened_at', sinceSessions)
      .order('opened_at', { ascending: true }),
    supabase
      .from('profiles')
      .select('timezone')
      .eq('id', session.user.id)
      .maybeSingle(),
    supabase
      .from('health_sleep')
      .select('stage, started_at, ended_at')
      .eq('user_id', session.user.id)
      .gte('started_at', daysAgo(HEALTH_SLEEP_DAYS)),
    supabase
      .from('step_counts')
      .select('hour_start, steps')
      .eq('user_id', session.user.id)
      .gte('hour_start', daysAgo(STEPS_DAYS)),
    supabase
      .from('health_workouts')
      .select('duration_min')
      .eq('user_id', session.user.id)
      .gte('started_at', daysAgo(WORKOUT_WEEKS * 7)),
  ]);

  if (pingsRes.error) return { pingsRead: 0, placesRead: 0, routinesRead: 0, error: pingsRes.error.message };
  if (placesRes.error) return { pingsRead: 0, placesRead: 0, routinesRead: 0, error: placesRes.error.message };
  if (routinesRes.error) return { pingsRead: 0, placesRead: 0, routinesRead: 0, error: routinesRes.error.message };

  const pings = pingsRes.data ?? [];
  const places = placesRes.data ?? [];
  const routines = (routinesRes.data ?? []).map((r) => ({
    category: r.category,
    consistency: r.consistency ?? 0,
  }));
  const sessions = sessionsRes.data ?? [];
  const timezone =
    (profileRes.data as { timezone: string | null } | null)?.timezone ?? 'UTC';

  // Sleep: measured HealthKit nights win; app-session inference is the fallback.
  const healthSleep = inferSleepFromHealth(sleepRes.data ?? [], timezone);
  const sleep =
    healthSleep.data_quality === 'high'
      ? healthSleep
      : inferSleep({ sessions: sessions as { opened_at: string }[], timezone });

  // Steps: average over local days, skipping today (still filling) and days
  // the phone recorded nothing at all (not carried / no data).
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  const perDay = new Map<string, number>();
  for (const r of stepsRes.data ?? []) {
    const day = new Date(r.hour_start).toLocaleDateString('en-CA', { timeZone: timezone });
    if (day === todayKey) continue;
    perDay.set(day, (perDay.get(day) ?? 0) + r.steps);
  }
  const stepDays = [...perDay.values()].filter((n) => n > 0);
  const avg_daily_steps =
    stepDays.length >= 3 ? Math.round(stepDays.reduce((a, b) => a + b, 0) / stepDays.length) : null;

  // Workouts: measured sessions ≥10 min per week, when Health has any.
  const workouts = (workoutsRes.data ?? []).filter((w) => (w.duration_min ?? 0) >= 10);
  const weekly_workout_count =
    workouts.length > 0 ? Math.round((workouts.length / WORKOUT_WEEKS) * 10) / 10 : null;

  const summary = computeSummary(pings, places, routines, sleep, {
    avg_daily_steps,
    weekly_workout_count,
  });

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
