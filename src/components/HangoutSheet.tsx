import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAuth } from '../lib/auth-context';
import {
  getHangoutDetails,
  getInviteCandidates,
  INVITE_POLICY_LABEL,
  inviteToHangout,
  personName,
  respondToHangout,
  setInvitePolicy,
  type HangoutDetails,
  type InviteCandidate,
  type InvitePolicy,
  type ParticipantStatus,
} from '../lib/hangouts';
import { supabase } from '../lib/supabase';
import { colors, font, radius, space } from '../theme';
import { AvatarStack, otherParticipants, planColor } from './AvatarStack';
import { Button } from './Button';
import { PersonAvatar } from './PersonAvatar';

/**
 * Everything about one plan, opened from a calendar block, an upcoming card or
 * a group's hangout card: what / when / where, why the agent picked it, who's
 * in (and how they answered), your own answer, inviting more people, and — for
 * the host — who else is allowed to invite.
 */

const STATUS_LABEL: Record<ParticipantStatus, string> = {
  confirmed: 'Going',
  maybe: 'Maybe',
  pending: 'Invited',
  declined: "Can't",
};

const POLICY_HINT: Record<InvitePolicy, string> = {
  host_only: 'Only you can add people.',
  participants: 'Anyone going can add their friends.',
  mutuals: 'Anyone going can add friends who also know someone else in the plan.',
};

const BLOCK_REASON: Record<string, string> = {
  no_mutual: 'Not friends with anyone else here',
  not_your_friend: 'Not your friend',
  already_in: 'Already invited',
};

