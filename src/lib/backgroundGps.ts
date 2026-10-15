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

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { NetInfoStateType } from '@react-native-community/netinfo';
import * as BackgroundTask from 'expo-background-task';
import * as Battery from 'expo-battery';
import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { encodeGeohash } from './clustering';
import { fetchCurrentWifi } from '../../modules/wifi-info';
import { getDeviceId } from './device-id';
import { supabase } from './supabase';

export const BACKGROUND_LOCATION_TASK = 'aline-background-location';
// Timer-based sampler: fires even when the user is STATIONARY (the movement
// stream above never fires when still). This is what captures "at home doing a
// workout / WFH" presence that the comparator needs.
export const PERIODIC_LOCATION_TASK = 'aline-periodic-location';
// Region monitoring: fires the moment you ENTER one of your significant places.
// This is the highest-certainty presence signal we have — exact arrival at a
// known place — and it's what resolves "unknown" live-status into truth.
export const GEOFENCE_TASK = 'aline-geofencing';

// iOS monitors at most 20 regions per app; keep headroom under that cap.
const MAX_GEOFENCE_REGIONS = 18;
const GEOFENCE_RADIUS_M = 120; // ~reliable lower bound for iOS region monitoring
const GEOFENCE_SYNC_KEY = 'aline_geofence_region_ids'; // skip redundant re-syncs

/** Origin of a behavioral ping — provenance for evidence weighting. */
type PingSource = 'movement' | 'periodic' | 'foreground' | 'geofence';

type MotionState = 'stationary' | 'walking' | 'active' | 'driving' | 'unknown';

/**
 * Bucket the OS-reported ground speed (m/s). iOS reports -1 (and Android may
 * report null/0 without a GPS fix) when speed is invalid — e.g. Wi-Fi/cell fixes
 * at Balanced accuracy — so negative/missing → unknown, never stationary.
 * 1.5–7 m/s is running OR cycling; speed alone can't tell them apart, so it's
 * 'active' rather than a guess.
 */
function motionFromSpeed(speed: number | null | undefined): MotionState {
  if (speed == null || !Number.isFinite(speed) || speed < 0) return 'unknown';
  if (speed < 0.3) return 'stationary';
  if (speed < 1.5) return 'walking';
  if (speed <= 7) return 'active';
  return 'driving';
}

/**
 * Battery level (0–1) + charging state at capture. Charging overnight is a
 * strong asleep-at-home signal; unplugging marks waking up. Never throws.
 */
async function readBattery(): Promise<{ level: number | null; state: string }> {
  try {
    const [level, state] = await Promise.all([
      Battery.getBatteryLevelAsync(),
      Battery.getBatteryStateAsync(),
    ]);
    return {
      level: level >= 0 ? level : null,
      state:
        state === Battery.BatteryState.UNPLUGGED ? 'unplugged'
          : state === Battery.BatteryState.CHARGING ? 'charging'
            : state === Battery.BatteryState.FULL ? 'full'
              : 'unknown',
    };
  } catch {
    return { level: null, state: 'unknown' };
  }
}

// iOS only returns the SSID/BSSID with the Access WiFi Information entitlement
// AND location permission — both of which ALINE has.
NetInfo.configure({ shouldFetchWiFiSSID: true });

// App-wide salt (not per-user): the same router must hash identically for every
// user, so two people on one network can be recognised as together. Raw network
// names and MACs never leave the device.
const WIFI_SALT = 'aline-wifi-v1:';
// iOS returns this placeholder BSSID when it won't reveal the real one.
const BLANK_BSSIDS = new Set(['02:00:00:00:00:00', '00:00:00:00:00:00']);

export { BLANK_BSSIDS };

async function hashWifi(value: string | null | undefined): Promise<string | null> {
  const v = value?.trim().toLowerCase();
  if (!v || BLANK_BSSIDS.has(v)) return null;
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, WIFI_SALT + v);
}

/**
 * Network context at capture: on Wi-Fi usually means "at a place", cellular
 * means "out". The hashed BSSID fingerprints the exact access point — a
 * room-level location that keeps working indoors where GPS drifts.
 */
