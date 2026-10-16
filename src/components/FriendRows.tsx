/**
 * Rows for the People tab's Friends list: a friend (connection type + when you
 * last met or next meet; star = inner circle; swipe left to unfriend) and a
 * pending request (accept / decline, or cancel one you sent).
 */

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Alert, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { supabase } from '../lib/supabase';
import { setFriendTier, type FriendProfile, type PendingRequest } from '../lib/use-friends';
import { colors, font, radius, space } from '../theme';
import { PersonAvatar } from './PersonAvatar';

export type Together = { last_met: string | null; times_met: number; next_plan_at: string | null };

/** "met 3 days ago", "next plan Fri", "no plans together yet". */
export function togetherLine(t: Together | undefined): string {
  if (t?.next_plan_at) {
    const d = new Date(t.next_plan_at);
    const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
    return `next plan ${days < 7 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
  }
  if (t?.last_met) {
    const days = Math.floor((Date.now() - new Date(t.last_met).getTime()) / 86_400_000);
    const ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 14 ? `${days} days ago` : days < 60 ? `${Math.round(days / 7)} weeks ago` : `${Math.round(days / 30)} months ago`;
    return `met ${ago}`;
  }
  return 'no plans together yet';
}

export function FriendRow({
  friend,
  together,
  onChanged,
}: {
  friend: FriendProfile;
  together?: Together;
  onChanged: () => void;
}) {
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
          <Text style={styles.meta} numberOfLines={1}>
            {inner ? 'Inner circle' : 'Friend'} · {togetherLine(together)}
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

export function RequestRow({ req, onActed }: { req: PendingRequest; onActed: () => void }) {
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
