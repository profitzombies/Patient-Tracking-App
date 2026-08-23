/**
 * Menu Scan — photograph a restaurant menu and get AI guidance on what can
 * be ordered under the THINNR program, and exactly how to ask for it.
 *
 * The patient takes a photo (native) or picks one from their library (web
 * fallback + native option), previews it, and starts the scan. The photo is
 * downscaled and re-encoded as JPEG on device, sent once to
 * POST /api/coach/menu-scan, analyzed in memory, and never stored anywhere.
 *
 * Everything shown here is AI guidance in the model's own words — grounded
 * server-side in the official program materials but never presented as
 * official program copy. The results view says so explicitly and links to
 * the official Approved list via the shared APPROVED_FOODS_HREF constant.
 *
 * Failure states keep the chosen photo so retry is one tap: unreadable and
 * non-menu photos come back as announced notices, transport/AI failures as
 * announced errors (same alert-role + live-region + iOS-announce trio as the
 * onboarding ErrorBox), and a mid-scan cancel simply returns to the preview.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Redirect, router, usePathname } from 'expo-router';
import { LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { APPROVED_FOODS_HREF } from '@/constants/links';
import { useAppMode } from '@/context/AppModeContext';
import { useColors } from '@/hooks/useColors';
import { MenuScanError, scanMenuPhoto, type MenuScanResult } from '@/lib/coach-api';
import { preparePhotoForUpload, type PreparedPhoto } from '@/lib/photo-prep';

type Phase =
  | { kind: 'pick' }
  | { kind: 'preview'; photo: PreparedPhoto }
  | { kind: 'scanning'; photo: PreparedPhoto }
  /** Transport/AI failure — retry reuses the kept photo. */
  | { kind: 'error'; photo: PreparedPhoto; message: string }
  /** The AI answered, but the photo was not a readable menu. */
  | { kind: 'notice'; photo: PreparedPhoto; result: MenuScanResult }
  | { kind: 'results'; photo: PreparedPhoto; result: MenuScanResult };

