/**
 * Barcode Scan — log a packaged food to ONE diary meal by scanning (or
 * typing) the number under its barcode. Opened from the diary meal card's
 * barcode chip with `{ date, meal }`, so everything found here logs to that
 * slot on that day.
 *
 * Two capture paths, one lookup:
 * - Native with camera permission: live EAN-13/EAN-8/UPC-A/UPC-E detection
 *   in an embedded viewfinder, debounced so one steady frame can't fire a
 *   burst of duplicate lookups.
 * - Everywhere (and the ONLY path on web or when permission is denied):
 *   type the number printed under the bars. Same normalizer, same lookup.
 *
 * The lookup itself goes through the API server (lib/barcode-food.ts):
 * shared nutrition-facts table first, Open Food Facts only on a miss —
 * published per-serving values only, never estimates. A found product shows
 * a confirm card (name, brand, serving, calories, macros) with the same
 * half-step serving stepper as the chat's label card; Add runs the exact
 * label-flow path — save a per-serving custom food to "My Foods", then log
 * quantity × per-serving to the bound meal — so editing, undo, and the
 * library treat it like any other custom food. Unknown codes and products
 * without a usable panel get an honest message that points to the label
 * scanner instead; nutrition numbers are never invented.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Redirect, router, useLocalSearchParams, usePathname } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { Divider, LedgerCard } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import { usePatient } from '@/context/PatientContext';
import { formatQty } from '@/data/diary-entries';
import { MEAL_LABELS, MEAL_SLOTS, TODAY_KEY, type MealSlot } from '@/data/patient-data';
import {
  BarcodeLookupError,
  buildBarcodeDiaryEntry,
  buildCustomFoodFromBarcode,
  lookupBarcode,
  normalizeScannedBarcode,
  normalizeTypedBarcode,
  type BarcodeFood,
} from '@/lib/barcode-food';

/** Same serving stepper bounds as the chat's label food card. */
const QTY_MIN = 0.5;
const QTY_MAX = 10;

/** Ignore repeat camera detections of the same code inside this window. */
const SCAN_REPEAT_MS = 2500;

const LOOKUP_FALLBACK_ERROR = 'The barcode lookup is unavailable right now. Please try again.';
const INPUT_ERROR = 'Enter the 8, 12, or 13 digit number printed under the bars.';

type Phase =
  | { kind: 'scan' }
  | { kind: 'looking'; code: string }
  | { kind: 'found'; food: BarcodeFood }
  /** Add ran: food saved to My Foods and the entry logged. Card freezes. */
  | { kind: 'added'; food: BarcodeFood; quantity: number }
  | { kind: 'not_found'; message: string; code: string }
  | { kind: 'error'; message: string; code: string };

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
        name={tone === 'risk' ? 'alert-triangle' : 'search'}
        size={14}
        color={palette.text}
        style={styles.announceIcon}
      />
      <Text style={[styles.announceText, { color: palette.text }]}>{message}</Text>
    </View>
  );
}

