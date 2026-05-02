import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '../../src/components/Button';
import { Screen } from '../../src/components/Screen';
import { useProfile } from '../../src/lib/use-profile';
import { colors, font, space } from '../../src/theme';

export default function OnboardingWelcome() {
  const router = useRouter();
  const { profile } = useProfile();
  const firstName = profile?.first_name ?? 'there';

  return (
    <Screen>
      <View style={styles.body}>
        <View style={styles.markBox}>
          <Text style={styles.mark}>✦</Text>
        </View>

        <Text style={styles.greeting}>Hey {firstName}.</Text>
        <Text style={styles.lede}>
          I'm ALINE — your personal agent. The more I know about you, the better
          I can coordinate with the people in your life.
        </Text>
        <Text style={styles.bullets}>
          Next three screens take about a minute:
          {'\n'}• Pick a handle so friends can find you
          {'\n'}• Tap a few things you're into
          {'\n'}• Set how social you're feeling
        </Text>
        <Text style={styles.lede}>
          You can change all of this later, anytime, just by talking to me.
        </Text>
      </View>

      <View style={styles.footer}>
        <Button
          label="Let's go →"
          onPress={() => router.push('/(onboarding)/handle')}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, justifyContent: 'center', gap: space.lg },
  markBox: {
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentDim,
    marginBottom: space.lg,
  },
  mark: { fontSize: 36, color: colors.accent },
  greeting: {
    color: colors.text,
    fontSize: font.size.xxxl,
    fontWeight: '700',
    textAlign: 'center',
  },
  lede: {
    color: colors.textMuted,
    fontSize: font.size.md,
    lineHeight: 22,
    textAlign: 'center',
  },
  bullets: {
    color: colors.text,
    fontSize: font.size.sm,
    lineHeight: 22,
    textAlign: 'left',
    backgroundColor: colors.bgElevated,
    padding: space.lg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  footer: { paddingBottom: space.xxl },
});
