/**
 * Device signals beyond location: collection-health heartbeat + pedometer.
 *
 * - reportCollectionHealth(): one upserted row per user describing whether data
 *   collection can actually work on this device (permissions, Background App
 *   Refresh, whether each background task is registered). Builds 18–33 lost
 *   four months of background data silently; this makes that visible in a day.
 * - syncSteps(): hourly step counts from the iOS pedometer. CoreMotion keeps 7
 *   days of history, so this backfills hours the app was closed — the one
 *   movement signal that doesn't depend on our background tasks running.
 *
 * Both are best-effort and never throw.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as Application from 'expo-application';
import * as BackgroundTask from 'expo-background-task';
import * as Calendar from 'expo-calendar';
import * as Location from 'expo-location';
import { Pedometer } from 'expo-sensors';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import {
  BACKGROUND_LOCATION_TASK,
  BLANK_BSSIDS,
  GEOFENCE_TASK,
  PERIODIC_LOCATION_TASK,
} from './backgroundGps';
import { fetchCurrentWifi, isWifiInfoAvailable } from '../../modules/wifi-info';
import { getDeviceId } from './device-id';
import { hasHealthAuthorization } from './health';
import { supabase } from './supabase';

const STEPS_CURSOR_KEY = 'aline_steps_synced_hour_ms';
const STEPS_MIN_INTERVAL_MS = 30 * 60_000;
const STEPS_HISTORY_HOURS = 7 * 24; // iOS pedometer history limit
const HOUR_MS = 3600_000;

let lastStepsRunMs = 0;

async function userId(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user.id ?? null;
}

export async function reportCollectionHealth(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const uid = await userId();
    if (!uid) return;
    await syncTimezone(uid);

    const [fg, bg, bgTask, locRunning, geoRunning, periodic, cal, motion, lastKnown, cursor, deviceId, wifiProbe, healthOn] =
      await Promise.all([
        Location.getForegroundPermissionsAsync().catch(() => null),
        Location.getBackgroundPermissionsAsync().catch(() => null),
        BackgroundTask.getStatusAsync().catch(() => null),
        Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => null),
        Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => null),
        TaskManager.isTaskRegisteredAsync(PERIODIC_LOCATION_TASK).catch(() => null),
        Calendar.getCalendarPermissionsAsync().catch(() => null),
        Pedometer.getPermissionsAsync().catch(() => null),
        Location.getLastKnownPositionAsync().catch(() => null),
        AsyncStorage.getItem(STEPS_CURSOR_KEY).catch(() => null),
        getDeviceId(),
        probeWifi(),
        hasHealthAuthorization(),
      ]);

    // iOS doesn't expose the "Precise Location" toggle directly; a reduced-
    // accuracy fix comes back with a radius of several km.
    const acc = lastKnown?.coords.accuracy;
    const precise = acc == null ? null : acc < 1000;

    await supabase.from('collection_health').upsert({
      user_id: uid,
      device_id: deviceId,
      wifi_probe: wifiProbe,
      health_connected: healthOn,
      app_build: Application.nativeBuildVersion ?? null,
      os_version: `${Platform.OS} ${Platform.Version}`,
      location_fg: fg?.status ?? null,
      location_bg: bg?.status ?? null,
      location_precise: precise,
      background_refresh:
        bgTask == null ? null
          : bgTask === BackgroundTask.BackgroundTaskStatus.Available ? 'available' : 'restricted',
      location_task_running: locRunning,
      geofencing_running: geoRunning,
      periodic_task_registered: periodic,
      calendar_permission: cal?.status ?? null,
      motion_permission: motion?.status ?? null,
      last_steps_synced_hour: cursor ? new Date(parseInt(cursor, 10)).toISOString() : null,
      reported_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[ALINE signals] reportCollectionHealth failed:', e);
  }
}

/**
 * Keep profiles.timezone equal to the phone's timezone. Every server-side
 * time (pushes, quiet hours, "yesterday", activity checks, visits) is computed
 * in it; new accounts used to get a fixed 'Europe/Ljubljana' default and
 * nothing ever corrected it — wrong for anyone elsewhere or travelling.
 */
