/**
 * The user's goals and the preferences ALINE has extracted from chat, plus the
 * helpers that turn raw rows into what the You tab shows: one row per goal
 * (goals table merged with the agent's goal notes) and grouped, deduped
 * preference chips. Reloads whenever the calling screen gains focus.
 */

import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useAuth } from './auth-context';
import { supabase } from './supabase';
import type { Goal, Interest } from '../types/database';

export function useYouFacts() {
  const { user } = useAuth();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [interests, setInterests] = useState<Interest[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!user) return;
    const [goalsRes, interestsRes] = await Promise.all([
      supabase.from('goals').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(20),
      supabase
        .from('interests')
        .select('*')
        .eq('user_id', user.id)
        .eq('active', true)
        .order('updated_at', { ascending: false })
        .limit(60),
    ]);
    setGoals((goalsRes.data ?? []) as Goal[]);
    setInterests((interestsRes.data ?? []) as Interest[]);
    setLoading(false);
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  const goalRows = mergeGoals(dedupeGoals(goals), interests);
  const prefGroups = groupInterests(interests.filter((i) => i.key !== 'goal_update'));
  return { goals, interests, goalRows, prefGroups, loading, reload };
}

/** Collapse repeated goals (same title) into one display row.
 *  Goals arrive newest-first, so the first row seen for a title is the one we
 *  keep to display; the rest are folded in. We hold onto every version's id
 *  (so delete removes the whole history) and a count of how many times the
 *  goal has been restated — the "versions" the user can eyeball for change. */
export function dedupeGoals(
  goals: Goal[],
): { goal: Goal; ids: string[]; versions: number }[] {
  const byTitle = new Map<string, { goal: Goal; ids: string[]; versions: number }>();
  for (const g of goals) {
    const key = g.title.trim().toLowerCase();
    const existing = byTitle.get(key);
    if (existing) {
      existing.ids.push(g.id);
      existing.versions += 1;
    } else {
      byTitle.set(key, { goal: g, ids: [g.id], versions: 1 });
    }
  }
  return [...byTitle.values()];
}

type GoalNote = { id: string; text: string; when: string };
export type GoalView = {
  key: string;
  title: string;
  latest: GoalNote | null;
  earlier: GoalNote[];
  when: string;
  goalIds: string[];
  noteIds: string[];
};

/** One row per goal: the goals table merged with the agent's goal_update notes
 *  (matched on the normalized goal name). Interests arrive newest-first, so the
 *  first note per goal is the one shown; distinct older notes go to `earlier`,
 *  exact repeats are dropped from view (their ids still delete with the goal). */
export function mergeGoals(
  rows: { goal: Goal; ids: string[]; versions: number }[],
  interests: Interest[],
): GoalView[] {
  const views = new Map<string, GoalView>();
  for (const { goal, ids } of rows) {
    const key = normGoal(goal.title);
    views.set(key, {
      key,
      title: goal.title,
      latest: null,
      earlier: [],
      when: formatWhen(goal.updated_at ?? goal.created_at),
      goalIds: ids,
      noteIds: [],
    });
  }
  const seenText = new Map<string, Set<string>>();
  for (const i of interests) {
    if (i.key !== 'goal_update') continue;
    const v = (i.value ?? {}) as Record<string, unknown>;
    const name = typeof v.goal === 'string' ? v.goal : '';
    if (!name) continue;
    const key = normGoal(name);
    let view = views.get(key);
    if (!view) {
      view = {
        key,
        title: name.charAt(0).toUpperCase() + name.slice(1),
        latest: null,
        earlier: [],
        when: '',
        goalIds: [],
        noteIds: [],
      };
      views.set(key, view);
    }
    view.noteIds.push(i.id);
    const text = goalNoteText(v);
    if (!text) continue;
    const seen = seenText.get(key) ?? new Set<string>();
    seenText.set(key, seen);
    if (seen.has(text)) continue;
    seen.add(text);
    const note = { id: i.id, text, when: formatWhen(i.updated_at ?? i.created_at) };
    if (!view.latest) {
      view.latest = note;
      if (!view.when) view.when = note.when;
    } else {
      view.earlier.push(note);
    }
  }
  return [...views.values()];
}

function normGoal(s: string): string {
  return s.trim().toLowerCase();
}

/** Human line for a goal note: the context if there is one, else its plan. */
function goalNoteText(v: Record<string, unknown>): string {
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
  const context = str(v.context);
  const plan = [str(v.frequency), str(v.duration)].filter(Boolean).join(' · ');
  const text = context || plan;
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Compact "when" stamp — when ALINE last recorded or changed this goal. */
function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' },
  );
}

// Friendly section labels for the raw interest keys the agent extracts.
const INTEREST_GROUPS: Record<string, string> = {
  activity_like: 'Likes',
  activity_dislike: 'Dislikes',
  time_preference: 'Time preferences',
  venue_preference: 'Places & venues',
  social_preference: 'Social style',
  group_preference: 'Groups',
  goal_update: 'Goal notes',
  mood: 'Recent moods',
  life_event: 'Life events',
  other: 'Other',
};
const GROUP_ORDER = Object.values(INTEREST_GROUPS);

/** Group raw interests into human sections, prettified + deduped.
 *  Each chip keeps the ids of ALL rows it represents so delete removes them all. */
export function groupInterests(
  interests: Interest[],
): { label: string; items: { text: string; ids: string[] }[] }[] {
  const byLabel = new Map<string, Map<string, string[]>>();
  for (const i of interests) {
    const label = INTEREST_GROUPS[i.key] ?? 'Other';
    const raw = formatInterest(i).trim();
    if (!raw) continue;
    const text = raw.charAt(0).toUpperCase() + raw.slice(1);
    if (!byLabel.has(label)) byLabel.set(label, new Map());
    const items = byLabel.get(label)!;
    items.set(text, [...(items.get(text) ?? []), i.id]);
  }
  return GROUP_ORDER.filter((l) => byLabel.has(l)).map((label) => ({
    label,
    items: [...byLabel.get(label)!.entries()].map(([text, ids]) => ({ text, ids })),
  }));
}

function formatInterest(i: Interest): string {
  // Best-effort prettify of the JSONB value.
  const v = i.value as unknown;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (typeof obj.label === 'string') return obj.label;
    return Object.entries(obj)
      .map(([k, val]) => `${k}: ${typeof val === 'string' ? val : JSON.stringify(val)}`)
      .join(' · ');
  }
  return JSON.stringify(v);
}
