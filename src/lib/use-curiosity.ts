/**
 * The agent's curiosity loop — Block 1 Step 8.
 *
 * Surfaces one inference at a time (a place or a routine ALINE has guessed)
 * and gives the user three response paths:
 *
 *   1. Confirm     → inference_status='confirmed', agent uses it with high confidence
 *   2. Correct     → user_label set, inference_status='corrected'
 *   3. Reject      → place: is_hidden=true; routine: active=false. Dropped from context.
 *
 * Settled answers (confirm/correct/reject) lock in forever — never re-asked.
 * "Later" snoozes for 30 days before that specific item can resurface.
 *
 * Per-device throttle: at most one curiosity card visible per 24 hours.
 * The agent should be quiet by default. When it speaks, the question should
 * feel meaningful, not nagging.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth-context';
import { supabase } from './supabase';

const LAST_SHOWN_KEY = '@aline/curiosity_last_shown_at';
const MIN_VISIBLE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type CuriosityItem =
  | {
      kind: 'place';
      id: string;
      payload: {
        name: string | null;
        user_label: string | null;
        category: string | null;
        primary_type: string | null;
        visit_count: number;
        ping_count: number;
        confidence: number | null;
        first_seen: string;
        last_seen: string;
        is_sensitive: boolean;
        has_google_match: boolean;
      };
    }
  | {
      kind: 'routine';
      id: string;
      payload: {
        place_id: string | null;
        place_name: string;
        category: string | null;
        day_of_week: number | null;
        start_minute: number | null;
        end_minute: number | null;
        consistency: number | null;
        last_observed: string | null;
      };
    };

async function readLastShownMs(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_SHOWN_KEY);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

async function writeLastShownMs(ms: number): Promise<void> {
  try { await AsyncStorage.setItem(LAST_SHOWN_KEY, String(ms)); } catch {}
}

export function useCuriosity() {
  const { user } = useAuth();
  const [item, setItem] = useState<CuriosityItem | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) {
      setItem(null);
      setLoading(false);
      return;
    }
    setLoading(true);

    // Per-day display throttle: even if the queue has items, we surface at
    // most one card every 24 hours per device. After answering or snoozing,
    // refresh() bumps the throttle so the next card waits a day.
    const lastShown = await readLastShownMs();
    if (lastShown && Date.now() - lastShown < MIN_VISIBLE_INTERVAL_MS) {
      setItem(null);
      setLoading(false);
      return;
    }

    const { data, error } = await supabase.rpc('next_curiosity_item');
    if (error) {
      console.warn('[curiosity] load failed:', error.message);
      setItem(null);
    } else {
      const first = (data as Array<{ kind: string; id: string; payload: object }> | null)?.[0];
      const next = first ? (first as CuriosityItem) : null;
      setItem(next);
      // Mark "shown" only if there actually was something to show.
      if (next) await writeLastShownMs(Date.now());
    }
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  return { item, loading, refresh: load };
}

// ---------- mutations -------------------------------------------------------

/** Confirm the agent's inference is correct. */
export async function confirmCuriosityItem(
  kind: 'place' | 'routine',
  id: string,
): Promise<{ error?: string }> {
  const table = kind === 'place' ? 'places' : 'routines';
  const { error } = await supabase
    .from(table)
    .update({
      inference_status: 'confirmed',
      last_asked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  return error ? { error: error.message } : {};
}

/** User typed a corrected label for a place. */
export async function correctPlaceLabel(
  id: string,
  label: string,
): Promise<{ error?: string }> {
  const { error } = await supabase
    .from('places')
    .update({
      user_label: label,
      inference_status: 'corrected',
      last_asked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  return error ? { error: error.message } : {};
}

/** Reject the inference — for places: hide. For routines: deactivate. */
export async function rejectCuriosityItem(
  kind: 'place' | 'routine',
  id: string,
): Promise<{ error?: string }> {
  if (kind === 'place') {
    const { error } = await supabase
      .from('places')
      .update({
        is_hidden: true,
        inference_status: 'corrected',
        last_asked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    return error ? { error: error.message } : {};
  }
  const { error } = await supabase
    .from('routines')
    .update({
      active: false,
      inference_status: 'corrected',
      last_asked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  return error ? { error: error.message } : {};
}

/** "Ask me later" — bumps last_asked_at without changing the inference. */
export async function snoozeCuriosityItem(
  kind: 'place' | 'routine',
  id: string,
): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('mark_curiosity_asked', {
    _kind: kind,
    _id: id,
  });
  return error ? { error: error.message } : {};
}
