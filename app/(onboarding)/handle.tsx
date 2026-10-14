import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BackChevron } from '../../src/components/BackChevron';
import { Button } from '../../src/components/Button';
import { Input } from '../../src/components/Input';
import { Screen } from '../../src/components/Screen';
import { useOnboarding } from '../../src/lib/onboarding-context';
import { supabase } from '../../src/lib/supabase';
import { colors, font, space } from '../../src/theme';

const HANDLE_RE = /^[a-z][a-z0-9_]{2,19}$/;

export default function OnboardingHandle() {
  const router = useRouter();
  const { handle, setHandle } = useOnboarding();
  const [value, setValue] = useState(handle);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);

  // Local validation runs instantly; availability check debounces network.
  const normalized = value.trim().toLowerCase();
  const formatValid = HANDLE_RE.test(normalized);

  useEffect(() => {
    if (!formatValid) {
      setAvailable(null);
      return;
    }
    setChecking(true);
    setAvailable(null);
    const t = setTimeout(async () => {
      const { data, error: err } = await supabase.rpc('find_user_by_handle', {
        _handle: normalized,
      });
      setChecking(false);
      if (err) {
        setAvailable(null);
        return;
      }
      // RPC returns array (0 or 1 row).
      setAvailable(!data || data.length === 0);
    }, 350);
    return () => clearTimeout(t);
  }, [normalized, formatValid]);

  const onNext = () => {
    setError(null);
    if (!formatValid) {
      setError("Handles need 3–20 characters: letters, digits, and underscores. Has to start with a letter.");
      return;
    }
    if (available === false) {
      setError('That handle is taken — try another?');
      return;
    }
    setHandle(normalized);
    router.push('/(onboarding)/interests');
  };

  // Status text under the input — "available", "taken", or hint.
  let status: { text: string; tone: 'good' | 'bad' | 'muted' } | null = null;
  if (formatValid && checking) {
    status = { text: 'Checking…', tone: 'muted' };
  } else if (formatValid && available === true) {
    status = { text: '✓ Available', tone: 'good' };
  } else if (formatValid && available === false) {
    status = { text: '✕ Already taken', tone: 'bad' };
  } else if (value && !formatValid) {
    status = {
      text: '3–20 chars, start with a letter, lowercase + digits + underscore.',
      tone: 'muted',
    };
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.kav}
      >
        <BackChevron />
        <View style={styles.header}>
          <Text style={styles.step}>1 of 4</Text>
          <Text style={styles.title}>Pick a handle</Text>
          <Text style={styles.sub}>
            How friends find and add you. Like a username — short and unique.
            You can change it later.
          </Text>
        </View>

        <View style={styles.form}>
          <View style={styles.inputRow}>
            <Text style={styles.atSign}>@</Text>
            <Input
              placeholder="tim"
              value={value}
              onChangeText={(t) => setValue(t.toLowerCase().replace(/\s/g, ''))}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={20}
              autoFocus
              style={{ flex: 1 }}
            />
          </View>

          {status ? (
            <Text
              style={[
                styles.statusText,
                status.tone === 'good' && { color: colors.success },
                status.tone === 'bad' && { color: colors.danger },
                status.tone === 'muted' && { color: colors.textDim },
              ]}
            >
              {status.text}
            </Text>
          ) : null}

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>

        <View style={styles.footer}>
          <Button
            label="Next →"
            onPress={onNext}
            disabled={!formatValid || available === false || checking}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  kav: { flex: 1 },
  header: { paddingTop: space.md, gap: 4 },
  step: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  title: { color: colors.text, fontSize: font.size.xxl, fontWeight: '700' },
  sub: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    lineHeight: 20,
    marginTop: 4,
  },
  form: { flex: 1, justifyContent: 'center', gap: space.sm },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  atSign: { color: colors.textMuted, fontSize: 22, fontWeight: '600' },
  statusText: { fontSize: 13, marginLeft: 24 },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    marginLeft: 24,
  },
  footer: { paddingBottom: space.xxl },
});
