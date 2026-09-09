import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, useLocalSearchParams, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NutritionFacts } from '@/components/patient/NutritionFacts';
import { LedgerCard, PillSelector } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import {
  buildFoodLogEntry, getItemNutritionSnapshot, selectionScale, supportsOunces, useFoodLogging,
  withItemNutritionSnapshot,
} from '@/context/FoodLoggingContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { usePatient } from '@/context/PatientContext';
import type { FoodItem } from '@/data/patient-data';
import { MEAL_LABELS, MEAL_SLOTS, type MealSlot } from '@/data/patient-data';
import {
  scaledSnapshotMacros, selectSnapshotPortion, snapshotConfigurationId, snapshotPortion,
  visibleNutritionPortions,
} from '@/data/food-nutrition';
import type { FoodNutritionSnapshot } from '@/data/food-nutrition';
import { useColors } from '@/hooks/useColors';
import { catalogFoodToLoggable, type LoggableItem, useLoggableItems } from '@/hooks/useLoggableItems';
import {
  catalogErrorMessage, catalogFoodSnapshot, getFamilyVariants, selectCatalogFood, type CatalogFood,
} from '@/lib/food-catalog';

type Draft = {
  key: string;
  item: LoggableItem;
  snapshot: FoodNutritionSnapshot | null;
  quantity: number;
  ounces?: number;
};

function display(value: number, decimalPlaces = 2): string {
  return Number(value.toFixed(decimalPlaces)).toString();
}

function accountKey(account: ReturnType<typeof usePatientAccount>['account']): string {
  return account.kind === 'real' ? `real:${account.patientId}` : account.kind;
}

function foodItemForSave(item: LoggableItem, snapshot: FoodNutritionSnapshot): FoodItem {
  const macros = scaledSnapshotMacros(snapshot);
  return {
    id: item.refId,
    name: item.name,
    serving: item.serving,
    calories: macros?.calories ?? item.calories,
    protein: macros?.protein ?? item.protein,
    carbs: macros?.carbs ?? item.carbs,
    fat: macros?.fat ?? item.fat,
    category: item.catalog?.group === 'branded' ? 'Branded Products' : 'Common Foods',
    catalogShared: true,
    catalogSourceLabel: item.catalog?.sourceLabel,
    catalogApproved: item.approved,
    catalogLookupId: item.catalog?.lookupId,
    catalogServingGrams: item.catalog?.servingGrams,
    catalogMeasures: item.catalog?.measures,
    catalogCanonicalName: item.catalog?.canonicalName,
    nutritionSnapshot: snapshot,
  };
}

function catalogFromItem(item: LoggableItem): CatalogFood | null {
  if (!item.catalog) return null;
  return {
    id: item.refId,
    catalogId: item.catalog.catalogId,
    group: item.catalog.group,
    source: item.catalog.source,
    sourceLabel: item.catalog.sourceLabel,
    approved: item.approved,
    name: item.name,
    serving: item.serving,
    calories: item.calories,
    protein: item.protein,
    carbs: item.carbs,
    fat: item.fat,
    category: item.catalog.group === 'branded' ? 'Branded Products' : 'Common Foods',
    measures: item.catalog.measures,
    ...(item.catalog.lookupId ? { lookupId: item.catalog.lookupId } : {}),
    ...(item.catalog.selectionToken ? { selectionToken: item.catalog.selectionToken } : {}),
    ...(item.catalog.servingGrams ? { servingGrams: item.catalog.servingGrams } : {}),
    ...(item.catalog.canonicalName ? { canonicalName: item.catalog.canonicalName } : {}),
    ...(item.catalog.resultKey ? { resultKey: item.catalog.resultKey } : {}),
    ...(item.catalog.familyKey ? { familyKey: item.catalog.familyKey } : {}),
    ...(item.catalog.variantSummary ? { variantSummary: item.catalog.variantSummary } : {}),
    ...(item.catalog.dimensions ? { dimensions: item.catalog.dimensions } : {}),
    ...(item.catalog.choiceRequired !== undefined ? { choiceRequired: item.catalog.choiceRequired } : {}),
    ...(item.catalog.nutritionSnapshot ? { nutritionSnapshot: item.catalog.nutritionSnapshot } : {}),
  };
}

