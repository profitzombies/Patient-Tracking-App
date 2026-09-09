/**
 * The Add Food search space — every loggable item (library foods including
 * custom ones, coach-saved recipes, curated THINNR recipes) flattened to one
 * shape, plus an id lookup. Shared by the Add Food screen and the
 * "Yesterday's [meal]" review so both search exactly the same catalog.
 */
import { useMemo } from 'react';
import { usePatient } from '@/context/PatientContext';
import { isApprovedFood } from '@/data/approved-foods';
import { RECIPES } from '@/data/patient-data';
import type { FoodNutritionSnapshot } from '@/data/food-nutrition';
import { scaledSnapshotMacros } from '@/data/food-nutrition';
import type { CatalogFood } from '@/lib/food-catalog';

function savedCatalogSource(food: { nutritionSnapshot?: FoodNutritionSnapshot }) {
  const provider = food.nutritionSnapshot?.source.provider.toLowerCase();
  if (provider === 'usda' || provider === 'thinnr' || provider === 'openfoodfacts' || provider === 'personal') {
    return provider;
  }
  return 'catalog' as const;
}

function selectedMacro(
  food: { nutritionSnapshot?: FoodNutritionSnapshot },
  key: 'calories' | 'protein' | 'carbs' | 'fat',
  fallback: number,
): number {
  return (food.nutritionSnapshot ? scaledSnapshotMacros(food.nutritionSnapshot) : null)?.[key] ?? fallback;
}

export interface LoggableItem {
  refId: string;
  kind: 'food' | 'recipe';
  name: string;
  sub: string;
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Food matches the official THINNR Approved Foods list. */
  approved: boolean;
  /** Times logged in the most-logged window (set only in that group). */
  loggedCount?: number;
  /** Exact immutable baseline and selected amount, when one exists. */
  nutritionSnapshot?: FoodNutritionSnapshot;
  /** Growing-catalog metadata; absent for legacy foods and recipes. */
  catalog?: {
    catalogId: string;
    group: 'common' | 'personal' | 'branded';
    source: 'usda' | 'thinnr' | 'openfoodfacts' | 'personal' | 'catalog';
    sourceLabel: string;
    selectionToken?: string;
    lookupId?: string;
    persisted?: boolean;
    servingGrams?: number;
    measures: Array<{ label: string; grams: number }>;
    canonicalName?: string;
    resultKey?: string;
    familyKey?: string;
    variantSummary?: string;
    dimensions?: Record<string, string>;
    choiceRequired?: boolean;
    nutritionSnapshot?: FoodNutritionSnapshot;
  };
}

/** Lossless catalog-to-basket conversion shared by search and details. */
export function catalogFoodToLoggable(food: CatalogFood): LoggableItem {
  const selectedTotals = food.nutritionSnapshot ? scaledSnapshotMacros(food.nutritionSnapshot) : null;
  return {
    refId: food.catalogId,
    kind: 'food',
    name: food.name,
    sub: food.variantSummary ?? food.brand ?? food.category,
    serving: food.serving,
    calories: selectedTotals?.calories ?? food.calories,
    protein: selectedTotals?.protein ?? food.protein,
    carbs: selectedTotals?.carbs ?? food.carbs,
    fat: selectedTotals?.fat ?? food.fat,
    approved: food.approved,
    ...(food.nutritionSnapshot ? { nutritionSnapshot: food.nutritionSnapshot } : {}),
    catalog: {
      catalogId: food.catalogId,
      group: food.group,
      source: food.source,
      sourceLabel: food.sourceLabel,
      ...(food.selectionToken ? { selectionToken: food.selectionToken } : {}),
      ...(food.lookupId ? { lookupId: food.lookupId } : {}),
      ...(food.servingGrams ? { servingGrams: food.servingGrams } : {}),
      measures: food.measures,
      ...(food.canonicalName ? { canonicalName: food.canonicalName } : {}),
      ...(food.resultKey ? { resultKey: food.resultKey } : {}),
      ...(food.familyKey ? { familyKey: food.familyKey } : {}),
      ...(food.variantSummary ? { variantSummary: food.variantSummary } : {}),
      ...(food.dimensions ? { dimensions: food.dimensions } : {}),
      ...(food.choiceRequired !== undefined ? { choiceRequired: food.choiceRequired } : {}),
      ...(food.nutritionSnapshot ? { nutritionSnapshot: food.nutritionSnapshot } : {}),
    },
  };
}

export function useLoggableItems(): {
  allItems: LoggableItem[];
  byId: Map<string, LoggableItem>;
} {
  const patient = usePatient();

  const allItems = useMemo<LoggableItem[]>(() => {
    const foods: LoggableItem[] = patient.allFoods.map(food => ({
      refId: food.id,
      kind: 'food',
      name: food.name,
      sub: food.brand ?? food.category,
      serving: food.serving,
      calories: selectedMacro(food, 'calories', food.calories),
      protein: selectedMacro(food, 'protein', food.protein),
      carbs: selectedMacro(food, 'carbs', food.carbs),
      fat: selectedMacro(food, 'fat', food.fat),
      approved: food.catalogApproved ?? isApprovedFood(food.id),
      ...(food.nutritionSnapshot ? { nutritionSnapshot: food.nutritionSnapshot } : {}),
      ...(food.catalogShared
        ? {
            catalog: {
              catalogId: food.id,
              group: food.category === 'Branded Products' ? 'branded' as const : 'common' as const,
              source: savedCatalogSource(food),
              sourceLabel: food.catalogSourceLabel ?? 'Food catalog',
              ...(food.catalogLookupId ? { lookupId: food.catalogLookupId } : {}),
              ...(food.catalogServingGrams ? { servingGrams: food.catalogServingGrams } : {}),
              measures: food.catalogMeasures ?? [],
              ...(food.catalogCanonicalName ? { canonicalName: food.catalogCanonicalName } : {}),
              ...(food.nutritionSnapshot?.variant ? {
                familyKey: food.nutritionSnapshot.variant.familyKey,
                variantSummary: food.nutritionSnapshot.variant.summary,
                dimensions: food.nutritionSnapshot.variant.dimensions,
              } : {}),
              ...(food.nutritionSnapshot ? { nutritionSnapshot: food.nutritionSnapshot } : {}),
              persisted: true,
            },
          }
        : {}),
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
      approved: false,
    }));
    // Recipes saved from coach (AI) suggestions log like any other recipe;
    // their nutrition numbers are model estimates, so say so in the sub.
    const savedRecipes: LoggableItem[] = patient.savedRecipes.map(recipe => ({
      refId: recipe.id,
      kind: 'recipe',
      name: recipe.name,
      sub: 'Coach recipe · AI estimate',
      serving: '1 serving',
      calories: recipe.calories,
      protein: recipe.protein,
      carbs: recipe.carbs,
      fat: recipe.fat,
      approved: false,
    }));
    return [...foods, ...savedRecipes, ...recipes];
  }, [patient.allFoods, patient.savedRecipes]);

  const byId = useMemo(() => new Map(allItems.map(item => [item.refId, item])), [allItems]);

  return { allItems, byId };
}
