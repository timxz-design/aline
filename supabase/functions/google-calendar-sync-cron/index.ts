/**
 * google-calendar-sync-cron — Supabase Edge Function
 * ----------------------------------------------------------------------------
 * Background Google Calendar sync for EVERY connected user, so schedules stay
 * fresh without anyone opening the Week tab (the old client-only trigger let
 * data go 30+ days stale).
 *
 * Invoked by pg_cron via pg_net (no user JWT): deploy with --no-verify-jwt,
 * gated by the x-cron-key header matching the CRON_SECRET edge secret. Unlike
 * proactive-weather, a missing CRON_SECRET is a hard failure — this function
 * writes to users' Google calendars.
 *
 * Users whose refresh token is revoked (invalid_grant) are skipped: retrying
 * can't fix it, and the stored error is what CalendarReconnectBanner shows.
 * Reconnecting via google-oauth-exchange clears the error and re-enables them.
 *
 * Secrets required: CRON_SECRET, GOOGLE_OAUTH_CLIENT_ID,
 * GOOGLE_OAUTH_CLIENT_SECRET (+ built-in service role).
 * ----------------------------------------------------------------------------
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { syncUserGoogleCalendar } from '../_shared/google-sync.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET');

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!CRON_SECRET || req.headers.get('x-cron-key') !== CRON_SECRET) {
    return json({ error: 'forbidden' }, 403);
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: tokenRows, error } = await adminClient
    .from('google_oauth_tokens')
    .select('user_id, last_sync_error')
    .not('refresh_token', 'is', null);
  if (error) return json({ error: error.message }, 500);

  const results: Record<string, unknown> = {};
  for (const row of tokenRows ?? []) {
    const userId = row.user_id as string;
    if (((row.last_sync_error as string | null) ?? '').includes('invalid_grant')) {
      results[userId] = { skipped: 'revoked' };
      continue;
    }
    try {
      const r = await syncUserGoogleCalendar(adminClient, userId);
      results[userId] = r.ok
        ? { ok: true, seen: r.events_seen, upserted: r.events_upserted }
        : { ok: false, error: r.error, code: r.code };
    } catch (e) {
      // One user's failure must not stop the rest.
      results[userId] = { ok: false, error: (e as Error).message };
    }
  }

  return json({ users: Object.keys(results).length, results });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
