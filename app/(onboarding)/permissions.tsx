import * as Calendar from 'expo-calendar';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { Pedometer } from 'expo-sensors';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { BackChevron } from '../../src/components/BackChevron';
import { Button } from '../../src/components/Button';
import { Screen } from '../../src/components/Screen';
import { useAuth } from '../../src/lib/auth-context';
import { requestLocationPermissions } from '../../src/lib/backgroundGps';
import { connectDeviceCalendar } from '../../src/lib/device-calendar';
import { useOnboarding } from '../../src/lib/onboarding-context';
import { registerForPushNotifications } from '../../src/lib/push-notifications';
import { ensureMotionPermission } from '../../src/lib/signals';
import { useProfile } from '../../src/lib/use-profile';
import { colors, font, radius, space } from '../../src/theme';

/**
 * Final onboarding step: every permission ALINE needs, on one screen, each with
 * its reason. "Turn everything on" walks through the OS prompts in order.
 * Location is the one that needs care — iOS grants "While Using" first, and
 * only "Always" lets ALINE learn routines in the background, so a partial grant
 * gets a tap-through to Settings.
 */

type ItemState = 'on' | 'partial' | 'off';
type Key = 'location' | 'calendar' | 'motion' | 'notifications';

const ITEMS: { key: Key; title: string; why: string }[] = [
  {
    key: 'location',
    title: 'Location — Always',
    why: 'Learns your places and routines so your agent knows when you\'re actually free. Stored as rough areas, never exact coordinates.',
  },
  {
    key: 'calendar',
    title: 'Calendar',
    why: 'Sees when you\'re busy so plans never clash with what you already have. Read-only.',
  },
  {
    key: 'motion',
    title: 'Motion & Fitness',
    why: 'Step counts tell walking from sitting, even while the app is closed.',
  },
  {
    key: 'notifications',
    title: 'Notifications',
    why: 'So friends\' plans and "leave now" nudges actually reach you.',
  },
];

async function readStates(): Promise<Record<Key, ItemState>> {
  const [fg, bg, cal, motion, notif] = await Promise.all([
    Location.getForegroundPermissionsAsync().catch(() => null),
    Location.getBackgroundPermissionsAsync().catch(() => null),
    Calendar.getCalendarPermissionsAsync().catch(() => null),
    Pedometer.getPermissionsAsync().catch(() => null),
    Notifications.getPermissionsAsync().catch(() => null),
  ]);
  return {
    location: bg?.granted ? 'on' : fg?.granted ? 'partial' : 'off',
    calendar: cal?.granted ? 'on' : 'off',
    motion: motion?.granted ? 'on' : 'off',
    notifications: notif?.granted ? 'on' : 'off',
  };
}

export default function OnboardingPermissions() {
  const router = useRouter();
  const { user } = useAuth();
  const { refresh } = useProfile();
  const { complete } = useOnboarding();
  const [states, setStates] = useState<Record<Key, ItemState> | null>(null);
  const [busy, setBusy] = useState<Key | 'all' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => { readStates().then(setStates); }, []);

  // Re-read when coming back from Settings (the "Always" upgrade path).
  useEffect(() => {
    reload();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') reload(); });
    return () => sub.remove();
  }, [reload]);

  const enable = async (key: Key) => {
    const s = states?.[key];
    // iOS won't re-prompt once answered — the only way forward is Settings.
    if (s === 'partial' || (s === 'off' && (await alreadyAnswered(key)))) {
      Linking.openSettings();
      return;
    }
    if (key === 'location') await requestLocationPermissions();
    if (key === 'calendar') await connectDeviceCalendar();
    if (key === 'motion') await ensureMotionPermission();
    if (key === 'notifications') await registerForPushNotifications();
  };

  const onItem = async (key: Key) => {
    setBusy(key);
    await enable(key);
    await readStates().then(setStates);
    setBusy(null);
  };

  const onAll = async () => {
    setBusy('all');
    for (const item of ITEMS) {
      const current = (await readStates())[item.key];
      if (current === 'off' && !(await alreadyAnswered(item.key))) await enable(item.key);
    }
    await readStates().then(setStates);
    setBusy(null);
  };

  const finish = async () => {
    if (!user) return;
    setSubmitting(true);
    setError(null);
    const { error: completeErr } = await complete(user.id);
    setSubmitting(false);
    if (completeErr) {
      setError(completeErr.message);
      return;
    }
    await refresh();
    router.replace('/(app)/agent');
  };

  const allOn = states ? ITEMS.every((i) => states[i.key] === 'on') : false;

  return (
    <Screen>
      <BackChevron />
      <View style={styles.header}>
        <Text style={styles.step}>4 of 4</Text>
        <Text style={styles.title}>Let your agent see your day</Text>
        <Text style={styles.sub}>
          The more it knows about when you're busy and where you usually are,
          the less you'll ever have to coordinate yourself.
        </Text>
      </View>

      <View style={styles.list}>
        {ITEMS.map((item) => {
          const s = states?.[item.key] ?? 'off';
          return (
            <Pressable
              key={item.key}
              onPress={() => s !== 'on' && onItem(item.key)}
              disabled={busy !== null || s === 'on'}
              style={({ pressed }) => [styles.row, s === 'on' && styles.rowOn, pressed && { opacity: 0.9 }]}
            >
              <View style={[styles.check, s === 'on' && styles.checkOn, s === 'partial' && styles.checkPartial]}>
                <Text style={styles.checkText}>{s === 'on' ? '✓' : s === 'partial' ? '!' : ''}</Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.rowTitle}>{item.title}</Text>
                <Text style={styles.rowWhy}>
                  {item.key === 'location' && s === 'partial'
                    ? 'Set to "While Using". Tap → Location → Always, so it works while the app is closed.'
                    : item.why}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <View style={styles.footer}>
        {!allOn ? (
          <Button label="Turn everything on" onPress={onAll} loading={busy === 'all'} />
        ) : null}
        <Button
          label={allOn ? 'Done — meet your agent' : 'Continue'}
          variant={allOn ? undefined : 'secondary'}
          onPress={finish}
          loading={submitting}
        />
      </View>
    </Screen>
  );
}

/** True when iOS has already shown (and the user answered) this prompt. */
async function alreadyAnswered(key: Key): Promise<boolean> {
  if (Platform.OS === 'web') return true;
  const res =
    key === 'location' ? await Location.getForegroundPermissionsAsync().catch(() => null)
      : key === 'calendar' ? await Calendar.getCalendarPermissionsAsync().catch(() => null)
        : key === 'motion' ? await Pedometer.getPermissionsAsync().catch(() => null)
          : await Notifications.getPermissionsAsync().catch(() => null);
  return !!res && !res.granted && !res.canAskAgain;
}

const styles = StyleSheet.create({
  header: { paddingTop: space.md, gap: 4 },
  step: { color: colors.accent, fontSize: 12, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: colors.text, fontSize: font.size.xxl, fontWeight: '700' },
  sub: { color: colors.textMuted, fontSize: font.size.sm, lineHeight: 20, marginTop: 4 },
  list: { flex: 1, justifyContent: 'center', gap: space.md, paddingVertical: space.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
  },
  rowOn: { borderColor: colors.success },
  check: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.success, borderColor: colors.success },
  checkPartial: { backgroundColor: colors.warning, borderColor: colors.warning },
  checkText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  rowTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  rowWhy: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  errorText: { color: colors.danger, fontSize: 13, textAlign: 'center' },
  footer: { paddingBottom: space.xxl, gap: space.sm },
});
