import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { LoggableItem } from '@/hooks/useLoggableItems';
import type { MealLogEntry, MealSlot } from '@/data/patient-data';

import { parseNutritionSnapshot, scaledSnapshotMacros, snapshotPortion } from '@/data/food-nutrition';
import type { FoodNutritionSnapshot } from '@/data/food-nutrition';
import { snapshotConfigurationKey } from '@/data/food-nutrition';
import { usePatientAccount } from './PatientAccountContext';

export const GRAMS_PER_OUNCE = 28.349523125;

export interface SelectedFood {
  basketId: string;
  item: LoggableItem;
  quantity: number;
  ounces?: number;
}

export interface FoodLoggingContextValue {
  selected: SelectedFood[];
  recalled: (refId: string) => LoggableItem | undefined;
  remember: (item: LoggableItem) => void;
  toggle: (item: LoggableItem) => void;
  configure: (item: LoggableItem, amount: { quantity: number; ounces?: number }, basketId?: string) => void;
  remove: (basketId: string) => void;
  clear: () => void;
}

const FoodLoggingContext = createContext<FoodLoggingContextValue | null>(null);

export function supportsOunces(item: LoggableItem): boolean {
  return item.kind === 'food'
    && item.catalog?.group === 'common'
    && typeof item.catalog.servingGrams === 'number'
    && item.catalog.servingGrams > 0
    && item.catalog.measures.some(measure => /\boz\b/i.test(measure.label) && measure.grams > 0);
}

export function getItemNutritionSnapshot(item: LoggableItem): FoodNutritionSnapshot | null {
  return parseNutritionSnapshot(item.nutritionSnapshot ?? item.catalog?.nutritionSnapshot);
}

export function withItemNutritionSnapshot(
  item: LoggableItem,
  snapshot: FoodNutritionSnapshot,
): LoggableItem {
  const totals = scaledSnapshotMacros(snapshot);
  return {
    ...item,
    ...(totals ?? {}),
    nutritionSnapshot: snapshot,
    ...(item.catalog ? { catalog: { ...item.catalog, nutritionSnapshot: snapshot } } : {}),
  };
}

function configurationKey(item: LoggableItem): string {
  const snapshot = getItemNutritionSnapshot(item);
  if (snapshot) return snapshotConfigurationKey(snapshot);
  return JSON.stringify([item.kind, item.refId]);
}

export function sameItemConfiguration(left: LoggableItem, right: LoggableItem): boolean {
  return configurationKey(left) === configurationKey(right);
}

export function selectionMatchesItemConfiguration(selection: SelectedFood, item: LoggableItem): boolean {
  if (!sameItemConfiguration(selection.item, item)) return false;
  const visible = defaultSelection(item);
  return selection.quantity === visible.quantity && selection.ounces === visible.ounces;
}

export function defaultSelection(item: LoggableItem): SelectedFood {
  const basketId = Math.random().toString(36).substring(2, 10);
  const snapshot = getItemNutritionSnapshot(item);
  if (snapshot) return { basketId, item: withItemNutritionSnapshot(item, snapshot), quantity: snapshot.selected.scale };
  return supportsOunces(item) ? { basketId, item, quantity: 1, ounces: 5 } : { basketId, item, quantity: 1 };
}

export function selectionScale(selection: SelectedFood): number {
  const snapshot = getItemNutritionSnapshot(selection.item);
  if (snapshot) return snapshot.selected.scale;
  if (selection.ounces !== undefined && selection.item.catalog?.servingGrams) {
    return selection.ounces * GRAMS_PER_OUNCE / selection.item.catalog.servingGrams;
  }
  return selection.quantity;
}

function compactNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

export function selectionDisplay(selection: SelectedFood): {
  amount: string;
  variant: string | null;
  calories: number;
} {
  const snapshot = getItemNutritionSnapshot(selection.item);
  if (snapshot) {
    const portion = snapshotPortion(snapshot);
    const amountUnit = portion?.unit || portion?.label || snapshot.selected.unitId;
    return {
      amount: `${compactNumber(snapshot.selected.amount)} ${amountUnit}`,
      variant: snapshot.variant?.summary ?? selection.item.catalog?.variantSummary ?? null,
      calories: scaledSnapshotMacros(snapshot)?.calories ?? selection.item.calories,
    };
  }
  return {
    amount: selection.ounces !== undefined
      ? `${compactNumber(selection.ounces)} oz`
      : `${compactNumber(selection.quantity)} × ${selection.item.serving}`,
    variant: selection.item.catalog?.variantSummary ?? null,
    calories: selection.item.calories * selectionScale(selection),
  };
}

export function selectionDisplayText(selection: SelectedFood): string {
  const display = selectionDisplay(selection);
  return `${display.variant ? `${display.variant} · ` : ''}${display.amount} · ${Math.round(display.calories)} cal`;
}

export function foodResultDisplayText(item: LoggableItem): string {
  const display = selectionDisplay(defaultSelection(item));
  return [
    display.variant,
    display.amount,
    item.catalog?.sourceLabel,
  ].filter(Boolean).join(' · ');
}

