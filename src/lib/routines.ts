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
 * Routines are built on the server now (`rebuild_routines`, hourly) from the
 * stays timeline, including recurring walks/runs/rides. No-op on the phone.
 */
export async function recomputeRoutinesForCurrentUser(): Promise<{
  pingsRead: number;
  placesRead: number;
  routinesFound: number;
  error?: string;
}> {
  return { pingsRead: 0, placesRead: 0, routinesFound: 0 };
}
