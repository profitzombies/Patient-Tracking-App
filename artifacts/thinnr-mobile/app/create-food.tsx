/**
 * Create Food — build a custom food (name, serving, calories/macros) that is
 * saved to "My Foods" in the library. Opened with an `id` param it becomes
 * Edit Food: the same form pre-filled from the stored food, saving in place.
 * Custom foods are stored on-device and never carry the approved checkmark.
 *
 * Creating (not editing) also offers "Scan a label": photograph the
 * Nutrition Facts panel and the same server reader behind the coach chat's
 * label flow (POST /api/coach/label-scan) prefills serving, calories, and
 * macros from the printed values — transcription only, nothing estimated.
 * An unreadable photo answers with the coach's warm retake ask and leaves
 * the form untouched. Every prefilled value stays editable and saving is
 * the ordinary save path; the photo itself is analyzed in memory server-side
 * and never stored.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { OrdinaryTextInput as TextInput } from '@/components/ui/OrdinaryTextInput';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Redirect, router, useLocalSearchParams, usePathname } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { usePatient } from '@/context/PatientContext';
import { LabelScanError, scanLabelPhoto } from '@/lib/coach-api';
import type { LabelDraft } from '@/lib/label-food';
import { preparePhotoForUpload, type PreparedPhoto } from '@/lib/photo-prep';
import { toTitleCase } from '@/lib/title-case';

/**
 * Label-scan companion state. The photo is kept through every phase after
 * picking so retrying an unreadable or failed scan is one tap, not a
 * re-shoot; a mid-scan cancel simply returns to the preview.
 */
type ScanPhase =
  | { kind: 'idle' }
  | { kind: 'preview'; photo: PreparedPhoto }
  | { kind: 'scanning'; photo: PreparedPhoto }
  /** The AI answered, but not with values: not a label, or unreadable. */
  | { kind: 'notice'; photo: PreparedPhoto; message: string }
  /** Transport/AI failure — retry reuses the kept photo. */
  | { kind: 'error'; photo: PreparedPhoto; message: string }
  /** Values landed in the form below; the patient reviews, names, saves. */
  | { kind: 'done'; photo: PreparedPhoto; message: string; flagged: boolean };

