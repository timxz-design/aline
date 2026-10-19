import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as Speech from 'expo-speech';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { decode as decodeBase64 } from 'base64-arraybuffer';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
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
import { ChatHistorySheet } from '../../src/components/ChatHistorySheet';
import { GoalPlanCard } from '../../src/components/GoalPlanCard';
import { ImageViewer } from '../../src/components/ImageViewer';
import { EventCard } from '../../src/components/EventCard';
import { useLocalEvents } from '../../src/lib/use-local-events';
import type { LocalEvent } from '../../src/types/database';
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
  // A session is one local day: the chat shows today only (empty on a new day).
  // Earlier days live in the History sheet, grouped by date — never inline.
  // The agent's context is the same day.
  const sessionStartIdx = useMemo(() => {
    const today = new Date().toDateString();
    const i = messages.findIndex((m) => new Date(m.created_at ?? 0).toDateString() === today);
    return i < 0 ? messages.length : i;
  }, [messages]);
  const visibleMessages = useMemo(() => messages.slice(sessionStartIdx), [messages, sessionStartIdx]);
  const earlierMessages = useMemo(() => messages.slice(0, sessionStartIdx), [messages, sessionStartIdx]);
  // Rendered by an INVERTED FlatList (the standard chat pattern): offset 0 is
  // the bottom, so the list rests on the newest message by itself. No more
  // scrollToEnd on every content/layout change — that fought the user's finger
  // (twitching) and landed short of the end when rows weren't measured yet.
  const listData = useMemo(() => [...visibleMessages].reverse(), [visibleMessages]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyDay, setHistoryDay] = useState<string | null>(null);
  const { byMessage: changeSetsByMessage } = useChangeSets();
  const { byId: plansById } = useGoalPlans();
  const chatEventIds = useMemo(
    () => [...new Set(messages.flatMap((m) => m.event_ids ?? []))],
    [messages],
  );
  const { byId: eventsById, goingMap, refresh: refreshEvents } = useLocalEvents(chatEventIds);
  // Stable per-message event lists so memoised bubbles don't re-render on
  // every keystroke in the composer.
  const eventsByMessage = useMemo(() => {
    const out: Record<string, LocalEvent[]> = {};
    for (const m of messages) {
      if (m.event_ids?.length) out[m.id] = m.event_ids.map((id) => eventsById[id]).filter(Boolean);
    }
    return out;
  }, [messages, eventsById]);
  const [listening, setListening] = useState(false);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  // When the user spoke their message, speak the reply back (voice in → voice
  // out). A ref so the realtime handler (stable closure) reads the live value.
  const voiceReplyRef = useRef(false);
  // Synchronous send lock: `thinking` is state, so it's still false for the
  // awaits between tapping send and the agent call — a second tap or a repeated
  // voice "final" result slipped through and sent the message twice.
  const sendingRef = useRef(false);
  const lastSentRef = useRef<{ text: string; at: number } | null>(null);

  // Initial history load. NEWEST 200 reversed for display — ascending+limit
  // returns the OLDEST rows, which silently freezes the chat once history
  // passes 200. Explicit columns skip the context_snapshot debug payload.
  // The catch matters: a network hiccup here used to reject unhandled and
  // leave the spinner up forever ("chat not loading") — now it surfaces a
  // tap-to-retry instead.
  const loadChat = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      const { data, error: qErr } = await supabase
        .from('chat_messages')
        .select('id, user_id, role, content, created_at, image_url, goal_plan_id, event_ids, extracted_data, model, input_tokens, output_tokens')
        .eq('user_id', user.id)
        // History reaches back one week; the server keeps raw chat 30 days.
        .gte('created_at', new Date(Date.now() - 7 * 86_400_000).toISOString())
        .order('created_at', { ascending: false })
        .limit(300);
      if (qErr) throw new Error(qErr.message);
      setMessages(((data ?? []) as ChatMessage[]).reverse());
    } catch (e) {
      console.warn('Chat load failed:', e);
      setError('Could not load the conversation — tap here to retry.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadChat();
  }, [loadChat]);

  // Merge incoming rows (realtime or catch-up), and speak an agent reply if
  // the user's last message was spoken.
  const addIncoming = useCallback((rows: ChatMessage[]) => {
    if (rows.length === 0) return;
    setMessages((prev) => {
      const known = new Set(prev.map((m) => m.id));
      const fresh = rows.filter((m) => !known.has(m.id));
      if (fresh.length === 0) return prev;
      return [...prev, ...fresh].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
    });
    // Voice in → voice out: speak the agent's reply only if the last
    // message was spoken. Typed conversations stay silent.
    const reply = rows.find((m) => m.role === 'agent');
    if (reply && voiceReplyRef.current) {
      voiceReplyRef.current = false;
      Speech.stop();
      Speech.speak(reply.content, { rate: 1.0 });
    }
  }, []);

  // Realtime alone isn't enough: when its socket has dropped (app was in the
  // background) a reply is saved but never delivered — "it did it but didn't
  // answer". Catch up straight from the table after each agent call and on
  // every return to the foreground.
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const catchUp = useCallback(async () => {
    if (!user) return;
    const last = messagesRef.current[messagesRef.current.length - 1]?.created_at;
    const since = last ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data } = await supabase
      .from('chat_messages')
      .select('id, user_id, role, content, created_at, image_url, goal_plan_id, event_ids, extracted_data, model, input_tokens, output_tokens')
      .eq('user_id', user.id)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(50);
    addIncoming((data ?? []) as ChatMessage[]);
  }, [user, addIncoming]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') catchUp();
    });
    return () => sub.remove();
  }, [catchUp]);

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
        (payload) => addIncoming([payload.new as ChatMessage]),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, addIncoming]);

  // A dictated message gets a spoken reply (voice in → voice out).
  const send = () => {
    const fromVoice = dictatedRef.current;
    dictatedRef.current = false;
    if (listening) {
      try { ExpoSpeechRecognitionModule.stop(); } catch {}
      setListening(false);
    }
    sendText(draft, fromVoice);
  };

  // Photo → chat: snap a poster (or pick a screenshot), it uploads to storage
  // and rides the message; the agent reads it server-side (vision) and can
  // save_event straight from it.
  const attachImage = () => {
    if (!user || thinking) return;
    const pick = async (fromCamera: boolean) => {
      const perm = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('No access', 'Allow access in Settings to share posters with ALINE.');
        return;
      }
      const res = fromCamera
        ? await ImagePicker.launchCameraAsync({ quality: 0.5 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.5 });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      await sendText(draft, false, res.assets[0].uri);
    };
    Alert.alert('Add a photo', 'An event poster, flyer, or screenshot — ALINE reads the details.', [
      { text: 'Take photo', onPress: () => pick(true) },
      { text: 'Choose from library', onPress: () => pick(false) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const uploadChatImage = async (uri: string): Promise<string | null> => {
    if (!user) return null;
    try {
      const b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      const path = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error: upErr } = await supabase.storage
        .from('chat-images')
        .upload(path, decodeBase64(b64), { contentType: 'image/jpeg' });
      if (upErr) {
        console.warn('image upload failed:', upErr.message);
        return null;
      }
      return supabase.storage.from('chat-images').getPublicUrl(path).data.publicUrl;
    } catch (e) {
      console.warn('image read failed:', e);
      return null;
    }
  };

  const sendText = async (raw: string, fromVoice: boolean, imageUri?: string) => {
    if (!user || thinking || sendingRef.current) return;
    const content = raw.trim();
    if (!content && !imageUri) return;
    // Same text again within 30s is a duplicate (double tap / repeated voice
    // result), not a new message.
    const last = lastSentRef.current;
    if (!imageUri && last && last.text === content && Date.now() - last.at < 30_000) return;
    sendingRef.current = true;
    try {
      await sendTextUnlocked(raw, content, fromVoice, imageUri);
    } finally {
      sendingRef.current = false;
    }
  };

  const sendTextUnlocked = async (raw: string, content: string, fromVoice: boolean, imageUri?: string) => {
    if (!user) return;
    voiceReplyRef.current = fromVoice;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setDraft('');
    setError(null);

    // 0) Upload the image first (if any) so the message row carries its URL.
    let imageUrl: string | null = null;
    if (imageUri) {
      setThinking(true);
      imageUrl = await uploadChatImage(imageUri);
      setThinking(false);
      if (!imageUrl) {
        setError('Could not upload the photo. Try again.');
        setDraft(raw);
        return;
      }
    }

    // 1) Persist the user's message and show it immediately.
    const { data: inserted, error: insertErr } = await supabase
      .from('chat_messages')
      .insert({
        user_id: user.id,
        role: 'user',
        content: content || '📷',
        image_url: imageUrl,
      })
      .select('*')
      .single();
    if (insertErr || !inserted) {
      console.warn('Send failed:', insertErr?.message);
      setError('Could not send message. Try again.');
      return;
    }
    lastSentRef.current = { text: content, at: Date.now() };
    setMessages((prev) =>
      prev.some((m) => m.id === inserted.id) ? prev : [...prev, inserted]
    );
    // Your own message always brings you down (offset 0 = bottom, inverted).
    requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));

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
      // The reply is in the table by the time the call returns; don't rely on
      // realtime to have delivered it.
      await catchUp().catch(() => {});
      setThinking(false);
    }
  };

  // ---- Voice input (on-device STT) ----
  // Dictation, not auto-send: recognition keeps listening through pauses until
  // the mic is tapped again, and the transcript lands in the composer so a
  // misheard word or a half-finished thought can be fixed before sending.
  // (Auto-sending on iOS's end-of-phrase cut people off mid-sentence.)
  const dictationPrefixRef = useRef('');
  const dictatedRef = useRef(false);
  useSpeechRecognitionEvent('result', (e) => {
    const t = e.results?.[0]?.transcript ?? '';
    if (!t) return;
    dictatedRef.current = true;
    const prefix = dictationPrefixRef.current;
    setDraft(prefix ? `${prefix} ${t}` : t);
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
    // Keep anything already typed; dictation appends to it.
    dictationPrefixRef.current = draft.trim();
    setListening(true);
    ExpoSpeechRecognitionModule.start({
      lang: 'en-US',
      interimResults: true,
      continuous: true, // pauses don't end it — the mic button does
    });
  }, [listening, draft]);

  // Notification deep-link: scroll to the focused message and pulse a
  // highlight. Waits for the message to be present (it may arrive via realtime
  // a beat after navigation). Handled once per focus value.
  useEffect(() => {
    if (!focus || focusHandledRef.current) return;
    const fullIdx = messages.findIndex((m) => m.id === focus);
    if (fullIdx < 0) return; // not loaded yet — retry when messages update
    if (fullIdx < sessionStartIdx) {
      // Focused message is from an earlier day: open that day in History.
      focusHandledRef.current = true;
      setHistoryDay(new Date(messages[fullIdx].created_at ?? 0).toDateString());
      setHistoryOpen(true);
      return;
    }
    // Index in the inverted list (newest first).
    const idx = messages.length - 1 - fullIdx;
    focusHandledRef.current = true;
    setHighlightId(focus);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          listRef.current?.scrollToIndex({ index: idx, viewPosition: 0.5, animated: true });
        } catch {
          // stay at the bottom
        }
      });
    });
  }, [focus, messages, sessionStartIdx]);

  // Clear the highlight on its own timer. It used to live in the effect above,
  // whose cleanup ran on every new message — so replying within 2s left the
  // highlight (and the paused auto-scroll) stuck, and the scrolls fought.
  useEffect(() => {
    if (!highlightId) return;
    const t = setTimeout(() => setHighlightId(null), 2200);
    return () => clearTimeout(t);
  }, [highlightId]);

  return (
    <Screen noPadding>
      <ChatHistorySheet
        visible={historyOpen}
        messages={earlierMessages}
        openDayKey={historyDay}
        onOpenDay={setHistoryDay}
        onClose={() => setHistoryOpen(false)}
        renderMessage={(item) => (
          <Bubble
            msg={item}
            changeSet={changeSetsByMessage[item.id]}
            plan={item.goal_plan_id ? plansById[item.goal_plan_id] : undefined}
            highlighted={item.id === focus}
            // no onImagePress: iOS can't present the image viewer over this sheet
            events={eventsByMessage[item.id]}
            goingMap={goingMap}
            userId={user?.id ?? null}
            onEventChanged={refreshEvents}
          />
        )}
      />
      <View style={styles.header}>
        <Text style={styles.title}>ALINE</Text>
        <View style={{ flexDirection: 'row', gap: space.xs }}>
          <Pressable
            onPress={() => {
              setHistoryDay(null);
              setHistoryOpen(true);
            }}
            hitSlop={10}
            style={({ pressed }) => [styles.goalsBtn, styles.iconBtn, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Past conversations"
          >
            <Ionicons name="time-outline" size={16} color={colors.accent} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/(app)/events')}
            hitSlop={10}
            style={({ pressed }) => [styles.goalsBtn, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Events"
          >
            <Ionicons name="compass-outline" size={14} color={colors.accent} />
            <Text style={styles.goalsBtnText}>Events</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/(app)/goals')}
            hitSlop={10}
            style={({ pressed }) => [styles.goalsBtn, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Goals"
          >
            <Ionicons name="flag-outline" size={14} color={colors.accent} />
            <Text style={styles.goalsBtnText}>Goals</Text>
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
        ) : visibleMessages.length === 0 ? (
          <EmptyAgentState firstName={profile?.first_name ?? null} />
        ) : (
          <FlatList
            ref={listRef}
            inverted
            data={listData}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.messages}
            renderItem={({ item }) => (
              <Bubble
                msg={item}
                changeSet={changeSetsByMessage[item.id]}
                plan={item.goal_plan_id ? plansById[item.goal_plan_id] : undefined}
                highlighted={item.id === highlightId}
                onPromptDifferentTime={setDraft}
                onImagePress={setViewerUri}
                events={eventsByMessage[item.id]}
                goingMap={goingMap}
                userId={user?.id ?? null}
                onEventChanged={refreshEvents}
              />
            )}
            ItemSeparatorComponent={Separator}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            // New messages keep you at the bottom when you're there; when you've
            // scrolled up to read, they arrive without moving what you're reading.
            maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}
            onScrollToIndexFailed={(info) => {
              listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true });
            }}
          />
        )}

        {error ? (
          <Pressable
            style={styles.errorRow}
            onPress={() => {
              // Load failures retry; send failures just dismiss.
              if (messages.length === 0) {
                setLoading(true);
                loadChat();
              } else {
                setError(null);
              }
            }}
            hitSlop={8}
          >
            <Text style={styles.errorText}>{error}</Text>
            <Text style={styles.errorDismiss}>
              {messages.length === 0 ? 'Tap to retry' : 'Tap to dismiss'}
            </Text>
          </Pressable>
        ) : null}

        {thinking ? (
          <View style={styles.thinkingRow}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.thinkingText}>ALINE is thinking…</Text>
          </View>
        ) : null}

        <View style={styles.composer}>
          <Pressable
            onPress={attachImage}
            disabled={thinking}
            hitSlop={6}
            style={({ pressed }) => [styles.micBtn, pressed && { opacity: 0.8 }]}
            accessibilityLabel="Add a photo"
          >
            <Ionicons name="camera-outline" size={20} color={colors.textMuted} />
          </Pressable>
          <TextInput
            style={styles.composerInput}
            placeholder={listening ? 'Listening…' : 'Talk to ALINE…'}
            placeholderTextColor={colors.textDim}
            value={draft}
            onChangeText={(t) => {
              if (!t) dictatedRef.current = false; // cleared → it's a typed message now
              setDraft(t);
            }}
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
            <Ionicons name={listening ? 'stop' : 'mic-outline'} size={20} color={listening ? colors.accent : colors.textMuted} />
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
            <Ionicons name="arrow-up" size={18} color={colors.textInverse} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <ImageViewer uri={viewerUri} onClose={() => setViewerUri(null)} />
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
  workout_start: 'Session starting',
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

