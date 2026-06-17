import * as AuthSession from 'expo-auth-session';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import {
  GOOGLE_DISCOVERY,
  GOOGLE_SCOPES,
  GOOGLE_WEB_CLIENT_ID,
  disconnectGoogleCalendar,
  exchangeCodeForTokens,
  getGoogleCalendarStatus,
  syncGoogleCalendar,
  type GoogleCalendarStatus,
} from '../lib/google-calendar';
import { colors, font, radius, space } from '../theme';
import { Button } from './Button';

/**
 * Connect / Disconnect block for Google Calendar. Drop into Profile screen.
 *
 * Behavior:
 *   - Loads connection status on mount.
 *   - Connect → opens Google OAuth → exchanges code → triggers initial sync.
 *   - Disconnect → wipes tokens + synced events.
 *   - Resync → refreshes events without re-authing.
 *
 * The OAuth client ID lives in `EXPO_PUBLIC_GOOGLE_CLIENT_ID`. The redirect
 * URI is auto-derived by `expo-auth-session` based on the runtime (Expo Go
 * proxy in dev, custom-scheme in standalone builds).
 */
export function GoogleCalendarConnect() {
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Redirect URI handling:
  //   - Web (dev/prod):    http(s)://localhost:8081 — must be registered in
  //                        Google Cloud as an "Authorized redirect URI" on
  //                        the Web OAuth client.
  //   - Standalone native: aline:// custom scheme — needs a separate Android
  //                        / iOS OAuth client in Google Cloud (created when
  //                        you do EAS Build).
  //   - Expo Go:           does NOT work for Google OAuth (Expo deprecated
  //                        the auth proxy in SDK 50+). Use a dev build for
  //                        phone testing.
  // Drop the path segment so the URI exactly matches what's registered.
  const redirectUri = AuthSession.makeRedirectUri({
    native: 'com.googleusercontent.apps.509292620550-d4qjje04rltcuanidbhh6vd923e7v4ok:/oauth2callback',
  });

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: GOOGLE_WEB_CLIENT_ID ?? '',
      scopes: GOOGLE_SCOPES,
      redirectUri,
      // PKCE — auth-session handles code_verifier under the hood.
      usePKCE: true,
      // Force a refresh_token even if the user has previously authorized.
      extraParams: { access_type: 'offline', prompt: 'consent' },
      responseType: AuthSession.ResponseType.Code,
    },
    GOOGLE_DISCOVERY
  );

  // Initial status load.
  useEffect(() => {
    let cancelled = false;
    getGoogleCalendarStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .finally(() => {
        if (!cancelled) setLoadingStatus(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Handle the auth response when it comes back.
  useEffect(() => {
    if (!response) return;
    if (response.type === 'cancel' || response.type === 'dismiss') {
      setBusy(null);
      return;
    }
    if (response.type === 'error') {
      setBusy(null);
      setError(response.error?.message ?? 'OAuth failed');
      return;
    }
    if (response.type === 'success' && response.params.code) {
      const code = response.params.code;
      const codeVerifier = request?.codeVerifier ?? '';
      (async () => {
        const exchange = await exchangeCodeForTokens({
          code,
          codeVerifier,
          redirectUri,
        });
        if (!exchange.success) {
          setBusy(null);
          setError(exchange.error ?? 'Token exchange failed');
          return;
        }
        const sync = await syncGoogleCalendar();
        setBusy(null);
        if (!sync.success) {
          setError(sync.error ?? 'Sync failed');
          return;
        }
        setMessage(
          sync.events_upserted !== undefined
            ? `Connected. Pulled ${sync.events_upserted} events.`
            : 'Connected.'
        );
        const s = await getGoogleCalendarStatus();
        setStatus(s);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  const onConnect = async () => {
    if (!GOOGLE_WEB_CLIENT_ID) {
      setError(
        'Set EXPO_PUBLIC_GOOGLE_CLIENT_ID in .env. See README "Google Cloud setup".'
      );
      return;
    }
    setError(null);
    setMessage(null);
    setBusy('connect');
    try {
      await promptAsync();
    } catch (e) {
      setBusy(null);
      setError((e as Error).message);
    }
  };

  const onResync = async () => {
    setError(null);
    setMessage(null);
    setBusy('sync');
    const result = await syncGoogleCalendar();
    setBusy(null);
    if (!result.success) {
      setError(result.error ?? 'Sync failed');
      return;
    }
    setMessage(
      result.events_upserted !== undefined
        ? `Synced ${result.events_upserted} events.`
        : 'Synced.'
    );
    const s = await getGoogleCalendarStatus();
    setStatus(s);
  };

  const onDisconnect = () => {
    Alert.alert(
      'Disconnect Google Calendar?',
      "We'll remove your stored tokens and the events we synced. ALINE won't see your calendar until you reconnect.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            setBusy('disconnect');
            const result = await disconnectGoogleCalendar();
            setBusy(null);
            if (!result.success) {
              setError(result.error ?? 'Disconnect failed');
              return;
            }
            setStatus({ connected: false, last_synced_at: null, last_sync_error: null });
            setMessage('Disconnected.');
          },
        },
      ]
    );
  };

  if (loadingStatus) {
    return (
      <View style={styles.row}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.statusText}>Checking connection…</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: space.sm }}>
      {status?.connected ? (
        <>
          <View style={styles.connectedRow}>
            <View style={styles.dot} />
            <Text style={styles.connectedLabel}>Connected to Google Calendar</Text>
          </View>
          {status.last_synced_at ? (
            <Text style={styles.subtle}>
              Last synced {formatRelative(status.last_synced_at)}
            </Text>
          ) : (
            <Text style={styles.subtle}>Not synced yet.</Text>
          )}
          {status.last_sync_error ? (
            <Text style={styles.errorInline}>
              Last sync error: {status.last_sync_error}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button
              label="Resync"
              variant="secondary"
              onPress={onResync}
              loading={busy === 'sync'}
              style={{ flex: 1 }}
            />
            <Button
              label="Disconnect"
              variant="secondary"
              onPress={onDisconnect}
              loading={busy === 'disconnect'}
              style={{ flex: 1 }}
            />
          </View>
        </>
      ) : (
        <>
          <Text style={styles.subtle}>
            Let your agent see your real schedule, add the blocks it plans, and
            send calendar invites on your behalf — all synced with Google.
          </Text>
          <Button
            label="Connect Google Calendar"
            onPress={onConnect}
            loading={busy === 'connect'}
            disabled={!request}
          />
        </>
      )}
      {message ? <Text style={styles.successText}>{message}</Text> : null}
      {error ? <Text style={styles.errorInline}>{error}</Text> : null}
    </View>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  statusText: { color: colors.textMuted, fontSize: 13 },
  connectedRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
  },
  connectedLabel: {
    color: colors.text,
    fontSize: font.size.md,
    fontWeight: '600',
  },
  subtle: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  successText: { color: colors.success, fontSize: 12 },
  errorInline: { color: colors.danger, fontSize: 12, lineHeight: 16 },
});
