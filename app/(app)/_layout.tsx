import { Redirect, Tabs } from 'expo-router';
import { Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth-context';
// GPS temporarily disabled for crash diagnostics
// import { useEffect } from 'react';
// import { startBackgroundGps, stopBackgroundGps } from '../../src/lib/backgroundGps';
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

  // GPS temporarily disabled for crash diagnostics
  // useEffect(() => {
  //   if (!session) return;
  //   startBackgroundGps();
  //   return () => { stopBackgroundGps(); };
  // }, [session?.user.id]);

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
