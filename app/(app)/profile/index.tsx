import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  formatDays,
  groupRoutines,
  isDisplayRoutine,
  isPlaceConfirmed,
  placeName,
} from '../../../src/components/KnowledgeRows';
import { PersonAvatar } from '../../../src/components/PersonAvatar';
import { Group, Row } from '../../../src/components/settings-ui';
import { Screen } from '../../../src/components/Screen';
import { useAuth } from '../../../src/lib/auth-context';
import { getDeviceCalendarPermission } from '../../../src/lib/device-calendar';
import { getGoogleCalendarStatus } from '../../../src/lib/google-calendar';
import { isHealthAvailable } from '../../../src/lib/health';
import { OPENNESS_OPTIONS } from '../../../src/lib/onboarding-data';
import { readPermissionStates, type PermissionKey, type PermissionState } from '../../../src/lib/permission-status';
import { registerForPushNotifications } from '../../../src/lib/push-notifications';
import { confirmPlace, useBehavioralProfile, type Place } from '../../../src/lib/use-behavioral-profile';
import { useFriends } from '../../../src/lib/use-friends';
import { useProfile } from '../../../src/lib/use-profile';
import { useYouFacts } from '../../../src/lib/use-you-facts';
import { colors, font, radius, space } from '../../../src/theme';

/**
 * You tab — a mirror of what ALINE knows, laid out like iOS Settings/Health:
 * your card, a couple of "recently learned" highlights, then grouped rows that
 * each open a detail screen where you check and correct things. The Sources
 * group doubles as a setup check: anything off shows amber and fixes in a tap.
 */
