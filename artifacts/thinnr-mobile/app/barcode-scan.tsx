/**
 * Barcode Scan — log packaged foods to ONE diary meal by scanning (or
 * typing) the numbers under their barcodes. Opened from the diary meal
 * card's barcode chip with `{ date, meal }`, so everything found here logs
 * to that slot on that day.
 *
 * Multi-scan session: each successful lookup drops the product onto a
 * running on-screen list and scanning stays live, so a packaged meal's
 * items can be scanned back to back. The list dedupes on the CANONICAL
 * code the lookup returns — never the raw scanned or typed digits — so the
 * same product arriving as a UPC on one scan and an EAN on the next still
 * counts as one product: it never lands twice, and a brief announced
 * "already on your list" notice shows instead. (Codes the client itself
 * canonicalizes to a listed row skip the network round trip; the
 * post-lookup check covers variants only the server unifies.) Each row
 * keeps the half-step serving stepper, and ONE primary action logs the
 * whole list, running the exact label-flow path per item — save a
 * per-serving custom food to "My Foods", then log quantity × per-serving
 * to the bound meal — so editing, undo, and the library treat every row
 * like any other custom food. Nothing is logged before that confirm.
 *
 * Two capture paths, one lookup:
 * - Native with camera permission: live EAN-13/EAN-8/UPC-A/UPC-E detection
 *   in an embedded viewfinder, debounced so one steady frame can't fire a
 *   burst of duplicate lookups. A flash button drives the camera's
 *   continuous torch — lit the moment it's pressed, announced to screen
 *   readers, and off again once the list is logged or the screen closes.
 *   Hidden on web, where browsers cannot drive a torch.
 * - Everywhere (and the ONLY path on web or when permission is denied):
 *   type the number printed under the bars. Same normalizer, same lookup,
 *   same list, same duplicate handling.
 *
 * The lookup itself goes through the API server (lib/barcode-food.ts):
 * shared nutrition-facts table first, Open Food Facts only on a miss —
 * published per-serving values only, never estimates. Unknown codes and
 * products without a usable panel get an honest message that points to
 * the label scanner instead; nutrition numbers are never invented.
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
import { Feather } from '@expo/vector-icons';
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

/** How long the transient added/duplicate notice stays on screen. */
const NOTICE_MS = 4000;

const LOOKUP_FALLBACK_ERROR = 'The barcode lookup is unavailable right now. Please try again.';
const INPUT_ERROR = 'Enter the 8, 12, or 13 digit number printed under the bars.';

type Phase =
  | { kind: 'scan' }
  | { kind: 'looking'; code: string }
  | { kind: 'not_found'; message: string; code: string }
  | { kind: 'error'; message: string; code: string }
  /** Add ran: every listed food saved to My Foods and logged. List freezes. */
  | { kind: 'logged'; count: number };

/** One product on the running session list, with its serving stepper value. */
interface SessionItem {
  food: BarcodeFood;
  qty: number;
}

/** Transient feedback after a scan/typed code resolved: appended, or a dupe. */
interface Notice {
  tone: 'added' | 'duplicate';
  message: string;
  /** Timestamp key — remounts the box so repeats re-announce. */
  at: number;
}

function countText(n: number): string {
  return n === 1 ? '1 food' : `${n} foods`;
}

