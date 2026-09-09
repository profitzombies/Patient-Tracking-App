import React from 'react';
import { parseNutritionSnapshot, scaledSnapshotMacros } from '../../data/food-nutrition';

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
export let detailAccountKind: 'demo' | 'real' = 'demo';
export function setDetailAccountKind(kind: 'demo' | 'real') {
  detailAccountKind = kind;
}
export function setSubmitOutcome(outcome: { outcome: string; message?: string }) {
  submitOutcome = outcome;
}
export const selected: any[] = [];
export let variants: any[] = [];
export let currentItem: any = null;

export function resetDetailState(item: any, selection?: any, familyVariants: any[] = []) {
  currentItem = item;
  selected.splice(0, selected.length, ...(selection ? [selection] : []));
  variants = familyVariants;
  configureCalls.length = 0;
  favoriteCalls.length = 0;
  routerCalls.length = 0;
  route.id = item.refId;
  route.basketId = selection?.basketId;
  route.approvedOnly = 'true';
  route.origin = undefined;
  route.date = undefined;
  route.meal = undefined;
  submittedEntries.length = 0;
  selectedCatalogFoods.length = 0;
  savedConfigurations.length = 0;
  submitOutcome = { outcome: 'saved' };
  detailAccountKind = 'demo';
}

export function useAppMode() {
  return { mode: 'patient', hydrated: true };
}

export function usePatientAccount() {
  return {
    resolving: false,
    account: detailAccountKind === 'real'
      ? { kind: 'real', patientId: 'patient-test' }
      : { kind: 'demo' },
    accountNotice: null,
    retryResolve() {},
  };
}

export function usePatient() {
  return {
    hydrated: true,
    favorites: [],
    allFoods: [],
    savedRecipes: [],
    todayKey: '2026-09-08',
    async saveFoodConfiguration(food: any, options: any) {
      favoriteCalls.push({ food, options });
      savedConfigurations.push(food);
      return food;
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

export function getItemNutritionSnapshot(item: any) {
  return parseNutritionSnapshot(item?.nutritionSnapshot ?? item?.catalog?.nutritionSnapshot);
}

export function withItemNutritionSnapshot(item: any, snapshot: any) {
  const macros = scaledSnapshotMacros(snapshot);
  return {
    ...item,
    ...(macros ?? {}),
    nutritionSnapshot: snapshot,
    ...(item.catalog ? { catalog: { ...item.catalog, nutritionSnapshot: snapshot } } : {}),
  };
}

export function selectionScale(value: any) {
  const snapshot = getItemNutritionSnapshot(value.item);
  if (snapshot) return snapshot.selected.scale;
  return value.ounces === undefined ? value.quantity : value.ounces * 28.349523125 / value.item.catalog.servingGrams;
}

export function supportsOunces(item: any) {
  return !!item.catalog?.servingGrams;
}

export function buildFoodLogEntry(selection: any, target: any) {
  const snapshot = getItemNutritionSnapshot(selection.item);
  const macros = snapshot ? scaledSnapshotMacros(snapshot) : null;
  return {
    ...target,
    kind: 'food',
    refId: selection.item.refId,
    name: selection.item.name,
    detail: snapshot ? `${snapshot.selected.amount} ${snapshot.selected.unitId}` : selection.item.serving,
    quantity: snapshot?.selected.scale ?? selection.quantity,
    calories: macros?.calories ?? selection.item.calories * selection.quantity,
    protein: macros?.protein ?? selection.item.protein * selection.quantity,
    carbs: macros?.carbs ?? selection.item.carbs * selection.quantity,
    fat: macros?.fat ?? selection.item.fat * selection.quantity,
    ...(snapshot ? { nutritionSnapshot: snapshot } : {}),
  };
}

export function useFoodLogging() {
  return {
    selected,
    recalled() { return undefined; },
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