export default function MenuScanScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { mode, hydrated: modeHydrated } = useAppMode();

  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [pickError, setPickError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Abandon any in-flight scan when the screen unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Android/web hear the status text via its live region; iOS has no live
  // regions, so the wait is announced explicitly when scanning starts.
  useEffect(() => {
    if (phase.kind === 'scanning' && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(
        'Scanning the menu photo. This can take about half a minute.',
      );
    }
  }, [phase.kind]);

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 32 : insets.bottom + 24;

  // Patient-only route: deep links must not bypass the persona flow. The
  // guard is gated on the active pathname so it can't hijack navigation
  // while this screen unmounts.
  if (!modeHydrated) return null;
  if (pathname === '/menu-scan' && mode !== 'patient') {
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const goBack = () => {
    abortRef.current?.abort();
    if (router.canGoBack()) router.back();
    else router.replace('/restaurant-guide');
  };

  const usePickedPhoto = async (result: ImagePicker.ImagePickerResult) => {
    if (result.canceled || !result.assets?.[0]) return;
    setPreparing(true);
    try {
      const photo = await preparePhotoForUpload(result.assets[0]);
      setPickError(null);
      setPhase({ kind: 'preview', photo });
    } catch (error) {
      console.error('Menu photo preparation failed', error);
      setPickError('That photo could not be prepared. Please try a different one.');
    } finally {
      setPreparing(false);
    }
  };

  const takePhoto = async () => {
    Haptics.selectionAsync();
    setPickError(null);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setPickError('Camera permission was declined. You can still choose a photo from your library.');
      return;
    }
    try {
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
      await usePickedPhoto(result);
    } catch (error) {
      console.error('Camera launch failed', error);
      setPickError('The camera could not be opened. Try choosing a photo instead.');
    }
  };

  const choosePhoto = async () => {
    Haptics.selectionAsync();
    setPickError(null);
    if (Platform.OS !== 'web') {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setPickError('Photo library permission was declined.');
        return;
      }
    }
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
        base64: Platform.OS === 'web',
      });
      await usePickedPhoto(result);
    } catch (error) {
      console.error('Photo library launch failed', error);
      setPickError('Your photo library could not be opened. Please try again.');
    }
  };

  const startScan = useCallback(async (photo: PreparedPhoto) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: 'scanning', photo });
    try {
      const result = await scanMenuPhoto(photo.uri, { signal: controller.signal });
      if (controller.signal.aborted) return;
      Haptics.notificationAsync(
        result.result === 'ok'
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning,
      );
      setPhase(
        result.result === 'ok'
          ? { kind: 'results', photo, result }
          : { kind: 'notice', photo, result },
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof Error && error.name === 'AbortError') return;
      const message =
        error instanceof MenuScanError
          ? error.message
          : 'The menu scan is unavailable right now. Please try again.';
      setPhase({ kind: 'error', photo, message });
    }
  }, []);

  const cancelScan = (photo: PreparedPhoto) => {
    Haptics.selectionAsync();
    abortRef.current?.abort();
    setPhase({ kind: 'preview', photo });
  };

  const changePhoto = () => {
    Haptics.selectionAsync();
    setPhase({ kind: 'pick' });
  };

  const openApprovedList = () => {
    Haptics.selectionAsync();
    router.push(APPROVED_FOODS_HREF);
  };

  const photoAspect = (photo: PreparedPhoto) =>
    Math.min(Math.max(photo.width / Math.max(photo.height, 1), 0.62), 1.7);

  const renderPhotoCard = (photo: PreparedPhoto, dimmed = false) => (
    <LedgerCard style={styles.photoCard}>
      <Image
        source={{ uri: photo.uri }}
        style={[
          styles.photo,
          { aspectRatio: photoAspect(photo), backgroundColor: colors.paperCardAlt },
          dimmed && { opacity: 0.45 },
        ]}
        contentFit="cover"
        accessibilityLabel="Your menu photo"
      />
    </LedgerCard>
  );

  const disclaimer = (
    <View
      testID="menu-scan-disclaimer"
      style={[
        styles.disclaimer,
        { backgroundColor: colors.accent, borderColor: colors.activeBorder, borderRadius: colors.radiusSm },
      ]}
    >
      <View style={styles.disclaimerHead}>
        <MaterialCommunityIcons name="creation" size={13} color={colors.cobalt} />
        <Text style={[styles.disclaimerLabel, { color: colors.cobalt }]}>AI GUIDANCE</Text>
      </View>
      <Text style={[styles.disclaimerBody, { color: colors.bodyText }]}>
        These suggestions were read from your photo by AI — they are not official program
        wording. When in doubt, check the official Approved list.
      </Text>
      <Pressable
        testID="menu-scan-approved-link"
        accessibilityRole="button"
        accessibilityLabel="Open the official Approved list"
        onPress={openApprovedList}
        hitSlop={6}
        style={styles.disclaimerLink}
      >
        <Text style={[styles.disclaimerLinkText, { color: colors.cobalt }]}>
          Open the Approved list
        </Text>
        <Feather name="chevron-right" size={13} color={colors.cobalt} />
      </Pressable>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={{ paddingTop: topPad + 8, paddingBottom: bottomPad }}>
        <View style={styles.headerRow}>
          <Pressable
            testID="menu-scan-back-btn"
            accessibilityRole="button"
            accessibilityLabel="Go back"
            onPress={goBack}
            hitSlop={8}
            style={({ pressed }) => [
              styles.backBtn,
              {
                borderColor: colors.border,
                backgroundColor: pressed ? colors.accent : colors.card,
                borderRadius: colors.radiusSm,
              },
            ]}
          >
            <Feather name="arrow-left" size={17} color={colors.navy} />
          </Pressable>
          <Text style={[styles.title, { color: colors.navy }]}>Scan a Menu</Text>
        </View>

        {phase.kind === 'pick' && (
          <>
            <Text style={[styles.intro, { color: colors.bodyText }]}>
              At a restaurant? Photograph the menu and get AI guidance on which dishes can
              work — and exactly how to ask for them.
            </Text>
            {pickError !== null && (
              <AnnouncedBox tone="risk" message={pickError} testID="menu-scan-pick-error" />
            )}
            <LedgerCard accentTop style={styles.actionCard}>
              <View style={styles.actionCardInner}>
                <View style={[styles.bigIcon, { backgroundColor: colors.accent, borderColor: colors.border, borderRadius: colors.radiusSm }]}>
                  <Feather name="camera" size={22} color={colors.cobalt} />
                </View>
                {Platform.OS !== 'web' && (
                  <PrimaryButton
                    testID="menu-scan-take"
                    label="Take a photo"
                    icon="camera"
                    disabled={preparing}
                    onPress={takePhoto}
                  />
                )}
                {Platform.OS === 'web' ? (
                  <PrimaryButton
                    testID="menu-scan-choose"
                    label="Choose a menu photo"
                    icon="image"
                    disabled={preparing}
                    onPress={choosePhoto}
                  />
                ) : (
                  <SecondaryButton
                    testID="menu-scan-choose"
                    label="Choose from library"
                    disabled={preparing}
                    onPress={choosePhoto}
                  />
                )}
                {preparing && (
                  <View style={styles.preparingRow}>
                    <ActivityIndicator size="small" color={colors.cobalt} />
                    <Text style={[styles.preparingText, { color: colors.subtleText }]}>
                      Preparing photo…
                    </Text>
                  </View>
                )}
              </View>
            </LedgerCard>
            <Text style={[styles.finePrint, { color: colors.subtleText }]}>
              Photos are analyzed once to build your guidance, then discarded — never stored.
              Results are AI guidance, with the official Approved list one tap away.
            </Text>
          </>
        )}

        {phase.kind === 'preview' && (
          <>
            {renderPhotoCard(phase.photo)}
            <View style={styles.buttonStack}>
              <PrimaryButton
                testID="menu-scan-start"
                label="Scan this menu"
                icon="search"
                onPress={() => startScan(phase.photo)}
              />
              <SecondaryButton
                testID="menu-scan-change-photo"
                label="Choose a different photo"
                onPress={changePhoto}
              />
            </View>
          </>
        )}

        {phase.kind === 'scanning' && (
          <>
            {renderPhotoCard(phase.photo, true)}
            <LedgerCard style={styles.statusCard} testID="menu-scan-progress">
              <View style={styles.statusInner}>
                <ActivityIndicator size="small" color={colors.cobalt} />
                <View style={{ flex: 1 }}>
                  <Text
                    accessibilityLiveRegion="polite"
                    style={[styles.statusTitle, { color: colors.navyLight }]}
                  >
                    Reading the menu…
                  </Text>
                  <Text style={[styles.statusMeta, { color: colors.subtleText }]}>
                    Checking each dish against the program's rules. This can take about half a
                    minute.
                  </Text>
                </View>
              </View>
            </LedgerCard>
            <View style={styles.buttonStack}>
              <SecondaryButton
                testID="menu-scan-cancel"
                label="Cancel"
                onPress={() => cancelScan(phase.photo)}
              />
            </View>
          </>
        )}

        {phase.kind === 'error' && (
          <>
            {renderPhotoCard(phase.photo)}
            <AnnouncedBox tone="risk" message={phase.message} testID="menu-scan-error" />
            <View style={styles.buttonStack}>
              <PrimaryButton
                testID="menu-scan-retry"
                label="Try again"
                icon="refresh-cw"
                onPress={() => startScan(phase.photo)}
              />
              <SecondaryButton
                testID="menu-scan-change-photo"
                label="Choose a different photo"
                onPress={changePhoto}
              />
            </View>
          </>
        )}

        {phase.kind === 'notice' && (
          <>
            {renderPhotoCard(phase.photo)}
            <AnnouncedBox tone="warn" message={phase.result.message} testID="menu-scan-notice" />
            <View style={styles.buttonStack}>
              <PrimaryButton
                testID="menu-scan-change-photo"
                label="Choose a different photo"
                icon="image"
                onPress={changePhoto}
              />
              <SecondaryButton
                testID="menu-scan-retry"
                label="Scan the same photo again"
                onPress={() => startScan(phase.photo)}
              />
            </View>
          </>
        )}

        {phase.kind === 'results' && (
          <View testID="menu-scan-results">
            <LedgerCard accentTop style={styles.summaryCard}>
              <View style={styles.summaryInner}>
                <View style={styles.summaryRow}>
                  <Image
                    source={{ uri: phase.photo.uri }}
                    style={[styles.summaryThumb, { backgroundColor: colors.paperCardAlt, borderColor: colors.border, borderRadius: colors.radiusSm }]}
                    contentFit="cover"
                    accessibilityLabel="Your menu photo"
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.summaryTitle, { color: colors.navy }]}>
                      {phase.result.menuTitle ?? 'Menu scanned'}
                    </Text>
                    <Text style={[styles.summaryMeta, { color: colors.subtleText }]}>
                      {phase.result.order.length === 1
                        ? '1 dish can work'
                        : `${phase.result.order.length} dishes can work`}
                      {phase.result.avoid.length > 0
                        ? ` · ${phase.result.avoid.length} to avoid`
                        : ''}
                    </Text>
                  </View>
                </View>
                <Text style={[styles.summaryMessage, { color: colors.bodyText }]}>
                  {phase.result.message}
                </Text>
              </View>
            </LedgerCard>

            {disclaimer}

            <SectionHeader label="What can work" style={styles.sectionHeader} />
            {phase.result.order.length === 0 ? (
              <LedgerCard>
                <Text style={[styles.emptyText, { color: colors.subtleText }]}>
                  No dish on this menu could be matched to the program as printed.
                </Text>
              </LedgerCard>
            ) : (
              <View style={styles.dishList}>
                {phase.result.order.map((dish, index) => (
                  <LedgerCard key={`${dish.name}-${index}`} testID={`menu-scan-dish-${index}`}>
                    <View style={styles.dishInner}>
                      <View style={styles.dishHead}>
                        <View style={[styles.dishIndex, { backgroundColor: colors.accent, borderColor: colors.border, borderRadius: colors.radiusSm }]}>
                          <Text style={[styles.dishIndexText, { color: colors.cobalt }]}>
                            {String(index + 1).padStart(2, '0')}
                          </Text>
                        </View>
                        <Text style={[styles.dishName, { color: colors.navyLight }]}>
                          {dish.name}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.askBlock,
                          { borderLeftColor: colors.cobalt, backgroundColor: colors.paperCardAlt },
                        ]}
                      >
                        <Text style={[styles.askLabel, { color: colors.labelText }]}>
                          HOW TO ASK
                        </Text>
                        <Text style={[styles.askText, { color: colors.bodyText }]}>
                          {dish.howToOrder}
                        </Text>
                      </View>
                      {dish.note ? (
                        <View style={styles.noteRow}>
                          <Feather name="info" size={12} color={colors.subtleText} style={styles.noteIcon} />
                          <Text style={[styles.noteText, { color: colors.subtleText }]}>
                            {dish.note}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </LedgerCard>
                ))}
              </View>
            )}

            {phase.result.avoid.length > 0 && (
              <>
                <SectionHeader label="Steer clear of" style={styles.sectionHeader} />
                <LedgerCard testID="menu-scan-avoid">
                  <View style={styles.avoidInner}>
                    {phase.result.avoid.map((dish, index) => (
                      <View
                        key={`${dish.name}-${index}`}
                        style={[
                          styles.avoidRow,
                          index > 0 && { borderTopWidth: 1, borderTopColor: colors.divider },
                        ]}
                      >
                        <Feather name="x-circle" size={14} color={colors.riskText} style={styles.avoidIcon} />
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.avoidName, { color: colors.navyLight }]}>
                            {dish.name}
                          </Text>
                          <Text style={[styles.avoidReason, { color: colors.subtleText }]}>
                            {dish.reason}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </LedgerCard>
              </>
            )}

            <View style={styles.buttonStack}>
              <SecondaryButton
                testID="menu-scan-again"
                label="Scan another menu"
                onPress={changePhoto}
              />
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─── Announced message box (same trio as the onboarding ErrorBox) ────────────

/**
 * Self-announcing message box: alert role + polite live region cover
 * Android/web, and iOS (no live regions) gets an explicit announcement when
 * the message appears or changes. Never nested inside another live region.
 */
function AnnouncedBox({
  tone,
  message,
  testID,
}: {
  tone: 'risk' | 'warn';
  message: string;
  testID?: string;
}) {
  const colors = useColors();

  useEffect(() => {
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [message]);

  const palette =
    tone === 'risk'
      ? { bg: colors.riskBg, border: colors.riskBorder, text: colors.riskText }
      : { bg: colors.warnBg, border: colors.warnBorder, text: colors.warnText };

  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[
        styles.announceBox,
        { backgroundColor: palette.bg, borderColor: palette.border, borderRadius: colors.radiusSm },
      ]}
    >
      <Feather
        name={tone === 'risk' ? 'alert-triangle' : 'camera-off'}
        size={14}
        color={palette.text}
        style={styles.announceIcon}
      />
      <Text style={[styles.announceText, { color: palette.text }]}>{message}</Text>
    </View>
  );
}

// ─── Buttons ─────────────────────────────────────────────────────────────────

function PrimaryButton({
  label,
  onPress,
  icon,
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  icon?: React.ComponentProps<typeof Feather>['name'];
  disabled?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        {
          backgroundColor: disabled ? colors.cobaltMuted : colors.cobalt,
          borderRadius: colors.radiusSm,
        },
        pressed && !disabled && { opacity: 0.88 },
      ]}
    >
      {icon ? <Feather name={icon} size={15} color={colors.primaryForeground} /> : null}
      <Text style={[styles.btnText, { color: colors.primaryForeground }]}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({
  label,
  onPress,
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        {
          backgroundColor: pressed ? colors.accent : colors.card,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: colors.radiusSm,
        },
        disabled && { opacity: 0.55 },
      ]}
    >
      <Text style={[styles.btnText, { color: colors.navyLight }]}>{label}</Text>
    </Pressable>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
  },
  backBtn: {
    width: 32,
    height: 32,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 22,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.2,
  },
  intro: {
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
    paddingHorizontal: 16,
    marginTop: 10,
    marginBottom: 4,
  },
  actionCard: {
    marginTop: 12,
  },
  actionCardInner: {
    padding: 20,
    alignItems: 'stretch',
    gap: 10,
  },
  bigIcon: {
    width: 44,
    height: 44,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 4,
  },
  preparingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 2,
  },
  preparingText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  finePrint: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
    paddingHorizontal: 16,
    marginTop: 10,
  },
  photoCard: {
    marginTop: 12,
  },
  photo: {
    width: '100%',
  },
  buttonStack: {
    paddingHorizontal: 16,
    marginTop: 12,
    gap: 8,
  },
  btn: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 18,
  },
  btnText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  statusCard: {
    marginTop: 12,
  },
  statusInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
  },
  statusTitle: {
    fontSize: 14.5,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  statusMeta: {
    fontSize: 11.5,
    lineHeight: 16,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  announceBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderWidth: 1,
    padding: 12,
    marginHorizontal: 16,
    marginTop: 12,
  },
  announceIcon: {
    marginTop: 1,
  },
  announceText: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: 'Inter_500Medium',
  },
  summaryCard: {
    marginTop: 12,
  },
  summaryInner: {
    padding: 16,
    gap: 12,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  summaryThumb: {
    width: 52,
    height: 52,
    borderWidth: 1,
  },
  summaryTitle: {
    fontSize: 17,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.2,
  },
  summaryMeta: {
    fontSize: 11.5,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  summaryMessage: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: 'Inter_400Regular',
  },
  disclaimer: {
    borderWidth: 1,
    marginHorizontal: 16,
    marginTop: 8,
    padding: 12,
    gap: 6,
  },
  disclaimerHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  disclaimerLabel: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1.2,
  },
  disclaimerBody: {
    fontSize: 12,
    lineHeight: 17,
    fontFamily: 'Inter_400Regular',
  },
  disclaimerLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    alignSelf: 'flex-start',
    minHeight: 24,
  },
  disclaimerLinkText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  sectionHeader: {
    marginTop: 18,
    marginBottom: 8,
    paddingHorizontal: 16,
  },
  dishList: {
    gap: 8,
  },
  dishInner: {
    padding: 16,
    gap: 10,
  },
  dishHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dishIndex: {
    width: 28,
    height: 28,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dishIndexText: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.4,
  },
  dishName: {
    flex: 1,
    fontSize: 15.5,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.1,
  },
  askBlock: {
    borderLeftWidth: 3,
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 3,
  },
  askLabel: {
    fontSize: 9.5,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1.1,
  },
  askText: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: 'Inter_400Regular',
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  noteIcon: {
    marginTop: 2,
  },
  noteText: {
    flex: 1,
    fontSize: 11.5,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
  },
  avoidInner: {
    paddingHorizontal: 16,
  },
  avoidRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 12,
  },
  avoidIcon: {
    marginTop: 2,
  },
  avoidName: {
    fontSize: 13.5,
    fontFamily: 'Inter_600SemiBold',
  },
  avoidReason: {
    fontSize: 11.5,
    lineHeight: 16,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  emptyText: {
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
    padding: 16,
  },
});