export function buildFoodLogEntry(
  selection: SelectedFood,
  target: { dateKey: string; meal: MealSlot },
): Omit<MealLogEntry, 'id'> {
  const scale = selectionScale(selection);
  const snapshot = getItemNutritionSnapshot(selection.item);
  const snapshotMacros = snapshot ? scaledSnapshotMacros(snapshot) : null;

  return {
    ...target,
    kind: selection.item.kind,
    refId: selection.item.refId,
    name: selection.item.name,
    detail: selection.ounces !== undefined
      ? `${Number(selection.ounces.toFixed(1))} oz · ${Math.round(selection.ounces * GRAMS_PER_OUNCE)} g`
      : (snapshot ? `${Number(snapshot.selected.amount.toFixed(1))} ${snapshot.selected.unitId}` : `${Number(selection.quantity.toFixed(1))} × ${selection.item.serving}`),
    quantity: scale,
    calories: snapshotMacros?.calories ?? (snapshot ? selection.item.calories : selection.item.calories * scale),
    protein: snapshotMacros?.protein ?? (snapshot ? selection.item.protein : selection.item.protein * scale),
    carbs: snapshotMacros?.carbs ?? (snapshot ? selection.item.carbs : selection.item.carbs * scale),
    fat: snapshotMacros?.fat ?? (snapshot ? selection.item.fat : selection.item.fat * scale),
    ...(snapshot ? { nutritionSnapshot: snapshot } : {}),
  };
}

export function FoodLoggingProvider({ children }: { children: React.ReactNode }) {
  const { account } = usePatientAccount();
  const accountKey = account.kind === 'real' ? `real:${account.patientId}` : account.kind;
  const [basketState, setBasketState] = useState<{ accountKey: string; selected: SelectedFood[] }>({
    accountKey,
    selected: [],
  });
  if (basketState.accountKey !== accountKey) {
    // React-supported render-time state adjustment: unlike an effect, this
    // destroys A's private objects before B can commit a frame, and A cannot
    // recover them by switching back later.
    setBasketState({ accountKey, selected: [] });
  }
  const selected = basketState.accountKey === accountKey ? basketState.selected : [];
  const rememberedRef = useRef<{ accountKey: string; items: Map<string, LoggableItem> }>({
    accountKey,
    items: new Map(),
  });
  if (rememberedRef.current.accountKey !== accountKey) {
    rememberedRef.current = { accountKey, items: new Map() };
  }
  const remember = useCallback((item: LoggableItem) => {
    if (rememberedRef.current.accountKey === accountKey) rememberedRef.current.items.set(item.refId, item);
  }, [accountKey]);
  const recalled = useCallback((refId: string) =>
    rememberedRef.current.accountKey === accountKey ? rememberedRef.current.items.get(refId) : undefined,
  [accountKey]);

  const toggle = useCallback((item: LoggableItem) => {
    setBasketState(state => {
      const current = state.accountKey === accountKey ? state.selected : [];
      const existing = current.find(entry => selectionMatchesItemConfiguration(entry, item));
      if (existing) {
        return { accountKey, selected: current.filter(entry => entry.basketId !== existing.basketId) };
      }
      return { accountKey, selected: [...current, defaultSelection(item)] };
    });
  }, [accountKey]);

  const configure = useCallback((item: LoggableItem, amount: { quantity: number; ounces?: number }, basketId?: string) => {
    setBasketState(state => {
      const current = state.accountKey === accountKey ? state.selected : [];
      const snapshot = getItemNutritionSnapshot(item);
      const configuredItem = snapshot ? withItemNutritionSnapshot(item, snapshot) : item;
      const exactKey = configurationKey(configuredItem);
      const duplicate = current.find(entry =>
        entry.basketId !== basketId &&
        configurationKey(entry.item) === exactKey &&
        entry.quantity === amount.quantity &&
        entry.ounces === amount.ounces
      );
      if (duplicate) {
        return {
          accountKey,
          selected: basketId
            ? current.filter(entry => entry.basketId !== basketId)
            : current,
        };
      }
      const idToReplace = basketId;
      const next: SelectedFood = {
        basketId: idToReplace || Math.random().toString(36).substring(2, 10),
        item: configuredItem,
        quantity: snapshot ? snapshot.selected.scale : amount.quantity,
        ...(!snapshot && amount.ounces !== undefined ? { ounces: amount.ounces } : {})
      };
      if (idToReplace) {
        return { accountKey, selected: current.map(entry => entry.basketId === idToReplace ? next : entry) };
      }
      return { accountKey, selected: [...current, next] };
    });
  }, [accountKey]);

  const remove = useCallback((basketId: string) => {
    setBasketState(state => ({
      accountKey,
      selected: state.accountKey === accountKey
        ? state.selected.filter(entry => entry.basketId !== basketId)
        : [],
    }));
  }, [accountKey]);
  const clear = useCallback(() => setBasketState({ accountKey, selected: [] }), [accountKey]);
  const value = useMemo(
    () => ({ selected, recalled, remember, toggle, configure, remove, clear }),
    [selected, recalled, remember, toggle, configure, remove, clear],
  );

  return <FoodLoggingContext.Provider value={value}>{children}</FoodLoggingContext.Provider>;
}

export function useFoodLogging(): FoodLoggingContextValue {
  const value = useContext(FoodLoggingContext);
  if (!value) throw new Error('useFoodLogging must be used within FoodLoggingProvider');
  return value;
}