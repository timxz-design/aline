import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, space } from '../theme';

/**
 * Full-screen image viewer — tap a chat photo or event poster to open it.
 * ScrollView zoom gives native pinch-to-zoom on iOS (up to 4×); the ✕ (or the
 * hardware back gesture via onRequestClose) dismisses.
 */
export function ImageViewer({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  return (
    <Modal visible={!!uri} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        {uri ? (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.zoomArea}
            maximumZoomScale={4}
            minimumZoomScale={1}
            showsVerticalScrollIndicator={false}
            showsHorizontalScrollIndicator={false}
            centerContent
          >
            <Image source={{ uri }} style={styles.image} resizeMode="contain" />
          </ScrollView>
        ) : null}
        <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn} accessibilityLabel="Close image">
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' },
  zoomArea: { flexGrow: 1, justifyContent: 'center' },
  image: { width: '100%', height: '100%', minHeight: 300 },
  closeBtn: {
    position: 'absolute',
    top: 56,
    right: space.lg,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(30,30,30,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  closeText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
