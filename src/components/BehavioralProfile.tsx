/**
 * "What ALINE knows about you" — the trust principle made visible.
 *
 * Renders three subsections:
 *   - Archetype card: the behavioral_summary one-liner + chronotype + sleep window
 *   - Places list: every clustered location, with hide / show / delete controls
 *   - Routines list: every detected pattern, with confirm / reject controls
 *
 * Every fact ALINE has inferred is shown here. The user can always edit or
 * remove anything.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { colors, font, radius, space } from '../theme';
import {
  confirmRoutine,
  deletePlace,
  hidePlace,
  rejectRoutine,
  unhidePlace,
  useBehavioralProfile,
  type Place,
  type Routine,
} from '../lib/use-behavioral-profile';

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatMinute(m: number | null): string {
  if (m == null) return '—';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function categoryLabel(category: string | null): string {
  if (!category) return 'place';
  return category;
}

/** Category symbol — single char to keep things clean without an icon library. */
function categorySymbol(category: string | null): string {
  switch (category) {
    case 'home': return '⌂';
    case 'food': return '○';
    case 'gym': return '◆';
    case 'education': return '◊';
    case 'work': return '▣';
    case 'shopping': return '▤';
    case 'transit': return '→';
    case 'outdoors': return '▲';
    case 'social': return '◐';
    case 'health': return '✚';
    case 'religion': return '✦';
    case 'legal': return '§';
    case 'funeral': return '✝';
    default: return '•';
  }
}