export default function YouScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { profile } = useProfile();
  const { friends, pending } = useFriends();
  const { places, routines, summary, refresh: refreshKnowledge } = useBehavioralProfile();
  const { goalRows, prefGroups } = useYouFacts();

  const [perms, setPerms] = useState<Record<PermissionKey, PermissionState> | null>(null);
  const [google, setGoogle] = useState(false);
  const [phoneCal, setPhoneCal] = useState(false);
  const [healthAvailable, setHealthAvailable] = useState(true);

  const reloadSources = useCallback(() => {
    readPermissionStates().then(setPerms);
    getGoogleCalendarStatus().then((s) => setGoogle(s.connected)).catch(() => {});
    getDeviceCalendarPermission().then((s) => setPhoneCal(s === 'granted')).catch(() => {});
  }, []);

  useFocusEffect(
    useCallback(() => {
      reloadSources();
      refreshKnowledge();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reloadSources]),
  );
  // Coming back from iOS Settings after fixing a permission.
  useEffect(() => {
    isHealthAvailable().then(setHealthAvailable);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') reloadSources();
    });
    return () => sub.remove();
  }, [reloadSources]);

  const visiblePlaces = places.filter((p) => !p.is_hidden);
  const confirmedPlaces = visiblePlaces.filter(isPlaceConfirmed);
  const routineGroups = useMemo(() => groupRoutines(routines.filter(isDisplayRoutine)), [routines]);
  const prefCount = prefGroups.reduce((n, g) => n + g.items.length, 0);
  const inbound = pending.filter((p) => !p.outbound).length;
  const openness = OPENNESS_OPTIONS.find((o) => o.value === profile?.social_openness);

  const placesValue =
    confirmedPlaces.length > 0
      ? confirmedPlaces.slice(0, 2).map(placeName).join(', ') +
        (visiblePlaces.length > 2 ? ` +${visiblePlaces.length - 2}` : '')
      : visiblePlaces.length > 0
        ? `${visiblePlaces.length}`
        : undefined;

  const calendars = [phoneCal ? 'iPhone' : null, google ? 'Google' : null].filter(Boolean).join(', ');
  const go = (path: string) => router.push(`/(app)/profile/${path}` as never);

  // ---- recently learned (max two tiles) ----
  const pendingPlace = visiblePlaces
    .filter((p) => !isPlaceConfirmed(p) && p.visit_count >= 2)
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen))[0];
  const topRoutine = routineGroups.find((g) => g.days.length >= 2);
  const like = prefGroups.find((g) => g.label === 'Likes')?.items[0]?.text;
  const tiles: TileData[] = [];
  if (pendingPlace) {
    tiles.push({
      key: 'place',
      icon: 'location',
      tint: colors.warning,
      label: 'New place',
      title: `${placeName(pendingPlace)}?`,
      place: pendingPlace,
      onPress: () => go('places'),
    });
  }
  if (summary?.bedtime_minute != null && summary.waketime_minute != null) {
    tiles.push({
      key: 'sleep',
      icon: 'moon',
      tint: colors.accent2,
      label: 'Sleep',
      title: `Asleep ~${clock(summary.bedtime_minute)}`,
      meta: `up ~${clock(summary.waketime_minute)}`,
      onPress: () => go('routines'),
    });
  }
  if (topRoutine) {
    const where = topRoutine.placeId
      ? placeName(places.find((p) => p.id === topRoutine.placeId) ?? { user_label: null, name: null, category: topRoutine.category })
      : topRoutine.category ?? 'Routine';
    tiles.push({
      key: 'routine',
      icon: 'time',
      tint: colors.accent,
      label: 'Routine',
      title: where,
      meta: `${formatDays(topRoutine.days)} from ${clock(topRoutine.start)}`,
      onPress: () => go('routines'),
    });
  }
  if (like) {
    tiles.push({ key: 'like', icon: 'heart', tint: colors.danger, label: 'You like', title: like, onPress: () => go('preferences') });
  }

  const permValue = (s: PermissionState | undefined, on: string, partial = 'Limited') =>
    s === 'on' ? on : s === 'partial' ? partial : 'Off';
  const tone = (s: PermissionState | undefined): 'muted' | 'warning' => (s === 'on' ? 'muted' : 'warning');

  return (
    <Screen noPadding>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.pageTitle}>You</Text>

        <Pressable
          onPress={() => go('account')}
          style={({ pressed }) => [styles.card, pressed && { backgroundColor: colors.bgRaised }]}
          accessibilityRole="button"
        >
          <PersonAvatar id={user?.id} name={profile?.first_name} size={52} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{profile?.first_name ?? 'You'}</Text>
            <Text style={styles.cardSub}>
              {profile?.handle ? `@${profile.handle} · ` : ''}Account and sign-out
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.border} />
        </Pressable>

        {tiles.length > 0 ? (
          <View>
            <Text style={styles.groupLabel}>Recently learned</Text>
            <View style={styles.tiles}>
              {tiles.slice(0, 2).map((t) => (
                <Tile key={t.key} t={t} onChanged={refreshKnowledge} />
              ))}
            </View>
          </View>
        ) : null}

        <Group label="About you">
          <Row
            icon="time"
            iconColor={colors.accent2}
            title="Routines and sleep"
            value={routineGroups.length ? String(routineGroups.length) : undefined}
            onPress={() => go('routines')}
          />
          <Row icon="location" iconColor={colors.warning} title="Places" value={placesValue} onPress={() => go('places')} />
          <Row
            icon="heart"
            iconColor={colors.danger}
            title="Likes and dislikes"
            value={prefCount ? String(prefCount) : undefined}
            onPress={() => go('preferences')}
          />
          <Row
            icon="flag"
            iconColor={colors.success}
            title="Goals"
            value={goalRows.length ? String(goalRows.length) : undefined}
            onPress={() => go('goals')}
          />
        </Group>

        <Group label="People">
          <Row
            icon="people"
            iconColor={colors.accent}
            title="Friends"
            badge={inbound || undefined}
            value={String(friends.length)}
            onPress={() => go('friends')}
          />
          <Row
            icon="lock-closed"
            iconColor="#8E5BA8"
            title="Who can plan with you"
            value={openness?.short ?? 'Not set'}
            onPress={() => go('privacy')}
          />
        </Group>

        <Group
          label="Sources"
          footer={
            perms && Object.entries(perms).some(([k, v]) => v !== 'on' && (k !== 'health' || healthAvailable))
              ? 'Anything in amber limits what ALINE can learn. Tap it to turn it on.'
              : undefined
          }
        >
          <Row
            icon="calendar"
            title="Calendars"
            value={calendars || 'Off'}
            valueTone={calendars ? 'muted' : 'warning'}
            onPress={() => go('calendars')}
          />
          {healthAvailable ? (
            <Row
              icon="fitness"
              title="Apple Health"
              value={permValue(perms?.health, 'On')}
              valueTone={tone(perms?.health)}
              onPress={() => go('health')}
            />
          ) : null}
          <Row
            icon="navigate"
            title="Location"
            value={permValue(perms?.location, 'Always', 'While using')}
            valueTone={tone(perms?.location)}
            onPress={() => Linking.openSettings()}
          />
          <Row
            icon="walk"
            title="Motion"
            value={permValue(perms?.motion, 'On')}
            valueTone={tone(perms?.motion)}
            onPress={() => Linking.openSettings()}
          />
          <Row
            icon="notifications"
            title="Notifications"
            value={permValue(perms?.notifications, 'On')}
            valueTone={tone(perms?.notifications)}
            onPress={async () => {
              if (perms?.notifications !== 'on') {
                await registerForPushNotifications().catch(() => null);
                const next = await readPermissionStates();
                setPerms(next);
                if (next.notifications === 'on') return;
              }
              Linking.openSettings();
            }}
          />
        </Group>
      </ScrollView>
    </Screen>
  );
}

