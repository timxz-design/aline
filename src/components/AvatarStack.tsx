import { StyleSheet, Text, View } from 'react-native';
import { personName, type Participant } from '../lib/hangouts';
import { colors } from '../theme';
import { avatarColor, PersonAvatar } from './PersonAvatar';

/** Group plans get their own colour, kept out of the person palette. */
export const GROUP_PLAN_COLOR = colors.eventCoordinated;

/** The other people in a plan who haven't said no. */
export function otherParticipants(participants: Participant[], meId: string | undefined): Participant[] {
  return participants.filter((p) => p.user_id !== meId && p.status !== 'declined');
}

/**
 * A plan's colour: the other person's colour for a 1:1, the group colour when
 * two or more others are in it.
 */
export function planColor(participants: Participant[], meId: string | undefined): string {
  const others = otherParticipants(participants, meId);
  return others.length === 1 ? avatarColor(others[0].user_id) : GROUP_PLAN_COLOR;
}

/** Overlapping initials, up to `max`, then "+N". Going = solid; invited/maybe = faded.
 *  Confirmed people are shown first so a full stack favours who's actually coming. */
export function AvatarStack({
  people,
  size = 22,
  max = 3,
}: {
  people: Participant[];
  size?: number;
  max?: number;
}) {
  if (people.length === 0) return null;
  const ordered = [...people].sort((a, b) => Number(b.status === 'confirmed') - Number(a.status === 'confirmed'));
  const shown = ordered.slice(0, max);
  const extra = people.length - shown.length;
  const overlap = Math.round(size * 0.3);
  return (
    <View style={styles.row}>
      {shown.map((p, i) => (
        <View
          key={p.user_id}
          style={[
            styles.ring,
            { borderRadius: (size + 4) / 2, marginLeft: i === 0 ? 0 : -overlap, zIndex: max - i },
            // Invited / maybe: shown, but faded until they say yes.
            p.status !== 'confirmed' && { opacity: 0.45 },
          ]}
        >
          <PersonAvatar id={p.user_id} name={personName(p)} size={size} />
        </View>
      ))}
      {extra > 0 ? (
        <View
          style={[
            styles.ring,
            styles.extra,
            { width: size + 4, height: size + 4, borderRadius: (size + 4) / 2, marginLeft: -overlap },
          ]}
        >
          <Text style={[styles.extraText, { fontSize: Math.round(size * 0.4) }]}>+{extra}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  // White ring so overlapping circles stay distinct.
  ring: { borderWidth: 2, borderColor: colors.bg, backgroundColor: colors.bg },
  extra: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgRaised },
  extraText: { color: colors.textMuted, fontWeight: '700' },
});
