/**
 * name-stays — cron (x-cron-key). Looks up what a recent stop was: for each
 * stay of 15+ min that isn't at a known place and has no lookup nearby yet,
 * ask Google Places with the stay-aware ranking and store the answer in
 * `stay_names` (by location, so later stops at the same spot reuse it).
 * predict_visit_activity then shows it as a guess ("EF, University…?").
 */
// @ts-nocheck Deno edge runtime
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { bestForStay, placesConfigured, rankPlacesForStay } from '../_shared/place-rank.ts';

const CRON_SECRET = Deno.env.get('CRON_SECRET');
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get('x-cron-key') !== CRON_SECRET) return new Response('unauthorized', { status: 401 });
  if (!placesConfigured()) return Response.json({ error: 'places not configured' });

  const { data: todo, error } = await admin.rpc('stays_needing_names', { _limit: 20 });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const out: unknown[] = [];
  for (const s of todo ?? []) {
    try {
      const best = bestForStay(await rankPlacesForStay(s.lat, s.lon, s.minutes, 120));
      await admin.from('stay_names').insert({
        user_id: s.user_id,
        lat: s.lat,
        lon: s.lon,
        name: best?.name ?? null, // null = looked, nothing fitting — don't ask again
        primary_type: best?.primaryType ?? null,
        types: best?.types.join(',') ?? null,
      });
      out.push({ minutes: s.minutes, name: best?.name ?? null });
    } catch (e) {
      out.push({ error: String(e) }); // e.g. Google down: retried next run
    }
  }
  return Response.json({ looked_up: out.length, results: out });
});
