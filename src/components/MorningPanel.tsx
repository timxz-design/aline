/**
 * MorningPanel — the daily ritual surface.
 *
 * Renders at the top of the Week tab when the user's first foreground for
 * the day is detected (or when the morning push routes them in). Combines
 * today's calendar, pending RSVPs, and the curiosity card into one panel
 * the user can act on in 5 seconds.
 *
 * Dismissal is persisted by local-day key in AsyncStorage so it doesn't
 * keep reappearing throughout the day. Resets on the next local-day
 * boundary.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../lib/auth-context';
import { useProfile } from '../lib/use-profile';
import { supabase } from '../lib/supabase';
import { colors, font, radius, space } from '../theme';

const DISMISS_KEY_PREFIX = '@aline/morning_panel_dismissed_';
const LAST_SHOWN_KEY = '@aline/morning_panel_last_shown_day';

type TodayEvent = {
  id: string;
  title: string | null;
  start_at: string;
  end_at: string;
};

type PendingHangout = {
  id: string;
  title: string;
  proposed_start: string | null;
};

/** Returns 'YYYY-MM-DD' for `date` in `timezone`. */
function localDayKey(date: Date, timezone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Format a UTC ISO start time as a short local-time string (e.g. "14:30"). */
function shortTime(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

/** Format a date as "Tuesday, May 19". */
function longDate(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(date);
  } catch {
    return date.toDateString();
  }
}

export function MorningPanel() {
  const { user } = useAuth();
  const { profile } = useProfile();
  const router = useRouter();
  const timezone = profile?.timezone ?? 'UTC';

  const [shouldShow, setShouldShow] = useState(false);
  const [events, setEvents] = useState<TodayEvent[]>([]);
  const [pending, setPending] = useState<PendingHangout[]>([]);
  const [responding, setResponding] = useState<string | null>(null);

  const today = useMemo(() => new Date(), []);
  const dayKey = useMemo(() => localDayKey(today, timezone), [today, timezone]);

  // Decide whether to show the panel. Conditions:
  //   1. Not yet dismissed for today.
  //   2. The most recent app_session before today is in a different local
  //      day (i.e. this is the first open of this local day).
  useEffect(() => {
    if (!user) {
      setShouldShow(false);
      return;
    }

    let cancelled = false;
    (async () => {
      // 1. Already dismissed today?
      const dismissedKey = `${DISMISS_KEY_PREFIX}${dayKey}`;
      const dismissed = await AsyncStorage.getItem(dismissedKey);
      if (dismissed) {
        if (!cancelled) setShouldShow(false);
        return;
      }

      // 2. First open of this local day?
      // Query the most recent session BEFORE today's start (cheap — index on
      // user_id, opened_at DESC).
      // Start of today in local = today's date string + T00:00 in tz; we just
      // compare local day keys for simplicity.
      const { data: lastSession } = await supabase
        .from('app_sessions')
        .select('opened_at')
        .eq('user_id', user.id)
        .order('opened_at', { ascending: false })
        .limit(2); // most recent two — the most recent is THIS session

      // Find the most recent session before today. If we only have one row
      // (this session itself), then there is no prior session today → fresh
      // day. If the second row is on a previous local day → fresh day.
      let isFreshDay = false;
      if (!lastSession || lastSession.length <= 1) {
        // First session ever or only one row total. Treat as a fresh day if
        // we have not shown this user the panel today yet.
        const lastShown = await AsyncStorage.getItem(LAST_SHOWN_KEY);
        isFreshDay = lastShown !== dayKey;
      } else {
        const priorDayKey = localDayKey(new Date(lastSession[1].opened_at), timezone);
        isFreshDay = priorDayKey !== dayKey;
      }

      if (!cancelled) {
        setShouldShow(isFreshDay);
        if (isFreshDay) {
          await AsyncStorage.setItem(LAST_SHOWN_KEY, dayKey);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, dayKey, timezone]);

  // Fetch today's events + pending hangouts when visible.
  useEffect(() => {
    if (!shouldShow || !user) return;

    let cancelled = false;
    (async () => {
      // Compute UTC range for "today in user's local tz". The trick used
      // elsewhere in the codebase: shift midnight UTC by the tz offset.
      const startLocalIso = (() => {
        const ymd = dayKey;
        const naive = new Date(`${ymd}T00:00:00Z`);
        const offsetMin = tzOffsetMinutes(naive, timezone);
        return new Date(naive.getTime() - offsetMin * 60_000).toISOString();
      })();
      const endLocalIso = new Date(
        new Date(startLocalIso).getTime() + 86_400_000,
      ).toISOString();

      const [eventsRes, hangoutsRes] = await Promise.all([
        supabase
          .from('calendar_events')
          .select('id, title, start_at, end_at')
          .eq('user_id', user.id)
          .gte('start_at', startLocalIso)
          .lt('start_at', endLocalIso)
          .order('start_at', { ascending: true })
          .limit(5),
        supabase
          .from('hangouts')
          .select('id, title, proposed_start, hangout_responses!inner(user_id, status)')
          .eq('hangout_responses.user_id', user.id)
          .eq('hangout_responses.status', 'pending')
          .in('status', ['proposing', 'confirmed'])
          .order('proposed_start', { ascending: true }),
      ]);
      if (cancelled) return;
      setEvents((eventsRes.data ?? []) as TodayEvent[]);
      setPending((hangoutsRes.data ?? []) as PendingHangout[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [shouldShow, user?.id, dayKey, timezone]);

  const dismiss = useCallback(async () => {
    await AsyncStorage.setItem(`${DISMISS_KEY_PREFIX}${dayKey}`, '1');
    setShouldShow(false);
  }, [dayKey]);

  const respond = useCallback(
    async (hangoutId: string, status: 'confirmed' | 'declined' | 'maybe') => {
      if (responding) return;
      setResponding(hangoutId);
      await supabase.rpc('respond_to_hangout', {
        _hangout_id: hangoutId,
        _status: status,
      });
      setResponding(null);
      // Drop the answered hangout from the list immediately.
      setPending((prev) => prev.filter((h) => h.id !== hangoutId));
    },
    [responding],
  );

  const goToAgentEmptyDay = useCallback(() => {
    // Open the agent with a seed message. Agent.tsx accepts a `seed` param
    // for pre-filling the composer. Falls back to plain navigate if not.
    router.push('/agent?seed=Got%20nothing%20on.%20Got%20any%20ideas%3F' as never);
  }, [router]);

  if (!shouldShow) return null;

  const greetingName = profile?.first_name ?? 'friend';

  return (
    <View style={styles.card}>
      <Text style={styles.greeting}>Good morning, {greetingName}.</Text>
      <Text style={styles.date}>{longDate(today, timezone)}</Text>

      {/* Today's plan */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Today</Text>
        {events.length > 0 ? (
          events.map((ev) => (
            <View key={ev.id} style={styles.eventRow}>
              <Text style={styles.eventTime}>{shortTime(ev.start_at, timezone)}</Text>
              <Text style={styles.eventTitle} numberOfLines={1}>
                {ev.title ?? '(untitled)'}
              </Text>
            </View>
          ))
        ) : (
          <Pressable onPress={goToAgentEmptyDay} style={styles.emptyCta}>
            <Text style={styles.emptyCtaText}>
              Light day. Tap to ask ALINE to suggest something.
            </Text>
          </Pressable>
        )}
      </View>

      {/* Waiting on you */}
      {pending.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Waiting on you</Text>
          {pending.map((h) => (
            <View key={h.id} style={styles.pendingCard}>
              <Text style={styles.pendingTitle} numberOfLines={1}>
                {h.title}
                {h.proposed_start ? ` · ${shortTime(h.proposed_start, timezone)}` : ''}
              </Text>
              <View style={styles.pendingButtons}>
                <Pressable
                  onPress={() => respond(h.id, 'confirmed')}
                  style={[styles.respBtn, styles.respBtnIn]}
                >
                  <Text style={styles.respBtnText}>I'm in</Text>
                </Pressable>
                <Pressable
                  onPress={() => respond(h.id, 'maybe')}
                  style={[styles.respBtn, styles.respBtnMaybe]}
                >
                  <Text style={styles.respBtnText}>Maybe</Text>
                </Pressable>
                <Pressable
                  onPress={() => respond(h.id, 'declined')}
                  style={[styles.respBtn, styles.respBtnOut]}
                >
                  <Text style={styles.respBtnText}>Out</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {/* Curiosity card renders separately below the panel (in Week tab) */}

      <Pressable onPress={dismiss} style={styles.dismissBtn}>
        <Text style={styles.dismissText}>Got it</Text>
      </Pressable>
    </View>
  );
}

/** Offset of `timezone` (in minutes) from UTC for the given instant. */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  try {
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
      +o.second,
    );
    return (asUtc - date.getTime()) / 60_000;
  } catch {
    return 0;
  }
}

const styles = StyleSheet.create({
  card: {
    margin: space.lg,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    gap: space.md,
  },
  greeting: {
    color: colors.text,
    fontSize: font.size.xl,
    fontWeight: '700',
  },
  date: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    marginTop: -space.xs,
  },
  section: {
    gap: space.xs,
  },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 4,
  },
  eventTime: {
    color: colors.accent,
    fontSize: font.size.md,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    width: 52,
  },
  eventTitle: {
    color: colors.text,
    fontSize: font.size.md,
    flex: 1,
  },
  emptyCta: {
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyCtaText: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    lineHeight: 20,
  },
  pendingCard: {
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.border,
    gap: space.sm,
  },
  pendingTitle: {
    color: colors.text,
    fontSize: font.size.md,
    fontWeight: '600',
  },
  pendingButtons: {
    flexDirection: 'row',
    gap: space.xs,
  },
  respBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  respBtnIn: { backgroundColor: colors.accent },
  respBtnMaybe: { backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.border },
  respBtnOut: { backgroundColor: 'rgba(248,113,113,0.15)', borderWidth: 1, borderColor: colors.danger },
  respBtnText: {
    color: colors.text,
    fontSize: font.size.sm,
    fontWeight: '600',
  },
  dismissBtn: {
    alignSelf: 'center',
    paddingVertical: space.xs,
    paddingHorizontal: space.lg,
  },
  dismissText: {
    color: colors.textDim,
    fontSize: font.size.sm,
  },
});
