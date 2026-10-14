import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { AddFriendModal } from '../../src/components/AddFriendModal';
import { BehavioralProfile } from '../../src/components/BehavioralProfile';
import { Button } from '../../src/components/Button';
import { DeviceCalendarConnect } from '../../src/components/DeviceCalendarConnect';
import { GoogleCalendarConnect } from '../../src/components/GoogleCalendarConnect';
import { HealthConnect } from '../../src/components/HealthConnect';
import { Input } from '../../src/components/Input';
import { PipelineStatus } from '../../src/components/PipelineStatus';
import { Screen } from '../../src/components/Screen';
import { useAuth } from '../../src/lib/auth-context';
import { OPENNESS_OPTIONS, type SocialOpenness } from '../../src/lib/onboarding-data';
import { supabase } from '../../src/lib/supabase';
import { useFriends, setFriendTier, type FriendProfile, type PendingRequest } from '../../src/lib/use-friends';
import { useProfile } from '../../src/lib/use-profile';
import type { Goal, Interest } from '../../src/types/database';
import { colors, font, radius, space } from '../../src/theme';

/**
 * Profile / Settings tab. Three things:
 *
 *   1. Identity strip — name, email, edit name inline.
 *   2. "What I know about you" — a transparent dump of goals + interests
 *      so the user always sees what their agent has learned. This matters
 *      for the trust principle (#3 in the design philosophy).
 *   3. Settings — social openness + sign out.
 */
