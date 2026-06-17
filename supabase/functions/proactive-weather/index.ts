/**
 * proactive-weather — Supabase Edge Function (cron-invoked)
 * ----------------------------------------------------------------------------
 * Sweeps every user's next ~12h of OUTDOOR-looking calendar blocks (walk, run,
 * hike, bike…), checks the OpenWeather 3h forecast near their home, and — when
 * the forecast at block time is bad — nudges them via try_proactive_push
 * (which enforces quiet hours, the daily cap, and per-block dedupe).
 *
 * Invoked hourly by pg_cron via pg_net (no user JWT): verify_jwt=false, gated
 * by the x-cron-key header matching the CRON_SECRET edge secret instead.
 *
 * Secrets required: OPENWEATHER_API_KEY, CRON_SECRET (+ built-in service role).
 * ----------------------------------------------------------------------------
 */

// @ts-expect-error — Deno-only deps; runs in Supabase Edge Runtime.
import { createClient } from 'jsr:@supabase/supabase-js@2';

// @ts-expect-error
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// @ts-expect-error
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// @ts-expect-error
const OPENWEATHER_API_KEY = Deno.env.get('OPENWEATHER_API_KEY');
// @ts-expect-error
const CRON_SECRET = Deno.env.get('CRON_SECRET');

const OUTDOOR_RE =
  /\b(walk|run|jog|hike|hiking|bike|cycling|picnic|tennis|football|soccer|basketball|golf|swim|climb|kayak|ski|outdoor)\b/i;

// @ts-expect-error
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (CRON_SECRET && req.headers.get('x-cron-key') !== CRON_SECRET) {
    return json({ error: 'forbidden' }, 403);
  }
  if (!OPENWEATHER_API_KEY) return json({ error: 'OPENWEATHER_API_KEY missing' }, 500);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: blocks, error } = await db
    .from('calendar_events')
    .select('id, user_id, title, start_at')
    .in('event_type', ['flexible', 'goal', 'routine'])
    .gte('start_at', new Date().toISOString())
    .lt('start_at', new Date(Date.now() + 12 * 3600_000).toISOString());
  if (error) return json({ error: error.message }, 500);

  const outdoor = (blocks ?? []).filter((b) => OUTDOOR_RE.test(b.title ?? ''));
  if (outdoor.length === 0) return json({ checked: 0, pushed: 0 });

  // One forecast per user.
  const byUser = new Map<string, typeof outdoor>();
  for (const b of outdoor) {
    if (!byUser.has(b.user_id)) byUser.set(b.user_id, []);
    byUser.get(b.user_id)!.push(b);
  }

  let pushed = 0;
  for (const [userId, userBlocks] of byUser) {
    const { data: home } = await db
      .from('places')
      .select('centroid_lat, centroid_lon')
      .eq('user_id', userId)
      .not('centroid_lat', 'is', null)
      .or('category.eq.home,user_label.ilike.home')
      .limit(1)
      .maybeSingle();
    if (home?.centroid_lat == null) continue;

    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/forecast?lat=${home.centroid_lat}&lon=${home.centroid_lon}&units=metric&appid=${OPENWEATHER_API_KEY}`,
    );
    if (!res.ok) continue;
    const fc = (await res.json()) as {
      list?: Array<{ dt: number; main?: { temp?: number }; weather?: Array<{ main?: string; description?: string }>; pop?: number }>;
    };
    const steps = fc.list ?? [];

    for (const b of userBlocks) {
      const t = new Date(b.start_at).getTime();
      let best: (typeof steps)[number] | null = null;
      let bestGap = Infinity;
      for (const s of steps) {
        const gap = Math.abs(s.dt * 1000 - t);
        if (gap < bestGap) { bestGap = gap; best = s; }
      }
      if (!best || bestGap > 3 * 3600_000) continue;

      const pop = best.pop ?? 0;
      const cond = (best.weather?.[0]?.main ?? '').toLowerCase();
      const temp = best.main?.temp ?? 20;
      const bad =
        pop >= 0.5 || ['rain', 'thunderstorm', 'snow', 'drizzle'].includes(cond) ||
        temp >= 33 || temp <= -5;
      if (!bad) continue;

      const why =
        pop >= 0.5 || ['rain', 'thunderstorm', 'snow', 'drizzle'].includes(cond)
          ? `${Math.round(pop * 100)}% chance of ${best.weather?.[0]?.description ?? 'rain'}`
          : `it'll be around ${Math.round(temp)} degrees`;

      const { data: ok } = await db.rpc('try_proactive_push', {
        _user: userId,
        _kind: 'weather',
        _dedupe: `weather:${b.id}`,
        _title: 'Weather heads-up',
        _body: `Your "${b.title}" might hit bad weather — ${why}. Want me to find a better slot? Just open the chat.`,
        _data: { type: 'weather', event_id: b.id },
      });
      if (ok === true) pushed++;
    }
  }

  return json({ checked: outdoor.length, pushed });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
