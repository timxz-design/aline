import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Children, Fragment, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, space } from '../theme';
import { Screen } from './Screen';

/**
 * Apple Settings–style building blocks for the You tab: grouped white lists
 * with hairline separators, rows that push a detail screen, and a detail-screen
 * shell (back + large title). Rows open screens — nothing expands in place.
 */

type IconName = ComponentProps<typeof Ionicons>['name'];

export function DetailScreen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <Screen noPadding>
      <ScrollView contentContainerStyle={styles.detailBody}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}
          accessibilityRole="button"
          accessibilityLabel="Back to You"
        >
          <Ionicons name="chevron-back" size={22} color={colors.accent} />
          <Text style={styles.backText}>You</Text>
        </Pressable>
        <Text style={styles.detailTitle}>{title}</Text>
        {subtitle ? <Text style={styles.detailSubtitle}>{subtitle}</Text> : null}
        <View style={{ gap: space.lg, marginTop: space.md }}>{children}</View>
      </ScrollView>
    </Screen>
  );
}

/** A labelled white group; children are separated by hairlines. */
export function Group({
  label,
  footer,
  children,
}: {
  label?: string;
  footer?: string;
  children: ReactNode;
}) {
  const items = Children.toArray(children).filter(isValidElement);
  if (items.length === 0) return null;
  return (
    <View>
      {label ? <Text style={styles.groupLabel}>{label}</Text> : null}
      <View style={styles.group}>
        {items.map((child, i) => (
          <Fragment key={(child.key as string) ?? i}>
            {i > 0 ? <View style={styles.sep} /> : null}
            {child}
          </Fragment>
        ))}
      </View>
      {footer ? <Text style={styles.groupFooter}>{footer}</Text> : null}
    </View>
  );
}

export function Row({
  icon,
  iconColor = colors.textDim,
  title,
  subtitle,
  value,
  valueTone = 'muted',
  badge,
  onPress,
  chevron = !!onPress,
  right,
  titleLines = 1,
}: {
  icon?: IconName;
  iconColor?: string;
  title: string;
  subtitle?: string;
  value?: string;
  valueTone?: 'muted' | 'warning' | 'accent';
  badge?: number;
  onPress?: () => void;
  chevron?: boolean;
  right?: ReactNode;
  titleLines?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.bgRaised }]}
      accessibilityRole={onPress ? 'button' : undefined}
    >
      {icon ? (
        <View style={[styles.iconTile, { backgroundColor: iconColor }]}>
          <Ionicons name={icon} size={16} color={colors.textInverse} />
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={titleLines}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {badge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
      {value ? (
        <Text
          style={[
            styles.rowValue,
            valueTone === 'warning' && { color: colors.warning },
            valueTone === 'accent' && { color: colors.accent },
          ]}
          numberOfLines={1}
        >
          {value}
        </Text>
      ) : null}
      {right}
      {chevron ? <Ionicons name="chevron-forward" size={16} color={colors.border} /> : null}
    </Pressable>
  );
}

/** Calm empty line inside a group. */
export function EmptyRow({ text }: { text: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  detailBody: { padding: space.lg, paddingTop: space.sm, paddingBottom: space.xxxl },
  back: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginLeft: -6, marginBottom: space.xs },
  backText: { color: colors.accent, fontSize: font.size.md },
  detailTitle: { color: colors.text, fontSize: font.size.xxl, fontWeight: '700' },
  detailSubtitle: { color: colors.textMuted, fontSize: font.size.sm, lineHeight: 18, marginTop: 4 },

  groupLabel: { color: colors.textDim, fontSize: 12, marginLeft: space.md, marginBottom: 6 },
  group: { backgroundColor: colors.bgElevated, borderRadius: radius.lg, overflow: 'hidden' },
  groupFooter: { color: colors.textDim, fontSize: 12, lineHeight: 16, marginHorizontal: space.md, marginTop: 6 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: space.md },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 11,
    minHeight: 46,
  },
  iconTile: { width: 28, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { color: colors.text, fontSize: font.size.md },
  rowSubtitle: { color: colors.textMuted, fontSize: 12, lineHeight: 16 },
  rowValue: { color: colors.textDim, fontSize: font.size.sm, maxWidth: 150 },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.textInverse, fontSize: 12, fontWeight: '700' },
  emptyText: { color: colors.textDim, fontSize: font.size.sm },
});