export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const { profile, refresh } = useProfile();
  const { friends, pending, refresh: refreshFriends } = useFriends();

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [showAddFriend, setShowAddFriend] = useState(false);

  const [goals, setGoals] = useState<Goal[]>([]);
  const [interests, setInterests] = useState<Interest[]>([]);
  const [loading, setLoading] = useState(false);

  const loadFacts = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [goalsRes, interestsRes] = await Promise.all([
      supabase
        .from('goals')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20),
      supabase
        .from('interests')
        .select('*')
        .eq('user_id', user.id)
        .eq('active', true)
        .order('updated_at', { ascending: false })
        .limit(40),
    ]);
    setGoals((goalsRes.data ?? []) as Goal[]);
    setInterests((interestsRes.data ?? []) as Interest[]);
    setLoading(false);
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      loadFacts();
    }, [loadFacts])
  );

  const deletePreference = useCallback(
    (text: string, ids: string[]) => {
      Alert.alert('Forget this?', `ALINE will forget: "${text}"`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: async () => {
            const { error } = await supabase.from('interests').delete().in('id', ids);
            if (error) Alert.alert('Failed', error.message);
            else loadFacts();
          },
        },
      ]);
    },
    [loadFacts],
  );

  const deleteGoal = useCallback(
    (ids: string[], title: string) => {
      Alert.alert('Delete goal?', `"${title}" will be removed.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            // Remove every stored version of this goal, not just the latest row.
            const { error } = await supabase.from('goals').delete().in('id', ids);
            if (error) Alert.alert('Failed', error.message);
            else loadFacts();
          },
        },
      ]);
    },
    [loadFacts],
  );

  // Collapse repeated goals into one row each (newest kept for display), but
  // keep every version's id + a last-changed timestamp so the history isn't
  // lost and the user can see when a goal shifted.
  const goalRows = dedupeGoals(goals);

  const startEditName = () => {
    setNameDraft(profile?.first_name ?? '');
    setEditingName(true);
  };

  const saveName = async () => {
    if (!user || !nameDraft.trim()) return;
    setSavingName(true);
    const { error } = await supabase
      .from('profiles')
      .update({ first_name: nameDraft.trim() })
      .eq('id', user.id);
    setSavingName(false);
    if (error) {
      Alert.alert('Could not save', error.message);
      return;
    }
    setEditingName(false);
    await refresh();
  };

  const updateOpenness = async (value: SocialOpenness) => {
    if (!user || profile?.social_openness === value) return;
    const { error } = await supabase
      .from('profiles')
      .update({ social_openness: value })
      .eq('id', user.id);
    if (error) {
      Alert.alert('Could not save', error.message);
      return;
    }
    await refresh();
  };

  return (
    <Screen noPadding>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.pageTitle}>You</Text>

        {/* Identity */}
        <View style={styles.card}>
          <View style={styles.identityRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {(profile?.first_name?.[0] ?? '?').toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              {editingName ? (
                <View style={{ gap: space.xs }}>
                  <Input value={nameDraft} onChangeText={setNameDraft} autoFocus />
                  <View style={{ flexDirection: 'row', gap: space.xs }}>
                    <Button
                      label="Cancel"
                      variant="secondary"
                      onPress={() => setEditingName(false)}
                      style={{ flex: 1, height: 36 }}
                    />
                    <Button
                      label="Save"
                      onPress={saveName}
                      loading={savingName}
                      style={{ flex: 1, height: 36 }}
                    />
                  </View>
                </View>
              ) : (
                <>
                  <Pressable onPress={startEditName} hitSlop={6}>
                    <Text style={styles.name}>
                      {profile?.first_name ?? '—'}{' '}
                      <Text style={styles.editLink}>edit</Text>
                    </Text>
                  </Pressable>
                  {profile?.handle ? (
                    <Text style={styles.handle}>@{profile.handle}</Text>
                  ) : null}
                  <Text style={styles.email}>{user?.email}</Text>
                </>
              )}
            </View>
          </View>
        </View>

        {/* Friends */}
        <Section title="Friends">
          {pending.length > 0 ? (
            <View style={styles.pendingWrap}>
              <Text style={styles.subsectionLabel}>
                {pending.filter((p) => !p.outbound).length > 0
                  ? `${pending.filter((p) => !p.outbound).length} request${
                      pending.filter((p) => !p.outbound).length === 1 ? '' : 's'
                    } waiting`
                  : 'Pending'}
              </Text>
              <View style={{ gap: 6 }}>
                {pending.map((p) => (
                  <PendingRequestRow key={p.user.id} req={p} onActed={refreshFriends} />
                ))}
              </View>
            </View>
          ) : null}

          <View style={{ gap: space.xs }}>
            <Text style={styles.subsectionLabel}>Friends ({friends.length})</Text>
            {friends.length === 0 ? (
              <Text style={styles.emptyText}>
                No friends yet. Add someone by their handle to get started.
              </Text>
            ) : (
              friends.map((f) => (
                <FriendRow key={f.id} friend={f} onUnfriended={refreshFriends} />
              ))
            )}
          </View>

          <Button
            label="+ Add friend"
            variant="secondary"
            onPress={() => setShowAddFriend(true)}
            style={{ marginTop: space.sm }}
          />
        </Section>

        {/* Calendar connections — phone calendar first: it's where most
            people's real schedule lives, and needs no OAuth. */}
        <Section title="Calendars">
          <View style={{ gap: space.lg }}>
            <DeviceCalendarConnect />
            <GoogleCalendarConnect />
          </View>
        </Section>

        {/* Apple Health — measured workouts + sleep */}
        <Section title="Apple Health">
          <HealthConnect />
        </Section>

        {/* Behavioral profile — what ALINE knows about you */}
        <Section title="What ALINE knows about you">
          <BehavioralProfile />
        </Section>

        {/* Pipeline sync status — replaces the old four manual debug buttons */}
        <PipelineStatus />

        {/* Social openness */}
        <Section title="Social openness">
          <View style={{ gap: space.sm }}>
            {OPENNESS_OPTIONS.map((opt) => {
              const active = profile?.social_openness === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => updateOpenness(opt.value)}
                  style={({ pressed }) => [
                    styles.opennessOption,
                    active && styles.opennessOptionActive,
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <View
                    style={[styles.radio, active && styles.radioActive]}
                  />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.opennessLabel,
                        active && styles.opennessLabelActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                    <Text style={styles.opennessDesc}>{opt.description}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </Section>

        {/* What I know */}
        <Section title="Goals & preferences">
          <Text style={styles.subtleNote}>
            Built from what you've told the agent. You can correct anything by
            chatting with ALINE — "I don't actually run anymore", "drop the
            morning thing".
          </Text>

          <Subsection label={`Goals (${goalRows.length})`}>
            {goalRows.length === 0 ? (
              <Text style={styles.emptyText}>None yet.</Text>
            ) : (
              goalRows.map(({ goal: g, ids, versions }) => {
                const when = formatWhen(g.updated_at ?? g.created_at);
                const meta = [when, versions > 1 ? `${versions} versions` : '']
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <View key={g.id} style={[styles.factRow, styles.factRowWithAction]}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.factPrimary}>{g.title}</Text>
                      {meta ? <Text style={styles.factMeta}>{meta}</Text> : null}
                    </View>
                    <Pressable
                      onPress={() => deleteGoal(ids, g.title)}
                      hitSlop={10}
                      style={styles.deleteBtn}
                    >
                      <Text style={styles.deleteBtnText}>✕</Text>
                    </Pressable>
                  </View>
                );
              })
            )}
          </Subsection>

          <Subsection label="Preferences">
            {interests.length === 0 ? (
              <Text style={styles.emptyText}>
                {loading ? 'Loading…' : 'None yet.'}
              </Text>
            ) : (
              groupInterests(interests).map((group) => (
                <View key={group.label} style={styles.prefGroup}>
                  <Text style={styles.prefGroupLabel}>{group.label}</Text>
                  <View style={styles.prefChipWrap}>
                    {group.items.map((item, idx) => (
                      <Pressable
                        key={idx}
                        onPress={() => deletePreference(item.text, item.ids)}
                        style={({ pressed }) => [styles.prefChip, pressed && { opacity: 0.6 }]}
                      >
                        <Text style={styles.prefChipText}>{item.text}</Text>
                        <Text style={styles.prefChipX}>✕</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ))
            )}
          </Subsection>
        </Section>

        {/* Danger zone */}
        <Section title="Account">
          <Button
            label="Sign out"
            variant="secondary"
            onPress={async () => {
              await signOut();
            }}
          />
        </Section>

        <Text style={styles.versionText}>ALINE MVP · alpha</Text>
      </ScrollView>

      <AddFriendModal
        visible={showAddFriend}
        onClose={() => setShowAddFriend(false)}
        onSuccess={refreshFriends}
      />
    </Screen>
  );
}

function FriendRow({
  friend,
  onUnfriended,
}: {
  friend: FriendProfile;
  onUnfriended: () => void;
}) {
  const swipeRef = useRef<Swipeable>(null);

  const confirmUnfriend = () => {
    const label = friend.first_name ?? friend.handle ?? 'this friend';
    Alert.alert(
      `Unfriend ${label}?`,
      "You'll need to send a new request if you want to add them back later.",
      [
        { text: 'Cancel', style: 'cancel', onPress: () => swipeRef.current?.close() },
        {
          text: 'Unfriend',
          style: 'destructive',
          onPress: async () => {
            const { error } = await supabase.rpc('unfriend', { _other_user: friend.id });
            if (error) {
              Alert.alert('Could not unfriend', error.message);
              return;
            }
            onUnfriended();
          },
        },
      ]
    );
  };

  const renderRightActions = (
    progress: Animated.AnimatedInterpolation<number>
  ) => {
    const translate = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [80, 0],
    });
    return (
      <Animated.View style={{ transform: [{ translateX: translate }] }}>
        <Pressable style={styles.unfriendAction} onPress={confirmUnfriend}>
          <Text style={styles.unfriendActionText}>Unfriend</Text>
        </Pressable>
      </Animated.View>
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
      <View style={styles.friendRow}>
        <View style={styles.friendAvatar}>
          <Text style={styles.friendAvatarText}>
            {(friend.first_name?.[0] ?? friend.handle?.[0] ?? '?').toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.friendName}>
            {friend.first_name ?? friend.display_name ?? 'Unnamed'}
          </Text>
          {friend.handle ? (
            <Text style={styles.friendHandle}>@{friend.handle}</Text>
          ) : null}
          {friend.myTier === 'inner' ? (
            <Text style={styles.innerCircleLabel}>Inner circle · shares your full schedule</Text>
          ) : null}
        </View>
        <Pressable
          onPress={async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
            const next = friend.myTier === 'inner' ? 'friend' : 'inner';
            const { error } = await setFriendTier(friend.id, next);
            if (error) { Alert.alert('Could not update', error); return; }
            onUnfriended(); // refresh the friend list
          }}
          hitSlop={10}
          style={styles.tierToggle}
          accessibilityLabel={friend.myTier === 'inner' ? 'Remove from inner circle' : 'Add to inner circle'}
        >
          <Ionicons
            name={friend.myTier === 'inner' ? 'star' : 'star-outline'}
            size={18}
            color={friend.myTier === 'inner' ? colors.accent : colors.textDim}
          />
        </Pressable>
      </View>
    </Swipeable>
  );
}

function PendingRequestRow({
  req,
  onActed,
}: {
  req: PendingRequest;
  onActed: () => void;
}) {
  const [acting, setActing] = useState<'accept' | 'decline' | null>(null);

  const respond = async (action: 'accept' | 'decline') => {
    setActing(action);
    const { error } = await supabase.rpc('respond_to_friendship', {
      _other_user: req.user.id,
      _action: action,
    });
    setActing(null);
    if (error) {
      Alert.alert('Error', error.message);
      return;
    }
    onActed();
  };

  const cancelOutbound = async () => {
    setActing('decline');
    const { error } = await supabase.rpc('unfriend', { _other_user: req.user.id });
    setActing(null);
    if (error) {
      Alert.alert('Error', error.message);
      return;
    }
    onActed();
  };

  return (
    <View style={styles.pendingRow}>
      <View style={styles.friendAvatar}>
        <Text style={styles.friendAvatarText}>
          {(req.user.first_name?.[0] ?? req.user.handle?.[0] ?? '?').toUpperCase()}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.friendName}>
          {req.user.first_name ?? 'Unnamed'}
        </Text>
        <Text style={styles.friendHandle}>
          @{req.user.handle ?? '—'} ·{' '}
          {req.outbound ? 'request sent' : 'wants to be friends'}
        </Text>
      </View>
      {req.outbound ? (
        <Pressable
          onPress={cancelOutbound}
          disabled={acting !== null}
          hitSlop={8}
          style={({ pressed }) => [styles.miniBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.miniBtnTextNeutral}>Cancel</Text>
        </Pressable>
      ) : (
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Pressable
            onPress={() => respond('decline')}
            disabled={acting !== null}
            hitSlop={6}
            style={({ pressed }) => [styles.miniBtn, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.miniBtnTextNeutral}>
              {acting === 'decline' ? '…' : 'No'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => respond('accept')}
            disabled={acting !== null}
            hitSlop={6}
            style={({ pressed }) => [
              styles.miniBtnAccept,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={styles.miniBtnTextAccept}>
              {acting === 'accept' ? '…' : 'Accept'}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Subsection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.subsection}>
      <Text style={styles.subsectionLabel}>{label}</Text>
      <View style={{ gap: 4 }}>{children}</View>
    </View>
  );
}

/** Collapse repeated goals (same title) into one display row.
 *  Goals arrive newest-first, so the first row seen for a title is the one we
 *  keep to display; the rest are folded in. We hold onto every version's id
 *  (so delete removes the whole history) and a count of how many times the
 *  goal has been restated — the "versions" the user can eyeball for change. */
function dedupeGoals(
  goals: Goal[],
): { goal: Goal; ids: string[]; versions: number }[] {
  const byTitle = new Map<string, { goal: Goal; ids: string[]; versions: number }>();
  for (const g of goals) {
    const key = g.title.trim().toLowerCase();
    const existing = byTitle.get(key);
    if (existing) {
      existing.ids.push(g.id);
      existing.versions += 1;
    } else {
      byTitle.set(key, { goal: g, ids: [g.id], versions: 1 });
    }
  }
  return [...byTitle.values()];
}

/** Compact "when" stamp — when ALINE last recorded or changed this goal. */
function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' },
  );
}

// Friendly section labels for the raw interest keys the agent extracts.
const INTEREST_GROUPS: Record<string, string> = {
  activity_like: 'Likes',
  activity_dislike: 'Dislikes',
  time_preference: 'Time preferences',
  venue_preference: 'Places & venues',
  social_preference: 'Social style',
  group_preference: 'Groups',
  goal_update: 'Goal notes',
  mood: 'Recent moods',
  life_event: 'Life events',
  other: 'Other',
};
const GROUP_ORDER = Object.values(INTEREST_GROUPS);

/** Group raw interests into human sections, prettified + deduped.
 *  Each chip keeps the ids of ALL rows it represents so delete removes them all. */
function groupInterests(
  interests: Interest[],
): { label: string; items: { text: string; ids: string[] }[] }[] {
  const byLabel = new Map<string, Map<string, string[]>>();
  for (const i of interests) {
    const label = INTEREST_GROUPS[i.key] ?? 'Other';
    const raw = formatInterest(i).trim();
    if (!raw) continue;
    const text = raw.charAt(0).toUpperCase() + raw.slice(1);
    if (!byLabel.has(label)) byLabel.set(label, new Map());
    const items = byLabel.get(label)!;
    items.set(text, [...(items.get(text) ?? []), i.id]);
  }
  return GROUP_ORDER.filter((l) => byLabel.has(l)).map((label) => ({
    label,
    items: [...byLabel.get(label)!.entries()].map(([text, ids]) => ({ text, ids })),
  }));
}

function formatInterest(i: Interest): string {
  // Best-effort prettify of the JSONB value.
  const v = i.value as unknown;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (typeof obj.label === 'string') return obj.label;
    return Object.entries(obj)
      .map(([k, val]) => `${k}: ${typeof val === 'string' ? val : JSON.stringify(val)}`)
      .join(' · ');
  }
  return JSON.stringify(v);
}

const styles = StyleSheet.create({
  body: {
    padding: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xxxl,
    gap: space.lg,
  },
  pageTitle: {
    color: colors.text,
    fontSize: font.size.xxl,
    fontWeight: '700',
  },

  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: space.lg,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.accent, fontSize: 20, fontWeight: '700' },
  name: { color: colors.text, fontSize: 18, fontWeight: '700' },
  editLink: { color: colors.accent, fontSize: 12, fontWeight: '600' },
  handle: { color: colors.accent, fontSize: 13, marginTop: 2, fontWeight: '500' },
  email: { color: colors.textMuted, fontSize: 13, marginTop: 2 },

  section: { gap: space.sm },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
  },

  subsection: { gap: 4, marginTop: space.sm },
  subsectionLabel: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },

  subtleNote: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    fontStyle: 'italic',
  },
  emptyText: { color: colors.textDim, fontSize: 13, fontStyle: 'italic' },

  factRow: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    padding: space.md,
    gap: 2,
  },
  factPrimary: { color: colors.text, fontSize: 14, fontWeight: '600' },
  factMeta: { color: colors.textDim, fontSize: 11 },

  prefGroup: { gap: 6 },
  prefGroupLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  prefChipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  prefChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
  prefChipText: { color: colors.text, fontSize: 13 },
  prefChipX: { color: colors.textDim, fontSize: 11 },
  factRowWithAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  deleteBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtnText: { color: colors.textDim, fontSize: 13 },

  opennessOption: {
    flexDirection: 'row',
    gap: space.md,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
    padding: space.md,
  },
  opennessOptionActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentDim,
  },
  radio: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.border,
    marginTop: 3,
  },
  radioActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  opennessLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  opennessLabelActive: { color: colors.accent },
  opennessDesc: { color: colors.textMuted, fontSize: 12, marginTop: 2 },

  versionText: {
    textAlign: 'center',
    color: colors.textDim,
    fontSize: 11,
    marginTop: space.xl,
  },

  pendingWrap: {
    backgroundColor: colors.accentDim,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.accent,
    gap: space.xs,
  },
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 4,
  },
  friendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    padding: space.sm,
  },
  friendAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  friendAvatarText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  innerCircleLabel: { color: colors.accent, fontSize: 11, fontWeight: '600', marginTop: 2 },
  tierToggle: { paddingHorizontal: space.xs, paddingVertical: space.xs },
  tierStar: { fontSize: 20, color: colors.textDim },
  tierStarOn: { color: colors.accent },
  friendName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  friendHandle: { color: colors.textMuted, fontSize: 12 },
  unfriendAction: {
    width: 80,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(248,113,113,0.15)',
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
    marginLeft: space.sm,
  },
  unfriendActionText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  miniBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.bgRaised,
  },
  miniBtnAccept: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  miniBtnTextNeutral: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  miniBtnTextAccept: { color: colors.textInverse, fontSize: 12, fontWeight: '700' },
});
