import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { HangoutSheet } from '../../src/components/HangoutSheet';
import { PersonAvatar } from '../../src/components/PersonAvatar';
import { AddMembersModal } from '../../src/components/AddMembersModal';
import { Button } from '../../src/components/Button';
import { Input } from '../../src/components/Input';
import { Screen } from '../../src/components/Screen';
import { useAuth } from '../../src/lib/auth-context';
import { supabase } from '../../src/lib/supabase';
import type { Hangout, HangoutResponse } from '../../src/types/database';
import { colors, font, radius, space } from '../../src/theme';

type ResponseStatus = 'pending' | 'confirmed' | 'declined' | 'maybe';

type HangoutWithResponses = Hangout & {
  responses: HangoutResponse[];
  myResponse: HangoutResponse | null;
};

type GroupRow = {
  id: string;
  name: string;
  description: string | null;
  group_type: string | null;
  created_by: string;
  member_count: number;
  member_ids: string[];
  member_names: string[];
  /** id → label for every member, so hangout cards can name the proposer. */
  members: { id: string; label: string }[];
  hangouts: HangoutWithResponses[];
  muted_until: string | null;
};

export default function GroupsScreen() {
  const { user } = useAuth();
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [addingTo, setAddingTo] = useState<GroupRow | null>(null);
  // Track group ids so the realtime listener can refresh on relevant changes
  const groupIdsRef = useRef<string[]>([]);

  const loadGroups = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data: memberships, error: mErr } = await supabase
      .from('group_members')
      .select('group_id, muted_until')
      .eq('user_id', user.id);
    if (mErr || !memberships) {
      console.warn('Membership load failed:', mErr?.message);
      setGroups([]);
      setLoading(false);
      return;
    }
    const groupIds = memberships.map((m) => m.group_id);
    const mutedByGroup = new Map<string, string | null>(
      memberships.map((m) => [m.group_id, m.muted_until ?? null])
    );
    groupIdsRef.current = groupIds;
    if (groupIds.length === 0) {
      setGroups([]);
      setLoading(false);
      return;
    }

    const [{ data: groupRows }, { data: allMembers }, { data: hangouts }] =
      await Promise.all([
        supabase.from('groups').select('*').in('id', groupIds),
        supabase
          .from('group_members')
          .select('group_id, user_id, profiles(handle, first_name)')
          .in('group_id', groupIds),
        supabase
          .from('hangouts')
          .select('*')
          .in('group_id', groupIds)
          .in('status', ['proposing', 'confirmed'])
          .or(`proposed_start.is.null,proposed_start.gte.${new Date().toISOString()}`)
          .order('proposed_start', { ascending: true }),
      ]);

    const memberIdsByGroup = new Map<string, string[]>();
    const memberNamesByGroup = new Map<string, string[]>();
    const membersByGroup = new Map<string, { id: string; label: string }[]>();
    (allMembers as unknown as Array<{
      group_id: string;
      user_id: string;
      profiles: { handle: string | null; first_name: string | null } | null;
    }> | null)?.forEach((m) => {
      const arr = memberIdsByGroup.get(m.group_id) ?? [];
      arr.push(m.user_id);
      memberIdsByGroup.set(m.group_id, arr);
      const label =
        m.user_id === user.id
          ? 'You'
          : m.profiles?.first_name || (m.profiles?.handle ? `@${m.profiles.handle}` : '?');
      const names = memberNamesByGroup.get(m.group_id) ?? [];
      names.push(label);
      memberNamesByGroup.set(m.group_id, names);
      const people = membersByGroup.get(m.group_id) ?? [];
      people.push({ id: m.user_id, label });
      membersByGroup.set(m.group_id, people);
    });

    // Fetch all responses for the visible hangouts in one shot
    const hangoutIds = (hangouts ?? []).map((h) => h.id);
    let responses: HangoutResponse[] = [];
    if (hangoutIds.length > 0) {
      const { data } = await supabase
        .from('hangout_responses')
        .select('*')
        .in('hangout_id', hangoutIds);
      responses = (data ?? []) as HangoutResponse[];
    }

    const responsesByHangout = new Map<string, HangoutResponse[]>();
    responses.forEach((r) => {
      const arr = responsesByHangout.get(r.hangout_id) ?? [];
      arr.push(r);
      responsesByHangout.set(r.hangout_id, arr);
    });

    const hangoutsByGroup = new Map<string, HangoutWithResponses[]>();
    (hangouts ?? []).forEach((h) => {
      // Direct hangouts have group_id = null — they never reach this screen
      // (filtered out by .in('group_id', groupIds) above). Guard so TS is happy.
      if (!h.group_id) return;
      const all = responsesByHangout.get(h.id) ?? [];
      const mine = all.find((r) => r.user_id === user.id) ?? null;
      const enriched: HangoutWithResponses = {
        ...(h as Hangout),
        responses: all,
        myResponse: mine,
      };
      const arr = hangoutsByGroup.get(h.group_id) ?? [];
      arr.push(enriched);
      hangoutsByGroup.set(h.group_id, arr);
    });

    setGroups(
      (groupRows ?? []).map((g) => {
        const ids = memberIdsByGroup.get(g.id) ?? [];
        return {
          id: g.id,
          name: g.name,
          description: g.description,
          group_type: g.group_type,
          created_by: g.created_by,
          member_count: ids.length,
          member_ids: ids,
          member_names: memberNamesByGroup.get(g.id) ?? [],
          members: membersByGroup.get(g.id) ?? [],
          hangouts: hangoutsByGroup.get(g.id) ?? [],
          muted_until: mutedByGroup.get(g.id) ?? null,
        };
      })
    );
    setLoading(false);
  }, [user]);

  // Initial load + on focus
  useFocusEffect(
    useCallback(() => {
      loadGroups();
    }, [loadGroups])
  );

  // Stable ref to loader so realtime effect doesn't re-subscribe each render.
  const loadGroupsRef = useRef(loadGroups);
  useEffect(() => {
    loadGroupsRef.current = loadGroups;
  }, [loadGroups]);

  // Realtime: refresh whenever a hangout / response / member change touches
  // one of our groups. Subscribe ONCE per user.id with a per-instance channel
  // suffix to avoid name collisions on rapid mount/unmount.
  useEffect(() => {
    if (!user?.id) return;
    const channel = supabase
      .channel(`group-activity-${user.id}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'hangouts' },
        (payload) => {
          const row = (payload.new ?? payload.old) as { group_id?: string };
          if (row?.group_id && groupIdsRef.current.includes(row.group_id)) {
            loadGroupsRef.current?.();
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'hangout_responses' },
        () => {
          // No group_id on the response payload; just reload.
          loadGroupsRef.current?.();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'group_members' },
        () => {
          loadGroupsRef.current?.();
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  return (
    <Screen noPadding>
      <View style={styles.header}>
        <Text style={styles.title}>Groups</Text>
        <Pressable
          onPress={() => setShowCreate(true)}
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.7 }]}
          hitSlop={10}
        >
          <Text style={styles.addBtnText}>+ New</Text>
        </Pressable>
      </View>

      <FlatList
        data={groups}
        keyExtractor={(g) => g.id}
        contentContainerStyle={styles.listBody}
        ListEmptyComponent={
          loading ? null : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No groups yet</Text>
              <Text style={styles.emptyBody}>
                Create a group with your crew to start coordinating hangouts.
                Then ask your agent to plan something.
              </Text>
              <Button
                label="Create your first group"
                onPress={() => setShowCreate(true)}
                style={{ marginTop: space.md }}
              />
            </View>
          )
        }
        renderItem={({ item }) => (
          <SwipeableGroupCard
            group={item}
            onAddMembers={() => setAddingTo(item)}
            onRefresh={loadGroups}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: space.md }} />}
        refreshing={loading}
        onRefresh={loadGroups}
      />

      <CreateGroupModal
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => {
          setShowCreate(false);
          loadGroups();
        }}
      />

      {addingTo ? (
        <AddMembersModal
          visible={true}
          groupId={addingTo.id}
          excludeUserIds={addingTo.member_ids}
          onClose={() => setAddingTo(null)}
          onAdded={() => {
            setAddingTo(null);
            loadGroups();
          }}
        />
      ) : null}
    </Screen>
  );
}

const MUTE_OPTIONS = [
  { label: '1 hour',  hours: 1 },
  { label: '8 hours', hours: 8 },
  { label: '24 hours', hours: 24 },
  { label: '1 week',  hours: 24 * 7 },
];

function SwipeableGroupCard({
  group,
  onAddMembers,
  onRefresh,
}: {
  group: GroupRow;
  onAddMembers: () => void;
  onRefresh: () => void;
}) {
  const { user } = useAuth();
  const swipeRef = useRef<Swipeable>(null);
  const isMuted = group.muted_until ? new Date(group.muted_until) > new Date() : false;

  const handleLeave = () => {
    Alert.alert(
      'Leave group?',
      `You'll be removed from "${group.name}".`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => swipeRef.current?.close() },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            await supabase
              .from('group_members')
              .delete()
              .eq('group_id', group.id)
              .eq('user_id', user!.id);
            onRefresh();
          },
        },
      ]
    );
  };

  const handleMute = () => {
    swipeRef.current?.close();
    if (isMuted) {
      // Already muted — offer to unmute
      Alert.alert('Unmute group?', `"${group.name}" is currently muted.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unmute',
          onPress: async () => {
            await supabase
              .from('group_members')
              .update({ muted_until: null })
              .eq('group_id', group.id)
              .eq('user_id', user!.id);
            onRefresh();
          },
        },
      ]);
      return;
    }
    Alert.alert(
      'Mute notifications',
      `Mute "${group.name}" for how long?`,
      [
        ...MUTE_OPTIONS.map(({ label, hours }) => ({
          text: label,
          onPress: async () => {
            const until = new Date(Date.now() + hours * 3_600_000).toISOString();
            await supabase
              .from('group_members')
              .update({ muted_until: until })
              .eq('group_id', group.id)
              .eq('user_id', user!.id);
            onRefresh();
          },
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ]
    );
  };

  const renderRightActions = (
    progress: Animated.AnimatedInterpolation<number>
  ) => {
    const muteTranslate = progress.interpolate({
      inputRange: [0, 1], outputRange: [160, 0],
    });
    const deleteTranslate = progress.interpolate({
      inputRange: [0, 1], outputRange: [80, 0],
    });
    return (
      <View style={styles.swipeActionsContainer}>
        <Animated.View style={{ transform: [{ translateX: muteTranslate }] }}>
          <Pressable
            style={[styles.swipeAction, styles.muteAction]}
            onPress={handleMute}
          >
            <Text style={styles.swipeActionText}>
              {isMuted ? 'Unmute' : 'Mute'}
            </Text>
          </Pressable>
        </Animated.View>
        <Animated.View style={{ transform: [{ translateX: deleteTranslate }] }}>
          <Pressable
            style={[styles.swipeAction, styles.leaveAction]}
            onPress={handleLeave}
          >
            <Text style={styles.swipeActionText}>Leave</Text>
          </Pressable>
        </Animated.View>
      </View>
    );
  };

  return (
    <Swipeable
      ref={swipeRef}
      renderRightActions={renderRightActions}
      rightThreshold={40}
      overshootRight={false}
      friction={2}
    >
      <GroupCard group={group} onAddMembers={onAddMembers} isMuted={isMuted} />
    </Swipeable>
  );
}

function GroupCard({
  group,
  onAddMembers,
  isMuted,
}: {
  group: GroupRow;
  onAddMembers: () => void;
  isMuted?: boolean;
}) {
  return (
    <View style={[styles.card, isMuted && { opacity: 0.6 }]}>
      <View style={styles.cardHeader}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.cardTitle}>{group.name}</Text>
          {isMuted ? <Text style={styles.mutedBadge}>muted</Text> : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={styles.cardMembers}>
            {group.member_count} {group.member_count === 1 ? 'member' : 'members'}
          </Text>
          <Pressable
            onPress={onAddMembers}
            hitSlop={6}
            style={({ pressed }) => [styles.addMemberBtn, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.addMemberText}>+ Add</Text>
          </Pressable>
        </View>
      </View>
      {group.description ? (
        <Text style={styles.cardSub}>{group.description}</Text>
      ) : null}

      {group.members.length > 0 ? (
        <View style={styles.memberChipWrap}>
          {group.members.map((m) => (
            <View key={m.id} style={[styles.memberChip, styles.memberChipWithAvatar]}>
              <PersonAvatar id={m.id} name={m.label} size={20} />
              <Text style={styles.memberChipText}>{m.label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {group.hangouts.length === 0 ? (
        <Text style={styles.noHangout}>
          No hangouts yet. Ask ALINE to plan something.
        </Text>
      ) : (
        <View style={{ gap: space.sm, marginTop: space.xs }}>
          {group.hangouts.map((h) => (
            <HangoutCard
              key={h.id}
              hangout={h}
              groupMemberCount={group.member_count}
              proposer={group.members.find((m) => m.id === h.proposed_by) ?? null}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function HangoutCard({
  hangout,
  groupMemberCount,
  proposer,
}: {
  hangout: HangoutWithResponses;
  groupMemberCount: number;
  /** Who suggested this — shown so an invite always has a face on it. */
  proposer: { id: string; label: string } | null;
}) {
  const [responding, setResponding] = useState<ResponseStatus | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const myStatus = (hangout.myResponse?.status ?? 'pending') as ResponseStatus;
  const confirmedCount = hangout.responses.filter((r) => r.status === 'confirmed').length;
  const declinedCount = hangout.responses.filter((r) => r.status === 'declined').length;
  const maybeCount = hangout.responses.filter((r) => r.status === 'maybe').length;
  const isConfirmed = hangout.status === 'confirmed';
  const isCancelled = hangout.status === 'cancelled';
  const threshold = hangout.min_attendees ?? groupMemberCount;
  const stillNeeded = Math.max(0, threshold - confirmedCount);

  const respond = async (status: 'confirmed' | 'declined' | 'maybe') => {
    if (responding) return;
    setResponding(status);
    const { error } = await supabase.rpc('respond_to_hangout', {
      _hangout_id: hangout.id,
      _status: status,
    });
    setResponding(null);
    if (error) {
      Alert.alert('Could not respond', error.message);
    }
    // Realtime will refresh the list
  };

  return (
    <Pressable
      onPress={() => setShowDetails(true)}
      style={[
        styles.hangoutCard,
        isConfirmed && styles.hangoutCardConfirmed,
        isCancelled && styles.hangoutCardCancelled,
      ]}
    >
      <View style={styles.hangoutHeader}>
        <View
          style={[
            styles.hangoutDot,
            isCancelled && { backgroundColor: colors.danger },
          ]}
        />
        <Text style={styles.hangoutTitle}>{hangout.title}</Text>
        {isConfirmed ? (
          <Text style={styles.confirmedBadge}>GOING ✓</Text>
        ) : isCancelled ? (
          <Text style={styles.cancelledBadge}>CANCELLED</Text>
        ) : (
          <Text style={styles.proposingBadge}>PROPOSING</Text>
        )}
      </View>

      {proposer ? (
        <View style={styles.proposerRow}>
          <PersonAvatar id={proposer.id} name={proposer.label} size={20} />
          <Text style={styles.proposerText}>
            {proposer.label === 'You' ? 'You proposed this' : `Proposed by ${proposer.label}`}
          </Text>
        </View>
      ) : null}

      {hangout.proposed_start ? (
        <Text style={styles.hangoutTime}>
          {formatHangoutTime(hangout.proposed_start)}
          {hangout.venue_name ? ` · ${hangout.venue_name}` : ''}
        </Text>
      ) : null}

      {hangout.venue_name || hangout.venue_address ? (
        <Pressable
          onPress={() => openHangoutDirections(hangout)}
          hitSlop={6}
          style={styles.directionsRow}
        >
          <Text style={styles.directionsText}>
            📍 {hangout.venue_address || hangout.venue_name} · Directions
          </Text>
        </Pressable>
      ) : null}

      {hangout.reasoning ? (
        <Text style={styles.hangoutReasoning}>“{hangout.reasoning}”</Text>
      ) : null}

      <View style={styles.responseSummary}>
        <Text style={styles.responseSummaryText}>
          {confirmedCount}/{groupMemberCount} in
          {maybeCount > 0 ? ` · ${maybeCount} maybe` : ''}
          {declinedCount > 0 ? ` · ${declinedCount} out` : ''}
          {isConfirmed
            ? ` — going ✓`
            : isCancelled
            ? ` — not enough yeses`
            : stillNeeded > 0
            ? ` — needs ${stillNeeded} more (min ${threshold})`
            : ''}
        </Text>
      </View>

      {!isConfirmed && !isCancelled ? (
        <View style={styles.responseActions}>
          <ResponseButton
            label={myStatus === 'confirmed' ? "✓ You're in" : "I'm in"}
            active={myStatus === 'confirmed'}
            onPress={() => respond('confirmed')}
            loading={responding === 'confirmed'}
            variant="primary"
          />
          <ResponseButton
            label={myStatus === 'maybe' ? '~ Maybe' : 'Maybe'}
            active={myStatus === 'maybe'}
            onPress={() => respond('maybe')}
            loading={responding === 'maybe'}
            variant="neutral"
          />
          <ResponseButton
            label={myStatus === 'declined' ? '✕ Out' : 'Out'}
            active={myStatus === 'declined'}
            onPress={() => respond('declined')}
            loading={responding === 'declined'}
            variant="danger"
          />
        </View>
      ) : null}
      {isConfirmed && myStatus === 'confirmed' ? (
        <Pressable
          onPress={() => respond('declined')}
          disabled={!!responding}
          style={({ pressed }) => [styles.cantMakeItBtn, pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.cantMakeItText}>
            {responding === 'declined' ? '…' : "Can't make it"}
          </Text>
        </Pressable>
      ) : null}
      <Text style={styles.detailsLink}>Details, people & invites ›</Text>
      {/* Realtime refreshes the list after changes made in the sheet. */}
      <HangoutSheet hangoutId={showDetails ? hangout.id : null} onClose={() => setShowDetails(false)} />
    </Pressable>
  );
}

function ResponseButton({
  label,
  onPress,
  active,
  loading,
  variant,
}: {
  label: string;
  onPress: () => void;
  active: boolean;
  loading: boolean;
  variant: 'primary' | 'neutral' | 'danger';
}) {
  const palette = {
    primary: { bgActive: colors.accent, bgIdle: colors.bgRaised, fgActive: colors.textInverse, fgIdle: colors.text },
    neutral: { bgActive: colors.accent2Dim, bgIdle: colors.bgRaised, fgActive: colors.accent2, fgIdle: colors.textMuted },
    danger:  { bgActive: 'rgba(248,113,113,0.18)', bgIdle: colors.bgRaised, fgActive: colors.danger, fgIdle: colors.textMuted },
  }[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => [
        styles.responseBtn,
        { backgroundColor: active ? palette.bgActive : palette.bgIdle },
        pressed && { opacity: 0.85 },
      ]}
    >
      <Text
        style={[
          styles.responseBtnText,
          { color: active ? palette.fgActive : palette.fgIdle },
        ]}
      >
        {loading ? '…' : label}
      </Text>
    </Pressable>
  );
}

function formatHangoutTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Open the hangout's venue in Google Maps — exact coords if we have them,
 *  otherwise a text query of the venue name/address. */
function openHangoutDirections(h: Hangout): void {
  let url: string | null = null;
  if (typeof h.venue_lat === 'number' && typeof h.venue_lng === 'number') {
    url = `https://maps.google.com/?q=${h.venue_lat},${h.venue_lng}`;
  } else {
    const q = [h.venue_name, h.venue_address].filter(Boolean).join(' ').trim();
    if (q) url = `https://maps.google.com/?q=${encodeURIComponent(q)}`;
  }
  if (url) Linking.openURL(url).catch(() => {});
}

function CreateGroupModal({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const create = async () => {
    if (!user || !name.trim()) {
      Alert.alert('Name required', 'Give your group a name.');
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.rpc('create_group', {
      _name: name.trim(),
      _description: description.trim() || undefined,
    });
    setSubmitting(false);
    if (error) {
      Alert.alert('Could not create group', error.message);
      return;
    }
    setName('');
    setDescription('');
    onCreated();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>New group</Text>
          <Text style={styles.modalSub}>
            A small crew you want to coordinate hangouts with.
          </Text>
          <Input
            label="Name"
            placeholder="The crew, Gym squad, FRI study group…"
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
          />
          <Input
            label="Description (optional)"
            placeholder="Who's in this group, what you do together"
            value={description}
            onChangeText={setDescription}
            multiline
          />
          <View style={styles.modalActions}>
            <Button label="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            <Button
              label="Create"
              onPress={create}
              loading={submitting}
              style={{ flex: 1 }}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  title: {
    fontSize: font.size.xxl,
    fontWeight: '700',
    color: colors.text,
  },
  addBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  addBtnText: { color: colors.accent, fontWeight: '600', fontSize: 13 },
  listBody: {
    padding: space.lg,
    gap: space.md,
    flexGrow: 1,
  },
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: space.sm,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  cardMembers: { fontSize: 12, color: colors.textMuted },
  addMemberBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  addMemberText: { color: colors.accent, fontSize: 11, fontWeight: '700' },
  memberChipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  memberChip: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  memberChipText: { color: colors.textMuted, fontSize: 12 },
  memberChipWithAvatar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 3,
  },
  detailsLink: { color: colors.accent, fontSize: 12, fontWeight: '600', marginTop: 2 },
  proposerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  proposerText: { color: colors.textMuted, fontSize: 12 },
  cardSub: { color: colors.textMuted, fontSize: 13 },
  noHangout: { color: colors.textDim, fontSize: 12, fontStyle: 'italic', marginTop: 4 },

  hangoutCard: {
    backgroundColor: colors.bgRaised,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  hangoutCardConfirmed: {
    borderColor: colors.accent,
    backgroundColor: colors.accentDim,
  },
  hangoutCardCancelled: {
    opacity: 0.55,
  },
  hangoutHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  hangoutDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  hangoutTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  confirmedBadge: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.accent,
    letterSpacing: 1,
  },
  proposingBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textDim,
    letterSpacing: 1,
  },
  cancelledBadge: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.danger,
    letterSpacing: 1,
  },
  hangoutTime: {
    color: colors.textMuted,
    fontSize: 13,
    marginLeft: 16,
  },
  directionsRow: {
    marginLeft: 16,
    marginTop: 3,
  },
  directionsText: {
    color: colors.accent,
    fontSize: 12,
  },
  hangoutReasoning: {
    color: colors.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    marginLeft: 16,
    marginTop: 2,
  },
  responseSummary: {
    marginLeft: 16,
    marginTop: 4,
  },
  responseSummaryText: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.3,
  },
  responseActions: {
    flexDirection: 'row',
    gap: 6,
    marginTop: space.xs,
  },
  responseBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  responseBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },

  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.xs,
  },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '600' },
  emptyBody: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 300,
    lineHeight: 20,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: space.xl,
    gap: space.md,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  modalTitle: { fontSize: 22, fontWeight: '700', color: colors.text },
  modalSub: { fontSize: 13, color: colors.textMuted, marginTop: -8 },
  modalActions: {
    flexDirection: 'row',
    gap: space.md,
    marginTop: space.md,
  },
  cantMakeItBtn: {
    alignSelf: 'flex-start',
    marginLeft: 16,
    marginTop: 2,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cantMakeItText: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '500',
  },
  swipeActionsContainer: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginLeft: space.md,
  },
  swipeAction: {
    width: 80,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.lg,
  },
  muteAction: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.border,
    marginRight: 6,
  },
  leaveAction: {
    backgroundColor: 'rgba(248,113,113,0.15)',
    borderWidth: 1,
    borderColor: colors.danger,
  },
  swipeActionText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  mutedBadge: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textDim,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    letterSpacing: 0.5,
  },
});
