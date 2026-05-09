/**
 * Loads the user's pending change sets, indexed by chat_message_id, with
 * realtime updates. The chat screen uses this to render an
 * AgentChangeSetCard inline next to messages that produced a proposal.
 *
 * Once the user accepts or rejects a change set, the row's status changes
 * and the card disappears (the local state map drops the entry).
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth-context';
import { supabase } from './supabase';
import type { ChangeSet, ChangeSetOperation } from '../types/database';

export type PendingChangeSet = {
  id: string;
  chat_message_id: string | null;
  operations: ChangeSetOperation[];
  reasoning: string | null;
  status: ChangeSet['status'];
  expires_at: string;
  created_at: string;
};

function parseRow(row: ChangeSet): PendingChangeSet {
  let operations: ChangeSetOperation[] = [];
  if (Array.isArray(row.operations)) {
    operations = row.operations as ChangeSetOperation[];
  }
  return {
    id: row.id,
    chat_message_id: row.chat_message_id,
    operations,
    reasoning: row.reasoning,
    status: row.status,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

export function useChangeSets() {
  const { user } = useAuth();
  // Map keyed by chat_message_id (only pending ones). Plus a sidecar list
  // of ALL change sets for any message (so we can render "this was accepted"
  // history if we want to later).
  const [byMessage, setByMessage] = useState<Record<string, PendingChangeSet>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) {
      setByMessage({});
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from('change_sets')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      console.warn('[change_sets] load failed:', error.message);
      setByMessage({});
      setLoading(false);
      return;
    }

    const map: Record<string, PendingChangeSet> = {};
    for (const row of data ?? []) {
      const parsed = parseRow(row as ChangeSet);
      if (parsed.chat_message_id) map[parsed.chat_message_id] = parsed;
    }
    setByMessage(map);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  // Realtime: keep the map in sync as change sets get linked or settled.
  useEffect(() => {
    if (!user?.id) return;
    const userId = user.id;
    const channel = supabase
      .channel(`change_sets-${userId}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'change_sets',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const newRow = payload.new as ChangeSet | undefined;
          const oldRow = payload.old as ChangeSet | undefined;

          setByMessage((prev) => {
            const next = { ...prev };

            // On DELETE or status change away from pending → remove.
            if (payload.eventType === 'DELETE' && oldRow?.chat_message_id) {
              delete next[oldRow.chat_message_id];
              return next;
            }
            if (newRow && newRow.status !== 'pending' && newRow.chat_message_id) {
              delete next[newRow.chat_message_id];
              return next;
            }

            // INSERT or UPDATE that's still pending → add/replace.
            if (newRow && newRow.status === 'pending' && newRow.chat_message_id) {
              const expires = new Date(newRow.expires_at).getTime();
              if (expires > Date.now()) {
                next[newRow.chat_message_id] = parseRow(newRow);
              } else if (next[newRow.chat_message_id]) {
                delete next[newRow.chat_message_id];
              }
            }
            return next;
          });
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user?.id]);

  return { byMessage, loading, refresh: load };
}

// ---------- mutations -------------------------------------------------------

export async function applyChangeSet(id: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('apply_change_set', { _id: id });
  return error ? { error: error.message } : {};
}

export async function rejectChangeSet(id: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('reject_change_set', { _id: id });
  return error ? { error: error.message } : {};
}
