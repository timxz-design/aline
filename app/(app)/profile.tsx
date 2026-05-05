import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AddFriendModal } from '../../src/components/AddFriendModal';
import { Button } from '../../src/components/Button';
import { GoogleCalendarConnect } from '../../src/components/GoogleCalendarConnect';
import { Input } from '../../src/components/Input';
import { Screen } from '../../src/components/Screen';
import { useAuth } from '../../src/lib/auth-context';
import { OPENNESS_OPTIONS, type SocialOpenness } from '../../src/lib/onboarding-data';
import { recomputePlacesForCurrentUser, resolvePlaceIdentities } from '../../src/lib/places';
import { recomputeRoutinesForCurrentUser } from '../../src/lib/routines';
import { recomputeBehavioralSummaryForCurrentUser } from '../../src/lib/summary';
import { supabase } from '../../src/lib/supabase';
import { useFriends, type FriendProfile, type PendingRequest } from '../../src/lib/use-friends';
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
              friends.map((f) => <FriendRow key={f.id} friend={f} />)
            )}
          </View>

          <Button
            label="+ Add friend"
            variant="secondary"
            onPress={() => setShowAddFriend(true)}
            style={{ marginTop: space.sm }}
          />
        </Section>

        {/* Google Calendar connection */}
        <Section title="Google Calendar">
          <GoogleCalendarConnect />
        </Section>

        {/* Behavioral profile (debug) */}
        <Section title="Behavioral profile (debug)">
          <PlacesDebugButton />
        </Section>

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
        <Section title="What ALINE knows about you">
          <Text style={styles.subtleNote}>
            Built from what you've told the agent. You can correct anything by
            chatting with ALINE — "I don't actually run anymore", "drop the
            morning thing".
          </Text>

          <Subsection label={`Goals (${goals.length})`}>
            {goals.length === 0 ? (
              <Text style={styles.emptyText}>None yet.</Text>
            ) : (
              goals.map((g) => (
                <View key={g.id} style={styles.factRow}>
                  <Text style={styles.factPrimary}>{g.title}</Text>
                  <Text style={styles.factMeta}>
                    {g.category ?? 'general'}
                    {g.is_aspirational ? ' · aspirational' : ''} · {g.status}
                  </Text>
                </View>
              ))
            )}
          </Subsection>

          <Subsection label={`Preferences (${interests.length})`}>
            {interests.length === 0 ? (
              <Text style={styles.emptyText}>
                {loading ? 'Loading…' : 'None yet.'}
              </Text>
            ) : (
              interests.map((i) => (
                <View key={i.id} style={styles.factRow}>
                  <Text style={styles.factPrimary}>{formatInterest(i)}</Text>
                  <Text style={styles.factMeta}>
                    {i.key} · from {i.source ?? 'unknown'} ·{' '}
                    {Math.round((i.confidence ?? 0) * 100)}% confidence
                  </Text>
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

/**
 * Manual trigger for the place-clustering pipeline. Block-1 debug surface —
 * lets you verify pings → places upsert end-to-end before automating it.
 */
function PlacesDebugButton() {
  const [running, setRunning] = useState<'cluster' | 'resolve' | 'routines' | 'summary' | null>(null);
  const [last, setLast] = useState<string | null>(null);

  const cluster = useCallback(async () => {
    setRunning('cluster');
    try {
      const r = await recomputePlacesForCurrentUser();
      setLast(
        r.error
          ? `Cluster error: ${r.error}`
          : `Read ${r.pingsRead} pings → ${r.clustersFound} clusters → ${r.placesUpserted} places upserted`
      );
    } catch (e) {
      setLast(`Exception: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(null);
    }
  }, []);

  const resolve = useCallback(async () => {
    setRunning('resolve');
    try {
      const r = await resolvePlaceIdentities();
      setLast(
        r.error
          ? `Resolve error: ${r.error}`
          : `Resolved ${r.resolved} / ${r.total} places via Google Places`
      );
    } catch (e) {
      setLast(`Exception: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(null);
    }
  }, []);

  const routines = useCallback(async () => {
    setRunning('routines');
    try {
      const r = await recomputeRoutinesForCurrentUser();
      setLast(
        r.error
          ? `Routines error: ${r.error}`
          : `Mined ${r.pingsRead} pings × ${r.placesRead} places → ${r.routinesFound} routines detected`
      );
    } catch (e) {
      setLast(`Exception: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(null);
    }
  }, []);

  const summary = useCallback(async () => {
    setRunning('summary');
    try {
      const r = await recomputeBehavioralSummaryForCurrentUser();
      if (r.error) setLast(`Summary error: ${r.error}`);
      else if (r.summary) {
        setLast(
          `[${r.summary.data_quality}] ${r.summary.archetype_text}`,
        );
      } else {
        setLast('No summary produced');
      }
    } catch (e) {
      setLast(`Exception: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(null);
    }
  }, []);

  return (
    <View style={{ gap: space.sm }}>
      <Button
        label={running === 'cluster' ? 'Clustering…' : '1. Recompute places from pings'}
        onPress={cluster}
        disabled={running !== null}
      />
      <Button
        label={running === 'resolve' ? 'Resolving…' : '2. Label places via Google Places'}
        onPress={resolve}
        disabled={running !== null}
      />
      <Button
        label={running === 'routines' ? 'Mining…' : '3. Detect routines from pings'}
        onPress={routines}
        disabled={running !== null}
      />
      <Button
        label={running === 'summary' ? 'Generating…' : '4. Generate behavioral summary'}
        onPress={summary}
        disabled={running !== null}
      />
      {last ? (
        <Text style={{ color: colors.textDim, fontSize: 12 }}>{last}</Text>
      ) : null}
    </View>
  );
}

function FriendRow({ friend }: { friend: FriendProfile }) {
  return (
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
      </View>
    </View>
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
    borderWidth: 1,
    borderColor: colors.border,
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
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
  },
  factPrimary: { color: colors.text, fontSize: 14, fontWeight: '600' },
  factMeta: { color: colors.textDim, fontSize: 11 },

  opennessOption: {
    flexDirection: 'row',
    gap: space.md,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.border,
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
    borderWidth: 1,
    borderColor: colors.border,
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
  friendName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  friendHandle: { color: colors.textMuted, fontSize: 12 },
  miniBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.border,
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
