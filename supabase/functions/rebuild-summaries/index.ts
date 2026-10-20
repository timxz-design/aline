/**
 * rebuild-summaries — cron (x-cron-key). Computes each active user's
 * behavioral summary (sleep window, chronotype, steps, workouts, data quality)
 * on the server, from the same inputs the phone used to read. Moved off the
 * phone so it's current for every tester, including those who rarely open the
 * app. Same pure algorithm (_shared/sleep-inference.ts, _shared/summary-algo.ts).
 */
// @ts-nocheck Deno edge runtime
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { inferSleep, inferSleepFromHealth } from '../_shared/sleep-inference.ts';
import { computeSummary } from '../_shared/summary-algo.ts';

const CRON_SECRET = Deno.env.get('CRON_SECRET');
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const WORKOUT_WEEKS = 4;

async function rebuild(userId: string, timezone: string) {
  const [pingsRes, placesRes, routinesRes, sessionsRes, sleepRes, stepsRes, workoutsRes] = await Promise.all([
    admin.from('behavioral_pings').select('captured_at').eq('user_id', userId).gte('captured_at', daysAgo(30)),
    admin.from('places').select('category, visit_count').eq('user_id', userId).eq('is_hidden', false),
    admin.from('routines').select('category, consistency').eq('user_id', userId).eq('active', true),
    admin.from('app_sessions').select('opened_at').eq('user_id', userId).gte('opened_at', daysAgo(30)).order('opened_at', { ascending: true }),
    admin.from('health_sleep').select('stage, started_at, ended_at').eq('user_id', userId).gte('started_at', daysAgo(21)),
    admin.from('step_counts').select('hour_start, steps').eq('user_id', userId).gte('hour_start', daysAgo(14)),
    admin.from('health_workouts').select('duration_min').eq('user_id', userId).gte('started_at', daysAgo(WORKOUT_WEEKS * 7)),
  ]);
  const err = [pingsRes, placesRes, routinesRes].find((r) => r.error)?.error;
  if (err) throw new Error(err.message);

  // Sleep: measured Apple Health nights win; app-open times are the fallback.
  const healthSleep = inferSleepFromHealth(sleepRes.data ?? [], timezone);
  const sleep = healthSleep.data_quality === 'high'
    ? healthSleep
    : inferSleep({ sessions: sessionsRes.data ?? [], timezone });

  // Steps: average over full local days with any steps (today is still filling).
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  const perDay = new Map<string, number>();
  for (const r of stepsRes.data ?? []) {
    const day = new Date(r.hour_start).toLocaleDateString('en-CA', { timeZone: timezone });
    if (day !== todayKey) perDay.set(day, (perDay.get(day) ?? 0) + r.steps);
  }
  const stepDays = [...perDay.values()].filter((n) => n > 0);
  const avg_daily_steps = stepDays.length >= 3 ? Math.round(stepDays.reduce((a, b) => a + b, 0) / stepDays.length) : null;

  const workouts = (workoutsRes.data ?? []).filter((w) => (w.duration_min ?? 0) >= 10);
  const weekly_workout_count = workouts.length > 0 ? Math.round((workouts.length / WORKOUT_WEEKS) * 10) / 10 : null;

  const routines = (routinesRes.data ?? []).map((r) => ({ category: r.category, consistency: r.consistency ?? 0 }));
  const s = computeSummary(pingsRes.data ?? [], placesRes.data ?? [], routines, sleep, { avg_daily_steps, weekly_workout_count });

  const { error } = await admin.from('behavioral_summary').upsert({
    user_id: userId,
    archetype_text: s.archetype_text,
    chronotype: s.chronotype,
    bedtime_minute: s.bedtime_minute,
    waketime_minute: s.waketime_minute,
    weekly_workout_count: s.weekly_workout_count,
    avg_daily_steps: s.avg_daily_steps,
    data_quality: s.data_quality,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
  return { bedtime: s.bedtime_minute, wake: s.waketime_minute, quality: s.data_quality };
}

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get('x-cron-key') !== CRON_SECRET) return new Response('unauthorized', { status: 401 });

  // Active = any location data or app open in the last 30 days.
  const { data: users, error } = await admin.rpc('summary_users');
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results: Record<string, unknown> = {};
  for (const u of users ?? []) {
    try {
      results[u.user_id] = await rebuild(u.user_id, u.timezone || 'UTC');
    } catch (e) {
      results[u.user_id] = { error: String(e) };
    }
  }
  return Response.json({ users: (users ?? []).length, results });
});
