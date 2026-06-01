/**
 * morning-push — Supabase Edge Function
 * ----------------------------------------------------------------------------
 * Runs hourly via pg_cron (`0 * * * *`). For every authenticated user where:
 *   - push_notifications_enabled = true
 *   - expo_push_token is not null
 *   - it's currently 8am in their local timezone
 *   - we haven't already pushed today (last_morning_push_at < start_of_local_day)
 *
 * Sends a "Good morning, {firstName}" push with one of three template bodies,
 * picked by what their day looks like:
 *   1. Has ≥1 event today  → "{N} on your plate today. Tap to look at it / shuffle / cancel anything."
 *   2. Has 0 events        → "Light day ahead. Want to make plans with someone?"
 *   3. Has ≥1 pending RSVP → "{N} pending. {first hangout title} needs your call."
 *
 * The push routes the user to the Week tab (data.type='morning_push'), where
 * the MorningPanel renders the same plan in-app.
 *
 * Authorization: deployed with the default JWT verification on. pg_cron calls
 * this with the service role key in the Authorization header. The Supabase
 * Edge Runtime verifies the JWT before the handler runs; the handler itself
 * additionally requires the caller's role to be 'service_role' so a normal
 * user JWT cannot trigger mass pushes.
 * ----------------------------------------------------------------------------
 */

// @ts-expect-error — Deno-only deps; this file runs in Supabase Edge Runtime.
import { createClient } from 'jsr:@supabase/supabase-js@2';

// @ts-expect-error
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// @ts-expect-error
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const TARGET_LOCAL_HOUR = 8; // 8am local

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Profile = {
  id: string;
  first_name: string | null;
  timezone: string | null;
  last_morning_push_at: string | null;
};

type Hangout = {
  id: string;
  title: string;
  proposed_start: string | null;
};

type CalendarEvent = {
  id: string;
  title: string | null;
  start_at: string;
};

// ---------- helpers --------------------------------------------------------

/** Returns hour (0-23) for `now` in IANA `timezone`. */
function localHour(now: Date, timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    });
    return parseInt(fmt.format(now), 10);
  } catch {
    return now.getUTCHours();
  }
}

/** Returns the UTC ISO of the start of "today" in user's local time. */
function startOfLocalDayUtc(now: Date, timezone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const ymd = fmt.format(now); // YYYY-MM-DD in local time
    // Construct midnight-in-tz by formatting today's date with hour 00:00 in that tz.
    // The cleanest cross-timezone trick: interpret `${ymd}T00:00:00` as UTC, then
    // adjust by the tz offset for that instant.
    const naiveUtc = new Date(`${ymd}T00:00:00Z`);
    const offsetMin = tzOffsetMinutes(naiveUtc, timezone);
    return new Date(naiveUtc.getTime() - offsetMin * 60_000).toISOString();
  } catch {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }
}

/** Returns the UTC ISO of the end of "today" in user's local time (midnight tomorrow). */
function endOfLocalDayUtc(now: Date, timezone: string): string {
  const start = new Date(startOfLocalDayUtc(now, timezone));
  return new Date(start.getTime() + 86_400_000).toISOString();
}

/** Offset (in minutes) for a given instant in a given timezone. */
function tzOffsetMinutes(date: Date, timezone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
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
      +o.second,
    );
    return (asUtc - date.getTime()) / 60_000;
  } catch {
    return 0;
  }
}

// ---------- main -----------------------------------------------------------

// @ts-expect-error
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonRes({ error: 'POST required' }, 405);

  // Service-role-only. Reject anything that isn't pg_cron / the service role.
  // The Edge Runtime already enforced JWT validity before invoking us; we
  // additionally check that the caller is the service role so a user JWT
  // can't trigger a mass push.
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token !== SUPABASE_SERVICE_ROLE_KEY) {
    return jsonRes({ error: 'Unauthorized' }, 401);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Pull every push-eligible profile in a single query.
  const { data: profiles, error: pErr } = await admin
    .from('profiles')
    .select('id, first_name, timezone, last_morning_push_at')
    .eq('push_notifications_enabled', true)
    .not('expo_push_token', 'is', null);

  if (pErr) return jsonRes({ error: pErr.message }, 500);
  if (!profiles || profiles.length === 0) {
    return jsonRes({ ok: true, considered: 0, pushed: 0 });
  }

  const now = new Date();
  let pushed = 0;
  let considered = 0;

  for (const profile of (profiles as Profile[])) {
    const tz = profile.timezone ?? 'UTC';
    if (localHour(now, tz) !== TARGET_LOCAL_HOUR) continue;
    considered++;

    // Idempotency: skip if we already pushed since the start of THEIR local day.
    const dayStart = startOfLocalDayUtc(now, tz);
    if (profile.last_morning_push_at && profile.last_morning_push_at >= dayStart) continue;

    const dayEnd = endOfLocalDayUtc(now, tz);

    // Fetch today's calendar events and pending hangouts in parallel.
    const [eventsRes, hangoutsRes] = await Promise.all([
      admin
        .from('calendar_events')
        .select('id, title, start_at')
        .eq('user_id', profile.id)
        .gte('start_at', dayStart)
        .lt('start_at', dayEnd)
        .order('start_at', { ascending: true }),
      admin
        .from('hangouts')
        .select('id, title, proposed_start, hangout_responses!inner(user_id, status)')
        .eq('hangout_responses.user_id', profile.id)
        .eq('hangout_responses.status', 'pending')
        .in('status', ['proposing', 'confirmed'])
        .order('proposed_start', { ascending: true }),
    ]);

    const events = (eventsRes.data ?? []) as CalendarEvent[];
    const pendingHangouts = (hangoutsRes.data ?? []) as Hangout[];

    // Pick template
    const name = profile.first_name ?? 'friend';
    const title = `Good morning, ${name}`;
    let body: string;
    let routeType = 'morning_push';

    if (pendingHangouts.length > 0) {
      const head = pendingHangouts[0].title;
      body =
        pendingHangouts.length === 1
          ? `"${head}" needs your call.`
          : `${pendingHangouts.length} pending. "${head}" needs your call.`;
    } else if (events.length > 0) {
      body = `${events.length} on your plate today. Tap to look at it / shuffle / cancel anything.`;
    } else {
      body = `Light day ahead. Want to make plans with someone?`;
    }

    // Fire-and-forget push via the RPC.
    const { error: pushErr } = await admin.rpc('send_push_to_users', {
      _user_ids: [profile.id],
      _title: title,
      _body: body,
      _data: { type: routeType },
    });
    if (pushErr) {
      console.warn(`Morning push failed for ${profile.id}: ${pushErr.message}`);
      continue;
    }

    // Mark as pushed so we don't fire again until tomorrow.
    await admin
      .from('profiles')
      .update({ last_morning_push_at: now.toISOString() })
      .eq('id', profile.id);

    pushed++;
  }

  return jsonRes({ ok: true, considered, pushed });
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
