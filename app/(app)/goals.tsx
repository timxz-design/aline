import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BackChevron } from '../../src/components/BackChevron';
import { Screen } from '../../src/components/Screen';
import { useAuth } from '../../src/lib/auth-context';
import { supabase } from '../../src/lib/supabase';
import { colors, font, radius, space } from '../../src/theme';
import { GoalPlanCard, type PlanSpec } from '../../src/components/GoalPlanCard';
import { commitGoalPlan } from '../../src/lib/use-goal-plans';

type GoalRow = {
  id: string;
  title: string;
  category: string | null;
  target_per_week: number | null;
  target_date: string | null;
};
type PlanRow = {
  id: string;
  goal_id: string;
  status: 'draft' | 'live' | 'archived';
  version: number;
  plan_spec: PlanSpec | null;
  rationale: string | null;
};

/** Send a prefilled message to the agent — the agent owns all plan logic
 * (save/commit/refine), so the UI never duplicates it. The composer is seeded
 * (not auto-sent) so the user stays in control, especially for commit. */
function useAgentSeed() {
  const router = useRouter();
  return (text: string) =>
    router.push({ pathname: '/(app)/agent', params: { seed: text } });
}

export default function GoalsScreen() {
  const { user } = useAuth();
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [plansByGoal, setPlansByGoal] = useState<Record<string, PlanRow>>({});
  const [loading, setLoading] = useState(true);
  const seedAgent = useAgentSeed();

  const load = useCallback(async () => {
    if (!user) return;
    const [goalsRes, plansRes] = await Promise.all([
      supabase
        .from('goals')
        .select('id, title, category, target_per_week, target_date')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .order('created_at', { ascending: false }),
      supabase
        .from('goal_plans')
        .select('id, goal_id, status, version, plan_spec, rationale')
        .eq('user_id', user.id)
        .neq('status', 'archived'),
    ]);
    setGoals((goalsRes.data as GoalRow[] | null) ?? []);
    const map: Record<string, PlanRow> = {};
    for (const p of (plansRes.data as PlanRow[] | null) ?? []) map[p.goal_id] = p;
    setPlansByGoal(map);
    setLoading(false);
  }, [user]);

  // Reload whenever the screen regains focus (e.g. after refining in chat).
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // Commit happens directly (no chat round-trip) — it's a deterministic, user-
  // initiated action, like accepting a change-set card.
  const handleCommit = useCallback(
    async (goal: GoalRow, isLive: boolean) => {
      const res = await commitGoalPlan(goal.id);
      if ('error' in res) {
        Alert.alert("Couldn't add to schedule", res.error);
        return;
      }
      await load();
      const skipNote = res.skipped > 0 ? ` (${res.skipped} skipped — clashed with existing plans)` : '';
      Alert.alert(
        isLive ? 'Plan re-synced' : 'Added to your schedule',
        `${res.created} session${res.created === 1 ? '' : 's'} placed over the next 2 weeks${skipNote}.`,
      );
    },
    [load],
  );

  return (
    <Screen noPadding>
      <View style={styles.header}>
        <BackChevron />
        <Text style={styles.title}>Goals</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {goals.length === 0 ? (
            <EmptyState onAsk={() => seedAgent('Help me set a goal and build a plan for it.')} />
          ) : (
            goals.map((g) => (
              <GoalCard
                key={g.id}
                goal={g}
                plan={plansByGoal[g.id]}
                onBuild={() => seedAgent(`Help me build a plan for "${g.title}".`)}
                onRefine={() => seedAgent(`Let's tweak my "${g.title}" plan: `)}
                onCommit={() => handleCommit(g, plansByGoal[g.id]?.status === 'live')}
              />
            ))
          )}

          <Pressable
            style={styles.newGoalBtn}
            onPress={() => seedAgent('I want to work toward a new goal — help me plan it.')}
          >
            <Text style={styles.newGoalText}>+ New goal</Text>
          </Pressable>
        </ScrollView>
      )}
    </Screen>
  );
}

// Thin wrapper over the SHARED GoalPlanCard so the Goals screen and the chat
// render the exact same card (single source of truth — no drift).
function GoalCard({
  goal,
  plan,
  onBuild,
  onRefine,
  onCommit,
}: {
  goal: GoalRow;
  plan: PlanRow | undefined;
  onBuild: () => void;
  onRefine: () => void;
  onCommit: () => void;
}) {
  const status: 'live' | 'draft' | 'none' = plan
    ? plan.status === 'live'
      ? 'live'
      : 'draft'
    : 'none';
  const meta = [
    goal.category,
    goal.target_per_week ? `${goal.target_per_week}×/week` : null,
    goal.target_date ? `by ${goal.target_date}` : null,
  ].filter(Boolean) as string[];

  return (
    <View style={{ marginBottom: space.md }}>
      <GoalPlanCard
        title={goal.title}
        status={status}
        spec={plan?.plan_spec ?? null}
        meta={meta}
        onBuild={onBuild}
        onRefine={onRefine}
        onCommit={onCommit}
      />
    </View>
  );
}

function EmptyState({ onAsk }: { onAsk: () => void }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>No goals yet</Text>
      <Text style={styles.emptyBody}>
        Tell ALINE what you want to work toward — get fit, learn a language, grow your
        business — and it'll build a plan that fits your real week.
      </Text>
      <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onAsk}>
        <Text style={styles.btnPrimaryText}>Set a goal with ALINE</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: font.size.xl,
    fontWeight: '700',
    color: colors.text,
    marginLeft: space.sm,
  },
  headerSpacer: { flex: 1 },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: space.lg, paddingBottom: space.xxl },

  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    marginBottom: space.md,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { flex: 1, fontSize: font.size.lg, fontWeight: '600', color: colors.text },
  badge: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    marginLeft: space.sm,
  },
  badgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  cardMeta: { color: colors.textMuted, fontSize: font.size.sm, marginTop: 4 },

  summary: { color: colors.text, fontSize: font.size.md, marginTop: space.md, lineHeight: 21 },

  sessions: { marginTop: space.md, gap: space.sm },
  sessionRow: { flexDirection: 'row', alignItems: 'center' },
  sessionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.eventGoal,
    marginRight: space.md,
  },
  sessionActivity: { color: colors.text, fontSize: font.size.md, fontWeight: '500' },
  sessionWhen: { color: colors.textMuted, fontSize: font.size.sm, marginTop: 1 },

  draftNote: { color: colors.eventGoal, fontSize: font.size.sm, marginTop: space.md },
  emptyPlanHint: { color: colors.textMuted, fontSize: font.size.sm, marginTop: space.sm, marginBottom: space.md, lineHeight: 19 },

  btnRow: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  btn: {
    flex: 1,
    paddingVertical: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  btnPrimary: { backgroundColor: colors.accent },
  btnPrimaryText: { color: colors.textInverse, fontSize: font.size.md, fontWeight: '600' },
  btnGhost: { backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: colors.border },
  btnGhostText: { color: colors.text, fontSize: font.size.md, fontWeight: '500' },

  newGoalBtn: { alignItems: 'center', paddingVertical: space.md, marginTop: space.sm },
  newGoalText: { color: colors.accent, fontSize: font.size.md, fontWeight: '600' },

  empty: { paddingVertical: space.xxl, alignItems: 'center' },
  emptyTitle: { color: colors.text, fontSize: font.size.xl, fontWeight: '700', marginBottom: space.sm },
  emptyBody: {
    color: colors.textMuted,
    fontSize: font.size.md,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: space.xl,
  },
});
