import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AppleSignInButton } from '../../src/components/AppleSignInButton';
import { Button } from '../../src/components/Button';
import { Input } from '../../src/components/Input';
import { Screen } from '../../src/components/Screen';
import { useAuth } from '../../src/lib/auth-context';
import { colors, radius, space } from '../../src/theme';

export default function SignUp() {
  const { signUpWithEmail } = useAuth();
  const router = useRouter();
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);

    if (!email.trim() || !password || !firstName.trim()) {
      setError('Enter your name, email, and password to create your account.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setSubmitting(true);
    const { error: signUpErr } = await signUpWithEmail(
      email.trim(),
      password,
      firstName.trim()
    );
    setSubmitting(false);

    if (signUpErr) {
      setError(signUpErr.message);
      return;
    }

    router.replace({ pathname: '/(auth)/check-email', params: { email: email.trim() } });
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.kav}
      >
        <View style={styles.header}>
          <Text style={styles.brand}>ALINE</Text>
          <Text style={styles.subtitle}>Create your agent</Text>
        </View>

        <View style={styles.form}>
          <AppleSignInButton />
          <Input
            label="First name"
            placeholder="Tim"
            autoCapitalize="words"
            value={firstName}
            onChangeText={setFirstName}
          />
          <Input
            label="Email"
            placeholder="you@example.com"
            keyboardType="email-address"
            autoComplete="email"
            value={email}
            onChangeText={setEmail}
          />
          <Input
            label="Password"
            placeholder="At least 8 characters"
            secureTextEntry
            autoComplete="new-password"
            value={password}
            onChangeText={setPassword}
          />

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Button label="Create account" onPress={onSubmit} loading={submitting} />
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Already have one?</Text>
          <Link href="/(auth)/sign-in" style={styles.link}>
            Sign in
          </Link>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  kav: { flex: 1, justifyContent: 'center', gap: space.xxl },
  header: { gap: space.xs, alignItems: 'center' },
  brand: {
    color: colors.text,
    fontSize: 36,
    fontWeight: '800',
    letterSpacing: 4,
  },
  subtitle: { color: colors.textMuted, fontSize: 15 },
  form: { gap: space.md },
  footer: { flexDirection: 'row', justifyContent: 'center', gap: space.xs },
  footerText: { color: colors.textMuted, fontSize: 14 },
  link: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  errorBox: {
    backgroundColor: 'rgba(248,113,113,0.1)',
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
    padding: space.md,
  },
  errorText: { color: colors.danger, fontSize: 13, lineHeight: 18 },
});
