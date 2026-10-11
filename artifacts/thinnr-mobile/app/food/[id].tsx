import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo, ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, useLocalSearchParams, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NutritionFacts } from '@/components/patient/NutritionFacts';
import { LedgerCard, PillSelector } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import {
  buildFoodLogEntry, getItemNutritionSnapshot, initializeFreshItemSnapshot, selectionScale,
  supportsOunces, useFoodLogging, withItemNutritionSnapshot,
} from '@/context/FoodLoggingContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { usePatient } from '@/context/PatientContext';
import type { FoodItem } from '@/data/patient-data';
import { MEAL_LABELS, MEAL_SLOTS, type MealSlot } from '@/data/patient-data';
import {
  equivalentHouseholdPortion, formatNutritionAmount,
  nutritionPortionDimension, nutritionPortionPresentation, orderedNutritionPortions, scaledSnapshotMacros,
  selectSnapshotDisplayedPortion, selectSnapshotPortion, snapshotConfigurationId,
  snapshotDisplayedAmount, snapshotPortion,
} from '@/data/food-nutrition';
import type { FoodNutritionSnapshot } from '@/data/food-nutrition';
import { createLegacyFoodDetailSnapshot } from '@/data/food-detail-amount';
import { useColors } from '@/hooks/useColors';
import { useFoodFit } from '@/hooks/useFoodFit';
import { FitBadge } from '@/components/patient/FitBadge';
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

