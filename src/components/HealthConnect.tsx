import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  disconnectHealth,
  hasHealthAuthorization,
  isHealthAvailable,
  lastHealthSyncAt,
  requestHealthAuthorization,
  syncHealthWorkouts,
} from '../lib/health';
import { colors, font, radius, space } from '../theme';

/**
 * Apple Health connection. Once connected, workouts you actually did count
 * toward your goals automatically — no manual logging.
 *
 * Deliberately honest about the one limitation: nothing is recorded unless a
 * workout is started somewhere (Fitness app, or any app that writes HKWorkout).
 */
export function HealthConnect() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const ok = await isHealthAvailable();
    setAvailable(ok);
    if (!ok) return;
    setConnected(await hasHealthAuthorization());
    setLastSync(await lastHealthSyncAt());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runSync = useCallback(async () => {
    setBusy(true);
    const res = await syncHealthWorkouts();
    setBusy(false);
    setLastSync(await lastHealthSyncAt());

    if (res.error) {
      Alert.alert("Couldn't sync", res.error);
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

    const counted = res.planned + res.unplanned;
    if (counted === 0 && res.imported === 0) {
      Alert.alert('Nothing new', 'No new workouts since the last sync.');
      return;
    }
    const bits: string[] = [];
    if (res.planned > 0) bits.push(`${res.planned} planned session${res.planned === 1 ? '' : 's'} marked done`);
    if (res.unplanned > 0) bits.push(`${res.unplanned} unplanned workout${res.unplanned === 1 ? '' : 's'} added`);
    if (res.ambiguous > 0) bits.push(`${res.ambiguous} need${res.ambiguous === 1 ? 's' : ''} a goal — ask ALINE`);
    Alert.alert(
      'Synced',
      bits.length > 0 ? bits.join('\n') : `${res.imported} workout${res.imported === 1 ? '' : 's'} imported.`,
    );
  }, []);

  const connect = useCallback(async () => {
    setBusy(true);
    const ok = await requestHealthAuthorization();
    setBusy(false);
    if (!ok) {
      Alert.alert(
        'Not connected',
        'ALINE needs read access to your workouts. You can grant it in Settings → Health → Data Access & Devices → ALINE.',
      );
      return;
    }
    setConnected(true);
    await runSync();
  }, [runSync]);

  const disconnect = useCallback(() => {
    Alert.alert(
      'Disconnect Apple Health?',
      'ALINE stops importing workouts. Sessions already counted stay. To fully revoke access, use Settings → Health.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            await disconnectHealth();
            setConnected(false);
            setLastSync(null);
          },
        },
      ],
    );
  }, []);

  if (available === null) {
    return <ActivityIndicator color={colors.accent} style={{ alignSelf: 'flex-start' }} />;
  }

  if (!available) {
    return (
      <View style={styles.card}>
        <Text style={styles.body}>Apple Health isn&rsquo;t available on this device.</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Ionicons
          name={connected ? 'heart' : 'heart-outline'}
          size={22}
          color={connected ? colors.accent : colors.textDim}
        />
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>
            {connected ? 'Apple Health connected' : 'Apple Health'}
          </Text>
          <Text style={styles.meta}>
            {connected
              ? lastSync
                ? `Last synced ${formatWhen(lastSync)}`
                : 'Not synced yet'
              : 'Count workouts automatically, without logging them'}
          </Text>
        </View>
      </View>

      {connected ? (
        <Text style={styles.note}>
          Workouts count automatically — but only ones you start somewhere (the
          Fitness app, or any app that records a workout). Your AirPods Pro track
          heart rate during those.
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          onPress={connected ? runSync : connect}
          disabled={busy}
          style={({ pressed }) => [styles.btn, pressed && { opacity: 0.85 }, busy && { opacity: 0.6 }]}
        >
          <Text style={styles.btnText}>
            {busy ? 'Working…' : connected ? 'Sync now' : 'Connect Apple Health'}
          </Text>
        </Pressable>
        {connected ? (
          <Pressable onPress={disconnect} hitSlop={6} style={styles.ghostBtn}>
            <Text style={styles.ghostText}>Disconnect</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function formatWhen(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { color: colors.text, fontSize: font.size.md, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: font.size.sm, marginTop: 2 },
  body: { color: colors.textMuted, fontSize: font.size.sm },
  note: { color: colors.textDim, fontSize: font.size.xs, lineHeight: 17 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  btnText: { color: colors.textInverse, fontSize: font.size.sm, fontWeight: '700' },
  ghostBtn: { paddingHorizontal: space.sm, paddingVertical: space.sm },
  ghostText: { color: colors.textMuted, fontSize: font.size.sm, fontWeight: '600' },
});
