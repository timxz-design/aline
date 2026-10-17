import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

/**
 * iOS day signals (native code: ./ios/DaySignalsModule.swift):
 *  - Visit monitoring: iOS records arrivals/departures (CLVisit) even while
 *    ALINE is closed, queued natively until JS uploads them.
 *  - Motion activity history: the ~7 days of stationary / walking / running /
 *    cycling / driving that iOS records on its own.
 * Everything degrades to empty/false on Android, web, or a build without it.
 */

export type NativeVisit = {
  lat: number;
  lon: number;
  accuracy: number;
  recordedAt: number;
  /** ms since epoch; missing when iOS didn't know the arrival. */
  arrival?: number;
  /** ms since epoch; missing while you're still there. */
  departure?: number;
};

export type MotionKind = 'stationary' | 'walking' | 'running' | 'cycling' | 'driving' | 'unknown';
export type MotionSample = { start: number; kind: MotionKind; confidence: 0 | 1 | 2 };

type DaySignalsNative = {
  startVisitMonitoring(): boolean;
  stopVisitMonitoring(): void;
  pendingVisits(): NativeVisit[];
  ackVisits(count: number): void;
  isMotionActivityAvailable(): boolean;
  queryMotionActivity(fromMs: number, toMs: number): Promise<MotionSample[]>;
};

const native = Platform.OS === 'ios' ? requireOptionalNativeModule<DaySignalsNative>('DaySignals') : null;

export function startVisitMonitoring(): boolean {
  try {
    return native?.startVisitMonitoring() ?? false;
  } catch {
    return false;
  }
}

export function stopVisitMonitoring(): void {
  try {
    native?.stopVisitMonitoring();
  } catch { /* ignore */ }
}

export function pendingVisits(): NativeVisit[] {
  try {
    return native?.pendingVisits() ?? [];
  } catch {
    return [];
  }
}

export function ackVisits(count: number): void {
  try {
    native?.ackVisits(count);
  } catch { /* ignore */ }
}

export function isMotionActivityAvailable(): boolean {
  try {
    return native?.isMotionActivityAvailable() ?? false;
  } catch {
    return false;
  }
}

export async function queryMotionActivity(fromMs: number, toMs: number): Promise<MotionSample[]> {
  if (!native) return [];
  try {
    return (await native.queryMotionActivity(fromMs, toMs)) ?? [];
  } catch {
    return [];
  }
}
