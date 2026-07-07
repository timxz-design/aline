/**
 * Loads the user's goal plans (draft + live), indexed by plan id, with realtime
 * updates. The chat screen renders a GoalPlanCard inline next to the agent
 * message that drafted/committed a plan (chat_messages.goal_plan_id), and the
 * Goals screen lists them. Refetches on any change so commits/edits reflect.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth-context';
import { supabase } from './supabase';
import type { PlanSpec } from '../components/GoalPlanCard';

export type LoadedPlan = {
  id: string;
  goal_id: string;
  goalTitle: string;
  status: 'draft' | 'live';
  version: number;
  spec: PlanSpec | null;
};

export function useGoalPlans() {
  const { user } = useAuth();
  const [byId, setById] = useState<Record<string, LoadedPlan>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) {
      setById({});
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('goal_plans')
      .select('id, goal_id, status, version, plan_spec, goals(title)')
      .eq('user_id', user.id)
      .neq('status', 'archived');
    if (error) {
      console.warn('[goal_plans] load failed:', error.message);
      setLoading(false);
      return;
    }
    const map: Record<string, LoadedPlan> = {};
    for (const row of data ?? []) {
      const r = row as {
        id: string;
        goal_id: string;
        status: string;
        version: number;
        plan_spec: PlanSpec | null;
        goals: { title: string | null } | null;
      };
      if (r.status === 'archived') continue;
      map[r.id] = {
        id: r.id,
        goal_id: r.goal_id,
        goalTitle: r.goals?.title ?? 'Goal',
        status: r.status === 'live' ? 'live' : 'draft',
        version: r.version,
        spec: r.plan_spec,
      };
    }
    setById(map);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  // Realtime: refetch on any plan change (low volume; keeps the join fresh).
  useEffect(() => {
    if (!user?.id) return;
    const userId = user.id;
    const channel = supabase
      .channel(`goal_plans-${userId}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'goal_plans', filter: `user_id=eq.${userId}` },
        () => { load(); }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id, load]);

  return { byId, loading, refresh: load };
}

// Commit a goal's plan to the calendar directly (no chat round-trip). Flips
// draft→live and materializes the next ~2 weeks server-side via the RPC.
export async function commitGoalPlan(
  goalId: string,
): Promise<{ created: number; skipped: number } | { error: string }> {
  const { data, error } = await supabase.rpc('commit_goal_plan', { _goal_id: goalId });
  if (error) return { error: error.message };
  const r = (data ?? {}) as { created?: number; skipped?: number };
  return { created: r.created ?? 0, skipped: r.skipped ?? 0 };
}
