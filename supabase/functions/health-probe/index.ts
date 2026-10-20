/**
 * health-probe — cron (x-cron-key), daily before the health check.
 * Makes one real, minimal call to each outside service ALINE depends on and
 * records pass/fail in `system_health_probes`. Exists because these failed
 * silently before (Google billing was off for months; every caller just
 * carried on without the data).
 */
// @ts-nocheck Deno edge runtime
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CRON_SECRET = Deno.env.get('CRON_SECRET');
const PLACES_KEY = Deno.env.get('GOOGLE_PLACES_API_KEY') ?? Deno.env.get('GOOGLE_MAPS_API_KEY');
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

type Result = { service: string; ok: boolean; detail: string };

async function check(service: string, fn: () => Promise<string>): Promise<Result> {
  try {
    return { service, ok: true, detail: await fn() };
  } catch (e) {
    return { service, ok: false, detail: String(e).slice(0, 300) };
  }
}

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get('x-cron-key') !== CRON_SECRET) return new Response('unauthorized', { status: 401 });

  const results = await Promise.all([
    // Places (New): naming places and stops, venue search.
    check('google_places', async () => {
      if (!PLACES_KEY) throw new Error('no key configured');
      const r = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': 'places.id' },
        body: JSON.stringify({ maxResultCount: 1, locationRestriction: { circle: { center: { latitude: 46.0514, longitude: 14.506 }, radius: 200 } } }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return 'ok';
    }),
    // Distance Matrix: travel times / when to leave.
    check('google_distance_matrix', async () => {
      if (!PLACES_KEY) throw new Error('no key configured');
      const j = await fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?origins=46.0514,14.506&destinations=46.0569,14.5058&mode=driving&key=${PLACES_KEY}`).then((r) => r.json());
      const el = j.rows?.[0]?.elements?.[0];
      if (j.status !== 'OK' || el?.status !== 'OK') throw new Error(`${j.status} ${el?.status ?? ''} ${j.error_message ?? ''}`);
      return el.duration?.text ?? 'ok';
    }),
    // Anthropic: the agent itself. Listing models is free and proves the key works.
    check('anthropic', async () => {
      if (!ANTHROPIC_KEY) throw new Error('no key configured');
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return 'ok';
    }),
  ]);

  await admin.from('system_health_probes').insert(results);
  return Response.json(results);
});
