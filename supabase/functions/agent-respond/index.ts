/**
 * agent-respond — Supabase Edge Function
 * ----------------------------------------------------------------------------
 * The brain of ALINE. Receives a user's chat message id, loads everything we
 * know about them, runs an agentic loop with Claude (tool use enabled), then
 * persists the final reply + extracted preferences.
 *
 * Tools the agent can call:
 *   - propose_hangout(group_id, title, proposed_start, reasoning, ...)
 *       Creates a hangout proposal for a group. Per-member response rows
 *       are pre-populated; the proposer is auto-confirmed; the rest are
 *       'pending' until they tap confirm/decline in the app.
 *
 * Loop:
 *   1. Build context, call Claude with tools enabled.
 *   2. If Claude returns tool_use blocks → execute each, build tool_result,
 *      send back to Claude. Repeat up to MAX_TOOL_ROUNDS.
 *   3. Final assistant turn must contain text matching <reply>/<extracted>.
 *
 * Secrets required:
 *   - ANTHROPIC_API_KEY        (your Anthropic key)
 *   - ANTHROPIC_MODEL          (optional, defaults to claude-sonnet-4-5)
 * ----------------------------------------------------------------------------
 */

// @ts-expect-error — Deno-only deps; this file runs in Supabase Edge Runtime.
import { createClient } from 'jsr:@supabase/supabase-js@2';

// ---------- types --------------------------------------------------------
type ChatRow = {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  created_at: string | null;
};

type ProfileRow = {
  id: string;
  first_name: string | null;
  display_name: string | null;
  social_openness: string | null;
  timezone: string | null;
};

type GoalRow = {
  id: string;
  title: string;
  category: string | null;
  status: string | null;
  is_aspirational: boolean | null;
};

type InterestRow = {
  id: string;
  key: string;
  value: unknown;
  confidence: number | null;
};

type GroupRow = {
  id: string;
  name: string;
  group_type: string | null;
};

type GroupMemberRow = {
  id: string;
  handle: string | null;
  first_name: string | null;
};

type FriendRow = {
  id: string;
  handle: string | null;
  first_name: string | null;
};

type UpcomingHangoutRow = {
  id: string;
  title: string;
  proposed_start: string | null;
  status: string | null;
  // "who" is rendered for the prompt; for groups this is the group name,
  // for direct it's the other user's handle.
  who_label: string;
  // The agent needs the kind so it can pick the right RPC if it needs to
  // reschedule (cancel_hangout works for both; update_hangout for both).
  kind: 'group' | 'direct';
};

type BehavioralSummaryRow = {
  archetype_text: string | null;
  data_quality: string | null;
  chronotype: string | null;
  bedtime_minute: number | null;
  waketime_minute: number | null;
  weekly_workout_count: number | null;
};

type PlaceRow = {
  name: string | null;
  user_label: string | null;
  category: string | null;
};

type WeekEventRow = {
  id: string;
  title: string | null;
  start_at: string;
  end_at: string;
  event_type: string | null;
  is_movable: boolean | null;
  location: string | null;
};

type PatternRow = {
  activity_key: string;
  day_of_week: number;
  time_bucket: number;
  count: number;
  confidence: number;
  places: { name: string | null; user_label: string | null } | null;
};

type RecentChangeRow = {
  reasoning: string | null;
  status: string;
  updated_at: string;
};

type LiveStatusRow = {
  live_status: string;
  scheduled_start: string;
  scheduled_end: string;
  calendar_events: { title: string | null } | null;
  places: { user_label: string | null; name: string | null } | null;
};

type ReminderRow = {
  id: string;
  content: string;
  remind_at: string;
};

type Extracted = {
  key: string;
  value: unknown;
  confidence?: number;
};

// Anthropic message types
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

type ClaudeMessage = {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
};

// ---------- config --------------------------------------------------------
const MODEL =
  // @ts-expect-error
  Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-5';
// @ts-expect-error
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
// @ts-expect-error
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// @ts-expect-error
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
// @ts-expect-error
const OPENWEATHER_API_KEY = Deno.env.get('OPENWEATHER_API_KEY');

const MAX_TOOL_ROUNDS = 3;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------- tools ---------------------------------------------------------
const TOOLS = [
  {
    name: 'propose_hangout',
    description:
      "Create a hangout — either with a whole group (set group_id) or 1-on-1 with a single friend (set direct_friend_handle). Exactly ONE of {group_id, direct_friend_handle} must be set. " +
      "ONLY call this AFTER you have (1) called find_mutual_slots to verify the time works for everyone, AND (2) presented the time + reasoning to the user in chat and they confirmed (\"sounds good\", \"yes\", \"let's do it\"). Never call propose_hangout on the first turn unless the user explicitly gives a specific time AND you already verified it. " +
      "The hangout is auto-confirmed for the user. Other participants see it as pending until they respond.",
    input_schema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description:
            "UUID of the group, if this is a group hangout. MUST be one of the user's group IDs listed in the system prompt. Mutually exclusive with direct_friend_handle.",
        },
        direct_friend_handle: {
          type: 'string',
          description:
            "Handle (no leading @) of the single friend, if this is a 1-on-1 hangout. MUST be in the Friends list in the system prompt. Mutually exclusive with group_id.",
        },
        title: {
          type: 'string',
          description: "Short title, e.g. 'Dinner', 'Coffee', 'Tivoli run'",
        },
        proposed_start: {
          type: 'string',
          description:
            "ISO 8601 datetime in the user's LOCAL time, e.g. '2026-04-30T19:00:00'. Do NOT add a Z or timezone offset — the system applies the user's timezone automatically.",
        },
        reasoning: {
          type: 'string',
          description:
            'One sentence the user will see explaining WHY this time/place. Be honest — what made you pick it.',
        },
        description: {
          type: 'string',
          description: 'Optional one-sentence description.',
        },
        proposed_end: {
          type: 'string',
          description: 'Optional ISO 8601 end time. Defaults to start + 2h.',
        },
        venue_name: {
          type: 'string',
          description: "Optional venue name, e.g. 'Ramen Yasai'.",
        },
        venue_address: {
          type: 'string',
          description: 'Optional venue address.',
        },
        min_attendees: {
          type: 'integer',
          description:
            "Optional. How many 'I'm in' responses are needed before the hangout flips to CONFIRMED. " +
            "If omitted, a sensible default is computed from group size. " +
            "Lower this for casual hangs (e.g. 'come if you can'), raise it for activities " +
            "that need critical mass (group hike, party, study session). " +
            "Reasonable values: 1:1 = 2; small dinner = group_size; party = group_size/2; minimum 1.",
        },
      },
      required: ['title', 'proposed_start', 'reasoning'],
    },
  },
  {
    name: 'find_mutual_slots',
    description:
      "Find time slots when participants are free. Use this BEFORE proposing or rescheduling a hangout involving anyone besides the user. Privacy-preserving — reveals only when busy/free, never event details. " +
      "Two modes: " +
      "1) STRICT (default, omit min_free_count): only returns slots when EVERY listed participant is free. Best for 1-on-1 and small groups. " +
      "2) THRESHOLD (set min_free_count): returns slots where at least N participants are free. Use this when strict returned no slots, or for larger groups where everyone-free is unrealistic. The response tells you WHO is busy at each slot (busy_handles) so you can mention them honestly to the user. " +
      "The user is always included automatically and must be free in every returned slot. " +
      "Authorization: every participant must be friends with the user OR share a group with them.",
    input_schema: {
      type: 'object',
      properties: {
        participant_handles: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Handles (no leading @) of the OTHER participants. Do NOT include the user themselves. Examples: ['ana'], ['marko','luka']. Use [] for a self-only check.",
        },
        duration_minutes: {
          type: 'integer',
          description: 'How long the slot needs to be, in minutes.',
        },
        earliest: {
          type: 'string',
          description:
            "Earliest acceptable slot start, ISO 8601 in user's LOCAL time (no Z, no offset).",
        },
        latest: {
          type: 'string',
          description:
            "Latest acceptable slot end, ISO 8601 in user's LOCAL time.",
        },
        time_preference: {
          type: 'string',
          enum: ['morning', 'afternoon', 'evening', 'any'],
          description:
            "Bias the ranking. 'morning'=7-11, 'afternoon'=12-16, 'evening'=17-21.",
        },
        min_free_count: {
          type: 'integer',
          description:
            "Optional. When set, threshold mode: return slots where at least N participants are free (including the user). Examples: group of 5, set 4 to allow one person missing; group of 8, set 5 for majority. Omit for strict mode (everyone free).",
        },
      },
      required: ['participant_handles', 'duration_minutes', 'earliest', 'latest'],
    },
  },
  {
    name: 'cancel_hangout',
    description:
      "Cancel an existing hangout. Use this when the user wants to call something off (\"cancel my dinner with Marko\", \"call off the climbing trip\", \"cancel that\"). Look up the hangout id from the Upcoming hangouts section in the system prompt. If ambiguous (multiple matches), ASK first — don't guess. For direct hangouts either party can cancel; for group hangouts only the proposer can.",
    input_schema: {
      type: 'object',
      properties: {
        hangout_id: {
          type: 'string',
          description: 'UUID from the Upcoming hangouts list in the system prompt.',
        },
      },
      required: ['hangout_id'],
    },
  },
  {
    name: 'update_hangout',
    description:
      "Reschedule or edit an existing hangout (move the time, change the title, change the venue). Only the proposer can update. If you change the TIME, all other participants' RSVPs reset to pending — they have to reconfirm. " +
      "If the user asks to move a hangout, FIRST call find_mutual_slots for the new window, present the best option in chat with reasoning, wait for approval, THEN call update_hangout.",
    input_schema: {
      type: 'object',
      properties: {
        hangout_id: {
          type: 'string',
          description: 'UUID from the Upcoming hangouts list.',
        },
        new_start: {
          type: 'string',
          description: "New start time, ISO 8601 in user's LOCAL time (no Z, no offset). Optional.",
        },
        new_end: {
          type: 'string',
          description: 'Optional new end time, ISO 8601 local.',
        },
        new_title: { type: 'string', description: 'Optional new title.' },
        new_venue_name: { type: 'string', description: 'Optional new venue name.' },
        new_venue_address: { type: 'string', description: 'Optional new venue address.' },
        new_description: { type: 'string', description: 'Optional new description.' },
      },
      required: ['hangout_id'],
    },
  },
  {
    name: 'find_open_slots',
    description:
      "Find open time slots in the user's calendar within a window. Use this BEFORE proposing any calendar change so you know what's actually free vs blocked. Returns slots classified as 'none' (truly empty), 'flexible' (occupied by movable events the user has agreed can be reshuffled), or 'fixed' slots are silently skipped. When a slot is 'flexible', conflicting_events tells you what would need to be moved — you can then build a propose_change_set with both a 'move' op and a 'create' op together.",
    input_schema: {
      type: 'object',
      properties: {
        duration_minutes: {
          type: 'integer',
          description: 'How long the slot needs to be, in minutes.',
        },
        earliest: {
          type: 'string',
          description:
            "Earliest acceptable slot start, ISO 8601 in user's LOCAL time (no Z, no offset). E.g. '2026-05-13T08:00:00'. The system applies the user's timezone.",
        },
        latest: {
          type: 'string',
          description:
            "Latest acceptable slot end, ISO 8601 in user's LOCAL time. The window length is (latest - earliest).",
        },
        time_preference: {
          type: 'string',
          enum: ['morning', 'afternoon', 'evening', 'any'],
          description:
            "Bias the ranking. 'morning'=6-11, 'afternoon'=13-17, 'evening'=18-22. Use 'any' if user didn't say.",
        },
      },
      required: ['duration_minutes', 'earliest', 'latest'],
    },
  },
  {
    name: 'propose_change_set',
    description:
      "Propose a bundle of calendar operations the user can accept or reject as one atomic unit. NEVER apply changes directly to the calendar — always go through this. Operations are 'move' (shift an existing movable event) and 'create' (add a new event). The user sees a card in chat with three buttons: Accept all / Different time / Cancel. Always include a clear, friendly summary_for_user explaining the WHOLE bundle in one short sentence — not technical details, just the human-readable plan ('Move your gym Wed → Thu so dinner with Marko fits Wed evening').",
    input_schema: {
      type: 'object',
      properties: {
        summary_for_user: {
          type: 'string',
          description:
            "One short sentence the user will see at the top of the proposal card, explaining the whole bundle.",
        },
        apply: {
          type: 'boolean',
          description:
            "Set TRUE to apply the change immediately with NO confirmation card — use this when " +
            "${firstName} EXPLICITLY asked for this specific change (e.g. 'schedule a haircut Thursday 2pm', " +
            "'move my gym to 7pm'). Set FALSE (or omit) when YOU are suggesting or autonomously " +
            "reorganizing/rescheduling (e.g. shuffling blocks for a delay, mood, or conflict) — then the " +
            "user gets an Accept/Reject card. Rule of thumb: user directed it → apply:true; you decided it → apply:false.",
        },
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            description:
              "Either a 'move' op (op='move', event_id, new_start, new_end) or a 'create' op (op='create', title, start_at, end_at, event_type). All times are ISO 8601 LOCAL (no Z, no offset). event_type for create must be 'flexible' (default for self-blocks like reading time) or 'goal' (for goal-tied blocks like a planned run). Optional 'reasoning' on each op shows up next to the op in the card.",
          },
        },
      },
      required: ['summary_for_user', 'operations'],
    },
  },
  {
    name: 'set_reminder',
    description:
      "Set a lightweight reminder — a push nudge at a specific time, NOT a calendar block. Use when the user wants to be reminded of a small task that doesn't occupy time ('remind me to send that email at 4pm', 'remind me to call mom tomorrow morning'). Applies immediately, no confirmation needed. If the user asks to BLOCK TIME for something, use propose_change_set instead.",
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: "What to remind them of, phrased as a short spoken sentence ('Send the email to Marko').",
        },
        remind_at: {
          type: 'string',
          description: "When to fire, ISO 8601 in the user's LOCAL time (no Z, no offset). Look the date up in the Date reference table.",
        },
      },
      required: ['content', 'remind_at'],
    },
  },
  {
    name: 'cancel_reminder',
    description:
      "Cancel a pending reminder. Use the EXACT id from the Pending reminders list in the system prompt.",
    input_schema: {
      type: 'object',
      properties: {
        reminder_id: { type: 'string', description: 'UUID from the Pending reminders list.' },
      },
      required: ['reminder_id'],
    },
  },
  {
    name: 'get_weather',
    description:
      "Get the weather forecast near the user's home (3-hour steps, up to 5 days ahead). Call this BEFORE proposing or confirming any weather-sensitive activity — walk, run, bike, hike, picnic, outdoor sports — and when the user asks whether an outdoor plan still makes sense. Location is resolved automatically from their places; you only pick the date.",
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description:
            "Local date to forecast, 'YYYY-MM-DD' (look it up in the Date reference table). Omit for the next 24 hours.",
        },
      },
      required: [],
    },
  },
  {
    name: 'send_calendar_invite',
    description:
      "Create a real event on the user's Google Calendar and email a calendar invite to one or more people by email address. Use this to invite someone who is NOT on ALINE (no @handle) — e.g. the user says \"invite jane@email.com to coffee Friday 3pm\". The event also appears on the user's own calendar immediately. CRITICAL: this emails real people, so you MUST first describe the invite (who, what, when, where) in plain text and get the user's explicit go-ahead in a SEPARATE turn before calling this tool — never send on the same turn you first mention it. Requires Google Calendar connected with write permission; if it fails for permission reasons, tell the user to reconnect Google Calendar in the You tab.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title, e.g. "Coffee with Jane".' },
        start: { type: 'string', description: 'Start time as full ISO 8601 with offset, e.g. 2026-06-19T15:00:00+02:00.' },
        end: { type: 'string', description: 'End time as full ISO 8601 with offset. Default 1 hour after start if unsure.' },
        attendee_emails: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email addresses to invite. At least one.',
        },
        location: { type: 'string', description: 'Optional venue / address.' },
        description: { type: 'string', description: 'Optional note included in the invite.' },
      },
      required: ['title', 'start', 'end', 'attendee_emails'],
    },
  },
] as const;

