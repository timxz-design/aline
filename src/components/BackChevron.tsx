/**
 * Small back-navigation affordance for screens that don't show a header.
 * Renders a 32x32 hit-target with a subtle "‹" chevron in the top-left.
 *
 * Uses router.back() — falls through to the OS-level back gesture if the
 * Stack has no parent on iOS (rare). Hidden via canGoBack() so it doesn't
 * appear on the very first screen of a stack.
 */

import { useRouter } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, space } from '../theme';

export function BackChevron() {
  const router = useRouter();
  if (!router.canGoBack()) return null;
  return (
    <Pressable
      onPress={() => router.back()}
      hitSlop={12}
      style={({ pressed }) => [styles.btn, pressed && { opacity: 0.6 }]}
      accessibilityRole="button"
      accessibilityLabel="Go back"
    >
      <Ionicons name="chevron-back" size={22} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
    marginLeft: -space.xs, // align glyph with screen padding
  },
});
