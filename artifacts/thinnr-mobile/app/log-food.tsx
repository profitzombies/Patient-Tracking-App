/**
 * Log Food — search the food database and recipes, pick a quantity, and
 * add it to a meal. Includes recents, favorites, and quick-add custom foods.
 */
import React, { useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { Divider, EmptyState, LedgerCard, PillSelector } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import { usePatient } from '@/context/PatientContext';
import {
  formatDateKey,
  MEAL_LABELS,
  MEAL_SLOTS,
  RECIPES,
  TODAY_KEY,
  type MealSlot,
} from '@/data/patient-data';

type Scope = 'recent' | 'favorites' | 'all';

interface LoggableItem {
  refId: string;
  kind: 'food' | 'recipe';
  name: string;
  sub: string;
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

const SCOPE_OPTIONS: { label: string; value: Scope }[] = [
  { label: 'Recent', value: 'recent' },
  { label: 'Favorites', value: 'favorites' },
  { label: 'All', value: 'all' },
];

const MEAL_OPTIONS = MEAL_SLOTS.map(slot => ({ label: MEAL_LABELS[slot], value: slot }));

function parseNum(raw: string): number {
  const value = parseFloat(raw.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? value : NaN;
}

function formatQty(qty: number): string {
  return qty % 1 === 0 ? String(qty) : qty.toFixed(1);
}

export default function LogFoodScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const params = useLocalSearchParams<{ date?: string; meal?: string }>();

  const dateKey = typeof params.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
    ? params.date
    : TODAY_KEY;
  const initialMeal = MEAL_SLOTS.includes(params.meal as MealSlot)
    ? (params.meal as MealSlot)
    : 'breakfast';

  const [meal, setMeal] = useState<MealSlot>(initialMeal);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('recent');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [saving, setSaving] = useState(false);

  // Quick-add form
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickName, setQuickName] = useState('');
  const [quickServing, setQuickServing] = useState('');
  const [quickCals, setQuickCals] = useState('');
  const [quickProtein, setQuickProtein] = useState('');
  const [quickCarbs, setQuickCarbs] = useState('');
  const [quickFat, setQuickFat] = useState('');
  const [quickError, setQuickError] = useState('');

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 20 : Math.max(insets.bottom, 16);

  const allItems = useMemo<LoggableItem[]>(() => {
    const foods: LoggableItem[] = patient.allFoods.map(food => ({
      refId: food.id,
      kind: 'food',
      name: food.name,
      sub: food.brand ?? food.category,
      serving: food.serving,
      calories: food.calories,
      protein: food.protein,
      carbs: food.carbs,
      fat: food.fat,
    }));
    const recipes: LoggableItem[] = RECIPES.map(recipe => ({
      refId: recipe.id,
      kind: 'recipe',
      name: recipe.name,
      sub: 'THINNR Recipe',
      serving: '1 serving',
      calories: recipe.calories,
      protein: recipe.protein,
      carbs: recipe.carbs,
      fat: recipe.fat,
    }));
    return [...foods, ...recipes];
  }, [patient.allFoods]);

  const byId = useMemo(() => new Map(allItems.map(item => [item.refId, item])), [allItems]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      return allItems.filter(item => `${item.name} ${item.sub}`.toLowerCase().includes(q));
    }
    if (scope === 'recent') {
      return patient.recents.map(id => byId.get(id)).filter((i): i is LoggableItem => Boolean(i));
    }
    if (scope === 'favorites') {
      return patient.favorites.map(id => byId.get(id)).filter((i): i is LoggableItem => Boolean(i));
    }
    return allItems;
  }, [query, scope, allItems, byId, patient.recents, patient.favorites]);

  const selected = selectedId ? byId.get(selectedId) : undefined;

  // Patient-only route: deep links must not bypass the persona flow.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/today');
  };

  const addSelected = async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      await patient.addEntry({
        dateKey,
        meal,
        kind: selected.kind,
        refId: selected.refId,
        name: selected.name,
        detail: `${formatQty(qty)} × ${selected.serving}`,
        quantity: qty,
        calories: Math.round(selected.calories * qty),
        protein: Math.round(selected.protein * qty),
        carbs: Math.round(selected.carbs * qty),
        fat: Math.round(selected.fat * qty),
      });
      goBack();
    } finally {
      setSaving(false);
    }
  };

  const saveQuickAdd = async () => {
    if (saving) return;
    const name = quickName.trim();
    const calories = parseNum(quickCals);
    if (!name) {
      setQuickError('Give it a name.');
      return;
    }
    if (Number.isNaN(calories)) {
      setQuickError('Calories are required (0 or more).');
      return;
    }
    setQuickError('');
    setSaving(true);
    try {
      const protein = Number.isNaN(parseNum(quickProtein)) ? 0 : parseNum(quickProtein);
      const carbs = Number.isNaN(parseNum(quickCarbs)) ? 0 : parseNum(quickCarbs);
      const fat = Number.isNaN(parseNum(quickFat)) ? 0 : parseNum(quickFat);
      const serving = quickServing.trim() || '1 serving';
      const food = await patient.addCustomFood({
        name,
        serving,
        calories: Math.round(calories),
        protein: Math.round(protein),
        carbs: Math.round(carbs),
        fat: Math.round(fat),
      });
      await patient.addEntry({
        dateKey,
        meal,
        kind: 'food',
        refId: food.id,
        name: food.name,
        detail: `1 × ${food.serving}`,
        quantity: 1,
        calories: food.calories,
        protein: food.protein,
        carbs: food.carbs,
        fat: food.fat,
      });
      goBack();
    } finally {
      setSaving(false);
    }
  };

  const numericInputProps = {
    keyboardType: Platform.OS === 'web' ? undefined : ('decimal-pad' as const),
    placeholderTextColor: colors.subtleText,
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Header ── */}
      <View style={[styles.header, { paddingTop: topPad, borderBottomColor: colors.border }]}>
        <Pressable testID="logfood-cancel" onPress={goBack} hitSlop={8}>
          <Text style={[styles.headerAction, { color: colors.cobalt }]}>Cancel</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.navy }]}>Add Food</Text>
          <Text style={[styles.headerSub, { color: colors.subtleText }]}>
            {dateKey === TODAY_KEY ? 'Today' : formatDateKey(dateKey)}
          </Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad + (selected ? 120 : 0) }]}
      >
        <PillSelector options={MEAL_OPTIONS} selected={meal} onSelect={setMeal} style={{ marginBottom: 12 }} />

        <View style={[styles.searchBox, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <Feather name="search" size={14} color={colors.subtleText} />
          <TextInput
            testID="logfood-search"
            value={query}
            onChangeText={setQuery}
            placeholder="Search foods and recipes..."
            placeholderTextColor={colors.subtleText}
            style={[styles.searchInput, { color: colors.foreground }]}
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Feather name="x" size={14} color={colors.subtleText} />
            </Pressable>
          )}
        </View>

        {query.trim() === '' && (
          <PillSelector options={SCOPE_OPTIONS} selected={scope} onSelect={setScope} style={{ marginTop: 10 }} />
        )}

        {/* ── Quick add ── */}
        <LedgerCard style={{ marginTop: 12 }}>
          <Pressable
            testID="logfood-quick-toggle"
            onPress={() => setQuickOpen(open => !open)}
            style={({ pressed }) => [styles.quickToggle, pressed && { backgroundColor: colors.accent }]}
          >
            <Feather name={quickOpen ? 'chevron-down' : 'plus'} size={14} color={colors.cobalt} />
            <Text style={[styles.quickToggleText, { color: colors.cobalt }]}>
              Quick add a custom food
            </Text>
          </Pressable>
          {quickOpen && (
            <View style={styles.quickForm}>
              <Divider style={{ marginBottom: 12 }} />
              <TextInput
                testID="logfood-quick-name"
                value={quickName}
                onChangeText={setQuickName}
                placeholder="Name (e.g. Deli turkey sandwich)"
                placeholderTextColor={colors.subtleText}
                style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background }]}
              />
              <TextInput
                testID="logfood-quick-serving"
                value={quickServing}
                onChangeText={setQuickServing}
                placeholder="Serving (e.g. 1 sandwich)"
                placeholderTextColor={colors.subtleText}
                style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background }]}
              />
              <View style={styles.quickGrid}>
                <View style={styles.quickGridItem}>
                  <Text style={[styles.quickFieldLabel, { color: colors.labelText }]}>CALORIES</Text>
                  <TextInput
                    testID="logfood-quick-calories"
                    value={quickCals}
                    onChangeText={setQuickCals}
                    placeholder="0"
                    {...numericInputProps}
                    style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, marginBottom: 0 }]}
                  />
                </View>
                <View style={styles.quickGridItem}>
                  <Text style={[styles.quickFieldLabel, { color: colors.labelText }]}>PROTEIN G</Text>
                  <TextInput
                    testID="logfood-quick-protein"
                    value={quickProtein}
                    onChangeText={setQuickProtein}
                    placeholder="0"
                    {...numericInputProps}
                    style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, marginBottom: 0 }]}
                  />
                </View>
                <View style={styles.quickGridItem}>
                  <Text style={[styles.quickFieldLabel, { color: colors.labelText }]}>CARBS G</Text>
                  <TextInput
                    testID="logfood-quick-carbs"
                    value={quickCarbs}
                    onChangeText={setQuickCarbs}
                    placeholder="0"
                    {...numericInputProps}
                    style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, marginBottom: 0 }]}
                  />
                </View>
                <View style={styles.quickGridItem}>
                  <Text style={[styles.quickFieldLabel, { color: colors.labelText }]}>FAT G</Text>
                  <TextInput
                    testID="logfood-quick-fat"
                    value={quickFat}
                    onChangeText={setQuickFat}
                    placeholder="0"
                    {...numericInputProps}
                    style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, marginBottom: 0 }]}
                  />
                </View>
              </View>
              {quickError ? (
                <Text style={[styles.quickError, { color: colors.riskText }]}>{quickError}</Text>
              ) : null}
              <Pressable
                testID="logfood-quick-save"
                onPress={saveQuickAdd}
                disabled={saving}
                style={({ pressed }) => [
                  styles.quickSaveBtn,
                  { backgroundColor: colors.cobalt },
                  (pressed || saving) && { opacity: 0.85 },
                ]}
              >
                <Text style={[styles.quickSaveText, { color: colors.primaryForeground }]}>
                  Save & Log to {MEAL_LABELS[meal]}
                </Text>
              </Pressable>
            </View>
          )}
        </LedgerCard>

        {/* ── Results ── */}
        <Text style={[styles.resultCount, { color: colors.labelText }]}>
          {visible.length} ITEM{visible.length === 1 ? '' : 'S'}
        </Text>
        {visible.length === 0 ? (
          <LedgerCard>
            <EmptyState
              icon={<Feather name="search" size={22} color={colors.subtleText} />}
              title={scope === 'recent' && !query ? 'Nothing logged yet' : scope === 'favorites' && !query ? 'No favorites yet' : 'No matches'}
              body={
                scope === 'recent' && !query
                  ? 'Foods you log will show up here for fast re-adding.'
                  : scope === 'favorites' && !query
                    ? 'Star recipes in the Recipes tab to see them here.'
                    : 'Try a different search, or quick add it above.'
              }
            />
          </LedgerCard>
        ) : (
          <LedgerCard>
            {visible.map((item, index) => {
              const isSelected = selectedId === item.refId;
              return (
                <View key={`${item.refId}-${index}`}>
                  {index > 0 && <Divider />}
                  <Pressable
                    testID={`logfood-item-${item.refId}`}
                    onPress={() => {
                      setSelectedId(current => (current === item.refId ? null : item.refId));
                      setQty(1);
                    }}
                    style={({ pressed }) => [
                      styles.itemRow,
                      isSelected && { backgroundColor: colors.sidebarBg },
                      pressed && !isSelected && { backgroundColor: colors.accent },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.itemName, { color: colors.navyLight }]} numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Text style={[styles.itemSub, { color: colors.subtleText }]} numberOfLines={1}>
                        {item.sub} · {item.serving} · P {item.protein}g
                      </Text>
                    </View>
                    <Text style={[styles.itemCals, { color: colors.navyLight }]}>{item.calories}</Text>
                    <Feather
                      name={isSelected ? 'check-square' : 'plus-square'}
                      size={16}
                      color={isSelected ? colors.cobalt : colors.subtleText}
                    />
                  </Pressable>
                </View>
              );
            })}
          </LedgerCard>
        )}
      </KeyboardAwareScrollViewCompat>

      {/* ── Selected item action bar ── */}
      {selected && (
        <View
          style={[
            styles.actionBar,
            {
              backgroundColor: colors.card,
              borderTopColor: colors.border,
              paddingBottom: bottomPad,
            },
          ]}
        >
          <View style={styles.actionInfo}>
            <Text style={[styles.actionName, { color: colors.navyLight }]} numberOfLines={1}>
              {selected.name}
            </Text>
            <Text style={[styles.actionMeta, { color: colors.subtleText }]}>
              {formatQty(qty)} × {selected.serving} · {Math.round(selected.calories * qty)} cal
            </Text>
          </View>
          <View style={styles.actionControls}>
            <Pressable
              testID="logfood-qty-minus"
              onPress={() => setQty(q => Math.max(0.5, Math.round((q - 0.5) * 2) / 2))}
              disabled={qty <= 0.5}
              style={({ pressed }) => [
                styles.stepBtn,
                { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.background },
                qty <= 0.5 && { opacity: 0.35 },
              ]}
            >
              <Feather name="minus" size={13} color={colors.bodyText} />
            </Pressable>
            <Text style={[styles.qtyValue, { color: colors.navy }]}>{formatQty(qty)}</Text>
            <Pressable
              testID="logfood-qty-plus"
              onPress={() => setQty(q => Math.min(10, Math.round((q + 0.5) * 2) / 2))}
              disabled={qty >= 10}
              style={({ pressed }) => [
                styles.stepBtn,
                { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.background },
                qty >= 10 && { opacity: 0.35 },
              ]}
            >
              <Feather name="plus" size={13} color={colors.bodyText} />
            </Pressable>
            <Pressable
              testID="logfood-add"
              onPress={addSelected}
              disabled={saving}
              style={({ pressed }) => [
                styles.addBtn,
                { backgroundColor: colors.cobalt },
                (pressed || saving) && { opacity: 0.85 },
              ]}
            >
              <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>
                Add to {MEAL_LABELS[meal]}
              </Text>
            </Pressable>
          </View>
        </View>
      )}
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
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.2,
  },
  headerSub: {
    fontSize: 10,
    marginTop: 1,
    fontFamily: 'Inter_400Regular',
  },
  headerSpacer: {
    width: 52,
  },
  content: {
    padding: 16,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 38,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  quickToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  quickToggleText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  quickForm: {
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  quickInput: {
    borderWidth: 1,
    paddingHorizontal: 10,
    height: 38,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    marginBottom: 8,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  quickGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  quickGridItem: {
    flex: 1,
  },
  quickFieldLabel: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
    marginBottom: 4,
  },
  quickError: {
    fontSize: 11,
    marginTop: 8,
    fontFamily: 'Inter_400Regular',
  },
  quickSaveBtn: {
    marginTop: 12,
    paddingVertical: 11,
    alignItems: 'center',
  },
  quickSaveText: {
    fontSize: 12.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  resultCount: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    marginTop: 14,
    marginBottom: 8,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  itemName: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  itemSub: {
    fontSize: 10.5,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  itemCals: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  actionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  actionInfo: {
    marginBottom: 10,
  },
  actionName: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  actionMeta: {
    fontSize: 11,
    marginTop: 1,
    fontFamily: 'Inter_400Regular',
  },
  actionControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stepBtn: {
    width: 32,
    height: 38,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyValue: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    minWidth: 30,
    textAlign: 'center',
  },
  addBtn: {
    flex: 1,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
});
