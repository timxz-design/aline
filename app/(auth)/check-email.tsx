import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '../../src/components/Button';
import { Screen } from '../../src/components/Screen';
import { supabase } from '../../src/lib/supabase';
import { colors, radius, space } from '../../src/theme';
import { useState } from 'react';

export default function CheckEmail() {
  const { email } = useLocalSearchParams<{ email: string }>();
  const router = useRouter();
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  const resend = async () => {
    if (!email) return;
    setResending(true);
    await supabase.auth.resend({ type: 'signup', email });
    setResending(false);
    setResent(true);
  };

  return (
    <Screen>
      <View style={styles.container}>
        <View style={styles.icon}>
          <Text style={styles.iconText}>✉</Text>
        </View>

        <View style={styles.textGroup}>
          <Text style={styles.heading}>Check your inbox</Text>
          <Text style={styles.body}>
            We sent a confirmation link to{'\n'}
            <Text style={styles.email}>{email ?? 'your email'}</Text>
          </Text>
          <Text style={styles.hint}>
            Tap the link in the email to activate your account, then come back and sign in.
          </Text>
        </View>

        <View style={styles.actions}>
          <Button
            label={resent ? 'Email sent!' : 'Resend email'}
            onPress={resend}
            loading={resending}
            variant="secondary"
          />
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Already confirmed?</Text>
          <Link href="/(auth)/sign-in" style={styles.link}>Sign in</Link>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: space.xxl,
    paddingHorizontal: space.xl,
  },
  icon: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    backgroundColor: colors.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { fontSize: 32 },
  textGroup: { gap: space.md, alignItems: 'center' },
  heading: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  body: {
    color: colors.textMuted,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  email: {
    color: colors.text,
    fontWeight: '600',
  },
  hint: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },
  actions: { width: '100%' },
  footer: {
    flexDirection: 'row',
    gap: space.xs,
    alignItems: 'center',
  },
  footerText: { color: colors.textMuted, fontSize: 14 },
  link: { color: colors.accent, fontSize: 14, fontWeight: '600' },
});
