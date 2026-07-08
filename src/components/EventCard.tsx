import { Alert, Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, space } from '../theme';
import { goToLocalEvent, forceGoToLocalEvent } from '../lib/use-local-events';
import type { LocalEvent } from '../types/database';

/**
 * Compact event card for the chat thread — the agent's reply stays one line;
 * this carries the details (poster, when/where, I'm going / Map). Shared look
 * with the Events screen cards, sized for the conversation column.
 */
export function EventCard({
  event: e,
  userId,
  going,
  onChanged,
  onImagePress,
  onSeedAgent,
}: {
  event: LocalEvent;
  userId: string;
  going: boolean;
  onChanged: () => void;
  onImagePress?: (uri: string) => void;
  onSeedAgent?: (text: string) => void;
}) {
  const start = new Date(e.starts_at);
  const when = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    + ' · '
    + start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const meta = [when, e.venue_text, e.price_text].filter(Boolean).join(' · ');

  const openMap = () => {
    const url =
      e.lat != null && e.lon != null
        ? `https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lon}`
        : e.venue_text
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.venue_text)}`
          : null;
    if (url) Linking.openURL(url);
  };

  const go = async () => {
    const res = await goToLocalEvent(userId, e);
    if (res.status === 'added') {
      onChanged();
      return;
    }
    if (res.status === 'clash') {
      Alert.alert('Schedule clash', `"${res.conflictTitle}" overlaps this event.`, [
        {
          text: 'Let ALINE sort it',
          onPress: () =>
            onSeedAgent?.(
              `I want to go to "${e.title}" (${e.venue_text ?? ''}) starting ${e.starts_at}, but it clashes with "${res.conflictTitle}". Help me rearrange things so I can make it.`,
            ),
        },
        {
          text: 'Add anyway',
          onPress: async () => {
            const r = await forceGoToLocalEvent(userId, e);
            if (r.status === 'error') Alert.alert('Could not add', r.message);
            else onChanged();
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
      return;
    }
    Alert.alert('Could not add', res.message);
  };

  return (
    <View style={styles.card}>
      {e.image_url ? (
        <Pressable onPress={() => onImagePress?.(e.image_url!)} accessibilityLabel="View poster full screen">
          <Image source={{ uri: e.image_url }} style={styles.poster} resizeMode="cover" />
        </Pressable>
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.title} numberOfLines={2}>{e.title}</Text>
        <Text style={styles.meta}>{meta}</Text>
        {e.description ? (
          <Text style={styles.desc} numberOfLines={2}>{e.description}</Text>
        ) : null}
        <View style={styles.actions}>
          <Pressable
            onPress={going ? undefined : go}
            style={({ pressed }) => [styles.goBtn, going && styles.goBtnGoing, pressed && { opacity: 0.85 }]}
          >
            <Text style={[styles.goBtnText, going && styles.goBtnTextGoing]}>
              {going ? '✓ Going' : "I'm going"}
            </Text>
          </Pressable>
          {e.venue_text || e.lat != null ? (
            <Pressable onPress={openMap} hitSlop={6} style={styles.linkBtn}>
              <Text style={styles.linkText}>Map</Text>
            </Pressable>
          ) : null}
          {e.url ? (
            <Pressable onPress={() => Linking.openURL(e.url!)} hitSlop={6} style={styles.linkBtn}>
              <Text style={styles.linkText}>Info</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: space.sm,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    maxWidth: '88%',
  },
  poster: {
    width: 56,
    height: 76,
    borderRadius: radius.sm,
    backgroundColor: colors.bgRaised,
  },
  title: { color: colors.text, fontSize: font.size.md, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: font.size.sm },
  desc: { color: colors.textDim, fontSize: font.size.sm },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs },
  goBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
  goBtnGoing: {
    backgroundColor: colors.accentDim,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  goBtnText: { color: colors.textInverse, fontSize: font.size.xs, fontWeight: '700' },
  goBtnTextGoing: { color: colors.accent },
  linkBtn: { paddingHorizontal: space.xs, paddingVertical: 4 },
  linkText: { color: colors.accent, fontSize: font.size.xs, fontWeight: '600' },
});
