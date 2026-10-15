import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AvatarStack, otherParticipants, planColor } from '../../src/components/AvatarStack';
import { CalendarReconnectBanner } from '../../src/components/CalendarReconnectBanner';
import { CuriosityCard } from '../../src/components/CuriosityCard';
import { HangoutSheet } from '../../src/components/HangoutSheet';
import { Screen } from '../../src/components/Screen';
import { useAuth } from '../../src/lib/auth-context';
import { useCuriosity } from '../../src/lib/use-curiosity';
import {
  DAY_LABELS,
  addDays,
  dayKey,
  sameDay,
  startOfWeek,
} from '../../src/lib/date-utils';
import {
  getGoogleCalendarStatus,
  syncGoogleCalendar,
} from '../../src/lib/google-calendar';
import { getParticipantsFor, type Participant } from '../../src/lib/hangouts';
import { supabase } from '../../src/lib/supabase';
import type { CalendarEvent } from '../../src/types/database';
import { colors, font, radius, space } from '../../src/theme';

const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 6am - 11pm
const HOUR_HEIGHT = 56;

const EVENT_COLORS: Record<string, string> = {
  fixed: colors.eventFixed,
  flexible: colors.eventFlexible,
  goal: colors.eventGoal,
  coordinated: colors.eventCoordinated,
  routine: colors.accent2,
  transit: colors.textMuted,
};