async function readNetwork(): Promise<{
  network_type: string;
  wifi_bssid_hash: string | null;
  wifi_ssid_hash: string | null;
}> {
  try {
    // refresh(), not fetch(): fetch() returns NetInfo's cached state from the
    // last connectivity event, which can predate this ping by hours.
    const state = await NetInfo.refresh();
    const network_type =
      state.type === NetInfoStateType.wifi ? 'wifi'
        : state.type === NetInfoStateType.cellular ? 'cellular'
          : state.type === NetInfoStateType.none ? 'none'
            : 'other';
    if (state.type !== NetInfoStateType.wifi) {
      return { network_type, wifi_bssid_hash: null, wifi_ssid_hash: null };
    }
    // Apple's current API first (NEHotspotNetwork, local module); NetInfo's
    // deprecated CNCopyCurrentNetworkInfo returned nothing on iOS 26.
    const native = await fetchCurrentWifi();
    const [wifi_bssid_hash, wifi_ssid_hash] = await Promise.all([
      hashWifi(native?.bssid ?? state.details.bssid),
      hashWifi(native?.ssid ?? state.details.ssid),
    ]);
    return { network_type, wifi_bssid_hash, wifi_ssid_hash };
  } catch {
    return { network_type: 'other', wifi_bssid_hash: null, wifi_ssid_hash: null };
  }
}

/** Raw speed worth storing: valid readings only (see motionFromSpeed). */
function validSpeed(speed: number | null | undefined): number | null {
  return speed == null || !Number.isFinite(speed) || speed < 0 ? null : speed;
}

// Minimum time between uploaded pings, regardless of how often iOS fires the
// task. iOS ignores the timeInterval option (Android-only) and fires on every
// 200m crossed — which at highway speeds is every ~7s. Place clustering only
// cares about stationary points; travel-path density is wasted writes. This
// cap keeps the upload rate sane during long drives.
const MIN_UPLOAD_GAP_MS = 60 * 1000; // 1 minute
const LAST_PING_KEY = 'aline_last_ping_uploaded_ms';

// ---------- task definition (must run at import time) -----------------------

/**
 * Shared ping recorder: throttle → resolve session → insert geohash-8 ping.
 * Used by the movement stream, the periodic sampler, and the foreground sample.
 * `force` skips the throttle (for explicit one-shot samples).
 */
async function recordPing(
  lat: number,
  lon: number,
  capturedAtMs: number,
  force = false,
  source: PingSource = 'movement',
  speedMps: number | null = null,
  motionState: MotionState = motionFromSpeed(speedMps),
): Promise<void> {
  try {
    const now = Date.now();
    if (!force) {
      try {
        const lastRaw = await AsyncStorage.getItem(LAST_PING_KEY);
        const last = lastRaw ? parseInt(lastRaw, 10) : 0;
        if (Number.isFinite(last) && now - last < MIN_UPLOAD_GAP_MS) return;
      } catch { /* ignore */ }
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const [battery, network, device_id] = await Promise.all([readBattery(), readNetwork(), getDeviceId()]);
    const { error: insertErr } = await supabase.from('behavioral_pings').insert([{
      user_id: session.user.id,
      captured_at: new Date(capturedAtMs).toISOString(),
      geohash_8: encodeGeohash(lat, lon, 8),
      motion_state: motionState,
      speed_mps: speedMps,
      battery_level: battery.level,
      battery_state: battery.state,
      ...network,
      device_id,
      source,
    }]);
    if (insertErr) {
      console.warn('[ALINE GPS] Upload failed:', insertErr.message);
      return;
    }
    try { await AsyncStorage.setItem(LAST_PING_KEY, String(now)); } catch { /* ignore */ }
  } catch (e) {
    console.warn('[ALINE GPS] recordPing exception:', e);
  }
}

// Movement stream: fires when iOS delivers a location update (distance-based).
TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[ALINE GPS] Task error:', error.message);
    return;
  }
  const { locations } = data as { locations: Location.LocationObject[] };
  if (!locations?.length) return;
  const loc = locations[0];
  await recordPing(
    loc.coords.latitude, loc.coords.longitude, loc.timestamp, false, 'movement',
    validSpeed(loc.coords.speed),
  );
});

// Periodic timer task (expo-background-task / iOS BGTaskScheduler): fires on the
// OS's schedule even when stationary. Grabs a one-shot fix so we capture presence
// while the user is sitting still (home workout, WFH, etc.).
TaskManager.defineTask(PERIODIC_LOCATION_TASK, async () => {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return BackgroundTask.BackgroundTaskResult.Success;
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    await recordPing(loc.coords.latitude, loc.coords.longitude, loc.timestamp, true, 'periodic', validSpeed(loc.coords.speed));
  } catch (e) {
    console.warn('[ALINE GPS] Periodic task exception:', e);
  }
  return BackgroundTask.BackgroundTaskResult.Success;
});

// Region monitoring task: fires when the OS detects you crossing into one of
// your monitored places. An ENTER is the strongest presence signal available —
// certain arrival at a known place — so record a forced ping at the region
// center, tagged stationary + geofence provenance, to resolve the comparator's
// "unknown" status into truth. Enter-only for v1; exit/departure timing is
// deferred to the travel-planning track.
TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[ALINE GPS] Geofence task error:', error.message);
    return;
  }
  const { eventType, region } = (data ?? {}) as {
    eventType: Location.GeofencingEventType;
    region: Location.LocationRegion;
  };
  if (eventType !== Location.GeofencingEventType.Enter) return;
  if (region?.latitude == null || region?.longitude == null) return;
  await recordPing(
    region.latitude,
    region.longitude,
    Date.now(),
    true,
    'geofence',
    null,
    'stationary',
  );
});

