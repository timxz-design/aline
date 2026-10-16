import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { formatMinute, groupRoutines, isDisplayRoutine, placeName, RoutineRow } from '../../../src/components/KnowledgeRows';
import { DetailScreen, EmptyRow, Group, Row } from '../../../src/components/settings-ui';
import { useBehavioralProfile } from '../../../src/lib/use-behavioral-profile';
import { colors } from '../../../src/theme';

export default function RoutinesScreen() {
  const { places, routines, summary, loading, refresh } = useBehavioralProfile();
  useFocusEffect(
    useCallback(() => {
      refresh();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );
  const groups = useMemo(() => groupRoutines(routines.filter(isDisplayRoutine)), [routines]);
  const hasSleep = summary?.bedtime_minute != null && summary.waketime_minute != null;

  const labelFor = (placeId: string | null, category: string | null) => {
    const p = places.find((x) => x.id === placeId);
    return p ? placeName(p) : category ? category.charAt(0).toUpperCase() + category.slice(1) : 'Somewhere';
  };

  return (
    <DetailScreen
      title="Routines and sleep"
      subtitle="Patterns ALINE noticed. It uses them to know when you're usually busy, so plans land when you're free."
    >
      <Group label="Sleep" footer={hasSleep ? 'From Apple Health when connected, otherwise from when your phone goes quiet.' : undefined}>
        {hasSleep ? (
          [
            <Row key="bed" icon="moon" iconColor={colors.accent2} title="Usually asleep" value={`~${formatMinute(summary!.bedtime_minute)}`} />,
            <Row key="wake" icon="sunny" iconColor={colors.warning} title="Usually up" value={`~${formatMinute(summary!.waketime_minute)}`} />,
          ]
        ) : (
          <EmptyRow text={loading ? 'Loading…' : 'Not enough nights yet.'} />
        )}
      </Group>

      <Group label="Routines" footer={groups.length ? "Tap one to confirm it or tell ALINE it's not really a routine." : undefined}>
        {groups.length ? (
          groups.map((g) => (
            <RoutineRow key={g.key} group={g} placeLabel={labelFor(g.placeId, g.category)} onChange={refresh} />
          ))
        ) : (
          <EmptyRow text={loading ? 'Loading…' : 'No steady routines yet — they show up after a week or two.'} />
        )}
      </Group>
    </DetailScreen>
  );
}
