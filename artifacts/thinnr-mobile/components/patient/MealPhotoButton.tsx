/**
 * "Take a photo of your meal" — the shared entry point for photo meal
 * logging, placed at the top of the patient Library and Diary screens (card
 * variant) and under a finished meal-photo reply in the coach chat as the
 * "Retake photo" chip (chip variant). Both entry points run the exact same
 * flow:
 *
 *   tap → camera on device (photo library fallback on web, matching the
 *   menu scan) → use-photo / retake preview → the photo enters the coach
 *   chat as a meal turn (sendPhoto kind "meal") → navigate to the chat,
 *   where the AI streams back what it sees with committed portion
 *   estimates and an editable meal card.
 *
 * Nothing uploads until "Use this photo" is pressed — the preview modal is
 * the send gate. The photo is downscaled/re-encoded on device by the shared
 * photo-prep helper, analyzed in memory server-side, and never stored.
 *
 * Camera-permission denials degrade to the library picker (fallback sheet),
 * so a locked-down device can still log a meal. While a coach reply is
 * already streaming the button disables rather than queueing a second turn.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useRouter, usePathname } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useCoachChat } from '@/context/CoachChatContext';
import { preparePhotoForUpload, type PreparedPhoto } from '@/lib/photo-prep';

/** Soft chip shadow shared with the chat's suggestion chips. */
const CHIP_SHADOW = '0 5px 12px rgba(35, 61, 95, 0.08)';
const CARD_SHADOW = '0 8px 20px rgba(40, 55, 74, 0.07)';

interface MealPhotoButtonProps {
  /**
   * "card": the prominent Library/Diary entry point.
   * "chip": the compact "Retake photo" chip under a coach reply.
   */
  variant: 'card' | 'chip';
  testID: string;
  /** Extra outer styling (e.g. screen-specific margins). */
  style?: object;
}

