import * as AppleAuthentication from 'expo-apple-authentication';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../lib/auth-context';
import { colors, radius, space } from '../theme';

/**
 * Native "Sign in with Apple" button + an "or" divider underneath. Renders
 * nothing where Apple auth isn't available (Android, web, old iOS). New and
 * returning users take the same path — the root route then sends new accounts
 * into onboarding.
 */
export function AppleSignInButton() {
  const { signInWithApple } = useAuth();
  const router = useRouter();
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    AppleAuthentication.isAvailableAsync().then(setAvailable).catch(() => setAvailable(false));
  }, []);

  if (!available) return null;

  const onPress = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    const { error: err, cancelled } = await signInWithApple();
    setBusy(false);
    if (cancelled) return;
    if (err) {
      setError(err.message);
      return;
    }
    router.replace('/');
  };

  return (
    <View style={{ gap: space.md }}>
      <AppleAuthentication.AppleAuthenticationButton
        buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
        buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
        cornerRadius={radius.md}
        style={styles.button}
        onPress={onPress}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <View style={styles.dividerRow}>
        <View style={styles.line} />
        <Text style={styles.or}>or use email</Text>
        <View style={styles.line} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  button: { height: 50, width: '100%' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  line: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  or: { color: colors.textMuted, fontSize: 13 },
  errorText: { color: colors.danger, fontSize: 13, lineHeight: 18 },
});
