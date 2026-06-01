/**
 * App-session logging — captures every time the user brings ALINE to the
 * foreground, and how long they stayed. Powers two things:
 *
 *   1. Wake/sleep inference (sleep-inference.ts) — first session of the day
 *      after a multi-hour gap is a reliable proxy for wake time. Last
 *      session before a gap is a proxy for bedtime.
 *   2. Morning ritual detection — Week tab uses last_session_at vs today's
 *      local-day boundary to decide whether to show the Morning panel.
 *
 * Cheap: one INSERT on open, one UPDATE on close. RLS restricts every row
 * to its owner. Server-side cron prunes anything older than 30 days.
 */

import { supabase } from './supabase';

export type SessionSource =
  | 'cold_start'
  | 'background_resume'
  | 'notification_tap'
  | 'foreground';

/**
 * Insert a new session row when the app becomes active.
 * Returns the new session's id (used by logSessionClose), or null if there
 * was no auth session or the insert failed.
 */
export async function logSessionOpen(source: SessionSource): Promise<string | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;

    const { data, error } = await supabase
      .from('app_sessions')
      .insert({
        user_id: session.user.id,
        opened_at: new Date().toISOString(),
        source,
      })
      .select('id')
      .single();

    if (error) {
      console.warn('[ALINE sessions] open insert failed:', error.message);
      return null;
    }
    return data?.id ?? null;
  } catch (e) {
    console.warn('[ALINE sessions] open exception:', e);
    return null;
  }
}

/**
 * Fill in duration_seconds when the app goes to background. Fire-and-forget —
 * we never want to block the AppState transition on this.
 */
export async function logSessionClose(
  sessionId: string,
  durationSeconds: number,
): Promise<void> {
  if (!sessionId) return;
  try {
    const { error } = await supabase
      .from('app_sessions')
      .update({ duration_seconds: Math.max(0, Math.round(durationSeconds)) })
      .eq('id', sessionId);
    if (error) {
      console.warn('[ALINE sessions] close update failed:', error.message);
    }
  } catch (e) {
    console.warn('[ALINE sessions] close exception:', e);
  }
}
