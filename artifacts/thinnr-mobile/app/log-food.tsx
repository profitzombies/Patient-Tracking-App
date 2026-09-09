/**
 * Log Food — search the food database and recipes, pick a quantity, and
 * add it to a meal. Includes recents, favorites, quick-add custom foods,
 * and — when the viewed day's previous day has entries in the selected
 * slot — a "Yesterday's [meal]" option above the most-logged group that
 * opens a review-and-log of that whole slot.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { OrdinaryTextInput as TextInput } from '@/components/ui/OrdinaryTextInput';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { ApprovedBadge } from '@/components/patient/ApprovedBadge';
import { Divider, EmptyState, LedgerCard, PillSelector } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import { usePatient } from '@/context/PatientContext';
import { yesterdaySlotPreview } from '@/data/diary-entries';
import {
  DIARY_MIN_KEY,
  formatDateKey,
  MEAL_LABELS,
  MEAL_SLOTS,
  shiftDateKey,
  type MealSlot,
} from '@/data/patient-data';
import { catalogFoodToLoggable, useLoggableItems, type LoggableItem } from '@/hooks/useLoggableItems';
import {
  useFoodCatalogSearch,
} from '@/hooks/useFoodCatalogSearch';
import { catalogFoodSnapshot, runAccountGuardedSteps, selectCatalogFood } from '@/lib/food-catalog';
import {
  buildFoodLogEntry,
  foodResultDisplayText,
  getItemNutritionSnapshot,
  selectionMatchesItemConfiguration,
  selectionDisplayText,
  useFoodLogging,
  withItemNutritionSnapshot,
} from '@/context/FoodLoggingContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { usePatientSync } from '@/context/PatientContext';
import { toTitleCase } from '@/lib/title-case';
import { scaledSnapshotMacros, snapshotConfigurationId } from '@/data/food-nutrition';

type Scope = 'recent' | 'favorites';
type Intent = 'basic' | 'packaged' | 'recipe';

/** A titled section of the results list (title is null for flat lists). */
interface ResultGroup {
  key: string;
  title: string | null;
  items: LoggableItem[];
}

