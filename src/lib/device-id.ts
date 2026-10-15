import * as Application from 'expo-application';
import { Platform } from 'react-native';

/**
 * Stable id for this physical device (iOS identifierForVendor), tagged on every
 * ping and heartbeat so two phones signed into one account can't silently mix
 * their locations. Resets only if every app from this vendor is uninstalled.
 */
let cached: Promise<string> | null = null;

export function getDeviceId(): Promise<string> {
  if (!cached) {
    cached = (async () => {
      try {
        if (Platform.OS === 'ios') return (await Application.getIosIdForVendorAsync()) ?? 'unknown';
        if (Platform.OS === 'android') return Application.getAndroidId() ?? 'unknown';
      } catch {
        /* fall through */
      }
      return 'unknown';
    })();
  }
  return cached;
}
