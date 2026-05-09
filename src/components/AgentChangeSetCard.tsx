/**
 * AgentChangeSetCard — renders a pending change_set proposal next to a
 * chat_message in the chat thread.
 *
 * The agent emits these via the `propose_change_set` tool. Each card lists
 * the operations one per line ("Move gym Wed → Thu", "Add dinner with Marko
 * Wed 19:00") with a friendly summary on top, and three buttons:
 *   Accept all   → calls apply_change_set RPC, calendar mutates atomically
 *   Different time → drops a hint into the chat composer
 *   Cancel       → calls reject_change_set RPC
 *
 * The card disappears the moment the change set is no longer 'pending'
 * (the realtime subscription in useChangeSets handles the unmount).
 */

import { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  applyChangeSet,
  rejectChangeSet,
  type PendingChangeSet,
} from '../lib/use-change-sets';
import type { ChangeSetOperation } from '../types/database';
import { colors, font, radius, space } from '../theme';

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatLocal(iso: string): { dow: string; date: string; time: string } {
  const d = new Date(iso);
  const dow = DOW_NAMES[d.getDay()];
  const date = `${d.getDate()}/${d.getMonth() + 1}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return { dow, date, time: `${hh}:${mm}` };
}

function describeOp(op: ChangeSetOperation): {
  symbol: string;
  primary: string;
  secondary: string;
} {
  if (op.op === 'create') {
    const start = formatLocal(op.start_at);
    const end = formatLocal(op.end_at);
    return {
      symbol: '+',
      primary: op.title,
      secondary: `${start.dow} ${start.date} · ${start.time}–${end.time}`,
    };
  }
  // 'move' op — we don't have the original event title in the payload;
  // show the new placement and (best-effort) the reason.
  const newStart = formatLocal(op.new_start);
  const newEnd = formatLocal(op.new_end);
  return {
    symbol: '↔',
    primary: op.reasoning ?? 'Move existing event',
    secondary: `→ ${newStart.dow} ${newStart.date} · ${newStart.time}–${newEnd.time}`,
  };
}

export function AgentChangeSetCard({
  changeSet,
  onPromptDifferentTime,
}: {
  changeSet: PendingChangeSet;
  /** Drop a hint into the composer when the user wants a different time. */
  onPromptDifferentTime?: (suggestion: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'accepted' | 'rejected' | null>(null);

  const opLines = useMemo(
    () => changeSet.operations.map(describeOp),
    [changeSet.operations],
  );

  const expiresIn = useMemo(() => {
    const ms = new Date(changeSet.expires_at).getTime() - Date.now();
    if (ms < 0) return 'expired';
    const hours = Math.floor(ms / 3_600_000);
    if (hours >= 1) return `${hours}h to decide`;
    const mins = Math.max(1, Math.floor(ms / 60_000));
    return `${mins}m to decide`;
  }, [changeSet.expires_at]);

  const onAccept = async () => {
    setBusy(true);
    const r = await applyChangeSet(changeSet.id);
    setBusy(false);
    if (r.error) Alert.alert('Could not apply', r.error);
    else setDone('accepted');
  };

  const onReject = async () => {
    setBusy(true);
    const r = await rejectChangeSet(changeSet.id);
    setBusy(false);
    if (r.error) Alert.alert('Could not reject', r.error);
    else setDone('rejected');
  };

  const onDifferent = () => {
    onPromptDifferentTime?.('Different time would be better — what about ');
  };

  // After action, briefly show settled state. The realtime sub will
  // unmount us shortly after.
  if (done === 'accepted') {
    return (
      <View style={[styles.card, styles.cardSettled]}>
        <Text style={styles.settledText}>✓ Done — calendar updated.</Text>
      </View>
    );
  }
  if (done === 'rejected') {
    return (
      <View style={[styles.card, styles.cardSettled]}>
        <Text style={styles.settledText}>Cancelled.</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow}>ALINE proposes</Text>
        <Text style={styles.expires}>{expiresIn}</Text>
      </View>

      {changeSet.reasoning ? (
        <Text style={styles.summary}>{changeSet.reasoning}</Text>
      ) : null}

      <View style={styles.opList}>
        {opLines.map((line, idx) => (
          <View key={idx} style={styles.opRow}>
            <Text style={styles.opSymbol}>{line.symbol}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.opPrimary}>{line.primary}</Text>
              <Text style={styles.opSecondary}>{line.secondary}</Text>
            </View>
          </View>
        ))}
      </View>

      <View style={styles.buttonRow}>
        <Pressable
          onPress={onAccept}
          disabled={busy}
          style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
        >
          <Text style={styles.btnPrimaryText}>Accept all</Text>
        </Pressable>
        <Pressable
          onPress={onDifferent}
          disabled={busy}
          style={[styles.btn, styles.btnGhost, busy && styles.btnDisabled]}
        >
          <Text style={styles.btnGhostText}>Different time</Text>
        </Pressable>
        <Pressable
          onPress={onReject}
          disabled={busy}
          style={[styles.btn, styles.btnGhost, busy && styles.btnDisabled]}
        >
          <Text style={[styles.btnGhostText, { color: colors.danger }]}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: space.sm,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.accent2Dim,
    padding: space.md,
    gap: space.sm,
  },
  cardSettled: {
    borderColor: colors.border,
    paddingVertical: space.sm,
  },
  settledText: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    fontStyle: 'italic',
  },
  headerRow: {
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
  expires: {
    color: colors.textDim,
    fontSize: font.size.xs,
  },
  summary: {
    color: colors.text,
    fontSize: font.size.md,
    fontWeight: font.weight.medium,
    lineHeight: 20,
  },
  opList: {
    gap: space.xs,
    paddingVertical: space.xs,
  },
  opRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
  },
  opSymbol: {
    color: colors.accent,
    fontSize: font.size.lg,
    fontWeight: font.weight.bold,
    width: 18,
    textAlign: 'center',
  },
  opPrimary: {
    color: colors.text,
    fontSize: font.size.sm,
    fontWeight: font.weight.medium,
  },
  opSecondary: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    marginTop: 1,
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
  btnDisabled: {
    opacity: 0.5,
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
});
