/**
 * "Reconnect Google Calendar" banner.
 *
 * Surfaces at the top of My Week whenever Google Calendar sync is broken —
 * typically because the OAuth refresh token expired (Google revokes
 * unverified-app refresh tokens after 7 days, plus other lifecycle reasons).
 *
 * Without this, sync just silently fails after a week and the user wonders
 * why ALINE stopped seeing their calendar. The banner makes it actionable
 * with a single tap → routes to Profile where GoogleCalendarConnect handles
 * the actual OAuth flow.
 *
 * Detection: we read `last_sync_error` from `google_oauth_tokens` via the
 * `getGoogleCalendarStatus()` RPC. Any non-null error while the user is
 * still marked connected is treated as actionable.
 */

import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getGoogleCalendarStatus, type GoogleCalendarStatus } from '../lib/google-calendar';
import { breadcrumb } from '../lib/sentry';
import { colors, font, radius, space } from '../theme';

type Props = {
  /** Called whenever the banner refreshes status. Lets the parent know the
   *  current state so it can re-render its own pieces if needed. */
  onStatus?: (s: GoogleCalendarStatus | null) => void;
};

export function CalendarReconnectBanner({ onStatus }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getGoogleCalendarStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        onStatus?.(s);
      })
      .catch((e) => {
        breadcrumb('CalendarReconnectBanner status fetch failed', { err: String(e) });
      })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [onStatus]);

  // Render only when actionable: previously connected AND there's a sync error.
  // If user never connected → no banner. If healthy → no banner.
  if (!loaded) return null;
  if (!status?.connected) return null;
  if (!status.last_sync_error) return null;

  const onTap = () => {
    breadcrumb('reconnect banner tapped');
    router.push('/(app)/profile' as never);
  };

  // Deliberately quiet: a one-line muted note, not an alarm box. Sync being
  // paused is an inconvenience, not an emergency — it shouldn't dominate the
  // Week tab every morning.
  return (
    <Pressable
      onPress={onTap}
      style={({ pressed }) => [styles.banner, pressed && { opacity: 0.7 }]}
      hitSlop={6}
    >
      <Text style={styles.text} numberOfLines={1}>
        Calendar sync paused · tap to reconnect
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignSelf: 'center',
    paddingVertical: 4,
    paddingHorizontal: space.md,
    marginTop: space.xs,
  },
  text: {
    color: colors.textDim,
    fontSize: font.size.xs,
  },
});
