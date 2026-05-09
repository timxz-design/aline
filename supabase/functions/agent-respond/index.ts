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
      "Propose a hangout for one of the user's groups. All group members will see the proposal in their app and can confirm/decline. Use this when the user asks to plan, organize, or coordinate something with their group. Don't use it for casual mentions — only when they actually want to make plans.",
    input_schema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description:
            "UUID of the group. MUST be one of the user's group IDs listed in the system prompt.",
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
      required: ['group_id', 'title', 'proposed_start', 'reasoning'],
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
}): { staticBlock: string; dynamicBlock: string } {
  const { firstName, socialOpenness, timezone, goals, interests, groups, behavioralSummary } = input;

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

- **propose_hangout** — Use this to actually create a hangout proposal in one
  of ${firstName}'s groups. Only call it when ${firstName} explicitly wants to
  plan something. After calling it, you'll get a tool_result confirming it
  worked, then write your final reply.

  When picking a time: prefer evenings (18:00-20:00 local) for casual hangs,
  late afternoon for activities. Use ISO 8601 with the user's timezone offset.
  Always provide concrete reasoning ("Thursday works best — most of the week
  is open and Friday plans are hard to confirm last-minute").

  When picking min_attendees: think about the activity. A casual coffee can
  happen with 2 people. A party flops with 3. A movie night needs 3+. A study
  session works with 2 if both want to study. If you're unsure, omit it — the
  default is sensible (everyone for groups of 3-, half+1 for medium, half for
  big groups). If ${firstName} hints at how many they want ("only if 5+ are
  in"), use that number.

  If you don't know which group, ASK ${firstName} which one before calling
  the tool. Don't guess if there are multiple groups.

- **find_open_slots** — Read-only. Use this to figure out where things could
  fit in ${firstName}'s calendar. Returns a ranked list. Each slot is
  'none' (genuinely free), 'flexible' (a movable block sits there but can be
  shuffled), or filtered out entirely if blocked by a fixed event. ALWAYS
  call this before proposing calendar changes — never guess at availability.

- **propose_change_set** — Use this to actually move things around or add
  things to ${firstName}'s calendar. NEVER write to the calendar another
  way. The user sees a card with Accept/Reject buttons; only after they tap
  Accept does anything actually happen.

  Compose change sets atomically: if making dinner with a friend requires
  moving a gym block, both ops go in the SAME change set. Don't propose half
  a plan. The summary_for_user is what the user reads first — make it
  conversational and clear ("Move your Wed gym to Thu so dinner with Marko
  fits Wed evening").

  Bundling rule: when the change includes hanging out with friends (a
  group hangout), call propose_hangout FIRST to get the hangout id, then
  include a 'create' op in the change set so the corresponding calendar
  block also lands. The user accepts the calendar side; the friends still
  see and confirm the hangout via their own apps.

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

Active goals:
${goalLines}

Known preferences:
${interestLines}

Their groups (USE THE EXACT id WHEN CALLING propose_hangout):
${groupLines}

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
  const dynamicBlock = `Now (UTC): ${now.toISOString()}`;

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
  const [
    profileRes,
    goalsRes,
    interestsRes,
    groupsRes,
    chatRes,
    triggerMsgRes,
    summaryRes,
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
      const result = await executeTool(supabase, userId, groups, userTz, tu.name, tu.input);
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
  userTimezone: string,
  name: string,
  input: Record<string, unknown>
): Promise<{ ok: boolean; message: string }> {
  if (name === 'propose_hangout') {
    const groupId = String(input.group_id ?? '');
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

    if (!userGroups.some((g) => g.id === groupId)) {
      return {
        ok: false,
        message: `Group ${groupId} not found in user's groups. Ask the user which group they meant.`,
      };
    }
    if (!title) return { ok: false, message: 'title is required' };
    if (!proposedStartRaw) return { ok: false, message: 'proposed_start is required' };
    if (!reasoning) return { ok: false, message: 'reasoning is required' };

    // Normalize timestamps. If Claude gave a naive datetime (no offset), we
    // interpret it as local time in the user's timezone — almost always what
    // they meant by "tomorrow at 2pm".
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
