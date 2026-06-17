/**
 * google-calendar-write — Supabase Edge Function
 * ----------------------------------------------------------------------------
 * Writes to the user's primary Google Calendar: create / update / delete
 * events, with sendUpdates=all so Google emails attendees. Auth: user JWT
 * (same pattern as google-calendar-sync). Requires the calendar.events scope
 * (granted on reconnect after the scope upgrade) — a 403 means the user must
 * reconnect Google with write permission.
 *
 * Body: { op: 'create_event' | 'update_event' | 'delete_event', ... }
 *   create_event: { title, start, end, description?, location?, attendee_emails? }
 *   update_event: { google_event_id, title, start, end, description?, location?, attendee_emails? }
 *   delete_event: { google_event_id }
 *
 * Returns { success, id? } or { error, detail?, code? }.
 * ----------------------------------------------------------------------------
 */

// @ts-nocheck Deno edge runtime
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  createGoogleEvent,
  deleteGoogleEvent,
  getValidAccessToken,
  patchGoogleEvent,
  type GoogleEventInput,
} from '../_shared/google-auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonRes({ error: 'POST required' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return jsonRes({ error: 'Missing Authorization' }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return jsonRes({ error: 'Unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }
  const op = body.op as string;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const tokenRes = await getValidAccessToken(admin, user.id);
  if (!tokenRes.ok) {
    const status = tokenRes.code === 'no_connection' ? 400 : 502;
    return jsonRes({ error: tokenRes.detail, code: tokenRes.code }, status);
  }
  const token = tokenRes.accessToken;

  const recordError = async (detail: string) => {
    await admin
      .from('google_oauth_tokens')
      .update({ last_sync_error: detail.slice(0, 500) })
      .eq('user_id', user.id);
  };

  if (op === 'create_event' || op === 'update_event') {
    const input: GoogleEventInput = {
      title: String(body.title ?? '').trim() || '(untitled)',
      start: String(body.start ?? ''),
      end: String(body.end ?? ''),
      description: (body.description as string | null) ?? null,
      location: (body.location as string | null) ?? null,
      attendeeEmails: Array.isArray(body.attendee_emails)
        ? (body.attendee_emails as string[]).map((e) => String(e).trim()).filter(Boolean)
        : undefined,
    };
    if (!input.start || !input.end) {
      return jsonRes({ error: 'start and end are required' }, 400);
    }

    const result =
      op === 'create_event'
        ? await createGoogleEvent(token, input)
        : await patchGoogleEvent(token, String(body.google_event_id ?? ''), input);

    if (!result.ok) {
      await recordError(`Write failed (${result.status}): ${result.detail}`);
      const code = result.status === 403 ? 'insufficient_scope' : undefined;
      return jsonRes({ error: 'Google write failed', status: result.status, detail: result.detail, code }, 502);
    }
    return jsonRes({ success: true, id: result.id }, 200);
  }

  if (op === 'delete_event') {
    const gid = String(body.google_event_id ?? '');
    if (!gid) return jsonRes({ error: 'google_event_id required' }, 400);
    const result = await deleteGoogleEvent(token, gid);
    if (!result.ok) {
      await recordError(`Delete failed (${result.status}): ${result.detail}`);
      return jsonRes({ error: 'Google delete failed', status: result.status, detail: result.detail }, 502);
    }
    return jsonRes({ success: true }, 200);
  }

  return jsonRes({ error: `Unknown op: ${op}` }, 400);
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
