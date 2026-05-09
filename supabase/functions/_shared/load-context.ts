/**
 * Shared user-context loader.
 *
 * Centralises the parallel queries that both `agent-respond` (for chat turns)
 * and `agent-daily-scan` (for proactive proposals) need:
 *   profile, goals, interests, groups, recent chat, behavioral_summary,
 *   calendar events in a window.
 *
 * Each consumer picks what it needs from the returned bundle. The cost of the
 * extra fields is a few small Supabase round-trips that already run in
 * parallel — negligible.
 */

// deno-lint-ignore no-explicit-any
export type SupabaseLikeClient = any;

export type ProfileRow = {
  id: string;
  first_name: string | null;
  display_name: string | null;
  social_openness: string | null;
  timezone: string | null;
};

export type GoalRow = {
  id: string;
  title: string;
  category: string | null;
  status: string | null;
  is_aspirational: boolean | null;
  target_per_week: number | null;
  last_completed_at: string | null;
};

export type InterestRow = {
  id: string;
  key: string;
  value: unknown;
  confidence: number | null;
};

export type GroupRow = {
  id: string;
  name: string;
  group_type: string | null;
};

export type BehavioralSummaryRow = {
  archetype_text: string | null;
  data_quality: string | null;
  chronotype: string | null;
  bedtime_minute: number | null;
  waketime_minute: number | null;
  weekly_workout_count: number | null;
};

export type ChatRow = {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  created_at: string | null;
};

export type CalendarEventRow = {
  id: string;
  title: string | null;
  start_at: string;
  end_at: string;
  event_type: string | null;
  is_movable: boolean;
  hangout_id: string | null;
};

export type UserContext = {
  profile: ProfileRow;
  goals: GoalRow[];
  interests: InterestRow[];
  groups: GroupRow[];
  recentChat: ChatRow[];
  behavioralSummary: BehavioralSummaryRow | null;
  calendarEvents: CalendarEventRow[];
};

export async function loadUserContext(
  supabase: SupabaseLikeClient,
  userId: string,
  options: {
    /** ISO UTC, calendar events from this point. Default: 7 days ago. */
    calendar_from?: string;
    /** ISO UTC, calendar events up to this point. Default: 14 days ahead. */
    calendar_to?: string;
    /** How many recent chat messages to include. Default 30. */
    chat_limit?: number;
  } = {},
): Promise<UserContext> {
  const calendarFrom =
    options.calendar_from ??
    new Date(Date.now() - 7 * 86_400_000).toISOString();
  const calendarTo =
    options.calendar_to ??
    new Date(Date.now() + 14 * 86_400_000).toISOString();
  const chatLimit = options.chat_limit ?? 30;

  const [profileRes, goalsRes, interestsRes, groupsRes, chatRes, summaryRes, eventsRes] =
    await Promise.all([
      supabase
        .from('profiles')
        .select('id, first_name, display_name, social_openness, timezone')
        .eq('id', userId)
        .maybeSingle(),
      supabase
        .from('goals')
        .select('id, title, category, status, is_aspirational, target_per_week, last_completed_at')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(20),
      supabase
        .from('interests')
        .select('id, key, value, confidence')
        .eq('user_id', userId)
        .eq('active', true)
        .order('updated_at', { ascending: false })
        .limit(40),
      supabase
        .from('group_members')
        .select('group_id, groups(id, name, group_type)')
        .eq('user_id', userId),
      supabase
        .from('chat_messages')
        .select('id, role, content, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(chatLimit),
      supabase
        .from('behavioral_summary')
        .select('archetype_text, data_quality, chronotype, bedtime_minute, waketime_minute, weekly_workout_count')
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('calendar_events')
        .select('id, title, start_at, end_at, event_type, is_movable, hangout_id')
        .eq('user_id', userId)
        .gte('start_at', calendarFrom)
        .lte('start_at', calendarTo)
        .order('start_at', { ascending: true }),
    ]);

  const profile: ProfileRow = (profileRes.data as ProfileRow | null) ?? {
    id: userId,
    first_name: null,
    display_name: null,
    social_openness: null,
    timezone: null,
  };

  const goals: GoalRow[] = (goalsRes.data as GoalRow[] | null) ?? [];
  const interests: InterestRow[] = (interestsRes.data as InterestRow[] | null) ?? [];
  const groups: GroupRow[] =
    ((groupsRes.data as { groups: GroupRow }[] | null) ?? [])
      .map((m) => m.groups)
      .filter(Boolean);
  const recentChat: ChatRow[] = ((chatRes.data as ChatRow[] | null) ?? []).reverse();
  const behavioralSummary = (summaryRes.data as BehavioralSummaryRow | null) ?? null;
  const calendarEvents: CalendarEventRow[] = (eventsRes.data as CalendarEventRow[] | null) ?? [];

  return {
    profile,
    goals,
    interests,
    groups,
    recentChat,
    behavioralSummary,
    calendarEvents,
  };
}
