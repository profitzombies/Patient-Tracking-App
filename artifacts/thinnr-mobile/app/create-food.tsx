/**
 * Create Food — build a custom food (name, serving, calories/macros) that is
 * saved to "My Foods" in the library. Opened with an `id` param it becomes
 * Edit Food: the same form pre-filled from the stored food, saving in place.
 * Custom foods are stored on-device and never carry the approved checkmark.
 */
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Redirect, router, useLocalSearchParams, usePathname } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import { usePatient } from '@/context/PatientContext';

function parseNum(raw: string): number {
  const value = parseFloat(raw.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? value : NaN;
}

export default function CreateFoodScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { mode, hydrated: modeHydrated } = useAppMode();
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
        name: trimmedName,
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
});
