import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { supabase } from '../lib/supabase';
import { useFriends } from '../lib/use-friends';
import { colors, space } from '../theme';
import { AddFriendModal } from './AddFriendModal';
import { FriendRow, RequestRow, type Together } from './FriendRows';
import { EmptyRow, Group, Row } from './settings-ui';

/**
 * The People tab's Friends view: requests waiting for you, your friends (with
 * how you're connected and when you last met), and requests you've sent.
 * Friends are sorted by who you see most recently / next.
 */
export function FriendsList({ addOpen, onCloseAdd, onOpenAdd }: { addOpen: boolean; onCloseAdd: () => void; onOpenAdd: () => void }) {
  const { friends, pending, loading, refresh } = useFriends();
  const [together, setTogether] = useState<Record<string, Together>>({});

  const loadTogether = useCallback(async () => {
    const { data } = await supabase.rpc('people_together_summary');
    const map: Record<string, Together> = {};
    for (const r of data ?? []) map[r.other_user_id] = r;
    setTogether(map);
  }, []);

  const reload = useCallback(() => {
    refresh();
    loadTogether();
  }, [refresh, loadTogether]);

  useFocusEffect(
    useCallback(() => {
      reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const recency = (id: string) => {
    const t = together[id];
    return t?.next_plan_at ? 2e13 - new Date(t.next_plan_at).getTime() : t?.last_met ? new Date(t.last_met).getTime() : 0;
  };
  const sorted = [...friends].sort(
    (a, b) =>
      (a.myTier === 'inner' ? 0 : 1) - (b.myTier === 'inner' ? 0 : 1) ||
      recency(b.id) - recency(a.id) ||
      (a.first_name ?? '').localeCompare(b.first_name ?? ''),
  );
  const inbound = pending.filter((p) => !p.outbound);
  const outbound = pending.filter((p) => p.outbound);

  return (
    <ScrollView
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl refreshing={false} onRefresh={reload} tintColor={colors.accent} />}
    >
      <Group label={inbound.length ? 'Waiting for you' : undefined}>
        {inbound.map((p) => (
          <RequestRow key={p.user.id} req={p} onActed={reload} />
        ))}
      </Group>

      <Group
        label={friends.length ? `Friends · ${friends.length}` : undefined}
        footer={friends.length ? 'Star someone to add them to your inner circle — they see your full schedule. Swipe left to unfriend.' : undefined}
      >
        {sorted.length ? (
          sorted.map((f) => <FriendRow key={f.id} friend={f} together={together[f.id]} onChanged={reload} />)
        ) : (
          <EmptyRow text={loading ? 'Loading…' : 'No friends yet. Add someone by their handle.'} />
        )}
      </Group>

      <Group label={outbound.length ? 'Sent' : undefined}>
        {outbound.map((p) => (
          <RequestRow key={p.user.id} req={p} onActed={reload} />
        ))}
      </Group>

      <Group>
        <Row icon="person-add" iconColor={colors.accent} title="Add friend" onPress={onOpenAdd} />
      </Group>

      <AddFriendModal visible={addOpen} onClose={onCloseAdd} onSuccess={reload} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, paddingBottom: space.xxxl, gap: space.lg },
});
