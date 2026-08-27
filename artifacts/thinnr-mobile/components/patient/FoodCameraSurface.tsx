/**
 * Full-screen in-app camera for food photos — the Instagram-story-style
 * capture surface behind every "Take a photo" control in the coach flows.
 *
 * Live preview with a shutter, camera flip, a flash button, and close; the
 * flash drives the camera's continuous torch (not capture-time flash): lit
 * the moment it's pressed, its on/off state announced to screen readers,
 * and reset the moment the surface closes — unmounting kills enableTorch.
 * Native back camera only: the front camera has no torch hardware and web
 * browsers cannot drive one. The bottom corner
 * holds the library shortcut, showing the most recent photo as a thumbnail
 * when photo access is already granted (a plain icon otherwise) so an
 * existing shot is one tap away. Capture and library pick both hand ONE raw
 * asset back through onSettle — the entry point that opened the screen owns
 * photo-prep and its own single blue "Use this photo" confirmation, so
 * nothing here uploads or double-confirms.
 *
 * Camera permission is asked once on arrival (only while still
 * undetermined). A denial, or a camera that fails to start, is never a dead
 * end: the surface swaps to a plain explanation with the library picker as
 * the primary action, plus either a re-ask button or a Settings link
 * depending on whether the OS would honor another ask. Errors follow the
 * shared announced-error pattern (alert role + live region + explicit iOS
 * announcement).
 *
 * The recent-photo thumbnail only READS permission state
 * (getPermissionsAsync never prompts): the library is offered quietly, and
 * the real permission ask happens on tap, inside the picker flow itself.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { useColors } from '@/hooks/useColors';
import type { FoodCameraCapture } from '@/lib/food-camera';

/** Scrim behind the floating controls over the live preview. */
const CONTROL_SCRIM = 'rgba(16, 22, 31, 0.42)';

interface FoodCameraSurfaceProps {
  /**
   * Receives the chosen raw asset (camera shot or library pick) or null
   * when the patient closes without one. Called at most once.
   */
  onSettle: (capture: FoodCameraCapture | null) => void;
}

