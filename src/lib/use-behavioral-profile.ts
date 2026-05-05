/**
 * Loads the current user's behavioral data: places, routines, summary.
 * Used by the "What ALINE knows about you" UI section on the Profile tab.
 *
 * Implements the transparency principle (#3 Iron-clad principles): every
 * fact ALINE has inferred about the user is exposed here, with controls
 * to confirm / hide / correct it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth-context';
import { supabase } from './supabase';

export type Place = {
  id: string;
  name: string | null;
  primary_type: string | null;
  category: string | null;
  visit_count: number;
  first_seen: string;
  last_seen: string;
  user_label: string | null;
  is_hidden: boolean;
  is_sensitive: boolean;
  inference_status: 'pending' | 'confirmed' | 'corrected';
};

export type Routine = {
  id: string;
  place_id: string | null;
  category: string | null;
  day_of_week: number | null;
  start_minute: number | null;
  end_minute: number | null;
  consistency: number | null;
  last_observed: string | null;
  active: boolean;
  inference_status: 'pending' | 'confirmed' | 'corrected';
};

export type BehavioralSummary = {
  archetype_text: string | null;
  chronotype: 'early_bird' | 'night_owl' | 'intermediate' | null;
  bedtime_minute: number | null;
  waketime_minute: number | null;
  weekly_workout_count: number | null;
  data_quality: 'none' | 'low' | 'medium' | 'high';
};

export function useBehavioralProfile() {
  const { user } = useAuth();
  const [places, setPlaces] = useState<Place[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [summary, setSummary] = useState<BehavioralSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (userId: string) => {
    const [placesRes, routinesRes, summaryRes] = await Promise.all([
      supabase
        .from('places')
        .select('id, name, primary_type, category, visit_count, first_seen, last_seen, user_label, is_hidden, is_sensitive, inference_status')
        .eq('user_id', userId)
        .order('visit_count', { ascending: false }),
      supabase
        .from('routines')
        .select('id, place_id, category, day_of_week, start_minute, end_minute, consistency, last_observed, active, inference_status')
        .eq('user_id', userId)
        .order('consistency', { ascending: false }),
      supabase
        .from('behavioral_summary')
        .select('archetype_text, chronotype, bedtime_minute, waketime_minute, weekly_workout_count, data_quality')
        .eq('user_id', userId)
        .maybeSingle(),
    ]);

    setPlaces((placesRes.data as Place[] | null) ?? []);
    setRoutines((routinesRes.data as Routine[] | null) ?? []);
    setSummary((summaryRes.data as BehavioralSummary | null) ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!user) {
      setPlaces([]); setRoutines([]); setSummary(null); setLoading(false);
      return;
    }
    setLoading(true);
    load(user.id);
  }, [user?.id, load]);

  return {
    places,
    routines,
    summary,
    loading,
    refresh: () => (user ? load(user.id) : Promise.resolve()),
  };
}

// ---------- mutations -------------------------------------------------------

export async function hidePlace(placeId: string): Promise<{ error?: string }> {
  const { error } = await supabase
    .from('places')
    .update({ is_hidden: true, updated_at: new Date().toISOString() })
    .eq('id', placeId);
  return error ? { error: error.message } : {};
}

export async function unhidePlace(placeId: string): Promise<{ error?: string }> {
  const { error } = await supabase
    .from('places')
    .update({ is_hidden: false, updated_at: new Date().toISOString() })
    .eq('id', placeId);
  return error ? { error: error.message } : {};
}

export async function renamePlace(placeId: string, label: string | null): Promise<{ error?: string }> {
  const { error } = await supabase
    .from('places')
    .update({
      user_label: label,
      inference_status: label ? 'corrected' : 'pending',
      updated_at: new Date().toISOString(),
    })
    .eq('id', placeId);
  return error ? { error: error.message } : {};
}

export async function deletePlace(placeId: string): Promise<{ error?: string }> {
  const { error } = await supabase.from('places').delete().eq('id', placeId);
  return error ? { error: error.message } : {};
}

export async function confirmRoutine(routineId: string): Promise<{ error?: string }> {
  const { error } = await supabase
    .from('routines')
    .update({ inference_status: 'confirmed', updated_at: new Date().toISOString() })
    .eq('id', routineId);
  return error ? { error: error.message } : {};
}

/** "Not really" — silently drop the routine from matching going forward. */
export async function rejectRoutine(routineId: string): Promise<{ error?: string }> {
  const { error } = await supabase
    .from('routines')
    .update({
      active: false,
      inference_status: 'corrected',
      updated_at: new Date().toISOString(),
    })
    .eq('id', routineId);
  return error ? { error: error.message } : {};
}
