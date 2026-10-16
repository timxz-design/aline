import * as Calendar from 'expo-calendar';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Pedometer } from 'expo-sensors';
import { hasHealthAuthorization } from './health';

/**
 * Current OS permission state for everything ALINE reads. Shared by the
 * onboarding permissions step and the You tab's Sources rows.
 * 'partial' = location granted only "While Using" (routines need "Always").
 */

export type PermissionState = 'on' | 'partial' | 'off';
export type PermissionKey = 'location' | 'calendar' | 'motion' | 'health' | 'notifications';

export async function readPermissionStates(): Promise<Record<PermissionKey, PermissionState>> {
  const [fg, bg, cal, motion, notif, healthOn] = await Promise.all([
    Location.getForegroundPermissionsAsync().catch(() => null),
    Location.getBackgroundPermissionsAsync().catch(() => null),
    Calendar.getCalendarPermissionsAsync().catch(() => null),
    Pedometer.getPermissionsAsync().catch(() => null),
    Notifications.getPermissionsAsync().catch(() => null),
    // HealthKit never reveals read-access status; this is our own record of
    // the user having completed the Health sheet.
    hasHealthAuthorization(),
  ]);
  return {
    location: bg?.granted ? 'on' : fg?.granted ? 'partial' : 'off',
    calendar: cal?.granted ? 'on' : 'off',
    motion: motion?.granted ? 'on' : 'off',
    health: healthOn ? 'on' : 'off',
    notifications: notif?.granted ? 'on' : 'off',
  };
}
