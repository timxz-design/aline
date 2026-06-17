/**
 * DayStrip — a thin, glanceable one-liner of today's shape, anchored in the
 * agent chat header. Replaces the MorningPanel day-shape now that chat is home
 * and the calendar tab is a detail view. Tap → full week.
 *
 * Refreshes on mount and whenever the app returns to foreground, so it stays
 * current without a heavy subscription.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../lib/auth-context';
import { localDayBoundsIso, localDayKey, shortTime } from '../lib/day';
import { supabase } from '../lib/supabase';
import { useProfile } from '../lib/use-profile';
import { colors, font, radius, space } from '../theme';

type TodayEvent = {
  id: string;
  title: string | null;
  start_at: string;
  end_at: string;
  event_type: string | null;
};

export function DayStrip() {
  const { user } = useAuth();
  const { profile } = useProfile();
  const router = useRouter();
  const timezone = profile?.timezone ?? 'UTC';

  const [events, setEvents] = useState<TodayEvent[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    const dayKey = localDayKey(new Date(), timezone);
    const { startIso, endIso } = localDayBoundsIso(dayKey, timezone);
    const { data } = await supabase
      .from('calendar_events')
      .select('id, title, start_at, end_at, event_type')
      .eq('user_id', user.id)
      .gte('start_at', startIso)
      .lt('start_at', endIso)
      .order('start_at', { ascending: true })
      .limit(50);
    setEvents((data ?? []) as TodayEvent[]);
    setLoaded(true);
  }, [user?.id, timezone]);

  useEffect(() => {
    load();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') load();
    });
    return () => sub.remove();
  }, [load]);

  const dayShape = useMemo(() => {
    const realBlocks = events.filter((e) => e.event_type !== 'transit');
    if (realBlocks.length === 0) return null; // empty-day CTA handled below
    const nowMs = Date.now();
    const current = realBlocks.find(
      (e) =>
        new Date(e.start_at).getTime() <= nowMs &&
        new Date(e.end_at).getTime() > nowMs,
    );
    const next = realBlocks.find((e) => new Date(e.start_at).getTime() > nowMs);
    const lastBlock = realBlocks[realBlocks.length - 1];
    return [
      current
        ? `Now: ${current.title ?? 'busy'} until ${shortTime(current.end_at, timezone)}`
        : next
          ? `Next: ${next.title ?? 'something'} at ${shortTime(next.start_at, timezone)}`
          : 'All done for today',
      `${realBlocks.length} block${realBlocks.length === 1 ? '' : 's'}`,
      lastBlock && new Date(lastBlock.end_at).getTime() > nowMs
        ? `free after ${shortTime(lastBlock.end_at, timezone)}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }, [events, timezone]);

  // Don't flash an empty strip before the first load resolves.
  if (!loaded) return null;

  const isEmpty = dayShape === null;

  return (
    <Pressable
      onPress={() => router.push('/(app)/week' as never)}
      style={({ pressed }) => [styles.strip, pressed && { opacity: 0.7 }]}
    >
      <Text style={styles.icon}>◫</Text>
      <Text style={[styles.text, isEmpty && styles.textDim]} numberOfLines={1}>
        {isEmpty ? 'Light day — tap to plan something' : dayShape}
      </Text>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    backgroundColor: colors.bgElevated,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  icon: { color: colors.textMuted, fontSize: 15 },
  text: { flex: 1, color: colors.text, fontSize: font.size.sm },
  textDim: { color: colors.textMuted },
  chevron: { color: colors.textDim, fontSize: 20, marginTop: -2 },
});
