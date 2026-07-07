import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Speech from 'expo-speech';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AgentChangeSetCard } from '../../src/components/AgentChangeSetCard';
import { GoalPlanCard } from '../../src/components/GoalPlanCard';
import { useGoalPlans, commitGoalPlan, type LoadedPlan } from '../../src/lib/use-goal-plans';
import { DayStrip } from '../../src/components/DayStrip';
import { Screen } from '../../src/components/Screen';
import { useAuth } from '../../src/lib/auth-context';
import { supabase } from '../../src/lib/supabase';
import { useChangeSets, type PendingChangeSet } from '../../src/lib/use-change-sets';
import { useProfile } from '../../src/lib/use-profile';
import type { ChatMessage } from '../../src/types/database';
import { colors, font, radius, space } from '../../src/theme';

/**
 * Agent chat — full-screen conversation with ALINE.
 *
 * Flow:
 *   1. User types a message and hits send.
 *   2. We insert their message into `chat_messages` (so the row + id exist).
 *   3. We invoke the `agent-respond` edge function with that message id.
 *   4. The edge function loads context, calls Claude, and inserts the agent
 *      reply into `chat_messages` server-side.
 *   5. Our realtime subscription picks up the agent reply automatically.
 *
 * If the edge function fails (no API key, network, etc.) we surface a
 * recoverable inline error so the user knows something went wrong.
 */
