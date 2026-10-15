import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

/**
 * Current Wi-Fi network from iOS (NEHotspotNetwork). Native code lives in
 * ./ios/WifiInfoModule.swift. Returns null off Wi-Fi, on Android/web, or when
 * the native module isn't in the build — callers must treat null as "unknown".
 */
export type WifiNetwork = { ssid: string | null; bssid: string | null };

type WifiInfoNative = { fetchCurrent(): Promise<WifiNetwork | null> };

const native = Platform.OS === 'ios' ? requireOptionalNativeModule<WifiInfoNative>('WifiInfo') : null;

export async function fetchCurrentWifi(): Promise<WifiNetwork | null> {
  if (!native) return null;
  try {
    return (await native.fetchCurrent()) ?? null;
  } catch {
    return null;
  }
}

export function isWifiInfoAvailable(): boolean {
  return native != null;
}
