import { StyleSheet, Text, View } from 'react-native';

/**
 * A person's initial on a colour that is always the same for that person
 * (derived from their user id), so "who is this?" is answerable at a glance
 * anywhere they appear — friends, invites, group members, hangout cards.
 *
 * Deliberately plain: initials age well for every user, where cartoon avatars
 * read oddly on adults. All palette colours are dark enough for white text.
 */
const PALETTE = [
  '#1E6091', // ocean (teal is reserved for group plans)
  '#3D5A99', // indigo
  '#8A4F7D', // plum
  '#B5543C', // terracotta
  '#5E7D2E', // olive
  '#9A6B12', // ochre
  '#4F6D7A', // slate
  '#7A4E9E', // violet
  '#A23E5A', // raspberry
  '#2F7A4F', // green
];

export function avatarColor(id: string | null | undefined): string {
  if (!id) return PALETTE[6];
  // FNV-1a — stable across platforms and app versions.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return PALETTE[(h >>> 0) % PALETTE.length];
}

export function PersonAvatar({
  id,
  name,
  size = 36,
}: {
  id: string | null | undefined;
  /** First name, display name or handle — the first letter is shown. */
  name: string | null | undefined;
  size?: number;
}) {
  const initial = (name?.replace(/^@/, '').trim()[0] ?? '?').toUpperCase();
  return (
    <View
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: avatarColor(id) },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Text style={[styles.initial, { fontSize: Math.round(size * 0.42) }]}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  initial: { color: '#FFFFFF', fontWeight: '700' },
});