function ActionButton({
  testID,
  label,
  icon,
  primary,
  disabled,
  onPress,
}: {
  testID: string;
  label: string;
  icon?: React.ComponentProps<typeof Feather>['name'];
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        {
          borderColor: primary ? colors.cobalt : colors.border,
          backgroundColor: primary ? (disabled ? colors.cobaltMuted : colors.cobalt) : colors.background,
          borderRadius: colors.radiusSm,
          opacity: disabled && !primary ? 0.5 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {icon && (
        <Feather name={icon} size={13} color={primary ? colors.primaryForeground : colors.cobalt} />
      )}
      <Text
        style={[
          styles.actionButtonText,
          { color: primary ? colors.primaryForeground : colors.cobalt },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export default function BarcodeScanScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const pathname = usePathname();
  const params = useLocalSearchParams<{ date?: string; meal?: string }>();

  const dateKey =
    typeof params.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
      ? params.date
      : TODAY_KEY;
  const meal: MealSlot = MEAL_SLOTS.includes(params.meal as MealSlot)
    ? (params.meal as MealSlot)
    : 'snacks';

  const [phase, setPhase] = useState<Phase>({ kind: 'scan' });
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [saving, setSaving] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scanGateRef = useRef<{ code: string; at: number } | null>(null);
  // The camera callback fires outside React's render cycle — read the
  // current phase through a ref so a stale closure can't double-fire.
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const [permission, requestPermission] = useCameraPermissions();
  const askedPermissionRef = useRef(false);
  useEffect(() => {
    if (Platform.OS === 'web' || !permission) return;
    if (!permission.granted && permission.canAskAgain && !askedPermissionRef.current) {
      askedPermissionRef.current = true;
      void requestPermission();
    }
  }, [permission, requestPermission]);

  // Abandon any in-flight lookup when the screen unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Android/web hear status changes via live regions; iOS has none, so the
  // wait and the found result are announced explicitly. Misses and errors
  // announce through their boxes.
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    if (phase.kind === 'looking') {
      AccessibilityInfo.announceForAccessibility('Looking up that barcode.');
    } else if (phase.kind === 'found') {
      AccessibilityInfo.announceForAccessibility(
        `Found ${phase.food.name}. Review the nutrition facts, then add it to ${MEAL_LABELS[meal]}.`,
      );
    }
  }, [phase, meal]);

  const startLookup = useCallback(async (code: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setInputError(null);
    setPhase({ kind: 'looking', code });
    try {
      const outcome = await lookupBarcode(code, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (outcome.result === 'found') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setQty(1);
        setPhase({ kind: 'found', food: outcome.food });
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setPhase({ kind: 'not_found', message: outcome.message, code });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof Error && error.name === 'AbortError') return;
      const message =
        error instanceof BarcodeLookupError ? error.message : LOOKUP_FALLBACK_ERROR;
      setPhase({ kind: 'error', message, code });
    }
  }, []);

  const handleBarcodeScanned = ({ data, type }: { data: string; type: string }) => {
    if (phaseRef.current.kind !== 'scan') return;
    const code = normalizeScannedBarcode(String(data ?? ''), type);
    if (!code) return;
    const now = Date.now();
    const gate = scanGateRef.current;
    if (gate && gate.code === code && now - gate.at < SCAN_REPEAT_MS) return;
    scanGateRef.current = { code, at: now };
    Haptics.selectionAsync();
    void startLookup(code);
  };

  const submitManual = () => {
    if (phase.kind === 'looking' || saving) return;
    const code = normalizeTypedBarcode(input);
    if (!code) {
      setInputError(INPUT_ERROR);
      return;
    }
    Haptics.selectionAsync();
    void startLookup(code);
  };

  const cancelLookup = () => {
    Haptics.selectionAsync();
    abortRef.current?.abort();
    setPhase({ kind: 'scan' });
  };

  /** Back to a clean scanner: keep the meal binding, drop the last result. */
  const scanAnother = () => {
    Haptics.selectionAsync();
    abortRef.current?.abort();
    scanGateRef.current = null;
    setInput('');
    setInputError(null);
    setQty(1);
    setPhase({ kind: 'scan' });
  };

  const stepQty = (delta: number) => {
    Haptics.selectionAsync();
    setQty(q => Math.min(QTY_MAX, Math.max(QTY_MIN, Math.round((q + delta) * 2) / 2)));
  };

  const add = async () => {
    if (saving || phase.kind !== 'found') return;
    setSaving(true);
    try {
      // The same two steps the label flow runs: create the reusable custom
      // food (always per-serving), then log the stepped number of servings
      // to THIS screen's bound meal and day.
      const food = await patient.addCustomFood(buildCustomFoodFromBarcode(phase.food));
      await patient.addEntry(buildBarcodeDiaryEntry(food, meal, dateKey, qty));
      if (Platform.OS === 'ios') {
        AccessibilityInfo.announceForAccessibility(
          `Added to ${MEAL_LABELS[meal]} and saved to My Foods.`,
        );
      }
      setPhase({ kind: 'added', food: phase.food, quantity: qty });
    } finally {
      setSaving(false);
    }
  };

  const goBack = () => {
    abortRef.current?.abort();
    if (router.canGoBack()) router.back();
    else router.replace('/diary');
  };

  const openLabelScanner = () => {
    Haptics.selectionAsync();
    // Replace, not push: back from create-food should land on the diary,
    // not on a stale scanner result.
    router.replace('/create-food');
  };

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 20 : Math.max(insets.bottom, 16);

  // Patient-only route: deep links must not bypass the persona flow. The
  // redirect is gated on pathname so it never hijacks in-flight navigation.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    if (pathname !== '/barcode-scan') return null;
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const cameraLive = Platform.OS !== 'web' && permission?.granted === true;
  const cameraDenied =
    Platform.OS !== 'web' && permission != null && !permission.granted && !permission.canAskAgain;
  const resultFood = phase.kind === 'found' || phase.kind === 'added' ? phase.food : null;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Header ── */}
      <View
        style={[
          styles.header,
          { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt },
        ]}
      >
        <Pressable
          testID="barcode-cancel"
          accessibilityRole="button"
          accessibilityLabel="Close the barcode scanner"
          onPress={goBack}
          hitSlop={8}
        >
          <Text style={[styles.headerAction, { color: colors.cobalt }]}>Cancel</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.navy }]}>Scan a Barcode</Text>
          <Text style={[styles.headerSub, { color: colors.subtleText }]}>
            {`LOGS TO ${MEAL_LABELS[meal].toUpperCase()}`}
          </Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
      >
        {/* ── Live viewfinder (native with permission) ── */}
        {cameraLive && (
          <View
            style={[styles.cameraShell, { borderColor: colors.border, borderRadius: colors.radiusSm }]}
            testID="barcode-camera"
          >
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e'] }}
              onBarcodeScanned={phase.kind === 'scan' ? handleBarcodeScanned : undefined}
            />
            <View style={[styles.reticleWrap, { pointerEvents: 'none' }]}>
              <View style={styles.reticle} />
              <Text style={styles.cameraHint}>
                {phase.kind === 'scan'
                  ? 'Center the barcode in the frame'
                  : 'Scanning paused while this result is open'}
              </Text>
            </View>
          </View>
        )}

        {/* ── Permission denied for good (native): typing still works ── */}
        {cameraDenied && (
          <LedgerCard style={styles.sectionCard} testID="barcode-camera-denied">
            <View style={styles.deniedRow}>
              <Feather name="camera-off" size={14} color={colors.subtleText} />
              <Text style={[styles.deniedText, { color: colors.subtleText }]}>
                Camera access is off, so live scanning is unavailable. Typing the number below
                works exactly the same. To scan live, allow camera access in your device
                settings.
              </Text>
            </View>
          </LedgerCard>
        )}

        {/* ── Manual entry — the path that always works ── */}
        <LedgerCard accentTop style={styles.sectionCard}>
          <Text style={[styles.sectionLabel, { color: colors.labelText }]}>
            {cameraLive ? 'OR TYPE THE NUMBER' : 'TYPE THE NUMBER'}
          </Text>
          <Text style={[styles.sectionSub, { color: colors.subtleText }]}>
            {Platform.OS === 'web'
              ? 'Live camera scanning runs on your phone. Here, enter the number printed under the bars.'
              : 'Enter the number printed under the bars.'}
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              testID="barcode-input"
              value={input}
              onChangeText={value => {
                setInput(value.replace(/[^0-9\s-]/g, ''));
                if (inputError) setInputError(null);
              }}
              onSubmitEditing={submitManual}
              returnKeyType="search"
              inputMode="numeric"
              keyboardType={Platform.OS === 'web' ? undefined : 'number-pad'}
              placeholder="e.g. 3017624010701"
              placeholderTextColor={colors.subtleText}
              accessibilityLabel="Barcode number"
              editable={phase.kind !== 'looking' && !saving}
              style={[
                styles.input,
                {
                  borderColor: colors.border,
                  color: colors.foreground,
                  backgroundColor: colors.background,
                  borderRadius: colors.radiusSm,
                },
              ]}
            />
            <Pressable
              testID="barcode-submit"
              accessibilityRole="button"
              accessibilityLabel="Look up this barcode"
              disabled={phase.kind === 'looking' || saving}
              onPress={submitManual}
              style={({ pressed }) => [
                styles.lookupButton,
                {
                  backgroundColor:
                    phase.kind === 'looking' || saving ? colors.cobaltMuted : colors.cobalt,
                  borderRadius: colors.radiusSm,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text style={[styles.lookupButtonText, { color: colors.primaryForeground }]}>
                Look up
              </Text>
            </Pressable>
          </View>
          {inputError !== null && (
            <AnnouncedBox tone="risk" message={inputError} testID="barcode-input-error" />
          )}
        </LedgerCard>

        {/* ── Lookup in flight ── */}
        {phase.kind === 'looking' && (
          <LedgerCard style={styles.sectionCard} testID="barcode-looking">
            <View style={styles.statusRow}>
              <ActivityIndicator size="small" color={colors.cobalt} />
              <Text
                accessibilityLiveRegion="polite"
                style={[styles.statusText, { color: colors.navyLight }]}
              >
                {`Checking barcode ${phase.code}…`}
              </Text>
            </View>
            <View style={styles.buttonStack}>
              <ActionButton testID="barcode-lookup-cancel" label="Cancel" onPress={cancelLookup} />
            </View>
          </LedgerCard>
        )}

        {/* ── Found: confirm card ── */}
        {resultFood && (
          <LedgerCard accentTop style={styles.sectionCard} testID="barcode-result">
            <Text style={[styles.resultTag, { color: colors.cobalt }]}>PACKAGED FOOD</Text>
            <Text style={[styles.foodName, { color: colors.navy }]} numberOfLines={2}>
              {resultFood.name}
            </Text>
            {!!resultFood.brand && (
              <Text style={[styles.foodBrand, { color: colors.subtleText }]}>{resultFood.brand}</Text>
            )}
            <Text style={[styles.foodFacts, { color: colors.bodyText }]}>
              {`Per ${resultFood.serving} · ${Math.round(resultFood.calories)} cal · P ${resultFood.protein}g · C ${resultFood.carbs}g · F ${resultFood.fat}g`}
            </Text>
            <Divider />
            {phase.kind === 'found' && (
              <>
                <View style={styles.qtyRow}>
                  <Pressable
                    testID="barcode-qty-minus"
                    accessibilityRole="button"
                    accessibilityLabel="Fewer servings"
                    disabled={qty <= QTY_MIN}
                    onPress={() => stepQty(-0.5)}
                    style={[
                      styles.qtyButton,
                      {
                        borderColor: colors.border,
                        borderRadius: colors.radiusSm,
                        opacity: qty <= QTY_MIN ? 0.35 : 1,
                      },
                    ]}
                  >
                    <Feather name="minus" size={13} color={colors.bodyText} />
                  </Pressable>
                  <Text
                    testID="barcode-qty"
                    accessibilityLabel={`${formatQty(qty)} ${qty === 1 ? 'serving' : 'servings'}`}
                    style={[styles.qtyValue, { color: colors.navy }]}
                  >
                    {formatQty(qty)}
                  </Text>
                  <Pressable
                    testID="barcode-qty-plus"
                    accessibilityRole="button"
                    accessibilityLabel="More servings"
                    disabled={qty >= QTY_MAX}
                    onPress={() => stepQty(0.5)}
                    style={[
                      styles.qtyButton,
                      {
                        borderColor: colors.border,
                        borderRadius: colors.radiusSm,
                        opacity: qty >= QTY_MAX ? 0.35 : 1,
                      },
                    ]}
                  >
                    <Feather name="plus" size={13} color={colors.bodyText} />
                  </Pressable>
                  <Text style={[styles.qtyHint, { color: colors.subtleText }]}>
                    {`${qty === 1 ? 'serving' : 'servings'} · ${Math.round(resultFood.calories * qty)} cal`}
                  </Text>
                </View>
                <View style={styles.buttonStack}>
                  <ActionButton
                    testID="barcode-add"
                    label={saving ? 'Adding…' : `Add to ${MEAL_LABELS[meal]}`}
                    icon={saving ? undefined : 'plus'}
                    primary
                    disabled={saving}
                    onPress={() => void add()}
                  />
                  <ActionButton
                    testID="barcode-rescan"
                    label="Scan a different item"
                    disabled={saving}
                    onPress={scanAnother}
                  />
                </View>
                <Text style={[styles.savedHint, { color: colors.subtleText }]}>
                  Adding also saves it to My Foods, so next time it is one tap from Add food.
                </Text>
              </>
            )}
            {phase.kind === 'added' && (
              <>
                <View style={styles.addedRow} testID="barcode-added">
                  <Feather name="check-circle" size={13} color={colors.cobalt} />
                  <Text
                    accessibilityLiveRegion="polite"
                    style={[styles.addedText, { color: colors.cobalt }]}
                  >
                    {`${
                      phase.quantity === 1
                        ? 'Added'
                        : `${formatQty(phase.quantity)} servings added`
                    } to ${MEAL_LABELS[meal]} · saved to My Foods`}
                  </Text>
                </View>
                <View style={styles.buttonStack}>
                  <ActionButton testID="barcode-done" label="Done" primary onPress={goBack} />
                  <ActionButton
                    testID="barcode-scan-another"
                    label="Scan another item"
                    onPress={scanAnother}
                  />
                </View>
              </>
            )}
          </LedgerCard>
        )}

        {/* ── Honest miss: point to the label scanner ── */}
        {phase.kind === 'not_found' && (
          <LedgerCard style={styles.sectionCard} testID="barcode-miss">
            <AnnouncedBox tone="warn" message={phase.message} testID="barcode-not-found" />
            <View style={styles.buttonStack}>
              <ActionButton
                testID="barcode-open-label-scan"
                label="Scan the label instead"
                icon="camera"
                primary
                onPress={openLabelScanner}
              />
              <ActionButton
                testID="barcode-try-again"
                label="Try another number"
                onPress={scanAnother}
              />
            </View>
          </LedgerCard>
        )}

        {/* ── Transport/upstream failure: retry the same code ── */}
        {phase.kind === 'error' && (
          <LedgerCard style={styles.sectionCard} testID="barcode-failed">
            <AnnouncedBox tone="risk" message={phase.message} testID="barcode-error" />
            <View style={styles.buttonStack}>
              <ActionButton
                testID="barcode-retry"
                label="Try again"
                icon="refresh-cw"
                primary
                onPress={() => void startLookup(phase.code)}
              />
              <ActionButton
                testID="barcode-change"
                label="Enter a different number"
                onPress={scanAnother}
              />
            </View>
          </LedgerCard>
        )}
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  headerAction: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    width: 52,
  },
  headerCenter: {
    alignItems: 'center',
    gap: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontFamily: 'PlayfairDisplay_700Bold',
  },
  headerSub: {
    fontSize: 8.5,
    letterSpacing: 1.4,
    fontFamily: 'Inter_600SemiBold',
  },
  headerSpacer: {
    width: 52,
  },
  content: {
    padding: 14,
    gap: 12,
  },
  cameraShell: {
    height: 240,
    borderWidth: 1,
    overflow: 'hidden',
    backgroundColor: '#101418',
  },
  camera: {
    ...StyleSheet.absoluteFillObject,
  },
  reticleWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  reticle: {
    width: 220,
    height: 110,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    borderRadius: 10,
  },
  cameraHint: {
    fontSize: 11.5,
    fontFamily: 'Inter_500Medium',
    color: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
  },
  sectionCard: {
    padding: 14,
    gap: 8,
  },
  sectionLabel: {
    fontSize: 9.5,
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
  },
  sectionSub: {
    fontSize: 12,
    lineHeight: 17,
    fontFamily: 'Inter_400Regular',
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'web' ? 10 : 8,
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
  },
  lookupButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lookupButtonText: {
    fontSize: 12.5,
    fontFamily: 'Inter_600SemiBold',
  },
  deniedRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
  },
  deniedText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: 'Inter_400Regular',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  resultTag: {
    fontSize: 9,
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
  },
  foodName: {
    fontSize: 17,
    lineHeight: 22,
    fontFamily: 'PlayfairDisplay_700Bold',
  },
  foodBrand: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  foodFacts: {
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: 'Inter_500Medium',
  },
  qtyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  qtyButton: {
    width: 30,
    height: 30,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyValue: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    minWidth: 30,
    textAlign: 'center',
  },
  qtyHint: {
    fontSize: 11.5,
    fontFamily: 'Inter_400Regular',
    flex: 1,
  },
  buttonStack: {
    gap: 8,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    paddingVertical: 11,
    paddingHorizontal: 12,
  },
  actionButtonText: {
    fontSize: 12.5,
    fontFamily: 'Inter_600SemiBold',
  },
  savedHint: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
  },
  addedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  addedText: {
    flex: 1,
    fontSize: 12.5,
    fontFamily: 'Inter_600SemiBold',
  },
  announceBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderWidth: 1,
    padding: 10,
  },
  announceIcon: {
    marginTop: 1,
  },
  announceText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: 'Inter_500Medium',
  },
});
