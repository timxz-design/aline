import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useState, type ReactNode } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space } from '../theme';

/**
 * A tappable header that reveals its content — the building block of the
 * You tab, so every section stays closed (one line each) until asked for.
 *
 *   variant 'section' — a card-like row with title + one-line summary
 *   variant 'inline'  — a lighter row for nesting inside an open section
 */
export function Collapsible({
  title,
  summary,
  badge,
  defaultOpen = false,
  variant = 'section',
  children,
}: {
  title: string;
  summary?: string;
  /** Small accent pill, for things that want attention (e.g. pending requests). */
  badge?: string;
  defaultOpen?: boolean;
  variant?: 'section' | 'inline';
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const section = variant === 'section';

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    Haptics.selectionAsync().catch(() => {});
    setOpen((o) => !o);
  };

  return (
    <View style={section ? styles.sectionWrap : styles.inlineWrap}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [section ? styles.sectionHeader : styles.inlineHeader, pressed && { opacity: 0.7 }]}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={section ? styles.sectionTitle : styles.inlineTitle}>{title}</Text>
          {summary && !open ? (
            <Text style={styles.summary} numberOfLines={1}>{summary}</Text>
          ) : null}
        </View>
        {badge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        ) : null}
        <Ionicons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={section ? 18 : 15}
          color={colors.textDim}
        />
      </Pressable>
      {open ? <View style={section ? styles.sectionBody : styles.inlineBody}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionWrap: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 56,
  },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  sectionBody: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.sm },

  inlineWrap: {},
  inlineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
  },
  inlineTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  inlineBody: { paddingBottom: space.sm, gap: 6 },

  summary: { color: colors.textMuted, fontSize: 13 },
  badge: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: { color: colors.textInverse, fontSize: 11, fontWeight: '700' },
});
