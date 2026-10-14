/**
 * google-calendar-sync — Supabase Edge Function
 * ----------------------------------------------------------------------------
 * Pulls events from the user's primary Google Calendar into our
 * `calendar_events` table. Idempotent: re-running upserts by (user_id,
 * source='google', external_id).
 *
 * Window: -7 days through +30 days from now. Enough to give the agent
 * recent context for routine inference and forward visibility for
 * scheduling proposals.
 *
 * Trigger: client invokes after a successful OAuth connect, and on demand
 * (Refresh button on My Week, before agent proposes a hangout, etc).
 * Background freshness comes from `google-calendar-sync-cron` (pg_cron), which
 * runs the same core (`_shared/google-sync.ts`) for every connected user.
 *
 * Token refresh: if the stored access_token is expired, we refresh it
 * via the refresh_token and persist the new access_token.
 *
 * Secrets required:
 *   - GOOGLE_OAUTH_CLIENT_ID
 *   - GOOGLE_OAUTH_CLIENT_SECRET
 * ----------------------------------------------------------------------------
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { syncUserGoogleCalendar } from '../_shared/google-sync.ts';

const GOOGLE_OAUTH_CLIENT_ID = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonRes({ error: 'POST required' }, 405);

  if (!GOOGLE_OAUTH_CLIENT_ID) {
    return jsonRes({ error: 'Google OAuth not configured.' }, 500);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return jsonRes({ error: 'Missing Authorization' }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) return jsonRes({ error: 'Unauthorized' }, 401);

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const result = await syncUserGoogleCalendar(adminClient, user.id);
  if (!result.ok) {
    return jsonRes(
      { error: result.error, code: result.code, detail: result.detail },
      result.status
    );
  }
  return jsonRes(
    {
      success: true,
      events_seen: result.events_seen,
      events_upserted: result.events_upserted,
      window: result.window,
    },
    200
  );
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