function AnnouncedBox({
  tone,
  message,
  icon,
  testID,
}: {
  tone: 'risk' | 'warn' | 'ok';
  message: string;
  icon?: React.ComponentProps<typeof Feather>['name'];
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
      : tone === 'warn'
        ? { bg: colors.warnBg, border: colors.warnBorder, text: colors.warnText }
        : { bg: colors.activeBg, border: colors.activeBorder, text: colors.cobalt };

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
        name={icon ?? (tone === 'risk' ? 'alert-triangle' : tone === 'warn' ? 'search' : 'check-circle')}
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
  const [items, setItems] = useState<SessionItem[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scanGateRef = useRef<{ code: string; at: number } | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The camera callback fires outside React's render cycle — read current
  // state through refs so a stale closure can't double-fire or double-add.
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const itemsRef = useRef<SessionItem[]>(items);
  itemsRef.current = items;
  const savingRef = useRef(saving);
  savingRef.current = saving;

  const [permission, requestPermission] = useCameraPermissions();
  const askedPermissionRef = useRef(false);
  useEffect(() => {
    if (Platform.OS === 'web' || !permission) return;
    if (!permission.granted && permission.canAskAgain && !askedPermissionRef.current) {
      askedPermissionRef.current = true;
      void requestPermission();
    }
  }, [permission, requestPermission]);

  // Abandon any in-flight lookup (and the notice timer) when the screen
  // unmounts. The torch needs no teardown of its own: enableTorch dies with
  // the camera view, so leaving the screen always resets the flash to off.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  // Android/web hear status changes via live regions; iOS has none, so the
  // wait is announced explicitly. Appends, duplicates, misses, and errors
  // all announce through their boxes.
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    if (phase.kind === 'looking') {
      AccessibilityInfo.announceForAccessibility('Looking up that barcode.');
    }
  }, [phase]);

  /** Shows the transient appended/duplicate notice (auto-clears). */
  const showNotice = useCallback((tone: Notice['tone'], message: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice({ tone, message, at: Date.now() });
    noticeTimerRef.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const startLookup = useCallback(
    async (code: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setInputError(null);
      setPhase({ kind: 'looking', code });
      try {
        const outcome = await lookupBarcode(code, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (outcome.result === 'found') {
          // Dedupe on the CANONICAL code the server answered with — a UPC
          // and its EAN form resolve to the same row and count as one
          // product, no matter which form was scanned or typed.
          const existing = itemsRef.current.find(item => item.food.code === outcome.food.code);
          if (existing) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            showNotice('duplicate', `${existing.food.name} is already on your list.`);
          } else {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setItems(prev => [...prev, { food: outcome.food, qty: 1 }]);
            showNotice('added', `${outcome.food.name} is on your list.`);
          }
          setInput('');
          setPhase({ kind: 'scan' });
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
    },
    [showNotice],
  );

  const handleBarcodeScanned = ({ data, type }: { data: string; type: string }) => {
    if (phaseRef.current.kind !== 'scan' || savingRef.current) return;
    const code = normalizeScannedBarcode(String(data ?? ''), type);
    if (!code) return;
    const now = Date.now();
    const gate = scanGateRef.current;
    if (gate && gate.code === code && now - gate.at < SCAN_REPEAT_MS) return;
    scanGateRef.current = { code, at: now };
    // Fast path: this scan canonicalizes straight to a listed row, so the
    // duplicate is known without a network round trip. The post-lookup
    // check above still covers variants only the server unifies.
    const existing = itemsRef.current.find(item => item.food.code === code);
    if (existing) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      showNotice('duplicate', `${existing.food.name} is already on your list.`);
      return;
    }
    Haptics.selectionAsync();
    void startLookup(code);
  };

  const submitManual = () => {
    if (phase.kind === 'looking' || phase.kind === 'logged' || saving) return;
    const code = normalizeTypedBarcode(input);
    if (!code) {
      setInputError(INPUT_ERROR);
      return;
    }
    const existing = items.find(item => item.food.code === code);
    if (existing) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      showNotice('duplicate', `${existing.food.name} is already on your list.`);
      setInput('');
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

  /** Dismisses a miss/error card back to live scanning. The list stays. */
  const dismissResult = () => {
    Haptics.selectionAsync();
    abortRef.current?.abort();
    scanGateRef.current = null;
    setInput('');
    setInputError(null);
    setPhase({ kind: 'scan' });
  };

  /** After logging: clear the just-logged list and scan a fresh one. */
  const startNewList = () => {
    Haptics.selectionAsync();
    scanGateRef.current = null;
    setItems([]);
    setNotice(null);
    setInput('');
    setInputError(null);
    setPhase({ kind: 'scan' });
  };

  const stepItemQty = (code: string, delta: number) => {
    Haptics.selectionAsync();
    setItems(prev =>
      prev.map(item =>
        item.food.code === code
          ? {
              ...item,
              qty: Math.min(QTY_MAX, Math.max(QTY_MIN, Math.round((item.qty + delta) * 2) / 2)),
            }
          : item,
      ),
    );
  };

  /** ONE confirm: logs every listed item to the bound meal, in list order. */
  const addAll = async () => {
    if (saving || items.length === 0) return;
    if (phase.kind === 'looking' || phase.kind === 'logged') return;
    setSaving(true);
    try {
      // The same two steps the label flow runs, once per listed item:
      // create the reusable custom food (always per-serving), then log the
      // stepped number of servings to THIS screen's bound meal and day.
      for (const item of items) {
        const food = await patient.addCustomFood(buildCustomFoodFromBarcode(item.food));
        await patient.addEntry(buildBarcodeDiaryEntry(food, meal, dateKey, item.qty));
      }
      // Adding the foods ends the flash session.
      setTorchOn(false);
      setNotice(null);
      if (Platform.OS === 'ios') {
        AccessibilityInfo.announceForAccessibility(
          `Added ${countText(items.length)} to ${MEAL_LABELS[meal]} and saved to My Foods.`,
        );
      }
      setPhase({ kind: 'logged', count: items.length });
    } finally {
      setSaving(false);
    }
  };

  /** Immediate, persistent torch: on the moment it's pressed, announced. */
  const toggleTorch = () => {
    Haptics.selectionAsync();
    const next = !torchOn;
    setTorchOn(next);
    AccessibilityInfo.announceForAccessibility(next ? 'Flash on' : 'Flash off');
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
  const listLocked = saving || phase.kind === 'logged';
  const cameraHint =
    phase.kind === 'scan'
      ? saving
        ? 'Adding your list…'
        : items.length === 0
          ? 'Center the barcode in the frame'
          : 'Keep scanning — each item lands on your list'
      : phase.kind === 'logged'
        ? 'All set — your list is logged'
        : 'Scanning paused while this result is open';

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
          <Text style={[styles.headerTitle, { color: colors.navy }]}>Scan Barcodes</Text>
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
              enableTorch={torchOn}
              barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e'] }}
              onBarcodeScanned={phase.kind === 'scan' && !saving ? handleBarcodeScanned : undefined}
            />
            <View style={[styles.reticleWrap, { pointerEvents: 'none' }]}>
              <View style={styles.reticle} />
              <Text style={styles.cameraHint}>{cameraHint}</Text>
            </View>
            {/* Continuous torch, not capture-time flash: lit from the press
                until the foods are added or the screen closes. Native only —
                web never renders the camera shell at all. */}
            <Pressable
              testID="barcode-torch"
              accessibilityRole="button"
              accessibilityLabel={torchOn ? 'Turn off the flash' : 'Turn on the flash'}
              accessibilityState={{ selected: torchOn }}
              hitSlop={6}
              onPress={toggleTorch}
              style={({ pressed }) => [
                styles.torchButton,
                { backgroundColor: torchOn ? colors.cobalt : 'rgba(0, 0, 0, 0.45)' },
                pressed && { opacity: 0.8 },
              ]}
            >
              <Feather name={torchOn ? 'zap' : 'zap-off'} size={16} color="#ffffff" />
            </Pressable>
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

        {/* ── Transient feedback: appended to the list, or already on it ── */}
        {notice && (
          <AnnouncedBox
            key={notice.at}
            tone={notice.tone === 'added' ? 'ok' : 'warn'}
            icon={notice.tone === 'added' ? 'check-circle' : 'copy'}
            message={notice.message}
            testID={`barcode-notice-${notice.tone}`}
          />
        )}

        {/* ── Manual entry — the path that always works ── */}
        <LedgerCard accentTop style={styles.sectionCard}>
          <Text style={[styles.sectionLabel, { color: colors.labelText }]}>
            {cameraLive ? 'OR TYPE THE NUMBER' : 'TYPE THE NUMBER'}
          </Text>
          <Text style={[styles.sectionSub, { color: colors.subtleText }]}>
            {Platform.OS === 'web'
              ? 'Live camera scanning runs on your phone. Here, enter the number printed under the bars — each food joins the list below.'
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
              editable={phase.kind !== 'looking' && phase.kind !== 'logged' && !saving}
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
              disabled={phase.kind === 'looking' || phase.kind === 'logged' || saving}
              onPress={submitManual}
              style={({ pressed }) => [
                styles.lookupButton,
                {
                  backgroundColor:
                    phase.kind === 'looking' || phase.kind === 'logged' || saving
                      ? colors.cobaltMuted
                      : colors.cobalt,
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
                onPress={dismissResult}
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
                onPress={dismissResult}
              />
            </View>
          </LedgerCard>
        )}

        {/* ── The running session list — nothing logs until ONE confirm ── */}
        {items.length > 0 && (
          <LedgerCard accentTop style={styles.sectionCard} testID="barcode-list">
            <Text style={[styles.sectionLabel, { color: colors.labelText }]}>
              {`YOUR LIST · ${items.length} ${items.length === 1 ? 'ITEM' : 'ITEMS'}`}
            </Text>
            {items.map((item, index) => (
              <React.Fragment key={item.food.code}>
                {index > 0 && <Divider />}
                <View style={styles.itemBlock} testID={`barcode-item-${item.food.code}`}>
                  <Text style={[styles.foodName, { color: colors.navy }]} numberOfLines={2}>
                    {item.food.name}
                  </Text>
                  {!!item.food.brand && (
                    <Text style={[styles.foodBrand, { color: colors.subtleText }]}>
                      {item.food.brand}
                    </Text>
                  )}
                  <Text style={[styles.foodFacts, { color: colors.bodyText }]}>
                    {`Per ${item.food.serving} · ${Math.round(item.food.calories)} cal · P ${item.food.protein}g · C ${item.food.carbs}g · F ${item.food.fat}g`}
                  </Text>
                  <View style={styles.qtyRow}>
                    <Pressable
                      testID={`barcode-item-minus-${item.food.code}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Fewer servings of ${item.food.name}`}
                      disabled={listLocked || item.qty <= QTY_MIN}
                      onPress={() => stepItemQty(item.food.code, -0.5)}
                      style={[
                        styles.qtyButton,
                        {
                          borderColor: colors.border,
                          borderRadius: colors.radiusSm,
                          opacity: listLocked || item.qty <= QTY_MIN ? 0.35 : 1,
                        },
                      ]}
                    >
                      <Feather name="minus" size={13} color={colors.bodyText} />
                    </Pressable>
                    <Text
                      testID={`barcode-item-qty-${item.food.code}`}
                      accessibilityLabel={`${formatQty(item.qty)} ${item.qty === 1 ? 'serving' : 'servings'} of ${item.food.name}`}
                      style={[styles.qtyValue, { color: colors.navy }]}
                    >
                      {formatQty(item.qty)}
                    </Text>
                    <Pressable
                      testID={`barcode-item-plus-${item.food.code}`}
                      accessibilityRole="button"
                      accessibilityLabel={`More servings of ${item.food.name}`}
                      disabled={listLocked || item.qty >= QTY_MAX}
                      onPress={() => stepItemQty(item.food.code, 0.5)}
                      style={[
                        styles.qtyButton,
                        {
                          borderColor: colors.border,
                          borderRadius: colors.radiusSm,
                          opacity: listLocked || item.qty >= QTY_MAX ? 0.35 : 1,
                        },
                      ]}
                    >
                      <Feather name="plus" size={13} color={colors.bodyText} />
                    </Pressable>
                    <Text style={[styles.qtyHint, { color: colors.subtleText }]}>
                      {`${item.qty === 1 ? 'serving' : 'servings'} · ${Math.round(item.food.calories * item.qty)} cal`}
                    </Text>
                  </View>
                </View>
              </React.Fragment>
            ))}
            <Divider />
            {phase.kind === 'logged' ? (
              <>
                <View style={styles.addedRow} testID="barcode-added">
                  <Feather name="check-circle" size={13} color={colors.cobalt} />
                  <Text
                    accessibilityLiveRegion="polite"
                    style={[styles.addedText, { color: colors.cobalt }]}
                  >
                    {`Added ${countText(phase.count)} to ${MEAL_LABELS[meal]} · saved to My Foods`}
                  </Text>
                </View>
                <View style={styles.buttonStack}>
                  <ActionButton testID="barcode-done" label="Done" primary onPress={goBack} />
                  <ActionButton
                    testID="barcode-scan-more"
                    label="Scan more items"
                    onPress={startNewList}
                  />
                </View>
              </>
            ) : (
              <>
                <View style={styles.buttonStack}>
                  <ActionButton
                    testID="barcode-add-all"
                    label={
                      saving ? 'Adding…' : `Add ${countText(items.length)} to ${MEAL_LABELS[meal]}`
                    }
                    icon={saving ? undefined : 'plus'}
                    primary
                    disabled={saving || phase.kind === 'looking'}
                    onPress={() => void addAll()}
                  />
                </View>
                <Text style={[styles.savedHint, { color: colors.subtleText }]}>
                  Nothing is logged until you add your list. Adding also saves each food to My
                  Foods, so next time it is one tap from Add food.
                </Text>
              </>
            )}
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
  torchButton: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
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
  itemBlock: {
    gap: 4,
  },
  foodName: {
    fontSize: 15.5,
    lineHeight: 20,
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
    marginTop: 2,
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