type TileData = {
  key: string;
  icon: 'location' | 'moon' | 'time' | 'heart';
  tint: string;
  label: string;
  title: string;
  meta?: string;
  place?: Place;
  onPress: () => void;
};

function Tile({ t, onChanged }: { t: TileData; onChanged: () => void }) {
  return (
    <Pressable
      onPress={t.onPress}
      style={({ pressed }) => [styles.tile, pressed && { backgroundColor: colors.bgRaised }]}
    >
      <View style={styles.tileLabelRow}>
        <Ionicons name={t.icon} size={13} color={t.tint} />
        <Text style={[styles.tileLabel, { color: t.tint }]}>{t.label}</Text>
      </View>
      <Text style={styles.tileTitle} numberOfLines={2}>
        {t.title}
      </Text>
      {t.place ? (
        <View style={styles.tileActions}>
          <Pressable
            hitSlop={8}
            onPress={async () => {
              await confirmPlace(t.place!.id);
              onChanged();
            }}
          >
            <Text style={styles.tileAction}>Confirm</Text>
          </Pressable>
          <Pressable hitSlop={8} onPress={t.onPress}>
            <Text style={styles.tileActionMuted}>Not right</Text>
          </Pressable>
        </View>
      ) : t.meta ? (
        <Text style={styles.tileMeta}>{t.meta}</Text>
      ) : null}
    </Pressable>
  );
}

function clock(m: number | null): string {
  if (m == null) return '—';
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  body: { padding: space.lg, paddingTop: space.md, paddingBottom: space.xxxl, gap: space.lg },
  pageTitle: { color: colors.text, fontSize: font.size.xxl, fontWeight: '700' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: space.md,
  },
  name: { color: colors.text, fontSize: font.size.lg, fontWeight: '700' },
  cardSub: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  groupLabel: { color: colors.textDim, fontSize: 12, marginLeft: space.md, marginBottom: 6 },
  tiles: { flexDirection: 'row', gap: space.sm },
  tile: { flex: 1, backgroundColor: colors.bgElevated, borderRadius: radius.lg, padding: space.md, gap: 4 },
  tileLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tileLabel: { fontSize: 12, fontWeight: '600' },
  tileTitle: { color: colors.text, fontSize: font.size.md, fontWeight: '600' },
  tileMeta: { color: colors.textDim, fontSize: 12 },
  tileActions: { flexDirection: 'row', gap: space.md, marginTop: 2 },
  tileAction: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  tileActionMuted: { color: colors.textMuted, fontSize: 13 },
});