export function MealPhotoButton({ variant, testID, style }: MealPhotoButtonProps) {
  const colors = useColors();
  const router = useRouter();
  const pathname = usePathname();
  const { sendPhoto, isStreaming } = useCoachChat();

  // The capture flow's modal state: the fallback sheet (camera declined /
  // failed → library option) and the use-photo/retake preview. `photo` set
  // means the preview is up.
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  // Where the current photo came from, so "Retake" relaunches the same
  // source (camera vs library) the patient used.
  const sourceRef = useRef<'camera' | 'library'>('camera');

  // Android/web hear errors via the box's live region; iOS has no live
  // regions, so announce explicitly there.
  useEffect(() => {
    if (error && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(error);
    }
  }, [error]);

  const busy = preparing || isStreaming;

  const usePickedPhoto = async (result: ImagePicker.ImagePickerResult) => {
    if (result.canceled || !result.assets?.[0]) return;
    setPreparing(true);
    try {
      const prepared = await preparePhotoForUpload(result.assets[0]);
      setError(null);
      setFallbackOpen(false);
      setPhoto(prepared);
    } catch (err) {
      console.error('Meal photo preparation failed', err);
      setError('That photo could not be prepared. Please try a different one.');
    } finally {
      setPreparing(false);
    }
  };

  const takePhoto = async () => {
    setError(null);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError('Camera permission was declined. You can still choose a photo from your library.');
      setFallbackOpen(true);
      return;
    }
    sourceRef.current = 'camera';
    try {
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
      await usePickedPhoto(result);
    } catch (err) {
      console.error('Camera launch failed', err);
      setError('The camera could not be opened. Try choosing a photo instead.');
      setFallbackOpen(true);
    }
  };

  const choosePhoto = async () => {
    setError(null);
    if (Platform.OS !== 'web') {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setError('Photo library permission was declined.');
        setFallbackOpen(true);
        return;
      }
    }
    sourceRef.current = 'library';
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
        base64: Platform.OS === 'web',
      });
      await usePickedPhoto(result);
    } catch (err) {
      console.error('Photo library launch failed', err);
      setError('Your photo library could not be opened. Please try again.');
      setFallbackOpen(true);
    }
  };

  const start = () => {
    if (busy) return;
    Haptics.selectionAsync();
    // Camera on device; the web preview has no live capture, so it goes
    // straight to the picker — same fallback the menu scan uses.
    if (Platform.OS === 'web') void choosePhoto();
    else void takePhoto();
  };

  const retake = () => {
    Haptics.selectionAsync();
    setPhoto(null);
    if (sourceRef.current === 'camera' && Platform.OS !== 'web') void takePhoto();
    else void choosePhoto();
  };

  const cancel = () => {
    Haptics.selectionAsync();
    setPhoto(null);
    setFallbackOpen(false);
    setError(null);
  };

  const confirmPhoto = () => {
    if (!photo || isStreaming) return;
    Haptics.selectionAsync();
    sendPhoto(photo, 'meal');
    setPhoto(null);
    setError(null);
    // The chat's own retake chip is already on the thread screen; entry
    // points elsewhere hand over to the conversation.
    if (pathname !== '/coach-chat') router.push('/coach-chat');
  };

  const photoAspect = (p: PreparedPhoto) =>
    Math.min(Math.max(p.width / Math.max(p.height, 1), 0.62), 1.7);

  return (
    <>
      {variant === 'card' ? (
        <Pressable
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel="Take a photo of your meal"
          accessibilityHint="Opens the camera. The AI coach identifies the foods so you can log the meal."
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={start}
          style={({ pressed }) => [
            styles.card,
            {
              backgroundColor: colors.cobalt,
              borderRadius: colors.radius,
              boxShadow: CARD_SHADOW,
            },
            pressed && !busy && { opacity: 0.9 },
            busy && { opacity: 0.6 },
            style,
          ]}
        >
          <View
            style={[
              styles.cardIcon,
              {
                backgroundColor: 'rgba(255, 255, 255, 0.14)',
                borderColor: 'rgba(255, 255, 255, 0.25)',
                borderRadius: colors.radiusSm,
              },
            ]}
          >
            {preparing ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Feather name="camera" size={17} color={colors.primaryForeground} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.cardTitle, { color: colors.primaryForeground }]}>
              Take a photo of your meal
            </Text>
            <Text style={[styles.cardSub, { color: 'rgba(255, 255, 255, 0.75)' }]}>
              {isStreaming
                ? 'The coach is replying — one moment'
                : 'AI reads your plate so you can log it in a tap'}
            </Text>
          </View>
          <Feather name="chevron-right" size={16} color="rgba(255, 255, 255, 0.75)" />
        </Pressable>
      ) : (
        <Pressable
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel="Retake the meal photo"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={start}
          style={({ pressed }) => [
            styles.chip,
            {
              borderColor: colors.activeBorder,
              backgroundColor: colors.activeBg,
              borderRadius: colors.radiusSm,
              boxShadow: CHIP_SHADOW,
            },
            pressed && { backgroundColor: colors.accent },
            busy && { opacity: 0.5 },
            style,
          ]}
        >
          {preparing ? (
            <ActivityIndicator size="small" color={colors.cobalt} />
          ) : (
            <Feather name="camera" size={13} color={colors.cobalt} />
          )}
          <Text style={[styles.chipText, { color: colors.cobalt }]}>Retake photo</Text>
        </Pressable>
      )}

      {/* ── Fallback sheet: camera declined/failed → library option ── */}
      <Modal
        visible={fallbackOpen && photo === null}
        transparent
        animationType="fade"
        onRequestClose={cancel}
      >
        <View style={styles.backdrop}>
          <View
            testID="meal-photo-fallback"
            style={[
              styles.sheet,
              { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
            ]}
          >
            <Text style={[styles.sheetLabel, { color: colors.labelText }]}>MEAL PHOTO</Text>
            {error ? (
              <View
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={[
                  styles.errorBox,
                  { backgroundColor: colors.warnBg, borderColor: colors.warnBorder, borderRadius: colors.radiusSm },
                ]}
              >
                <Feather name="camera-off" size={13} color={colors.warnText} style={{ marginTop: 1 }} />
                <Text style={[styles.errorText, { color: colors.warnText }]}>{error}</Text>
              </View>
            ) : null}
            <Pressable
              testID="meal-photo-choose"
              accessibilityRole="button"
              accessibilityLabel="Choose a photo from your library"
              disabled={preparing}
              onPress={() => void choosePhoto()}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: preparing ? colors.cobaltMuted : colors.cobalt, borderRadius: colors.radiusSm },
                pressed && !preparing && { opacity: 0.88 },
              ]}
            >
              {preparing ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Feather name="image" size={15} color={colors.primaryForeground} />
              )}
              <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                Choose from library
              </Text>
            </Pressable>
            <Pressable
              testID="meal-photo-fallback-cancel"
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={cancel}
              style={({ pressed }) => [
                styles.secondaryBtn,
                { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
              ]}
            >
              <Text style={[styles.secondaryBtnText, { color: colors.navyLight }]}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── Use-photo / retake preview — the send gate ── */}
      <Modal visible={photo !== null} transparent animationType="fade" onRequestClose={cancel}>
        <View style={styles.backdrop}>
          <View
            testID="meal-photo-preview"
            style={[
              styles.sheet,
              { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
            ]}
          >
            <Text style={[styles.sheetLabel, { color: colors.labelText }]}>YOUR MEAL PHOTO</Text>
            {photo ? (
              <Image
                source={{ uri: photo.uri }}
                style={[
                  styles.previewPhoto,
                  {
                    aspectRatio: photoAspect(photo),
                    borderRadius: colors.radiusSm,
                    backgroundColor: colors.paperCardAlt,
                  },
                ]}
                contentFit="cover"
                accessibilityLabel="Preview of your meal photo"
              />
            ) : null}
            <Text style={[styles.sheetHint, { color: colors.subtleText }]}>
              The AI coach will list what it sees with estimated amounts — you can adjust
              everything before logging. Photos are analyzed once, never stored.
            </Text>
            {error ? (
              <View
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={[
                  styles.errorBox,
                  { backgroundColor: colors.riskBg, borderColor: colors.riskBorder, borderRadius: colors.radiusSm },
                ]}
              >
                <Feather name="alert-triangle" size={13} color={colors.riskText} style={{ marginTop: 1 }} />
                <Text style={[styles.errorText, { color: colors.riskText }]}>{error}</Text>
              </View>
            ) : null}
            <Pressable
              testID="meal-photo-use"
              accessibilityRole="button"
              accessibilityLabel="Use this photo"
              accessibilityState={{ disabled: isStreaming }}
              disabled={isStreaming}
              onPress={confirmPhoto}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: isStreaming ? colors.cobaltMuted : colors.cobalt, borderRadius: colors.radiusSm },
                pressed && !isStreaming && { opacity: 0.88 },
              ]}
            >
              <Feather name="send" size={14} color={colors.primaryForeground} />
              <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                Use this photo
              </Text>
            </Pressable>
            <Pressable
              testID="meal-photo-retake"
              accessibilityRole="button"
              accessibilityLabel={
                sourceRef.current === 'camera' && Platform.OS !== 'web'
                  ? 'Retake the photo'
                  : 'Choose a different photo'
              }
              disabled={preparing}
              onPress={retake}
              style={({ pressed }) => [
                styles.secondaryBtn,
                { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
              ]}
            >
              {preparing ? <ActivityIndicator size="small" color={colors.navyLight} /> : null}
              <Text style={[styles.secondaryBtnText, { color: colors.navyLight }]}>
                {sourceRef.current === 'camera' && Platform.OS !== 'web' ? 'Retake' : 'Choose a different photo'}
              </Text>
            </Pressable>
            <Pressable
              testID="meal-photo-cancel"
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={cancel}
              hitSlop={6}
              style={({ pressed }) => [styles.cancelLink, pressed && { opacity: 0.7 }]}
            >
              <Text style={[styles.cancelLinkText, { color: colors.subtleText }]}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  cardIcon: {
    width: 38,
    height: 38,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: 14.5,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.1,
  },
  cardSub: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 7,
    borderWidth: 1,
    paddingVertical: 9,
    paddingHorizontal: 14,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(23, 32, 46, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  sheetLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  sheetHint: {
    fontSize: 11.5,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
  },
  previewPhoto: {
    width: '100%',
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
    paddingHorizontal: 16,
  },
  secondaryBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  cancelLink: {
    alignSelf: 'center',
    minHeight: 24,
    justifyContent: 'center',
  },
  cancelLinkText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
});
