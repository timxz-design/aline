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
const PICKED_AT_SIGNUP = 'Picked when you joined';
const GROUP_ORDER = [...Object.values(INTEREST_GROUPS), PICKED_AT_SIGNUP];

export type PrefItem = {
  /** The thing itself: "Football", "Evening (8pm)". */
  text: string;
  /** Why / how, from the agent's notes: "both playing and watching". */
  detail: string | null;
  /** Every row this item stands for, so "forget" removes them all. */
  ids: string[];
  /** Newest of those rows (ISO). */
  updatedAt: string;
};

/** Group raw interests into human sections. Entries about the same thing
 *  ("football" and "football — both playing and watching") merge into one
 *  item; the newest non-empty detail is shown. */
export function groupInterests(interests: Interest[]): { label: string; items: PrefItem[] }[] {
  const byLabel = new Map<string, Map<string, PrefItem>>();
  for (const i of interests) {
    // Signup chips are broad categories, kept apart from what ALINE learned.
    const label = i.source === 'onboarding' ? PICKED_AT_SIGNUP : INTEREST_GROUPS[i.key] ?? 'Other';
    const { title, detail } = describeInterest(i.value as unknown);
    if (!title) continue;
    const key = title.toLowerCase();
    const items = byLabel.get(label) ?? new Map<string, PrefItem>();
    byLabel.set(label, items);
    const updatedAt = i.updated_at ?? i.created_at ?? '';
    const existing = items.get(key);
    if (existing) {
      existing.ids.push(i.id);
      // Interests arrive newest-first: keep the first detail seen, fill gaps.
      if (!existing.detail && detail) existing.detail = detail;
      if (updatedAt > existing.updatedAt) existing.updatedAt = updatedAt;
    } else {
      items.set(key, { text: cap(title), detail: detail ? cap(detail) : null, ids: [i.id], updatedAt });
    }
  }
  return GROUP_ORDER.filter((l) => byLabel.has(l)).map((label) => ({
    label,
    items: [...byLabel.get(label)!.values()],
  }));
}

function cap(s: string): string {
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Turn the agent's JSON note into a title + one detail line — never raw
 *  "key: value" pairs. Known shapes first, then a generic fallback. */
function describeInterest(v: unknown): { title: string; detail: string | null } {
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  if (typeof v === 'string') return { title: v.trim(), detail: null };
  if (!v || typeof v !== 'object') return { title: '', detail: null };
  const o = v as Record<string, unknown>;

  // Onboarding picks: { label, blurb, icon }
  if (str(o.label)) return { title: str(o.label)!, detail: str(o.blurb) };
  // Likes / dislikes: { activity, context | reason }
  if (str(o.activity)) return { title: str(o.activity)!, detail: str(o.context) ?? str(o.reason) };
  // Time preferences: { time, context }
  if (str(o.time)) return { title: str(o.time)!, detail: str(o.context) };
  // Venue preferences: { context: "dinner", max_drive_time, price_preference }
  if (str(o.max_drive_time) || str(o.price_preference)) {
    const parts = [
      str(o.max_drive_time) ? `within ${str(o.max_drive_time)}` : null,
      str(o.price_preference),
    ].filter(Boolean);
    return { title: str(o.context) ?? str(o.venue) ?? 'Places to go', detail: parts.join(' · ') || null };
  }
  // Habits / other notes: { detail, type }
  if (str(o.detail)) return { title: str(o.detail)!, detail: null };

  // Fallback: first text value is the title, the next one the detail.
  const texts = Object.entries(o)
    .filter(([k]) => k !== 'icon' && k !== 'type')
    .map(([, x]) => str(x))
    .filter((x): x is string => !!x);
  return { title: texts[0] ?? '', detail: texts[1] ?? null };
}
