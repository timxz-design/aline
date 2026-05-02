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
import { supabase } from './supabase';

export const BACKGROUND_LOCATION_TASK = 'aline-background-location';

// ---------- geohash encoding (standard base32 algo, no external dep) --------

const GH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encodeGeohash(lat: number, lon: number, precision: number): string {
  let idx = 0, bit = 0;
  let evenBit = true;
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let hash = '';

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { idx = idx * 2 + 1; lonMin = mid; }
      else            { idx = idx * 2;     lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { idx = idx * 2 + 1; latMin = mid; }
      else            { idx = idx * 2;     latMax = mid; }
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      hash += GH_BASE32[idx];
      bit = 0; idx = 0;
    }
  }
  return hash;
}

// ---------- motion state mapping --------------------------------------------

type MotionState = 'stationary' | 'walking' | 'running' | 'cycling' | 'driving' | 'unknown';

function activityToMotion(activity: Location.LocationActivityType | undefined): MotionState {
  switch (activity) {
    case Location.LocationActivityType.Fitness:
    case Location.LocationActivityType.Other:
      return 'walking';
    case Location.LocationActivityType.AutomotiveNavigation:
      return 'driving';
    case Location.LocationActivityType.OtherNavigation:
      return 'cycling';
    default:
      return 'unknown';
  }
}

// ---------- task definition (must run at import time) -----------------------

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[ALINE GPS] Task error:', error.message);
    return;
  }

  const { locations } = data as { locations: Location.LocationObject[] };
  if (!locations?.length) return;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;

  const pings = locations.map((loc) => ({
    user_id: session.user.id,
    captured_at: new Date(loc.timestamp).toISOString(),
    geohash_8: encodeGeohash(loc.coords.latitude, loc.coords.longitude, 8),
    motion_state: activityToMotion(undefined) as MotionState,
    battery_level: null as number | null,
  }));

  const { error: insertErr } = await supabase
    .from('behavioral_pings')
    .insert(pings);

  if (insertErr) {
    console.warn('[ALINE GPS] Upload failed:', insertErr.message);
  }
});

// ---------- permission helpers ----------------------------------------------

export async function requestLocationPermissions(): Promise<boolean> {
  const { status: fg } = await Location.requestForegroundPermissionsAsync();
  if (fg !== 'granted') return false;

  const { status: bg } = await Location.requestBackgroundPermissionsAsync();
  return bg === 'granted';
}

// ---------- start / stop ----------------------------------------------------

const TASK_OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.Balanced,
  timeInterval: 15 * 60 * 1000,     // at most once per 15 min
  distanceInterval: 50,              // skip if moved < 50 m
  pausesUpdatesAutomatically: true,  // iOS: OS pauses when stationary
  activityType: Location.ActivityType.Other,
  showsBackgroundLocationIndicator: true,
  foregroundService: {
    notificationTitle: 'ALINE',
    notificationBody: 'Learning your routines in the background',
    notificationColor: '#7C6AF7',
  },
  deferredUpdatesInterval: 15 * 60 * 1000,
  deferredUpdatesDistance: 50,
};

export async function startBackgroundGps(): Promise<void> {
  const hasPerms = await requestLocationPermissions();
  if (!hasPerms) {
    console.log('[ALINE GPS] Background location permission not granted — skipping');
    return;
  }

  const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (alreadyRunning) return;

  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, TASK_OPTIONS);
  console.log('[ALINE GPS] Background task started');
}

export async function stopBackgroundGps(): Promise<void> {
  const running = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (running) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    console.log('[ALINE GPS] Background task stopped');
  }
}
