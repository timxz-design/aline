/**
 * Background GPS sampling for ALINE behavioral profile collection.
 *
 * Design:
 *  - Expo Task Manager fires the task when the OS delivers a location update.
 *  - Raw lat/lon are immediately converted to geohash-8 (~38 m precision).
 *    Coordinates are never stored or transmitted — only the geohash.
 *  - Conservative battery posture: Balanced accuracy, 15-min minimum interval,
 *    50 m minimum distance, iOS auto-pause when stationary.
 *  - Android requires a foreground service (visible notification) for bg access.
 *
 * Registration:
 *  - Import this file at app root (_layout.tsx) so defineTask runs before
 *    any background wake-up can arrive.
 *  - Call startBackgroundGps() once the user is authenticated.
 *  - Call stopBackgroundGps() on sign-out.
 */

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { encodeGeohash } from './clustering';
import { supabase } from './supabase';

export const BACKGROUND_LOCATION_TASK = 'aline-background-location';

// ---------- task definition (must run at import time) -----------------------

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[ALINE GPS] Task error:', error.message);
    return;
  }

  const { locations } = data as { locations: Location.LocationObject[] };
  if (!locations?.length) return;

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const pings = locations.map((loc) => ({
      user_id: session.user.id,
      captured_at: new Date(loc.timestamp).toISOString(),
      geohash_8: encodeGeohash(loc.coords.latitude, loc.coords.longitude, 8),
      motion_state: 'unknown',
      battery_level: null as number | null,
    }));

    const { error: insertErr } = await supabase
      .from('behavioral_pings')
      .insert(pings);

    if (insertErr) {
      console.warn('[ALINE GPS] Upload failed:', insertErr.message);
    }
  } catch (e) {
    console.warn('[ALINE GPS] Task exception:', e);
  }
});

// ---------- permission helpers ----------------------------------------------

export async function requestLocationPermissions(): Promise<boolean> {
  try {
    const { status: fg } = await Location.requestForegroundPermissionsAsync();
    if (fg !== 'granted') return false;

    const { status: bg } = await Location.requestBackgroundPermissionsAsync();
    return bg === 'granted';
  } catch (e) {
    console.warn('[ALINE GPS] Permission request failed:', e);
    return false;
  }
}

// ---------- start / stop ----------------------------------------------------

// Build platform-safe options — ActivityType and showsBackgroundLocationIndicator
// are iOS-only; accessing them on Android returns undefined and crashes at
// module load time if evaluated eagerly.
function buildTaskOptions(): Location.LocationTaskOptions {
  // Testing-friendly cadence: 2 min / 30 m. Production should dial back to
  // 15 min / 50 m for battery (TODO before public launch).
  const TIME_MS = 2 * 60 * 1000;
  const DIST_M  = 30;

  const base: Location.LocationTaskOptions = {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: TIME_MS,
    distanceInterval: DIST_M,
    foregroundService: {              // Android: required for background access
      notificationTitle: 'ALINE',
      notificationBody: 'Learning your routines in the background',
      notificationColor: '#7C6AF7',
    },
    deferredUpdatesInterval: TIME_MS,
    deferredUpdatesDistance: DIST_M,
  };

  if (Platform.OS === 'ios') {
    base.pausesUpdatesAutomatically = true;   // let iOS pause when stationary
    base.showsBackgroundLocationIndicator = true;
    base.activityType = Location.ActivityType.Other;
  }

  return base;
}

export async function startBackgroundGps(): Promise<void> {
  try {
    const hasPerms = await requestLocationPermissions();
    if (!hasPerms) {
      console.log('[ALINE GPS] Background location permission not granted — skipping');
      return;
    }

    const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    if (alreadyRunning) return;

    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, buildTaskOptions());
    console.log('[ALINE GPS] Background task started');
  } catch (e) {
    // Never crash the app over GPS setup failure
    console.warn('[ALINE GPS] startBackgroundGps failed:', e);
  }
}

export async function stopBackgroundGps(): Promise<void> {
  try {
    const running = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    if (running) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
      console.log('[ALINE GPS] Background task stopped');
    }
  } catch (e) {
    console.warn('[ALINE GPS] stopBackgroundGps failed:', e);
  }
}