function parseNum(raw: string): number {
  const value = parseFloat(raw.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? value : NaN;
}

export default function CreateFoodScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const patientAccount = usePatientAccount();
  // Signed-in accounts authenticate the scan so the server can honor the
  // account's consent and photo-analysis choice; the demo stays tokenless.
  const scanAuth =
    patientAccount.account.kind === 'demo'
      ? {}
      : { getAuthToken: patientAccount.getAccessToken ?? (async () => null) };
  const pathname = usePathname();
  const params = useLocalSearchParams<{ id?: string }>();
  const editId = typeof params.id === 'string' && params.id ? params.id : undefined;
  const editingFood = editId ? patient.customFoods.find(f => f.id === editId) : undefined;

  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [serving, setServing] = useState('');
  const [cals, setCals] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [scan, setScan] = useState<ScanPhase>({ kind: 'idle' });
  const [pickError, setPickError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Abandon any in-flight label scan when the screen unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Android/web hear scan status through live regions; iOS has none, so the
  // wait and the outcome are announced explicitly.
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    if (scan.kind === 'scanning') {
      AccessibilityInfo.announceForAccessibility(
        'Reading the nutrition label. This can take about half a minute.',
      );
    } else if (scan.kind === 'done') {
      AccessibilityInfo.announceForAccessibility(
        'Label read. Serving, calories, and macros are filled in below.',
      );
    }
  }, [scan.kind]);

  // Pre-fill once from the stored food. Patient state hydrates async, so the
  // food may only appear a beat after mount (render is gated below).
  const [seededId, setSeededId] = useState<string | null>(null);
  useEffect(() => {
    if (!editingFood || seededId === editingFood.id) return;
    setName(editingFood.name);
    setBrand(editingFood.brand ?? '');
    setServing(editingFood.serving);
    setCals(String(editingFood.calories));
    setProtein(String(editingFood.protein));
    setCarbs(String(editingFood.carbs));
    setFat(String(editingFood.fat));
    setSeededId(editingFood.id);
  }, [editingFood, seededId]);

  const isEditing = Boolean(editingFood);

  /** Bind a field setter so editing any field clears a shown validation error. */
  const bind = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    if (error) setError('');
  };

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 20 : Math.max(insets.bottom, 16);

  // Patient-only route: deep links must not bypass the persona flow. The
  // redirect is gated on pathname so it never hijacks in-flight navigation.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    if (pathname !== '/create-food') return null;
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }
  // Editing: wait for patient hydration so fields seed from the stored food
  // instead of flashing an empty create form.
  if (editId && !patient.hydrated) return null;

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/recipes');
  };

  const save = async () => {
    if (saving) return;
    const trimmedName = name.trim();
    const calories = parseNum(cals);
    if (!trimmedName) {
      setError('Give it a name.');
      return;
    }
    if (Number.isNaN(calories)) {
      setError('Calories are required (0 or more).');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const proteinVal = Number.isNaN(parseNum(protein)) ? 0 : parseNum(protein);
      const carbsVal = Number.isNaN(parseNum(carbs)) ? 0 : parseNum(carbs);
      const fatVal = Number.isNaN(parseNum(fat)) ? 0 : parseNum(fat);
      const trimmedBrand = brand.trim();
      const payload = {
        // Created names are Title Case everywhere (matches coach cards and
        // the chat's label flow); deliberate caps like "PB&J" survive.
        name: toTitleCase(trimmedName),
        ...(trimmedBrand ? { brand: trimmedBrand } : {}),
        serving: serving.trim() || '1 serving',
        calories: Math.round(calories),
        protein: Math.round(proteinVal),
        carbs: Math.round(carbsVal),
        fat: Math.round(fatVal),
        // updateCustomFood rebuilds from the payload, so carry the AI dish
        // photo (foods saved from coach suggestions) through edits.
        ...(editingFood?.photoUri ? { photoUri: editingFood.photoUri } : {}),
      };
      if (editingFood) {
        await patient.updateCustomFood(editingFood.id, payload);
      } else {
        await patient.addCustomFood(payload);
      }
      goBack();
    } finally {
      setSaving(false);
    }
  };

  // ── Label scan (create mode only) ──────────────────────────────────────

  /** Prefill the nutrition fields from a validated label read. */
  const applyLabel = (draft: LabelDraft) => {
    setServing(draft.servingSize);
    setCals(String(draft.calories));
    setProtein(String(draft.protein));
    setCarbs(String(draft.carbs));
    setFat(String(draft.fat));
    setError('');
  };

  const usePickedPhoto = async (result: ImagePicker.ImagePickerResult) => {
    if (result.canceled || !result.assets?.[0]) return;
    setPreparing(true);
    try {
      const photo = await preparePhotoForUpload(result.assets[0]);
      setPickError(null);
      setScan({ kind: 'preview', photo });
    } catch (err) {
      console.error('Label photo preparation failed', err);
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
    } catch (err) {
      console.error('Camera launch failed', err);
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
    } catch (err) {
      console.error('Photo library launch failed', err);
      setPickError('Your photo library could not be opened. Please try again.');
    }
  };

  const startScan = async (photo: PreparedPhoto) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setScan({ kind: 'scanning', photo });
    try {
      const result = await scanLabelPhoto(photo.uri, { signal: controller.signal, ...scanAuth });
      if (controller.signal.aborted) return;
      if (result.result === 'ok' && result.label) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        applyLabel(result.label);
        setScan({
          kind: 'done',
          photo,
          message: result.message,
          flagged: result.label.flagged === true,
        });
      } else {
        // Not a label / unreadable: the coach's warm re-ask, nothing guessed
        // and nothing touched in the form.
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setScan({ kind: 'notice', photo, message: result.message });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      const message =
        err instanceof LabelScanError
          ? err.message
          : 'The label scan is unavailable right now. Please try again.';
      setScan({ kind: 'error', photo, message });
    }
  };

  const cancelScan = (photo: PreparedPhoto) => {
    Haptics.selectionAsync();
    abortRef.current?.abort();
    setScan({ kind: 'preview', photo });
  };

  const changeScanPhoto = () => {
    Haptics.selectionAsync();
    setScan({ kind: 'idle' });
  };

  const numericInputProps = {
    keyboardType: Platform.OS === 'web' ? undefined : ('decimal-pad' as const),
    placeholderTextColor: colors.subtleText,
  };

  const inputStyle = [
    styles.input,
    { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, borderRadius: colors.radiusSm },
  ];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Header ── */}
      <View style={[styles.header, { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
        <Pressable testID="createfood-cancel" onPress={goBack} hitSlop={8}>
          <Text style={[styles.headerAction, { color: colors.cobalt }]}>Cancel</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.navy }]}>
            {isEditing ? 'Edit Food' : 'Create Food'}
          </Text>
          <Text style={[styles.headerSub, { color: colors.subtleText }]}>
            {isEditing ? 'UPDATES MY FOODS' : 'SAVED TO MY FOODS'}
          </Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAwareScrollViewCompat contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
        {!isEditing && (
          <View style={styles.scanSection} testID="createfood-scan-section">
            {scan.kind === 'idle' ? (
              <LedgerCard accentTop style={styles.scanCard}>
                <View style={styles.scanInner}>
                  <View style={styles.scanHead}>
                    <View
                      style={[
                        styles.scanIcon,
                        { backgroundColor: colors.accent, borderColor: colors.border, borderRadius: colors.radiusSm },
                      ]}
                    >
                      <Feather name="camera" size={15} color={colors.cobalt} />
                    </View>
                    <View style={styles.scanHeadText}>
                      <Text style={[styles.scanTitle, { color: colors.navy }]}>Scan a label instead</Text>
                      <Text style={[styles.scanSub, { color: colors.subtleText }]}>
                        Photograph the Nutrition Facts panel and the serving, calories, and
                        macros below fill in from the printed values. Nothing is estimated.
                      </Text>
                    </View>
                  </View>
                  {pickError !== null && (
                    <AnnouncedBox tone="risk" message={pickError} testID="createfood-scan-pick-error" />
                  )}
                  <View style={styles.scanBtnStack}>
                    {Platform.OS !== 'web' && (
                      <ScanButton
                        testID="createfood-scan-take"
                        label="Take a photo"
                        icon="camera"
                        primary
                        disabled={preparing}
                        onPress={takePhoto}
                      />
                    )}
                    <ScanButton
                      testID="createfood-scan-choose"
                      label={Platform.OS === 'web' ? 'Choose a label photo' : 'Choose from library'}
                      icon={Platform.OS === 'web' ? 'image' : undefined}
                      primary={Platform.OS === 'web'}
                      disabled={preparing}
                      onPress={choosePhoto}
                    />
                  </View>
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
            ) : (
              <LedgerCard accentTop={scan.kind === 'done'} style={styles.scanCard}>
                <View style={styles.scanInner}>
                  <View style={styles.scanThumbRow}>
                    <Image
                      source={{ uri: scan.photo.uri }}
                      style={[
                        styles.scanThumb,
                        { backgroundColor: colors.paperCardAlt, borderColor: colors.border, borderRadius: colors.radiusSm },
                        scan.kind === 'scanning' && { opacity: 0.5 },
                      ]}
                      contentFit="cover"
                      accessibilityLabel="Your label photo"
                    />
                    <View style={styles.scanHeadText}>
                      {scan.kind === 'preview' && (
                        <>
                          <Text style={[styles.scanTitle, { color: colors.navy }]}>
                            Ready to read this label
                          </Text>
                          <Text style={[styles.scanSub, { color: colors.subtleText }]}>
                            Best shots are straight on, with the Nutrition Facts panel sharp and
                            filling the frame.
                          </Text>
                        </>
                      )}
                      {scan.kind === 'scanning' && (
                        <View testID="createfood-scan-progress">
                          <View style={styles.scanStatusRow}>
                            <ActivityIndicator size="small" color={colors.cobalt} />
                            <Text
                              accessibilityLiveRegion="polite"
                              style={[styles.scanStatusTitle, { color: colors.navyLight }]}
                            >
                              Reading the label…
                            </Text>
                          </View>
                          <Text style={[styles.scanSub, { color: colors.subtleText }]}>
                            Transcribing the printed values. This can take about half a minute.
                          </Text>
                        </View>
                      )}
                      {(scan.kind === 'notice' || scan.kind === 'error') && (
                        <>
                          <Text style={[styles.scanTitle, { color: colors.navy }]}>
                            {scan.kind === 'notice' ? 'That photo did not work' : 'The scan hit a snag'}
                          </Text>
                          <Text style={[styles.scanSub, { color: colors.subtleText }]}>
                            Your photo is kept, so trying again is one tap.
                          </Text>
                        </>
                      )}
                      {scan.kind === 'done' && (
                        <>
                          <View style={styles.scanDoneHead}>
                            <Feather name="check-circle" size={12} color={colors.cobalt} />
                            <Text
                              accessibilityLiveRegion="polite"
                              style={[styles.scanDoneLabel, { color: colors.cobalt }]}
                            >
                              LABEL READ
                            </Text>
                          </View>
                          <Text style={[styles.scanSub, { color: colors.bodyText }]}>{scan.message}</Text>
                        </>
                      )}
                    </View>
                  </View>

                  {scan.kind === 'notice' && (
                    <AnnouncedBox tone="warn" message={scan.message} testID="createfood-scan-notice" />
                  )}
                  {scan.kind === 'error' && (
                    <AnnouncedBox tone="risk" message={scan.message} testID="createfood-scan-error" />
                  )}
                  {scan.kind === 'done' && scan.flagged && (
                    <AnnouncedBox
                      tone="warn"
                      message="The printed calories and macros disagree on this label. Worth a double check on the package."
                      testID="createfood-scan-flagged"
                    />
                  )}
                  {scan.kind === 'done' && (
                    <Text style={[styles.scanHint, { color: colors.subtleText }]}>
                      Every value below is editable. Check the numbers against the package, give
                      the food its name, then save as usual.
                    </Text>
                  )}

                  <View style={styles.scanBtnStack}>
                    {scan.kind === 'preview' && (
                      <>
                        <ScanButton
                          testID="createfood-scan-start"
                          label="Read this label"
                          icon="search"
                          primary
                          onPress={() => startScan(scan.photo)}
                        />
                        <ScanButton
                          testID="createfood-scan-change"
                          label="Choose a different photo"
                          onPress={changeScanPhoto}
                        />
                      </>
                    )}
                    {scan.kind === 'scanning' && (
                      <ScanButton
                        testID="createfood-scan-cancel"
                        label="Cancel"
                        onPress={() => cancelScan(scan.photo)}
                      />
                    )}
                    {scan.kind === 'notice' && (
                      <>
                        <ScanButton
                          testID="createfood-scan-change"
                          label="Try a different photo"
                          icon="image"
                          primary
                          onPress={changeScanPhoto}
                        />
                        <ScanButton
                          testID="createfood-scan-retry"
                          label="Scan the same photo again"
                          onPress={() => startScan(scan.photo)}
                        />
                      </>
                    )}
                    {scan.kind === 'error' && (
                      <>
                        <ScanButton
                          testID="createfood-scan-retry"
                          label="Try again"
                          icon="refresh-cw"
                          primary
                          onPress={() => startScan(scan.photo)}
                        />
                        <ScanButton
                          testID="createfood-scan-change"
                          label="Choose a different photo"
                          onPress={changeScanPhoto}
                        />
                      </>
                    )}
                    {scan.kind === 'done' && (
                      <ScanButton
                        testID="createfood-scan-restart"
                        label="Scan a different label"
                        onPress={changeScanPhoto}
                      />
                    )}
                  </View>
                </View>
              </LedgerCard>
            )}
          </View>
        )}

        <LedgerCard style={{ padding: 14 }}>
          <Text style={[styles.fieldLabel, { color: colors.labelText }]}>NAME *</Text>
          <TextInput
            testID="createfood-name"
            value={name}
            onChangeText={bind(setName)}
            placeholder="e.g. Greek yogurt bowl"
            placeholderTextColor={colors.subtleText}
            style={inputStyle}
          />
          <Text style={[styles.fieldLabel, { color: colors.labelText }]}>BRAND (OPTIONAL)</Text>
          <TextInput
            testID="createfood-brand"
            value={brand}
            onChangeText={bind(setBrand)}
            placeholder="e.g. Fage"
            placeholderTextColor={colors.subtleText}
            style={inputStyle}
          />
          <Text style={[styles.fieldLabel, { color: colors.labelText }]}>SERVING SIZE</Text>
          <TextInput
            testID="createfood-serving"
            value={serving}
            onChangeText={bind(setServing)}
            placeholder="e.g. 1 cup"
            placeholderTextColor={colors.subtleText}
            style={inputStyle}
          />

          <View style={styles.grid}>
            <View style={styles.gridItem}>
              <Text style={[styles.fieldLabel, { color: colors.labelText }]}>CALORIES *</Text>
              <TextInput
                testID="createfood-calories"
                value={cals}
                onChangeText={bind(setCals)}
                placeholder="0"
                {...numericInputProps}
                style={[...inputStyle, { marginBottom: 0 }]}
              />
            </View>
            <View style={styles.gridItem}>
              <Text style={[styles.fieldLabel, { color: colors.labelText }]}>PROTEIN G</Text>
              <TextInput
                testID="createfood-protein"
                value={protein}
                onChangeText={bind(setProtein)}
                placeholder="0"
                {...numericInputProps}
                style={[...inputStyle, { marginBottom: 0 }]}
              />
            </View>
            <View style={styles.gridItem}>
              <Text style={[styles.fieldLabel, { color: colors.labelText }]}>CARBS G</Text>
              <TextInput
                testID="createfood-carbs"
                value={carbs}
                onChangeText={bind(setCarbs)}
                placeholder="0"
                {...numericInputProps}
                style={[...inputStyle, { marginBottom: 0 }]}
              />
            </View>
            <View style={styles.gridItem}>
              <Text style={[styles.fieldLabel, { color: colors.labelText }]}>FAT G</Text>
              <TextInput
                testID="createfood-fat"
                value={fat}
                onChangeText={bind(setFat)}
                placeholder="0"
                {...numericInputProps}
                style={[...inputStyle, { marginBottom: 0 }]}
              />
            </View>
          </View>

          {error ? <Text style={[styles.error, { color: colors.riskText }]}>{error}</Text> : null}

          <Pressable
            testID="createfood-save"
            onPress={save}
            disabled={saving}
            style={({ pressed }) => [
              styles.saveBtn,
              { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
              (pressed || saving) && { opacity: 0.85 },
            ]}
          >
            <Text style={[styles.saveText, { color: colors.primaryForeground }]}>
              {isEditing ? 'Save Changes' : 'Save to My Foods'}
            </Text>
          </Pressable>
        </LedgerCard>

        <Text style={[styles.footnote, { color: colors.subtleText }]}>
          {isEditing
            ? 'Changes apply to this food in My Foods going forward. Diary entries you already logged keep the values they were logged with.'
            : 'Custom foods are stored on this device under My Foods in the Library. They never carry the approved checkmark — that badge is reserved for foods on the official THINNR Approved Foods list.'}
        </Text>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

/**
 * Announced status box — the same alert-role + live-region + iOS-announce
 * trio as the onboarding ErrorBox and the menu scan's notices, so screen
 * readers hear scan problems without focus moving.
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

/** Compact scan-card button; `primary` fills cobalt, otherwise outlined. */
function ScanButton({
  label,
  onPress,
  icon,
  primary = false,
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  icon?: React.ComponentProps<typeof Feather>['name'];
  primary?: boolean;
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
        styles.scanBtn,
        primary
          ? {
              backgroundColor: disabled ? colors.cobaltMuted : colors.cobalt,
              borderRadius: colors.radiusSm,
            }
          : {
              backgroundColor: pressed ? colors.accent : colors.card,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: colors.radiusSm,
            },
        pressed && primary && !disabled && { opacity: 0.88 },
        !primary && disabled && { opacity: 0.55 },
      ]}
    >
      {icon ? (
        <Feather
          name={icon}
          size={14}
          color={primary ? colors.primaryForeground : colors.navyLight}
        />
      ) : null}
      <Text
        style={[
          styles.scanBtnText,
          { color: primary ? colors.primaryForeground : colors.navyLight },
        ]}
      >
        {label}
      </Text>
    </Pressable>
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
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    width: 52,
  },
  headerCenter: {
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.1,
  },
  headerSub: {
    fontSize: 8.5,
    fontWeight: '700',
    letterSpacing: 1.1,
    marginTop: 2,
    fontFamily: 'Inter_700Bold',
  },
  headerSpacer: {
    width: 52,
  },
  content: {
    padding: 16,
  },
  fieldLabel: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    paddingHorizontal: 10,
    height: 38,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    marginBottom: 10,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  grid: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  gridItem: {
    flex: 1,
  },
  error: {
    fontSize: 11,
    marginTop: 10,
    fontFamily: 'Inter_400Regular',
  },
  saveBtn: {
    marginTop: 14,
    paddingVertical: 11,
    alignItems: 'center',
  },
  saveText: {
    fontSize: 12.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  footnote: {
    fontSize: 10,
    lineHeight: 14,
    marginTop: 12,
    fontFamily: 'Inter_400Regular',
  },
  // ── Label scan ──
  scanSection: {
    marginBottom: 12,
  },
  scanCard: {
    padding: 12,
  },
  scanInner: {
    gap: 10,
  },
  scanHead: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
  scanHeadText: {
    flex: 1,
    gap: 3,
  },
  scanIcon: {
    width: 34,
    height: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanTitle: {
    fontSize: 14.5,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.1,
  },
  scanSub: {
    fontSize: 11,
    lineHeight: 15.5,
    fontFamily: 'Inter_400Regular',
  },
  scanBtnStack: {
    gap: 8,
  },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 40,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  scanBtnText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  preparingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  preparingText: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  scanThumbRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
  scanThumb: {
    width: 54,
    height: 54,
    borderWidth: 1,
  },
  scanStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 3,
  },
  scanStatusTitle: {
    fontSize: 12.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  scanDoneHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 2,
  },
  scanDoneLabel: {
    fontSize: 8.5,
    fontWeight: '700',
    letterSpacing: 1.1,
    fontFamily: 'Inter_700Bold',
  },
  scanHint: {
    fontSize: 10.5,
    lineHeight: 14.5,
    fontFamily: 'Inter_400Regular',
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
    fontSize: 11.5,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
  },
});
