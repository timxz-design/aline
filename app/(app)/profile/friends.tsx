import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Alert, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { AddFriendModal } from '../../../src/components/AddFriendModal';
import { PersonAvatar } from '../../../src/components/PersonAvatar';
import { DetailScreen, EmptyRow, Group, Row } from '../../../src/components/settings-ui';
import { supabase } from '../../../src/lib/supabase';
import { setFriendTier, useFriends, type FriendProfile, type PendingRequest } from '../../../src/lib/use-friends';
import { colors, font, radius, space } from '../../../src/theme';

export default function FriendsScreen() {
  const { friends, pending, refresh } = useFriends();
  const [showAdd, setShowAdd] = useState(false);
  const inbound = pending.filter((p) => !p.outbound);
  const outbound = pending.filter((p) => p.outbound);

  return (
    <DetailScreen title="Friends" subtitle="Star someone to add them to your inner circle — they see your full schedule, not just free/busy.">
      <Group label={inbound.length ? 'Waiting for you' : undefined}>
        {inbound.map((p) => (
          <RequestRow key={p.user.id} req={p} onActed={refresh} />
        ))}
      </Group>

      <Group label="Your friends" footer={friends.length ? 'Swipe left on someone to unfriend.' : undefined}>
        {friends.length ? (
          friends.map((f) => <FriendRow key={f.id} friend={f} onChanged={refresh} />)
        ) : (
          <EmptyRow text="No friends yet. Add someone by their handle." />
        )}
      </Group>

      <Group label={outbound.length ? 'Sent' : undefined}>
        {outbound.map((p) => (
          <RequestRow key={p.user.id} req={p} onActed={refresh} />
        ))}
      </Group>

      <Group>
        <Row icon="person-add" iconColor={colors.accent} title="Add friend" onPress={() => setShowAdd(true)} />
      </Group>

      <AddFriendModal visible={showAdd} onClose={() => setShowAdd(false)} onSuccess={refresh} />
    </DetailScreen>
  );
}

function FriendRow({ friend, onChanged }: { friend: FriendProfile; onChanged: () => void }) {
  const swipeRef = useRef<Swipeable>(null);
  const label = friend.first_name ?? friend.display_name ?? friend.handle ?? 'this friend';
  const inner = friend.myTier === 'inner';

  const confirmUnfriend = () =>
    Alert.alert(`Unfriend ${label}?`, "You'll need to send a new request to add them back.", [
      { text: 'Cancel', style: 'cancel', onPress: () => swipeRef.current?.close() },
      {
        text: 'Unfriend',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.rpc('unfriend', { _other_user: friend.id });
          if (error) Alert.alert("Couldn't unfriend", error.message);
          else onChanged();
        },
      },
    ]);

  const renderRightActions = (progress: Animated.AnimatedInterpolation<number>) => {
    const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [90, 0] });
    return (
      <Animated.View style={{ transform: [{ translateX }] }}>
        <Pressable style={styles.unfriend} onPress={confirmUnfriend}>
          <Text style={styles.unfriendText}>Unfriend</Text>
        </Pressable>
      </Animated.View>
    );
  };

  return (
    <Swipeable ref={swipeRef} renderRightActions={renderRightActions} rightThreshold={40} overshootRight={false} friction={2}>
      <View style={styles.row}>
        <PersonAvatar id={friend.id} name={friend.first_name ?? friend.handle} />
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{friend.first_name ?? friend.display_name ?? 'Unnamed'}</Text>
          <Text style={styles.meta}>
            {friend.handle ? `@${friend.handle}` : ''}
            {inner ? `${friend.handle ? ' · ' : ''}inner circle` : ''}
          </Text>
        </View>
        <Pressable
          onPress={async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
            const { error } = await setFriendTier(friend.id, inner ? 'friend' : 'inner');
            if (error) Alert.alert("Couldn't update", error);
            else onChanged();
          }}
          hitSlop={10}
          accessibilityLabel={inner ? 'Remove from inner circle' : 'Add to inner circle'}
        >
          <Ionicons name={inner ? 'star' : 'star-outline'} size={20} color={inner ? colors.accent : colors.textDim} />
        </Pressable>
      </View>
    </Swipeable>
  );
}

function RequestRow({ req, onActed }: { req: PendingRequest; onActed: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true);
    const { error } = await fn();
    setBusy(false);
    if (error) Alert.alert('Something went wrong', error.message);
    else onActed();
  };
  const respond = (action: 'accept' | 'decline') =>
    act(() => supabase.rpc('respond_to_friendship', { _other_user: req.user.id, _action: action }));

  return (
    <View style={styles.row}>
      <PersonAvatar id={req.user.id} name={req.user.first_name ?? req.user.handle} />
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>{req.user.first_name ?? 'Unnamed'}</Text>
        <Text style={styles.meta}>@{req.user.handle ?? '—'}</Text>
      </View>
      {req.outbound ? (
        <Pressable
          disabled={busy}
          onPress={() => act(() => supabase.rpc('unfriend', { _other_user: req.user.id }))}
          style={styles.btn}
          hitSlop={6}
        >
          <Text style={styles.btnText}>Cancel</Text>
        </Pressable>
      ) : (
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Pressable disabled={busy} onPress={() => respond('decline')} style={styles.btn} hitSlop={6}>
            <Text style={styles.btnText}>No</Text>
          </Pressable>
          <Pressable disabled={busy} onPress={() => respond('accept')} style={[styles.btn, styles.btnAccept]} hitSlop={6}>
            <Text style={[styles.btnText, { color: colors.textInverse }]}>Accept</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    backgroundColor: colors.bgElevated,
  },
  name: { color: colors.text, fontSize: font.size.md },
  meta: { color: colors.textMuted, fontSize: 12 },
  btn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.bgRaised },
  btnAccept: { backgroundColor: colors.accent },
  btnText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  unfriend: {
    width: 90,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.danger,
  },
  unfriendText: { color: colors.textInverse, fontSize: 13, fontWeight: '600' },
});
