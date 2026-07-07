import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BackChevron } from '../../src/components/BackChevron';
import { Screen } from '../../src/components/Screen';
import { useAuth } from '../../src/lib/auth-context';
import { supabase } from '../../src/lib/supabase';
import { colors, font, radius, space } from '../../src/theme';
import type { LocalEvent } from '../../src/types/database';

/**
 * Events — the town listing, browse view. Hidden route (not a tab; chat-first),
 * reached from the "◈ Events" button in the agent header.
 *
 * READ surface only: what's coming up, visible per RLS (public + friends-shared
 * + own). All the WRITE flows (add / find / cancel) go through the agent —
 * the composer is seeded, same pattern as Goals.
 */
export default function EventsScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [events, setEvents] = useState<LocalEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const seedAgent = (text: string) =>
    router.push({ pathname: '/(app)/agent', params: { seed: text } });

  const load = useCallback(async () => {
    if (!user) return;
    // RLS scopes visibility (public + friends-shared + own). Next 30 days.
    const { data } = await supabase
      .from('events')
      .select('*')
      .eq('status', 'scheduled')
      .gte('starts_at', new Date().toISOString())
      .lte('starts_at', new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString())
      .order('starts_at', { ascending: true })
      .limit(50);
    setEvents((data as LocalEvent[] | null) ?? []);
    setLoading(false);
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const cancelOwn = useCallback(
    (e: LocalEvent) => {
      Alert.alert('Cancel this event?', `"${e.title}" will be hidden from everyone's discovery.`, [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel event',
          style: 'destructive',
          onPress: async () => {
            const { error } = await supabase
              .from('events')
              .update({ status: 'cancelled' })
              .eq('id', e.id);
            if (error) Alert.alert('Failed', error.message);
            else load();
          },
        },
      ]);
    },
    [load],
  );

  return (
    <Screen noPadding>
      <View style={styles.header}>
        <BackChevron />
        <Text style={styles.title}>Events</Text>
        <View style={{ flex: 1 }} />
      </View>

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {events.length === 0 ? (
            <EmptyState onAsk={() => seedAgent("What's happening around here in the next few days?")} />
          ) : (
            groupByDay(events).map((day) => (
              <View key={day.label} style={{ marginBottom: space.md }}>
                <Text style={styles.dayLabel}>{day.label}</Text>
                <View style={{ gap: space.sm }}>
                  {day.items.map((e) => (
                    <EventRow
                      key={e.id}
                      event={e}
                      mine={e.created_by === user?.id}
                      onCancel={() => cancelOwn(e)}
                    />
                  ))}
                </View>
              </View>
            ))
          )}

          <Pressable
            style={styles.addBtn}
            onPress={() =>
              seedAgent('I want to add a local event to the listing: ')
            }
          >
            <Text style={styles.addText}>+ Add an event</Text>
          </Pressable>
          <Text style={styles.footNote}>
            Know about something happening? Tell ALINE — everyone discovers it.
          </Text>
        </ScrollView>
      )}
    </Screen>
  );
}

function EventRow({
  event: e,
  mine,
  onCancel,
}: {
  event: LocalEvent;
  mine: boolean;
  onCancel: () => void;
}) {
  const start = new Date(e.starts_at);
  const time = start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const openMap = () => {
    const url =
      e.lat != null && e.lon != null
        ? `https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lon}`
        : e.venue_text
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.venue_text)}`
          : null;
    if (url) Linking.openURL(url);
  };

  const meta = [time, e.venue_text, e.price_text].filter(Boolean).join(' · ');

  return (
    <View style={styles.card}>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.titleRow}>
          <Text style={styles.eventTitle} numberOfLines={2}>
            {e.title}
          </Text>
          {e.visibility !== 'public' ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {e.visibility === 'friends' ? 'friends' : 'private'}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.eventMeta}>{meta}</Text>
        {e.description ? (
          <Text style={styles.eventDesc} numberOfLines={2}>
            {e.description}
          </Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        {e.venue_text || e.lat != null ? (
          <Pressable onPress={openMap} hitSlop={6}>
            <Text style={styles.actionLink}>Map</Text>
          </Pressable>
        ) : null}
        {e.url ? (
          <Pressable onPress={() => Linking.openURL(e.url!)} hitSlop={6}>
            <Text style={styles.actionLink}>Info</Text>
          </Pressable>
        ) : null}
        {mine ? (
          <Pressable onPress={onCancel} hitSlop={6}>
            <Text style={[styles.actionLink, { color: colors.danger }]}>Cancel</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function EmptyState({ onAsk }: { onAsk: () => void }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>Nothing listed yet</Text>
      <Text style={styles.emptyBody}>
        This is the town's shared listing — concerts, markets, matches, meetups.
        Ask ALINE what's on, or add something you know about.
      </Text>
      <Pressable style={styles.emptyBtn} onPress={onAsk}>
        <Text style={styles.emptyBtnText}>Ask ALINE what's happening</Text>
      </Pressable>
    </View>
  );
}

/** Group upcoming events under friendly day headers (Today / Tomorrow / date). */
function groupByDay(events: LocalEvent[]): { label: string; items: LocalEvent[] }[] {
  const out: { label: string; items: LocalEvent[] }[] = [];
  const todayKey = new Date().toDateString();
  const tomorrowKey = new Date(Date.now() + 24 * 3600 * 1000).toDateString();
  for (const e of events) {
    const d = new Date(e.starts_at);
    const key = d.toDateString();
    const label =
      key === todayKey
        ? 'Today'
        : key === tomorrowKey
          ? 'Tomorrow'
          : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(e);
    else out.push({ label, items: [e] });
  }
  return out;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: font.size.xl,
    fontWeight: '700',
    color: colors.text,
    marginLeft: space.sm,
  },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: space.lg, paddingBottom: space.xxl },

  dayLabel: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: space.sm,
  },

  card: {
    flexDirection: 'row',
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    gap: space.sm,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  eventTitle: { color: colors.text, fontSize: font.size.md, fontWeight: '600', flexShrink: 1 },
  eventMeta: { color: colors.textMuted, fontSize: font.size.sm },
  eventDesc: { color: colors.textDim, fontSize: font.size.sm, marginTop: 2 },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.accentDim,
  },
  badgeText: { color: colors.accent, fontSize: 10, fontWeight: '700' },
  actions: { justifyContent: 'center', alignItems: 'flex-end', gap: space.xs },
  actionLink: { color: colors.accent, fontSize: font.size.xs, fontWeight: '600' },

  addBtn: { alignItems: 'center', paddingVertical: space.md, marginTop: space.sm },
  addText: { color: colors.accent, fontSize: font.size.md, fontWeight: '600' },
  footNote: {
    color: colors.textDim,
    fontSize: font.size.xs,
    textAlign: 'center',
    fontStyle: 'italic',
  },

  empty: { paddingVertical: space.xxl, alignItems: 'center' },
  emptyTitle: { color: colors.text, fontSize: font.size.xl, fontWeight: '700', marginBottom: space.sm },
  emptyBody: {
    color: colors.textMuted,
    fontSize: font.size.md,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: space.xl,
  },
  emptyBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.xl,
  },
  emptyBtnText: { color: colors.textInverse, fontSize: font.size.md, fontWeight: '600' },
});
