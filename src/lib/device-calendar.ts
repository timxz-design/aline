import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';
import { supabase } from './supabase';

/**
 * Device calendar import (iOS Calendar: iCloud, Exchange/work, local, and any
 * other accounts added on the phone) → `calendar_events` with source='apple'.
 *
 * Read-only. No OAuth, no refresh tokens, nothing to revoke — the OS permission
 * is the whole connection. This is where most people's non-work life actually
 * lives, which the Google pull alone never saw.
 *
 * Same window as the Google sync (-7d..+30d). Idempotent: upsert by
 * (user_id, source, external_id); apple rows in the window that no longer exist
 * on the device are deleted.
 *
 * Skipped on purpose:
 *   - availability='free' events (iOS all-day events default to free — birthdays,
 *     reminders-as-events) so they don't block whole days for coordination.
 *   - birthday + subscribed (holiday) calendars.
 *   - Google-account calendars when Google is connected server-side, so the same
 *     event doesn't land twice (once as 'google', once as 'apple').
 */

const WINDOW_BACK_DAYS = 7;
const WINDOW_FORWARD_DAYS = 30;
const MIN_INTERVAL_MS = 15 * 60_000;

let lastRunMs = 0;
let inFlight: Promise<DeviceCalendarSyncResult> | null = null;

export type DeviceCalendarSyncResult =
  | { ok: true; imported: number; removed: number; calendars: number }
  | { ok: false; reason: 'unsupported' | 'no_permission' | 'no_session' | 'error'; error?: string };

export async function getDeviceCalendarPermission(): Promise<'granted' | 'denied' | 'undetermined'> {
  if (Platform.OS === 'web') return 'denied';
  const { status } = await Calendar.getCalendarPermissionsAsync();
  return status;
}

/** Ask for calendar access (only call from an explicit user action), then sync. */
export async function connectDeviceCalendar(): Promise<DeviceCalendarSyncResult> {
  if (Platform.OS === 'web') return { ok: false, reason: 'unsupported' };
  const { status } = await Calendar.requestCalendarPermissionsAsync();
  if (status !== 'granted') return { ok: false, reason: 'no_permission' };
  return syncDeviceCalendar({ force: true });
}

/**
 * Import device events. Never prompts — no-ops when permission isn't granted.
 * Throttled to once per 15 min unless forced; concurrent calls share one run.
 */
export async function syncDeviceCalendar(opts: { force?: boolean } = {}): Promise<DeviceCalendarSyncResult> {
  if (Platform.OS === 'web') return { ok: false, reason: 'unsupported' };
  if (inFlight) return inFlight;
  if (!opts.force && Date.now() - lastRunMs < MIN_INTERVAL_MS) {
    return { ok: true, imported: 0, removed: 0, calendars: 0 };
  }
  inFlight = run().finally(() => { inFlight = null; });
  return inFlight;
}

async function run(): Promise<DeviceCalendarSyncResult> {
  try {
    const { status } = await Calendar.getCalendarPermissionsAsync();
    if (status !== 'granted') return { ok: false, reason: 'no_permission' };

    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user.id;
    if (!userId) return { ok: false, reason: 'no_session' };
    lastRunMs = Date.now();

    const { data: googleStatus } = await supabase.rpc('google_calendar_status');
    const googleRow = Array.isArray(googleStatus) ? googleStatus[0] : googleStatus;
    const googleConnected = !!googleRow?.connected && !googleRow?.last_sync_error;

    const calendars = (await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT)).filter((c) => {
      if (c.type === Calendar.CalendarType.BIRTHDAYS || c.type === Calendar.CalendarType.SUBSCRIBED) return false;
      if (googleConnected && isGoogleSource(c)) return false;
      return true;
    });

    const timeMin = new Date(Date.now() - WINDOW_BACK_DAYS * 86400_000);
    const timeMax = new Date(Date.now() + WINDOW_FORWARD_DAYS * 86400_000);

    const events = calendars.length
      ? await Calendar.getEventsAsync(calendars.map((c) => c.id), timeMin, timeMax)
      : [];

    const rows = events
      .filter((e) => e.availability !== Calendar.Availability.FREE)
      .filter((e) => e.status !== Calendar.EventStatus.CANCELED)
      .map((e) => {
        const start = new Date(e.startDate);
        const end = new Date(e.endDate);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
        return {
          user_id: userId,
          // Recurring occurrences share e.id on iOS — the start time makes each
          // instance unique and stable across syncs.
          external_id: `${e.id}@${start.toISOString()}`,
          source: 'apple',
          title: e.title?.trim() || '(untitled)',
          description: e.notes?.trim() || null,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          location: e.location?.trim() || null,
          event_type: 'fixed',
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // Dedupe within the batch (an event visible via two calendars).
    const byId = new Map(rows.map((r) => [r.external_id, r]));
    const unique = [...byId.values()];

    if (unique.length) {
      const { error } = await supabase
        .from('calendar_events')
        .upsert(unique, { onConflict: 'user_id,source,external_id' });
      if (error) return { ok: false, reason: 'error', error: error.message };
    }

    // Remove apple rows in the window that are gone from the device. Diff in JS
    // and delete by primary key — a NOT IN over hundreds of ids would blow the
    // URL length limit.
    const { data: existing, error: existingErr } = await supabase
      .from('calendar_events')
      .select('id, external_id')
      .eq('user_id', userId)
      .eq('source', 'apple')
      .gte('start_at', timeMin.toISOString())
      .lt('start_at', timeMax.toISOString());
    if (existingErr) return { ok: false, reason: 'error', error: existingErr.message };

    const staleIds = (existing ?? [])
      .filter((r) => !byId.has(r.external_id as string))
      .map((r) => r.id as string);
    for (let i = 0; i < staleIds.length; i += 100) {
      await supabase.from('calendar_events').delete().in('id', staleIds.slice(i, i + 100));
    }

    return { ok: true, imported: unique.length, removed: staleIds.length, calendars: calendars.length };
  } catch (e) {
    return { ok: false, reason: 'error', error: (e as Error).message };
  }
}

function isGoogleSource(c: Calendar.Calendar): boolean {
  const name = `${c.source?.name ?? ''} ${c.source?.type ?? ''}`.toLowerCase();
  return name.includes('google') || name.includes('gmail');
}
