import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AgentChangeSetCard } from '../../src/components/AgentChangeSetCard';
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
  const { seed } = useLocalSearchParams<{ seed?: string }>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState(typeof seed === 'string' ? seed : '');
  const [thinking, setThinking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const { byMessage: changeSetsByMessage } = useChangeSets();

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
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  const send = async () => {
    if (!user || !draft.trim() || thinking) return;
    const content = draft.trim();
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

  // Auto-scroll to bottom on new messages and after initial load
  useEffect(() => {
    if (messages.length > 0) {
      // Double rAF ensures the list has finished layout before scrolling
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          listRef.current?.scrollToEnd({ animated: messages.length > 1 });
        });
      });
    }
  }, [messages.length]);

  return (
    <Screen noPadding>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>ALINE</Text>
          <Text style={styles.subtitle}>Your personal agent</Text>
        </View>
      </View>

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
                onPromptDifferentTime={(s) => setDraft(s)}
              />
            )}
            ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
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
            placeholder="Talk to ALINE…"
            placeholderTextColor={colors.textDim}
            value={draft}
            onChangeText={setDraft}
            multiline
            onSubmitEditing={send}
          />
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

function Bubble({
  msg,
  changeSet,
  onPromptDifferentTime,
}: {
  msg: ChatMessage;
  changeSet?: PendingChangeSet;
  onPromptDifferentTime?: (s: string) => void;
}) {
  const isUser = msg.role === 'user';
  return (
    <View>
      <View style={[styles.row, isUser ? styles.rowRight : styles.rowLeft]}>
        <View
          style={[
            styles.bubble,
            isUser ? styles.bubbleUser : styles.bubbleAgent,
          ]}
        >
          <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
            {msg.content}
          </Text>
        </View>
      </View>
      {changeSet ? (
        <AgentChangeSetCard
          changeSet={changeSet}
          onPromptDifferentTime={onPromptDifferentTime}
        />
      ) : null}
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
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
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
