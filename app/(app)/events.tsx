import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Image,
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
/** End of an event: explicit end, else start + 2h (concert-ish default). */
function eventEnd(e: LocalEvent): string {
  return e.ends_at ?? new Date(new Date(e.starts_at).getTime() + 2 * 3600 * 1000).toISOString();
}

export default function EventsScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [events, setEvents] = useState<LocalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // event_id → calendar_event_id for events already on the user's calendar.
  const [goingMap, setGoingMap] = useState<Record<string, string>>({});

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
    const rows = (data as LocalEvent[] | null) ?? [];
    setEvents(rows);
    // Going-state: which of these are already on my calendar?
    if (rows.length > 0) {
      const { data: going } = await supabase
        .from('calendar_events')
        .select('id, local_event_id')
        .eq('user_id', user.id)
        .in('local_event_id', rows.map((r) => r.id));
      const map: Record<string, string> = {};
      for (const g of (going ?? []) as { id: string; local_event_id: string | null }[]) {
        if (g.local_event_id) map[g.local_event_id] = g.id;
      }
      setGoingMap(map);
    } else {
      setGoingMap({});
    }
    setLoading(false);
  }, [user]);

  // "I'm going" — the goal-plan direct-commit principle: deterministic action,
  // one tap, no chat round-trip. The agent only gets involved when there's an
  // actual conflict to negotiate.
  const goToEvent = useCallback(
    async (e: LocalEvent) => {
      if (!user) return;
      const end = eventEnd(e);
      const insertGo = async () => {
        const { error } = await supabase.from('calendar_events').insert({
          user_id: user.id,
          title: e.title,
          start_at: e.starts_at,
          end_at: end,
          location: e.venue_text,
          description: e.description,
          event_type: 'flexible',
          is_movable: false,
          source: 'aline',
          local_event_id: e.id,
        });
        if (error) {
          Alert.alert('Could not add', error.message);
          return;
        }
        await load();
      };

      // Conflict check: anything already on the calendar overlapping the slot.
      const { data: clash } = await supabase
        .from('calendar_events')
        .select('id, title, start_at')
        .eq('user_id', user.id)
        .lt('start_at', end)
        .gt('end_at', e.starts_at)
        .limit(1);
      const conflict = (clash ?? [])[0] as { title: string | null } | undefined;

      if (conflict) {
        Alert.alert(
          'Schedule clash',
          `"${conflict.title ?? 'Another plan'}" overlaps this event.`,
          [
            {
              text: 'Let ALINE sort it',
              onPress: () =>
                seedAgent(
                  `I want to go to "${e.title}" (${e.venue_text ?? ''}) starting ${e.starts_at}, but it clashes with "${conflict.title ?? 'an existing plan'}". Help me rearrange things so I can make it.`,
                ),
            },
            { text: 'Add anyway', onPress: insertGo },
            { text: 'Cancel', style: 'cancel' },
          ],
        );
        return;
      }
      await insertGo();
    },
    [user, load],
  );

  const unGoEvent = useCallback(
    (e: LocalEvent, calendarEventId: string) => {
      Alert.alert('Not going?', `"${e.title}" will be removed from your calendar.`, [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const { error } = await supabase.from('calendar_events').delete().eq('id', calendarEventId);
            if (error) Alert.alert('Failed', error.message);
            else load();
          },
        },
      ]);
    },
    [load],
  );

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
                      expanded={expandedId === e.id}
                      goingCalId={goingMap[e.id] ?? null}
                      onToggle={() => setExpandedId(expandedId === e.id ? null : e.id)}
                      onGo={() => goToEvent(e)}
                      onUnGo={(calId) => unGoEvent(e, calId)}
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
  expanded,
  goingCalId,
  onToggle,
  onGo,
  onUnGo,
  onCancel,
}: {
  event: LocalEvent;
  mine: boolean;
  expanded: boolean;
  goingCalId: string | null;
  onToggle: () => void;
  onGo: () => void;
  onUnGo: (calendarEventId: string) => void;
  onCancel: () => void;
}) {
  const start = new Date(e.starts_at);
  const time = start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const endTime = e.ends_at
    ? new Date(e.ends_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null;
  const going = goingCalId != null;
  const openMap = () => {
    const url =
      e.lat != null && e.lon != null
        ? `https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lon}`
        : e.venue_text
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.venue_text)}`
          : null;
    if (url) Linking.openURL(url);
  };

  const meta = [
    endTime ? `${time}–${endTime}` : time,
    e.venue_text,
    e.price_text,
    expanded ? e.category : null,
  ].filter(Boolean).join(' · ');

  // Collapsed: compact scannable row. Expanded: full poster, whole description,
  // and the action row. Tap anywhere on the card body to toggle.
  return (
    <Pressable onPress={onToggle} style={({ pressed }) => [pressed && { opacity: 0.9 }]}>
      <View style={[styles.card, expanded && styles.cardExpanded]}>
        {expanded && e.image_url ? (
          <Image source={{ uri: e.image_url }} style={styles.posterLarge} resizeMode="cover" />
        ) : null}
        <View style={styles.cardBody}>
          {!expanded && e.image_url ? (
            <Image source={{ uri: e.image_url }} style={styles.poster} resizeMode="cover" />
          ) : null}
          <View style={{ flex: 1, gap: 2 }}>
            <View style={styles.titleRow}>
              <Text style={styles.eventTitle} numberOfLines={expanded ? undefined : 2}>
                {e.title}
              </Text>
              {going ? (
                <View style={[styles.badge, styles.badgeGoing]}>
                  <Text style={[styles.badgeText, styles.badgeGoingText]}>going ✓</Text>
                </View>
              ) : null}
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
              <Text style={styles.eventDesc} numberOfLines={expanded ? undefined : 2}>
                {e.description}
              </Text>
            ) : null}
          </View>
        </View>

        {expanded ? (
          <View style={styles.expandedActions}>
            <Pressable
              onPress={() => (going ? onUnGo(goingCalId!) : onGo())}
              style={({ pressed }) => [
                styles.goBtn,
                going && styles.goBtnGoing,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={[styles.goBtnText, going && styles.goBtnTextGoing]}>
                {going ? "✓ You're going" : "I'm going"}
              </Text>
            </Pressable>
            {e.venue_text || e.lat != null ? (
              <Pressable onPress={openMap} style={styles.ghostBtn} hitSlop={4}>
                <Text style={styles.ghostBtnText}>Map</Text>
              </Pressable>
            ) : null}
            {e.url ? (
              <Pressable onPress={() => Linking.openURL(e.url!)} style={styles.ghostBtn} hitSlop={4}>
                <Text style={styles.ghostBtnText}>Info</Text>
              </Pressable>
            ) : null}
            {mine ? (
              <Pressable onPress={onCancel} style={styles.ghostBtn} hitSlop={4}>
                <Text style={[styles.ghostBtnText, { color: colors.danger }]}>Cancel event</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
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
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    gap: space.sm,
  },
  cardExpanded: { borderColor: colors.accent },
  cardBody: { flexDirection: 'row', gap: space.sm },
  poster: {
    width: 56,
    height: 72,
    borderRadius: radius.sm,
    backgroundColor: colors.bgRaised,
  },
  posterLarge: {
    width: '100%',
    height: 200,
    borderRadius: radius.sm,
    backgroundColor: colors.bgRaised,
  },
  expandedActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xs,
    flexWrap: 'wrap',
  },
  goBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  goBtnGoing: {
    backgroundColor: colors.accentDim,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  goBtnText: { color: colors.textInverse, fontSize: font.size.sm, fontWeight: '700' },
  goBtnTextGoing: { color: colors.accent },
  ghostBtn: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ghostBtnText: { color: colors.text, fontSize: font.size.sm, fontWeight: '600' },
  badgeGoing: { backgroundColor: colors.accent },
  badgeGoingText: { color: colors.textInverse },
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
