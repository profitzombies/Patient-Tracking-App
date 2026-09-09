import assert from 'node:assert/strict';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { NutritionFacts, nutrientDailyValuePercent } from '../components/patient/NutritionFacts';
import { DiaryEntryCalories, DiaryEntryNutritionLine } from '../components/patient/DiaryEntryNutrition';
import { selectSnapshotPortion } from '../data/food-nutrition';
import type { FoodNutritionSnapshot } from '../data/food-nutrition';
import type { LoggableItem } from '../hooks/useLoggableItems';
import FoodDetailScreen from '../app/food/[id]';
import {
  configureCalls, favoriteCalls, resetDetailState, routerCalls,
} from './food-detail-stubs/state';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot: FoodNutritionSnapshot = {
  version: 1,
  source: {
    provider: 'USDA FoodData Central',
    recordId: 'test-record',
    release: 'Foundation 2026',
    revision: 'sha256:test',
    canonicalName: 'Test food, source description',
  },
  basis: { amount: 100, unit: 'g', label: '100 g', grams: 100 },
  nutrients: [
    { id: '1008', name: 'Energy', unit: 'kcal', amount: 200.125 },
    { id: '1003', name: 'Protein', unit: 'g', amount: 20.25 },
    { id: '1005', name: 'Carbohydrate', unit: 'g', amount: 10.5 },
    { id: '1004', name: 'Total Fat', unit: 'g', amount: 7.8 },
    { id: '1079', name: 'Dietary Fiber', unit: 'g', amount: 0 },
    { id: '1093', name: 'Sodium', unit: 'mg', amount: 230 },
    { id: '2000', name: 'Total Sugars', unit: 'g', amount: 2 },
  ],
  portions: [
    { id: 'gram', label: 'g', unit: 'g', dimension: 'weight', basisMultiplier: 0.01, grams: 1 },
    { id: 'ounce', label: 'oz', unit: 'oz', dimension: 'weight', basisMultiplier: 0.28349523125, grams: 28.349523125 },
  ],
  selected: { amount: 100, unitId: 'gram', scale: 1 },
  provenance: 'generic_source',
};

const item: LoggableItem = {
  refId: 'food-test',
  kind: 'food',
  name: 'Test food',
  sub: 'Common Foods',
  serving: '100 g',
  calories: 200.125,
  protein: 20.25,
  carbs: 10.5,
  fat: 7.8,
  approved: true,
};

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');
}
const closeTo = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-9;

function byTestId(root: ReactTestInstance, id: string): ReactTestInstance {
  const matches = root.findAll(node => node.props.testID === id && typeof node.type === 'string');
  assert.equal(matches.length, 1, `expected one real screen control ${id}`);
  return matches[0];
}

async function press(renderer: ReturnType<typeof create>, id: string) {
  await act(async () => {
    await byTestId(renderer.root, id).props.onPress();
    await Promise.resolve();
  });
}

function detailedItem(baseSnapshot: FoodNutritionSnapshot = snapshot): LoggableItem {
  return {
    ...item,
    nutritionSnapshot: baseSnapshot,
    catalog: {
      catalogId: item.refId,
      group: 'common',
      source: 'usda',
      sourceLabel: 'USDA FoodData Central',
      measures: [{ label: '1 oz', grams: 28.349523125 }],
      servingGrams: 100,
      familyKey: 'test-family',
      variantSummary: baseSnapshot.variant?.summary ?? 'Raw',
      dimensions: baseSnapshot.variant?.dimensions ?? { Preparation: 'Raw' },
      nutritionSnapshot: baseSnapshot,
    },
  };
}

