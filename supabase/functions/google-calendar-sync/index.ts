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

const GOOGLE_OAUTH_CLIENT_ID = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
const GOOGLE_OAUTH_CLIENT_SECRET = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const WINDOW_BACK_DAYS = 7;
const WINDOW_FORWARD_DAYS = 30;

type StoredToken = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  scope: string | null;
};

type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
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

  // Load tokens.
  const { data: tokenRow, error: tokenErr } = await adminClient
    .from('google_oauth_tokens')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (tokenErr) {
    return jsonRes({ error: 'Failed to load tokens', detail: tokenErr.message }, 500);
  }
  if (!tokenRow) {
    return jsonRes(
      { error: 'No Google Calendar connection. Connect first.' },
      400
    );
  }

  let token = tokenRow as StoredToken;

  // Refresh if expired (or about to be).
  const expiresAt = new Date(token.token_expires_at).getTime();
  if (Date.now() >= expiresAt) {
    const refreshed = await refreshAccessToken(token.refresh_token);
    if (!refreshed.ok) {
      await adminClient
        .from('google_oauth_tokens')
        .update({ last_sync_error: `Token refresh failed: ${refreshed.detail}` })
        .eq('user_id', user.id);
      return jsonRes(
        { error: 'Token refresh failed', detail: refreshed.detail },
        502
      );
    }
    const newExpires = new Date(Date.now() + (refreshed.expires_in - 30) * 1000);
    await adminClient
      .from('google_oauth_tokens')
      .update({
        access_token: refreshed.access_token,
        token_expires_at: newExpires.toISOString(),
      })
      .eq('user_id', user.id);
    token = {
      ...token,
      access_token: refreshed.access_token,
      token_expires_at: newExpires.toISOString(),
    };
  }

  // Fetch events.
  const timeMin = new Date(Date.now() - WINDOW_BACK_DAYS * 86400_000).toISOString();
  const timeMax = new Date(Date.now() + WINDOW_FORWARD_DAYS * 86400_000).toISOString();

  const allEvents: GoogleEvent[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const url = new URL(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events'
    );
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!res.ok) {
      const detail = await res.text();
      await adminClient
        .from('google_oauth_tokens')
        .update({ last_sync_error: `Fetch failed: ${res.status}: ${detail.slice(0, 500)}` })
        .eq('user_id', user.id);
      return jsonRes(
        { error: 'Google Calendar API error', status: res.status, detail },
        502
      );
    }
    const data = (await res.json()) as {
      items?: GoogleEvent[];
      nextPageToken?: string;
    };
    allEvents.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
    pages += 1;
    if (pages > 8) break; // hard cap, ~2000 events
  } while (pageToken);

  // Transform & upsert.
  const rows = allEvents
    .filter((e) => e.status !== 'cancelled' && e.start && e.end)
    .map((e) => {
      // dateTime: timed event (with timezone). date: all-day event.
      const startIso = e.start?.dateTime ?? naiveDateToIso(e.start?.date);
      const endIso = e.end?.dateTime ?? naiveDateToIso(e.end?.date);
      if (!startIso || !endIso) return null;
      return {
        user_id: user.id,
        external_id: e.id,
        source: 'google',
        title: e.summary?.trim() || '(untitled)',
        description: e.description?.trim() || null,
        start_at: new Date(startIso).toISOString(),
        end_at: new Date(endIso).toISOString(),
        location: e.location?.trim() || null,
        event_type: 'fixed',
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  let upsertedCount = 0;
  if (rows.length > 0) {
    const { error: upsertErr, count } = await adminClient
      .from('calendar_events')
      .upsert(rows, {
        onConflict: 'user_id,source,external_id',
        count: 'exact',
      });
    if (upsertErr) {
      await adminClient
        .from('google_oauth_tokens')
        .update({ last_sync_error: `Upsert failed: ${upsertErr.message}` })
        .eq('user_id', user.id);
      return jsonRes({ error: 'DB upsert failed', detail: upsertErr.message }, 500);
    }
    upsertedCount = count ?? rows.length;
  }

  // Drop google-sourced events that are within the window but no longer in
  // the user's calendar (i.e. they deleted them on Google's side).
  const presentIds = rows.map((r) => r.external_id);
  if (presentIds.length > 0) {
    await adminClient
      .from('calendar_events')
      .delete()
      .eq('user_id', user.id)
      .eq('source', 'google')
      .gte('start_at', timeMin)
      .lt('start_at', timeMax)
      .not('external_id', 'in', `(${presentIds.map((id) => `"${id}"`).join(',')})`);
  } else {
    // Window has zero events — wipe any stale ones inside the window.
    await adminClient
      .from('calendar_events')
      .delete()
      .eq('user_id', user.id)
      .eq('source', 'google')
      .gte('start_at', timeMin)
      .lt('start_at', timeMax);
  }

  await adminClient
    .from('google_oauth_tokens')
    .update({ last_synced_at: new Date().toISOString(), last_sync_error: null })
    .eq('user_id', user.id);

  return jsonRes(
    {
      success: true,
      events_seen: allEvents.length,
      events_upserted: upsertedCount,
      window: { from: timeMin, to: timeMax },
    },
    200
  );
});

async function refreshAccessToken(
  refreshToken: string
): Promise<
  | { ok: true; access_token: string; expires_in: number }
  | { ok: false; detail: string }
> {
  const refreshParams = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID!,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  // iOS OAuth clients have no client secret — only include for Web clients.
  if (GOOGLE_OAUTH_CLIENT_SECRET) {
    refreshParams.set('client_secret', GOOGLE_OAUTH_CLIENT_SECRET);
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: refreshParams.toString(),
  });
  if (!res.ok) {
    return { ok: false, detail: await res.text() };
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  return { ok: true, access_token: data.access_token, expires_in: data.expires_in };
}

/**
 * Convert "YYYY-MM-DD" (an all-day event date) to a midnight UTC ISO. Good
 * enough for a calendar where all-day events are rendered as full-day blocks.
 */
function naiveDateToIso(date: string | undefined): string | null {
  if (!date) return null;
  return new Date(date + 'T00:00:00Z').toISOString();
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
