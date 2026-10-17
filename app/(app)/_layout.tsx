import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import { Redirect, Tabs, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState, Text, View, type AppStateStatus } from 'react-native';
import { logSessionClose, logSessionOpen, type SessionSource } from '../../src/lib/app-sessions';
import { useAuth } from '../../src/lib/auth-context';
import { maybeRecompute } from '../../src/lib/auto-recompute';
import { syncMotionActivity, syncVisits } from '../../src/lib/day-signals';
import { foregroundSampleOnce, startBackgroundGps, stopBackgroundGps, syncGeofences } from '../../src/lib/backgroundGps';
import { syncDeviceCalendar } from '../../src/lib/device-calendar';
import { syncHealth } from '../../src/lib/health';
import {
  registerForPushNotifications,
  routeForNotification,
} from '../../src/lib/push-notifications';
import { ensureMotionPermission, reportCollectionHealth, syncSteps } from '../../src/lib/signals';
import { useProfile } from '../../src/lib/use-profile';
import { colors, space } from '../../src/theme';

/** Tab icons — Ionicons, filled variant when focused. */
function TabIcon({ name, focused }: { name: keyof typeof Ionicons.glyphMap; focused: boolean }) {
  return (
    <Ionicons
      name={name}
      size={22}
      color={focused ? colors.accent : colors.textDim}
    />
  );
}

export default function AppLayout() {
  const { session, loading: authLoading } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const router = useRouter();

  useEffect(() => {
    if (!session) return;
    startBackgroundGps();
    return () => { stopBackgroundGps(); };
  }, [session?.user.id]);

  // Auto-recompute the behavioral pipeline (cluster → resolve → routines →
  // summary). Throttled to ≤1 run per hour per device. Runs in the background;
  // never blocks the UI. Triggered on:
  //   - first mount with a session (cold app open)
  //   - foreground transitions (user comes back to the app)
  //
  // Also logs app sessions: cold_start on initial mount, background_resume on
  // foreground transitions, with a duration_seconds update on background.
  // Powers wake/sleep inference and morning-ritual detection.
  const sessionIdRef = useRef<string | null>(null);
  const sessionStartMsRef = useRef<number>(0);
  const notificationTapPendingRef = useRef<boolean>(false);

  useEffect(() => {
    if (!session) return;

    // Cold start: insert the first session row. Default to cold_start; if a
    // notification tap routing fires below we'll have already flipped the
    // ref so the session is tagged accordingly.
    const initialSource: SessionSource = notificationTapPendingRef.current
      ? 'notification_tap'
      : 'cold_start';
    notificationTapPendingRef.current = false;
    sessionStartMsRef.current = Date.now();
    logSessionOpen(initialSource).then((id) => {
      sessionIdRef.current = id;
    });

    // Fire once now — DEFERRED off the startup critical path (heavy JS at
    // cold open competes with first paint/first queries; a hung stage used
    // to freeze the whole app at launch).
    // Device calendar import rides the same deferred slot (no-ops without
    // permission; throttled to once per 15 min). Google is kept fresh by the
    // google_calendar_sync_30min cron, so it needs no client trigger here.
    // Same slot: step backfill (asks for Motion access once) and the
    // collection-health heartbeat.
    const recomputeTimer = setTimeout(() => {
      maybeRecompute();
      syncDeviceCalendar();
      ensureMotionPermission().then(() => {
        syncSteps();
        syncMotionActivity(); // same Motion & Fitness permission
      });
      syncVisits();
      syncHealth(); // no-op until Apple Health is connected
      reportCollectionHealth();
    }, 8000);
    // Cold-launch location sample. The AppState 'active' handler below only
    // fires on foreground *resume*, so without this a cold open never captured
    // "where you are right now". No-ops silently if permission isn't granted
    // yet (e.g. first-ever launch); the resume handler picks it up after.
    foregroundSampleOnce();

    // Re-fire whenever the app comes to foreground / log open + close.
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') {
        const src: SessionSource = notificationTapPendingRef.current
          ? 'notification_tap'
          : 'background_resume';
        notificationTapPendingRef.current = false;
        sessionStartMsRef.current = Date.now();
        logSessionOpen(src).then((id) => {
          sessionIdRef.current = id;
        });
        setTimeout(() => {
          maybeRecompute();
          syncDeviceCalendar();
          syncSteps();
          syncMotionActivity();
          syncVisits();
          syncHealth();
          reportCollectionHealth();
        }, 8000);
        foregroundSampleOnce(); // capture current location on app open
        syncGeofences(); // refresh monitored places (clustering may have changed them)

      } else if (next === 'background' || next === 'inactive') {
        const id = sessionIdRef.current;
        const start = sessionStartMsRef.current;
        if (id && start) {
          const duration = (Date.now() - start) / 1000;
          // Fire and forget — never block AppState transitions.
          logSessionClose(id, duration);
        }
        sessionIdRef.current = null;
      }
    });
    return () => { sub.remove(); clearTimeout(recomputeTimer); };
  }, [session?.user.id]);

  // Register for push notifications + handle taps. Done once user has a session.
  useEffect(() => {
    if (!session) return;
    registerForPushNotifications();

    // If the app was opened cold by tapping a notification, route to the
    // relevant screen. Also tag the upcoming session as notification_tap so
    // wake-time inference knows the source.
    Notifications.getLastNotificationResponseAsync().then((res) => {
      if (!res) return;
      notificationTapPendingRef.current = true;
      const data = res.notification.request.content.data as
        | Record<string, unknown>
        | undefined;
      const route = routeForNotification(data);
      // Slight delay so the tab navigator is mounted before we navigate.
      setTimeout(() => router.push(route as never), 100);
    });

    // Live taps while app is running
    const sub = Notifications.addNotificationResponseReceivedListener((res) => {
      notificationTapPendingRef.current = true;
      const data = res.notification.request.content.data as
        | Record<string, unknown>
        | undefined;
      router.push(routeForNotification(data) as never);
    });
    return () => sub.remove();
  }, [session?.user.id, router]);

  if (authLoading || profileLoading) return null;
  if (!session) return <Redirect href="/(auth)/sign-in" />;
  // Tab layout is only for users who finished onboarding. The root index
  // already routes here when appropriate; this is a defense-in-depth check.
  if (profile && !profile.onboarding_complete) {
    return <Redirect href="/(onboarding)" />;
  }

  return (
    <Tabs
      initialRouteName="agent"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textDim,
        tabBarStyle: {
          backgroundColor: colors.bgElevated,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          paddingTop: space.xs,
          paddingBottom: space.sm,
          height: 64,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="agent"
        options={{
          title: 'Agent',
          tabBarIcon: ({ focused }) => <TabIcon name={focused ? "sparkles" : "sparkles-outline"} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="week"
        options={{
          title: 'My Week',
          tabBarIcon: ({ focused }) => <TabIcon name={focused ? "calendar" : "calendar-outline"} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="groups"
        options={{
          title: 'People',
          tabBarIcon: ({ focused }) => <TabIcon name={focused ? "people" : "people-outline"} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'You',
          tabBarIcon: ({ focused }) => <TabIcon name={focused ? "person-circle" : "person-circle-outline"} focused={focused} />,
        }}
      />
      {/* Goals + Events are reached from the agent header, not the tab bar. */}
      <Tabs.Screen name="goals" options={{ href: null }} />
      <Tabs.Screen name="events" options={{ href: null }} />
    </Tabs>
  );
}
