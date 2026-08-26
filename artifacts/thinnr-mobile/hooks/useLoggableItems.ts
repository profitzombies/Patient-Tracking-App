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
      calories: food.calories,
      protein: food.protein,
      carbs: food.carbs,
      fat: food.fat,
      approved: isApprovedFood(food.id),
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
