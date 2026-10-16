/**
 * Push notifications — registration + handler.
 *
 * Lifecycle:
 *   1. App startup: configure foreground notification behaviour + Android channel.
 *   2. After auth: ask permission (soft prompt), grab Expo Push token,
 *      save it via the `set_push_token` RPC.
 *   3. Tap on a notification: deep-link to the relevant screen.
 *
 * Server side:
 *   - Postgres triggers fan out pushes via `send_push_to_users` →  Expo Push API.
 *   - The five events firing pushes: hangout proposed, hangout confirmed,
 *     hangout cancelled, friend request received, friend request accepted.
 *
 * Notes:
 *   - Push tokens are device-specific. We overwrite on every fresh registration.
 *   - Permission is asked once. If user denies, we don't badger.
 *   - Web platform is a no-op (Expo Push doesn't support web cleanly).
 */

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { supabase } from './supabase';

// Show notifications even when the app is in foreground.
// Android needs a notification channel to display anything at all on 8.0+.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const ANDROID_CHANNEL_ID = 'aline-default';

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: 'ALINE',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#5EEAD4',
    sound: 'default',
  });
}

/**
 * Request permission, fetch the Expo Push token, and save it via RPC.
 * Safe to call multiple times — only writes if a token came back.
 *
 * Returns the token (or null on failure / denial / web).
 */
export async function registerForPushNotifications(): Promise<string | null> {
  if (Platform.OS === 'web') return null;

  try {
    await ensureAndroidChannel();

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.status === 'granted';

    if (!granted && existing.canAskAgain) {
      const requested = await Notifications.requestPermissionsAsync();
      granted = requested.status === 'granted';
    }

    if (!granted) {
      console.log('[push] permission not granted');
      return null;
    }

    // EAS build uses the projectId from app.json/extra to issue the token.
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;

    if (!projectId) {
      console.warn('[push] no EAS projectId — token cannot be issued');
      return null;
    }

    const token = (
      await Notifications.getExpoPushTokenAsync({ projectId })
    ).data;

    if (!token) return null;

    // Save to profiles via RPC. Fire-and-forget on errors — push not working
    // shouldn't block app usage.
    const { error } = await supabase.rpc('set_push_token', { _token: token });
    if (error) {
      console.warn('[push] set_push_token failed:', error.message);
    } else {
      console.log('[push] token registered');
    }

    return token;
  } catch (e) {
    console.warn('[push] registration failed:', e);
    return null;
  }
}

/**
 * Deregister from pushes — called on sign-out.
 */
export async function deregisterPushToken(): Promise<void> {
  try {
    // The SQL function accepts null to clear the token, but the generated arg
    // type is non-null `string`; cast to satisfy it without weakening the type.
    await supabase.rpc('set_push_token', { _token: null as unknown as string });
  } catch (e) {
    console.warn('[push] deregister failed:', e);
  }
}

/**
 * Returns the route a notification's data payload should deep-link to.
 * Falls back to the home tab if nothing matches.
 */
export function routeForNotification(data: Record<string, unknown> | undefined): string {
  if (!data || typeof data !== 'object') return '/(app)/agent';

  // Proactive pushes (weather, reminders, leave-by, live-status, goal pacing,
  // morning brief, etc.) are mirrored into the agent chat thread server-side
  // and carry the id of that message. Deep-link straight to it so the user
  // lands on the nudge instead of the bottom of the thread.
  const mid = (data as { chat_message_id?: string }).chat_message_id;
  if (typeof mid === 'string' && mid) {
    return `/(app)/agent?focus=${encodeURIComponent(mid)}`;
  }

  const t = (data as { type?: string }).type;

  switch (t) {
    case 'hangout_proposed':
    case 'hangout_confirmed':
    case 'hangout_cancelled': {
      // Open the plan sheet for that hangout on My Week.
      const hid = (data as { hangout_id?: string }).hangout_id;
      return typeof hid === 'string' && hid
        ? `/(app)/week?plan=${encodeURIComponent(hid)}`
        : '/(app)/week';
    }

    case 'friend_request':
    case 'friend_accepted':
      return '/(app)/profile/friends';

    default:
      // Chat is home — anything unrecognized lands with the agent.
      return '/(app)/agent';
  }
}
