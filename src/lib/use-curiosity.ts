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
 * Or the user can dismiss the card without answering. We bump `last_asked_at`
 * either way so we don't re-ask for 7 days.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth-context';
import { supabase } from './supabase';

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
    const { data, error } = await supabase.rpc('next_curiosity_item');
    if (error) {
      console.warn('[curiosity] load failed:', error.message);
      setItem(null);
    } else {
      const first = (data as Array<{ kind: string; id: string; payload: object }> | null)?.[0];
      setItem(first ? (first as CuriosityItem) : null);
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
