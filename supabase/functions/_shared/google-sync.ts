/**
 * Core Google Calendar sync for one user — shared by `google-calendar-sync`
 * (user-triggered, JWT) and `google-calendar-sync-cron` (pg_cron, all users).
 *
 * Steps: push ALINE-origin events to Google, pull the -7d..+30d window into
 * `calendar_events` (upsert by user_id+source+external_id), drop google rows
 * deleted upstream, stamp last_synced_at. Errors are written to
 * google_oauth_tokens.last_sync_error so CalendarReconnectBanner can surface them.
 */

// deno-lint-ignore-file no-explicit-any
import {
  createGoogleEvent,
  getValidAccessToken,
  patchGoogleEvent,
} from './google-auth.ts';

const WINDOW_BACK_DAYS = 7;
const WINDOW_FORWARD_DAYS = 30;

type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

export type SyncResult =
  | {
      ok: true;
      events_seen: number;
      events_upserted: number;
      window: { from: string; to: string };
    }
  | { ok: false; status: number; error: string; code?: string; detail?: string };

export async function syncUserGoogleCalendar(adminClient: any, userId: string): Promise<SyncResult> {
  // Obtain a valid access token (refreshes + persists if expired).
  const tokenRes = await getValidAccessToken(adminClient, userId);
  if (!tokenRes.ok) {
    const status = tokenRes.code === 'no_connection' ? 400 : 502;
    return { ok: false, status, error: tokenRes.detail, code: tokenRes.code };
  }
  const accessToken = tokenRes.accessToken;

  // -------- write-back: push ALINE-origin events to Google BEFORE the pull ----
  // Inferred/recurring agent blocks (routine/transit/goal) stay local — we never
  // pollute the user's real calendar with guesses or recurring goal sessions
  // (and goal blocks are re-materialized/edited locally, so syncing them would
  // orphan Google copies on every regenerate). Concrete one-off ALINE events
  // (fixed/flexible/coordinated) get created or updated in Google. Round-trip
  // duplication is prevented by keeping source='aline' and storing the Google id
  // in external_id; the pull below SKIPS any Google event already claimed by an
  // aline row.
  try {
    const pushMin = new Date(Date.now() - WINDOW_BACK_DAYS * 86400_000).toISOString();
    const pushMax = new Date(Date.now() + WINDOW_FORWARD_DAYS * 86400_000).toISOString();
    const { data: alineRows } = await adminClient
      .from('calendar_events')
      .select('id, external_id, title, description, start_at, end_at, location, updated_at, google_synced_at')
      .eq('user_id', userId)
      .eq('source', 'aline')
      .not('event_type', 'in', '(routine,transit,goal)')
      .gte('start_at', pushMin)
      .lt('start_at', pushMax);

    for (const row of alineRows ?? []) {
      const input = {
        title: row.title ?? '(untitled)',
        start: row.start_at as string,
        end: row.end_at as string,
        description: (row.description as string | null) ?? null,
        location: (row.location as string | null) ?? null,
      };
      if (!row.external_id) {
        const created = await createGoogleEvent(accessToken, input);
        if (created.ok) {
          await adminClient
            .from('calendar_events')
            .update({ external_id: created.id, google_synced_at: new Date().toISOString() })
            .eq('id', row.id);
        }
      } else {
        // Re-PATCH only when the local row changed meaningfully after the last
        // push. The 5s tolerance absorbs the updated_at trigger's own jitter so
        // we don't re-PATCH (and re-email attendees) on every sync.
        const updatedMs = row.updated_at ? new Date(row.updated_at as string).getTime() : 0;
        const syncedMs = row.google_synced_at ? new Date(row.google_synced_at as string).getTime() : 0;
        if (updatedMs - syncedMs > 5000) {
          const patched = await patchGoogleEvent(accessToken, row.external_id as string, input);
          if (patched.ok) {
            await adminClient
              .from('calendar_events')
              .update({ google_synced_at: new Date().toISOString() })
              .eq('id', row.id);
          }
        }
      }
    }
  } catch (e) {
    // Push failures must never block the pull — log and continue.
    console.warn('[gcal-sync] push step failed:', (e as Error).message);
  }

  // Fetch events.
  const timeMin = new Date(Date.now() - WINDOW_BACK_DAYS * 86400_000).toISOString();
  const timeMax = new Date(Date.now() + WINDOW_FORWARD_DAYS * 86400_000).toISOString();

  const allEvents: GoogleEvent[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const detail = await res.text();
      await adminClient
        .from('google_oauth_tokens')
        .update({ last_sync_error: `Fetch failed: ${res.status}: ${detail.slice(0, 500)}` })
        .eq('user_id', userId);
      return { ok: false, status: 502, error: 'Google Calendar API error', detail };
    }
    const data = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    allEvents.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
    pages += 1;
    if (pages > 8) break; // hard cap, ~2000 events
  } while (pageToken);

  // Google ids already claimed by ALINE-origin rows — skip them on pull so an
  // ALINE event we pushed doesn't get re-imported as a duplicate source='google'
  // row (and never clobbers a local move/edit of an ALINE event).
  const { data: claimedRows } = await adminClient
    .from('calendar_events')
    .select('external_id')
    .eq('user_id', userId)
    .eq('source', 'aline')
    .not('external_id', 'is', null);
  const claimedIds = new Set((claimedRows ?? []).map((r: any) => r.external_id as string));

  // Transform & upsert.
  const rows = allEvents
    .filter((e) => e.status !== 'cancelled' && e.start && e.end && !claimedIds.has(e.id))
    .map((e) => {
      // dateTime: timed event (with timezone). date: all-day event.
      const startIso = e.start?.dateTime ?? naiveDateToIso(e.start?.date);
      const endIso = e.end?.dateTime ?? naiveDateToIso(e.end?.date);
      if (!startIso || !endIso) return null;
      return {
        user_id: userId,
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
      .upsert(rows, { onConflict: 'user_id,source,external_id', count: 'exact' });
    if (upsertErr) {
      await adminClient
        .from('google_oauth_tokens')
        .update({ last_sync_error: `Upsert failed: ${upsertErr.message}` })
        .eq('user_id', userId);
      return { ok: false, status: 500, error: 'DB upsert failed', detail: upsertErr.message };
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
      .eq('user_id', userId)
      .eq('source', 'google')
      .gte('start_at', timeMin)
      .lt('start_at', timeMax)
      .not('external_id', 'in', `(${presentIds.map((id) => `"${id}"`).join(',')})`);
  } else {
    // Window has zero events — wipe any stale ones inside the window.
    await adminClient
      .from('calendar_events')
      .delete()
      .eq('user_id', userId)
      .eq('source', 'google')
      .gte('start_at', timeMin)
      .lt('start_at', timeMax);
  }

  await adminClient
    .from('google_oauth_tokens')
    .update({ last_synced_at: new Date().toISOString(), last_sync_error: null })
    .eq('user_id', userId);

  return {
    ok: true,
    events_seen: allEvents.length,
    events_upserted: upsertedCount,
    window: { from: timeMin, to: timeMax },
  };
}

/**
 * Convert "YYYY-MM-DD" (an all-day event date) to a midnight UTC ISO. Good
 * enough for a calendar where all-day events are rendered as full-day blocks.
 */
function naiveDateToIso(date: string | undefined): string | null {
  if (!date) return null;
  return new Date(date + 'T00:00:00Z').toISOString();
}
