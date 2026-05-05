/**
 * Routine detection — Supabase pipeline wrapper.
 *
 *   pings × places  →  detectRoutines()  →  routines table
 *
 * The pure algorithm lives in routines-algo.ts (no I/O, fully testable
 * in plain Node). This file is the React Native bridge.
 */

import { detectRoutines, type DetectedRoutine } from './routines-algo';
import { supabase } from './supabase';

const PING_WINDOW_DAYS = 30;

export type { DetectedRoutine };
export { detectRoutines };

/**
 * Fetch the user's recent pings and places, run detection, replace pending
 * routines with the new set. User-confirmed and corrected routines are kept.
 */
export async function recomputeRoutinesForCurrentUser(): Promise<{
  pingsRead: number;
  placesRead: number;
  routinesFound: number;
  error?: string;
}> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return { pingsRead: 0, placesRead: 0, routinesFound: 0, error: 'not signed in' };
  }

  const since = new Date(Date.now() - PING_WINDOW_DAYS * 86_400_000).toISOString();

  const [pingsRes, placesRes] = await Promise.all([
    supabase
      .from('behavioral_pings')
      .select('captured_at, geohash_8')
      .eq('user_id', session.user.id)
      .gte('captured_at', since)
      .order('captured_at', { ascending: true }),
    supabase
      .from('places')
      .select('id, geohash_7, category')
      .eq('user_id', session.user.id)
      .eq('is_hidden', false),
  ]);

  if (pingsRes.error) {
    return { pingsRead: 0, placesRead: 0, routinesFound: 0, error: pingsRes.error.message };
  }
  if (placesRes.error) {
    return { pingsRead: 0, placesRead: 0, routinesFound: 0, error: placesRes.error.message };
  }

  const pings = pingsRes.data ?? [];
  const places = placesRes.data ?? [];

  const detected = detectRoutines(pings, places);

  // Wipe pending routines for this user; preserve confirmed/corrected.
  await supabase
    .from('routines')
    .delete()
    .eq('user_id', session.user.id)
    .eq('inference_status', 'pending');

  if (detected.length > 0) {
    const rows = detected.map((r) => ({
      user_id: session.user.id,
      place_id: r.place_id,
      category: r.category,
      day_of_week: r.day_of_week,
      start_minute: r.start_minute,
      end_minute: r.end_minute,
      consistency: r.consistency,
      last_observed: r.last_observed,
      active: true,
      inference_status: 'pending' as const,
    }));

    const { error: insErr } = await supabase.from('routines').insert(rows);
    if (insErr) {
      return {
        pingsRead: pings.length,
        placesRead: places.length,
        routinesFound: 0,
        error: insErr.message,
      };
    }
  }

  return {
    pingsRead: pings.length,
    placesRead: places.length,
    routinesFound: detected.length,
  };
}
