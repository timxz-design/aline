import * as Notifications from 'expo-notifications';
import { Redirect, Tabs, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { AppState, Text, View, type AppStateStatus } from 'react-native';
import { useAuth } from '../../src/lib/auth-context';
import { maybeRecompute } from '../../src/lib/auto-recompute';
import { startBackgroundGps, stopBackgroundGps } from '../../src/lib/backgroundGps';
import {
  registerForPushNotifications,
  routeForNotification,
} from '../../src/lib/push-notifications';
import { useProfile } from '../../src/lib/use-profile';
import { colors, space } from '../../src/theme';

/**
 * Tab icons. Plain typography so we don't pull in an icon library yet —
 * we can swap to lucide-react-native or @expo/vector-icons in the next pass.
 */
function TabIcon({ symbol, focused }: { symbol: string; focused: boolean }) {
  return (
    <View
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
      }}
    >
      <Text
        style={{
          fontSize: 16,
          color: focused ? colors.accent : colors.textDim,
        }}
      >
        {symbol}
      </Text>
    </View>
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
  useEffect(() => {
    if (!session) return;

    // Fire once now (throttle inside maybeRecompute will skip if too recent).
    maybeRecompute();

    // Re-fire whenever the app comes to foreground.
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') maybeRecompute();
    });
    return () => sub.remove();
  }, [session?.user.id]);

  // Register for push notifications + handle taps. Done once user has a session.
  useEffect(() => {
    if (!session) return;
    registerForPushNotifications();

    // If the app was opened cold by tapping a notification, route to the
    // relevant screen.
    Notifications.getLastNotificationResponseAsync().then((res) => {
      if (!res) return;
      const data = res.notification.request.content.data as
        | Record<string, unknown>
        | undefined;
      const route = routeForNotification(data);
      // Slight delay so the tab navigator is mounted before we navigate.
      setTimeout(() => router.push(route as never), 100);
    });

    // Live taps while app is running
    const sub = Notifications.addNotificationResponseReceivedListener((res) => {
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
        name="week"
        options={{
          title: 'My Week',
          tabBarIcon: ({ focused }) => <TabIcon symbol="◫" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="groups"
        options={{
          title: 'Groups',
          tabBarIcon: ({ focused }) => <TabIcon symbol="◉" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="agent"
        options={{
          title: 'Agent',
          tabBarIcon: ({ focused }) => <TabIcon symbol="✦" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'You',
          tabBarIcon: ({ focused }) => <TabIcon symbol="◐" focused={focused} />,
        }}
      />
    </Tabs>
  );
}