// ---------- prompt --------------------------------------------------------
/**
 * Returns two strings: a STATIC block (per-user, stable within a session)
 * suitable for prompt caching, and a DYNAMIC block (current timestamp only,
 * changes every request, must NOT be cached).
 *
 * This split powers Anthropic prompt caching: the static block is sent with
 * cache_control: { type: 'ephemeral' }, the dynamic block is appended after.
 * On a cache hit, the static block is read at 10% of normal cost — typically
 * 40-60% input-token savings on a chatty session.
 */
function buildSystemPromptBlocks(input: {
  firstName: string;
  socialOpenness: string | null;
  timezone: string;
  goals: GoalRow[];
  interests: InterestRow[];
  groups: GroupRow[];
  behavioralSummary: BehavioralSummaryRow | null;
  friends: FriendRow[];
  upcomingHangouts: UpcomingHangoutRow[];
  places: PlaceRow[];
  weekEvents: WeekEventRow[];
  patterns: PatternRow[];
  recentChanges: RecentChangeRow[];
  liveStatuses: LiveStatusRow[];
  reminders: ReminderRow[];
}): { staticBlock: string; dynamicBlock: string } {
  const {
    firstName,
    socialOpenness,
    timezone,
    goals,
    interests,
    groups,
    behavioralSummary,
    friends,
    upcomingHangouts,
    places,
    weekEvents,
    patterns,
    recentChanges,
    liveStatuses,
    reminders,
  } = input;

  const goalLines =
    goals.length === 0
      ? 'None recorded yet.'
      : goals
          .map(
            (g) =>
              `  - ${g.title}${g.category ? ` [${g.category}]` : ''}${
                g.is_aspirational ? ' (aspirational)' : ''
              }`
          )
          .join('\n');

  const interestLines =
    interests.length === 0
      ? 'None learned yet.'
      : interests
          .map((i) => `  - ${i.key}: ${JSON.stringify(i.value)}`)
          .join('\n');

  const groupLines =
    groups.length === 0
      ? 'No groups yet. Suggest creating one if they want to coordinate hangouts.'
      : groups
          .map(
            (g) =>
              `  - ${g.name}${g.group_type ? ` (${g.group_type})` : ''} — id: ${g.id}`
          )
          .join('\n');

  const friendLines =
    friends.length === 0
      ? 'No friends yet. They can add friends by handle.'
      : friends
          .map(
            (f) =>
              `  - @${f.handle ?? '?'}${f.first_name ? ` (${f.first_name})` : ''}`
          )
          .join('\n');

  const upcomingLines =
    upcomingHangouts.length === 0
      ? 'No upcoming hangouts.'
      : upcomingHangouts
          .map((h) => {
            const when = h.proposed_start
              ? new Date(h.proposed_start).toLocaleString('en-US', {
                  timeZone: timezone,
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })
              : '(no time)';
            return `  - "${h.title}" · ${when} · with ${h.who_label} · ${h.status} · id: ${h.id} · kind: ${h.kind}`;
          })
          .join('\n');

  const placeLines =
    places.length === 0
      ? 'No places learned yet.'
      : places
          .map(
            (p) =>
              `  - ${p.user_label || p.name || 'Unnamed'}${
                p.category ? ` (${p.category})` : ''
              }`
          )
          .join('\n');

  const fmtMin = (m: number | null): string => {
    if (m == null) return '??:??';
    const hh = Math.floor(((m % 1440) + 1440) % 1440 / 60);
    const mm = ((m % 60) + 60) % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  const rhythmReliable =
    behavioralSummary?.data_quality === 'high' &&
    (behavioralSummary?.waketime_minute != null ||
      behavioralSummary?.bedtime_minute != null);
  const rhythmLine = rhythmReliable
    ? `Daily rhythm (inferred, reliable): wakes ~${fmtMin(
        behavioralSummary!.waketime_minute,
      )}, sleeps ~${fmtMin(behavioralSummary!.bedtime_minute)}${
        behavioralSummary!.chronotype ? ` · ${behavioralSummary!.chronotype}` : ''
      }${
        behavioralSummary!.weekly_workout_count != null
          ? ` · ~${behavioralSummary!.weekly_workout_count} workouts/week`
          : ''
      }. Plan within waking hours; don't schedule over sleep.`
    : null;

  const scheduleLines =
    weekEvents.length === 0
      ? 'Nothing on the calendar in the next 7 days.'
      : weekEvents
          .map((e) => {
            const when = new Date(e.start_at).toLocaleString('en-US', {
              timeZone: timezone,
              weekday: 'short',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            });
            const end = new Date(e.end_at).toLocaleString('en-US', {
              timeZone: timezone,
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            });
            const tag =
              e.event_type === 'routine'
                ? ' [routine]'
                : e.event_type === 'transit'
                  ? ' [transit]'
                  : e.event_type === 'coordinated'
                    ? ' [hangout]'
                    : '';
            const movable =
              e.is_movable && e.event_type !== 'coordinated' && e.event_type !== 'transit';
            const passed = new Date(e.end_at).getTime() < Date.now() ? ' · ALREADY PASSED' : '';
            return `  - ${when}–${end} ${e.title ?? 'Untitled'}${tag}${
              e.location ? ` @ ${e.location}` : ''
            } · id: ${e.id}${movable ? ' · movable' : ''}${passed}`;
          })
          .join('\n');

  // Fused belief: collapse the learned distribution to the top location per
  // activity (rows arrive ordered by count desc, so first-per-key is dominant).
  const seenKeys = new Set<string>();
  const patternLines =
    patterns.length === 0
      ? 'Nothing learned yet — patterns build as activities recur.'
      : patterns
          .filter((p) => {
            if (seenKeys.has(p.activity_key)) return false;
            seenKeys.add(p.activity_key);
            return true;
          })
          .slice(0, 8)
          .map((p) => {
            const place = p.places?.user_label || p.places?.name || 'no fixed place';
            return `  - ${p.activity_key} → usually ${place} (${Math.round(
              p.confidence * 100,
            )}% of the time)`;
          })
          .join('\n');

  const relTime = (iso: string): string => {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const h = Math.round(mins / 60);
    return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  };
  const changeLines =
    recentChanges.length === 0
      ? 'None recently.'
      : recentChanges
          .map(
            (c) =>
              `  - ${c.status === 'accepted' ? '✓ accepted' : '✗ declined'} (${relTime(
                c.updated_at,
              )}): ${c.reasoning ?? 'a calendar change'}`,
          )
          .join('\n');

  const liveStatusLabel: Record<string, string> = {
    late_incoming: 'running late (appears to be on the way)',
    likely_skip: 'looks like they skipped / are not there',
    unknown_location: 'at an unrecognized place',
    unknown: 'no location signal',
  };
  const liveLines =
    liveStatuses.length === 0
      ? 'Nothing flagged.'
      : liveStatuses
          .map((l) => {
            const title = l.calendar_events?.title ?? 'an activity';
            const place = l.places?.user_label || l.places?.name;
            return `  - "${title}"${place ? ` (expected @ ${place})` : ''}: ${
              liveStatusLabel[l.live_status] ?? l.live_status
            }`;
          })
          .join('\n');

  const reminderLines =
    reminders.length === 0
      ? 'None pending.'
      : reminders
          .map((r) => {
            const when = new Date(r.remind_at).toLocaleString('en-US', {
              timeZone: timezone,
              weekday: 'short',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            });
            return `  - ${when}: "${r.content}" · id: ${r.id}`;
          })
          .join('\n');

  const staticBlock = `You are ALINE — ${firstName}'s personal AI agent.

You help them coordinate their life and connect with the people who matter to them.
You learn from every conversation. You represent ${firstName} when their agent talks to other people's agents.

# Iron-clad principles (never break, even if asked)

1. **Suggest, never control.** You are a copilot. ${firstName} always decides.
2. **Be transparent.** Always show WHY you're suggesting something.
3. **Never manipulate.** Never engineer encounters in secret. Never push.
4. **Connections find people.** You surface possibilities — you don't pressure.
5. **Goals drive matching, behavioral data enables it.**

# Your voice

- Concise. Talk like a smart friend, not a corporate AI.
- Warm but not saccharine. No emojis unless ${firstName} uses them first.
- Reference what you know about ${firstName} when it's actually relevant.
- Never say "As an AI..." or "I'm just a language model." You are ALINE.
- When you don't know something yet, say so. Don't make things up.

# Tools you have

- **find_mutual_slots** — Find slots where everyone is free (the user plus
  named friends, or all members of one of their groups). Privacy-preserving;
  returns free/busy windows only, never event details. ALWAYS call this first
  when you're planning anything that involves anyone other than the user.

- **propose_hangout** — Create a hangout. Two modes:
  - Group: pass \`group_id\` (one of ${firstName}'s group ids).
  - 1-on-1: pass \`direct_friend_handle\` (a handle from Friends).
  ONLY call this AFTER (1) find_mutual_slots confirms the time works, AND
  (2) ${firstName} approves the proposal in chat ("yes", "sounds good"). The
  hangout auto-confirms ${firstName}; others see it as pending. Always
  include concrete reasoning the user will see.

- **cancel_hangout** — Cancel an existing hangout. Look up the id from the
  Upcoming hangouts list. For direct: either party can cancel. For group:
  only the proposer.

- **update_hangout** — Reschedule or edit an existing hangout (only the
  proposer can). If you're CHANGING THE TIME, you must call find_mutual_slots
  first, present the new option in chat, and wait for approval — same flow
  as propose_hangout.

- **find_open_slots** — Read-only. Slot finder for ${firstName}'s OWN
  calendar only. Returns 'none' / 'flexible' classification (the multi-user
  find_mutual_slots is preferred for hangouts). Use this when ${firstName}
  asks about THEIR availability for solo blocks (gym, study, reading).

- **propose_change_set** — Move things or add new blocks to ${firstName}'s
  calendar. NEVER write to the calendar another way. Compose changes atomically:
  if making dinner requires moving a gym block, both go in the SAME change set.
  Summary_for_user is what the user reads first — keep it conversational.

  **apply vs. confirm (important):**
  - If ${firstName} EXPLICITLY asked for this specific change — "schedule a haircut
    Thursday 2pm", "add a 1h run tomorrow morning", "move my gym to 7pm" — set
    **apply: true**. It happens immediately, NO card. Just confirm in your reply
    ("Done — haircut Thursday at 2pm."). Don't make them approve what they just asked for.
  - If YOU are suggesting it or reorganizing autonomously — reshuffling for a delay,
    a conflict, their mood/energy, or a plan-my-day where you chose the layout — set
    **apply: false** (or omit). They get an Accept/Reject card, because the initiative
    was yours, not theirs.
  - When unsure, prefer apply:false (ask). A reschedule the user explicitly requested
    is apply:true; a reschedule you initiated is apply:false.

  Bundling rule: when proposing a group hangout that also needs a calendar
  block, call propose_hangout FIRST to get the hangout id, then include a
  'create' op in the change set with the hangout_id linked.

  Day-planning rule: when ${firstName} asks you to plan, structure, or lay out
  a day (or a chunk of it), propose ALL the blocks together as multiple 'create'
  ops in ONE change set (up to 12) — don't drip them one at a time. Place blocks
  in the real free gaps (respect existing events, routines, transit, and the
  sleep/wake window above), give each a clear title and time, and explain the
  shape of the day in summary_for_user. One card, one approval, whole day laid out.

- **set_reminder / cancel_reminder** — A reminder is a push NUDGE at a time, not
  a calendar block. "Remind me to send that email at 4" → set_reminder (applies
  immediately, no card, no block). Use a block (propose_change_set) only when the
  task genuinely OCCUPIES time. When planning a day, small to-dos the user mentions
  ("and remind me to call mom") become reminders, not blocks. Phrase content as a
  short spoken sentence — pushes may be read aloud by Siri.

- **get_weather** — Local forecast near ${firstName}'s home, 3h steps, ~5 days out.
  Weather-aware planning rule: walks, runs, bike rides, hikes, picnics and outdoor
  sports are weather-sensitive. CHECK THE FORECAST before proposing one, and when
  ${firstName} asks about an upcoming outdoor plan. If the forecast at that time is
  bad (likely rain, storm, extreme heat/cold), say so plainly and OFFER a fix —
  a better slot the same day/week (find_open_slots) or an indoor alternative.
  Don't silently reschedule, and don't mention weather for indoor activities.

- **send_calendar_invite** — Invite someone who is NOT on ALINE (no @handle) by
  email: creates a real Google Calendar event and emails them an invite. Use it
  when ${firstName} gives an email or says "invite X by email". For people who
  ARE on ALINE (have an @handle), use propose_hangout instead — never email them.
  TWO-STEP, NO EXCEPTIONS: because this emails real people, first describe the
  invite (who / what / when / where) in chat and ask "want me to send it?", then
  call the tool ONLY after explicit approval on a later turn. apply-mode does not
  apply here — there is no silent send, ever. Needs Google connected with write
  access; on a permission failure, tell ${firstName} to reconnect Google Calendar
  in the You tab.

# Intent playbook — how to handle natural-language requests

**Hard rule.** Before proposing or updating any time that involves anyone
besides ${firstName}, you MUST call find_mutual_slots first. Never blind-
propose. This is non-negotiable.

**Two-step pattern for ALL hangout proposals and reschedules:**
1. Call find_mutual_slots, then reply in chat with the best slot and your
   reasoning ("4pm Wednesday works — you finish work at 3 and Ana's also free.
   Want me to send it?"). DO NOT call propose_hangout or update_hangout yet.
2. Wait for explicit approval ("yes", "looks good", "sure"). Only THEN call
   the actual tool. If they push back ("not Wednesday", "later"), call
   find_mutual_slots again with the adjusted constraints.

**Always settle the WHERE, not just the when.** A time with no place sends
people back to texting each other — which defeats the point. When you confirm
the time, also propose or capture a venue and pass it as venue_name (with
venue_address when you know it):
- If the user names a place ("at Čaj café", "my place", "Tivoli"), use it.
- If they don't, SUGGEST one in the same chat message as the time ("4pm at
  Čokl for coffee?") and let them approve both together. Pick somewhere that
  fits the activity and is reasonable for both people.
- Only leave the venue empty if the user explicitly wants to decide later
  ("we'll figure out where"). In that case say so plainly.
Same rule applies when rescheduling via update_hangout — keep or update the
venue, don't silently drop it.

**Threshold fallback for groups:**
If strict find_mutual_slots (everyone free) returns zero slots for a group
of 3+, call it AGAIN with min_free_count set to a sensible threshold:
- For groups of 3-4: try min_free_count = total - 1 (one person allowed missing)
- For groups of 5-7: try min_free_count = total - 2 (or majority floor)
- For groups of 8+: try majority (ceil(total / 2) + 1)
- If user mentioned a number ("only if 4+ are in"), use that

When threshold mode returns slots, be honest in chat: "Thursday 7pm works
for 4 of 5 — Marko's busy. Want to send it anyway? The hangout will confirm
once enough people RSVP yes." This matches the hangout's existing
min_attendees threshold — you propose to everyone, but it confirms when
enough commit.

NEVER propose a slot where the user themselves is busy. The RPC already
filters those out, but if all slots have free_count < what user wants,
suggest a different window instead.

**About event titles you don't actually know:**
find_mutual_slots returns ONLY busy time windows — it does NOT tell you
what events are at those times. Don't invent titles ("the run", "lunch",
"meeting") unless you SAW that title in chat history, the upcoming
hangouts section, or the user just told you. If you only know they're
busy but not WITH WHAT, say "you're booked then" or "you have something
on" — never invent specifics.

**Common intents:**

- "Plan X with [name]" / "let's grab coffee with Ana":
  Resolve [name] from Friends (match by handle or first_name). Use
  find_mutual_slots(['handle']) → present option in chat → on approval call
  propose_hangout with \`direct_friend_handle\`. If multiple friends match,
  ask which one.

- "Plan X with the [group]" / "dinner with the climbers":
  Match group from Their groups. Use find_mutual_slots with that group's
  member handles → present → on approval call propose_hangout with
  \`group_id\`.

- "Cancel my dinner with Marko" / "cancel that":
  Find the matching hangout in Upcoming hangouts. For "that" or "it", use
  the most recently mentioned one from the conversation. If ambiguous, ASK
  ("you have dinner with Marko Wed AND Fri — which one?"). Then call
  cancel_hangout.

- "Move it to Friday 6pm" / "push the run by an hour":
  Find the matching hangout. Call find_mutual_slots for the new window →
  present in chat → on approval call update_hangout with the new time.

- "I can't make it tonight" / "I have to skip":
  If ${firstName} is the proposer, cancel the hangout. Otherwise this is a
  decline of their own RSVP — currently they need to tap the in-app button
  for that; tell them so. (Auto-respond on their behalf isn't wired up yet.)

# Time + location context

- ${firstName}'s timezone: ${timezone}
- IMPORTANT: When you call propose_hangout, the proposed_start and
  proposed_end you provide are interpreted as ${firstName}'s LOCAL TIME
  in ${timezone}. So if ${firstName} says "tomorrow at 2pm", just send
  "<tomorrow's date>T14:00:00" and the system will handle the conversion.
  Do NOT manually convert to UTC. Do NOT append a Z suffix.

# What you currently know about ${firstName}

Social openness: ${socialOpenness ?? 'not set yet'}

Note: place labels (Home, Work, etc.) are inferred from GPS patterns and Google Places — they are educated guesses, not confirmed facts. Treat them with appropriate humility. If ${firstName} mentions a place, check your assumption ("I think that's your gym — is that right?") rather than stating it as fact.

${
  behavioralSummary?.data_quality === 'high' && behavioralSummary?.archetype_text
    ? `Sleep + lifestyle profile (inferred from when ${firstName} opens the app — reliable):
${behavioralSummary.archetype_text}`
    : `Note: no reliable sleep data yet. Do NOT make claims about ${firstName}'s sleep schedule, chronotype, bedtime, or wake time. If asked about sleep, say honestly that you don't have enough data yet — they need a couple more weeks of normal app usage first.`
}
${rhythmLine ? `\n${rhythmLine}\n` : ''}
Their places (inferred — treat with humility, confirm rather than assert):
${placeLines}

Active goals:
${goalLines}

Known preferences:
${interestLines}

Their groups (USE THE EXACT id when calling propose_hangout with group_id):
${groupLines}

Their friends (USE THE EXACT handle when calling propose_hangout with direct_friend_handle, or in find_mutual_slots participant_handles):
${friendLines}

Upcoming hangouts (next 5; USE THE EXACT id for cancel_hangout / update_hangout):
${upcomingLines}

This week at a glance (next 7 days — real occupied time, your source of truth for what's scheduled):
${scheduleLines}

Learned patterns (fused from schedule + location over time — what usually happens where; use to
predict and fill in likely locations, e.g. "your workout's probably at home"):
${patternLines}

Recently acted-on proposals (you proposed these; the user tapped a card — there's no chat
message for it, so rely on this). Acknowledge accepted ones as DONE and don't re-propose them;
respect declined ones:
${changeLines}

Live activity status (right now / just passed — inferred from location, may be wrong, so check
before asserting):
${liveLines}

Pending reminders (USE THE EXACT id for cancel_reminder):
${reminderLines}

# Planning rules

- The calendar above + upcoming hangouts are the SOURCE OF TRUTH for what's scheduled.
  NEVER infer current plans from older chat messages — a past message saying "tomorrow
  you have X" was relative to WHEN IT WAS SENT (see the [date] tags on messages), not now.
  If it's not in the calendar/hangouts above, it is not scheduled.
- Blocks tagged [routine] are inferred recurring patterns; [transit] blocks are commute
  time. Treat BOTH as occupied — don't schedule over a routine's transit, and remember a
  venue activity really consumes the activity PLUS its transit on each side.
- Talk in terms of the activity ("your gym block at 18:00"), but respect the full
  occupied span including transit when judging whether something else fits.
- When planning the day, account for the daily rhythm (wake/sleep), goals, and stated
  preferences above — don't propose things during sleep or that clash with a routine.

**Rescheduling rule (never leave duplicates):** if ${firstName} wants to MOVE or reschedule
something already on the calendar above, do NOT create a new block — that leaves the old one
behind as a duplicate. Instead:
  - For a 'movable' calendar block: use a propose_change_set **move** op with that block's
    EXACT id (from the list above). A move updates the block in place, so the old time is
    erased automatically.
  - For a [hangout]: use update_hangout (not a calendar op).
  - Only use a 'create' op for something genuinely NEW that isn't already on the calendar.
  If you're changing the time of an existing activity and you can see its id above, you must
  move it, not recreate it.
  - Blocks marked ALREADY PASSED can still be moved to later today ("I overslept" → move the
    missed gym block to a free slot, don't abandon it).
  - **Never silently drop an activity.** If a move op fails (id not found), recover: re-check
    the schedule list for the right id, or re-create the block at the new time — and say what
    you did. The user asked to ADJUST their day, not to lose pieces of it.

**Live-status intervention:** if the Live activity status above flags something, and it's relevant
to what ${firstName} is saying (or they ask "what's my day"), act gently — don't nag unprompted:
  - **running late** → offer to push the activity and cascade later blocks (one change_set).
  - **looks like they skipped** → offer to reschedule it for later/another day.
  - **unrecognized place** → ask what they're up to ("you're not at your usual spot — what's going on?").
  Always phrase as a question/offer, never an accusation, and remember the signal can be wrong.

# Output format (STRICT)

Your FINAL turn (after any tool calls) must be a single text block with
EXACTLY this structure, no text outside:

<reply>
Your conversational response to ${firstName}. Keep it under ~80 words unless they asked for more.
If you just proposed a hangout, briefly tell them what you set up + why.
</reply>
<extracted>
JSON array of NEW preferences/facts learned from THIS user message. Use [] if nothing new. Each entry:
{
  "key": "<one of: time_preference, venue_preference, activity_like, activity_dislike, social_preference, goal_update, group_preference, mood, life_event, other>",
  "value": <object or string>,
  "confidence": <0.0-1.0>
}
Do NOT re-extract things already in "Known preferences".
</extracted>`;

  const now = new Date();
  // Provide both UTC and the user's local time. Without this the agent
  // reasons about "today" / "tomorrow" in UTC and gets dates wrong when the
  // user is in a non-UTC timezone.
  const localDateTime = now.toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const localDate = now.toLocaleDateString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  // Explicit weekday→date lookup for the next 14 days, in the user's timezone.
  // LLMs are unreliable at day-of-week arithmetic — DON'T make the agent compute
  // dates; it just reads them here (fixes the "Thursday landed on Friday" bug).
  const dateRefLines: string[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    const wd = d.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long' });
    const ymd = d.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD
    const tagn = i === 0 ? '  ← today' : i === 1 ? '  ← tomorrow' : '';
    dateRefLines.push(`  ${wd} = ${ymd}${tagn}`);
  }
  const dynamicBlock =
    `Now (UTC): ${now.toISOString()}\n` +
    `Now (${timezone}): ${localDateTime}\n` +
    `Today (in user's local time): ${localDate}\n\n` +
    `Date reference (user's local dates for the next 2 weeks). When the user names a weekday\n` +
    `("Thursday", "next Tuesday"), DO NOT calculate the date yourself — look it up here and use\n` +
    `the SOONEST matching date (if they name today's weekday, assume next week unless they say "today"):\n` +
    dateRefLines.join('\n') +
    `\nAll proposed_start / change-set times are this LOCAL date + the requested time (no Z, no offset).`;

  return { staticBlock, dynamicBlock };
}

// ---------- response parsing ----------------------------------------------
function parseClaudeText(text: string): { reply: string; extracted: Extracted[] } {
  const replyMatch = text.match(/<reply>([\s\S]*?)<\/reply>/);
  const extractedMatch = text.match(/<extracted>([\s\S]*?)<\/extracted>/);

  const reply = (replyMatch?.[1] ?? text).trim();

  let extracted: Extracted[] = [];
  if (extractedMatch?.[1]) {
    try {
      const parsed = JSON.parse(extractedMatch[1].trim());
      if (Array.isArray(parsed)) {
        extracted = parsed.filter(
          (x): x is Extracted =>
            x && typeof x === 'object' && typeof (x as Extracted).key === 'string'
        );
      }
    } catch {
      // Tolerate invalid JSON — keep the reply working.
    }
  }
  return { reply, extracted };
}

// ---------- handler -------------------------------------------------------
// @ts-expect-error
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonRes({ error: 'POST required' }, 405);
  }

  if (!ANTHROPIC_API_KEY) {
    return jsonRes(
      {
        error:
          'ANTHROPIC_API_KEY not configured. Set it via Supabase dashboard → Edge Functions → Secrets.',
      },
      500
    );
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return jsonRes({ error: 'Missing Authorization' }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return jsonRes({ error: 'Unauthorized' }, 401);
  }
  const userId = userData.user.id;

  let body: { user_message_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.user_message_id) {
    return jsonRes({ error: 'user_message_id required' }, 400);
  }

  // -------- load context in parallel --------
  const nowIso = new Date().toISOString();
  const [
    profileRes,
    goalsRes,
    interestsRes,
    groupsRes,
    chatRes,
    triggerMsgRes,
    summaryRes,
    friendsRes,
    upcomingHangoutsRes,
    placesRes,
    weekEventsRes,
    patternsRes,
    changeSetsRes,
    liveStatusRes,
    remindersRes,
  ] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, first_name, display_name, social_openness, timezone')
      .eq('id', userId)
      .maybeSingle(),
    supabase
      .from('goals')
      .select('id, title, category, status, is_aspirational')
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
      .limit(30),
    supabase
      .from('chat_messages')
      .select('id, role, content, created_at')
      .eq('id', body.user_message_id)
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('behavioral_summary')
      .select('archetype_text, data_quality, chronotype, bedtime_minute, waketime_minute, weekly_workout_count')
      .eq('user_id', userId)
      .maybeSingle(),
    // Friends: mutual friendships where current user appears on either side.
    // Join to profiles twice (user_a and user_b) and resolve "the other user"
    // in JS below.
    supabase
      .from('friendships')
      .select(
        'user_a, user_b, ' +
          'profile_a:profiles!friendships_user_a_fkey(id, handle, first_name), ' +
          'profile_b:profiles!friendships_user_b_fkey(id, handle, first_name)'
      )
      .eq('status', 'accepted')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`),
    // Upcoming hangouts (group + direct), top 5 by proposed_start.
    // RLS already scopes these to ones the user participates in.
    supabase
      .from('hangouts')
      .select(
        'id, title, proposed_start, status, group_id, direct_user_id, ' +
          'groups(name), ' +
          'direct_user:profiles!hangouts_direct_user_id_fkey(handle, first_name), ' +
          'proposer:profiles!hangouts_proposed_by_fkey(id, handle, first_name)'
      )
      .in('status', ['proposing', 'confirmed'])
      .gte('proposed_start', nowIso)
      .order('proposed_start', { ascending: true })
      .limit(5),
    // Labelled places (home/work/gym…) — for "where" context + envelope humility.
    supabase
      .from('places')
      .select('name, user_label, category')
      .eq('user_id', userId)
      .eq('is_hidden', false)
      .not('category', 'is', null)
      .order('visit_count', { ascending: false })
      .limit(12),
    // This week at a glance: real occupied time incl. materialized routines +
    // transit. Window: earlier-today → +7 days. Including today's passed blocks
    // matters: "I overslept, adjust my schedule" needs the 8am gym's id to MOVE
    // it — if the list started at `now`, the agent couldn't see or move it.
    supabase
      .from('calendar_events')
      .select('id, title, start_at, end_at, event_type, is_movable, location')
      .eq('user_id', userId)
      .gte('start_at', new Date(Date.now() - 18 * 3600_000).toISOString())
      .lt('start_at', new Date(Date.now() + 7 * 86_400_000).toISOString())
      .order('start_at', { ascending: true })
      .limit(70),
    // Fused occurrence memory: what activities usually happen where (learned).
    supabase
      .from('activity_patterns')
      .select('activity_key, day_of_week, time_bucket, place_id, count, confidence, places(name, user_label)')
      .eq('user_id', userId)
      .gte('confidence', 0.5)
      .order('count', { ascending: false })
      .limit(30),
    // Recently acted-on change sets — so the agent knows what the user accepted
    // or declined (tapping the card leaves no chat message).
    supabase
      .from('change_sets')
      .select('reasoning, status, updated_at')
      .eq('user_id', userId)
      .in('status', ['accepted', 'rejected'])
      .gte('updated_at', new Date(Date.now() - 2 * 86_400_000).toISOString())
      .order('updated_at', { ascending: false })
      .limit(5),
    // Live activity status — current/just-passed blocks flagged late/skip/etc.
    supabase
      .from('activity_log')
      .select('live_status, scheduled_start, scheduled_end, calendar_events(title), places:predicted_place_id(user_label, name)')
      .eq('user_id', userId)
      .not('live_status', 'is', null)
      .neq('live_status', 'on_track')
      .gte('scheduled_end', new Date(Date.now() - 3 * 3600_000).toISOString())
      .order('scheduled_start', { ascending: false })
      .limit(4),
    // Pending reminders — so the agent can list/cancel them and avoid duplicates.
    supabase
      .from('reminders')
      .select('id, content, remind_at')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('remind_at', { ascending: true })
      .limit(10),
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
  const triggerMsg = triggerMsgRes.data as ChatRow | null;
  const behavioralSummary = (summaryRes.data as BehavioralSummaryRow | null) ?? null;
  const places: PlaceRow[] = (placesRes.data as PlaceRow[] | null) ?? [];
  const weekEvents: WeekEventRow[] = (weekEventsRes.data as WeekEventRow[] | null) ?? [];
  const patterns: PatternRow[] = (patternsRes.data as PatternRow[] | null) ?? [];
  const recentChanges: RecentChangeRow[] =
    (changeSetsRes.data as RecentChangeRow[] | null) ?? [];
  const liveStatuses: LiveStatusRow[] = (liveStatusRes.data as LiveStatusRow[] | null) ?? [];
  const reminders: ReminderRow[] = (remindersRes.data as ReminderRow[] | null) ?? [];

  // Friends: pick "the other" profile from each friendship row.
  type FriendshipJoinRow = {
    user_a: string;
    user_b: string;
    profile_a: { id: string; handle: string | null; first_name: string | null } | null;
    profile_b: { id: string; handle: string | null; first_name: string | null } | null;
  };
  const friends: FriendRow[] =
    ((friendsRes.data as FriendshipJoinRow[] | null) ?? [])
      .map((row) => (row.user_a === userId ? row.profile_b : row.profile_a))
      .filter((p): p is { id: string; handle: string | null; first_name: string | null } => !!p)
      .map((p) => ({ id: p.id, handle: p.handle, first_name: p.first_name }));

  // Upcoming hangouts: flatten the joins into a friendly shape.
  type UpcomingJoinRow = {
    id: string;
    title: string;
    proposed_start: string | null;
    status: string | null;
    group_id: string | null;
    direct_user_id: string | null;
    groups: { name: string } | null;
    direct_user: { handle: string | null; first_name: string | null } | null;
    proposer: { id: string; handle: string | null; first_name: string | null } | null;
  };
  const upcomingHangouts: UpcomingHangoutRow[] =
    ((upcomingHangoutsRes.data as UpcomingJoinRow[] | null) ?? []).map((h) => {
      if (h.group_id) {
        return {
          id: h.id,
          title: h.title,
          proposed_start: h.proposed_start,
          status: h.status,
          who_label: h.groups?.name ?? 'group',
          kind: 'group' as const,
        };
      }
      // Direct hangout. For the current user, the "who" is the OTHER party.
      // If proposer is me, show direct_user. If direct_user is me, show proposer.
      const otherIsDirect = h.proposer?.id === userId;
      const who =
        (otherIsDirect ? h.direct_user?.handle : h.proposer?.handle) ??
        (otherIsDirect ? h.direct_user?.first_name : h.proposer?.first_name) ??
        'friend';
      return {
        id: h.id,
        title: h.title,
        proposed_start: h.proposed_start,
        status: h.status,
        who_label: `@${who}`,
        kind: 'direct' as const,
      };
    });

  if (!triggerMsg || triggerMsg.role !== 'user') {
    return jsonRes({ error: 'Trigger message not found or not a user message' }, 404);
  }

  const { staticBlock, dynamicBlock } = buildSystemPromptBlocks({
    firstName: profile.first_name ?? 'friend',
    socialOpenness: profile.social_openness,
    timezone: profile.timezone ?? 'Europe/Ljubljana',
    goals,
    interests,
    groups,
    behavioralSummary,
    friends,
    upcomingHangouts,
    places,
    weekEvents,
    patterns,
    recentChanges,
    liveStatuses,
    reminders,
  });

  // Anthropic prompt caching: cache_control on the static block. The dynamic
  // block (current timestamp) follows uncached. On subsequent requests within
  // ~5 minutes with the same static block, the cached portion costs 10% of
  // normal — meaningful savings on chatty sessions.
  const systemArray = [
    {
      type: 'text' as const,
      text: staticBlock,
      cache_control: { type: 'ephemeral' as const },
    },
    {
      type: 'text' as const,
      text: dynamicBlock,
    },
  ];

  const messages: ClaudeMessage[] = toClaudeMessages(recentChat);

  // -------- agentic loop --------
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  const totalStart = Date.now();
  const toolsExecuted: Array<{ name: string; input: Record<string, unknown>; result: string; ok: boolean }> = [];
  let finalText = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemArray,
        tools: TOOLS,
        messages,
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Anthropic error:', claudeRes.status, errText);
      return jsonRes(
        { error: `Anthropic API error: ${claudeRes.status}`, detail: errText },
        502
      );
    }

    const claudeData = (await claudeRes.json()) as {
      content?: ContentBlock[];
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };

    totalInputTokens += claudeData.usage?.input_tokens ?? 0;
    totalOutputTokens += claudeData.usage?.output_tokens ?? 0;
    totalCacheCreationTokens += claudeData.usage?.cache_creation_input_tokens ?? 0;
    totalCacheReadTokens += claudeData.usage?.cache_read_input_tokens ?? 0;

    const blocks = claudeData.content ?? [];
    const textBlocks = blocks.filter((b): b is { type: 'text'; text: string } => b.type === 'text');
    const toolUseBlocks = blocks.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        b.type === 'tool_use'
    );

    finalText = textBlocks.map((b) => b.text).join('\n').trim();

    if (claudeData.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
      // Done — Claude is finished thinking.
      break;
    }

    // Execute each tool call and collect results.
    const toolResults: ContentBlock[] = [];
    const userTz = profile.timezone ?? 'Europe/Ljubljana';
    for (const tu of toolUseBlocks) {
      const result = await executeTool(
        supabase,
        userId,
        groups,
        friends,
        upcomingHangouts,
        userTz,
        tu.name,
        tu.input
      );
      toolsExecuted.push({ name: tu.name, input: tu.input, result: result.message, ok: result.ok });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.message,
        is_error: !result.ok,
      });
    }

    // Append assistant turn (verbatim) and our user turn with tool_results.
    messages.push({ role: 'assistant', content: blocks });
    messages.push({ role: 'user', content: toolResults });
  }

  // If the tool-round limit was hit mid-tool-use, Claude never produced a final
  // text turn — the user would see "(no response)" even though tools ran. Force
  // one last text-only turn so the user always gets told what happened.
  if (!finalText.trim()) {
    const finalRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemArray,
        tools: TOOLS,
        tool_choice: { type: 'none' },
        messages,
      }),
    });
    if (finalRes.ok) {
      const finalData = (await finalRes.json()) as {
        content?: ContentBlock[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      totalInputTokens += finalData.usage?.input_tokens ?? 0;
      totalOutputTokens += finalData.usage?.output_tokens ?? 0;
      finalText = (finalData.content ?? [])
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
    }
  }

  const totalLatency = Date.now() - totalStart;
  const { reply, extracted } = parseClaudeText(finalText);

  // -------- persist agent reply --------
  const { data: agentMsg, error: insertErr } = await supabase
    .from('chat_messages')
    .insert({
      user_id: userId,
      role: 'agent',
      content: reply || '(no response)',
      model: MODEL,
      input_tokens: totalInputTokens || null,
      output_tokens: totalOutputTokens || null,
      context_snapshot: {
        goals_count: goals.length,
        interests_count: interests.length,
        groups_count: groups.length,
        history_count: recentChat.length,
        latency_ms: totalLatency,
        tools_executed: toolsExecuted,
        cache_creation_tokens: totalCacheCreationTokens,
        cache_read_tokens: totalCacheReadTokens,
      },
      extracted_data: extracted.length > 0 ? extracted : null,
    })
    .select('id, content, created_at')
    .single();

  if (insertErr) {
    console.error('Failed to persist agent message:', insertErr);
    return jsonRes({ error: 'DB insert failed', detail: insertErr.message }, 500);
  }

  // -------- link change sets to this chat message --------
  // Any change_set the agent created via propose_change_set this turn needs its
  // chat_message_id set so the UI can render the proposal card next to the message.
  const newChangeSetIds: string[] = [];
  for (const t of toolsExecuted) {
    if (t.name === 'propose_change_set' && t.ok) {
      try {
        const parsed = JSON.parse(t.result) as { change_set_id?: string };
        if (parsed.change_set_id) newChangeSetIds.push(parsed.change_set_id);
      } catch { /* ignore */ }
    }
  }
  if (newChangeSetIds.length > 0 && agentMsg?.id) {
    const { error: linkErr } = await supabase
      .from('change_sets')
      .update({ chat_message_id: agentMsg.id, updated_at: new Date().toISOString() })
      .in('id', newChangeSetIds)
      .eq('user_id', userId);
    if (linkErr) console.warn('change_sets link failed:', linkErr.message);
  }

  // -------- persist extracted preferences --------
  if (extracted.length > 0) {
    const interestsToInsert = extracted.map((e) => ({
      user_id: userId,
      key: e.key,
      value: (e.value as object | string | number | boolean | null) ?? null,
      confidence: typeof e.confidence === 'number' ? e.confidence : 0.7,
      source: 'chat',
    }));
    const { error: intErr } = await supabase.from('interests').insert(interestsToInsert);
    if (intErr) console.warn('Failed to insert interests:', intErr);
  }

  return jsonRes(
    {
      success: true,
      message: agentMsg,
      extracted_count: extracted.length,
      tools_executed: toolsExecuted.length,
      latency_ms: totalLatency,
    },
    200
  );
});

// ---------- timezone helpers ----------------------------------------------
/**
 * Detect whether an ISO datetime string already carries a timezone suffix.
 * Matches `Z` or `+HH:MM` / `-HH:MM` (with or without the colon).
 */
function hasTimezoneSuffix(iso: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso.trim());
}

/**
 * Compute a timezone's UTC offset (in minutes) for a given instant.
 * E.g. for Europe/Ljubljana on 2026-07-15 → 120 (CEST = UTC+2).
 */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const o: Record<string, string> = {};
  for (const p of parts) o[p.type] = p.value;
  const asUtc = Date.UTC(
    +o.year,
    +o.month - 1,
    +o.day,
    +(o.hour === '24' ? '0' : o.hour),
    +o.minute,
    +o.second
  );
  return (asUtc - date.getTime()) / 60_000;
}

/**
 * Convert a naive ISO datetime ("2026-04-29T14:00:00") interpreted as
 * wall-clock time in `timezone`, into a UTC ISO string.
 */
function naiveLocalToUtcIso(naiveISO: string, timezone: string): string {
  const seed = new Date(naiveISO + (naiveISO.endsWith('Z') ? '' : 'Z'));
  const offsetMin = tzOffsetMinutes(seed, timezone);
  const realUtc = new Date(seed.getTime() - offsetMin * 60_000);
  return realUtc.toISOString();
}

/**
 * Normalize whatever Claude gave us into a valid UTC ISO string.
 *  - If the string carries Z or ±HH:MM → trust the offset, normalize via Date.
 *  - If the string is naive (no offset) → interpret it as local time in the
 *    user's timezone. This is almost always what they meant by "2pm tomorrow".
 *  - Returns null on unparseable input.
 */
function normalizeIsoToUtc(raw: string, userTimezone: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    if (hasTimezoneSuffix(trimmed)) {
      const d = new Date(trimmed);
      if (isNaN(d.getTime())) return null;
      return d.toISOString();
    }
    return naiveLocalToUtcIso(trimmed, userTimezone);
  } catch {
    return null;
  }
}

// ---------- slot finder (inlined from _shared/calendar.ts) ----------------
type CalendarEventLite = {
  id: string;
  start_at: string;
  end_at: string;
  title: string | null;
  event_type: string | null;
  is_movable: boolean;
};
type SlotConflictKind = 'none' | 'flexible' | 'fixed';
type Slot = {
  start_at: string;
  end_at: string;
  conflict: SlotConflictKind;
  conflicting_events: CalendarEventLite[];
  score: number;
};
type TimePreference = 'morning' | 'afternoon' | 'evening' | 'any';

function _localHour(utcMs: number, timezone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', hour12: false,
  });
  const h = parseInt(dtf.format(new Date(utcMs)), 10);
  return Number.isFinite(h) ? h : 0;
}
function _prefScore(localStartHour: number, pref: TimePreference): number {
  switch (pref) {
    case 'morning':
      if (localStartHour >= 6 && localStartHour < 11) return 1.0;
      if (localStartHour >= 11 && localStartHour < 13) return 0.6;
      return 0.2;
    case 'afternoon':
      if (localStartHour >= 13 && localStartHour < 17) return 1.0;
      if (localStartHour >= 11 && localStartHour < 13) return 0.7;
      if (localStartHour >= 17 && localStartHour < 19) return 0.7;
      return 0.2;
    case 'evening':
      if (localStartHour >= 18 && localStartHour < 22) return 1.0;
      if (localStartHour >= 17 && localStartHour < 18) return 0.7;
      if (localStartHour >= 22 && localStartHour < 24) return 0.6;
      return 0.2;
    default: return 1.0;
  }
}
function _overlap(events: CalendarEventLite[], startMs: number, endMs: number): CalendarEventLite[] {
  return events.filter((ev) => {
    const s = new Date(ev.start_at).getTime();
    const e = new Date(ev.end_at).getTime();
    return s < endMs && e > startMs;
  });
}
function findOpenSlots(args: {
  events: CalendarEventLite[];
  earliest: string; latest: string;
  duration_minutes: number;
  user_timezone: string;
  time_preference?: TimePreference;
  step_minutes?: number;
  max_results?: number;
  earliest_hour?: number;
  latest_hour?: number;
}): Slot[] {
  const {
    events, earliest, latest, duration_minutes, user_timezone,
    time_preference = 'any', step_minutes = 30, max_results = 5,
    earliest_hour = 8, latest_hour = 22,
  } = args;
  const earliestMs = new Date(earliest).getTime();
  const latestMs = new Date(latest).getTime();
  const stepMs = step_minutes * 60_000;
  const durationMs = duration_minutes * 60_000;
  if (latestMs - earliestMs < durationMs) return [];
  const candidates: Slot[] = [];
  for (let s = earliestMs; s + durationMs <= latestMs; s += stepMs) {
    const e = s + durationMs;
    const hr = _localHour(s, user_timezone);
    if (hr < earliest_hour || hr > latest_hour) continue;
    const conflicts = _overlap(events, s, e);
    const kind: SlotConflictKind = conflicts.length === 0
      ? 'none'
      : conflicts.some((c) => !c.is_movable) ? 'fixed' : 'flexible';
    if (kind === 'fixed') continue;
    const pref = _prefScore(hr, time_preference);
    if (pref === 0) continue;
    const base = kind === 'none' ? 1.0 : 0.5;
    candidates.push({
      start_at: new Date(s).toISOString(),
      end_at: new Date(e).toISOString(),
      conflict: kind,
      conflicting_events: kind === 'none' ? [] : conflicts,
      score: base * pref,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked: Slot[] = [];
  for (const c of candidates) {
    const cs = new Date(c.start_at).getTime();
    const tooClose = picked.some((p) => Math.abs(new Date(p.start_at).getTime() - cs) < durationMs);
    if (!tooClose) picked.push(c);
    if (picked.length >= max_results) break;
  }
  return picked;
}

// ---------- tool execution ------------------------------------------------
async function executeTool(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  userGroups: GroupRow[],
  userFriends: FriendRow[],
  upcomingHangouts: UpcomingHangoutRow[],
  userTimezone: string,
  name: string,
  input: Record<string, unknown>
): Promise<{ ok: boolean; message: string }> {
  if (name === 'propose_hangout') {
    const groupId = input.group_id ? String(input.group_id) : '';
    const directHandle = input.direct_friend_handle
      ? String(input.direct_friend_handle).replace(/^@/, '').toLowerCase()
      : '';
    const title = String(input.title ?? '').trim();
    const proposedStartRaw = String(input.proposed_start ?? '');
    const reasoning = String(input.reasoning ?? '').trim();
    const description = input.description ? String(input.description) : null;
    const proposedEndRaw = input.proposed_end ? String(input.proposed_end) : null;
    const venueName = input.venue_name ? String(input.venue_name) : null;
    const venueAddress = input.venue_address ? String(input.venue_address) : null;
    const minAttendees =
      typeof input.min_attendees === 'number' && Number.isFinite(input.min_attendees)
        ? Math.max(1, Math.floor(input.min_attendees))
        : null;

    // Exactly one of group_id / direct_friend_handle
    if (!!groupId === !!directHandle) {
      return {
        ok: false,
        message:
          'Provide exactly one of group_id (for group hangouts) or direct_friend_handle (for 1-on-1). Not both, not neither.',
      };
    }
    if (!title) return { ok: false, message: 'title is required' };
    if (!proposedStartRaw) return { ok: false, message: 'proposed_start is required' };
    if (!reasoning) return { ok: false, message: 'reasoning is required' };

    const proposedStart = normalizeIsoToUtc(proposedStartRaw, userTimezone);
    if (!proposedStart) {
      return {
        ok: false,
        message: `proposed_start "${proposedStartRaw}" is not parseable as ISO 8601`,
      };
    }
    const proposedEnd = proposedEndRaw
      ? normalizeIsoToUtc(proposedEndRaw, userTimezone)
      : null;

    // -- Direct hangout path --
    if (directHandle) {
      const friend = userFriends.find(
        (f) => (f.handle ?? '').toLowerCase() === directHandle
      );
      if (!friend) {
        return {
          ok: false,
          message: `@${directHandle} is not in the user's friends list. Either ask the user to add them first, or check that you used the right handle.`,
        };
      }
      const { data, error } = await supabase.rpc('propose_direct_hangout', {
        _direct_user_id: friend.id,
        _title: title,
        _proposed_start: proposedStart,
        _reasoning: reasoning,
        _description: description,
        _proposed_end: proposedEnd,
        _venue_name: venueName,
        _venue_address: venueAddress,
      });
      if (error) {
        return { ok: false, message: `Failed to create direct hangout: ${error.message}` };
      }
      return {
        ok: true,
        message: `Direct hangout created (id: ${data}) with @${friend.handle ?? '?'}. You're auto-confirmed; they see it as pending until they respond.`,
      };
    }

    // -- Group hangout path --
    if (!userGroups.some((g) => g.id === groupId)) {
      return {
        ok: false,
        message: `Group ${groupId} not found in user's groups. Ask the user which group they meant.`,
      };
    }
    const { data, error } = await supabase.rpc('propose_hangout', {
      _group_id: groupId,
      _title: title,
      _proposed_start: proposedStart,
      _reasoning: reasoning,
      _description: description,
      _proposed_end: proposedEnd,
      _venue_name: venueName,
      _venue_address: venueAddress,
      _min_attendees: minAttendees,
    });

    if (error) {
      return { ok: false, message: `Failed to create hangout: ${error.message}` };
    }

    const groupName = userGroups.find((g) => g.id === groupId)?.name ?? 'the group';
    return {
      ok: true,
      message: `Hangout created (id: ${data}). Group "${groupName}" members notified. You're auto-confirmed; the hangout flips to CONFIRMED once enough members are in.`,
    };
  }

  if (name === 'find_mutual_slots') {
    const handlesRaw = Array.isArray(input.participant_handles)
      ? input.participant_handles
      : [];
    const duration = Number(input.duration_minutes);
    const earliestRaw = String(input.earliest ?? '');
    const latestRaw = String(input.latest ?? '');
    const timePref = String(input.time_preference ?? 'any') as TimePreference;
    const minFreeCountRaw = input.min_free_count;
    const minFreeCount =
      typeof minFreeCountRaw === 'number' && Number.isFinite(minFreeCountRaw)
        ? Math.max(1, Math.floor(minFreeCountRaw))
        : null;

    if (!Number.isFinite(duration) || duration <= 0) {
      return { ok: false, message: 'duration_minutes must be a positive number' };
    }
    const earliest = normalizeIsoToUtc(earliestRaw, userTimezone);
    const latest = normalizeIsoToUtc(latestRaw, userTimezone);
    if (!earliest || !latest) {
      return { ok: false, message: 'earliest/latest must be ISO 8601 datetimes' };
    }

    // Resolve handles → user_ids. Reject any unknown handles.
    const userIds: string[] = [];
    const unknown: string[] = [];
    for (const raw of handlesRaw) {
      const h = String(raw).replace(/^@/, '').toLowerCase().trim();
      if (!h) continue;
      const f = userFriends.find((fr) => (fr.handle ?? '').toLowerCase() === h);
      if (f) {
        userIds.push(f.id);
      } else {
        unknown.push(h);
      }
    }
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `Unknown handle(s): ${unknown.map((h) => '@' + h).join(', ')}. Pick from the Friends list in the system prompt.`,
      };
    }

    const { data, error } = await supabase.rpc('find_mutual_slots', {
      _user_ids: userIds,
      _earliest: earliest,
      _latest: latest,
      _duration_minutes: duration,
      _time_preference: timePref,
      _min_free_count: minFreeCount,
    });
    if (error) {
      return { ok: false, message: `find_mutual_slots failed: ${error.message}` };
    }

    // Resolve busy_user_ids back to handles for the model. The agent thinks
    // in handles, not uuids.
    type SlotRow = {
      start_at: string;
      end_at: string;
      score: number;
      free_count: number;
      total_count: number;
      busy_user_ids: string[];
    };
    const rows = (data ?? []) as SlotRow[];
    const idToHandle = new Map<string, string>(
      userFriends.map((f) => [f.id, f.handle ?? '?'])
    );
    const enriched = rows.map((s) => ({
      start_at: s.start_at,
      end_at: s.end_at,
      score: s.score,
      free_count: s.free_count,
      total_count: s.total_count,
      busy_handles: (s.busy_user_ids ?? []).map((id) => idToHandle.get(id) ?? id),
    }));

    return {
      ok: true,
      message: JSON.stringify({
        participant_count: userIds.length + 1,
        mode: minFreeCount === null ? 'strict' : `threshold (min ${minFreeCount} free)`,
        slots: enriched,
      }),
    };
  }

  if (name === 'cancel_hangout') {
    const hangoutId = String(input.hangout_id ?? '').trim();
    if (!hangoutId) return { ok: false, message: 'hangout_id is required' };

    // Soft check: must be in upcoming list (the RPC will also enforce auth).
    const known = upcomingHangouts.find((h) => h.id === hangoutId);
    if (!known) {
      return {
        ok: false,
        message: `hangout_id ${hangoutId} not in user's upcoming hangouts. Double-check the id.`,
      };
    }
    const { error } = await supabase.rpc('cancel_hangout', { _hangout_id: hangoutId });
    if (error) {
      return { ok: false, message: `cancel_hangout failed: ${error.message}` };
    }
    return {
      ok: true,
      message: `Cancelled "${known.title}" (${known.who_label}). Other participants are notified via realtime sync.`,
    };
  }

  if (name === 'update_hangout') {
    const hangoutId = String(input.hangout_id ?? '').trim();
    if (!hangoutId) return { ok: false, message: 'hangout_id is required' };

    const known = upcomingHangouts.find((h) => h.id === hangoutId);
    if (!known) {
      return {
        ok: false,
        message: `hangout_id ${hangoutId} not in user's upcoming hangouts.`,
      };
    }

    const newStartRaw = input.new_start ? String(input.new_start) : null;
    const newEndRaw = input.new_end ? String(input.new_end) : null;
    const newTitle = input.new_title ? String(input.new_title) : null;
    const newVenueName = input.new_venue_name ? String(input.new_venue_name) : null;
    const newVenueAddr = input.new_venue_address ? String(input.new_venue_address) : null;
    const newDescription = input.new_description ? String(input.new_description) : null;

    const newStart = newStartRaw ? normalizeIsoToUtc(newStartRaw, userTimezone) : null;
    const newEnd = newEndRaw ? normalizeIsoToUtc(newEndRaw, userTimezone) : null;
    if (newStartRaw && !newStart) {
      return { ok: false, message: `new_start "${newStartRaw}" not parseable as ISO 8601` };
    }
    if (newEndRaw && !newEnd) {
      return { ok: false, message: `new_end "${newEndRaw}" not parseable as ISO 8601` };
    }

    if (!newStart && !newEnd && !newTitle && !newVenueName && !newVenueAddr && !newDescription) {
      return { ok: false, message: 'no fields to update — provide at least one' };
    }

    const { error } = await supabase.rpc('update_hangout', {
      _hangout_id: hangoutId,
      _new_start: newStart,
      _new_end: newEnd,
      _new_title: newTitle,
      _new_venue_name: newVenueName,
      _new_venue_addr: newVenueAddr,
      _new_description: newDescription,
    });
    if (error) {
      return { ok: false, message: `update_hangout failed: ${error.message}` };
    }
    const timeChanged = !!(newStart || newEnd);
    return {
      ok: true,
      message: timeChanged
        ? `Updated "${known.title}". Time changed → other participants' RSVPs were reset to pending; they need to reconfirm.`
        : `Updated "${known.title}".`,
    };
  }

  if (name === 'find_open_slots') {
    const duration = Number(input.duration_minutes);
    const earliestRaw = String(input.earliest ?? '');
    const latestRaw = String(input.latest ?? '');
    const timePref = String(input.time_preference ?? 'any') as TimePreference;

    if (!Number.isFinite(duration) || duration <= 0) {
      return { ok: false, message: 'duration_minutes must be a positive number' };
    }
    const earliest = normalizeIsoToUtc(earliestRaw, userTimezone);
    const latest   = normalizeIsoToUtc(latestRaw,   userTimezone);
    if (!earliest || !latest) {
      return { ok: false, message: 'earliest/latest must be ISO 8601 datetimes' };
    }

    const { data: events, error } = await supabase
      .from('calendar_events')
      .select('id, title, start_at, end_at, event_type, is_movable')
      .eq('user_id', userId)
      .gte('end_at', earliest)
      .lte('start_at', latest)
      .order('start_at', { ascending: true });

    if (error) {
      return { ok: false, message: `failed to load calendar: ${error.message}` };
    }

    const slots = findOpenSlots({
      events: (events ?? []) as CalendarEventLite[],
      earliest, latest,
      duration_minutes: duration,
      user_timezone: userTimezone,
      time_preference: timePref,
    });

    // Compact for the model — keep only what it needs to reason
    const compact = slots.map((s) => ({
      start_at: s.start_at,
      end_at: s.end_at,
      conflict: s.conflict,
      conflicting_events: s.conflicting_events.map((e) => ({
        id: e.id, title: e.title, start_at: e.start_at, end_at: e.end_at,
        event_type: e.event_type, is_movable: e.is_movable,
      })),
    }));

    return {
      ok: true,
      message: JSON.stringify({ count: compact.length, slots: compact }),
    };
  }

  if (name === 'propose_change_set') {
    const summary = String(input.summary_for_user ?? '').trim();
    const operationsRaw = Array.isArray(input.operations) ? input.operations : [];

    if (!summary) {
      return { ok: false, message: 'summary_for_user is required' };
    }
    if (operationsRaw.length === 0) {
      return { ok: false, message: 'at least one operation is required' };
    }
    if (operationsRaw.length > 12) {
      return { ok: false, message: 'too many operations in one change set (max 12)' };
    }

    // Validate + normalize each op. We keep all string times in UTC after this.
    const normalized: Record<string, unknown>[] = [];
    for (const rawOp of operationsRaw) {
      if (!rawOp || typeof rawOp !== 'object') {
        return { ok: false, message: 'each operation must be an object' };
      }
      const op = rawOp as Record<string, unknown>;
      const kind = String(op.op ?? '');

      if (kind === 'move') {
        const eventId = String(op.event_id ?? '');
        const newStartRaw = String(op.new_start ?? '');
        const newEndRaw   = String(op.new_end   ?? '');
        if (!eventId) return { ok: false, message: 'move op missing event_id' };
        const newStart = normalizeIsoToUtc(newStartRaw, userTimezone);
        const newEnd   = normalizeIsoToUtc(newEndRaw,   userTimezone);
        if (!newStart || !newEnd) {
          return { ok: false, message: `move op times unparseable: ${newStartRaw} / ${newEndRaw}` };
        }
        // Preflight: event must exist, belong to user, and be movable.
        const { data: ev, error: evErr } = await supabase
          .from('calendar_events')
          .select('id, user_id, is_movable, title')
          .eq('id', eventId)
          .maybeSingle();
        if (evErr || !ev) {
          return { ok: false, message: `move target ${eventId} not found` };
        }
        if (ev.user_id !== userId) {
          return { ok: false, message: 'cannot move another user\'s event' };
        }
        if (!ev.is_movable) {
          return { ok: false, message: `event "${ev.title}" is not movable (event_type='fixed' or 'coordinated')` };
        }
        normalized.push({
          op: 'move',
          event_id: eventId,
          new_start: newStart,
          new_end: newEnd,
          reasoning: op.reasoning ? String(op.reasoning) : undefined,
        });
      } else if (kind === 'create') {
        const title = String(op.title ?? '').trim();
        const startRaw = String(op.start_at ?? '');
        const endRaw   = String(op.end_at   ?? '');
        const evTypeRaw = String(op.event_type ?? 'flexible');
        if (!title) return { ok: false, message: 'create op missing title' };
        const startAt = normalizeIsoToUtc(startRaw, userTimezone);
        const endAt   = normalizeIsoToUtc(endRaw,   userTimezone);
        if (!startAt || !endAt) {
          return { ok: false, message: `create op times unparseable: ${startRaw} / ${endRaw}` };
        }
        // For v1 the agent can only create user-side blocks. 'fixed' and
        // 'coordinated' come from external systems / hangouts, not from
        // free-form proposals.
        const evType = (evTypeRaw === 'goal' || evTypeRaw === 'flexible') ? evTypeRaw : 'flexible';
        normalized.push({
          op: 'create',
          title,
          start_at: startAt,
          end_at: endAt,
          event_type: evType,
          description: op.description ? String(op.description) : null,
          location: op.location ? String(op.location) : null,
          hangout_id: op.hangout_id ? String(op.hangout_id) : null,
          goal_id: op.goal_id ? String(op.goal_id) : null,
          reasoning: op.reasoning ? String(op.reasoning) : undefined,
        });
      } else {
        return { ok: false, message: `unknown op: ${kind} (must be 'move' or 'create')` };
      }
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('change_sets')
      .insert({
        user_id: userId,
        operations: normalized,
        reasoning: summary,
        status: 'pending',
      })
      .select('id, expires_at')
      .single();

    if (insertErr || !inserted) {
      return { ok: false, message: `failed to persist change set: ${insertErr?.message ?? 'unknown'}` };
    }

    // Apply-immediately mode: the user explicitly asked for THIS exact change, so
    // skip the confirmation card and apply it now. (Autonomous reorganizes leave
    // it pending → the user gets a card.)
    if (input.apply === true) {
      const { error: applyErr } = await supabase.rpc('apply_change_set', { _id: inserted.id });
      if (applyErr) {
        // Fall back to a pending proposal so nothing is lost.
        return {
          ok: true,
          message: JSON.stringify({
            change_set_id: inserted.id,
            operations_count: normalized.length,
            applied: false,
            note: `could not auto-apply (${applyErr.message}); left as a proposal card`,
          }),
        };
      }
      return {
        ok: true,
        message: JSON.stringify({
          change_set_id: inserted.id,
          operations_count: normalized.length,
          applied: true,
          note: 'Applied directly (user-requested) — no card needed; confirm in your reply.',
        }),
      };
    }

    return {
      ok: true,
      message: JSON.stringify({
        change_set_id: inserted.id,
        operations_count: normalized.length,
        expires_at: inserted.expires_at,
      }),
    };
  }

  if (name === 'set_reminder') {
    const content = String(input.content ?? '').trim();
    const remindAtRaw = String(input.remind_at ?? '');
    if (!content) return { ok: false, message: 'content is required' };
    const remindAt = normalizeIsoToUtc(remindAtRaw, userTimezone);
    if (!remindAt) return { ok: false, message: `remind_at "${remindAtRaw}" is not parseable as ISO 8601` };
    if (new Date(remindAt).getTime() < Date.now() - 60_000) {
      return { ok: false, message: 'remind_at is in the past — double-check the date table' };
    }
    const { data, error } = await supabase
      .from('reminders')
      .insert({ user_id: userId, content, remind_at: remindAt })
      .select('id')
      .single();
    if (error || !data) return { ok: false, message: `failed to set reminder: ${error?.message ?? 'unknown'}` };
    return { ok: true, message: `Reminder set (id: ${data.id}). It fires as a push at the requested time.` };
  }

  if (name === 'cancel_reminder') {
    const id = String(input.reminder_id ?? '');
    if (!id) return { ok: false, message: 'reminder_id is required' };
    const { data, error } = await supabase
      .from('reminders')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'pending')
      .select('id');
    if (error) return { ok: false, message: `failed to cancel: ${error.message}` };
    if (!data || data.length === 0) return { ok: false, message: 'no pending reminder with that id' };
    return { ok: true, message: 'Reminder cancelled.' };
  }

  if (name === 'send_calendar_invite') {
    const title = String(input.title ?? '').trim();
    const start = normalizeIsoToUtc(String(input.start ?? ''), userTimezone);
    const end = normalizeIsoToUtc(String(input.end ?? ''), userTimezone);
    const emails = Array.isArray(input.attendee_emails)
      ? (input.attendee_emails as unknown[]).map((e) => String(e).trim()).filter(Boolean)
      : [];
    const location = input.location ? String(input.location).trim() : null;
    const description = input.description ? String(input.description).trim() : null;
    if (!title) return { ok: false, message: 'title is required' };
    if (!start || !end) return { ok: false, message: 'start and end must be valid ISO 8601 (check the date table)' };
    if (emails.length === 0) return { ok: false, message: 'at least one attendee email is required' };

    const { data, error } = await supabase.functions.invoke('google-calendar-write', {
      body: { op: 'create_event', title, start, end, attendee_emails: emails, location, description },
    });
    if (error) {
      return { ok: false, message: `Could not create the invite: ${error.message}. If this looks like a permissions problem, ask the user to reconnect Google Calendar (with write access) in the You tab.` };
    }
    if (data && typeof data === 'object' && 'error' in data) {
      const code = (data as { code?: string }).code;
      if (code === 'insufficient_scope' || code === 'no_connection') {
        return { ok: false, message: 'Google Calendar needs reconnecting WITH write permission. Tell the user to open the You tab and reconnect Google Calendar.' };
      }
      return { ok: false, message: `Invite failed: ${String((data as { error: string }).error)}` };
    }
    const googleId =
      data && typeof data === 'object' && 'id' in data ? String((data as { id: string }).id) : null;

    // Mirror as an ALINE-origin row so it shows on My Week immediately. The
    // google_synced_at stamp keeps the sync push step from re-creating/re-PATCHing it.
    if (googleId) {
      await supabase.from('calendar_events').insert({
        user_id: userId,
        source: 'aline',
        external_id: googleId,
        event_type: 'fixed',
        title,
        description,
        location,
        start_at: start,
        end_at: end,
        google_synced_at: new Date().toISOString(),
      });
    }
    return {
      ok: true,
      message: `Invite created and emailed to ${emails.join(', ')}; it's on the user's calendar too.`,
    };
  }

  if (name === 'get_weather') {
    if (!OPENWEATHER_API_KEY) {
      return { ok: false, message: 'Weather is not configured (OPENWEATHER_API_KEY missing).' };
    }
    // Resolve coords: Home place centroid → any place centroid → latest ping.
    let lat: number | null = null;
    let lon: number | null = null;
    const { data: homePlace } = await supabase
      .from('places')
      .select('centroid_lat, centroid_lon, category, user_label')
      .eq('user_id', userId)
      .not('centroid_lat', 'is', null)
      .or('category.eq.home,user_label.ilike.home')
      .limit(1)
      .maybeSingle();
    if (homePlace?.centroid_lat != null) {
      lat = homePlace.centroid_lat; lon = homePlace.centroid_lon;
    } else {
      const { data: anyPlace } = await supabase
        .from('places')
        .select('centroid_lat, centroid_lon')
        .eq('user_id', userId)
        .not('centroid_lat', 'is', null)
        .order('visit_count', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (anyPlace?.centroid_lat != null) {
        lat = anyPlace.centroid_lat; lon = anyPlace.centroid_lon;
      } else {
        const { data: ping } = await supabase
          .from('behavioral_pings')
          .select('geohash_8')
          .eq('user_id', userId)
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (ping?.geohash_8) {
          const c = decodeGeohashLite(ping.geohash_8);
          lat = c.lat; lon = c.lon;
        }
      }
    }
    if (lat == null || lon == null) {
      return { ok: false, message: 'No location known yet — cannot fetch a local forecast.' };
    }

    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${OPENWEATHER_API_KEY}`,
    );
    if (!res.ok) {
      return { ok: false, message: `Weather API error ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    const data = (await res.json()) as {
      list?: Array<{
        dt: number;
        main?: { temp?: number };
        weather?: Array<{ description?: string }>;
        pop?: number;
        wind?: { speed?: number };
      }>;
    };

    const wantedDate = input.date ? String(input.date) : null;
    const horizonMs = Date.now() + 26 * 3600_000;
    const lines: string[] = [];
    for (const step of data.list ?? []) {
      const when = new Date(step.dt * 1000);
      const localDate = when.toLocaleDateString('en-CA', { timeZone: userTimezone });
      if (wantedDate ? localDate !== wantedDate : when.getTime() > horizonMs) continue;
      const hh = when.toLocaleTimeString('en-US', {
        timeZone: userTimezone, hour: '2-digit', minute: '2-digit', hour12: false,
      });
      lines.push(
        `${localDate} ${hh}: ${Math.round(step.main?.temp ?? 0)}°C, ${
          step.weather?.[0]?.description ?? '?'
        }, rain ${Math.round((step.pop ?? 0) * 100)}%, wind ${Math.round(step.wind?.speed ?? 0)} m/s`,
      );
    }
    if (lines.length === 0) {
      return { ok: false, message: 'No forecast data for that date (forecast covers ~5 days ahead).' };
    }
    return { ok: true, message: `Forecast near home (3h steps):\n${lines.join('\n')}` };
  }

  return { ok: false, message: `Unknown tool: ${name}` };
}

// Compact geohash decoder (cell center) — same scheme as resolve-places.
function decodeGeohashLite(hash: string): { lat: number; lon: number } {
  const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let evenBit = true;
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  for (const ch of hash) {
    const idx = B32.indexOf(ch);
    if (idx < 0) break;
    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1;
      if (evenBit) {
        const mid = (lonMin + lonMax) / 2;
        if (bit === 1) lonMin = mid; else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit === 1) latMin = mid; else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}

// ---------- helpers -------------------------------------------------------
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function toClaudeMessages(rows: ChatRow[]): ClaudeMessage[] {
  const out: ClaudeMessage[] = [];
  for (const row of rows) {
    if (row.role === 'system') continue;
    const claudeRole: 'user' | 'assistant' = row.role === 'user' ? 'user' : 'assistant';
    // Prefix each message with its date so the model can tell stale "today /
    // tomorrow" references (sent weeks ago) from current ones.
    const tag = row.created_at ? `[${row.created_at.slice(0, 10)}] ` : '';
    const text = tag + row.content;
    const last = out[out.length - 1];
    if (last && last.role === claudeRole && typeof last.content === 'string') {
      last.content += '\n\n' + text;
    } else {
      out.push({ role: claudeRole, content: text });
    }
  }
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}
