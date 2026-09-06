import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { LoggableItem } from '@/hooks/useLoggableItems';
import type { MealLogEntry, MealSlot } from '@/data/patient-data';

export const GRAMS_PER_OUNCE = 28.349523125;

export interface SelectedFood {
  item: LoggableItem;
  quantity: number;
  ounces?: number;
}

interface FoodLoggingContextValue {
  selected: SelectedFood[];
  recalled: (refId: string) => LoggableItem | undefined;
  remember: (item: LoggableItem) => void;
  toggle: (item: LoggableItem) => void;
  configure: (item: LoggableItem, amount: { quantity: number; ounces?: number }) => void;
  remove: (refId: string) => void;
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

export function defaultSelection(item: LoggableItem): SelectedFood {
  return supportsOunces(item) ? { item, quantity: 1, ounces: 5 } : { item, quantity: 1 };
}

export function selectionScale(selection: SelectedFood): number {
  if (selection.ounces !== undefined && selection.item.catalog?.servingGrams) {
    return selection.ounces * GRAMS_PER_OUNCE / selection.item.catalog.servingGrams;
  }
  return selection.quantity;
}

export function buildFoodLogEntry(
  selection: SelectedFood,
  target: { dateKey: string; meal: MealSlot },
): Omit<MealLogEntry, 'id'> {
  const scale = selectionScale(selection);
  return {
    ...target,
    kind: selection.item.kind,
    refId: selection.item.refId,
    name: selection.item.name,
    detail: selection.ounces !== undefined
      ? `${Number(selection.ounces.toFixed(1))} oz · ${Math.round(selection.ounces * GRAMS_PER_OUNCE)} g`
      : `${Number(selection.quantity.toFixed(1))} × ${selection.item.serving}`,
    quantity: scale,
    calories: Math.round(selection.item.calories * scale),
    protein: Math.round(selection.item.protein * scale),
    carbs: Math.round(selection.item.carbs * scale),
    fat: Math.round(selection.item.fat * scale),
  };
}

export function FoodLoggingProvider({ children }: { children: React.ReactNode }) {
  const [selected, setSelected] = useState<SelectedFood[]>([]);
  const rememberedRef = useRef(new Map<string, LoggableItem>());
  const remember = useCallback((item: LoggableItem) => {
    rememberedRef.current.set(item.refId, item);
  }, []);
  const recalled = useCallback((refId: string) => rememberedRef.current.get(refId), []);

  const toggle = useCallback((item: LoggableItem) => {
    setSelected(current => current.some(entry => entry.item.refId === item.refId)
      ? current.filter(entry => entry.item.refId !== item.refId)
      : [...current, defaultSelection(item)]);
  }, []);

  const configure = useCallback((item: LoggableItem, amount: { quantity: number; ounces?: number }) => {
    setSelected(current => {
      const next = { item, quantity: amount.quantity, ...(amount.ounces !== undefined ? { ounces: amount.ounces } : {}) };
      const index = current.findIndex(entry => entry.item.refId === item.refId);
      return index < 0
        ? [...current, next]
        : current.map((entry, entryIndex) => entryIndex === index ? next : entry);
    });
  }, []);

  const remove = useCallback((refId: string) => {
    setSelected(current => current.filter(entry => entry.item.refId !== refId));
  }, []);
  const clear = useCallback(() => setSelected([]), []);
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