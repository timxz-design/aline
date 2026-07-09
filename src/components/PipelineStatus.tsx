/**
 * Tiny status strip shown in Profile in place of the old four debug buttons.
 *
 * Reflects the per-stage state from `auto-recompute.ts` — the most-recently-run
 * stage's timestamp + a warning glyph if any stage failed on its last attempt.
 * Tap → forces a full pipeline recompute (`maybeRecompute({ force: true })`).
 *
 * The user shouldn't need to think about pipelines. This strip exists just so
 * (a) they have a visible signal something is happening behind the scenes and
 * (b) they have an explicit "retry now" hatch when something breaks.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  getPipelineState,
  maybeRecompute,
  type RecomputeStage,
} from '../lib/auto-recompute';
import { colors, font, radius, space } from '../theme';

type StageStatus = {
  last_ran_at: number | null;
  last_ok: boolean | null;
  last_error: string | null;
};

type PipelineState = Record<RecomputeStage, StageStatus>;

function formatRelative(ms: number | null): string {
  if (ms == null) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} hr ago`;
  return `${Math.round(diff / 86_400_000)} d ago`;
}

function mostRecentRun(state: PipelineState): number | null {
  let max: number | null = null;
  for (const stage of Object.values(state)) {
    if (stage.last_ran_at != null && (max == null || stage.last_ran_at > max)) {
      max = stage.last_ran_at;
    }
  }
  return max;
}

function hasError(state: PipelineState): { stage: RecomputeStage; error: string } | null {
  for (const [name, stage] of Object.entries(state)) {
    if (stage.last_ok === false && stage.last_error) {
      return { stage: name as RecomputeStage, error: stage.last_error };
    }
  }
  return null;
}

export function PipelineStatus() {
  const [state, setState] = useState<PipelineState | null>(null);
  const [running, setRunning] = useState(false);

  const refresh = useCallback(async () => {
    const s = await getPipelineState();
    setState(s);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onRetry = useCallback(async () => {
    setRunning(true);
    try {
      await maybeRecompute({ force: true });
      await refresh();
    } finally {
      setRunning(false);
    }
  }, [refresh]);

  if (!state) return null;
  const lastRun = mostRecentRun(state);
  const err = hasError(state);

  return (
    <Pressable
      onPress={onRetry}
      disabled={running}
      style={({ pressed }) => [
        styles.strip,
        err && styles.stripWarning,
        pressed && { opacity: 0.7 },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.line}>
          {err ? '⚠ ' : '✦ '}
          {err
            ? `Sync had a hiccup (${err.stage}) — tap to retry`
            : `Last synced ${formatRelative(lastRun)}`}
        </Text>
        {!err ? (
          <Text style={styles.subtle}>tap to refresh now</Text>
        ) : null}
      </View>
      {running ? (
        <ActivityIndicator size="small" color={colors.accent} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  stripWarning: {
    borderColor: colors.warning,
  },
  line: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: font.weight.medium,
  },
  subtle: {
    color: colors.textDim,
    fontSize: font.size.xs - 1,
    marginTop: 1,
  },
});
