import { Stack } from 'expo-router';
import { ShareIntentProvider } from 'expo-share-intent';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../src/lib/auth-context';
import { initSentry } from '../src/lib/sentry';
import { colors } from '../src/theme';
// Must be imported at root so TaskManager.defineTask runs before any background wake-up
import '../src/lib/backgroundGps';

// Sentry init at module load (before React renders). No-op if DSN missing.
initSentry();

export default function RootLayout() {
  return (
    // Outermost provider: something shared to ALINE from another app (a
    // training schedule screenshot, a pasted message) is picked up by the chat.
    <ShareIntentProvider>
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar style="dark" />
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
    </ShareIntentProvider>
  );
}
