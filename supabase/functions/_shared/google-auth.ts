/**
 * Shared Google Calendar access helpers.
 * ----------------------------------------------------------------------------
 * Used by `google-calendar-sync` (pull + write-back) and `google-calendar-write`
 * (agent invites). Holds:
 *   - getValidAccessToken: load the stored token, refresh if expired, persist.
 *   - create/patch/delete Google event REST calls (sendUpdates=all so Google
 *     emails attendees on create/change/cancel).
 *
 * Secrets required: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET (the
 * secret is omitted for iOS-style clients that have none).
 * ----------------------------------------------------------------------------
 */

// @ts-nocheck Deno edge runtime
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const GOOGLE_OAUTH_CLIENT_ID = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
const GOOGLE_OAUTH_CLIENT_SECRET = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');

const EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export type TokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; detail: string; code?: 'no_connection' | 'refresh_failed' };

/**
 * Return a currently-valid access token for the user, refreshing + persisting
 * if the stored one has expired. Writes last_sync_error on refresh failure.
 */
export async function getValidAccessToken(
  admin: SupabaseClient,
  userId: string,
): Promise<TokenResult> {
  const { data: tokenRow, error } = await admin
    .from('google_oauth_tokens')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { ok: false, detail: error.message };
  if (!tokenRow) {
    return { ok: false, detail: 'No Google Calendar connection.', code: 'no_connection' };
  }

  let accessToken = tokenRow.access_token as string;
  const expiresAt = new Date(tokenRow.token_expires_at as string).getTime();
  if (Date.now() >= expiresAt) {
    const refreshed = await refreshAccessToken(tokenRow.refresh_token as string);
    if (!refreshed.ok) {
      await admin
        .from('google_oauth_tokens')
        .update({ last_sync_error: `Token refresh failed: ${refreshed.detail}` })
        .eq('user_id', userId);
      return { ok: false, detail: refreshed.detail, code: 'refresh_failed' };
    }
    const newExpires = new Date(Date.now() + (refreshed.expires_in - 30) * 1000);
    await admin
      .from('google_oauth_tokens')
      .update({
        access_token: refreshed.access_token,
        token_expires_at: newExpires.toISOString(),
      })
      .eq('user_id', userId);
    accessToken = refreshed.access_token;
  }
  return { ok: true, accessToken };
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<
  | { ok: true; access_token: string; expires_in: number }
  | { ok: false; detail: string }
> {
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID ?? '',
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (GOOGLE_OAUTH_CLIENT_SECRET) params.set('client_secret', GOOGLE_OAUTH_CLIENT_SECRET);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) return { ok: false, detail: await res.text() };
  const data = (await res.json()) as { access_token: string; expires_in: number };
  return { ok: true, access_token: data.access_token, expires_in: data.expires_in };
}

// ---------- event REST ops ---------------------------------------------------

export type GoogleEventInput = {
  title: string;
  start: string; // UTC ISO (absolute instant)
  end: string;
  description?: string | null;
  location?: string | null;
  attendeeEmails?: string[];
};

export type WriteResult =
  | { ok: true; id: string }
  | { ok: false; status: number; detail: string };

function buildEventBody(input: GoogleEventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: input.title,
    start: { dateTime: new Date(input.start).toISOString() },
    end: { dateTime: new Date(input.end).toISOString() },
  };
  if (input.description != null) body.description = input.description;
  if (input.location != null) body.location = input.location;
  if (input.attendeeEmails && input.attendeeEmails.length > 0) {
    body.attendees = input.attendeeEmails.map((email) => ({ email }));
  }
  return body;
}

export async function createGoogleEvent(
  token: string,
  input: GoogleEventInput,
): Promise<WriteResult> {
  const res = await fetch(`${EVENTS_URL}?sendUpdates=all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildEventBody(input)),
  });
  if (!res.ok) return { ok: false, status: res.status, detail: await res.text() };
  const data = (await res.json()) as { id: string };
  return { ok: true, id: data.id };
}

export async function patchGoogleEvent(
  token: string,
  googleEventId: string,
  input: GoogleEventInput,
): Promise<WriteResult> {
  const res = await fetch(
    `${EVENTS_URL}/${encodeURIComponent(googleEventId)}?sendUpdates=all`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildEventBody(input)),
    },
  );
  if (!res.ok) return { ok: false, status: res.status, detail: await res.text() };
  const data = (await res.json()) as { id: string };
  return { ok: true, id: data.id };
}

export async function deleteGoogleEvent(
  token: string,
  googleEventId: string,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
  const res = await fetch(
    `${EVENTS_URL}/${encodeURIComponent(googleEventId)}?sendUpdates=all`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  // 410 = already deleted; treat as success (idempotent).
  if (!res.ok && res.status !== 410) {
    return { ok: false, status: res.status, detail: await res.text() };
  }
  return { ok: true };
}
