import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BackChevron } from '../../src/components/BackChevron';
import { Button } from '../../src/components/Button';
import { Screen } from '../../src/components/Screen';
import { useAuth } from '../../src/lib/auth-context';
import { useOnboarding } from '../../src/lib/onboarding-context';
import { OPENNESS_OPTIONS } from '../../src/lib/onboarding-data';
import { useProfile } from '../../src/lib/use-profile';
import { colors, font, radius, space } from '../../src/theme';

export default function OnboardingOpenness() {
  const router = useRouter();
  const { user } = useAuth();
  const { refresh } = useProfile();
  const { socialOpenness, setSocialOpenness, complete } = useOnboarding();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    if (!user) return;
    setSubmitting(true);
    setError(null);
    const { error: completeErr } = await complete(user.id);
    setSubmitting(false);
    if (completeErr) {
      setError(completeErr.message);
      return;
    }
    // Refresh profile so the auth gate redirects us into the app.
    await refresh();
    // Land on the agent tab, matching the "meet your agent" promise.
    router.replace('/(app)/agent');
  };

  return (
    <Screen>
      <BackChevron />
      <View style={styles.header}>
        <Text style={styles.step}>3 of 3</Text>
        <Text style={styles.title}>How social are you feeling?</Text>
        <Text style={styles.sub}>
          This sets my default. I won't push past it. You can change it anytime
          ("go quiet for a week", "I'm open to meeting people again").
        </Text>
      </View>

      <View style={styles.options}>
        {OPENNESS_OPTIONS.map((opt) => {
          const active = socialOpenness === opt.value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => setSocialOpenness(opt.value)}
              style={({ pressed }) => [
                styles.option,
                active && styles.optionActive,
                pressed && { opacity: 0.9 },
              ]}
            >
              <View style={styles.optionHeader}>
                <View
                  style={[styles.radio, active && styles.radioActive]}
                />
                <Text
                  style={[styles.optionLabel, active && styles.optionLabelActive]}
                >
                  {opt.label}
                </Text>
              </View>
              <Text style={styles.optionDesc}>{opt.description}</Text>
            </Pressable>
          );
        })}
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <View style={styles.footer}>
        <Button label="Done — meet your agent" onPress={finish} loading={submitting} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
  options: {
    flex: 1,
    justifyContent: 'center',
    gap: space.md,
    paddingVertical: space.xl,
  },
  option: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: 8,
  },
  optionActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentDim,
  },
  optionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  radioActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  optionLabel: { color: colors.text, fontSize: 16, fontWeight: '600' },
  optionLabelActive: { color: colors.accent },
  optionDesc: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    paddingLeft: 30,
  },
  errorText: { color: colors.danger, fontSize: 13, textAlign: 'center' },
  footer: { paddingBottom: space.xxl },
});
