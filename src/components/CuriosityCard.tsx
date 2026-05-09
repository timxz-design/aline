/**
 * CuriosityCard — the agent's first proactive moment.
 *
 * Shown at the top of the Week tab when ALINE has an unconfirmed inference
 * (a place it's seen ≥5 times, or a routine with ≥50% consistency, neither
 * yet confirmed by the user). Three paths:
 *
 *   - Yes        → confirmCuriosityItem
 *   - Actually…  → opens text input → correctPlaceLabel
 *   - Not really → rejectCuriosityItem (hides place / deactivates routine)
 *
 * After any action, we trigger `onAnswered` so the parent can refetch.
 * The card disappears, and the next pending item (if any) comes up.
 *
 * Trust principle in code: this is the agent saying "I'm guessing — am I right?"
 * rather than "I've decided." Every inference is up for negotiation.
 */

import { useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  CuriosityItem,
  confirmCuriosityItem,
  correctPlaceLabel,
  rejectCuriosityItem,
  snoozeCuriosityItem,
} from '../lib/use-curiosity';
import { colors, font, radius, space } from '../theme';

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatMinute(m: number | null | undefined): string {
  if (m == null) return '?';
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function relTime(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString();
}

export function CuriosityCard({
  item,
  onAnswered,
}: {
  item: CuriosityItem;
  onAnswered: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const question = buildQuestion(item);

  const onYes = async () => {
    setBusy(true);
    const r = await confirmCuriosityItem(item.kind, item.id);
    setBusy(false);
    if (r.error) Alert.alert('Failed', r.error);
    else onAnswered();
  };

  const onCorrect = async () => {
    if (item.kind !== 'place') return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    setBusy(true);
    const r = await correctPlaceLabel(item.id, trimmed);
    setBusy(false);
    if (r.error) Alert.alert('Failed', r.error);
    else {
      setEditing(false);
      setDraft('');
      onAnswered();
    }
  };

  const onReject = async () => {
    setBusy(true);
    const r = await rejectCuriosityItem(item.kind, item.id);
    setBusy(false);
    if (r.error) Alert.alert('Failed', r.error);
    else onAnswered();
  };

  const onSnooze = async () => {
    setBusy(true);
    await snoozeCuriosityItem(item.kind, item.id);
    setBusy(false);
    onAnswered();
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>ALINE is curious</Text>
        <Pressable onPress={onSnooze} hitSlop={8} disabled={busy}>
          <Text style={styles.snoozeText}>Later</Text>
        </Pressable>
      </View>

      <Text style={styles.question}>{question.text}</Text>

      {question.subtitle ? (
        <Text style={styles.subtitle}>{question.subtitle}</Text>
      ) : null}

      {editing ? (
        <View style={{ gap: space.sm }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="What is it actually?"
            placeholderTextColor={colors.textDim}
            style={styles.input}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={onCorrect}
            editable={!busy}
          />
          <View style={styles.buttonRow}>
            <Pressable
              onPress={onCorrect}
              disabled={busy || !draft.trim()}
              style={[styles.btn, styles.btnPrimary]}
            >
              <Text style={styles.btnPrimaryText}>Save</Text>
            </Pressable>
            <Pressable
              onPress={() => { setEditing(false); setDraft(''); }}
              disabled={busy}
              style={[styles.btn, styles.btnGhost]}
            >
              <Text style={styles.btnGhostText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.buttonRow}>
          <Pressable
            onPress={onYes}
            disabled={busy}
            style={[styles.btn, styles.btnPrimary]}
          >
            <Text style={styles.btnPrimaryText}>{question.yesLabel}</Text>
          </Pressable>
          {item.kind === 'place' ? (
            <Pressable
              onPress={() => setEditing(true)}
              disabled={busy}
              style={[styles.btn, styles.btnGhost]}
            >
              <Text style={styles.btnGhostText}>Actually…</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={onReject}
            disabled={busy}
            style={[styles.btn, styles.btnGhost]}
          >
            <Text style={[styles.btnGhostText, { color: colors.danger }]}>
              {question.rejectLabel}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ---------- question authoring ---------------------------------------------

function buildQuestion(item: CuriosityItem): {
  text: string;
  subtitle: string | null;
  yesLabel: string;
  rejectLabel: string;
} {
  if (item.kind === 'place') {
    const p = item.payload;
    const niceName = p.user_label ?? p.name;
    const cat = p.category ?? p.primary_type;
    const visits = p.visit_count;
    const confidence = p.confidence ?? 0;

    // Helper: stats line shown across all variants.
    const stats =
      `${visits} visit${visits === 1 ? '' : 's'} ` +
      `· last seen ${relTime(p.last_seen)}`;

    // Variant A — name + decent confidence (Google match OR strong time-of-day):
    // soft assertion. Tone is "ALINE noticed".
    if (niceName && confidence >= 0.7) {
      return {
        text: `Is this ${niceName}?`,
        subtitle: cat
          ? `${stats} · I have it as a ${cat}.`
          : stats,
        yesLabel: 'Yes',
        rejectLabel: 'Not really',
      };
    }

    // Variant B — name + low-mid confidence (auto-inferred from weak signal):
    // ALINE flags it as a guess explicitly. Less assertive.
    if (niceName) {
      return {
        text: `I think this is ${niceName} — am I right?`,
        subtitle: `${stats} · my guess, not certain.`,
        yesLabel: 'Yes',
        rejectLabel: 'Not really',
      };
    }

    // Variant C — no name. "What is this place?" + tap-to-label flow.
    return {
      text: `What is this place?`,
      subtitle: `${stats} · tap "Actually…" to label it.`,
      yesLabel: "It's a place I go",
      rejectLabel: "Don't track",
    };
  }

  // routine
  const r = item.payload;
  const dow = r.day_of_week != null ? DOW_NAMES[r.day_of_week] : '?';
  const window = `${formatMinute(r.start_minute)}–${formatMinute(r.end_minute)}`;
  const consistency = r.consistency ? Math.round(r.consistency * 100) : 0;

  return {
    text: `You tend to be at ${r.place_name} on ${dow}, ${window}.`,
    subtitle: `${consistency}% consistency. Is this a routine I should remember?`,
    yesLabel: "Yep, that's me",
    rejectLabel: 'Not a routine',
  };
}

// ---------- styles ----------------------------------------------------------

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
    borderWidth: 1,
    borderColor: colors.accent2Dim,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  eyebrow: {
    color: colors.accent,
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  snoozeText: {
    color: colors.textDim,
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold,
  },
  question: {
    color: colors.text,
    fontSize: font.size.lg,
    fontWeight: font.weight.medium,
    lineHeight: 24,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    lineHeight: 20,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: space.sm,
    flexWrap: 'wrap',
  },
  btn: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  btnPrimary: {
    backgroundColor: colors.accent,
  },
  btnPrimaryText: {
    color: colors.textInverse,
    fontSize: font.size.sm,
    fontWeight: font.weight.semibold,
  },
  btnGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnGhostText: {
    color: colors.text,
    fontSize: font.size.sm,
    fontWeight: font.weight.semibold,
  },
  input: {
    backgroundColor: colors.bgRaised,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: colors.text,
    fontSize: font.size.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
});