export default function AgentScreen() {
  const { user } = useAuth();
  const { profile } = useProfile();
  const { seed, focus } = useLocalSearchParams<{ seed?: string; focus?: string }>();
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Id of a message to scroll to + briefly highlight (set when the user taps a
  // proactive notification that deep-links to its chat message).
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const focusHandledRef = useRef(false);
  const [draft, setDraft] = useState(typeof seed === 'string' ? seed : '');
  const [thinking, setThinking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const { byMessage: changeSetsByMessage } = useChangeSets();
  const { byId: plansById } = useGoalPlans();
  const [listening, setListening] = useState(false);
  // When the user spoke their message, speak the reply back (voice in → voice
  // out). A ref so the realtime handler (stable closure) reads the live value.
  const voiceReplyRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    supabase
      .from('chat_messages')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(200)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.warn('Chat load failed:', error.message);
        setMessages(data ?? []);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Subscribe to realtime inserts so agent replies appear automatically when
  // the `agent-respond` edge function writes them server-side.
  // Per-instance channel name avoids "cannot add postgres_changes after
  // subscribe()" race when this effect re-runs.
  useEffect(() => {
    if (!user?.id) return;
    const userId = user.id;
    const channel = supabase
      .channel(`chat-${userId}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const msg = payload.new as ChatMessage;
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
          // Voice in → voice out: speak the agent's reply only if the last
          // message was spoken. Typed conversations stay silent.
          if (msg.role === 'agent' && voiceReplyRef.current) {
            voiceReplyRef.current = false;
            Speech.stop();
            Speech.speak(msg.content, { rate: 1.0 });
          }
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  const send = () => sendText(draft, false);

  const sendText = async (raw: string, fromVoice: boolean) => {
    if (!user || !raw.trim() || thinking) return;
    const content = raw.trim();
    voiceReplyRef.current = fromVoice;
    setDraft('');
    setError(null);

    // 1) Persist the user's message and show it immediately.
    const { data: inserted, error: insertErr } = await supabase
      .from('chat_messages')
      .insert({
        user_id: user.id,
        role: 'user',
        content,
      })
      .select('*')
      .single();
    if (insertErr || !inserted) {
      console.warn('Send failed:', insertErr?.message);
      setError('Could not send message. Try again.');
      return;
    }
    setMessages((prev) =>
      prev.some((m) => m.id === inserted.id) ? prev : [...prev, inserted]
    );

    // 2) Ask the agent. The edge function inserts the reply server-side;
    //    realtime subscription will deliver it.
    setThinking(true);
    try {
      const { error: fnError } = await supabase.functions.invoke('agent-respond', {
        body: { user_message_id: inserted.id },
      });
      if (fnError) {
        console.warn('agent-respond failed:', fnError);
        setError(
          'Your agent is offline right now. Check that ANTHROPIC_API_KEY is set in Supabase secrets.'
        );
      }
    } catch (e) {
      console.warn('agent-respond threw:', e);
      setError('Network issue talking to the agent.');
    } finally {
      setThinking(false);
    }
  };

  // ---- Voice input (on-device STT) ----
  useSpeechRecognitionEvent('result', (e) => {
    const t = e.results?.[0]?.transcript ?? '';
    if (t) setDraft(t);
    if (e.isFinal && t.trim()) {
      setListening(false);
      sendText(t, true);
    }
  });
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('error', (e) => {
    setListening(false);
    console.warn('speech recognition error:', e?.error);
  });

  // Stop any voice activity when leaving the screen.
  useEffect(() => {
    return () => {
      Speech.stop();
      try { ExpoSpeechRecognitionModule.stop(); } catch {}
    };
  }, []);

  const toggleMic = useCallback(async () => {
    if (listening) {
      ExpoSpeechRecognitionModule.stop();
      setListening(false);
      return;
    }
    Speech.stop(); // don't listen over our own voice
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      setError('Allow microphone & speech recognition in Settings to talk to ALINE.');
      return;
    }
    setError(null);
    setDraft('');
    setListening(true);
    ExpoSpeechRecognitionModule.start({
      lang: 'en-US',
      interimResults: true,
      continuous: false,
    });
  }, [listening]);

  // Auto-scroll to bottom on new messages and after initial load — unless we
  // have a pending notification focus to honor (handled by the effect below).
  useEffect(() => {
    const focusPending = !!focus && !focusHandledRef.current;
    if (messages.length > 0 && !focusPending) {
      // Double rAF ensures the list has finished layout before scrolling
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          listRef.current?.scrollToEnd({ animated: messages.length > 1 });
        });
      });
    }
  }, [messages.length, focus]);

  // Notification deep-link: scroll to the focused message and pulse a
  // highlight. Waits for the message to be present (it may arrive via realtime
  // a beat after navigation). Handled once per focus value.
  useEffect(() => {
    if (!focus || focusHandledRef.current) return;
    const idx = messages.findIndex((m) => m.id === focus);
    if (idx < 0) return; // not loaded yet — retry when messages update
    focusHandledRef.current = true;
    setHighlightId(focus);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          listRef.current?.scrollToIndex({ index: idx, viewPosition: 0.5, animated: true });
        } catch {
          listRef.current?.scrollToEnd({ animated: true });
        }
      });
    });
    const t = setTimeout(() => setHighlightId(null), 2200);
    return () => clearTimeout(t);
  }, [focus, messages]);

  return (
    <Screen noPadding>
      <View style={styles.header}>
        <Text style={styles.title}>ALINE</Text>
        <View style={{ flexDirection: 'row', gap: space.xs }}>
          <Pressable
            onPress={() => router.push('/(app)/events')}
            hitSlop={10}
            style={({ pressed }) => [styles.goalsBtn, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Events"
          >
            <Text style={styles.goalsBtnText}>◈ Events</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/(app)/goals')}
            hitSlop={10}
            style={({ pressed }) => [styles.goalsBtn, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Goals"
          >
            <Text style={styles.goalsBtnText}>◎ Goals</Text>
          </Pressable>
        </View>
      </View>
      <DayStrip />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={80}
        style={styles.kav}
      >
        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : messages.length === 0 ? (
          <EmptyAgentState firstName={profile?.first_name ?? null} />
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.messages}
            renderItem={({ item }) => (
              <Bubble
                msg={item}
                changeSet={changeSetsByMessage[item.id]}
                plan={item.goal_plan_id ? plansById[item.goal_plan_id] : undefined}
                highlighted={item.id === highlightId}
                onPromptDifferentTime={(s) => setDraft(s)}
              />
            )}
            ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
            onContentSizeChange={() => {
              if (!highlightId) listRef.current?.scrollToEnd({ animated: false });
            }}
            onLayout={() => {
              if (!highlightId) listRef.current?.scrollToEnd({ animated: false });
            }}
            onScrollToIndexFailed={() => {
              listRef.current?.scrollToEnd({ animated: true });
            }}
          />
        )}

        {error ? (
          <Pressable
            style={styles.errorRow}
            onPress={() => setError(null)}
            hitSlop={8}
          >
            <Text style={styles.errorText}>{error}</Text>
            <Text style={styles.errorDismiss}>Tap to dismiss</Text>
          </Pressable>
        ) : null}

        {thinking ? (
          <View style={styles.thinkingRow}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.thinkingText}>ALINE is thinking…</Text>
          </View>
        ) : null}

        <View style={styles.composer}>
          <TextInput
            style={styles.composerInput}
            placeholder={listening ? 'Listening…' : 'Talk to ALINE…'}
            placeholderTextColor={colors.textDim}
            value={draft}
            onChangeText={setDraft}
            multiline
            onSubmitEditing={send}
          />
          <Pressable
            onPress={toggleMic}
            disabled={thinking}
            style={({ pressed }) => [
              styles.micBtn,
              listening && styles.micBtnActive,
              pressed && { opacity: 0.8 },
            ]}
          >
            <Text style={styles.micBtnText}>{listening ? '◼' : '🎤'}</Text>
          </Pressable>
          <Pressable
            onPress={send}
            disabled={!draft.trim() || thinking}
            style={({ pressed }) => [
              styles.sendBtn,
              (!draft.trim() || thinking) && styles.sendBtnDisabled,
              pressed && { opacity: 0.8 },
            ]}
          >
            <Text style={styles.sendBtnText}>↑</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** Short local clock (HH:MM, 24h) for a chat message timestamp. */
function shortClock(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '';
  }
}

/** Header label per proactive-push kind. */
const PROACTIVE_LABEL: Record<string, string> = {
  weather: 'Heads up',
  live_status: 'Heads up',
  reminder: 'Reminder',
  leave_by: 'Time to head out',
  hangout_soon: 'Coming up',
  rsvp_nudge: 'Waiting on you',
  goal_pacing: 'Weekly goals',
  morning: 'Good morning',
};

/**
 * Render the agent's lightweight markdown (bold + links) into Text children.
 * Markdown links [label](url) and bare URLs become tappable; **x** becomes bold.
 * Wrapped by a `selectable` Text in Bubble so everything is copyable.
 */
function renderRich(content: string, isUser: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  const linkColor = isUser ? colors.textInverse : colors.accent;
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  const openUrl = (url: string) => { Linking.openURL(url).catch(() => {}); };
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) nodes.push(content.slice(last, m.index));
    if (m[1] !== undefined) {
      const url = m[2];
      nodes.push(
        <Text key={key++} style={[styles.link, { color: linkColor }]} onPress={() => openUrl(url)}>
          {m[1]}
        </Text>,
      );
    } else if (m[3] !== undefined) {
      nodes.push(<Text key={key++} style={styles.boldText}>{m[3]}</Text>);
    } else if (m[4] !== undefined) {
      const url = m[4];
      nodes.push(
        <Text key={key++} style={[styles.link, { color: linkColor }]} onPress={() => openUrl(url)}>
          {url}
        </Text>,
      );
    }
    last = re.lastIndex;
  }
  if (last < content.length) nodes.push(content.slice(last));
  return nodes;
}

function Bubble({
  msg,
  changeSet,
  plan,
  highlighted,
  onPromptDifferentTime,
}: {
  msg: ChatMessage;
  changeSet?: PendingChangeSet;
  plan?: LoadedPlan;
  highlighted?: boolean;
  onPromptDifferentTime?: (s: string) => void;
}) {
  const isUser = msg.role === 'user';
  const planCard = plan ? (
    <View style={styles.planWrap}>
      <GoalPlanCard
        title={plan.goalTitle}
        status={plan.status}
        spec={plan.spec}
        onRefine={() => onPromptDifferentTime?.(`Let's tweak my "${plan.goalTitle}" plan: `)}
        onCommit={async () => {
          const wasLive = plan.status === 'live';
          const res = await commitGoalPlan(plan.goal_id);
          if ('error' in res) {
            Alert.alert("Couldn't add to schedule", res.error);
            return;
          }
          const skipNote = res.skipped > 0 ? ` (${res.skipped} skipped — clashed)` : '';
          Alert.alert(
            wasLive ? 'Plan re-synced' : 'Added to your schedule',
            `${res.created} session${res.created === 1 ? '' : 's'} placed over the next 2 weeks${skipNote}.`,
          );
        }}
      />
    </View>
  ) : null;
  const ed = (msg.extracted_data ?? null) as
    | { proactive?: boolean; kind?: string }
    | null;
  const isProactive = !isUser && ed?.proactive === true;

  // Proactive notifications render as a distinct card (accent rail + header)
  // so a nudge reads as a nudge, not a reply.
  if (isProactive) {
    const label = PROACTIVE_LABEL[ed?.kind ?? ''] ?? 'Heads up';
    const time = shortClock(msg.created_at);
    return (
      <View>
        <View style={styles.rowLeft}>
          <View style={[styles.proactiveCard, highlighted && styles.cardHighlight]}>
            <View style={styles.proactiveHeader}>
              <Text style={styles.proactiveLabel}>{label}</Text>
              {time ? <Text style={styles.proactiveTime}>{time}</Text> : null}
            </View>
            <Text selectable style={styles.bubbleText}>{renderRich(msg.content, false)}</Text>
          </View>
        </View>
        {changeSet ? (
          <AgentChangeSetCard
            changeSet={changeSet}
            onPromptDifferentTime={onPromptDifferentTime}
          />
        ) : null}
        {planCard}
      </View>
    );
  }

  return (
    <View>
      <View style={[styles.row, isUser ? styles.rowRight : styles.rowLeft]}>
        <View
          style={[
            styles.bubble,
            isUser ? styles.bubbleUser : styles.bubbleAgent,
            highlighted && styles.cardHighlight,
          ]}
        >
          <Text selectable style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
            {renderRich(msg.content, isUser)}
          </Text>
        </View>
      </View>
      {changeSet ? (
        <AgentChangeSetCard
          changeSet={changeSet}
          onPromptDifferentTime={onPromptDifferentTime}
        />
      ) : null}
      {planCard}
    </View>
  );
}

function EmptyAgentState({ firstName }: { firstName: string | null }) {
  const greeting = firstName ? `Hey ${firstName}.` : 'Hey there.';
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyMark}>✦</Text>
      <Text style={styles.emptyTitle}>{greeting}</Text>
      <Text style={styles.emptyBody}>
        I'm ALINE — your personal agent. Tell me what's going on, or talk like
        you would to a friend who actually pays attention. I'll learn the
        rhythms of your week and start coordinating with the people in your
        life.
      </Text>
      <View style={styles.suggestionList}>
        <SuggestionChip text='"What does my Tuesday look like?"' />
        <SuggestionChip text='"Schedule a 1-hour run tomorrow morning"' />
        <SuggestionChip text='"Plan dinner with the crew this week"' />
      </View>
    </View>
  );
}

function SuggestionChip({ text }: { text: string }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText}>{text}</Text>
    </View>
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
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: font.size.xxl,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: 1,
  },
  goalsBtn: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  goalsBtnText: {
    color: colors.accent,
    fontSize: font.size.sm,
    fontWeight: '600',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  planWrap: { marginTop: space.sm },
  kav: { flex: 1 },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messages: { padding: space.lg, paddingBottom: space.xl },
  row: { flexDirection: 'row' },
  rowLeft: { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.lg,
  },
  bubbleAgent: {
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopLeftRadius: 4,
  },
  bubbleUser: {
    backgroundColor: colors.accent,
    borderTopRightRadius: 4,
  },
  bubbleText: { color: colors.text, fontSize: 15, lineHeight: 22 },
  bubbleTextUser: { color: colors.textInverse },
  boldText: { fontWeight: '700' },
  link: { textDecorationLine: 'underline' },
  proactiveCard: {
    maxWidth: '88%',
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.lg,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    gap: 4,
  },
  proactiveHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  proactiveLabel: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  proactiveTime: {
    color: colors.textDim,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  cardHighlight: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(94, 234, 212, 0.12)',
  },
  thinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  thinkingText: { color: colors.textMuted, fontSize: 13, fontStyle: 'italic' },
  errorRow: {
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    padding: space.md,
    backgroundColor: 'rgba(248, 113, 113, 0.1)',
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
    gap: 4,
  },
  errorText: { color: colors.danger, fontSize: 13, fontWeight: '500' },
  errorDismiss: { color: colors.textDim, fontSize: 11 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: space.md,
    paddingTop: 10,
    paddingBottom: 10,
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micBtnActive: {
    backgroundColor: colors.danger,
    borderColor: colors.danger,
  },
  micBtnText: { fontSize: 16 },
  sendBtnDisabled: { backgroundColor: colors.bgRaised },
  sendBtnText: {
    color: colors.textInverse,
    fontSize: 18,
    fontWeight: '700',
    marginTop: -2,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.sm,
  },
  emptyMark: { fontSize: 48, color: colors.accent, marginBottom: space.sm },
  emptyTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
  emptyBody: {
    color: colors.textMuted,
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 20,
    maxWidth: 320,
  },
  suggestionList: { gap: space.xs, marginTop: space.lg, alignItems: 'center' },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipText: { color: colors.textMuted, fontSize: 13, fontStyle: 'italic' },
});
