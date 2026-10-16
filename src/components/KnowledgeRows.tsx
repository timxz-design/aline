/**
 * Rows for the You tab's "About you" screens — places and routines ALINE has
 * learned, each correctable (trust principle #3: every inferred fact is
 * visible and editable). Tapping a row opens its actions; nothing is edited
 * inline, so the lists stay calm.
 */

import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text } from 'react-native';
import { decodeGeohash } from '../lib/clustering';
import {
  confirmPlace,
  confirmRoutine,
  deletePlace,
  hidePlace,
  rejectRoutine,
  renamePlace,
  unhidePlace,
  type Place,
  type Routine,
} from '../lib/use-behavioral-profile';
import { colors, font, radius, space } from '../theme';
import { Row } from './settings-ui';

type IconName = ComponentProps<typeof Ionicons>['name'];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatMinute(m: number | null): string {
  if (m == null) return '—';
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function placeIcon(category: string | null): IconName {
  switch (category) {
    case 'home': return 'home';
    case 'food': return 'restaurant';
    case 'gym': return 'barbell';
    case 'education': return 'school';
    case 'work': return 'briefcase';
    case 'shopping': return 'cart';
    case 'transit': return 'bus';
    case 'outdoors': return 'leaf';
    case 'social': return 'people';
    case 'health': return 'medkit';
    default: return 'location';
  }
}

export function placeName(p: Pick<Place, 'user_label' | 'name' | 'category'>): string {
  if (p.user_label) return p.user_label;
  if (p.name) return p.name;
  if (p.category === 'home') return 'Home';
  return p.category ? p.category.charAt(0).toUpperCase() + p.category.slice(1) : 'Unnamed place';
}

export function isPlaceConfirmed(p: Place): boolean {
  return p.inference_status !== 'pending' || !!p.user_label;
}

async function run(fn: () => Promise<{ error?: string }>, onChange: () => void) {
  const r = await fn();
  if (r.error) Alert.alert("Couldn't save", r.error);
  else onChange();
}

export function PlaceRow({ place, onChange }: { place: Place; onChange: () => void }) {
  const confirmed = isPlaceConfirmed(place);
  const name = placeName(place);
  const visits = `${place.visit_count} visit${place.visit_count === 1 ? '' : 's'}`;

  const rename = () =>
    Alert.prompt(
      'Name this place',
      undefined,
      (text) => {
        const label = text?.trim();
        if (label) run(() => renamePlace(place.id, label), onChange);
      },
      'plain-text',
      place.user_label ?? place.name ?? '',
    );

  const openMap = () => {
    const { lat, lon } = decodeGeohash(place.geohash_7);
    Linking.openURL(`https://maps.apple.com/?ll=${lat.toFixed(5)},${lon.toFixed(5)}&q=${encodeURIComponent(name)}`);
  };

  const remove = () =>
    Alert.alert('Delete this place?', `ALINE forgets "${name}". It may learn it again if you keep going there.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => run(() => deletePlace(place.id), onChange) },
    ]);

  const actions = () =>
    Alert.alert(name, `${place.category ?? 'Place'} · ${visits}`, [
      ...(confirmed ? [] : [{ text: "Yes, that's right", onPress: () => run(() => confirmPlace(place.id), onChange) }]),
      { text: 'Rename', onPress: rename },
      { text: 'Show on map', onPress: openMap },
      place.is_hidden
        ? { text: 'Unhide', onPress: () => run(() => unhidePlace(place.id), onChange) }
        : { text: 'Hide from ALINE', onPress: () => run(() => hidePlace(place.id), onChange) },
      { text: 'Delete', style: 'destructive' as const, onPress: remove },
      { text: 'Cancel', style: 'cancel' as const },
    ]);

  return (
    <Row
      icon={confirmed ? placeIcon(place.category) : 'help'}
      iconColor={place.is_hidden ? colors.textDim : confirmed ? colors.accent : colors.warning}
      title={confirmed ? name : `${name}?`}
      subtitle={[place.category && place.category !== name.toLowerCase() ? place.category : null, visits, place.is_sensitive ? 'sensitive' : null]
        .filter(Boolean)
        .join(' · ')}
      onPress={actions}
      chevron={confirmed}
      right={
        confirmed ? undefined : (
          <Pressable
            onPress={() => run(() => confirmPlace(place.id), onChange)}
            hitSlop={8}
            style={({ pressed }) => [styles.confirmBtn, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.confirmText}>Confirm</Text>
          </Pressable>
        )
      }
    />
  );
}

/** Routines that are real enough to show: confirmed, or ≥65% consistent. */
export function isDisplayRoutine(r: Routine): boolean {
  return r.active && (r.inference_status === 'confirmed' || (r.consistency ?? 0) >= 0.65);
}

export type RoutineGroup = {
  key: string;
  ids: string[];
  placeId: string | null;
  category: string | null;
  days: number[];
  start: number | null;
  end: number | null;
  consistency: number;
  confirmed: boolean;
};

/** Merge per-weekday routines at the same place and roughly the same hours
 *  ("Mon 8–15", "Tue 8–15", …) into one line: "Mon–Fri 08:00–15:00". */
export function groupRoutines(routines: Routine[]): RoutineGroup[] {
  const round = (m: number | null) => (m == null ? 'x' : String(Math.round(m / 30)));
  const map = new Map<string, RoutineGroup>();
  for (const r of routines) {
    const key = `${r.place_id ?? r.category}|${round(r.start_minute)}|${round(r.end_minute)}`;
    const g = map.get(key);
    if (g) {
      g.ids.push(r.id);
      if (r.day_of_week != null && !g.days.includes(r.day_of_week)) g.days.push(r.day_of_week);
      g.consistency = Math.max(g.consistency, r.consistency ?? 0);
      g.confirmed = g.confirmed && r.inference_status === 'confirmed';
    } else {
      map.set(key, {
        key,
        ids: [r.id],
        placeId: r.place_id,
        category: r.category,
        days: r.day_of_week != null ? [r.day_of_week] : [],
        start: r.start_minute,
        end: r.end_minute,
        consistency: r.consistency ?? 0,
        confirmed: r.inference_status === 'confirmed',
      });
    }
  }
  return [...map.values()].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

/** "Mon–Fri", "Sat, Sun", "Every day". Week starts Monday. */
export function formatDays(days: number[]): string {
  if (days.length === 7) return 'Every day';
  const order = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const idx = order.map((d) => (d + 6) % 7);
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (order.length >= 3 && contiguous) return `${DOW[order[0]]}–${DOW[order[order.length - 1]]}`;
  return order.map((d) => DOW[d]).join(', ');
}

export function RoutineRow({
  group,
  placeLabel,
  onChange,
}: {
  group: RoutineGroup;
  placeLabel: string;
  onChange: () => void;
}) {
  const when = `${formatDays(group.days)} · ${formatMinute(group.start)}–${formatMinute(group.end)}`;
  const confirmAll = () => run(async () => {
    for (const id of group.ids) {
      const r = await confirmRoutine(id);
      if (r.error) return r;
    }
    return {};
  }, onChange);
  const rejectAll = () => run(async () => {
    for (const id of group.ids) {
      const r = await rejectRoutine(id);
      if (r.error) return r;
    }
    return {};
  }, onChange);

  return (
    <Row
      icon={placeIcon(group.category)}
      iconColor={group.confirmed ? colors.accent2 : colors.textDim}
      title={placeLabel}
      subtitle={when}
      value={group.confirmed ? 'Confirmed' : `${Math.round(group.consistency * 100)}%`}
      valueTone={group.confirmed ? 'accent' : 'muted'}
      onPress={() =>
        Alert.alert(placeLabel, `${when}\nALINE uses this to know when you're usually busy.`, [
          ...(group.confirmed ? [] : [{ text: "Yes, that's right", onPress: confirmAll }]),
          { text: 'Not really', style: 'destructive' as const, onPress: rejectAll },
          { text: 'Cancel', style: 'cancel' as const },
        ])
      }
    />
  );
}

const styles = StyleSheet.create({
  confirmBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.accentDim,
  },
  confirmText: { color: colors.accent, fontSize: font.size.sm, fontWeight: '600' },
});
