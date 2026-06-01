import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CalendarReconnectBanner } from '../../src/components/CalendarReconnectBanner';
import { CuriosityCard } from '../../src/components/CuriosityCard';
import { MorningPanel } from '../../src/components/MorningPanel';
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
      await loadEvents();
    } finally {
      setSyncing(false);
    }
  }, [loadEvents]);

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
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollBody}
        showsVerticalScrollIndicator={false}
      >
        <CalendarReconnectBanner />
        <MorningPanel />
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
          {eventsForSelectedDay.map((ev) => (
            <EventBlock key={ev.id} event={ev} />
          ))}
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

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

function EventBlock({ event }: { event: CalendarEvent }) {
  const start = new Date(event.start_at);
  const end = new Date(event.end_at);
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end.getHours() * 60 + end.getMinutes();
  const dayStartMin = HOURS[0] * 60;
  const top = ((startMin - dayStartMin) / 60) * HOUR_HEIGHT;
  const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, 28);
  const accent = EVENT_COLORS[event.event_type ?? 'fixed'] ?? colors.eventFixed;
  const wasMoved = !!event.original_start_at;

  return (
    <View
      style={[
        styles.eventBlock,
        { top, height, borderLeftColor: accent, backgroundColor: tint(accent) },
      ]}
    >
      <View style={styles.eventTitleRow}>
        <Text style={styles.eventTitle} numberOfLines={1}>
          {event.title || 'Untitled'}
        </Text>
        {wasMoved ? <Text style={styles.movedBadge}>↔ moved</Text> : null}
      </View>
      <Text style={styles.eventTime}>
        {formatHM(start)} – {formatHM(end)}
        {wasMoved && event.original_start_at
          ? ` · was ${formatHM(new Date(event.original_start_at))}`
          : ''}
      </Text>
    </View>
  );
}

function tint(hex: string): string {
  // Cheap visual tint — just append low-alpha hex. Works because we use 6-char colors.
  return `${hex}22`;
}

function formatHM(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

const styles = StyleSheet.create({
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
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.lg,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: colors.textMuted, fontSize: 11 },
  scrollBody: { paddingBottom: space.xxxl },
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
