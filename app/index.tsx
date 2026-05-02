import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '../src/lib/auth-context';
import { useProfile } from '../src/lib/use-profile';
import { colors } from '../src/theme';

/**
 * Root route — decides where to send the user based on auth + onboarding state.
 *
 *  - auth still loading → spinner
 *  - signed out → /(auth)/sign-in
 *  - signed in but onboarding not complete → /(onboarding)
 *  - signed in and onboarded → /(app)/week
 *
 * The profile loader gates onboarding routing. We block on profile load to
 * avoid a flash where a fresh user briefly sees the app before being
 * redirected to onboarding.
 */
export default function Index() {
  const { session, loading: authLoading } = useAuth();
  const { profile, loading: profileLoading } = useProfile();

  if (authLoading || (session && profileLoading)) return <Spinner />;

  if (!session) return <Redirect href="/(auth)/sign-in" />;

  if (profile && !profile.onboarding_complete) {
    return <Redirect href="/(onboarding)" />;
  }

  return <Redirect href="/(app)/week" />;
}

function Spinner() {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}
