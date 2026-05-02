import { Redirect, Stack } from 'expo-router';
import { useAuth } from '../../src/lib/auth-context';
import { OnboardingProvider } from '../../src/lib/onboarding-context';
import { useProfile } from '../../src/lib/use-profile';

/**
 * Onboarding routes — only accessible to a signed-in user who hasn't yet
 * completed onboarding. The OnboardingProvider holds state across screens.
 */
export default function OnboardingLayout() {
  const { session, loading: authLoading } = useAuth();
  const { profile, loading: profileLoading } = useProfile();

  if (authLoading || profileLoading) return null;
  if (!session) return <Redirect href="/(auth)/sign-in" />;
  if (profile?.onboarding_complete) return <Redirect href="/(app)/week" />;

  return (
    <OnboardingProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
        }}
      />
    </OnboardingProvider>
  );
}