async function syncTimezone(uid: string): Promise<void> {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return;
    await supabase.from('profiles').update({ timezone: tz }).eq('id', uid).neq('timezone', tz);
  } catch (e) {
    console.warn('[ALINE signals] timezone sync failed:', e);
  }
}

/**
 * What iOS hands back for the current Wi-Fi network — presence only, never the
 * values. Build 35 got network_type 'wifi' but no SSID/BSSID despite the
 * entitlement, so this tells "iOS withheld it" apart from "we dropped it".
 */
async function probeWifi(): Promise<string | null> {
  try {
    const s = await NetInfo.refresh();
    if (s.type !== 'wifi') return s.type;
    const d = (s.details ?? {}) as { ssid?: string | null; bssid?: string | null };
    const describe = (v: string | null | undefined, isBssid: boolean) =>
      v == null ? 'null'
        : v === '' ? 'empty'
          : isBssid && BLANK_BSSIDS.has(v.toLowerCase()) ? 'placeholder'
            : 'present';
    // Both sources, so the probe shows which one iOS actually answers.
    const native = isWifiInfoAvailable() ? await fetchCurrentWifi() : undefined;
    const nativePart =
      native === undefined ? 'native=absent'
        : native === null ? 'native=null'
          : `native ssid=${describe(native.ssid, false)} bssid=${describe(native.bssid, true)}`;
    return `wifi netinfo ssid=${describe(d.ssid, false)} bssid=${describe(d.bssid, true)} · ${nativePart}`;
  } catch (e) {
    return `error ${(e as Error).message}`.slice(0, 200);
  }
}

/**
 * Ask for Motion & Fitness access if it hasn't been asked yet (iOS only shows
 * the prompt once). Returns whether access is granted.
 */
export async function ensureMotionPermission(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    if (!(await Pedometer.isAvailableAsync())) return false;
    const current = await Pedometer.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    return (await Pedometer.requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/**
 * Upload hourly step counts from the last synced hour (max 7 days back)
 * through the current, still-filling hour. Throttled to once per 30 min.
 * Never prompts — no-ops without Motion permission.
 */
export async function syncSteps(opts: { force?: boolean } = {}): Promise<void> {
  if (Platform.OS !== 'ios') return; // Android has no historical step query
  if (!opts.force && Date.now() - lastStepsRunMs < STEPS_MIN_INTERVAL_MS) return;
  lastStepsRunMs = Date.now();
  try {
    const perm = await Pedometer.getPermissionsAsync();
    if (!perm.granted) return;
    const uid = await userId();
    if (!uid) return;

    const currentHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const oldest = currentHour - (STEPS_HISTORY_HOURS - 1) * HOUR_MS;
    const cursorRaw = await AsyncStorage.getItem(STEPS_CURSOR_KEY).catch(() => null);
    const cursor = cursorRaw ? parseInt(cursorRaw, 10) : NaN;
    // Re-read the cursor hour itself: it was still filling when last synced.
    const start = Number.isFinite(cursor) ? Math.max(cursor, oldest) : oldest;

    const rows: { user_id: string; hour_start: string; steps: number; updated_at: string }[] = [];
    for (let h = start; h <= currentHour; h += HOUR_MS) {
      const end = Math.min(h + HOUR_MS, Date.now());
      try {
        const { steps } = await Pedometer.getStepCountAsync(new Date(h), new Date(end));
        rows.push({
          user_id: uid,
          hour_start: new Date(h).toISOString(),
          steps: Math.max(0, Math.round(steps)),
          updated_at: new Date().toISOString(),
        });
      } catch { /* hour outside the device's history — skip */ }
    }

    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabase
        .from('step_counts')
        .upsert(rows.slice(i, i + 200), { onConflict: 'user_id,hour_start' });
      if (error) {
        console.warn('[ALINE signals] step upload failed:', error.message);
        return; // keep the old cursor so these hours are retried
      }
    }
    await AsyncStorage.setItem(STEPS_CURSOR_KEY, String(currentHour)).catch(() => {});
  } catch (e) {
    console.warn('[ALINE signals] syncSteps failed:', e);
  }
}
