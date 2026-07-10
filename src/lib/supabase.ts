import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';
import type { Database } from '../types/database';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY in .env'
  );
}

/**
 * Pick a storage backend per platform.
 *  - Native (iOS/Android): AsyncStorage — persists between launches.
 *  - Web: leave undefined so Supabase falls back to `localStorage`.
 *    (AsyncStorage's native module isn't available in browsers.)
 */
const authStorage = Platform.OS === 'web' ? undefined : AsyncStorage;

/**
 * Supabase client for the ALINE app.
 *
 * Auth tokens are persisted so the user stays logged in across launches.
 * Auto-refresh keeps the access token valid in the background.
 */
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: authStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// React Native REQUIRES explicit refresh lifecycle wiring: timers don't run
// while iOS suspends the app, so without this the access token expires in the
// background and every PostgREST call can hang on a stale/deadlocked refresh
// (the "spinner forever, survives force-close" failure). Documented Supabase
// RN pattern: refresh only while foregrounded.
if (Platform.OS !== 'web') {
  supabase.auth.startAutoRefresh();
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}