const SCOPE_OPTIONS: { label: string; value: Scope }[] = [
  { label: 'Recent', value: 'recent' },
  { label: 'Favorites', value: 'favorites' },
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
  const sync = usePatientSync();
  const { account } = usePatientAccount();
  const accountKey = account.kind === 'real' ? `real:${account.patientId}` : account.kind;
  const accountRef = useRef(accountKey);
  const accountGenerationRef = useRef(0);
  if (accountRef.current !== accountKey) {
    accountRef.current = accountKey;
    accountGenerationRef.current += 1;
  }
  const { mode, hydrated: modeHydrated } = useAppMode();
  const params = useLocalSearchParams<{ date?: string; meal?: string }>();

  const dateKey = typeof params.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
    ? params.date
    : patient.todayKey;
  const initialMeal = MEAL_SLOTS.includes(params.meal as MealSlot)
    ? (params.meal as MealSlot)
    : 'breakfast';

  const [meal, setMeal] = useState<MealSlot>(initialMeal);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('recent');
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [screenAccountKey, setScreenAccountKey] = useState(accountKey);
  const [basketExpanded, setBasketExpanded] = useState(false);
  const [moreWaysOpen, setMoreWaysOpen] = useState(false);
  const [favoriteLimit, setFavoriteLimit] = useState(6);
  const basket = useFoodLogging();
  const operationIsCurrent = (capture: { accountKey: string; generation: number }) =>
    accountRef.current === capture.accountKey && accountGenerationRef.current === capture.generation;
  const captureOperation = () => ({ accountKey, generation: accountGenerationRef.current });

  // Quick-add form
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickName, setQuickName] = useState('');
  const [quickServing, setQuickServing] = useState('');
  const [quickCals, setQuickCals] = useState('');
  const [quickProtein, setQuickProtein] = useState('');
  const [quickCarbs, setQuickCarbs] = useState('');
  const [quickFat, setQuickFat] = useState('');
  const [quickError, setQuickError] = useState('');

  useEffect(() => {
    setScreenAccountKey(accountKey);
    setMeal(initialMeal);
    setQuery('');
    setScope('recent');
    setApprovedOnly(false);
    setIntent('basic');
    setQuickOpen(false);
    setQuickName('');
    setQuickServing('');
    setQuickCals('');
    setQuickProtein('');
    setQuickCarbs('');
    setQuickFat('');
    setQuickError('');
    setBasketExpanded(false);
    setMoreWaysOpen(false);
    setFavoriteLimit(6);
    savingRef.current = false;
    setSaving(false);
  }, [accountKey]);

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 20 : Math.max(insets.bottom, 16);

  const [intent, setIntent] = useState<Intent>('basic');

  // One catalog shared with the "Yesterday's [meal]" review, so both search
  // the exact same items.
  const { allItems, byId } = useLoggableItems();
  const catalogSearch = useFoodCatalogSearch(
    patient.allFoods,
    patient.customFoods,
    query,
    approvedOnly,
    intent === 'recipe' ? 'basic' : intent,
    undefined,
    patient.catalogFoods,
    patient.recents,
  );
  const catalogItems = useMemo(() => {
    const convert = catalogFoodToLoggable;
    return {
      common: catalogSearch.common.map(convert),
      personal: catalogSearch.personal.map(convert),
      branded: catalogSearch.branded.map(convert),
      results: (catalogSearch.results ?? []).map(convert),
    };
  }, [
    catalogSearch.common,
    catalogSearch.personal,
    catalogSearch.branded,
    catalogSearch.results,
    intent,
  ]);
  // "Yesterday's [meal]" — the previous day's entries for the selected slot,
  // offered above the most-logged group as a tap-in review-and-log.
  // "Yesterday" follows the diary's meaning (the day before the date being
  // viewed); below the diary horizon there is no previous day, and an empty
  // slot hides the option entirely.
  const isToday = dateKey === patient.todayKey;
  const prevKey = shiftDateKey(dateKey, -1);
  const atMin = dateKey <= DIARY_MIN_KEY;
  const yesterdayOption = atMin
    ? null
    : yesterdaySlotPreview(patient.entriesForDate(prevKey), meal);
  // Same label rule as the diary's copy actions: "Yesterday's …" only when
  // viewing today; otherwise name the actual source date.
  const yesterdayTitle = isToday
    ? `Yesterday's ${MEAL_LABELS[meal]}`
    : `${MEAL_LABELS[meal]} from ${formatDateKey(prevKey)}`;

  const groups = useMemo<ResultGroup[]>(() => {
    const q = query.trim().toLowerCase();
    let built: ResultGroup[];
    if (q) {
      if (intent === 'recipe') {
        const recipeMatches = allItems.filter(
          item => item.kind === 'recipe' && `${item.name} ${item.sub}`.toLowerCase().includes(q),
        ).slice(0, 6);
        built = [
          { key: 'recipes', title: 'RECIPES', items: recipeMatches },
        ];
      } else if (intent === 'packaged') {
        built = [
          { key: 'packaged', title: 'PACKAGED PRODUCTS', items: catalogItems.results },
        ];
      } else {
        built = [
          { key: 'results', title: 'RESULTS', items: catalogItems.results },
        ];
      }
    } else if (scope === 'recent') {
      const seenFamilies = new Set<string>();
      const recents = patient.recents
        .map(id => byId.get(id))
        .filter((i): i is LoggableItem => Boolean(i))
        .filter(item => {
          const key = getItemNutritionSnapshot(item)?.variant?.familyKey ?? item.refId;
          if (seenFamilies.has(key)) return false;
          seenFamilies.add(key);
          return true;
        })
        .slice(0, 6);
      built = [{ key: 'recent', title: null, items: recents }];
    } else if (scope === 'favorites') {
      built = [{
        key: 'favorites',
        title: null,
        items: patient.favorites
          .map(id => byId.get(id))
          .filter((i): i is LoggableItem => Boolean(i))
          .slice(0, favoriteLimit),
      }];
    } else {
      built = [{ key: 'all', title: null, items: allItems }];
    }
    return built
      .map(group => (approvedOnly ? { ...group, items: group.items.filter(item => item.approved) } : group))
      .filter(group => group.items.length > 0);
  }, [query, scope, approvedOnly, allItems, byId, patient.recents, patient.favorites, catalogItems, intent, favoriteLimit]);

  const totalVisible = groups.reduce((sum, group) => sum + group.items.length, 0);

  // Patient-only route: deep links must not bypass the persona flow.
  if (!modeHydrated) return null;
  if (screenAccountKey !== accountKey) return null;
  if (mode !== 'patient') {
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/today');
  };
  const cancelLogging = () => {
    basket.clear();
    goBack();
  };

  const toggleCatalogFavorite = async (item: LoggableItem) => {
    const operation = captureOperation();
    if (!item.catalog || item.catalog.persisted || item.catalog.group === 'personal') {
      await patient.toggleFavorite(item.refId);
      if (!operationIsCurrent(operation)) return;
      return;
    }
    const favoriteDraft = {
      id: item.refId,
      catalogId: item.catalog.catalogId,
      group: item.catalog.group,
      source: item.catalog.source,
      sourceLabel: item.catalog.sourceLabel,
      ...(item.catalog.lookupId ? { lookupId: item.catalog.lookupId } : {}),
      approved: item.approved,
      name: item.name,
      category: item.catalog.group === 'branded' ? 'Branded Products' : 'Common Foods',
      serving: item.serving,
      calories: item.calories,
      protein: item.protein,
      carbs: item.carbs,
      fat: item.fat,
      measures: item.catalog.measures,
      ...(item.catalog.servingGrams ? { servingGrams: item.catalog.servingGrams } : {}),
      ...(item.catalog.canonicalName ? { canonicalName: item.catalog.canonicalName } : {}),
      ...(item.catalog.resultKey ? { resultKey: item.catalog.resultKey } : {}),
      ...(item.catalog.familyKey ? { familyKey: item.catalog.familyKey } : {}),
      ...(item.catalog.variantSummary ? { variantSummary: item.catalog.variantSummary } : {}),
      ...(item.catalog.dimensions ? { dimensions: item.catalog.dimensions } : {}),
      ...(item.catalog.choiceRequired !== undefined ? { choiceRequired: item.catalog.choiceRequired } : {}),
      ...(item.catalog.nutritionSnapshot ? { nutritionSnapshot: item.catalog.nutritionSnapshot } : {}),
    };
    if (account.kind !== 'real' && account.kind !== 'demo') {
      throw new Error('Your patient account is unavailable. Please sign in again.');
    }
    const selectedCatalog = account.kind === 'real'
      ? await selectCatalogFood(favoriteDraft)
      : favoriteDraft;
    if (!operationIsCurrent(operation)) return;
    const itemSnapshot = getItemNutritionSnapshot(item);
    const snapshot = {
      ...catalogFoodSnapshot(selectedCatalog),
      ...(itemSnapshot ? { nutritionSnapshot: itemSnapshot } : {}),
    };
    const configured = await patient.saveFoodConfiguration(snapshot, { favorite: true });
    if (!operationIsCurrent(operation)) return;
    if (configured && !patient.favorites.includes(configured.id)) {
      // handled by { favorite: true }
    }
  };

  /** Navigate to the full recipe page so the patient can review before logging. */
  const openRecipe = (item: LoggableItem) => {
    router.push({
      pathname: '/recipe/[id]',
      params: { id: item.refId, date: dateKey, meal },
    });
  };

  /** Hand off to the yesterday review — it logs the final selection itself. */
  const openYesterdayReview = () => {
    router.push({ pathname: '/yesterday-review', params: { date: dateKey, meal } });
  };

  const addSelected = async () => {
    if (basket.selected.length === 0 || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const operation = captureOperation();
    try {
      const prepared = await Promise.all(basket.selected.map(async selection => {
        const item = selection.item;
        const configuredSnapshot = getItemNutritionSnapshot(item);
        if (item.refId.startsWith('cfg_')) {
          if (!configuredSnapshot) return selection;
          const totals = scaledSnapshotMacros(configuredSnapshot);
          const expectedId = snapshotConfigurationId(configuredSnapshot);
          const configured = await patient.saveFoodConfiguration({
            id: expectedId,
            name: item.name,
            serving: item.serving,
            category: item.catalog?.group === 'branded' ? 'Branded Products' : 'Common Foods',
            calories: totals?.calories ?? item.calories,
            protein: totals?.protein ?? item.protein,
            carbs: totals?.carbs ?? item.carbs,
            fat: totals?.fat ?? item.fat,
            catalogShared: true,
            catalogSourceLabel: item.catalog?.sourceLabel,
            catalogApproved: item.approved,
            ...(item.catalog?.lookupId ? { catalogLookupId: item.catalog.lookupId } : {}),
            ...(item.catalog?.servingGrams ? { catalogServingGrams: item.catalog.servingGrams } : {}),
            catalogMeasures: item.catalog?.measures ?? [],
            ...(item.catalog?.canonicalName ? { catalogCanonicalName: item.catalog.canonicalName } : {}),
            nutritionSnapshot: configuredSnapshot,
          });
          if (!operationIsCurrent(operation)) throw new Error('Your account changed. Please review your foods again.');
          if (!configured) throw new Error(`Could not save ${item.name}. Please try again.`);
          return {
            ...selection,
            item: withItemNutritionSnapshot({ ...item, refId: configured.id }, configuredSnapshot),
          };
        }
        if (!item.catalog || item.catalog.group === 'personal') return selection;

        const totals = configuredSnapshot ? scaledSnapshotMacros(configuredSnapshot) : null;
        const selectionDraft = {
            id: item.refId, catalogId: item.catalog!.catalogId, group: item.catalog!.group,
            source: item.catalog!.source, sourceLabel: item.catalog!.sourceLabel,
            ...(item.catalog!.selectionToken ? { selectionToken: item.catalog!.selectionToken } : {}),
             ...(item.catalog!.lookupId ? { lookupId: item.catalog!.lookupId } : {}),
            approved: item.approved, name: item.name,
            category: item.catalog!.group === 'branded' ? 'Branded Products' : 'Common Foods',
            serving: item.serving, calories: item.calories, protein: item.protein, carbs: item.carbs, fat: item.fat,
            measures: item.catalog!.measures,
            ...(item.catalog!.servingGrams ? { servingGrams: item.catalog!.servingGrams } : {}),
             ...(item.catalog!.canonicalName ? { canonicalName: item.catalog!.canonicalName } : {}),
             ...(item.catalog!.resultKey ? { resultKey: item.catalog!.resultKey } : {}),
             ...(item.catalog!.familyKey ? { familyKey: item.catalog!.familyKey } : {}),
             ...(item.catalog!.variantSummary ? { variantSummary: item.catalog!.variantSummary } : {}),
             ...(item.catalog!.dimensions ? { dimensions: item.catalog!.dimensions } : {}),
             ...(item.catalog!.choiceRequired !== undefined ? { choiceRequired: item.catalog!.choiceRequired } : {}),
             ...(configuredSnapshot ? { nutritionSnapshot: configuredSnapshot } : {}),
        };
        const guarded = await runAccountGuardedSteps(
          () => {
            if (account.kind === 'real') return selectCatalogFood(selectionDraft);
            if (account.kind === 'demo') return Promise.resolve(selectionDraft);
            return Promise.reject(new Error('Your patient account is unavailable. Please sign in again.'));
          },
          persisted => patient.saveFoodConfiguration({
            ...catalogFoodSnapshot({
              ...persisted,
              ...(totals ?? {}),
              ...(configuredSnapshot ? { nutritionSnapshot: configuredSnapshot } : {}),
            }),
            ...(configuredSnapshot ? { nutritionSnapshot: configuredSnapshot } : {}),
          }),
          () => operationIsCurrent(operation),
        );
        if (guarded.status === 'stale') throw new Error('Your account changed. Please review your foods again.');
        const configured = guarded.second;
        if (!configured) throw new Error(`Could not save ${item.name}. Please try again.`);
        return {
          ...selection,
          item: configuredSnapshot
            ? withItemNutritionSnapshot({ ...item, refId: configured.id }, configuredSnapshot)
            : { ...item, refId: configured.id },
        };
      }));
      if (!operationIsCurrent(operation)) return;
      const entries = prepared.map(selection => buildFoodLogEntry(selection, { dateKey, meal }));
      const result = await patient.submitFoodEntries(entries);
      if (!operationIsCurrent(operation)) return;
      if (result.outcome === 'rejected') {
        setQuickError(result.message);
      } else if (result.outcome === 'queued') {
        basket.clear();
        setQuickError('Saved on this device; waiting to sync.');
      } else {
        basket.clear();
        goBack();
      }
    } catch (error) {
      if (operationIsCurrent(operation)) {
        setQuickError(error instanceof Error ? error.message : 'Those foods could not be saved. Please try again.');
      }
    } finally {
      if (operationIsCurrent(operation)) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  const saveQuickAdd = async () => {
    if (saving) return;
    const operation = captureOperation();
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
      const guarded = await runAccountGuardedSteps(
        () => patient.addCustomFood({
          // Created names are Title Case everywhere foods are created.
          name: toTitleCase(name),
          serving,
          calories: Math.round(calories),
          protein: Math.round(protein),
          carbs: Math.round(carbs),
          fat: Math.round(fat),
        }),
        food => patient.submitFoodEntries([{
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
        }]),
        () => operationIsCurrent(operation),
      );
      if (guarded.status === 'stale') return;
      const result = guarded.second;
      if (result.outcome === 'rejected') {
        setQuickError(result.message);
      } else {
        goBack();
      }
    } finally {
      if (operationIsCurrent(operation)) setSaving(false);
    }
  };

  const numericInputProps = {
    keyboardType: Platform.OS === 'web' ? undefined : ('decimal-pad' as const),
    placeholderTextColor: colors.subtleText,
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Header ── */}
      <View style={[styles.header, { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
        <Pressable testID="logfood-cancel" onPress={cancelLogging} hitSlop={8}>
          <Text style={[styles.headerAction, { color: colors.cobalt }]}>Cancel</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.navy }]}>Add Food</Text>
          <Text style={[styles.headerSub, { color: colors.subtleText }]}>
            {dateKey === patient.todayKey ? 'Today' : formatDateKey(dateKey)}
          </Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAwareScrollViewCompat
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad + (basket.selected.length ? 150 : 0) }]}
      >
        <PillSelector options={MEAL_OPTIONS} selected={meal} onSelect={setMeal} style={{ marginBottom: 12 }} />

        <View style={styles.searchRow}>
          <View style={[styles.searchBox, { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm }]}>
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
        </View>

        {query.trim().length > 0 && (
          <>
          <View style={styles.intentLinks}>
            {([
              ['basic', 'Basic foods'],
              ['packaged', 'Search packaged foods'],
              ['recipe', 'Search recipes'],
            ] as const).map(([value, label]) => (
              <Pressable key={value} onPress={() => setIntent(value)} hitSlop={8}>
                <Text style={[
                  styles.intentLink,
                  { color: intent === value ? colors.navyLight : colors.cobalt },
                  intent === value && styles.intentLinkActive,
                ]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          {intent !== 'recipe' && !!catalogSearch.querySuggestions?.length && (
            <View testID="logfood-search-suggestions" style={styles.intentLinks}>
              {catalogSearch.querySuggestions.map(suggestion => (
                <Pressable
                  key={suggestion}
                  testID={`logfood-suggestion-${suggestion}`}
                  onPress={() => setQuery(suggestion)}
                  style={[styles.suggestion, { borderColor: colors.border }]}
                >
                  <Text style={[styles.intentLink, { color: colors.cobalt }]}>{suggestion}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {intent !== 'recipe' && catalogSearch.correctedQuery && catalogSearch.correctedQuery !== query.trim() && (
            <Text testID="logfood-corrected-query" style={[styles.correctionHint, { color: colors.subtleText }]}>
              Results for “{catalogSearch.correctedQuery}”
            </Text>
          )}
          </>
        )}

        {approvedOnly && (
          <View style={styles.legendRow}>
            <ApprovedBadge size="sm" />
            <Text style={[styles.legendText, { color: colors.subtleText }]}>
              Showing only foods approved for the THINNR program
            </Text>
            <Pressable onPress={() => setApprovedOnly(false)} hitSlop={8}>
              <Text style={[styles.legendText, { color: colors.cobalt }]}>Remove</Text>
            </Pressable>
          </View>
        )}

        {query.trim() === '' && (
          <PillSelector options={SCOPE_OPTIONS} selected={scope} onSelect={setScope} style={{ marginTop: 10 }} />
        )}

        {basket.selected.length > 0 && basketExpanded && (
          <LedgerCard style={{ marginTop: 12 }}>
            <Pressable
              testID="logfood-basket-toggle"
              accessibilityState={{ expanded: basketExpanded }}
              onPress={() => setBasketExpanded(value => !value)}
              style={styles.selectionHeader}
            >
              <Text style={[styles.groupHeader, { color: colors.labelText, paddingHorizontal: 0, paddingTop: 0 }]}>
                SELECTED FOODS · {basket.selected.length}
              </Text>
              <Feather name={basketExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.cobalt} />
            </Pressable>
            {basket.selected.map((selection, index) => (
              <View key={selection.basketId}>
                {index > 0 && <Divider />}
                <View style={styles.selectedRow}>
                  <Pressable
                    testID={`logfood-review-${selection.basketId}`}
                    accessibilityLabel={`Review ${selection.item.name}, ${selection.ounces !== undefined ? `${formatQty(selection.ounces)} ounces` : `${formatQty(selection.quantity)} servings`}`}
                    accessibilityHint={selection.item.kind === 'recipe' ? 'Recipe amount controls are shown here' : 'Opens food weight and nutrition details'}
                    onPress={() => {
                      if (selection.item.kind === 'recipe') return;
                      basket.remember(selection.item);
                      router.push({
                        pathname: '/food/[id]',
                        params: { id: selection.item.refId, basketId: selection.basketId, approvedOnly: approvedOnly ? 'true' : 'false' },
                      });
                    }}
                    disabled={selection.item.kind === 'recipe'}
                    style={{ flex: 1 }}
                  >
                    <Text style={[styles.actionName, { color: colors.navyLight }]} numberOfLines={1}>{selection.item.name}</Text>
                    <Text style={[styles.actionMeta, { color: colors.subtleText }]}>
                      {selectionDisplayText(selection)}
                    </Text>
                  </Pressable>
                  {selection.item.kind === 'recipe' && (
                    <View style={styles.recipeQuantity}>
                      <Pressable
                        accessibilityLabel={`Decrease ${selection.item.name} quantity`}
                        onPress={() => basket.configure(
                          selection.item,
                          { quantity: Math.max(0.5, selection.quantity - 0.5) },
                          selection.basketId,
                        )}
                        hitSlop={8}
                      >
                        <Feather name="minus-circle" size={18} color={colors.cobalt} />
                      </Pressable>
                      <Text style={[styles.actionMeta, { color: colors.bodyText }]}>
                        {formatQty(selection.quantity)}
                      </Text>
                      <Pressable
                        accessibilityLabel={`Increase ${selection.item.name} quantity`}
                        onPress={() => basket.configure(
                          selection.item,
                          { quantity: selection.quantity + 0.5 },
                          selection.basketId,
                        )}
                        hitSlop={8}
                      >
                        <Feather name="plus-circle" size={18} color={colors.cobalt} />
                      </Pressable>
                    </View>
                  )}
                  <Pressable
                    testID={`logfood-remove-${selection.basketId}`}
                    accessibilityLabel={`Remove ${selection.item.name} from selected foods`}
                    onPress={() => basket.remove(selection.basketId)}
                    hitSlop={10}
                  >
                    <Feather name="x" size={16} color={colors.subtleText} />
                  </Pressable>
                </View>
              </View>
            ))}
            <Pressable accessibilityLabel="Clear all selected foods" onPress={basket.clear} style={styles.showMoreBtn}>
              <Text style={[styles.clearSelection, { color: colors.cobalt }]}>Clear all</Text>
            </Pressable>
          </LedgerCard>
        )}

        {sync.foodSubmissions.map(submission => (
          <LedgerCard key={submission.queueId} style={{ marginTop: 12 }}>
            <Text style={[styles.groupHeader, { color: colors.labelText, paddingHorizontal: 0, paddingTop: 0 }]}>
              {submission.status === 'pending' ? 'PENDING SYNC' : 'SUBMISSION NEEDS REVIEW'}
            </Text>
            <Text style={[styles.actionMeta, { color: colors.subtleText, marginTop: 6 }]}>
              {submission.entries.length} {submission.entries.length === 1 ? 'food' : 'foods'}
              {submission.status === 'pending'
                ? ' saved on this device; waiting to sync.'
                : ` not accepted. ${submission.message ?? 'Please retry when ready.'}`}
            </Text>
            {submission.status === 'rejected' && (
              <Pressable
                testID={`logfood-retry-${submission.queueId}`}
                onPress={() => {
                  if (!sync.retryFoodSubmission(submission.queueId)) {
                    setQuickError('That submission is no longer available to retry.');
                  }
                }}
                style={styles.showMoreBtn}
              >
                <Text style={[styles.showMoreText, { color: colors.cobalt }]}>Retry same submission</Text>
              </Pressable>
            )}
          </LedgerCard>
        ))}

        {query.trim().length >= 2 && (catalogSearch.loading || catalogSearch.error || catalogSearch.upstreamUnavailable) && (
          <View testID="logfood-catalog-state" style={styles.catalogState}>
            <Feather
              name={catalogSearch.loading ? 'loader' : 'wifi-off'}
              size={12}
              color={colors.subtleText}
            />
            <Text style={[styles.catalogStateText, { color: colors.subtleText }]}>
              {catalogSearch.loading
                ? 'Searching the shared catalog… Local matches are ready.'
                : catalogSearch.error ?? catalogSearch.message ?? 'Branded search is unavailable. Local matches are still shown.'}
            </Text>
            {!!catalogSearch.error && (
              <Pressable testID="logfood-catalog-retry" onPress={catalogSearch.retry} hitSlop={8}>
                <Text style={[styles.showMoreText, { color: colors.cobalt }]}>Retry</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* ── Quick add ── */}
        <LedgerCard style={{ marginTop: 12 }}>
          <Pressable
            testID="logfood-more-ways-toggle"
            onPress={() => setMoreWaysOpen(open => !open)}
            style={({ pressed }) => [styles.quickToggle, pressed && { backgroundColor: colors.accent }]}
          >
            <Feather name={moreWaysOpen ? 'chevron-down' : 'plus'} size={14} color={colors.cobalt} />
            <Text style={[styles.quickToggleText, { color: colors.cobalt }]}>
              More ways to add
            </Text>
          </Pressable>
          {moreWaysOpen && (
            <View style={styles.quickForm}>
              <Divider style={{ marginBottom: 12 }} />
              <View style={styles.toolLinks}>
                <Pressable onPress={() => router.push('/barcode-scan')}><Text style={[styles.intentLink, { color: colors.cobalt }]}>Scan barcode</Text></Pressable>
                <Pressable onPress={() => router.push('/food-camera')}><Text style={[styles.intentLink, { color: colors.cobalt }]}>Photo or label</Text></Pressable>
                <Pressable onPress={() => router.push('/create-food')}><Text style={[styles.intentLink, { color: colors.cobalt }]}>Create food</Text></Pressable>
                <Pressable
                  testID="logfood-approved-toggle"
                  accessibilityLabel="Only show approved foods"
                  onPress={() => setApprovedOnly(value => !value)}
                >
                  <Text style={[styles.intentLink, { color: approvedOnly ? colors.activeGreen : colors.cobalt }]}>
                    {approvedOnly ? '✓ Approved only' : 'Approved only'}
                  </Text>
                </Pressable>
              </View>
              <Pressable
                testID="logfood-quick-toggle"
                onPress={() => setQuickOpen(open => !open)}
                style={styles.inlineQuickToggle}
              >
                <Text style={[styles.intentLink, { color: colors.cobalt }]}>Quick add nutrition</Text>
                <Feather name={quickOpen ? 'chevron-up' : 'chevron-down'} size={14} color={colors.cobalt} />
              </Pressable>
              {quickOpen && (
                <View>
              <TextInput
                testID="logfood-quick-name"
                value={quickName}
                onChangeText={setQuickName}
                placeholder="Name (e.g. Deli turkey sandwich)"
                placeholderTextColor={colors.subtleText}
                style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, borderRadius: colors.radiusSm }]}
              />
              <TextInput
                testID="logfood-quick-serving"
                value={quickServing}
                onChangeText={setQuickServing}
                placeholder="Serving (e.g. 1 sandwich)"
                placeholderTextColor={colors.subtleText}
                style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, borderRadius: colors.radiusSm }]}
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
                    style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, borderRadius: colors.radiusSm, marginBottom: 0 }]}
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
                    style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, borderRadius: colors.radiusSm, marginBottom: 0 }]}
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
                    style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, borderRadius: colors.radiusSm, marginBottom: 0 }]}
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
                    style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, borderRadius: colors.radiusSm, marginBottom: 0 }]}
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
                  { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                  (pressed || saving) && { opacity: 0.85 },
                ]}
              >
                <Text style={[styles.quickSaveText, { color: colors.primaryForeground }]}>
                  Save & Log to {MEAL_LABELS[meal]}
                </Text>
              </Pressable>
                </View>
              )}
            </View>
          )}
        </LedgerCard>

        {/* ── Yesterday's [meal] — review & log the previous day's slot ── */}
        {query.trim() === '' && yesterdayOption && (
          <LedgerCard style={{ marginTop: 12 }}>
            <Pressable
              testID="logfood-yesterday"
              accessibilityRole="button"
              accessibilityLabel={`${yesterdayTitle}: ${yesterdayOption.sources.map(e => e.name).join(', ')}. ${yesterdayOption.calories} calories total.`}
              accessibilityHint={`Opens a review where you can remove items or add more before logging to ${MEAL_LABELS[meal]}.`}
              onPress={openYesterdayReview}
              style={({ pressed }) => [styles.yesterdayRow, pressed && { opacity: 0.75 }]}
            >
              <View
                style={[
                  styles.yesterdayIcon,
                  { backgroundColor: colors.accent, borderRadius: colors.radiusSm },
                ]}
              >
                <Feather name="rotate-ccw" size={14} color={colors.cobalt} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.yesterdayTitle, { color: colors.cobalt }]}>
                  {yesterdayTitle}
                </Text>
                <Text
                  style={[styles.yesterdayMeta, { color: colors.subtleText }]}
                  numberOfLines={1}
                >
                  {yesterdayOption.sources.map(e => e.name).join(', ')} ·{' '}
                  {yesterdayOption.calories.toLocaleString('en-US')} cal
                </Text>
              </View>
              <Feather name="chevron-right" size={15} color={colors.subtleText} />
            </Pressable>
          </LedgerCard>
        )}

        {/* ── Results ── */}
        <Text style={[styles.resultCount, { color: colors.labelText }]}>
          {totalVisible} ITEM{totalVisible === 1 ? '' : 'S'}
          {approvedOnly ? ' · APPROVED' : ''}
        </Text>
        {totalVisible === 0 ? (
          <LedgerCard>
            <EmptyState
              icon={<Feather name="search" size={22} color={colors.subtleText} />}
              title={
                approvedOnly
                  ? 'No approved foods here'
                  : scope === 'recent' && !query
                    ? 'Nothing logged yet'
                    : scope === 'favorites' && !query
                      ? 'No favorites yet'
                      : 'No matches'
              }
              body={
                approvedOnly
                  ? 'Turn off the filter, or browse Approved Foods in the Library tab.'
                  : scope === 'recent' && !query
                    ? 'Foods you log will show up here for fast re-adding.'
                    : scope === 'favorites' && !query
                      ? 'Tap the star on any food or recipe to save it here for one-tap logging.'
                      : 'Try a different search, or quick add it above.'
              }
            />
          </LedgerCard>
        ) : (
          <LedgerCard>
            {groups.map((group, groupIndex) => (
              <View key={group.key}>
                {groupIndex > 0 && <Divider />}
                {group.title && (
                  <Text
                    testID={`logfood-group-${group.key}`}
                    style={[styles.groupHeader, { color: colors.labelText }]}
                  >
                    {group.title}
                  </Text>
                )}
                {group.items.map((item, index) => {
                   const isSelected = basket.selected.some(entry => selectionMatchesItemConfiguration(entry, item));
                  const isRecipe = item.kind === 'recipe';
                  const selectedSummary = foodResultDisplayText(item);
                  return (
                    <View key={`${item.refId}-${index}`}>
                      {index > 0 && <Divider />}
                      <View style={[styles.itemRow, isSelected && { backgroundColor: colors.sidebarBg }]}>
                        <Pressable
                          testID={`logfood-item-${item.refId}`}
                          accessibilityRole="button"
                          accessibilityLabel={`Open details for ${item.name}`}
                          accessibilityHint={isRecipe ? 'Opens recipe details' : 'Opens food weight and nutrition details'}
                          onPress={() => {
                            if (isRecipe) openRecipe(item);
                            else {
                              basket.remember(item);
                              router.push({ pathname: '/food/[id]', params: { id: item.refId, approvedOnly: approvedOnly ? 'true' : 'false' } });
                            }
                          }}
                          style={({ pressed }) => [styles.itemOpen, pressed && { opacity: 0.65 }]}
                        >
                          <View style={{ flex: 1 }}>
                            <View style={styles.itemNameRow}>
                              <Text style={[styles.itemName, { color: colors.navyLight }]} numberOfLines={1}>
                                {item.name}
                              </Text>
                              {item.approved && <ApprovedBadge size="sm" />}
                            </View>
                            <Text style={[styles.itemSub, { color: colors.subtleText }]} numberOfLines={1}>
                              {item.loggedCount ? `${item.loggedCount}× logged · ` : ''}
                              {isRecipe ? `${item.sub} · ${item.serving}` : selectedSummary}
                            </Text>
                          </View>
                        </Pressable>
                        {isRecipe ? (
                          /* Separate Pressable so + quick-adds without opening the page */
                          <Pressable
                            testID={`logfood-quicklog-${item.refId}`}
                            accessibilityLabel={`Quick add 1 serving of ${item.name}`}
                            onPress={() => {
                              Keyboard.dismiss();
                              basket.toggle(item);
                            }}
                            disabled={saving}
                            hitSlop={12}
                            style={({ pressed }) => [styles.plusTarget, pressed && { opacity: 0.6 }]}
                          >
                            <Feather name="plus-square" size={20} color={colors.subtleText} />
                          </Pressable>
                         ) : (
                           <Pressable
                             testID={`logfood-select-${item.refId}`}
                             accessibilityRole="checkbox"
                             accessibilityState={{ checked: isSelected }}
                             accessibilityLabel={`${isSelected ? 'Remove' : 'Select'} ${item.name}`}
                             onPress={() => {
                               Keyboard.dismiss();
                               if (item.catalog?.choiceRequired) {
                                 basket.remember(item);
                                 router.push({ pathname: '/food/[id]', params: { id: item.refId, approvedOnly: approvedOnly ? 'true' : 'false' } });
                               } else {
                                 basket.toggle(item);
                               }
                             }}
                             hitSlop={12}
                             style={({ pressed }) => [styles.plusTarget, pressed && { opacity: 0.6 }]}
                           >
                             <Feather name={isSelected ? 'check-square' : 'plus-square'} size={20} color={isSelected ? colors.cobalt : colors.subtleText} />
                           </Pressable>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            ))}

            {query.trim() === '' && scope === 'favorites' && patient.favorites.length > favoriteLimit && (
              <View>
                <Divider />
                <Pressable
                  testID="logfood-favorites-show-more"
                  onPress={() => setFavoriteLimit(limit => limit + 6)}
                  style={styles.showMoreBtn}
                >
                  <Text style={[styles.showMoreText, { color: colors.cobalt }]}>Show more favorites</Text>
                </Pressable>
              </View>
            )}

            {query.trim().length > 0 && catalogSearch.hasMore && !catalogSearch.pagingError && (
              <View>
                <Divider />
                <Pressable
                  testID="logfood-show-more"
                  onPress={catalogSearch.showMore}
                  disabled={catalogSearch.loadingMore}
                  style={({ pressed }) => [
                    styles.showMoreBtn,
                    pressed && { backgroundColor: colors.accent }
                  ]}
                >
                  {catalogSearch.loadingMore ? (
                    <Feather name="loader" size={16} color={colors.subtleText} style={{ marginRight: 6 }} />
                  ) : null}
                  <Text style={[styles.showMoreText, { color: colors.cobalt }]}>
                    {catalogSearch.loadingMore ? 'Loading...' : 'Show more results'}
                  </Text>
                </Pressable>
              </View>
            )}
            {query.trim().length > 0 && !!catalogSearch.pagingError && (
              <View>
                <Divider />
                <Pressable testID="logfood-show-more-retry" onPress={catalogSearch.showMore} style={styles.showMoreBtn}>
                  <Text style={[styles.showMoreText, { color: colors.cobalt }]}>Couldn’t load more · Retry</Text>
                </Pressable>
              </View>
            )}
          </LedgerCard>
        )}
      </KeyboardAwareScrollViewCompat>

      {/* ── Selected item action bar ── */}
      {basket.selected.length > 0 && (
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
          <Pressable
            testID="logfood-basket-summary"
            style={styles.actionInfo}
            accessibilityLabel={`${basket.selected.length} foods selected. Review selections`}
            accessibilityState={{ expanded: basketExpanded }}
            onPress={() => setBasketExpanded(value => !value)}
          >
            <Text style={[styles.actionName, { color: colors.navyLight }]}>
              {basket.selected.length} food{basket.selected.length === 1 ? '' : 's'} selected
            </Text>
            <Text style={[styles.actionMeta, { color: colors.subtleText }]} numberOfLines={2}>
              {basket.selected.map(entry => entry.item.name).join(', ')}
            </Text>
          </Pressable>
          <View style={styles.actionControls}>
            <Pressable
              testID="logfood-add"
              onPress={addSelected}
              disabled={saving}
              style={({ pressed }) => [
                styles.addBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                (pressed || saving) && { opacity: 0.85 },
              ]}
            >
              <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>
                 {saving ? 'Adding…' : `Log all to ${MEAL_LABELS[meal]}`}
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
    fontSize: 17,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.1,
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
  searchRow: {
    flexDirection: 'row',
    gap: 8,
  },
  intentLinks: {
    marginTop: 9,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  intentLink: {
    fontSize: 11.5,
    lineHeight: 18,
    fontFamily: 'Inter_500Medium',
  },
  intentLinkActive: {
    textDecorationLine: 'underline',
  },
  suggestion: {
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
  },
  correctionHint: {
    marginTop: 6,
    fontSize: 10.5,
    fontFamily: 'Inter_400Regular',
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 38,
  },
  approvedBtn: {
    width: 38,
    height: 38,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  legendText: {
    fontSize: 10.5,
    fontFamily: 'Inter_400Regular',
  },
  catalogState: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 9,
  },
  catalogStateText: {
    flex: 1,
    fontSize: 10.5,
    lineHeight: 14,
    fontFamily: 'Inter_400Regular',
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
  toolLinks: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 18,
    rowGap: 8,
    marginBottom: 10,
  },
  inlineQuickToggle: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  selectionHeader: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  clearSelection: {
    fontSize: 10.5,
    fontFamily: 'Inter_600SemiBold',
  },
  showMoreBtn: {
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  showMoreText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  plusTarget: {
    padding: 12, // larger target area
    marginLeft: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedRow: {
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  recipeQuantity: {
    marginTop: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  yesterdayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  yesterdayIcon: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  yesterdayTitle: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  yesterdayMeta: {
    fontSize: 10.5,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  groupHeader: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 2,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  itemOpen: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  itemNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  itemName: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    flexShrink: 1,
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
    boxShadow: '0 -8px 20px rgba(40, 55, 74, 0.08)',
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