async function main() {
  let facts!: ReturnType<typeof create>;
  await act(async () => {
    facts = create(<NutritionFacts snapshot={snapshot} />);
  });
  const factsText = textOf(facts.root);
  assert.match(factsText, /Dietary Fiber0 g · 0% DV/, 'an authentic zero renders and receives a valid DV');
  assert.match(factsText, /Sodium230 mg · 10% DV/, 'matching FDA milligram units receive a DV');
  assert.doesNotMatch(factsText, /Total Sugars2 g ·/, 'total sugar never receives an invalid DV');
  assert.equal(
    nutrientDailyValuePercent({ id: '1093', name: 'Sodium', unit: 'g', amount: 2.3 }),
    null,
    'a mismatched unit is not silently converted for DV',
  );

  const diarySnapshot: FoodNutritionSnapshot = {
    ...snapshot,
    variant: {
      familyKey: 'ground-beef',
      summary: 'Cooked · 90% lean / 10% fat',
      dimensions: { Preparation: 'Cooked', Leanness: '90/10' },
    },
    selected: { amount: 5.03, unitId: 'ounce', scale: 5.03 * 0.28349523125 },
  };
  let diaryLine!: ReturnType<typeof create>;
  let diaryCalories!: ReturnType<typeof create>;
  const diaryEntry = {
    id: 'diary-pretty', dateKey: '2026-09-08', meal: 'dinner' as const, kind: 'food' as const,
    refId: 'ground-beef-cooked', name: 'Ground Beef', detail: '1.426 quantity',
    quantity: diarySnapshot.selected.scale, calories: 285.47891, protein: 28.24891,
    carbs: 0.00001, fat: 14.24999, nutritionSnapshot: diarySnapshot,
  };
  await act(async () => {
    diaryLine = create(<DiaryEntryNutritionLine entry={diaryEntry} />);
    diaryCalories = create(<DiaryEntryCalories entry={diaryEntry} />);
  });
  assert.equal(
    textOf(diaryLine.root),
    '5.03 oz · Cooked · 90% lean / 10% fat · P 28.2g · C 0g · F 14.2g',
    'real diary row shows selected portion/type and display-only macro rounding',
  );
  assert.equal(textOf(diaryCalories.root), '285', 'real diary calories round to a whole display value');

  let legacy!: ReturnType<typeof create>;
  await act(async () => {
    legacy = create(<NutritionFacts snapshot={null} />);
  });
  assert.match(textOf(legacy.root), /Additional nutrients not provided/, 'legacy foods render without crashing');

  const ounces = selectSnapshotPortion(snapshot, snapshot.selected.scale / snapshot.portions[1].basisMultiplier, 'ounce');
  assert(ounces);
  const grams = selectSnapshotPortion(ounces, ounces.selected.scale / snapshot.portions[0].basisMultiplier, 'gram');
  assert(grams);
  assert.equal(grams.selected.scale, snapshot.selected.scale, 'g → oz → g preserves exact physical scale');

  const variantSnapshot: FoodNutritionSnapshot = {
    ...snapshot,
    source: { ...snapshot.source, recordId: 'cooked-record', revision: 'sha256:cooked' },
    variant: { familyKey: 'test-family', summary: 'Cooked', dimensions: { Preparation: 'Cooked' } },
  };
  const rawSnapshot: FoodNutritionSnapshot = {
    ...snapshot,
    variant: { familyKey: 'test-family', summary: 'Raw', dimensions: { Preparation: 'Raw' } },
  };
  const rawItem = detailedItem(rawSnapshot);
  const cookedItem = {
    ...detailedItem(variantSnapshot),
    refId: 'food-cooked',
    catalog: { ...detailedItem(variantSnapshot).catalog!, catalogId: 'food-cooked' },
  };

  resetDetailState(rawItem, { basketId: 'edited-basket-id', item: rawItem, quantity: 1 }, [
    { ...rawItem, catalogId: rawItem.refId, dimensions: { Preparation: 'Raw' }, loggable: rawItem },
    { ...cookedItem, catalogId: cookedItem.refId, dimensions: { Preparation: 'Cooked' }, variantSummary: 'Cooked', loggable: cookedItem },
  ]);
  let detail!: ReturnType<typeof create>;
  await act(async () => {
    detail = create(<FoodDetailScreen />);
    await Promise.resolve();
  });
  assert.match(textOf(detail.root), /200CALORIES/, 'actual detail screen initially renders authoritative calories');
  await press(detail, 'food-detail-plus');
  assert.match(textOf(detail.root), /100.5 g/, 'actual plus control changes the visible selected amount');
  assert.match(textOf(detail.root), /201CALORIES/, 'actual plus control changes visible macros from the same snapshot');
  assert.doesNotMatch(textOf(detail.root), /\d+\.\d{2,}g(?:PROTEIN|CARBS|FAT)/, 'detail macro summaries round display to at most one decimal');
  await press(detail, 'food-detail-unit-ounce');
  await press(detail, 'food-detail-unit-gram');
  assert.match(textOf(detail.root), /100.5 g/, 'actual unit controls round-trip without changing physical scale');
  await press(detail, 'food-detail-select');
  assert.equal(configureCalls[0].basketId, 'edited-basket-id', 'actual footer preserves the edited basket id');
  assert.equal(configureCalls[0].amount.ounces, undefined, 'actual footer does not pass legacy ounces for snapshots');
  assert(closeTo(configureCalls[0].item.nutritionSnapshot.selected.amount, 100.5), 'actual footer saves the stepped snapshot');
  assert(closeTo(configureCalls[0].item.calories, 201.125625), 'saved root totals are selected, unrounded snapshot macros');

  configureCalls.length = 0;
  favoriteCalls.length = 0;
  await press(detail, 'food-detail-plus');
  await press(detail, 'food-detail-favorite');
  assert(closeTo(favoriteCalls[0].food.nutritionSnapshot.selected.amount, 101), 'favorite saves the exact shown amount');
  assert(closeTo(favoriteCalls[0].food.calories, 202.12625), 'favorite root macros are selected totals without double scaling');
  assert.deepEqual(favoriteCalls[0].options, { favorite: true });

  await press(detail, 'food-detail-change-type');
  await press(detail, 'food-detail-dimension-Preparation-Cooked');
  assert.equal(configureCalls.length, 0, 'variant experiments do not mutate the basket');
  await press(detail, 'food-detail-select');
  assert.equal(configureCalls[0].item.refId, 'food-cooked', 'primary confirmation commits the drafted variant');
  await act(async () => detail.unmount());

  resetDetailState(rawItem, { basketId: 'edited-basket-id', item: rawItem, quantity: 1 }, [
    { ...rawItem, catalogId: rawItem.refId, dimensions: { Preparation: 'Raw' }, loggable: rawItem },
    { ...cookedItem, catalogId: cookedItem.refId, dimensions: { Preparation: 'Cooked' }, variantSummary: 'Cooked', loggable: cookedItem },
  ]);
  await act(async () => {
    detail = create(<FoodDetailScreen />);
    await Promise.resolve();
  });
  await press(detail, 'food-detail-change-type');
  await press(detail, 'food-detail-dimension-Preparation-Cooked');
  await press(detail, 'food-detail-back');
  assert.equal(configureCalls.length, 0, 'Back discards the complete local draft');
  assert.equal(routerCalls.at(-1), 'back');
  await act(async () => detail.unmount());

  const legacyItem = { ...item, refId: 'legacy-food' };
  resetDetailState(legacyItem);
  await act(async () => { detail = create(<FoodDetailScreen />); });
  assert.match(textOf(detail.root), /Test food/, 'actual detail screen renders a legacy null-snapshot food');
  await press(detail, 'food-detail-plus');
  await press(detail, 'food-detail-select');
  assert.equal(configureCalls[0].amount.quantity, 1.5, 'legacy serving multiplier remains usable');
  await act(async () => detail.unmount());

  const offGridSnapshot: FoodNutritionSnapshot = {
    ...snapshot,
    selected: { amount: 5.03, unitId: 'ounce', scale: 5.03 * 0.28349523125 },
  };
  resetDetailState(detailedItem(offGridSnapshot));
  await act(async () => { detail = create(<FoodDetailScreen />); });
  await press(detail, 'food-detail-minus');
  assert.match(textOf(detail.root), /5 oz/, 'one sensible half-step snaps 5.03 oz to the reachable 5 oz grid');
  await act(async () => detail.unmount());

  const offSnapshot: FoodNutritionSnapshot = {
    ...snapshot,
    source: { provider: 'Open Food Facts', recordId: '0123456789012', revision: 'off:2026-09-08' },
    nutrients: [
      { id: 'off:energy-kcal', name: 'Energy', unit: 'kcal', amount: 250.125 },
      { id: 'off:proteins', name: 'Proteins', unit: 'g', amount: 12.25 },
      { id: 'off:carbohydrates', name: 'Carbohydrates', unit: 'g', amount: 30.5 },
      { id: 'off:fat', name: 'Fat', unit: 'g', amount: 8.75 },
    ],
    portions: [{ id: 'gram', label: 'g', unit: 'g', dimension: 'weight', basisMultiplier: 0.01, grams: 1 }],
    selected: { amount: 30, unitId: 'gram', scale: 0.3 },
    provenance: 'identified_product',
  };
  const offItem = detailedItem(offSnapshot);
  resetDetailState(offItem);
  await act(async () => { detail = create(<FoodDetailScreen />); });
  assert.match(textOf(detail.root), /75CALORIES/, 'real OFF nutrient ids scale a 30 g selection in the actual screen');
  await press(detail, 'food-detail-favorite');
  assert.equal(favoriteCalls[0].food.calories, 75.0375, 'OFF favorite retains unrounded selected root calories');
  assert.equal(favoriteCalls[0].food.protein, 3.675, 'OFF favorite retains unrounded selected protein');

  await act(async () => {
    detail.unmount();
    facts.unmount();
    legacy.unmount();
    diaryLine.unmount();
    diaryCalories.unmount();
  });
  console.log('food detail behavior checks passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});