function Separator() {
  return <View style={{ height: space.sm }} />;
}

const Bubble = memo(function Bubble({
  msg,
  changeSet,
  plan,
  highlighted,
  onPromptDifferentTime,
  onImagePress,
  events,
  goingMap,
  userId,
  onEventChanged,
}: {
  msg: ChatMessage;
  changeSet?: PendingChangeSet;
  plan?: LoadedPlan;
  highlighted?: boolean;
  onPromptDifferentTime?: (s: string) => void;
  onImagePress?: (uri: string) => void;
  events?: LocalEvent[];
  goingMap?: Record<string, string>;
  userId?: string | null;
  onEventChanged?: () => void;
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
  const eventCards = events && events.length > 0 && userId ? (
    <View style={styles.eventCardsWrap}>
      {events.map((e) => (
        <EventCard
          key={e.id}
          event={e}
          userId={userId}
          going={!!goingMap?.[e.id]}
          onChanged={() => onEventChanged?.()}
          onImagePress={onImagePress}
          onSeedAgent={onPromptDifferentTime}
        />
      ))}
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
        {eventCards}
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
          {msg.image_url ? (
            <Pressable onPress={() => onImagePress?.(msg.image_url!)} accessibilityLabel="View photo full screen">
              <Image source={{ uri: msg.image_url }} style={styles.bubbleImage} resizeMode="cover" />
            </Pressable>
          ) : null}
          {/* Hide the bare 📷 placeholder when the image itself is shown. */}
          {!(msg.image_url && msg.content === '📷') ? (
            <Text selectable style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
              {renderRich(msg.content, isUser)}
            </Text>
          ) : null}
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
});

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
  iconBtn: { paddingHorizontal: 9 },
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.bgElevated,
  },
  goalsBtnText: {
    color: colors.accent,
    fontSize: font.size.sm,
    fontWeight: '600',
  },
  planWrap: { marginTop: space.sm },
  kav: { flex: 1 },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // Inverted list: paddingTop renders at the visual bottom, above the composer.
  messages: { padding: space.lg, paddingTop: space.xl },
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
  eventCardsWrap: { gap: space.sm, marginTop: space.sm },
  bubbleImage: {
    width: 220,
    height: 280,
    borderRadius: radius.md,
    marginBottom: 4,
    backgroundColor: colors.bgRaised,
  },
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
