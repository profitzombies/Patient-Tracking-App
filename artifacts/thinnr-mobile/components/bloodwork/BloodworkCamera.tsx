import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { AppModal } from '@/components/ui/AppModal';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Feather } from '@expo/vector-icons';
import { Pressable, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import * as Haptics from 'expo-haptics';
import { BloodworkCaptureGuard } from '@/lib/bloodwork-scope';

interface BloodworkCameraProps {
  visible: boolean;
  onClose: () => void;
  onCaptureStart: () => unknown | null;
  onCapture: (uri: string, width: number, height: number, scope: unknown) => void;
  onDiscard: (uri: string) => void;
}

export function BloodworkCamera({ visible, onClose, onCaptureStart, onCapture, onDiscard }: BloodworkCameraProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const cameraRef = React.useRef<CameraView>(null);
  const guardRef = React.useRef(new BloodworkCaptureGuard());
  React.useEffect(() => {
    guardRef.current.setVisible(visible);
  }, [visible]);

  React.useEffect(() => {
    if (visible && permission?.status === 'undetermined') {
      void requestPermission();
    }
  }, [visible, permission, requestPermission]);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current) return;
    const scope = onCaptureStart();
    if (!scope) return;
    const epoch = guardRef.current.begin();
    try {
      Haptics.selectionAsync();
      const photo = await cameraRef.current.takePictureAsync({ quality: 1 });
      if (photo?.uri) {
        if (!guardRef.current.accepts(epoch)) {
          onDiscard(photo.uri);
          return;
        }
        onCapture(photo.uri, photo.width ?? 0, photo.height ?? 0, scope);
      }
    } catch (e) {
      console.error('Camera capture failed', e);
    }
  }, [onCapture, onCaptureStart, onDiscard]);

  if (!visible) return null;

  const topPad = Math.max(insets.top, 14);
  const bottomPad = Math.max(insets.bottom, 18);

  const granted = permission?.granted === true;

  return (
    <AppModal visible={visible} onRequestClose={onClose} animationType="slide" transparent>
      <View style={styles.root}>
        {granted ? (
          <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
        ) : (
          <View style={styles.centerBlock}>
            <Text style={{ color: '#fff' }}>Camera access is required to take photos.</Text>
            {permission?.canAskAgain && (
              <Pressable onPress={requestPermission} style={styles.reqBtn}>
                <Text style={{ color: '#fff' }}>Grant Permission</Text>
              </Pressable>
            )}
          </View>
        )}

        <View style={[styles.overlay, { paddingTop: topPad, paddingBottom: bottomPad }]}>
          <View style={styles.topBar}>
            <Pressable onPress={onClose} style={styles.circleBtn} hitSlop={8}>
              <Feather name="x" size={24} color="#fff" />
            </Pressable>
          </View>

          {granted && (
            <View style={styles.bottomBar}>
              <View style={styles.spacer} />
              <Pressable onPress={handleCapture} style={styles.shutterRing}>
                <View style={styles.shutterCore} />
              </Pressable>
              <View style={styles.spacer} />
            </View>
          )}
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0d1219' },
  centerBlock: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  overlay: { flex: 1, justifyContent: 'space-between', paddingHorizontal: 16 },
  topBar: { flexDirection: 'row', justifyContent: 'flex-start' },
  bottomBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 24 },
  circleBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  shutterRing: { width: 72, height: 72, borderRadius: 36, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  shutterCore: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff' },
  spacer: { width: 44, height: 44 },
  reqBtn: { marginTop: 16, padding: 12, borderWidth: 1, borderColor: '#fff', borderRadius: 8 },
});
