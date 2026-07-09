import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, space } from '../theme';

// Mirrors the plan_spec shape the agent's save_goal_plan tool writes.
export type PlanCycle = {
  length: number;
  on: number[];
  anchor?: string | null;
};
export type PlanSession = {
  activity: string;
  days?: string[] | null;
  cycle?: PlanCycle | null;
  start?: string | null;
  duration_min?: number | null;
  location_hint?: string | null;
  note?: string | null;
};
export type PlanSpec = {
  summary?: string | null;
  cadence_per_week?: number | null;
  sessions?: PlanSession[];
};

function cycleLabel(c: PlanCycle): string {
  // Render common cycles in plain language; fall back to "on day(s) X of N".
  const offCount = c.length - c.on.length;
  const contiguous = c.on.length > 0 && c.on.every((v, i) => v === c.on[0] + i);
  if (contiguous && c.on[0] === 1 && offCount > 0) {
    return `${c.on.length} on / ${offCount} off`;
  }
  if (c.length === 2 && c.on.length === 1) return 'every other day';
  return `day${c.on.length > 1 ? 's' : ''} ${c.on.join(',')} of ${c.length}`;
}

function sessionWhen(s: PlanSession): string {
  const pattern = s.cycle && s.cycle.length
    ? cycleLabel(s.cycle)
    : (Array.isArray(s.days) && s.days.length ? s.days.join('/') : '');
  const parts = [pattern, s.start].filter(Boolean).join(' · ');
  const dur = s.duration_min ? `${s.duration_min} min` : '';
  const loc = s.location_hint ? `@ ${s.location_hint}` : '';
  return [parts, dur, loc].filter(Boolean).join(' · ');
}

type Props = {
  title: string;
  status: 'draft' | 'live' | 'none';
  spec: PlanSpec | null;
  /** Extra meta line (category · target · deadline). Shown on the Goals screen. */
  meta?: string[];
  onRefine: () => void;
  onCommit: () => void;
  /** Shown for status='none' (no plan yet) — the Goals screen passes this. */
  onBuild?: () => void;
  /** Chat variant: no outer border (it already sits in a bubble). */
  embedded?: boolean;
};

export function GoalPlanCard({ title, status, spec, meta, onRefine, onCommit, onBuild, embedded }: Props) {
  const sessions = Array.isArray(spec?.sessions) ? spec!.sessions! : [];
  const badge =
    status === 'live'
      ? { label: 'LIVE', color: colors.accent, bg: colors.accentDim }
      : status === 'draft'
        ? { label: 'DRAFT', color: colors.eventGoal, bg: '#2A220A' }
        : { label: 'NO PLAN', color: colors.textMuted, bg: colors.bgRaised };

  return (
    <View style={[styles.card, embedded && styles.embedded]}>
      <View style={styles.head}>
        <Text style={styles.title}>{title}</Text>
        <View style={[styles.badge, { backgroundColor: badge.bg }]}>
          <Text style={[styles.badgeText, { color: badge.color }]}>{badge.label}</Text>
        </View>
      </View>

      {meta && meta.length > 0 ? <Text style={styles.meta}>{meta.join(' · ')}</Text> : null}

      {status === 'none' ? (
        <>
          <Text style={styles.emptyHint}>
            No plan yet. Build one with ALINE — it'll fit sessions around your week.
          </Text>
          <Pressable style={[styles.btn, styles.primary]} onPress={onBuild}>
            <Text style={styles.primaryText}>Build a plan</Text>
          </Pressable>
        </>
      ) : (
        <>
          {spec?.summary ? <Text style={styles.summary}>{spec.summary}</Text> : null}

          <View style={styles.sessions}>
            {sessions.map((s, i) => (
              <View key={i} style={styles.sessionRow}>
                <View style={styles.dot} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.activity}>{s.activity}</Text>
                  <Text style={styles.when}>{sessionWhen(s)}</Text>
                </View>
              </View>
            ))}
          </View>

          {status === 'draft' ? <Text style={styles.draftNote}>Not on your calendar yet.</Text> : null}

          <View style={styles.btnRow}>
            <Pressable style={[styles.btn, styles.ghost]} onPress={onRefine}>
              <Text style={styles.ghostText}>Refine</Text>
            </Pressable>
            {status === 'draft' ? (
              <Pressable style={[styles.btn, styles.primary]} onPress={onCommit}>
                <Text style={styles.primaryText}>Commit to schedule</Text>
              </Pressable>
            ) : (
              <Pressable style={[styles.btn, styles.ghost]} onPress={onCommit}>
                <Text style={styles.ghostText}>Re-sync</Text>
              </Pressable>
            )}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: space.lg,
  },
  embedded: { backgroundColor: 'transparent', borderWidth: 0, padding: 0 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { flex: 1, fontSize: font.size.lg, fontWeight: '600', color: colors.text },
  badge: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, marginLeft: space.sm },
  badgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  meta: { color: colors.textMuted, fontSize: font.size.sm, marginTop: 4 },
  emptyHint: { color: colors.textMuted, fontSize: font.size.sm, marginTop: space.sm, marginBottom: space.md, lineHeight: 19 },
  summary: { color: colors.text, fontSize: font.size.md, marginTop: space.md, lineHeight: 21 },
  sessions: { marginTop: space.md, gap: space.sm },
  sessionRow: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.eventGoal, marginRight: space.md },
  activity: { color: colors.text, fontSize: font.size.md, fontWeight: '500' },
  when: { color: colors.textMuted, fontSize: font.size.sm, marginTop: 1 },
  draftNote: { color: colors.eventGoal, fontSize: font.size.sm, marginTop: space.md },
  btnRow: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  btn: { flex: 1, paddingVertical: space.md, borderRadius: radius.md, alignItems: 'center' },
  primary: { backgroundColor: colors.accent },
  primaryText: { color: colors.textInverse, fontSize: font.size.md, fontWeight: '600' },
  ghost: { backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: colors.border },
  ghostText: { color: colors.text, fontSize: font.size.md, fontWeight: '500' },
});
