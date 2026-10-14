import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BackChevron } from '../../src/components/BackChevron';
import { Button } from '../../src/components/Button';
import { Screen } from '../../src/components/Screen';
import { useOnboarding } from '../../src/lib/onboarding-context';
import { OPENNESS_OPTIONS } from '../../src/lib/onboarding-data';
import { colors, font, radius, space } from '../../src/theme';

export default function OnboardingOpenness() {
  const router = useRouter();
  const { socialOpenness, setSocialOpenness } = useOnboarding();

  return (
    <Screen>
      <BackChevron />
      <View style={styles.header}>
        <Text style={styles.step}>3 of 4</Text>
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

      <View style={styles.footer}>
        <Button label="Continue" onPress={() => router.push('/(onboarding)/permissions')} />
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
  footer: { paddingBottom: space.xxl },
});