export default function WeekScreen() {
  const { user } = useAuth();
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const { item: curiosityItem, refresh: refreshCuriosity } = useCuriosity();

  // Current time — updates every minute so the red line stays accurate.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const weekStart = useMemo(() => startOfWeek(selectedDate), [selectedDate]);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  const loadEvents = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const weekEnd = addDays(weekStart, 7);
    const { data, error } = await supabase
      .from('calendar_events')
      .select('*')
      .eq('user_id', user.id)
      .gte('start_at', weekStart.toISOString())
      .lt('start_at', weekEnd.toISOString())
      .order('start_at', { ascending: true });
    if (error) console.warn('Failed to load events:', error.message);
    setEvents(data ?? []);
    setLoading(false);
  }, [user, weekStart]);

  // Initial fetch + when week changes.
  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // Upcoming confirmed hangouts (direct + group) — sourced from the
  // coordinated calendar_events the hangout-sync triggers create. Spans the
  // near future, independent of the visible week, so a hangout two weeks out
  // is still visible here. This is the dedicated "where am I meeting people"
  // surface that the day grid alone doesn't give.
  const [upcoming, setUpcoming] = useState<CalendarEvent[]>([]);
  const loadUpcoming = useCallback(async () => {
    if (!user) return;
    const horizon = addDays(new Date(), 30);
    const { data, error } = await supabase
      .from('calendar_events')
      .select('*')
      .eq('user_id', user.id)
      .eq('event_type', 'coordinated')
      .gte('start_at', new Date().toISOString())
      .lt('start_at', horizon.toISOString())
      .order('start_at', { ascending: true })
      .limit(6);
    if (error) {
      console.warn('Failed to load upcoming hangouts:', error.message);
      return;
    }
    setUpcoming(data ?? []);
  }, [user]);

  useEffect(() => {
    loadUpcoming();
  }, [loadUpcoming]);

  // Who is in each visible plan — drives the block colour (the other person's
  // colour for a 1:1, the group colour for more) and the initials shown on it.
  const [participants, setParticipants] = useState<Map<string, Participant[]>>(new Map());
  useEffect(() => {
    const ids = [...new Set([...events, ...upcoming].map((e) => e.hangout_id).filter((x): x is string => !!x))];
    let cancelled = false;
    getParticipantsFor(ids).then((m) => {
      if (!cancelled) setParticipants(m);
    });
    return () => {
      cancelled = true;
    };
  }, [events, upcoming]);
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);

  // Deep link from a plan notification: /(app)/week?plan=<hangout id>.
  const { plan: planParam } = useLocalSearchParams<{ plan?: string }>();
  useEffect(() => {
    if (typeof planParam === 'string' && planParam) setOpenPlanId(planParam);
  }, [planParam]);

  // Plans waiting for my answer. Not on the calendar yet (only confirmed plans
  // are), and an invitee outside the plan's group never sees it in Groups — so
  // this is the one place an invite is always visible.
  type Invite = { hangout_id: string; title: string | null; proposed_start: string | null; venue_name: string | null };
  const [invites, setInvites] = useState<Invite[]>([]);
  const loadInvites = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from('hangout_responses')
      .select('hangout_id, hangouts!inner(title, proposed_start, venue_name, status)')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .in('hangouts.status', ['proposing', 'confirmed']);
    if (error) {
      console.warn('Failed to load invites:', error.message);
      return;
    }
    const nowMs = Date.now();
    setInvites(
      ((data ?? []) as unknown as {
        hangout_id: string;
        hangouts: { title: string | null; proposed_start: string | null; venue_name: string | null };
      }[])
        .map((r) => ({ hangout_id: r.hangout_id, ...r.hangouts }))
        .filter((i) => !i.proposed_start || new Date(i.proposed_start).getTime() > nowMs)
        .sort((a, b) => (a.proposed_start ?? '').localeCompare(b.proposed_start ?? '')),
    );
  }, [user]);
  useEffect(() => {
    loadInvites();
  }, [loadInvites]);
  const inviteIds = useMemo(() => invites.map((i) => i.hangout_id), [invites]);
  const [inviteParticipants, setInviteParticipants] = useState<Map<string, Participant[]>>(new Map());
  useEffect(() => {
    getParticipantsFor(inviteIds).then(setInviteParticipants);
  }, [inviteIds]);

  /**
   * Refresh button: if the user has Google connected, run a sync first
   * (which writes new/changed events into calendar_events), then reload.
   * If not connected, just re-read whatever's in the DB.
   */
  const onRefresh = useCallback(async () => {
    setSyncing(true);
    try {
      const status = await getGoogleCalendarStatus();
      if (status.connected) {
        await syncGoogleCalendar();
      }
      await Promise.all([loadEvents(), loadUpcoming(), loadInvites()]);
    } finally {
      setSyncing(false);
    }
  }, [loadEvents, loadUpcoming, loadInvites]);

  const eventsForSelectedDay = useMemo(
    () => events.filter((ev) => sameDay(new Date(ev.start_at), selectedDate)),
    [events, selectedDate]
  );

  /**
   * Week navigation. Moving by ±7 days keeps the same day-of-week selected
   * (Wednesday this week → Wednesday next week).
   */
  const goToPrevWeek = useCallback(() => {
    setSelectedDate((d) => addDays(d, -7));
  }, []);
  const goToNextWeek = useCallback(() => {
    setSelectedDate((d) => addDays(d, 7));
  }, []);
  const goToToday = useCallback(() => {
    setSelectedDate(new Date());
  }, []);

  // Whether the visible week contains today.
  const isCurrentWeek = useMemo(() => {
    const todayStart = startOfWeek(new Date()).getTime();
    return weekStart.getTime() === todayStart;
  }, [weekStart]);

  // Pretty week range for the header (e.g. "Apr 27 – May 3").
  const weekRangeLabel = useMemo(() => {
    const last = addDays(weekStart, 6);
    const fmt = (d: Date) =>
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const sameMonth = weekStart.getMonth() === last.getMonth();
    return sameMonth
      ? `${fmt(weekStart)} – ${last.getDate()}`
      : `${fmt(weekStart)} – ${fmt(last)}`;
  }, [weekStart]);

  return (
    <Screen noPadding>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>My Week</Text>
          <Text style={styles.dateLine}>{weekRangeLabel}</Text>
        </View>
        {!isCurrentWeek ? (
          <Pressable
            onPress={goToToday}
            hitSlop={10}
            style={({ pressed }) => [
              styles.todayBtn,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={styles.todayBtnText}>Today</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onRefresh}
          disabled={syncing}
          hitSlop={10}
          style={({ pressed }) => [
            styles.refreshBtn,
            pressed && { opacity: 0.7 },
            syncing && { opacity: 0.5 },
          ]}
        >
          <Text style={styles.refreshBtnText}>
            {syncing ? '⟳ Syncing…' : '⟳ Refresh'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.weekNavRow}>
        <Pressable
          onPress={goToPrevWeek}
          hitSlop={12}
          style={({ pressed }) => [styles.weekNavBtn, pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.weekNavText}>‹</Text>
        </Pressable>

        <View style={styles.daysRow}>
        {weekDays.map((d, i) => {
          const isSelected = sameDay(d, selectedDate);
          const isToday = sameDay(d, new Date());
          return (
            <Pressable
              key={dayKey(d)}
              style={[styles.dayCell, isSelected && styles.dayCellSelected]}
              onPress={() => setSelectedDate(d)}
            >
              <Text
                style={[
                  styles.dayLabel,
                  isSelected && styles.dayLabelSelected,
                  isToday && !isSelected && styles.dayLabelToday,
                ]}
              >
                {DAY_LABELS[i]}
              </Text>
              <Text
                style={[
                  styles.dayDate,
                  isSelected && styles.dayDateSelected,
                  isToday && !isSelected && styles.dayDateToday,
                ]}
              >
                {d.getDate()}
              </Text>
            </Pressable>
          );
        })}
        </View>

        <Pressable
          onPress={goToNextWeek}
          hitSlop={12}
          style={({ pressed }) => [styles.weekNavBtn, pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.weekNavText}>›</Text>
        </Pressable>
      </View>

      <View style={styles.legend}>
        <Legend color={colors.eventFixed} label="Fixed" />
        <Legend color={colors.eventFlexible} label="Flexible" />
        <Legend color={colors.eventGoal} label="Goal" />
        <Legend color={colors.eventCoordinated} label="Coordinated" />
        <Legend color={colors.accent2} label="Routine" />
        <Legend color={colors.textMuted} label="Transit" />
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollBody}
        showsVerticalScrollIndicator={false}
      >
        <CalendarReconnectBanner />
        {invites.length > 0 ? (
          <View style={styles.upcomingSection}>
            <Text style={styles.upcomingHeader}>Waiting for your answer</Text>
            {invites.map((inv) => {
              const people = inviteParticipants.get(inv.hangout_id);
              const others = people ? otherParticipants(people, user?.id) : [];
              const accent = people ? planColor(people, user?.id) : colors.eventCoordinated;
              return (
                <Pressable
                  key={inv.hangout_id}
                  onPress={() => setOpenPlanId(inv.hangout_id)}
                  style={({ pressed }) => [
                    styles.upcomingCard,
                    { borderLeftWidth: 3, borderLeftColor: accent },
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  {others.length > 0 ? (
                    <AvatarStack people={others} size={26} />
                  ) : (
                    <View style={[styles.upcomingDot, { backgroundColor: accent }]} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.upcomingTitle} numberOfLines={1}>
                      {inv.title || 'Plan'}
                    </Text>
                    <Text style={styles.upcomingWhen}>
                      {inv.proposed_start
                        ? new Date(inv.proposed_start).toLocaleString(undefined, {
                            weekday: 'short',
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                          })
                        : 'Time not set yet'}
                      {inv.venue_name ? ` · ${inv.venue_name}` : ''}
                    </Text>
                  </View>
                  <Text style={styles.answerLink}>Answer ›</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {upcoming.length > 0 ? (
          <View style={styles.upcomingSection}>
            <Text style={styles.upcomingHeader}>Upcoming hangouts</Text>
            {upcoming.map((h) => (
              <UpcomingHangout
                key={h.id}
                event={h}
                participants={h.hangout_id ? participants.get(h.hangout_id) : undefined}
                meId={user?.id}
                onOpen={h.hangout_id ? () => setOpenPlanId(h.hangout_id) : undefined}
              />
            ))}
          </View>
        ) : null}
        {curiosityItem ? (
          <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md }}>
            <CuriosityCard item={curiosityItem} onAnswered={refreshCuriosity} />
          </View>
        ) : null}
        <View style={styles.timeline}>
          {HOURS.map((h) => (
            <View key={h} style={styles.hourRow}>
              <Text style={styles.hourLabel}>
                {h.toString().padStart(2, '0')}:00
              </Text>
              <View style={styles.hourLine} />
            </View>
          ))}
          {eventsForSelectedDay.map((ev, i) => {
            // Overlap lane: count earlier events still running when this one
            // starts, and indent so every block stays visible/tappable.
            // (Overlap is a "something's off" signal — don't hide it.)
            let depth = 0;
            for (let j = 0; j < i; j++) {
              const prev = eventsForSelectedDay[j];
              if (
                new Date(prev.end_at) > new Date(ev.start_at) &&
                new Date(prev.start_at) < new Date(ev.end_at)
              ) {
                depth++;
              }
            }
            return (
              <EventBlock
                key={ev.id}
                event={ev}
                indent={Math.min(depth, 3)}
                participants={ev.hangout_id ? participants.get(ev.hangout_id) : undefined}
                meId={user?.id}
                onOpenPlan={ev.hangout_id ? () => setOpenPlanId(ev.hangout_id) : undefined}
                onChange={() => {
                  loadEvents();
                  loadUpcoming();
                }}
              />
            );
          })}
          {sameDay(selectedDate, now) ? (
            <CurrentTimeLine now={now} />
          ) : null}
          {!loading && eventsForSelectedDay.length === 0 ? (
            <View style={styles.emptyHint}>
              <Text style={styles.emptyTitle}>No events yet</Text>
              <Text style={styles.emptyBody}>
                Connect your calendar or talk to your agent to plan something.
              </Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
      <HangoutSheet
        hangoutId={openPlanId}
        onClose={() => setOpenPlanId(null)}
        onChanged={() => {
          loadEvents();
          loadUpcoming();
          loadInvites();
        }}
      />
    </Screen>
  );
}

function CurrentTimeLine({ now }: { now: Date }) {
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  const dayStartMin = HOURS[0] * 60;
  const dayEndMin = (HOURS[HOURS.length - 1] + 1) * 60;
  // Don't render if outside the visible hour range
  if (totalMinutes < dayStartMin || totalMinutes > dayEndMin) return null;
  const top = ((totalMinutes - dayStartMin) / 60) * HOUR_HEIGHT;
  return (
    <View style={[styles.nowLine, { top }]} pointerEvents="none">
      <View style={styles.nowDot} />
      <View style={styles.nowLineBar} />
    </View>
  );
}

function UpcomingHangout({
  event,
  participants,
  meId,
  onOpen,
}: {
  event: CalendarEvent;
  participants?: Participant[];
  meId?: string;
  onOpen?: () => void;
}) {
  const others = participants ? otherParticipants(participants, meId) : [];
  const accent = participants ? planColor(participants, meId) : colors.eventCoordinated;
  const when = new Date(event.start_at).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const openDirections = () => {
    if (!event.location) return;
    const url = `https://maps.google.com/?q=${encodeURIComponent(event.location)}`;
    Linking.openURL(url).catch(() => {});
  };
  return (
    <Pressable
      onPress={onOpen}
      disabled={!onOpen}
      style={({ pressed }) => [styles.upcomingCard, { borderLeftWidth: 3, borderLeftColor: accent }, pressed && { opacity: 0.85 }]}
    >
      {others.length > 0 ? (
        <AvatarStack people={others} size={26} />
      ) : (
        <View style={[styles.upcomingDot, { backgroundColor: accent }]} />
      )}
      <View style={{ flex: 1 }}>
        <Text style={styles.upcomingTitle} numberOfLines={1}>
          {event.title || 'Hangout'}
        </Text>
        <Text style={styles.upcomingWhen}>{when}</Text>
        {event.location ? (
          <Pressable onPress={openDirections} hitSlop={6}>
            <Text style={styles.upcomingVenue} numberOfLines={1}>
              📍 {event.location} · Directions
            </Text>
          </Pressable>
        ) : (
          <Text style={styles.upcomingNoVenue}>No place set yet</Text>
        )}
      </View>
    </Pressable>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

function EventBlock({
  event,
  onChange,
  indent = 0,
  participants,
  meId,
  onOpenPlan,
}: {
  event: CalendarEvent;
  onChange: () => void;
  indent?: number;
  /** Set for coordinated plans: colours the block and shows who's in it. */
  participants?: Participant[];
  meId?: string;
  onOpenPlan?: () => void;
}) {
  const start = new Date(event.start_at);
  const end = new Date(event.end_at);
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end.getHours() * 60 + end.getMinutes();
  const dayStartMin = HOURS[0] * 60;
  const top = ((startMin - dayStartMin) / 60) * HOUR_HEIGHT;
  const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, 28);
  const others = participants ? otherParticipants(participants, meId) : [];
  const accent = participants
    ? planColor(participants, meId)
    : EVENT_COLORS[event.event_type ?? 'fixed'] ?? colors.eventFixed;
  const wasMoved = !!event.original_start_at;
  const isRoutine = event.event_type === 'routine';

  // Routine blocks are inferred — let the user confirm or hide them.
  const onRoutinePress = () => {
    const routineId = event.external_id?.split(':')[0];
    if (!routineId) return;
    Alert.alert(
      event.title || 'Routine',
      "ALINE inferred this from your patterns. Keep it or hide it?",
      [
        {
          text: 'Confirm',
          onPress: async () => {
            await supabase
              .from('routines')
              .update({ inference_status: 'confirmed', active: true })
              .eq('id', routineId);
            onChange();
          },
        },
        {
          text: 'Hide',
          style: 'destructive',
          onPress: async () => {
            await supabase.from('routines').update({ active: false }).eq('id', routineId);
            await supabase
              .from('calendar_events')
              .delete()
              .eq('source', 'routine')
              .like('external_id', `${routineId}:%`);
            onChange();
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const body = (
    <>
      <View style={styles.eventTitleRow}>
        <Text style={styles.eventTitle} numberOfLines={1}>
          {event.title || 'Untitled'}
        </Text>
        {wasMoved ? <Text style={styles.movedBadge}>↔ moved</Text> : null}
        {isRoutine ? <Text style={styles.movedBadge}>inferred</Text> : null}
        {others.length > 0 ? <AvatarStack people={others} size={18} /> : null}
      </View>
      <Text style={styles.eventTime}>
        {formatHM(start)} – {formatHM(end)}
        {wasMoved && event.original_start_at
          ? ` · was ${formatHM(new Date(event.original_start_at))}`
          : ''}
      </Text>
    </>
  );

  const blockStyle = [
    styles.eventBlock,
    { top, height, borderLeftColor: accent, backgroundColor: tint(accent) },
    isRoutine && styles.eventBlockInferred,
    indent > 0 && {
      left: space.lg + 56 + indent * 16,
      zIndex: indent,
      borderWidth: 1,
      borderColor: colors.border,
      borderLeftWidth: 3,
      borderLeftColor: accent,
    },
  ];

  if (isRoutine) {
    return (
      <Pressable onPress={onRoutinePress} style={blockStyle}>
        {body}
      </Pressable>
    );
  }
  if (onOpenPlan) {
    return (
      <Pressable onPress={onOpenPlan} style={blockStyle}>
        {body}
      </Pressable>
    );
  }
  return <View style={blockStyle}>{body}</View>;
}

function tint(hex: string): string {
  // Cheap visual tint — just append low-alpha hex. Works because we use 6-char colors.
  return `${hex}22`;
}

function formatHM(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

const styles = StyleSheet.create({
  answerLink: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  header: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  refreshBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  refreshBtnText: { color: colors.accent, fontWeight: '600', fontSize: 12 },
  todayBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accentDim,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  todayBtnText: { color: colors.accent, fontWeight: '700', fontSize: 12 },
  weekNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.xs,
    gap: 2,
  },
  weekNavBtn: {
    width: 32,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekNavText: {
    color: colors.textMuted,
    fontSize: 28,
    fontWeight: '300',
    lineHeight: 30,
  },
  title: {
    fontSize: font.size.xxl,
    fontWeight: '700',
    color: colors.text,
  },
  dateLine: {
    fontSize: font.size.sm,
    color: colors.textMuted,
  },
  daysRow: {
    flex: 1,
    flexDirection: 'row',
    gap: space.xs,
  },
  dayCell: {
    flex: 1,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  dayCellSelected: {
    backgroundColor: colors.bgElevated,
    borderColor: colors.accentDim,
  },
  dayLabel: {
    fontSize: 11,
    color: colors.textDim,
    fontWeight: '500',
    letterSpacing: 0.5,
  },
  dayLabelSelected: { color: colors.accent },
  dayLabelToday: { color: colors.accent2 },
  dayDate: {
    fontSize: 18,
    color: colors.textMuted,
    fontWeight: '600',
    marginTop: 2,
  },
  dayDateSelected: { color: colors.accent },
  dayDateToday: { color: colors.accent2 },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    columnGap: space.md,
    rowGap: 4,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: colors.textMuted, fontSize: 11 },
  scrollBody: { paddingBottom: space.xxxl },
  upcomingSection: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    gap: space.xs,
  },
  upcomingHeader: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: space.xs,
  },
  upcomingCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    backgroundColor: colors.bgRaised,
    borderRadius: radius.md,
    padding: space.md,
  },
  upcomingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 5,
  },
  upcomingTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  upcomingWhen: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 1,
  },
  upcomingVenue: {
    color: colors.accent,
    fontSize: 12,
    marginTop: 3,
  },
  upcomingNoVenue: {
    color: colors.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 3,
  },
  timeline: {
    paddingHorizontal: space.lg,
    position: 'relative',
  },
  hourRow: {
    height: HOUR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  hourLabel: {
    width: 48,
    fontSize: 11,
    color: colors.textDim,
    paddingTop: 2,
  },
  hourLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginTop: 8,
  },
  eventBlock: {
    position: 'absolute',
    left: space.lg + 56,
    right: space.lg,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderLeftWidth: 3,
    justifyContent: 'center',
  },
  // NOTE: borderStyle:'dashed' + a single-side border renders NO border on iOS
  // (RN quirk) — routine blocks lost their color bar entirely. Solid bar +
  // opacity + the "inferred" badge carry the tentative look instead.
  eventBlockInferred: {
    opacity: 0.75,
  },
  eventTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  eventTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
  },
  movedBadge: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '600',
    backgroundColor: colors.accentDim,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  eventTime: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 1,
  },
  emptyHint: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 6 * HOUR_HEIGHT,
    alignItems: 'center',
    padding: space.lg,
    gap: 4,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  emptyBody: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
  },
  nowLine: {
    position: 'absolute',
    left: space.lg + 48,
    right: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 10,
  },
  nowDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.danger,
    marginLeft: -5,
  },
  nowLineBar: {
    flex: 1,
    height: 2,
    backgroundColor: colors.danger,
    opacity: 0.85,
  },
});
