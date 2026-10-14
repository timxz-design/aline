import { useEffect, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import {
  connectDeviceCalendar,
  getDeviceCalendarPermission,
  syncDeviceCalendar,
  type DeviceCalendarSyncResult,
} from '../lib/device-calendar';
import { colors, font, space } from '../theme';
import { Button } from './Button';

/**
 * Connect block for the phone's own calendar (iCloud, work/Exchange, etc).
 * The OS permission IS the connection — once granted, the app lifecycle keeps
 * it synced (see `syncDeviceCalendar` in app/(app)/_layout.tsx). Lives next to
 * GoogleCalendarConnect on the Profile screen.
 */
export function DeviceCalendarConnect() {
  const [perm, setPerm] = useState<'granted' | 'denied' | 'undetermined' | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDeviceCalendarPermission().then(setPerm);
  }, []);

  if (Platform.OS === 'web' || perm === null) return null;

  const report = (r: DeviceCalendarSyncResult) => {
    if (r.ok) {
      setMessage(`Synced ${r.imported} event${r.imported === 1 ? '' : 's'} from ${r.calendars} calendar${r.calendars === 1 ? '' : 's'}.`);
    } else if (r.reason === 'no_permission') {
      setPerm('denied');
    } else {
      setError(r.error ?? 'Sync failed');
    }
  };

  const onConnect = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    const r = await connectDeviceCalendar();
    setBusy(false);
    if (r.ok) setPerm('granted');
    report(r);
  };

  const onResync = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    const r = await syncDeviceCalendar({ force: true });
    setBusy(false);
    report(r);
  };

  return (
    <View style={{ gap: space.sm }}>
      {perm === 'granted' ? (
        <>
          <View style={styles.connectedRow}>
            <View style={styles.dot} />
            <Text style={styles.connectedLabel}>Using your iPhone calendar</Text>
          </View>
          <Button label="Resync" variant="secondary" onPress={onResync} loading={busy} />
        </>
      ) : perm === 'denied' ? (
        <>
          <Text style={styles.subtle}>
            Calendar access is off. Turn it on in Settings so your agent can see
            when you're busy.
          </Text>
          <Button label="Open Settings" variant="secondary" onPress={() => Linking.openSettings()} />
        </>
      ) : (
        <>
          <Text style={styles.subtle}>
            Let your agent see the calendars on this phone — iCloud, work, and
            any other accounts — so it knows when you're actually busy. Read-only.
          </Text>
          <Button label="Use iPhone calendar" onPress={onConnect} loading={busy} />
        </>
      )}
      {message ? <Text style={styles.successText}>{message}</Text> : null}
      {error ? <Text style={styles.errorInline}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  connectedRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  connectedLabel: { color: colors.text, fontSize: font.size.md, fontWeight: '600' },
  subtle: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  successText: { color: colors.success, fontSize: 12 },
  errorInline: { color: colors.danger, fontSize: 12, lineHeight: 16 },
});