function positiveAmountInput(value: string): number | null {
  const text = value.trim();
  const number = Number(text);
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) && Number.isFinite(number) && number > 0
    ? number : null;
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
  const foodFit = useFoodFit();
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
  const recalledItem = basket.recalled(id ?? '');
  const initialItem = selected?.item ?? recalledItem ?? byId.get(id ?? '')
    ?? allItems.find(candidate => candidate.refId === id);
  const currentAccountKey = accountKey(patientAccount.account);
  const initialKeyRef = useRef(`${currentAccountKey}:${id ?? ''}:${routeBasketId ?? ''}`);
  const guardRef = useRef({ accountKey: currentAccountKey, pathname });
  guardRef.current = { accountKey: currentAccountKey, pathname };
  const [draft, setDraft] = useState<Draft | null>(() => {
    if (!initialItem) return null;
    const storedSnapshot = getItemNutritionSnapshot(initialItem);
    const snapshot = storedSnapshot && !selected && !recalledItem && !initialItem.catalog?.persisted
      ? initializeFreshItemSnapshot(initialItem, storedSnapshot)
      : storedSnapshot ?? createLegacyFoodDetailSnapshot(initialItem, selected);
    return {
      key: initialKeyRef.current,
      item: initialItem,
      snapshot,
      quantity: snapshot?.selected.scale ?? selected?.quantity ?? 1,
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
  const [showUnits, setShowUnits] = useState(false);
  const [showNutrition, setShowNutrition] = useState(false);
  const [proposedVariant, setProposedVariant] = useState<CatalogFood | null>(null);
  const [portionNotice, setPortionNotice] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState<string | null>(null);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [libraryMeal, setLibraryMeal] = useState<MealSlot>(initialMeal);
  const [librarySaving, setLibrarySaving] = useState(false);
  const librarySavingRef = useRef(false);
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);

  useEffect(() => {
    if (draft || !initialItem) return;
    if (`${currentAccountKey}:${id ?? ''}:${routeBasketId ?? ''}` !== initialKeyRef.current) return;
    const storedSnapshot = getItemNutritionSnapshot(initialItem);
    const initialSnapshot = storedSnapshot && !selected && !recalledItem && !initialItem.catalog?.persisted
      ? initializeFreshItemSnapshot(initialItem, storedSnapshot)
      : storedSnapshot ?? createLegacyFoodDetailSnapshot(initialItem, selected);
    setDraft({
      key: initialKeyRef.current,
      item: initialItem,
      snapshot: initialSnapshot,
      quantity: initialSnapshot?.selected.scale ?? selected?.quantity ?? 1,
      ...(selected?.ounces !== undefined
        ? { ounces: selected.ounces }
        : !initialSnapshot && supportsOunces(initialItem) ? { ounces: 5 } : {}),
    });
  }, [draft, initialItem, currentAccountKey, id, routeBasketId, selected, recalledItem]);

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
  const pendingAmount = amountInput === null ? null : positiveAmountInput(amountInput);
  const previewSnapshot = snapshot && pendingAmount !== null && Number.isFinite(pendingAmount) && pendingAmount > 0
    ? selectSnapshotDisplayedPortion(snapshot, pendingAmount, snapshot.selected.unitId) ?? snapshot
    : snapshot;
  const activePortion = snapshot ? snapshotPortion(snapshot) : undefined;
  const formattedAmount = previewSnapshot ? formatNutritionAmount(previewSnapshot) : null;
  const amount = previewSnapshot
    ? formattedAmount!.text
    : draft.ounces !== undefined
      ? `${display(draft.ounces)} oz`
      : `${display(draft.quantity)} × ${item.serving}`;
  const legacyScale = selectionScale({
    basketId: routeBasketId ?? '',
    item,
    quantity: draft.quantity,
    ...(draft.ounces !== undefined ? { ounces: draft.ounces } : {}),
  });
  const previewLegacyScale = !snapshot && pendingAmount !== null && Number.isFinite(pendingAmount) && pendingAmount > 0
    ? selectionScale({
        basketId: routeBasketId ?? '',
        item,
        quantity: draft.ounces === undefined ? pendingAmount : draft.quantity,
        ...(draft.ounces !== undefined ? { ounces: pendingAmount } : {}),
      })
    : legacyScale;
  const macros = previewSnapshot ? scaledSnapshotMacros(previewSnapshot) : null;
  const macroValues = {
    calories: macros?.calories ?? item.calories * (previewSnapshot ? 1 : previewLegacyScale),
    protein: macros?.protein ?? item.protein * (previewSnapshot ? 1 : previewLegacyScale),
    carbs: macros?.carbs ?? item.carbs * (previewSnapshot ? 1 : previewLegacyScale),
    fat: macros?.fat ?? item.fat * (previewSnapshot ? 1 : previewLegacyScale),
  };
  const weightBased = snapshot ? !!activePortion && nutritionPortionDimension(activePortion) === 'weight' : supportsOunces(item);
  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 67 : 12);
  const bottomPad = Platform.OS === 'web' ? 34 : Math.max(insets.bottom, 16);
  const configurationId = previewSnapshot ? snapshotConfigurationId(previewSnapshot) : item.refId;
  // Old favorites stored just the food id, meaning one original serving.
  // Recognize that exact baseline without making every new amount a favorite.
  const legacyBaseline = initialItem && !getItemNutritionSnapshot(initialItem)
    ? createLegacyFoodDetailSnapshot(initialItem) : null;
  const legacyFavoriteId = legacyBaseline && initialItem &&
    snapshotConfigurationId(legacyBaseline) === configurationId &&
    patient.favorites.includes(initialItem.refId) ? initialItem.refId : null;
  const isFavorite = patient.favorites.includes(configurationId) || legacyFavoriteId !== null;
  const openFoodFacts = item.catalog?.source === 'openfoodfacts' ||
    /openfoodfacts/i.test(snapshot?.source.provider.replace(/[\s_-]/g, '') ?? '');
  const selectablePortions = snapshot
    ? orderedNutritionPortions(snapshot, {
        // An existing custom food may document only its original serving.
        // Keep that measure available even without alternate conversion evidence.
        preserveSelected: true,
      })
    : [];

  const updateVariant = (food: CatalogFood) => {
    const resolved = resolvePendingAmount();
    if (!resolved) return;
    const workingSnapshot = resolved.snapshot;
    const workingPortion = workingSnapshot ? snapshotPortion(workingSnapshot) : undefined;
    const nextItem = catalogFoodToLoggable(food);
    let nextSnapshot = getItemNutritionSnapshot(nextItem);
    let notice: string | null = null;
    if (workingSnapshot && nextSnapshot && workingPortion) {
      const nextPortions = orderedNutritionPortions(nextSnapshot, { preserveSelected: false });
      const currentPresentation = nutritionPortionPresentation(workingPortion);
      const physicalGrams = workingPortion.grams
        ? workingSnapshot.selected.amount * workingPortion.grams
        : null;
      const sameWeightUnit = nutritionPortionDimension(workingPortion) === 'weight'
        ? nextPortions.find(portion =>
            nutritionPortionDimension(portion) === 'weight' &&
            nutritionPortionPresentation(portion).singular === currentPresentation.singular)
        : undefined;
      const sameHousehold = equivalentHouseholdPortion(workingPortion, nextPortions);
      if (sameHousehold) {
        nextSnapshot = selectSnapshotDisplayedPortion(
          nextSnapshot,
          snapshotDisplayedAmount(workingSnapshot, workingPortion),
          sameHousehold.id,
        ) ?? nextSnapshot;
      } else if (sameWeightUnit) {
        nextSnapshot = selectSnapshotPortion(
          nextSnapshot,
          physicalGrams && sameWeightUnit.grams
            ? physicalGrams / sameWeightUnit.grams
            : workingSnapshot.selected.scale / sameWeightUnit.basisMultiplier,
          sameWeightUnit.id,
        ) ?? nextSnapshot;
      } else {
        const ounce = nextPortions.find(portion =>
          nutritionPortionDimension(portion) === 'weight' && nutritionPortionPresentation(portion).singular === 'oz');
        if (ounce) {
          nextSnapshot = selectSnapshotPortion(
            nextSnapshot,
            physicalGrams && ounce.grams
              ? physicalGrams / ounce.grams
              : workingSnapshot.selected.scale / ounce.basisMultiplier,
            ounce.id,
          ) ?? nextSnapshot;
          notice = `${currentPresentation.shortLabel} are not documented for this type. The same weight is shown in ounces.`;
        } else {
          notice = `${currentPresentation.shortLabel} are not documented for this type. Its documented portion is shown instead.`;
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
    setPortionNotice(notice);
    setProposedVariant(null);
  };

  const adjust = (direction: -1 | 1) => {
    const resolved = amountInput !== null ? resolvePendingAmount() : draft;
    if (!resolved) return;
    const workingSnapshot = resolved.snapshot;
    if (workingSnapshot) {
      const workingPortion = snapshotPortion(workingSnapshot);
      const activeDimension = workingPortion ? nutritionPortionDimension(workingPortion) : 'serving';
      const step = activeDimension === 'volume' ? 0.25
        : activeDimension === 'count' ? 1
          : activeDimension === 'weight' ? 0.5 : 1;
      const displayed = workingPortion
        ? snapshotDisplayedAmount(workingSnapshot, workingPortion)
        : workingSnapshot.selected.amount;
      const nextAmount = displayed + direction * step;
      if (nextAmount <= 0) return;
      const nextSnapshot = selectSnapshotDisplayedPortion(
        workingSnapshot,
        nextAmount,
        workingSnapshot.selected.unitId,
      );
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

  const commitAmountInput = () => {
    if (amountInput !== null) resolvePendingAmount();
  };

  const resolvePendingAmount = (): Draft | null => {
    if (amountInput === null) return draft;
    const nextAmount = positiveAmountInput(amountInput);
    if (nextAmount === null) {
      const message = 'Enter an amount greater than zero.';
      setPortionNotice(message);
      AccessibilityInfo.announceForAccessibility(message);
      return null;
    }
    if (!snapshot) {
      const resolved = draft.ounces !== undefined
        ? { ...draft, ounces: nextAmount }
        : { ...draft, quantity: nextAmount };
      setDraft(resolved);
      setAmountInput(null);
      setPortionNotice(null);
      return resolved;
    }
    const nextSnapshot = selectSnapshotDisplayedPortion(snapshot, nextAmount, snapshot.selected.unitId);
    if (!nextSnapshot) {
      const message = 'That amount is not supported.';
      setPortionNotice(message);
      AccessibilityInfo.announceForAccessibility(message);
      return null;
    }
    const resolved = {
      ...draft,
      snapshot: nextSnapshot,
      item: withItemNutritionSnapshot(draft.item, nextSnapshot),
      quantity: nextSnapshot.selected.scale,
      ounces: undefined,
    };
    setDraft(resolved);
    setAmountInput(null);
    setPortionNotice(null);
    return resolved;
  };

  const changeUnit = (unitId: string) => {
    const resolved = resolvePendingAmount();
    if (!resolved?.snapshot) return;
    // Explicit unit changes preserve the typed number, NOT physical weight.
    // Type/preparation changes above retain their separate conversion policy.
    const next = selectSnapshotDisplayedPortion(
      resolved.snapshot, snapshotDisplayedAmount(resolved.snapshot), unitId,
    );
    if (!next) return;
    setDraft({
      ...resolved,
      snapshot: next,
      item: withItemNutritionSnapshot(resolved.item, next),
      quantity: next.selected.scale,
      ounces: undefined,
    });
    setShowUnits(false);
    AccessibilityInfo.announceForAccessibility(`Amount changed to ${formatNutritionAmount(next).text}`);
  };

  const save = () => {
    const resolved = resolvePendingAmount();
    if (!resolved) return;
    const finalItem = resolved.snapshot
      ? withItemNutritionSnapshot(resolved.item, resolved.snapshot)
      : resolved.item;
    basket.configure(
      finalItem,
      resolved.snapshot
        ? { quantity: resolved.snapshot.selected.scale }
        : { quantity: resolved.quantity, ...(resolved.ounces !== undefined ? { ounces: resolved.ounces } : {}) },
      routeBasketId,
    );
    router.back();
  };

  const addFromLibrary = async () => {
    if (librarySavingRef.current) return;
    const resolved = resolvePendingAmount();
    if (!resolved) return;
    const actionItem = resolved.item;
    const actionSnapshot = resolved.snapshot;
    librarySavingRef.current = true;
    setLibrarySaving(true);
    setLibraryNotice(null);
    const requestAccount = currentAccountKey;
    const requestPath = pathname;
    const requestIsCurrent = () =>
      guardRef.current.accountKey === requestAccount && guardRef.current.pathname === requestPath;
    try {
      if (patientAccount.account.kind !== 'real') {
        throw new Error('Your patient account is unavailable. Please sign in again.');
      }
      const finalItem = actionSnapshot ? withItemNutritionSnapshot(actionItem, actionSnapshot) : actionItem;
      let logItem = finalItem;
      const catalog = catalogFromItem(finalItem);
      const promoted = catalog && catalog.group !== 'personal' && !catalog.catalogId.startsWith('cfg_')
        ? await selectCatalogFood(catalog)
        : null;
      if (!requestIsCurrent()) return;
      if (actionSnapshot) {
        const saveFood = promoted
          ? {
              ...catalogFoodSnapshot(promoted),
              ...foodItemForSave(finalItem, actionSnapshot),
              nutritionSnapshot: actionSnapshot,
            }
          : foodItemForSave(finalItem, actionSnapshot);
        const configured = await patient.saveFoodConfiguration(saveFood);
        if (!requestIsCurrent()) return;
        if (!configured) throw new Error('Could not save this food configuration.');
        logItem = { ...finalItem, refId: configured.id };
      } else if (catalog && catalog.group !== 'personal') {
        // Snapshotless reviewed singletons still need a private lookup copy so
        // recents/favorites can resolve them offline. Real accounts first use
        // the protected promotion endpoint; a signed-out session retains the
        // local source identity and never attempts that endpoint.
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
        quantity: actionSnapshot?.selected.scale ?? resolved.quantity,
        ...(!actionSnapshot && resolved.ounces !== undefined ? { ounces: resolved.ounces } : {}),
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
    const resolved = resolvePendingAmount();
    if (!resolved) return;
    const actionItem = resolved.item;
    const actionSnapshot = resolved.snapshot;
    setFavoriteBusy(true);
    setFavoriteError(null);
    const requestAccount = currentAccountKey;
    const requestPath = pathname;
    try {
      if (!actionSnapshot) {
        await patient.toggleFavorite(actionItem.refId);
        return;
      }
      const actionConfigurationId = snapshotConfigurationId(actionSnapshot);
      if (legacyFavoriteId && legacyBaseline && snapshotConfigurationId(legacyBaseline) === actionConfigurationId) {
        await patient.toggleFavorite(legacyFavoriteId);
        if (guardRef.current.accountKey !== requestAccount || guardRef.current.pathname !== requestPath) return;
        if (!patient.favorites.includes(actionConfigurationId)) return;
      }
      const saved = await patient.saveFoodConfiguration(
        foodItemForSave(actionItem, actionSnapshot),
        { favorite: !patient.favorites.includes(actionConfigurationId) },
      );
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
  const selectableDimensionKeys = dimensionKeys.filter(key =>
    new Set(variants.map(variant => variant.dimensions?.[key]).filter(Boolean)).size > 1);
  const openAttribution = (url: string) => {
    void Linking.openURL(url).catch(() => setPortionNotice('Could not open the attribution link. Please try again.'));
  };

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
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: bottomPad + 90 }}>
        <Text testID="food-detail-name" style={[styles.foodName, { color: colors.navy }]}>{item.name}</Text>
        {(() => {
          const fit = foodFit.classify(item);
          if (fit.verdict === 'unknown') return null;
          const why = fit.reasons.filter(reason => reason.kind === 'hit').map(reason => reason.message).slice(0, 2).join(' ');
          return (
            <View testID="food-detail-fit" style={{ marginTop: 8, gap: 4 }}>
              <FitBadge verdict={fit.verdict} size="md" />
              {why ? <Text style={[styles.summary, { color: colors.subtleText }]}>{why}</Text> : null}
            </View>
          );
        })()}
        {!!(snapshot?.variant?.summary ?? item.catalog?.variantSummary) && (
          <Text style={[styles.summary, { color: colors.bodyText }]}>
            {snapshot?.variant?.summary ?? item.catalog?.variantSummary}
          </Text>
        )}

        <LedgerCard style={{ padding: 16, marginTop: 16 }}>
          <Text style={[styles.label, { color: colors.labelText }]}>{weightBased ? 'AMOUNT' : 'SERVING QUANTITY'}</Text>
          <View style={styles.amountRow}>
            <Pressable testID="food-detail-minus" accessibilityLabel="Decrease amount" onPress={() => adjust(-1)} style={[styles.step, { borderColor: colors.border }]}>
              <Feather name="minus" size={16} color={colors.bodyText} />
            </Pressable>
            <View style={styles.amountEditor}>
              <TextInput
                testID="food-detail-amount-input"
                accessibilityLabel={`Current amount ${amount}. Enter a positive amount.`}
                keyboardType="decimal-pad"
                inputMode="decimal"
                selectTextOnFocus
                value={amountInput ?? (formattedAmount
                  ? display(formattedAmount.amount, 4)
                  : display(draft.ounces ?? draft.quantity, 4))}
                onChangeText={value => {
                  setAmountInput(value);
                  if (positiveAmountInput(value) !== null) setPortionNotice(null);
                }}
                onBlur={commitAmountInput}
                onSubmitEditing={commitAmountInput}
                style={[styles.amountInput, { color: colors.navy, borderColor: colors.border }]}
              />
              <Pressable
                testID="food-detail-unit-picker"
                accessibilityRole="button"
                accessibilityLabel={`Change unit, ${formattedAmount?.unit ?? item.serving}`}
                aria-expanded={showUnits}
                onPress={() => setShowUnits(value => !value)}
                style={[styles.unitPicker, { borderColor: colors.border, borderRadius: colors.radiusSm }]}
              >
                <Text testID="food-detail-amount" style={[styles.amountUnit, { color: colors.navy }]}>
                  {formattedAmount?.unit ?? (draft.ounces !== undefined ? 'oz' : item.serving)}
                </Text>
                <Feather name={showUnits ? 'chevron-up' : 'chevron-down'} size={14} color={colors.bodyText} />
              </Pressable>
            </View>
            <Pressable testID="food-detail-plus" accessibilityLabel="Increase amount" onPress={() => adjust(1)} style={[styles.step, { borderColor: colors.border }]}>
              <Feather name="plus" size={16} color={colors.bodyText} />
            </Pressable>
          </View>
          {snapshot && showUnits && (
            <View testID="food-detail-units" style={[styles.unitOptions, { borderColor: colors.border, borderRadius: colors.radiusSm }]}>
              {selectablePortions.map(portion => {
                const presentation = nutritionPortionPresentation(portion);
                const label = (formattedAmount?.amount ?? 1) <= 1 ? presentation.singular : presentation.plural;
                const chosen = snapshot.selected.unitId === portion.id;
                return (
                  <Pressable
                    testID={`food-detail-unit-${portion.id}`}
                    key={portion.id}
                    accessibilityRole="radio"
                    aria-checked={chosen}
                    accessibilityLabel={`${label}${presentation.qualifier ? `, ${presentation.qualifier}` : ''}`}
                    onPress={() => changeUnit(portion.id)}
                    style={[styles.unitOption, chosen && { backgroundColor: colors.accent }]}
                  >
                    <Text style={[styles.optionText, { color: chosen ? colors.cobalt : colors.bodyText }]}>
                      {label}{presentation.qualifier ? ` · ${presentation.qualifier}` : ''}
                    </Text>
                    {chosen && <Feather name="check" size={16} color={colors.cobalt} />}
                  </Pressable>
                );
              })}
            </View>
          )}
          {formattedAmount?.qualifier && (
            <Text testID="food-detail-portion-qualifier" style={[styles.qualifier, { color: colors.subtleText }]}>
              {formattedAmount.qualifier}
            </Text>
          )}
          {portionNotice && (
            <Text testID="food-detail-amount-error" accessibilityRole="alert" aria-live="polite" style={[styles.note, { color: colors.bodyText, marginTop: 8 }]}>
              {portionNotice}
            </Text>
          )}
        </LedgerCard>

        <LedgerCard style={{ padding: 16, marginTop: 12 }}>
          <Text testID="food-detail-nutrition-heading" style={[styles.label, { color: colors.labelText }]}>Nutrition · {amount}</Text>
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
                           const currentDimensions = item.catalog?.dimensions ?? snapshot?.variant?.dimensions ?? {};
                           const desired = Object.fromEntries(
                             selectableDimensionKeys.map(key => [
                               key,
                               key === dimKey ? value : currentDimensions[key],
                             ]).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
                           );
                          const direct = variants.find(variant =>
                            Object.entries(desired).every(([key, selectedValue]) => variant.dimensions?.[key] === selectedValue));
                          const alternate = variants.find(variant => variant.dimensions?.[dimKey] === value);
                          const selectedValue = currentValue === value;
                          return (
                            <Pressable
                              testID={`food-detail-dimension-${dimKey}-${value}`}
                              key={value}
                              accessibilityHint={!direct ? 'Requires changing other type choices and confirmation' : undefined}
                              onPress={() => {
                                if (direct) updateVariant(direct);
                                else if (alternate && resolvePendingAmount()) setProposedVariant(alternate);
                              }}
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
                      <Pressable testID="food-detail-cancel-variant" onPress={() => setProposedVariant(null)}>
                        <Text style={[styles.moreText, { color: colors.bodyText }]}>Cancel</Text>
                      </Pressable>
                      <Pressable testID="food-detail-confirm-variant" onPress={() => updateVariant(proposedVariant)}>
                        <Text style={[styles.moreText, { color: colors.cobalt }]}>Use this type</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
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
              <NutritionFacts snapshot={previewSnapshot} />
            </View>
          )}
        </LedgerCard>

        {openFoodFacts && (
          <View style={styles.attribution}>
            <Pressable
              testID="food-detail-off-attribution"
              accessibilityRole="link"
              accessibilityLabel="Nutrition data from Open Food Facts"
              onPress={() => openAttribution('https://world.openfoodfacts.org/')}
            >
              <Text style={[styles.note, { color: colors.cobalt }]}>Open Food Facts</Text>
            </Pressable>
            <Text style={[styles.note, { color: colors.subtleText }]}> · </Text>
            <Pressable
              testID="food-detail-off-license"
              accessibilityRole="link"
              accessibilityLabel="Open Database License, ODbL 1.0"
              onPress={() => openAttribution('https://opendatacommons.org/licenses/odbl/1-0/')}
            >
              <Text style={[styles.note, { color: colors.cobalt }]}>ODbL 1.0</Text>
            </Pressable>
          </View>
        )}

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
  amountRow: { marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  step: { width: 42, height: 42, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  amountEditor: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  amountInput: { width: 76, height: 42, borderWidth: 1, paddingHorizontal: 8, textAlign: 'center', fontSize: 20, fontFamily: 'Inter_600SemiBold' },
  amountUnit: { flexShrink: 1, fontSize: 17, fontFamily: 'Inter_600SemiBold' },
  unitPicker: { minHeight: 44, maxWidth: 130, flexShrink: 1, paddingHorizontal: 8, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 5 },
  unitOptions: { marginTop: 12, borderWidth: 1, overflow: 'hidden' },
  unitOption: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  qualifier: { marginTop: 8, textAlign: 'center', fontSize: 11, lineHeight: 15, fontFamily: 'Inter_400Regular' },
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
  favoriteArea: { marginTop: 12, gap: 8 },
  attribution: { marginTop: 12, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' },
  favoriteButton: { minHeight: 44, borderWidth: 1, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  favoriteText: { fontSize: 12.5, fontFamily: 'Inter_600SemiBold' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12, borderTopWidth: 1 },
  primary: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  primaryText: { fontSize: 12.5, fontFamily: 'Inter_700Bold', textAlign: 'center' },
});