import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from './supabase';

// Required so the auth result is delivered back to the app on web.
WebBrowser.maybeCompleteAuthSession();

/**
 * Google's OAuth 2.0 endpoints.
 */
export const GOOGLE_DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

/**
 * Scopes we ask for. `calendar.events` is read+write on events: we pull the
 * user's events AND write ALINE-created blocks / send invites back to Google.
 * (Still a "sensitive" scope — works for unverified test users via the warning
 * screen.) Upgrading from the old read-only scopes forces a one-time re-consent.
 */
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
];

/**
 * The Web OAuth client ID. Lives in EXPO_PUBLIC_GOOGLE_CLIENT_ID.
 *
 * In dev (Expo Go) and on web, the redirect URI uses Expo's auth-session
 * proxy, so this Web client ID works everywhere. For native standalone
 * builds we'd add platform-specific clients later.
 */
export const GOOGLE_WEB_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;

/**
 * Status returned by the `google_calendar_status` RPC.
 */
export type GoogleCalendarStatus = {
  connected: boolean;
  last_synced_at: string | null;
  last_sync_error: string | null;
};

/**
 * Read connection status. Single round-trip.
 */
export async function getGoogleCalendarStatus(): Promise<GoogleCalendarStatus> {
  const { data, error } = await supabase.rpc('google_calendar_status');
  if (error || !data || (Array.isArray(data) && data.length === 0)) {
    return { connected: false, last_synced_at: null, last_sync_error: null };
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    connected: row?.connected ?? false,
    last_synced_at: row?.last_synced_at ?? null,
    last_sync_error: row?.last_sync_error ?? null,
  };
}

/**
 * Send the OAuth code from the client to our edge function for exchange.
 * The edge function holds the client secret — never expose it client-side.
 */
export async function exchangeCodeForTokens(args: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('google-oauth-exchange', {
    body: {
      code: args.code,
      code_verifier: args.codeVerifier,
      redirect_uri: args.redirectUri,
    },
  });
  if (error) {
    return { success: false, error: error.message };
  }
  if (data && typeof data === 'object' && 'error' in data) {
    return { success: false, error: String((data as { error: string }).error) };
  }
  return { success: true };
}

/**
 * Trigger an immediate calendar sync. Pulls events into `calendar_events`.
 * Safe to call repeatedly — the function is idempotent (upsert by external_id).
 */
export async function syncGoogleCalendar(): Promise<{
  success: boolean;
  error?: string;
  events_upserted?: number;
}> {
  const { data, error } = await supabase.functions.invoke('google-calendar-sync', {
    body: {},
  });
  if (error) {
    return { success: false, error: error.message };
  }
  if (data && typeof data === 'object' && 'error' in data) {
    return { success: false, error: String((data as { error: string }).error) };
  }
  const upserted =
    data && typeof data === 'object' && 'events_upserted' in data
      ? (data as { events_upserted: number }).events_upserted
      : undefined;
  return { success: true, events_upserted: upserted };
}

/**
 * Disconnect: clears tokens and removes synced events.
 */
export async function disconnectGoogleCalendar(): Promise<{
  success: boolean;
  error?: string;
}> {
  const { error } = await supabase.rpc('disconnect_google_calendar');
  if (error) return { success: false, error: error.message };
  return { success: true };
}
