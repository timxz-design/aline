import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { useFriends, type FriendProfile } from '../lib/use-friends';
import { colors, font, radius, space } from '../theme';
import { Button } from './Button';
import { PersonAvatar } from './PersonAvatar';

/**
 * Modal for adding existing friends to a group. Friends-only:
 * non-friends must be added via friend request first.
 */
export function AddMembersModal({
  visible,
  groupId,
  excludeUserIds,
  onClose,
  onAdded,
}: {
  visible: boolean;
  groupId: string;
  /** Members already in the group — hide them from the picker. */
  excludeUserIds: string[];
  onClose: () => void;
  onAdded?: (count: number) => void;
}) {
  const { friends, refresh } = useFriends();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // Filter out friends already in the group.
  const candidates = useMemo(() => {
    const exclude = new Set(excludeUserIds);
    return friends.filter((f) => !exclude.has(f.id));
  }, [friends, excludeUserIds]);

  // Reset selection when reopening.
  useEffect(() => {
    if (visible) {
      setSelected(new Set());
      refresh();
    }
  }, [visible, refresh]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    const { data, error } = await supabase.rpc('add_friends_to_group', {
      _group_id: groupId,
      _user_ids: Array.from(selected),
    });
    setSubmitting(false);
    if (error) {
      Alert.alert('Could not add', error.message);
      return;
    }
    onAdded?.((data as number) ?? selected.size);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>Add friends to group</Text>
          <Text style={styles.sub}>
            Pick anyone you're already friends with. They'll see the group in
            their app immediately.
          </Text>

          {candidates.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No friends to add</Text>
              <Text style={styles.emptyBody}>
                Either you don't have friends yet, or they're all already in
                this group. Add a friend in the You tab first.
              </Text>
            </View>
          ) : (
            <FlatList
              data={candidates}
              keyExtractor={(f) => f.id}
              style={{ maxHeight: 360 }}
              ItemSeparatorComponent={() => <View style={{ height: 4 }} />}
              renderItem={({ item }) => {
                const active = selected.has(item.id);
                return (
                  <Pressable
                    onPress={() => toggle(item.id)}
                    style={({ pressed }) => [
                      styles.row,
                      active && styles.rowActive,
                      pressed && { opacity: 0.85 },
                    ]}
                  >
                    <View style={[styles.checkbox, active && styles.checkboxActive]}>
                      {active ? <Text style={styles.checkmark}>✓</Text> : null}
                    </View>
                    <PersonAvatar id={item.id} name={item.first_name ?? item.handle} size={32} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.name}>
                        {item.first_name ?? 'Unnamed'}
                      </Text>
                      {item.handle ? (
                        <Text style={styles.handle}>@{item.handle}</Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              }}
            />
          )}

          <View style={styles.actions}>
            <Button label="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            <Button
              label={
                selected.size > 0
                  ? `Add ${selected.size} ${selected.size === 1 ? 'friend' : 'friends'}`
                  : 'Add'
              }
              onPress={submit}
              loading={submitting}
              disabled={selected.size === 0}
              style={{ flex: 1 }}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: space.xl,
    gap: space.md,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  title: { color: colors.text, fontSize: font.size.xl, fontWeight: '700' },
  sub: { color: colors.textMuted, fontSize: 13, marginTop: -8 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 10,
    paddingHorizontal: space.sm,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowActive: {
    backgroundColor: colors.accentDim,
    borderColor: colors.accent,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  checkmark: { color: colors.textInverse, fontSize: 13, fontWeight: '900' },
  name: { color: colors.text, fontSize: 14, fontWeight: '600' },
  handle: { color: colors.textMuted, fontSize: 11 },

  empty: {
    padding: space.xl,
    gap: 4,
    alignItems: 'center',
  },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  emptyBody: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },

  actions: { flexDirection: 'row', gap: space.md, marginTop: space.sm },
});
