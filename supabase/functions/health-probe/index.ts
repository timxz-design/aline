/**
 * health-probe — cron (x-cron-key), daily before the health check.
 * Makes one real, minimal call to each outside service ALINE depends on and
 * records pass/fail in `system_health_probes`. Exists because these failed
 * silently before (Google billing was off for months; every caller just
 * carried on without the data).
 */
// @ts-nocheck Deno edge runtime
import { createClient } from 'jsr:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk@0.135.0';

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
    // Anthropic: the agent itself — the same SDK streaming call with the
    // agent's model and settings, through one full tool round (assistant turn
    // passed back verbatim), so a rejected config shows up here, not as users'
    // messages going unanswered.
    check('anthropic', async () => {
      if (!ANTHROPIC_KEY) throw new Error('no key configured');
      const model = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-5-5';
      const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
      const params = {
        model,
        max_tokens: 256,
        ...(model.startsWith('claude-sonnet-5-5')
          ? { thinking: { type: 'between_tools' }, output_config: { effort: 'medium' } }
          : {}),
        tools: [{ name: 'ping', description: 'Health check tool. Returns pong.', input_schema: { type: 'object', properties: {} } }],
      };
      const messages = [{ role: 'user', content: 'Call the ping tool once, then reply with the word ok.' }];
      let deltas = 0;
      let rounds = 0;
      for (; rounds < 3; rounds++) {
        const stream = anthropic.messages.stream({ ...params, messages });
        stream.on('text', () => deltas++);
        const msg = await stream.finalMessage();
        const calls = msg.content.filter((b) => b.type === 'tool_use');
        if (msg.stop_reason !== 'tool_use' || calls.length === 0) {
          const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
          return `${model}: ${text.slice(0, 20)} (rounds ${rounds + 1}, deltas ${deltas})`;
        }
        messages.push({ role: 'assistant', content: msg.content });
        messages.push({ role: 'user', content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'pong' })) });
      }
      throw new Error('no final answer after 3 rounds');
    }),
  ]);

  await admin.from('system_health_probes').insert(results);
  return Response.json(results);
});
