import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BackChevron } from '../../src/components/BackChevron';
import { Button } from '../../src/components/Button';
import { Screen } from '../../src/components/Screen';
import { useOnboarding } from '../../src/lib/onboarding-context';
import { INTEREST_TILES, type InterestTile } from '../../src/lib/onboarding-data';
import { colors, font, radius, space } from '../../src/theme';

export default function OnboardingInterests() {
  const router = useRouter();
  const { selectedInterests, toggleInterest } = useOnboarding();

  const isSelected = (tile: InterestTile) =>
    selectedInterests.some((t) => t.label === tile.label);

  return (
    <Screen>
      <BackChevron />
      <View style={styles.header}>
        <Text style={styles.step}>2 of 3</Text>
        <Text style={styles.title}>What are you into?</Text>
        <Text style={styles.sub}>
          Tap whatever fits. No pressure to be exhaustive — pick a few that feel
          right today. You can change these anytime.
        </Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.grid}
        showsVerticalScrollIndicator={false}
      >
        {INTEREST_TILES.map((tile) => {
          const active = isSelected(tile);
          return (
            <Pressable
              key={tile.label}
              onPress={() => toggleInterest(tile)}
              style={({ pressed }) => [
                styles.tile,
                active && styles.tileActive,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={styles.tileIcon}>{tile.icon}</Text>
              <Text style={[styles.tileLabel, active && styles.tileLabelActive]}>
                {tile.label}
              </Text>
              {tile.blurb ? (
                <Text style={styles.tileBlurb}>{tile.blurb}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.footer}>
        <Text style={styles.count}>
          {selectedInterests.length} selected
        </Text>
        <Button
          label="Next →"
          onPress={() => router.push('/(onboarding)/openness')}
          disabled={selectedInterests.length === 0}
        />
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
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingVertical: space.lg,
  },
  tile: {
    width: '48%',
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    gap: 4,
  },
  tileActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentDim,
  },
  tileIcon: { fontSize: 26 },
  tileLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  tileLabelActive: { color: colors.accent },
  tileBlurb: { color: colors.textDim, fontSize: 11, lineHeight: 14 },
  footer: { paddingBottom: space.xxl, gap: space.sm },
  count: {
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: 12,
  },
});
