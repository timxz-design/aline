import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { colors, font, radius, space } from '../theme';
import { Button } from './Button';

type Status =
  | 'request_sent'
  | 'already_friends'
  | 'request_pending'
  | 'auto_accepted'
  | string;

const STATUS_COPY: Record<string, { tone: 'good' | 'muted'; line: string }> = {
  request_sent: { tone: 'good', line: 'Request sent. They\'ll see it in their app.' },
  already_friends: { tone: 'muted', line: 'You\'re already friends.' },
  request_pending: { tone: 'muted', line: 'A request is already pending.' },
  auto_accepted: { tone: 'good', line: 'You\'re now friends — they had already sent you a request.' },
};

export function AddFriendModal({
  visible,
  onClose,
  onSuccess,
}: {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const [handle, setHandle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setHandle('');
    setStatus(null);
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    if (!handle.trim()) return;
    setSubmitting(true);
    setError(null);
    setStatus(null);
    const { data, error: rpcErr } = await supabase.rpc(
      'request_friendship_by_handle',
      { _handle: handle.trim().toLowerCase() }
    );
    setSubmitting(false);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    setStatus(data as Status);
    onSuccess?.();
  };

  const copy = status ? STATUS_COPY[status] : null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={close}
    >
      <Pressable style={styles.backdrop} onPress={close}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ width: '100%' }}
        >
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.title}>Add a friend</Text>
            <Text style={styles.sub}>
              Enter their handle. They'll get a request to accept.
            </Text>

            <View style={styles.inputRow}>
              <Text style={styles.atSign}>@</Text>
              <TextInput
                placeholder="handle"
                placeholderTextColor={colors.textDim}
                value={handle}
                onChangeText={(t) => {
                  setHandle(t.toLowerCase().replace(/\s/g, ''));
                  setStatus(null);
                  setError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="none"
                secureTextEntry={false}
                keyboardType="default"
                maxLength={20}
                autoFocus
                style={styles.handleInput}
              />
            </View>

            {copy ? (
              <Text
                style={[
                  styles.statusText,
                  copy.tone === 'good' && { color: colors.success },
                ]}
              >
                {copy.line}
              </Text>
            ) : status && !copy ? (
              <Text style={styles.statusText}>{status}</Text>
            ) : null}
            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <View style={styles.actions}>
              <Button label="Close" variant="secondary" onPress={close} style={{ flex: 1 }} />
              <Button
                label="Send request"
                onPress={submit}
                loading={submitting}
                disabled={!handle.trim()}
                style={{ flex: 1 }}
              />
            </View>
          </Pressable>
        </KeyboardAvoidingView>
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
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  atSign: { color: colors.textMuted, fontSize: 22, fontWeight: '600' },
  statusText: { fontSize: 13, color: colors.textMuted, marginLeft: 24 },
  errorText: { color: colors.danger, fontSize: 13, marginLeft: 24 },
  handleInput: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.sm },
});
