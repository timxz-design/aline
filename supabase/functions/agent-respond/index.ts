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
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
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
  calendar. NEVER write to the calendar another way. User sees Accept/Reject
  card. Compose changes atomically: if making dinner requires moving a gym
  block, both go in the SAME change set. Summary_for_user is what the user
  reads first — keep it conversational ("Move your Wed gym to Thu so dinner
  with Marko fits Wed evening").

  Bundling rule: when proposing a group hangout that also needs a calendar
  block, call propose_hangout FIRST to get the hangout id, then include a
  'create' op in the change set with the hangout_id linked.

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

Behavioral profile (learned from observed routines, data quality: ${behavioralSummary?.data_quality ?? 'none'}):
${behavioralSummary?.archetype_text ?? 'Not yet enough data — keep tracking, the picture will fill in.'}

Note: place labels (Home, Work, etc.) are inferred from GPS patterns and Google Places — they are educated guesses, not confirmed facts. Treat them with appropriate humility. If ${firstName} mentions a place, check your assumption ("I think that's your gym — is that right?") rather than stating it as fact.

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
  const dynamicBlock =
    `Now (UTC): ${now.toISOString()}\n` +
    `Now (${timezone}): ${localDateTime}\n` +
    `Today (in user's local time): ${localDate}\n` +
    `When you say "today" or "tomorrow", reason from the user's LOCAL date above, not UTC.`;

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
      .select('archetype_text, data_quality')
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
    if (operationsRaw.length > 5) {
      return { ok: false, message: 'too many operations in one change set (max 5)' };
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

    return {
      ok: true,
      message: JSON.stringify({
        change_set_id: inserted.id,
        operations_count: normalized.length,
        expires_at: inserted.expires_at,
      }),
    };
  }

  return { ok: false, message: `Unknown tool: ${name}` };
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
    const last = out[out.length - 1];
    if (last && last.role === claudeRole && typeof last.content === 'string') {
      last.content += '\n\n' + row.content;
    } else {
      out.push({ role: claudeRole, content: row.content });
    }
  }
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}
