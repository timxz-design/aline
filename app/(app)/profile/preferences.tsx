import { Alert } from 'react-native';
import { DetailScreen, EmptyRow, Group, Row } from '../../../src/components/settings-ui';
import { supabase } from '../../../src/lib/supabase';
import { useYouFacts } from '../../../src/lib/use-you-facts';

export default function PreferencesScreen() {
  const { prefGroups, loading, reload } = useYouFacts();

  const forget = (text: string, ids: string[]) =>
    Alert.alert('Forget this?', `ALINE will forget: "${text}"`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('interests').delete().in('id', ids);
          if (error) Alert.alert("Couldn't forget it", error.message);
          else reload();
        },
      },
    ]);

  return (
    <DetailScreen
      title="Likes and dislikes"
      subtitle="Picked up from your chats with ALINE. Tap anything that's wrong to forget it, or just tell ALINE."
    >
      {prefGroups.length === 0 ? (
        <Group>
          <EmptyRow text={loading ? 'Loading…' : 'Nothing yet — mention what you enjoy in chat.'} />
        </Group>
      ) : (
        prefGroups.map((g) => (
          <Group key={g.label} label={g.label}>
            {g.items.map((item) => (
              <Row key={item.text} title={item.text} subtitle={item.detail ?? undefined} titleLines={2} onPress={() => forget(item.text, item.ids)} chevron={false} />
            ))}
          </Group>
        ))
      )}
    </DetailScreen>
  );
}