export function FoodCameraSurface({ onSettle }: FoodCameraSurfaceProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [torchOn, setTorchOn] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mountError, setMountError] = useState(false);
  const [recentUri, setRecentUri] = useState<string | null>(null);
  const cameraRef = useRef<CameraView | null>(null);
  const askedRef = useRef(false);
  // The surface settles exactly once, no matter how taps interleave.
  const doneRef = useRef(false);

  const finish = useCallback(
    (capture: FoodCameraCapture | null) => {
      if (doneRef.current) return;
      doneRef.current = true;
      onSettle(capture);
    },
    [onSettle],
  );

  // Ask for the camera once on arrival — but only while the OS still counts
  // it as undetermined. A previous denial is respected: the fallback view's
  // own button (or Settings) is the way back in, never a surprise re-prompt.
  useEffect(() => {
    if (!permission || askedRef.current) return;
    if (permission.status !== 'undetermined') return;
    askedRef.current = true;
    void requestPermission();
  }, [permission, requestPermission]);

  // Corner thumbnail: quiet read of the newest library photo. Any failure
  // (no access, empty library, API trouble) just leaves the plain icon.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const access = await MediaLibrary.getPermissionsAsync();
        if (!access.granted) return;
        const page = await MediaLibrary.getAssetsAsync({
          first: 1,
          mediaType: MediaLibrary.MediaType.photo,
          sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        });
        const uri = page.assets[0]?.uri;
        if (!cancelled && uri) setRecentUri(uri);
      } catch {
        // Thumbnail is a nicety — the corner button works without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Android/web hear errors via the box's live region; iOS has no live
  // regions, so announce explicitly there.
  useEffect(() => {
    if (error && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(error);
    }
  }, [error]);

  const busy = capturing || picking;
  const cameraGranted = permission?.granted === true;
  const cameraMode = cameraGranted && !mountError;
  const fallbackMode = permission?.status === 'denied' || (cameraGranted && mountError);

  const close = () => {
    Haptics.selectionAsync();
    finish(null);
  };

  const flip = () => {
    Haptics.selectionAsync();
    setFacing(current => (current === 'back' ? 'front' : 'back'));
  };

  /**
   * Immediate, persistent torch: lights the moment it's pressed and stays
   * lit until the capture is used or the surface closes. The toggle stays
   * on through a flip — the front camera has no torch hardware, so
   * enableTorch goes false while facing front and relights on flip-back.
   */
  const toggleTorch = () => {
    Haptics.selectionAsync();
    const next = !torchOn;
    setTorchOn(next);
    AccessibilityInfo.announceForAccessibility(next ? 'Flash on' : 'Flash off');
  };

  const capture = async () => {
    if (busy) return;
    const camera = cameraRef.current;
    if (!camera) return;
    Haptics.selectionAsync();
    setError(null);
    setCapturing(true);
    try {
      const shot = await camera.takePictureAsync({ quality: 1 });
      if (!shot?.uri) throw new Error('Capture returned no image');
      finish({
        asset: { uri: shot.uri, width: shot.width ?? 0, height: shot.height ?? 0 },
        source: 'camera',
      });
    } catch (err) {
      console.error('In-app capture failed', err);
      setError('That shot did not go through. Try again, or choose a photo from your library.');
      setCapturing(false);
    }
  };

  const pickFromLibrary = async () => {
    if (busy) return;
    Haptics.selectionAsync();
    setError(null);
    setPicking(true);
    try {
      const access = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!access.granted) {
        setError('Photo library permission was declined.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
        base64: Platform.OS === 'web',
      });
      if (result.canceled || !result.assets?.[0]) return;
      finish({ asset: result.assets[0], source: 'library' });
    } catch (err) {
      console.error('Photo library launch failed', err);
      setError('Your photo library could not be opened. Please try again.');
    } finally {
      setPicking(false);
    }
  };

  const topPad = Math.max(insets.top, 14);
  const bottomPad = Math.max(insets.bottom, 18);

  const errorBox = error ? (
    <View
      testID="food-camera-error"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[
        styles.errorBox,
        {
          backgroundColor: colors.warnBg,
          borderColor: colors.warnBorder,
          borderRadius: colors.radiusSm,
        },
      ]}
    >
      <Feather name="alert-triangle" size={13} color={colors.warnText} style={{ marginTop: 1 }} />
      <Text style={[styles.errorText, { color: colors.warnText }]}>{error}</Text>
    </View>
  ) : null;

  return (
    <View style={styles.root}>
      {cameraMode ? (
        <CameraView
          ref={cameraRef}
          style={styles.cameraFill}
          facing={facing}
          enableTorch={torchOn && facing === 'back'}
          onMountError={event => {
            console.error('Camera failed to start', event);
            setMountError(true);
          }}
        />
      ) : null}

      <View style={[styles.overlay, { paddingTop: topPad, paddingBottom: bottomPad }]}>
        <View style={styles.topBar}>
          <Pressable
            testID="food-camera-close"
            accessibilityRole="button"
            accessibilityLabel="Close the camera"
            hitSlop={8}
            onPress={close}
            style={({ pressed }) => [
              styles.controlCircle,
              { backgroundColor: CONTROL_SCRIM },
              pressed && { opacity: 0.75 },
            ]}
          >
            <Feather name="x" size={20} color="#ffffff" />
          </Pressable>
          <Text style={styles.topTitle}>FOOD PHOTO</Text>
          <View style={styles.topActions}>
            {cameraMode && Platform.OS !== 'web' && facing === 'back' ? (
              <Pressable
                testID="food-camera-torch"
                accessibilityRole="button"
                accessibilityLabel={torchOn ? 'Turn off the flash' : 'Turn on the flash'}
                accessibilityState={{ selected: torchOn }}
                hitSlop={8}
                onPress={toggleTorch}
                style={({ pressed }) => [
                  styles.controlCircle,
                  { backgroundColor: torchOn ? colors.cobalt : CONTROL_SCRIM },
                  pressed && { opacity: 0.75 },
                ]}
              >
                <Feather name={torchOn ? 'zap' : 'zap-off'} size={17} color="#ffffff" />
              </Pressable>
            ) : null}
            {cameraMode ? (
              <Pressable
                testID="food-camera-flip"
                accessibilityRole="button"
                accessibilityLabel="Switch camera"
                hitSlop={8}
                onPress={flip}
                style={({ pressed }) => [
                  styles.controlCircle,
                  { backgroundColor: CONTROL_SCRIM },
                  pressed && { opacity: 0.75 },
                ]}
              >
                <Feather name="refresh-ccw" size={18} color="#ffffff" />
              </Pressable>
            ) : (
              <View style={styles.controlSpacer} />
            )}
          </View>
        </View>

        {cameraMode ? (
          <View style={styles.bottomGroup}>
            {errorBox}
            <Text style={styles.caption}>Photos are analyzed once, never stored.</Text>
            <View style={styles.bottomBar}>
              <Pressable
                testID="food-camera-library"
                accessibilityRole="button"
                accessibilityLabel="Choose a photo from your library"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={pickFromLibrary}
                style={({ pressed }) => [
                  styles.libraryButton,
                  pressed && !busy && { opacity: 0.8 },
                  busy && { opacity: 0.6 },
                ]}
              >
                {picking ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : recentUri ? (
                  <Image
                    testID="food-camera-library-thumb"
                    source={{ uri: recentUri }}
                    style={styles.libraryThumb}
                    contentFit="cover"
                  />
                ) : (
                  <View testID="food-camera-library-icon" style={styles.libraryIconBox}>
                    <Feather name="image" size={19} color="#ffffff" />
                  </View>
                )}
              </Pressable>
              <Pressable
                testID="food-camera-shutter"
                accessibilityRole="button"
                accessibilityLabel="Take the photo"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={capture}
                style={({ pressed }) => [
                  styles.shutterRing,
                  pressed && !busy && { transform: [{ scale: 0.94 }] },
                  busy && { opacity: 0.7 },
                ]}
              >
                {capturing ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <View style={styles.shutterCore} />
                )}
              </Pressable>
              <View style={styles.librarySpacer} />
            </View>
          </View>
        ) : fallbackMode ? (
          <View testID="food-camera-fallback" style={styles.centerBlock}>
            <Text style={styles.fallbackLabel}>CAMERA</Text>
            <Text style={styles.fallbackTitle}>
              {mountError ? 'The camera did not start' : 'Camera access is off'}
            </Text>
            <Text style={styles.fallbackBody} accessibilityLiveRegion="polite">
              {mountError
                ? 'The camera could not be started on this device. You can still choose a photo from your library.'
                : 'Camera access is turned off for THINNR, so the live camera cannot open. You can still choose a photo from your library.'}
            </Text>
            {errorBox}
            <Pressable
              testID="food-camera-fallback-library"
              accessibilityRole="button"
              accessibilityLabel="Choose a photo from your library"
              accessibilityState={{ disabled: picking }}
              disabled={picking}
              onPress={pickFromLibrary}
              style={({ pressed }) => [
                styles.primaryBtn,
                {
                  backgroundColor: picking ? colors.cobaltMuted : colors.cobalt,
                  borderRadius: colors.radiusSm,
                },
                pressed && !picking && { opacity: 0.88 },
              ]}
            >
              {picking ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Feather name="image" size={15} color={colors.primaryForeground} />
              )}
              <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                Choose from library
              </Text>
            </Pressable>
            {mountError ? null : permission?.canAskAgain ? (
              <Pressable
                testID="food-camera-allow"
                accessibilityRole="button"
                accessibilityLabel="Allow camera access"
                onPress={() => {
                  Haptics.selectionAsync();
                  void requestPermission();
                }}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  { borderRadius: colors.radiusSm },
                  pressed && { opacity: 0.8 },
                ]}
              >
                <Text style={styles.secondaryBtnText}>Allow camera access</Text>
              </Pressable>
            ) : (
              <Pressable
                testID="food-camera-settings"
                accessibilityRole="button"
                accessibilityLabel="Open Settings to allow camera access"
                onPress={() => {
                  Haptics.selectionAsync();
                  void Linking.openSettings();
                }}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  { borderRadius: colors.radiusSm },
                  pressed && { opacity: 0.8 },
                ]}
              >
                <Text style={styles.secondaryBtnText}>Open Settings</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <View style={styles.centerBlock}>
            <Text style={styles.waitingText} accessibilityLiveRegion="polite">
              Waiting for camera access
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0d1219',
  },
  cameraFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  overlay: {
    flex: 1,
    paddingHorizontal: 18,
    justifyContent: 'space-between',
    gap: 12,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  topTitle: {
    fontSize: 9,
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
    color: 'rgba(255, 255, 255, 0.85)',
  },
  controlCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlSpacer: {
    width: 40,
    height: 40,
  },
  centerBlock: {
    flex: 1,
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 24,
  },
  waitingText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    color: 'rgba(255, 255, 255, 0.7)',
    textAlign: 'center',
  },
  fallbackLabel: {
    fontSize: 9,
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
    color: 'rgba(255, 255, 255, 0.55)',
  },
  fallbackTitle: {
    fontSize: 22,
    lineHeight: 28,
    fontFamily: 'PlayfairDisplay_700Bold',
    color: '#ffffff',
  },
  fallbackBody: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: 'Inter_400Regular',
    color: 'rgba(255, 255, 255, 0.75)',
    marginBottom: 6,
  },
  bottomGroup: {
    gap: 12,
  },
  caption: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: 'rgba(255, 255, 255, 0.65)',
    textAlign: 'center',
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  libraryButton: {
    width: 46,
    height: 46,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.9)',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: CONTROL_SCRIM,
  },
  librarySpacer: {
    width: 46,
    height: 46,
  },
  libraryThumb: {
    width: '100%',
    height: '100%',
  },
  libraryIconBox: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterRing: {
    width: 70,
    height: 70,
    borderRadius: 35,
    borderWidth: 4,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterCore: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#ffffff',
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderWidth: 1,
    padding: 10,
  },
  errorText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: 'Inter_500Medium',
  },
  primaryBtn: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  primaryBtnText: {
    fontSize: 13.5,
    fontFamily: 'Inter_600SemiBold',
  },
  secondaryBtn: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.4)',
    paddingHorizontal: 16,
  },
  secondaryBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: '#ffffff',
  },
});
