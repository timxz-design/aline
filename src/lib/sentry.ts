/**
 * Sentry initialization for ALINE.
 *
 * Sentry is only enabled when `EXPO_PUBLIC_SENTRY_DSN` is present in the env.
 * Missing DSN → all functions become no-ops, the app keeps running normally.
 * This way the code can land in main before the user signs up at sentry.io
 * and pushes the DSN to EAS env vars.
 *
 * Usage:
 *   1. Create a free account at sentry.io
 *   2. New project → React Native → grab the DSN
 *   3. Add EXPO_PUBLIC_SENTRY_DSN=<dsn> to .env (local dev)
 *   4. Push to EAS:
 *        eas env:create --scope project --environment preview \
 *          --name EXPO_PUBLIC_SENTRY_DSN --value "<dsn>" --visibility plaintext
 *   5. Rebuild
 *
 * Privacy: Sentry by default scrubs PII from request payloads. We additionally
 * tag events with auth.uid() so we can correlate crashes to the right user
 * during incident response without exposing email or display name.
 */

import * as Sentry from '@sentry/react-native';

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
const ENABLED = !!DSN;

let initialized = false;

export function initSentry() {
  if (!ENABLED || initialized) return;

  try {
    Sentry.init({
      dsn: DSN,
      // For prototype phase: capture everything. We can sample down later
      // once the volume is real.
      tracesSampleRate: 1.0,
      // Disable user-agent / IP collection where the SDK lets us — privacy
      // posture is "minimal default capture" for friend MVP.
      sendDefaultPii: false,
      // Tag every event with the runtime context so we can filter by build.
      environment: __DEV__ ? 'development' : 'production',
      // Don't send events in __DEV__ runs by default — devs see their
      // own crashes via console + the dev menu.
      enabled: !__DEV__,
    });
    initialized = true;
  } catch (e) {
    console.warn('[sentry] init failed:', e);
  }
}

/** Tag the current Sentry scope with the signed-in user's id. Call this on
 *  every auth state change. Pass null to clear (sign-out). */
export function setSentryUser(userId: string | null) {
  if (!ENABLED) return;
  try {
    if (userId) {
      Sentry.setUser({ id: userId });
    } else {
      Sentry.setUser(null);
    }
  } catch {
    /* swallow */
  }
}

/** Manually capture an exception that was caught and shouldn't crash the app
 *  but is still worth reporting (e.g. an edge function returning 5xx). */
export function captureException(err: unknown, context?: Record<string, unknown>) {
  if (!ENABLED) return;
  try {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    /* swallow */
  }
}

/** Add a breadcrumb — small log line attached to subsequent events. Useful
 *  for tracing the path that led to a crash. */
export function breadcrumb(message: string, data?: Record<string, unknown>) {
  if (!ENABLED) return;
  try {
    Sentry.addBreadcrumb({ message, data });
  } catch {
    /* swallow */
  }
}

export const sentryEnabled = ENABLED;
