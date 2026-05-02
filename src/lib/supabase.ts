import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
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
