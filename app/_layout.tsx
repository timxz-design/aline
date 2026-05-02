import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../src/lib/auth-context';
import { colors } from '../src/theme';
// Must be imported at root so TaskManager.defineTask runs before any background wake-up
import '../src/lib/backgroundGps';

// ---------- debug error boundary (remove before public launch) --------------
class DebugErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const { error } = this.state;
    if (error) {
      return (
        <View style={{ flex: 1, backgroundColor: '#0A0E1A', padding: 24, paddingTop: 60 }}>
          <Text style={{ color: '#FF4444', fontSize: 18, fontWeight: 'bold', marginBottom: 12 }}>
            💥 JS Crash
          </Text>
          <ScrollView>
            <Text style={{ color: '#FF8888', fontSize: 14, marginBottom: 8 }}>
              {error.message}
            </Text>
            <Text style={{ color: '#888', fontSize: 11, fontFamily: 'monospace' }}>
              {error.stack}
            </Text>
          </ScrollView>
        </View>
      );
    }
    return this.props.children;
  }
}
// ---------- end debug boundary ----------------------------------------------

export default function RootLayout() {
  return (
    <DebugErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
        <SafeAreaProvider>
          <AuthProvider>
            <StatusBar style="light" />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bg },
                animation: 'fade',
              }}
            >
              <Stack.Screen name="index" />
              <Stack.Screen name="(auth)" />
              <Stack.Screen name="(app)" />
            </Stack>
          </AuthProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </DebugErrorBoundary>
  );
}
