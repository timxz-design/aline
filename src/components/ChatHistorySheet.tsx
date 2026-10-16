import { Ionicons } from '@expo/vector-icons';
import { useMemo, type ReactElement } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ChatMessage } from '../types/database';
import { colors, font, radius, space } from '../theme';

/**
 * Past conversations, one per local day — opened from the History button in
 * the chat header, so the main chat only ever shows today. First a list of
 * days (newest first, with a preview), then the chosen day's messages.
 */

type Day = { key: string; label: string; preview: string; count: number; messages: ChatMessage[] };

export function groupByDay(messages: ChatMessage[]): Day[] {
  const byKey = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    const key = new Date(m.created_at ?? 0).toDateString();
    const list = byKey.get(key) ?? [];
    list.push(m);
    byKey.set(key, list);
  }
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const thisYear = new Date().getFullYear();
  return [...byKey.entries()]
    .map(([key, msgs]) => {
      const d = new Date(key);
      const label =
        key === yesterday
          ? 'Yesterday'
          : d.toLocaleDateString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              ...(d.getFullYear() === thisYear ? {} : { year: 'numeric' }),
            });
      const first = msgs.find((m) => m.role === 'user') ?? msgs[0];
      return {
        key,
        label,
        preview: (first?.content ?? '').replace(/\s+/g, ' ').trim(),
        count: msgs.length,
        messages: msgs,
      };
    })
    .sort((a, b) => new Date(b.key).getTime() - new Date(a.key).getTime());
}

export function ChatHistorySheet({
  visible,
  messages,
  openDayKey,
  onOpenDay,
  onClose,
  renderMessage,
}: {
  visible: boolean;
  /** Everything before today. */
  messages: ChatMessage[];
  /** Day being viewed (null = the list of days). */
  openDayKey: string | null;
  onOpenDay: (key: string | null) => void;
  onClose: () => void;
  renderMessage: (m: ChatMessage) => ReactElement;
}) {
  const days = useMemo(() => groupByDay(messages), [messages]);
  const day = openDayKey ? days.find((d) => d.key === openDayKey) ?? null : null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <View style={styles.topBar}>
          {day ? (
            <Pressable onPress={() => onOpenDay(null)} hitSlop={12} style={styles.back} accessibilityLabel="All conversations">
              <Ionicons name="chevron-back" size={22} color={colors.accent} />
              <Text style={styles.backText}>All</Text>
            </Pressable>
          ) : (
            <View style={styles.back} />
          )}
          <Text style={styles.title} numberOfLines={1}>
            {day ? day.label : 'Past conversations'}
          </Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close">
            <Ionicons name="close" size={24} color={colors.textMuted} />
          </Pressable>
        </View>

        {day ? (
          <FlatList
            data={day.messages}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => renderMessage(item)}
            ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
            contentContainerStyle={styles.dayBody}
          />
        ) : days.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No earlier conversations yet.</Text>
          </View>
        ) : (
          <FlatList
            data={days}
            keyExtractor={(d) => d.key}
            contentContainerStyle={styles.list}
            ItemSeparatorComponent={() => <View style={styles.sep} />}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => onOpenDay(item.key)}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.bgRaised }]}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.rowDate}>{item.label}</Text>
                  <Text style={styles.rowPreview} numberOfLines={2}>
                    {item.preview || '—'}
                  </Text>
                </View>
                <Text style={styles.rowCount}>{item.count}</Text>
                <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
              </Pressable>
            )}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  back: { flexDirection: 'row', alignItems: 'center', minWidth: 56 },
  backText: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  title: { flex: 1, textAlign: 'center', color: colors.text, fontSize: font.size.lg, fontWeight: '700' },
  list: { paddingVertical: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 64,
  },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: space.lg },
  rowDate: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowPreview: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  rowCount: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '600',
    backgroundColor: colors.bgRaised,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  dayBody: { padding: space.lg, paddingBottom: space.xxxl },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: colors.textMuted, fontSize: 14 },
});
