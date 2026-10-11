import React from 'react';
import {
  parseNutritionSnapshot, snapshotConfigurationId,
} from '../../data/food-nutrition';
import {
  buildFoodLogEntry as realBuildFoodLogEntry,
  getItemNutritionSnapshot as realGetItemNutritionSnapshot,
  initializeFreshItemSnapshot as realInitializeFreshItemSnapshot,
  selectionScale as realSelectionScale,
  supportsOunces as realSupportsOunces,
  withItemNutritionSnapshot as realWithItemNutritionSnapshot,
} from '../../context/FoodLoggingContext';

export type LoggableItem = any;
export type CatalogFood = any;
export const route = {
  id: 'food-test',
  basketId: undefined as string | undefined,
  approvedOnly: undefined as string | undefined,
  origin: undefined as string | undefined,
  date: undefined as string | undefined,
  meal: undefined as string | undefined,
};
export const routerCalls: string[] = [];
export const configureCalls: Array<{ item: any; amount: any; basketId?: string }> = [];
export const favoriteCalls: Array<{ food: any; options: any }> = [];
export const submittedEntries: any[] = [];
export const selectedCatalogFoods: any[] = [];
export const savedConfigurations: any[] = [];
export let submitOutcome: { outcome: string; message?: string } = { outcome: 'saved' };
export let detailAccountKind: 'signed-out' | 'real' = 'real';
export function setDetailAccountKind(kind: 'signed-out' | 'real') {
  detailAccountKind = kind;
}
export function setSubmitOutcome(outcome: { outcome: string; message?: string }) {
  submitOutcome = outcome;
}
export const selected: any[] = [];
export const detailFavoriteIds: string[] = [];
export function setDetailFavorites(ids: string[]) {
  detailFavoriteIds.splice(0, detailFavoriteIds.length, ...ids);
}
export let variants: any[] = [];
export let currentItem: any = null;
let recalledDetailItem: any = undefined;
export function setRecalledDetailItem(item: any) {
  recalledDetailItem = item;
}

function asLoggableItem(item: any): any {
  if (!item) return item;
  if (item.kind === 'food' && item.refId) return item;
  return {
    ...item,
    kind: item.kind ?? 'food',
    refId: item.refId ?? item.id,
    sub: item.sub ?? item.category,
    approved: item.approved ?? true,
  };
}

export function resetDetailState(item: any, selection?: any, familyVariants: any[] = []) {
  recalledDetailItem = undefined;
  currentItem = asLoggableItem(item);
  selected.splice(0, selected.length, ...(selection ? [{
    ...selection,
    item: asLoggableItem(selection.item),
  }] : []));
  variants = familyVariants;
  configureCalls.length = 0;
  favoriteCalls.length = 0;
  routerCalls.length = 0;
  route.id = currentItem.refId;
  route.basketId = selection?.basketId;
  route.approvedOnly = 'true';
  route.origin = undefined;
  route.date = undefined;
  route.meal = undefined;
  submittedEntries.length = 0;
  selectedCatalogFoods.length = 0;
  savedConfigurations.length = 0;
  detailFavoriteIds.length = 0;
  submitOutcome = { outcome: 'saved' };
  detailAccountKind = 'real';
}

export function useAppMode() {
  return { mode: 'patient', hydrated: true };
}

export function usePatientAccount() {
  return {
    resolving: false,
    account: detailAccountKind === 'real'
      ? { kind: 'real', patientId: 'patient-test' }
      : { kind: 'signed-out' },
    accountNotice: null,
    retryResolve() {},
  };
}

export function usePatient() {
  return {
    hydrated: true,
    favorites: detailFavoriteIds,
    allFoods: [],
    savedRecipes: [],
    todayKey: '2026-09-08',
    async saveFoodConfiguration(food: any, options: any) {
      favoriteCalls.push({ food, options });
      const snapshot = parseNutritionSnapshot(food?.nutritionSnapshot);
      // PatientContext persists snapshot configurations under their stable
      // configuration id, rather than trusting the caller's source id.
      const saved = snapshot
        ? { ...food, id: snapshotConfigurationId(snapshot) }
        : food;
      savedConfigurations.push(saved);
      return saved;
    },
    async saveCatalogFood(food: any) {
      savedConfigurations.push(food);
      return true;
    },
    async toggleFavorite(id: string) {
      favoriteCalls.push({ food: { id }, options: { legacy: true } });
    },
    async submitFoodEntries(entries: any[]) {
      submittedEntries.push(...entries);
      return submitOutcome;
    },
  };
}

export function useLoggableItems() {
  return { allItems: currentItem ? [currentItem] : [], byId: new Map(currentItem ? [[currentItem.refId, currentItem]] : []) };
}

export function catalogFoodToLoggable(food: any) {
  return food.loggable ?? food;
}

// Keep the screen seam small, but do not reimplement production nutrition
// semantics in this test module. These are the same pure functions used by
// FoodLoggingContext; only its account/provider hooks remain stubbed below.
export const getItemNutritionSnapshot = realGetItemNutritionSnapshot;
export const initializeFreshItemSnapshot = realInitializeFreshItemSnapshot;
export const withItemNutritionSnapshot = realWithItemNutritionSnapshot;
export const selectionScale = realSelectionScale;
export const supportsOunces = realSupportsOunces;
export const buildFoodLogEntry = realBuildFoodLogEntry;

export function useFoodLogging() {
  return {
    selected,
    recalled() { return recalledDetailItem; },
    configure(item: any, amount: any, basketId?: string) {
      configureCalls.push({ item, amount, ...(basketId ? { basketId } : {}) });
    },
  };
}

export async function getFamilyVariants() {
  return variants;
}
export async function selectCatalogFood(food: any) {
  selectedCatalogFoods.push(food);
  return { ...food, id: 'stable-singleton-id', catalogId: 'stable-singleton-id' };
}
export function catalogFoodSnapshot(food: any) {
  return {
    id: food.catalogId,
    name: food.name,
    serving: food.serving,
    calories: food.calories,
    protein: food.protein,
    carbs: food.carbs,
    fat: food.fat,
    category: 'Common Foods',
  };
}

export function catalogErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Could not load variants.';
}

export const router = {
  back() { routerCalls.push('back'); },
  replace(target: unknown) { routerCalls.push(`replace:${String(target)}`); },
  push(target: unknown) { routerCalls.push(`push:${String(target)}`); },
};
export function useLocalSearchParams<T>() { return route as T; }
export function usePathname() { return `/food/${route.id}`; }
export function Redirect() { return null; }

export function LedgerCard(props: { children?: React.ReactNode; style?: unknown }) {
  return React.createElement('LedgerCard', props, props.children);
}
export function PillSelector(props: { selected: string; onSelect: (value: any) => void }) {
  return React.createElement('PillSelector', props);
}