export function BehavioralProfile() {
  const { places, routines, summary, loading, refresh } = useBehavioralProfile();
  const [showHidden, setShowHidden] = useState(false);

  // Refresh on focus — covers the case where the user just clicked one of the
  // pipeline buttons and we need to re-fetch.
  useEffect(() => {
    refresh();
  }, []);

  if (loading) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>Loading…</Text>
      </View>
    );
  }

  const visiblePlaces = showHidden ? places : places.filter((p) => !p.is_hidden);
  const hiddenCount = places.length - places.filter((p) => !p.is_hidden).length;
  const activeRoutines = routines.filter((r) => r.active);

  if (places.length === 0 && routines.length === 0 && !summary?.archetype_text) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>
          ALINE hasn't learned enough yet. Once GPS pings accumulate (a few days
          of normal life), tap the pipeline buttons below to populate this section.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: space.md }}>
      {/* Archetype card */}
      {summary?.archetype_text ? (
        <View style={styles.archetypeCard}>
          <Text style={styles.archetypeLabel}>Archetype</Text>
          <Text style={styles.archetypeText}>{summary.archetype_text}</Text>
          <View style={styles.archetypeMetaRow}>
            <DataQualityBadge quality={summary.data_quality} />
            {summary.waketime_minute != null && summary.bedtime_minute != null ? (
              <Text style={styles.archetypeMetaText}>
                Sleep window: {formatMinute(summary.waketime_minute)}–{formatMinute(summary.bedtime_minute)}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {/* Places */}
      {places.length > 0 ? (
        <View>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>
              Places ({visiblePlaces.length}
              {hiddenCount > 0 ? ` + ${hiddenCount} hidden` : ''})
            </Text>
            {hiddenCount > 0 ? (
              <Pressable onPress={() => setShowHidden((v) => !v)}>
                <Text style={styles.linkText}>
                  {showHidden ? 'Hide hidden' : 'Show hidden'}
                </Text>
              </Pressable>
            ) : null}
          </View>
          <View style={{ gap: space.xs }}>
            {visiblePlaces.map((place) => (
              <PlaceRow key={place.id} place={place} onChange={refresh} />
            ))}
          </View>
        </View>
      ) : null}

      {/* Routines */}
      {activeRoutines.length > 0 ? (
        <View>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>
              Routines ({activeRoutines.length})
            </Text>
          </View>
          <View style={{ gap: space.xs }}>
            {activeRoutines.map((routine) => (
              <RoutineRow
                key={routine.id}
                routine={routine}
                placeName={
                  places.find((p) => p.id === routine.place_id)?.user_label
                  ?? places.find((p) => p.id === routine.place_id)?.name
                  ?? 'unlabelled place'
                }
                onChange={refresh}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ---------- place row -------------------------------------------------------

function PlaceRow({ place, onChange }: { place: Place; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const displayName = place.user_label ?? place.name ?? 'Unlabelled place';

  const onHideToggle = useCallback(async () => {
    setBusy(true);
    const result = place.is_hidden ? await unhidePlace(place.id) : await hidePlace(place.id);
    setBusy(false);
    if (result.error) Alert.alert('Failed', result.error);
    else onChange();
  }, [place, onChange]);

  const onDelete = useCallback(() => {
    Alert.alert(
      'Delete place?',
      `Permanently remove "${displayName}". ALINE will re-cluster this from future pings unless you also avoid the location.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            const result = await deletePlace(place.id);
            setBusy(false);
            if (result.error) Alert.alert('Failed', result.error);
            else onChange();
          },
        },
      ],
    );
  }, [place, displayName, onChange]);

  return (
    <View style={[styles.row, place.is_hidden && styles.rowHidden]}>
      <Text style={styles.symbol}>{categorySymbol(place.category)}</Text>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.rowTitleRow}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {displayName}
          </Text>
          {place.is_sensitive ? <Badge label="sensitive" muted /> : null}
        </View>
        <Text style={styles.rowMeta}>
          {categoryLabel(place.category)} · {place.visit_count} visit{place.visit_count === 1 ? '' : 's'}
        </Text>
      </View>
      <Pressable onPress={onHideToggle} disabled={busy} hitSlop={6} style={styles.action}>
        <Text style={styles.actionText}>{place.is_hidden ? 'Unhide' : 'Hide'}</Text>
      </Pressable>
      <Pressable onPress={onDelete} disabled={busy} hitSlop={6} style={styles.action}>
        <Text style={[styles.actionText, { color: colors.danger }]}>Delete</Text>
      </Pressable>
    </View>
  );
}

// ---------- routine row -----------------------------------------------------

function RoutineRow({
  routine,
  placeName,
  onChange,
}: {
  routine: Routine;
  placeName: string;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const dow = routine.day_of_week != null ? DOW_NAMES[routine.day_of_week] : '?';
  const timeWindow =
    routine.start_minute != null && routine.end_minute != null
      ? `${formatMinute(routine.start_minute)}–${formatMinute(routine.end_minute)}`
      : '';
  const consistencyPct = routine.consistency != null
    ? Math.round(routine.consistency * 100)
    : 0;

  const isConfirmed = routine.inference_status === 'confirmed';

  const onConfirm = useCallback(async () => {
    setBusy(true);
    const result = await confirmRoutine(routine.id);
    setBusy(false);
    if (result.error) Alert.alert('Failed', result.error);
    else onChange();
  }, [routine, onChange]);

  const onReject = useCallback(() => {
    Alert.alert(
      'Not really?',
      "ALINE will stop using this routine. It'll keep watching new patterns from your pings.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: "Not really",
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            const result = await rejectRoutine(routine.id);
            setBusy(false);
            if (result.error) Alert.alert('Failed', result.error);
            else onChange();
          },
        },
      ],
    );
  }, [routine, onChange]);

  return (
    <View style={styles.row}>
      <Text style={styles.symbol}>{categorySymbol(routine.category)}</Text>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.rowTitleRow}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {placeName} · {dow} {timeWindow}
          </Text>
          {isConfirmed ? <Badge label="confirmed" /> : null}
        </View>
        <Text style={styles.rowMeta}>
          {consistencyPct}% consistency
        </Text>
      </View>
      {!isConfirmed ? (
        <Pressable onPress={onConfirm} disabled={busy} hitSlop={6} style={styles.action}>
          <Text style={[styles.actionText, { color: colors.accent }]}>Yes</Text>
        </Pressable>
      ) : null}
      <Pressable onPress={onReject} disabled={busy} hitSlop={6} style={styles.action}>
        <Text style={[styles.actionText, { color: colors.danger }]}>Not really</Text>
      </Pressable>
    </View>
  );
}

// ---------- small bits ------------------------------------------------------

function Badge({ label, muted }: { label: string; muted?: boolean }) {
  return (
    <View style={[styles.badge, muted && styles.badgeMuted]}>
      <Text style={[styles.badgeText, muted && styles.badgeTextMuted]}>{label}</Text>
    </View>
  );
}

function DataQualityBadge({ quality }: { quality: 'none' | 'low' | 'medium' | 'high' }) {
  const labelColor: Record<string, ViewStyle['backgroundColor']> = {
    none: colors.bgRaised,
    low: colors.accent2Dim,
    medium: colors.accent2Dim,
    high: colors.accentDim,
  };
  return (
    <View style={[styles.badge, { backgroundColor: labelColor[quality] }]}>
      <Text style={styles.badgeText}>{quality} data</Text>
    </View>
  );
}

// ---------- styles ----------------------------------------------------------

const styles = StyleSheet.create({
  empty: {
    padding: space.lg,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    lineHeight: 18,
  },
  archetypeCard: {
    backgroundColor: colors.accentDim,
    padding: space.lg,
    borderRadius: radius.md,
    gap: space.sm,
  },
  archetypeLabel: {
    color: colors.accent,
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  archetypeText: {
    color: colors.text,
    fontSize: font.size.md,
    fontWeight: font.weight.medium,
    lineHeight: 22,
  },
  archetypeMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexWrap: 'wrap',
  },
  archetypeMetaText: {
    color: colors.textMuted,
    fontSize: font.size.xs,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.sm,
  },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  linkText: {
    color: colors.accent,
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgElevated,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    gap: space.sm,
  },
  rowHidden: {
    opacity: 0.5,
  },
  symbol: {
    color: colors.accent,
    fontSize: font.size.lg,
    width: 22,
    textAlign: 'center',
  },
  rowTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  rowTitle: {
    color: colors.text,
    fontSize: font.size.sm,
    fontWeight: font.weight.medium,
    flexShrink: 1,
  },
  rowMeta: {
    color: colors.textDim,
    fontSize: font.size.xs,
  },
  action: {
    paddingHorizontal: space.xs,
    paddingVertical: 2,
  },
  actionText: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.accentDim,
  },
  badgeMuted: {
    backgroundColor: colors.bgRaised,
  },
  badgeText: {
    color: colors.accent,
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold,
  },
  badgeTextMuted: {
    color: colors.textMuted,
  },
});
