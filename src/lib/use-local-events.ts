/**
 * Local events referenced by chat messages (chat_messages.event_ids) — the
 * chat renders them as EventCards under the agent's reply, mirroring
 * use-goal-plans. Also tracks going-state (calendar_events.local_event_id)
 * and owns the "I'm going" logic shared with the Events screen flow.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth-context';
import { supabase } from './supabase';
import type { LocalEvent } from '../types/database';

export function useLocalEvents(eventIds: string[]) {
  const { user } = useAuth();
  const [byId, setById] = useState<Record<string, LocalEvent>>({});
  // event_id → calendar_event_id when already on the user's calendar.
  const [goingMap, setGoingMap] = useState<Record<string, string>>({});

  const key = [...eventIds].sort().join(',');

  const load = useCallback(async () => {
    if (!user || eventIds.length === 0) return;
    const [evRes, goingRes] = await Promise.all([
      supabase.from('events').select('*').in('id', eventIds),
      supabase
        .from('calendar_events')
        .select('id, local_event_id')
        .eq('user_id', user.id)
        .in('local_event_id', eventIds),
    ]);
    const map: Record<string, LocalEvent> = {};
    for (const e of (evRes.data as LocalEvent[] | null) ?? []) map[e.id] = e;
    setById(map);
    const gm: Record<string, string> = {};
    for (const g of (goingRes.data ?? []) as { id: string; local_event_id: string | null }[]) {
      if (g.local_event_id) gm[g.local_event_id] = g.id;
    }
    setGoingMap(gm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, key]);

  useEffect(() => {
    load();
  }, [load]);

  return { byId, goingMap, refresh: load };
}

/** Direct "I'm going": conflict-checked calendar insert. Returns what happened
 *  so the caller drives the UI (alerts / seed the agent with the clash). */
export async function goToLocalEvent(
  userId: string,
  e: LocalEvent,
): Promise<{ status: 'added' } | { status: 'clash'; conflictTitle: string } | { status: 'error'; message: string }> {
  const end = e.ends_at ?? new Date(new Date(e.starts_at).getTime() + 2 * 3600 * 1000).toISOString();
  const { data: clash } = await supabase
    .from('calendar_events')
    .select('id, title, event_type')
    .eq('user_id', userId)
    .lt('start_at', end)
    .gt('end_at', e.starts_at)
    .limit(5);
  // Routines/transit are soft, auto-materialized blocks — an inferred gym
  // habit shouldn't veto a concert. Only real commitments count as clashes.
  const conflict = ((clash ?? []) as { title: string | null; event_type: string | null }[])
    .find((c) => c.event_type !== 'routine' && c.event_type !== 'transit');
  if (conflict) return { status: 'clash', conflictTitle: conflict.title ?? 'an existing plan' };
  return forceGoToLocalEvent(userId, e);
}

/** Insert without the clash check (used for "Add anyway"). */
export async function forceGoToLocalEvent(
  userId: string,
  e: LocalEvent,
): Promise<{ status: 'added' } | { status: 'error'; message: string }> {
  const end = e.ends_at ?? new Date(new Date(e.starts_at).getTime() + 2 * 3600 * 1000).toISOString();
  const { error } = await supabase.from('calendar_events').insert({
    user_id: userId,
    title: e.title,
    start_at: e.starts_at,
    end_at: end,
    location: e.venue_text,
    description: e.description,
    event_type: 'flexible',
    is_movable: false,
    source: 'aline',
    local_event_id: e.id,
  });
  if (error) return { status: 'error', message: error.message };
  return { status: 'added' };
}
