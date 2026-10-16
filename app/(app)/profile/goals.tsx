import { useRouter } from 'expo-router';
import { Alert } from 'react-native';
import { DetailScreen, EmptyRow, Group, Row } from '../../../src/components/settings-ui';
import { supabase } from '../../../src/lib/supabase';
import { useYouFacts, type GoalView } from '../../../src/lib/use-you-facts';
import { colors } from '../../../src/theme';

export default function GoalsScreen() {
  const router = useRouter();
  const { goalRows, loading, reload } = useYouFacts();

  const remove = (g: GoalView) =>
    Alert.alert('Remove goal?', `"${g.title}" and its notes will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const results = await Promise.all([
            g.goalIds.length ? supabase.from('goals').delete().in('id', g.goalIds) : null,
            g.noteIds.length ? supabase.from('interests').delete().in('id', g.noteIds) : null,
          ]);
          const err = results.find((r) => r?.error)?.error;
          if (err) Alert.alert("Couldn't remove it", err.message);
          else reload();
        },
      },
    ]);

  const open = (g: GoalView) => {
    const notes = [g.latest, ...g.earlier].filter(Boolean).map((n) => `${n!.when} · ${n!.text}`);
    Alert.alert(g.title, notes.length ? notes.join('\n\n') : 'No notes yet.', [
      { text: 'Remove goal', style: 'destructive', onPress: () => remove(g) },
      { text: 'Close', style: 'cancel' },
    ]);
  };

  return (
    <DetailScreen
      title="Goals"
      subtitle="What you're working toward, as ALINE understood it. Change anything by telling ALINE — “I don't run anymore”."
    >
      <Group>
        {goalRows.length ? (
          goalRows.map((g) => (
            <Row
              key={g.key}
              icon="flag"
              iconColor={colors.success}
              title={g.title}
              subtitle={g.latest?.text}
              value={g.when || undefined}
              onPress={() => open(g)}
            />
          ))
        ) : (
          <EmptyRow text={loading ? 'Loading…' : 'No goals yet — tell ALINE what you want to make time for.'} />
        )}
      </Group>
      <Group>
        <Row icon="calendar" iconColor={colors.accent} title="Plans and schedule" onPress={() => router.push('/(app)/goals')} />
      </Group>
    </DetailScreen>
  );
}