function visibleOptions(values: string[], current: string | undefined, expanded: boolean): string[] {
  if (expanded || values.length <= 3) return values;
  const common = values.slice(0, 3);
  if (!current || common.includes(current)) return common;
  return [...values.slice(0, 2), current];
}

export default function FoodDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const patientAccount = usePatientAccount();
  const { mode, hydrated } = useAppMode();
  const pathname = usePathname();
  const params = useLocalSearchParams<{
    id: string; basketId?: string; approvedOnly?: string; origin?: string; date?: string; meal?: string;
  }>();
  const id = params.id;
  const routeBasketId = params.basketId;
  const libraryOrigin = params.origin === 'library';
  const targetDate = typeof params.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
    ? params.date
    : patient.todayKey;
  const initialMeal = MEAL_SLOTS.includes(params.meal as MealSlot) ? params.meal as MealSlot : 'breakfast';
  const approvedOnly = params.approvedOnly === 'true' || params.approvedOnly === '1';
  const { byId, allItems } = useLoggableItems();
  const basket = useFoodLogging();
  const selected = libraryOrigin ? undefined : routeBasketId
    ? basket.selected.find(entry => entry.basketId === routeBasketId)
    : basket.selected.find(entry => entry.item.refId === id);
  const initialItem = selected?.item ?? basket.recalled(id ?? '') ?? byId.get(id ?? '')
    ?? allItems.find(candidate => candidate.refId === id);
  const currentAccountKey = accountKey(patientAccount.account);
  const initialKeyRef = useRef(`${currentAccountKey}:${id ?? ''}:${routeBasketId ?? ''}`);
  const guardRef = useRef({ accountKey: currentAccountKey, pathname });
  guardRef.current = { accountKey: currentAccountKey, pathname };
  const [draft, setDraft] = useState<Draft | null>(() => {
    if (!initialItem) return null;
    const snapshot = getItemNutritionSnapshot(initialItem);
    return {
      key: initialKeyRef.current,
      item: initialItem,
      snapshot,
      quantity: selected?.quantity ?? 1,
      ...(selected?.ounces !== undefined
        ? { ounces: selected.ounces }
        : !snapshot && supportsOunces(initialItem) ? { ounces: 5 } : {}),
    };
  });
  const [variants, setVariants] = useState<CatalogFood[]>([]);
  const [loadingVariants, setLoadingVariants] = useState(false);
  const [variantError, setVariantError] = useState<string | null>(null);
  const [variantAttempt, setVariantAttempt] = useState(0);
  const [showVariants, setShowVariants] = useState(false);
  const [expandedDimensions, setExpandedDimensions] = useState<Record<string, boolean>>({});
  const [showAllUnits, setShowAllUnits] = useState(false);
  const [showNutrition, setShowNutrition] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [proposedVariant, setProposedVariant] = useState<CatalogFood | null>(null);
  const [portionNotice, setPortionNotice] = useState<string | null>(null);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [libraryMeal, setLibraryMeal] = useState<MealSlot>(initialMeal);
  const [librarySaving, setLibrarySaving] = useState(false);
  const librarySavingRef = useRef(false);
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);

  useEffect(() => {
    if (draft || !initialItem) return;
    if (`${currentAccountKey}:${id ?? ''}:${routeBasketId ?? ''}` !== initialKeyRef.current) return;
    const initialSnapshot = getItemNutritionSnapshot(initialItem);
    setDraft({
      key: initialKeyRef.current,
      item: initialItem,
      snapshot: initialSnapshot,
      quantity: selected?.quantity ?? 1,
      ...(selected?.ounces !== undefined
        ? { ounces: selected.ounces }
        : !initialSnapshot && supportsOunces(initialItem) ? { ounces: 5 } : {}),
    });
  }, [draft, initialItem, currentAccountKey, id, routeBasketId, selected]);

  useEffect(() => {
    if (`${currentAccountKey}:${id ?? ''}:${routeBasketId ?? ''}` === initialKeyRef.current) return;
    setDraft(null);
    router.replace('/log-food');
  }, [currentAccountKey, id, routeBasketId]);

  const familyKey = draft?.item.catalog?.familyKey;
  useEffect(() => {
    if (!familyKey) return;
    const controller = new AbortController();
    const requestAccount = currentAccountKey;
    setLoadingVariants(true);
    setVariantError(null);
    getFamilyVariants(familyKey, approvedOnly, controller.signal)
      .then(fetched => {
        if (controller.signal.aborted || guardRef.current.accountKey !== requestAccount) return;
        setVariants(fetched);
        setLoadingVariants(false);
      })
      .catch(error => {
        if (controller.signal.aborted || guardRef.current.accountKey !== requestAccount) return;
        setVariantError(catalogErrorMessage(error));
        setLoadingVariants(false);
      });
    return () => controller.abort();
  }, [familyKey, approvedOnly, variantAttempt, currentAccountKey]);

  if (!hydrated) return null;
  if (mode !== 'patient') return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  if (!patient.hydrated) return null;
  if (!draft || draft.item.kind !== 'food') {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.bodyText }}>Food not found.</Text>
      </View>
    );
  }

  const item = draft.item;
  const snapshot = draft.snapshot;
  const activePortion = snapshot ? snapshotPortion(snapshot) : undefined;
  const amount = snapshot
    ? `${display(snapshot.selected.amount)} ${activePortion?.label ?? snapshot.selected.unitId}`
    : draft.ounces !== undefined
      ? `${display(draft.ounces)} oz`
      : `${display(draft.quantity)} × ${item.serving}`;
  const legacyScale = selectionScale({
    basketId: routeBasketId ?? '',
    item,
    quantity: draft.quantity,
    ...(draft.ounces !== undefined ? { ounces: draft.ounces } : {}),
  });
  const macros = snapshot ? scaledSnapshotMacros(snapshot) : null;
  const macroValues = {
    calories: macros?.calories ?? item.calories * (snapshot ? 1 : legacyScale),
    protein: macros?.protein ?? item.protein * (snapshot ? 1 : legacyScale),
    carbs: macros?.carbs ?? item.carbs * (snapshot ? 1 : legacyScale),
    fat: macros?.fat ?? item.fat * (snapshot ? 1 : legacyScale),
  };
  const weightBased = snapshot ? activePortion?.dimension === 'weight' : supportsOunces(item);
  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 67 : 12);
  const bottomPad = Platform.OS === 'web' ? 34 : Math.max(insets.bottom, 16);
  const configurationId = snapshot ? snapshotConfigurationId(snapshot) : item.refId;
  const isFavorite = patient.favorites.includes(configurationId);
  const selectablePortions = snapshot
    ? visibleNutritionPortions(snapshot, {
        preserveSelected: Boolean(selected || item.catalog?.persisted),
      })
    : [];
  const visiblePortions = snapshot
    ? showAllUnits || selectablePortions.length <= 3
      ? selectablePortions
      : selectablePortions.slice(0, 3).some(portion => portion.id === snapshot.selected.unitId)
        ? selectablePortions.slice(0, 3)
        : [...selectablePortions.slice(0, 2), snapshotPortion(snapshot)!].filter(
            (portion, index, portions) => !!portion && portions.findIndex(candidate => candidate?.id === portion.id) === index,
          )
    : [];

  const updateVariant = (food: CatalogFood) => {
    const nextItem = catalogFoodToLoggable(food);
    let nextSnapshot = getItemNutritionSnapshot(nextItem);
    let reset = true;
    if (snapshot && nextSnapshot && activePortion?.grams) {
      const physicalGrams = snapshot.selected.amount * activePortion.grams;
      const compatible = nextSnapshot.portions.find(portion =>
        portion.dimension === activePortion.dimension && portion.grams && portion.grams > 0);
      if (compatible) {
        const selectedSnapshot = selectSnapshotPortion(nextSnapshot, physicalGrams / compatible.grams!, compatible.id);
        if (selectedSnapshot) {
          nextSnapshot = selectedSnapshot;
          reset = false;
        }
      }
    }
    setDraft(current => current ? {
      ...current,
      item: nextSnapshot ? withItemNutritionSnapshot(nextItem, nextSnapshot) : nextItem,
      snapshot: nextSnapshot,
      quantity: nextSnapshot?.selected.scale ?? 1,
      ounces: undefined,
    } : current);
    setPortionNotice(reset ? 'This type uses different portion evidence, so its documented portion was reset.' : null);
    setProposedVariant(null);
  };

  const adjust = (direction: -1 | 1) => {
    if (snapshot) {
      const step = activePortion?.dimension === 'weight' ? 0.5 : 1;
      const quotient = snapshot.selected.amount / step;
      const onGrid = Math.abs(quotient - Math.round(quotient)) < 1e-10;
      const nextAmount = Math.max(step, onGrid
        ? snapshot.selected.amount + direction * step
        : direction > 0 ? Math.ceil(quotient) * step : Math.floor(quotient) * step);
      const nextSnapshot = selectSnapshotPortion(snapshot, nextAmount, snapshot.selected.unitId);
      if (nextSnapshot) {
        setDraft(current => current ? {
          ...current,
          snapshot: nextSnapshot,
          item: withItemNutritionSnapshot(current.item, nextSnapshot),
          quantity: nextSnapshot.selected.scale,
          ounces: undefined,
        } : current);
      }
      return;
    }
    setDraft(current => {
      if (!current) return current;
      if (current.ounces !== undefined) {
        return { ...current, ounces: Math.min(32, Math.max(0.5, current.ounces + direction * 0.5)) };
      }
      return { ...current, quantity: Math.min(10, Math.max(0.5, current.quantity + direction * 0.5)) };
    });
  };

  const save = () => {
    const finalItem = snapshot ? withItemNutritionSnapshot(item, snapshot) : item;
    basket.configure(
      finalItem,
      snapshot
        ? { quantity: snapshot.selected.scale }
        : { quantity: draft.quantity, ...(draft.ounces !== undefined ? { ounces: draft.ounces } : {}) },
      routeBasketId,
    );
    router.back();
  };

  const addFromLibrary = async () => {
    if (librarySavingRef.current) return;
    librarySavingRef.current = true;
    setLibrarySaving(true);
    setLibraryNotice(null);
    const requestAccount = currentAccountKey;
    const requestPath = pathname;
    const requestIsCurrent = () =>
      guardRef.current.accountKey === requestAccount && guardRef.current.pathname === requestPath;
    try {
      if (patientAccount.account.kind !== 'real' && patientAccount.account.kind !== 'demo') {
        throw new Error('Your patient account is unavailable. Please sign in again.');
      }
      const finalItem = snapshot ? withItemNutritionSnapshot(item, snapshot) : item;
      let logItem = finalItem;
      const catalog = catalogFromItem(finalItem);
      const shouldPromote = patientAccount.account.kind === 'real';
      const promoted = shouldPromote && catalog && catalog.group !== 'personal' && !catalog.catalogId.startsWith('cfg_')
        ? await selectCatalogFood(catalog)
        : null;
      if (!requestIsCurrent()) return;
      if (snapshot) {
        const saveFood = promoted
          ? {
              ...catalogFoodSnapshot(promoted),
              ...foodItemForSave(finalItem, snapshot),
              nutritionSnapshot: snapshot,
            }
          : foodItemForSave(finalItem, snapshot);
        const configured = await patient.saveFoodConfiguration(saveFood);
        if (!requestIsCurrent()) return;
        if (!configured) throw new Error('Could not save this food configuration.');
        logItem = { ...finalItem, refId: configured.id };
      } else if (catalog && catalog.group !== 'personal') {
        // Snapshotless reviewed singletons still need a private lookup copy so
        // recents/favorites can resolve them offline. Real accounts first use
        // the protected promotion endpoint; guided demo accounts explicitly
        // retain the local source identity and never attempt that endpoint.
        const selectedCatalog = promoted ?? catalog;
        const lookupCopy = {
          ...catalogFoodSnapshot(selectedCatalog),
          name: finalItem.name,
          serving: finalItem.serving,
          calories: finalItem.calories,
          protein: finalItem.protein,
          carbs: finalItem.carbs,
          fat: finalItem.fat,
        };
        const saved = await patient.saveCatalogFood(lookupCopy);
        if (!requestIsCurrent()) return;
        if (!saved) throw new Error('Could not save this food.');
        logItem = { ...finalItem, refId: lookupCopy.id };
      }
      const result = await patient.submitFoodEntries([buildFoodLogEntry({
        basketId: 'library-direct',
        item: logItem,
        quantity: snapshot?.selected.scale ?? draft.quantity,
        ...(!snapshot && draft.ounces !== undefined ? { ounces: draft.ounces } : {}),
      }, { dateKey: targetDate, meal: libraryMeal })]);
      if (!requestIsCurrent()) return;
      if (result.outcome === 'rejected') throw new Error(result.message);
      setLibraryNotice(result.outcome === 'queued'
        ? `Added to ${MEAL_LABELS[libraryMeal]} on this device; waiting to sync.`
        : `Added to ${MEAL_LABELS[libraryMeal]}.`);
    } catch (error) {
      if (requestIsCurrent()) {
        setLibraryNotice(error instanceof Error ? error.message : 'Could not add this food. Please try again.');
      }
    } finally {
      librarySavingRef.current = false;
      if (requestIsCurrent()) setLibrarySaving(false);
    }
  };

  const toggleFavorite = async () => {
    if (favoriteBusy) return;
    setFavoriteBusy(true);
    setFavoriteError(null);
    const requestAccount = currentAccountKey;
    const requestPath = pathname;
    try {
      if (!snapshot) {
        await patient.toggleFavorite(item.refId);
        return;
      }
      const saved = await patient.saveFoodConfiguration(foodItemForSave(item, snapshot), { favorite: !isFavorite });
      if (guardRef.current.accountKey !== requestAccount || guardRef.current.pathname !== requestPath) return;
      if (!saved) setFavoriteError('Could not update this favorite. Please try again.');
    } catch {
      if (guardRef.current.accountKey === requestAccount && guardRef.current.pathname === requestPath) {
        setFavoriteError('Could not update this favorite. Please try again.');
      }
    } finally {
      if (guardRef.current.accountKey === requestAccount && guardRef.current.pathname === requestPath) {
        setFavoriteBusy(false);
      }
    }
  };

  const dimensionKeys = Array.from(new Set(variants.flatMap(variant => Object.keys(variant.dimensions ?? {}))));

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, {
        paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt,
      }]}>
        <Pressable testID="food-detail-back" accessibilityLabel="Back to food search" onPress={() => router.back()} style={styles.iconButton}>
          <Feather name="chevron-left" size={18} color={colors.bodyText} />
        </Pressable>
        <Text style={[styles.headerLabel, { color: colors.labelText }]}>FOOD DETAILS</Text>
        <View style={styles.iconButton} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: bottomPad + 90 }}>
        <Text testID="food-detail-name" style={[styles.foodName, { color: colors.navy }]}>{item.name}</Text>
        {!!(snapshot?.variant?.summary ?? item.catalog?.variantSummary) && (
          <Text style={[styles.summary, { color: colors.bodyText }]}>
            {snapshot?.variant?.summary ?? item.catalog?.variantSummary}
          </Text>
        )}

        <LedgerCard style={{ padding: 16, marginTop: 16 }}>
          <Text style={[styles.label, { color: colors.labelText }]}>{weightBased ? 'AMOUNT' : 'SERVING QUANTITY'}</Text>
          {snapshot && (
            <View style={styles.optionRow}>
              {visiblePortions.map(portion => (
                <Pressable
                  testID={`food-detail-unit-${portion.id}`}
                  key={portion.id}
                  onPress={() => {
                    const nextAmount = snapshot.selected.scale / portion.basisMultiplier;
                    const next = selectSnapshotPortion(snapshot, nextAmount, portion.id);
                    if (next) {
                      setDraft(current => current ? {
                        ...current, snapshot: next,
                        item: withItemNutritionSnapshot(current.item, next),
                        quantity: next.selected.scale, ounces: undefined,
                      } : current);
                    }
                  }}
                  style={[styles.option, { borderColor: snapshot.selected.unitId === portion.id ? colors.cobalt : colors.border },
                    snapshot.selected.unitId === portion.id && { backgroundColor: colors.accent }]}
                >
                  <Text style={[styles.optionText, { color: snapshot.selected.unitId === portion.id ? colors.cobalt : colors.bodyText }]}>
                    {portion.label}
                  </Text>
                </Pressable>
              ))}
               {!showAllUnits && selectablePortions.length > 3 && (
                <Pressable onPress={() => setShowAllUnits(true)} style={styles.more}>
                  <Text style={[styles.moreText, { color: colors.cobalt }]}>More units</Text>
                </Pressable>
              )}
            </View>
          )}
          <View style={styles.amountRow}>
            <Pressable testID="food-detail-minus" accessibilityLabel="Decrease amount" onPress={() => adjust(-1)} style={[styles.step, { borderColor: colors.border }]}>
              <Feather name="minus" size={16} color={colors.bodyText} />
            </Pressable>
            <Text testID="food-detail-amount" accessibilityLabel={`Current amount ${amount}`} style={[styles.amount, { color: colors.navy }]}>{amount}</Text>
            <Pressable testID="food-detail-plus" accessibilityLabel="Increase amount" onPress={() => adjust(1)} style={[styles.step, { borderColor: colors.border }]}>
              <Feather name="plus" size={16} color={colors.bodyText} />
            </Pressable>
          </View>
        </LedgerCard>

        <LedgerCard style={{ padding: 16, marginTop: 12 }}>
          <Text style={[styles.label, { color: colors.labelText }]}>NUTRITION · {amount.toUpperCase()}</Text>
          <View
            style={styles.nutrition}
            accessibilityLabel={`${Math.round(macroValues.calories)} calories, ${display(macroValues.protein, 1)} grams protein, ${display(macroValues.carbs, 1)} grams carbs, ${display(macroValues.fat, 1)} grams fat`}
          >
            {([
              ['CALORIES', Math.round(macroValues.calories)],
              ['PROTEIN', `${display(macroValues.protein, 1)}g`],
              ['CARBS', `${display(macroValues.carbs, 1)}g`],
              ['FAT', `${display(macroValues.fat, 1)}g`],
            ] as const).map(([label, value]) => (
              <View key={label} style={styles.nutritionCell}>
                <Text style={[styles.nutritionValue, { color: colors.navy }]}>{value}</Text>
                <Text style={[styles.label, { color: colors.labelText }]}>{label}</Text>
              </View>
            ))}
          </View>
        </LedgerCard>

        {!!familyKey && (
          <LedgerCard style={{ marginTop: 12 }}>
            <Pressable testID="food-detail-change-type" onPress={() => setShowVariants(value => !value)} style={styles.collapseHeader}>
              <Text style={[styles.label, { color: colors.labelText }]}>CHANGE TYPE / PREPARATION</Text>
              <Feather name={showVariants ? 'chevron-up' : 'chevron-down'} size={16} color={colors.subtleText} />
            </Pressable>
            {showVariants && (
              <View style={styles.collapseBody}>
                <View style={[styles.divider, { backgroundColor: colors.border }]} />
                {loadingVariants ? <ActivityIndicator size="small" color={colors.cobalt} /> : null}
                {variantError ? (
                  <View style={styles.messageBlock}>
                    <Text style={[styles.note, { color: colors.bodyText }]}>{variantError}</Text>
                    <Pressable testID="food-detail-variant-retry" onPress={() => setVariantAttempt(value => value + 1)}>
                      <Text style={[styles.moreText, { color: colors.cobalt }]}>Retry</Text>
                    </Pressable>
                  </View>
                ) : null}
                {!loadingVariants && !variantError && dimensionKeys.map(dimKey => {
                  const values = Array.from(new Set(variants.map(variant => variant.dimensions?.[dimKey]).filter((value): value is string => !!value)));
                  if (values.length <= 1) return null;
                  const currentValue = item.catalog?.dimensions?.[dimKey] ?? snapshot?.variant?.dimensions[dimKey];
                  return (
                    <View key={dimKey} style={styles.dimension}>
                      <Text style={[styles.dimensionLabel, { color: colors.bodyText }]}>{dimKey.toUpperCase()}</Text>
                      <View style={styles.optionRow}>
                        {visibleOptions(values, currentValue, !!expandedDimensions[dimKey]).map(value => {
                          const desired = { ...(item.catalog?.dimensions ?? snapshot?.variant?.dimensions ?? {}), [dimKey]: value };
                          const direct = variants.find(variant =>
                            Object.entries(desired).every(([key, selectedValue]) => variant.dimensions?.[key] === selectedValue));
                          const alternate = variants.find(variant => variant.dimensions?.[dimKey] === value);
                          const selectedValue = currentValue === value;
                          return (
                            <Pressable
                              testID={`food-detail-dimension-${dimKey}-${value}`}
                              key={value}
                              accessibilityHint={!direct ? 'Requires changing other type choices and confirmation' : undefined}
                              onPress={() => direct ? updateVariant(direct) : alternate && setProposedVariant(alternate)}
                              style={[styles.option, { borderColor: selectedValue ? colors.cobalt : colors.border },
                                selectedValue && { backgroundColor: colors.accent }]}
                            >
                              <Text style={[styles.optionText, { color: selectedValue ? colors.cobalt : colors.bodyText }]}>{value}</Text>
                            </Pressable>
                          );
                        })}
                        {!expandedDimensions[dimKey] && values.length > 3 && (
                          <Pressable onPress={() => setExpandedDimensions(current => ({ ...current, [dimKey]: true }))} style={styles.more}>
                            <Text style={[styles.moreText, { color: colors.cobalt }]}>More options</Text>
                          </Pressable>
                        )}
                      </View>
                    </View>
                  );
                })}
                {!loadingVariants && !variantError && variants.length > 0 && (
                  <Text style={[styles.note, { color: colors.subtleText }]}>
                    If a choice is not available with the other selected attributes, its complete supported type
                    will be shown for confirmation. Nothing changes silently.
                  </Text>
                )}
                {proposedVariant && (
                  <View style={[styles.confirm, { borderColor: colors.border }]}>
                    <Text style={[styles.note, { color: colors.bodyText }]}>
                      That choice is only available as: {proposedVariant.variantSummary ?? Object.values(proposedVariant.dimensions ?? {}).join(' · ')}.
                    </Text>
                    <View style={styles.confirmActions}>
                      <Pressable onPress={() => setProposedVariant(null)}>
                        <Text style={[styles.moreText, { color: colors.bodyText }]}>Cancel</Text>
                      </Pressable>
                      <Pressable testID="food-detail-confirm-variant" onPress={() => updateVariant(proposedVariant)}>
                        <Text style={[styles.moreText, { color: colors.cobalt }]}>Use this type</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
                {portionNotice && <Text style={[styles.note, { color: colors.bodyText }]}>{portionNotice}</Text>}
              </View>
            )}
          </LedgerCard>
        )}

        <LedgerCard style={{ marginTop: 12 }}>
          <Pressable testID="food-detail-nutrition-toggle" onPress={() => setShowNutrition(value => !value)} style={styles.collapseHeader}>
            <Text style={[styles.label, { color: colors.labelText }]}>NUTRITION FACTS</Text>
            <Feather name={showNutrition ? 'chevron-up' : 'chevron-down'} size={16} color={colors.subtleText} />
          </Pressable>
          {showNutrition && (
            <View style={styles.collapseBody}>
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              <NutritionFacts snapshot={snapshot} />
            </View>
          )}
        </LedgerCard>

        <LedgerCard style={{ marginTop: 12 }}>
          <Pressable testID="food-detail-source-toggle" onPress={() => setShowSource(value => !value)} style={styles.collapseHeader}>
            <Text style={[styles.label, { color: colors.labelText }]}>SOURCE</Text>
            <Feather name={showSource ? 'chevron-up' : 'chevron-down'} size={16} color={colors.subtleText} />
          </Pressable>
          {showSource && (
            <View style={styles.collapseBody}>
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              {snapshot ? (
                <Text style={[styles.sourceText, { color: colors.bodyText }]}>
                  {snapshot.source.canonicalName ? `${snapshot.source.canonicalName}\n` : ''}
                  {snapshot.source.provider}{snapshot.source.release ? ` · ${snapshot.source.release}` : ''}{'\n'}
                  Record {snapshot.source.recordId} · revision {snapshot.source.revision}{'\n'}
                  Baseline: {snapshot.basis.label}{'\n'}
                  {activePortion?.evidence ? `Portion evidence: ${activePortion.evidence}\n` : ''}
                  {snapshot.provenance === 'generic_dish_estimate' ? 'Generic dish estimate'
                    : snapshot.provenance === 'identified_product' ? 'Identified product nutrition'
                      : snapshot.provenance === 'personal_label' ? 'Personal or label-provided nutrition'
                        : 'Generic source record'}
                </Text>
              ) : (
                <Text style={[styles.sourceText, { color: colors.bodyText }]}>
                  {item.sub}. This legacy food does not include extended source or portion evidence.
                </Text>
              )}
            </View>
          )}
        </LedgerCard>

        <View style={styles.favoriteArea}>
          <Pressable
            testID="food-detail-favorite"
            accessibilityLabel={isFavorite ? `Remove ${item.name} from favorites` : `Favorite ${item.name} at ${amount}`}
            disabled={favoriteBusy}
            onPress={toggleFavorite}
            style={[styles.favoriteButton, { borderColor: colors.border }]}
          >
            {favoriteBusy
              ? <ActivityIndicator size="small" color={colors.cobalt} />
              : <Feather name="star" size={16} color={isFavorite ? colors.cobalt : colors.bodyText} />}
            <Text style={[styles.favoriteText, { color: colors.bodyText }]}>
              {isFavorite ? 'Remove favorite' : 'Save as favorite'}
            </Text>
          </Pressable>
          {favoriteError && <Text style={[styles.note, { color: colors.bodyText }]}>{favoriteError}</Text>}
        </View>
        {libraryOrigin && (
          <LedgerCard style={{ padding: 16, marginTop: 12 }}>
            <Text style={[styles.label, { color: colors.labelText }]}>ADD TO MEAL</Text>
            <PillSelector
              options={MEAL_SLOTS.map(meal => ({ label: MEAL_LABELS[meal], value: meal }))}
              selected={libraryMeal}
              onSelect={setLibraryMeal}
              style={{ marginTop: 10 }}
            />
            {libraryNotice && (
              <Text testID="food-detail-library-confirmation" style={[styles.note, { color: colors.bodyText, marginTop: 10 }]}>
                {libraryNotice}
              </Text>
            )}
          </LedgerCard>
        )}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: bottomPad, backgroundColor: colors.card, borderTopColor: colors.border }]}>
        <Pressable
          testID="food-detail-select"
          accessibilityLabel={`${libraryOrigin ? `Add to ${MEAL_LABELS[libraryMeal]}` : selected ? 'Update selection' : 'Select food'}: ${item.name}, ${amount}`}
          onPress={libraryOrigin ? addFromLibrary : save}
          disabled={librarySaving}
          style={[styles.primary, { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm }]}
        >
          <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>
            {libraryOrigin
              ? librarySaving ? 'Adding…' : `Add to ${MEAL_LABELS[libraryMeal]}`
              : selected ? 'Update selection' : 'Select food'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1 },
  iconButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerLabel: { fontSize: 10, letterSpacing: 1.3, fontFamily: 'Inter_700Bold' },
  foodName: { fontSize: 27, lineHeight: 32, fontFamily: 'PlayfairDisplay_600SemiBold' },
  summary: { marginTop: 7, fontSize: 13, lineHeight: 18, fontFamily: 'Inter_400Regular' },
  label: { fontSize: 9, letterSpacing: 1, fontFamily: 'Inter_700Bold' },
  amountRow: { marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 22 },
  step: { width: 42, height: 42, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  amount: { minWidth: 110, textAlign: 'center', fontSize: 22, fontFamily: 'Inter_600SemiBold' },
  nutrition: { flexDirection: 'row', marginTop: 16 },
  nutritionCell: { flex: 1, alignItems: 'center', gap: 4 },
  nutritionValue: { fontSize: 17, fontFamily: 'Inter_600SemiBold' },
  optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  option: { paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderRadius: 4 },
  optionText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  more: { paddingHorizontal: 8, paddingVertical: 8, justifyContent: 'center' },
  moreText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  collapseHeader: { padding: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  collapseBody: { paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  divider: { height: 1, marginBottom: 2 },
  dimension: { gap: 2 },
  dimensionLabel: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  messageBlock: { gap: 8 },
  confirm: { borderWidth: 1, padding: 12, gap: 10 },
  confirmActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 20 },
  note: { fontSize: 12, lineHeight: 17, fontFamily: 'Inter_400Regular' },
  sourceText: { fontSize: 12, lineHeight: 18, fontFamily: 'Inter_400Regular' },
  favoriteArea: { marginTop: 12, gap: 8 },
  favoriteButton: { minHeight: 44, borderWidth: 1, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  favoriteText: { fontSize: 12.5, fontFamily: 'Inter_600SemiBold' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12, borderTopWidth: 1 },
  primary: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  primaryText: { fontSize: 12.5, fontFamily: 'Inter_700Bold', textAlign: 'center' },
});