export function HangoutSheet({
  hangoutId,
  onClose,
  onChanged,
}: {
  hangoutId: string | null;
  onClose: () => void;
  /** Called after any change (answer, invite, policy) so callers can reload. */
  onChanged?: () => void;
}) {
  const { user } = useAuth();
  const [plan, setPlan] = useState<HangoutDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [candidates, setCandidates] = useState<InviteCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!hangoutId) return;
    setLoading(true);
    try {
      setPlan(await getHangoutDetails(hangoutId));
    } catch (e) {
      Alert.alert("Couldn't load the plan", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [hangoutId]);

  useEffect(() => {
    setPlan(null);
    setInviting(false);
    setCandidates(null);
    setPicked(new Set());
    load();
  }, [load]);

  const changed = async () => {
    await load();
    onChanged?.();
  };

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      await changed();
    } catch (e) {
      Alert.alert('Something went wrong', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openInvite = async () => {
    if (!plan) return;
    setInviting(true);
    setPicked(new Set());
    try {
      setCandidates(await getInviteCandidates(plan.id));
    } catch (e) {
      setCandidates([]);
      Alert.alert("Couldn't load friends", (e as Error).message);
    }
  };

  const sendInvites = () =>
    plan &&
    run('invite', async () => {
      const n = await inviteToHangout(plan.id, [...picked]);
      setInviting(false);
      setCandidates(null);
      if (n === 0) Alert.alert('Nobody invited', "Those people can't be added to this plan.");
    });

  const cancelPlan = () => {
    if (!plan) return;
    Alert.alert('Cancel this plan?', 'Everyone in it will be told.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Cancel plan',
        style: 'destructive',
        onPress: () =>
          run('cancel', async () => {
            const { error } = await supabase.rpc('cancel_hangout', { _hangout_id: plan.id });
            if (error) throw new Error(error.message);
          }),
      },
    ]);
  };

  const me = plan?.participants.find((p) => p.user_id === user?.id);
  const others = plan ? otherParticipants(plan.participants, user?.id) : [];
  const accent = plan ? planColor(plan.participants, user?.id) : colors.eventCoordinated;
  const isClosed = plan?.status === 'cancelled';

  return (
    <Modal
      visible={!!hangoutId}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet}>
        <View style={[styles.band, { backgroundColor: accent }]} />
        <View style={styles.topBar}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close">
            <Ionicons name="close" size={24} color={colors.textMuted} />
          </Pressable>
        </View>

        {!plan ? (
          <View style={styles.center}>
            {loading ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={styles.muted}>This plan isn't available.</Text>
            )}
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            {/* Header */}
            <View style={{ gap: space.sm }}>
              <AvatarStack people={others} size={30} max={5} />
              <Text style={styles.title}>{plan.title || 'Plan'}</Text>
              <View style={styles.row}>
                <StatusBadge status={plan.status} />
                {plan.group_name ? <Text style={styles.muted}>· {plan.group_name}</Text> : null}
              </View>
            </View>

            {/* What / when / where */}
            <View style={styles.card}>
              <InfoRow icon="time-outline" text={formatWhen(plan.proposed_start, plan.proposed_end)} />
              {plan.venue_name || plan.venue_address ? (
                <Pressable onPress={() => openDirections(plan)} hitSlop={6}>
                  <InfoRow
                    icon="location-outline"
                    text={[plan.venue_name, plan.venue_address].filter(Boolean).join(' · ')}
                    action="Directions"
                  />
                </Pressable>
              ) : (
                <InfoRow icon="location-outline" text="No place set yet" muted />
              )}
              {plan.description ? <InfoRow icon="document-text-outline" text={plan.description} /> : null}
            </View>

            {plan.reasoning ? (
              <View style={styles.card}>
                <Text style={styles.label}>Why this works</Text>
                <Text style={styles.reasoning}>{plan.reasoning}</Text>
              </View>
            ) : null}

            {/* Your answer */}
            {me && !isClosed ? (
              <View style={{ gap: space.sm }}>
                <Text style={styles.label}>Your answer</Text>
                <View style={styles.answerRow}>
                  {(['confirmed', 'maybe', 'declined'] as const).map((s) => {
                    const active = me.status === s;
                    return (
                      <Pressable
                        key={s}
                        disabled={busy !== null}
                        onPress={() => run(`answer-${s}`, () => respondToHangout(plan.id, s))}
                        style={({ pressed }) => [
                          styles.answerBtn,
                          active && { backgroundColor: s === 'declined' ? colors.danger : accent, borderColor: 'transparent' },
                          pressed && { opacity: 0.8 },
                        ]}
                      >
                        {busy === `answer-${s}` ? (
                          <ActivityIndicator color={active ? colors.textInverse : colors.textMuted} />
                        ) : (
                          <Text style={[styles.answerText, active && { color: colors.textInverse }]}>
                            {STATUS_LABEL[s]}
                          </Text>
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}

            {/* People */}
            <View style={{ gap: space.sm }}>
              <Text style={styles.label}>
                People · {plan.participants.filter((p) => p.status === 'confirmed').length} going
              </Text>
              <View style={styles.card}>
                {plan.participants.map((p) => (
                  <View key={p.user_id} style={styles.personRow}>
                    <PersonAvatar id={p.user_id} name={personName(p)} size={32} />
                    <Text style={styles.personName} numberOfLines={1}>
                      {p.user_id === user?.id ? 'You' : personName(p)}
                      {p.user_id === plan.proposed_by ? <Text style={styles.host}>  host</Text> : null}
                    </Text>
                    <View style={[styles.pill, pillStyle(p.status)]}>
                      <Text style={[styles.pillText, pillTextStyle(p.status)]}>{STATUS_LABEL[p.status]}</Text>
                    </View>
                  </View>
                ))}
              </View>

              {plan.can_invite && !inviting ? (
                <Button label="+ Invite people" variant="secondary" onPress={openInvite} />
              ) : null}

              {inviting ? (
                <View style={styles.card}>
                  <Text style={styles.label}>Invite friends</Text>
                  {candidates === null ? (
                    <ActivityIndicator color={colors.accent} />
                  ) : candidates.length === 0 ? (
                    <Text style={styles.muted}>All your friends are already in this plan.</Text>
                  ) : (
                    candidates.map((c) => {
                      const on = picked.has(c.user_id);
                      return (
                        <Pressable
                          key={c.user_id}
                          disabled={!c.allowed}
                          onPress={() => {
                            const next = new Set(picked);
                            if (on) next.delete(c.user_id);
                            else next.add(c.user_id);
                            setPicked(next);
                          }}
                          style={[styles.personRow, !c.allowed && { opacity: 0.45 }]}
                        >
                          <PersonAvatar id={c.user_id} name={personName(c)} size={32} />
                          <View style={{ flex: 1 }}>
                            <Text style={styles.personName}>{personName(c)}</Text>
                            {!c.allowed && c.reason ? (
                              <Text style={styles.small}>{BLOCK_REASON[c.reason] ?? c.reason}</Text>
                            ) : null}
                          </View>
                          {c.allowed ? (
                            <Ionicons
                              name={on ? 'checkmark-circle' : 'ellipse-outline'}
                              size={22}
                              color={on ? accent : colors.textDim}
                            />
                          ) : null}
                        </Pressable>
                      );
                    })
                  )}
                  <View style={styles.answerRow}>
                    <Button
                      label="Not now"
                      variant="ghost"
                      onPress={() => setInviting(false)}
                      style={{ flex: 1 }}
                    />
                    <Button
                      label={picked.size > 0 ? `Invite ${picked.size}` : 'Invite'}
                      disabled={picked.size === 0}
                      loading={busy === 'invite'}
                      onPress={sendInvites}
                      style={{ flex: 1 }}
                    />
                  </View>
                </View>
              ) : null}
            </View>

            {/* Host: who can invite */}
            {plan.is_host && !isClosed ? (
              <View style={{ gap: space.sm }}>
                <Text style={styles.label}>Who can invite</Text>
                <View style={styles.segment}>
                  {(['host_only', 'participants', 'mutuals'] as InvitePolicy[]).map((p) => {
                    const active = plan.invite_policy === p;
                    return (
                      <Pressable
                        key={p}
                        disabled={busy !== null || active}
                        onPress={() => run(`policy-${p}`, () => setInvitePolicy(plan.id, p))}
                        style={[styles.segmentItem, active && { backgroundColor: colors.bgElevated }]}
                      >
                        <Text style={[styles.segmentText, active && { color: colors.text, fontWeight: '700' }]}>
                          {INVITE_POLICY_LABEL[p]}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={styles.small}>{POLICY_HINT[plan.invite_policy]}</Text>
              </View>
            ) : null}

            {plan.is_host && !isClosed ? (
              <Button label="Cancel plan" variant="ghost" onPress={cancelPlan} loading={busy === 'cancel'} />
            ) : null}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label = status === 'confirmed' ? "IT'S ON" : status === 'cancelled' ? 'CANCELLED' : 'WAITING ON ANSWERS';
  const color = status === 'confirmed' ? colors.success : status === 'cancelled' ? colors.danger : colors.warning;
  return <Text style={[styles.badge, { color }]}>{label}</Text>;
}

function InfoRow({
  icon,
  text,
  action,
  muted,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  action?: string;
  muted?: boolean;
}) {
  return (
    <View style={styles.infoRow}>
      <Ionicons name={icon} size={18} color={colors.textMuted} />
      <Text style={[styles.infoText, muted && styles.muted]}>{text}</Text>
      {action ? <Text style={styles.action}>{action}</Text> : null}
    </View>
  );
}

function pillStyle(s: ParticipantStatus) {
  if (s === 'confirmed') return { backgroundColor: `${colors.success}22` };
  if (s === 'declined') return { backgroundColor: `${colors.danger}1A` };
  return { backgroundColor: colors.bgRaised };
}
function pillTextStyle(s: ParticipantStatus) {
  if (s === 'confirmed') return { color: colors.success };
  if (s === 'declined') return { color: colors.danger };
  return { color: colors.textMuted };
}

function formatWhen(start: string | null, end: string | null): string {
  if (!start) return 'Time not set yet';
  const s = new Date(start);
  const day = s.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  const hm = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return end ? `${day} · ${hm(s)} – ${hm(new Date(end))}` : `${day} · ${hm(s)}`;
}

function openDirections(h: HangoutDetails): void {
  let url: string | null = null;
  if (typeof h.venue_lat === 'number' && typeof h.venue_lng === 'number') {
    url = `https://maps.google.com/?q=${h.venue_lat},${h.venue_lng}`;
  } else {
    const q = [h.venue_name, h.venue_address].filter(Boolean).join(' ').trim();
    if (q) url = `https://maps.google.com/?q=${encodeURIComponent(q)}`;
  }
  if (url) Linking.openURL(url).catch(() => {});
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.bg },
  band: { height: 6 },
  topBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: space.lg, paddingTop: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: space.lg, paddingTop: space.sm, gap: space.lg, paddingBottom: space.xxxl },
  title: { color: colors.text, fontSize: font.size.xxl, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  badge: { fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  card: { backgroundColor: colors.bgElevated, borderRadius: radius.lg, padding: space.md, gap: space.sm },
  label: { color: colors.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  infoText: { flex: 1, color: colors.text, fontSize: 15, lineHeight: 21 },
  action: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  reasoning: { color: colors.text, fontSize: 14, lineHeight: 20, fontStyle: 'italic' },
  answerRow: { flexDirection: 'row', gap: space.sm },
  answerBtn: {
    flex: 1,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgElevated,
  },
  answerText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 2 },
  personName: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '500' },
  host: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
  pill: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  pillText: { fontSize: 12, fontWeight: '600' },
  segment: { flexDirection: 'row', backgroundColor: colors.bgRaised, borderRadius: radius.md, padding: 3 },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.md - 2 },
  segmentText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  muted: { color: colors.textMuted, fontSize: 14 },
  small: { color: colors.textDim, fontSize: 12, lineHeight: 16 },
});
