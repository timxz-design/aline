import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { isPlaceConfirmed, PlaceRow } from '../../../src/components/KnowledgeRows';
import { DetailScreen, EmptyRow, Group, Row } from '../../../src/components/settings-ui';
import { useBehavioralProfile } from '../../../src/lib/use-behavioral-profile';

export default function PlacesScreen() {
  const { places, loading, refresh } = useBehavioralProfile();
  const [showMore, setShowMore] = useState(false);
  useFocusEffect(
    useCallback(() => {
      refresh();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const visible = places.filter((p) => !p.is_hidden);
  const confirmed = visible.filter(isPlaceConfirmed);
  const unsure = visible.filter((p) => !isPlaceConfirmed(p) && p.visit_count >= 2);
  const once = visible.filter((p) => !isPlaceConfirmed(p) && p.visit_count < 2);
  const hidden = places.filter((p) => p.is_hidden);

  return (
    <DetailScreen
      title="Places"
      subtitle="Learned from where you spend time. Only you see this list."
    >
      {loading ? null : places.length === 0 ? (
        <Group>
          <EmptyRow text="Nothing yet. ALINE learns your places over a few days of normal life." />
        </Group>
      ) : null}

      <Group label="Confirmed">
        {confirmed.map((p) => (
          <PlaceRow key={p.id} place={p} onChange={refresh} />
        ))}
      </Group>

      <Group label="Not sure yet" footer={unsure.length ? 'Confirm what is right; tap a place to rename, hide or delete it.' : undefined}>
        {unsure.map((p) => (
          <PlaceRow key={p.id} place={p} onChange={refresh} />
        ))}
      </Group>

      {once.length > 0 ? (
        <Group label="Seen once">
          {showMore
            ? once.map((p) => <PlaceRow key={p.id} place={p} onChange={refresh} />)
            : [<Row key="more" title={`Show ${once.length} more`} onPress={() => setShowMore(true)} />]}
        </Group>
      ) : null}

      <Group label="Hidden" footer={hidden.length ? "ALINE ignores hidden places when planning." : undefined}>
        {hidden.map((p) => (
          <PlaceRow key={p.id} place={p} onChange={refresh} />
        ))}
      </Group>
    </DetailScreen>
  );
}