/**
 * One-shot location sample — call when the app comes to the foreground so we
 * capture "where you are right now" immediately, without waiting on the OS timer.
 */
export async function foregroundSampleOnce(): Promise<void> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return;
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    await recordPing(loc.coords.latitude, loc.coords.longitude, loc.timestamp, true, 'foreground', validSpeed(loc.coords.speed));
  } catch (e) {
    console.warn('[ALINE GPS] foregroundSampleOnce failed:', e);
  }
}

/**
 * Register region monitoring for the user's most-visited places (capped under
 * the iOS 20-region limit). Skips hidden/sensitive places (privacy) and any
 * without a centroid. Re-syncs only when the monitored set changes, so it's
 * cheap to call on every foreground. Requires background ("Always") location
 * permission — same grant the movement stream needs.
 */
export async function syncGeofences(): Promise<void> {
  try {
    const { status } = await Location.getBackgroundPermissionsAsync();
    if (status !== 'granted') return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const { data: places, error } = await supabase
      .from('places')
      .select('id, centroid_lat, centroid_lon, visit_count')
      .eq('user_id', session.user.id)
      .eq('is_hidden', false)
      .eq('is_sensitive', false)
      .not('centroid_lat', 'is', null)
      .not('centroid_lon', 'is', null)
      .order('visit_count', { ascending: false })
      .limit(MAX_GEOFENCE_REGIONS);
    if (error) {
      console.warn('[ALINE GPS] Geofence place query failed:', error.message);
      return;
    }

    const regions: Location.LocationRegion[] = (places ?? [])
      .filter((p) => p.centroid_lat != null && p.centroid_lon != null)
      .map((p) => ({
        identifier: p.id as string,
        latitude: p.centroid_lat as number,
        longitude: p.centroid_lon as number,
        radius: GEOFENCE_RADIUS_M,
        notifyOnEnter: true,
        notifyOnExit: false,
      }));

    const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);

    if (regions.length === 0) {
      if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK);
      try { await AsyncStorage.removeItem(GEOFENCE_SYNC_KEY); } catch { /* ignore */ }
      return;
    }

    // Re-register only if the monitored set actually changed (startGeofencing
    // replaces the whole set, so churning it on every foreground is wasteful).
    const signature = regions.map((r) => r.identifier).sort().join(',');
    try {
      const prev = await AsyncStorage.getItem(GEOFENCE_SYNC_KEY);
      if (started && prev === signature) return;
    } catch { /* ignore */ }

    await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
    try { await AsyncStorage.setItem(GEOFENCE_SYNC_KEY, signature); } catch { /* ignore */ }
    console.log(`[ALINE GPS] Geofencing ${regions.length} place(s)`);
  } catch (e) {
    console.warn('[ALINE GPS] syncGeofences failed:', e);
  }
}

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
  // Production cadence: 15 min / 200 m.
  // Note: on iOS the timeInterval is IGNORED — only distanceInterval applies.
  // We use 200 m so a car drive (50 km/h) yields a ping every ~14 s instead of
  // every ~3 s. Routine detection cares about stationary clusters, not travel
  // paths — denser sampling during transit is wasted bandwidth + battery.
  // Android honours both intervals.
  const TIME_MS = 15 * 60 * 1000;
  const DIST_M  = 200;

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
    // Don't let iOS fully pause when stationary — the periodic task is our
    // stationary safety net, but keeping the stream alive helps too.
    base.pausesUpdatesAutomatically = false;
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

    // Register the periodic stationary sampler (OS-scheduled, ~15 min best-effort).
    try {
      await BackgroundTask.registerTaskAsync(PERIODIC_LOCATION_TASK, { minimumInterval: 15 });
      console.log('[ALINE GPS] Periodic sampler registered');
    } catch (e) {
      console.warn('[ALINE GPS] Periodic sampler registration failed:', e);
    }

    // Register region monitoring for the user's significant places. Best-effort.
    await syncGeofences();
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
    try { await BackgroundTask.unregisterTaskAsync(PERIODIC_LOCATION_TASK); } catch { /* ignore */ }
    try {
      if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) {
        await Location.stopGeofencingAsync(GEOFENCE_TASK);
      }
    } catch { /* ignore */ }
    try { await AsyncStorage.removeItem(GEOFENCE_SYNC_KEY); } catch { /* ignore */ }
  } catch (e) {
    console.warn('[ALINE GPS] stopBackgroundGps failed:', e);
  }
}
