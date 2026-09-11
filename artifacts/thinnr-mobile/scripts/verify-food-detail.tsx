import assert from 'node:assert/strict';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { NutritionFacts, nutrientDailyValuePercent } from '../components/patient/NutritionFacts';
import { DiaryEntryCalories, DiaryEntryNutritionLine } from '../components/patient/DiaryEntryNutrition';
import { FOOD_DB } from '../data/patient-data';
import {
  formatNutritionAmount, nutritionPortionDimension, nutritionPortionPresentation,
  scaledSnapshotMacros, selectSnapshotDisplayedPortion, selectSnapshotPortion, snapshotConfigurationId,
} from '../data/food-nutrition';
import type { FoodNutritionSnapshot } from '../data/food-nutrition';
import type { LoggableItem } from '../hooks/useLoggableItems';
import { createLegacyFoodDetailSnapshot } from '../data/food-detail-amount';
import FoodDetailScreen from '../app/food/[id]';
import {
  configureCalls, favoriteCalls, resetDetailState, route, routerCalls, savedConfigurations,
  selectedCatalogFoods, setDetailAccountKind, setDetailFavorites, setSubmitOutcome, submittedEntries, setRecalledDetailItem,
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

function unitOptions(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(node =>
    typeof node.type === 'string' &&
    typeof node.props.testID === 'string' &&
    node.props.testID.startsWith('food-detail-unit-') &&
    node.props.testID !== 'food-detail-unit-picker',
  );
}

function unitId(root: ReactTestInstance, label: RegExp): string {
  const matches = unitOptions(root).filter(option => label.test(String(option.props.accessibilityLabel ?? textOf(option))));
  assert.equal(matches.length, 1, `expected one open unit option matching ${label}`);
  return matches[0].props.testID;
}

async function openUnits(renderer: ReturnType<typeof create>) {
  if (renderer.root.findAll(node => node.props.testID === 'food-detail-units').length === 0) {
    await press(renderer, 'food-detail-unit-picker');
  }
  assert(renderer.root.findAll(node => node.props.testID === 'food-detail-units').length > 0, 'the picker panel is mounted');
  assert(unitOptions(renderer.root).length > 0, 'the open picker exposes its options');
}

async function chooseUnit(renderer: ReturnType<typeof create>, label: RegExp) {
  await openUnits(renderer);
  await press(renderer, unitId(renderer.root, label));
}

function foodItemFromSeed(id: string): LoggableItem {
  const food = FOOD_DB.find(candidate => candidate.id === id);
  assert(food, `expected seeded food ${id}`);
  return {
    ...food,
    kind: 'food',
    refId: food.id,
    sub: food.category,
    approved: true,
  };
}

function snapshotForSeed(id: string): FoodNutritionSnapshot {
  const item = foodItemFromSeed(id);
  const snapshot = createLegacyFoodDetailSnapshot(item, undefined);
  assert(snapshot, `expected legacy snapshot for seeded food ${id}`);
  return snapshot;
}

function expectedNutritionText(snapshot: FoodNutritionSnapshot): string {
  const macros = scaledSnapshotMacros(snapshot);
  assert(macros);
  return `${Math.round(macros.calories)}CALORIES`;
}

function assertNutritionPreview(
  renderer: ReturnType<typeof create>,
  expected: FoodNutritionSnapshot,
  message: string,
) {
  const formatted = formatNutritionAmount(expected);
  assert.equal(
    textOf(byTestId(renderer.root, 'food-detail-nutrition-heading')),
    `Nutrition · ${formatted.text}`,
    `${message}: heading uses the displayed mixed-case amount`,
  );
  assert.match(textOf(renderer.root), new RegExp(expectedNutritionText(expected)), `${message}: calories use the selected source`);
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
  let detail!: ReturnType<typeof create>;
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

  // The seeded Brown Rice is intentionally exercised through the legacy
  // adapter, not a hand-authored test snapshot. This catches drift between
  // Food Details initialization and the real FOOD_DB row.
  const brownRice = foodItemFromSeed('fd_brown_rice');
  const brownRiceSnapshot = snapshotForSeed('fd_brown_rice');
  const brownRiceCup = brownRiceSnapshot.portions.find(portion =>
    nutritionPortionDimension(portion) === 'volume' &&
    nutritionPortionPresentation(portion).singular === 'cup');
  const brownRiceOunce = brownRiceSnapshot.portions.find(portion =>
    nutritionPortionDimension(portion) === 'weight' &&
    nutritionPortionPresentation(portion).singular === 'oz');
  const brownRiceGram = brownRiceSnapshot.portions.find(portion =>
    nutritionPortionDimension(portion) === 'weight' &&
    nutritionPortionPresentation(portion).singular === 'g');
  assert(brownRiceCup && brownRiceOunce && brownRiceGram, 'Brown Rice legacy snapshot documents cup, ounce, and gram');
  assert.equal(brownRiceCup.grams, 195, 'Brown Rice uses its confirmed one-cup source weight');
  assert.match(brownRiceCup.evidence ?? '', /FDC 168875.*1 cup = 195 g/, 'Brown Rice keeps food-specific USDA evidence');
  const brownRiceTwoCups = selectSnapshotDisplayedPortion(brownRiceSnapshot, 2, brownRiceCup.id);
  const brownRiceTwoOunces = selectSnapshotDisplayedPortion(brownRiceSnapshot, 2, brownRiceOunce.id);
  const brownRiceTwoGrams = selectSnapshotDisplayedPortion(brownRiceSnapshot, 2, brownRiceGram.id);
  assert(brownRiceTwoCups && brownRiceTwoOunces && brownRiceTwoGrams);

  resetDetailState(brownRice);
  await act(async () => { detail = create(<FoodDetailScreen />); });
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '1', 'seeded Brown Rice starts at one cup');
  assertNutritionPreview(detail, brownRiceSnapshot, 'seeded Brown Rice starts from its source serving');
  assert.equal(textOf(byTestId(detail.root, 'food-detail-nutrition-heading')), 'Nutrition · 1 cup');
  assert.equal(unitOptions(detail.root).length, 0, 'unit option ids are absent while the picker is closed');
  await openUnits(detail);
  assert.equal(byTestId(detail.root, 'food-detail-unit-picker').props['aria-expanded'], true, 'picker exposes its expanded state');
  assert.equal(unitOptions(detail.root).length, 3, 'Brown Rice exposes all source/cup, ounce, and gram choices');
  assert.equal(
    unitId(detail.root, /cup/i),
    `food-detail-unit-${brownRiceCup.id}`,
    'the source/cup option uses the helper-provided portion id',
  );
  assert.equal(unitId(detail.root, /\boz\b/i), `food-detail-unit-${brownRiceOunce.id}`, 'the ounce id is discovered from the open picker');
  assert.equal(unitId(detail.root, /\bg\b/i), `food-detail-unit-${brownRiceGram.id}`, 'the gram id is discovered from the open picker');
  assert.equal(detail.root.findAll(node => node.props.testID === 'food-detail-more-units').length, 0, 'there is no More units affordance');
  assert.equal(detail.root.findAll(node => node.props.testID === 'food-detail-source-measure').length, 0, 'the source accordion is removed');

  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('2');
  });
  assertNutritionPreview(detail, brownRiceTwoCups, 'pending two cups');
  assert.equal(textOf(byTestId(detail.root, 'food-detail-nutrition-heading')), 'Nutrition · 2 cups');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '2', 'raw 2 remains editable mid-entry');
  assert.equal(
    byTestId(detail.root, 'food-detail-amount-input').props.accessibilityLabel,
    'Current amount 2 cups. Enter a positive amount.',
    'amount accessibility names the pending displayed amount',
  );
  assert.equal(
    byTestId(detail.root, 'food-detail-unit-picker').props.accessibilityLabel,
    'Change unit, cups',
    'unit picker accessibility names the current plural unit',
  );
  const brownMacro = scaledSnapshotMacros(brownRiceTwoCups);
  assert(brownMacro);
  const brownNutrition = detail.root.findAll(node =>
    node.props.accessibilityLabel ===
      `${Math.round(brownMacro.calories)} calories, ${Number(brownMacro.protein.toFixed(1))} grams protein, ` +
      `${Number(brownMacro.carbs.toFixed(1))} grams carbs, ${Number(brownMacro.fat.toFixed(1))} grams fat`,
  );
  assert(brownNutrition.length > 0, 'nutrition summary exposes exact accessible macro values');
  await press(detail, 'food-detail-nutrition-toggle');
  const brownFactsText = textOf(detail.root);
  assert.match(brownFactsText, /432/, 'Nutrition Facts follows the pending two-cup preview');
  assert.match(brownFactsText, /Protein10 g/, 'Nutrition Facts reports the exact two-cup protein');
  assert.match(brownFactsText, /Carbohydrates?90 g/, 'Nutrition Facts reports the exact two-cup carbohydrate');
  assert.match(brownFactsText, /Total Fat4 g/, 'Nutrition Facts reports the exact two-cup fat');

  // Explicit unit selection consumes "2" but keeps the displayed amount. In
  // particular this is deliberately not the old physical-scale conversion.
  await chooseUnit(detail, /\boz\b/i);
  assertNutritionPreview(detail, brownRiceTwoOunces, 'two ounces after pending two cups');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '2');
  assert.equal(unitOptions(detail.root).length, 0, 'choosing a unit closes and removes the option ids');
  assert.equal(byTestId(detail.root, 'food-detail-unit-picker').props['aria-expanded'], false, 'picker exposes its collapsed state after selection');
  await chooseUnit(detail, /\bg\b/i);
  assertNutritionPreview(detail, brownRiceTwoGrams, 'two grams after two ounces');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '2');
  await act(async () => detail.unmount());

  // Favorite persistence uses the stable configuration id and reopens the
  // exact displayed amount rather than regenerating a fresh serving.
  resetDetailState(brownRice);
  setDetailFavorites([brownRice.refId]);
  await act(async () => { detail = create(<FoodDetailScreen />); });
  assert.equal(
    byTestId(detail.root, 'food-detail-favorite').props.accessibilityLabel,
    'Remove Brown Rice, cooked from favorites',
    'a legacy favorite id matches Brown Rice only at its original baseline',
  );
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('2');
  });
  assert.equal(
    byTestId(detail.root, 'food-detail-favorite').props.accessibilityLabel,
    'Favorite Brown Rice, cooked at 2 cups',
    'a changed Brown Rice amount is not treated as the legacy baseline favorite',
  );
  await act(async () => detail.unmount());

  resetDetailState(brownRice);
  await act(async () => { detail = create(<FoodDetailScreen />); });
  await act(async () => { byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('2'); });
  await press(detail, 'food-detail-favorite');
  assert.equal(favoriteCalls.length, 1);
  assert.equal(favoriteCalls[0].options.favorite, true);
  assert.equal(favoriteCalls[0].food.nutritionSnapshot.selected.amount, 2);
  const brownSaved = savedConfigurations[0];
  assert.equal(brownSaved.id, snapshotConfigurationId(favoriteCalls[0].food.nutritionSnapshot));
  await act(async () => detail.unmount());
  resetDetailState({ ...brownSaved, kind: 'food', refId: brownSaved.id });
  await act(async () => { detail = create(<FoodDetailScreen />); });
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '2', 'saved Brown Rice configuration reopens at two cups');
  assert.equal(textOf(byTestId(detail.root, 'food-detail-nutrition-heading')), 'Nutrition · 2 cups');
  await act(async () => detail.unmount());

  const legacySevenOunces = selectSnapshotPortion({
    ...rawSnapshot,
    variant: {
      familyKey: 'bulk-whole-wheat-bread',
      summary: 'Raw',
      dimensions: { Preparation: 'Raw' },
    },
  }, 7, 'ounce');
  assert(legacySevenOunces);
  const legacyConfigurationId = snapshotConfigurationId(legacySevenOunces);
  const legacySavedItem = {
    ...detailedItem(legacySevenOunces),
    refId: legacyConfigurationId,
    catalog: {
      ...detailedItem(legacySevenOunces).catalog!,
      catalogId: legacyConfigurationId,
      familyKey: 'bulk-whole-wheat-bread',
      persisted: true,
    },
  };
  const canonicalRawSnapshot: FoodNutritionSnapshot = {
    ...legacySevenOunces,
    variant: {
      ...legacySevenOunces.variant!,
      familyKey: 'everyday-whole-wheat-bread',
    },
  };
  const canonicalRawItem = {
    ...detailedItem(canonicalRawSnapshot),
    refId: 'canonical-bread-raw',
    catalog: {
      ...detailedItem(canonicalRawSnapshot).catalog!,
      catalogId: 'canonical-bread-raw',
      familyKey: 'everyday-whole-wheat-bread',
    },
  };
  const canonicalCookedSnapshot: FoodNutritionSnapshot = {
    ...variantSnapshot,
    selected: legacySevenOunces.selected,
    variant: {
      familyKey: 'everyday-whole-wheat-bread',
      summary: 'Cooked',
      dimensions: { Preparation: 'Cooked' },
    },
  };
  const canonicalCookedItem = {
    ...detailedItem(canonicalCookedSnapshot),
    refId: 'canonical-bread-cooked',
    catalog: {
      ...detailedItem(canonicalCookedSnapshot).catalog!,
      catalogId: 'canonical-bread-cooked',
      familyKey: 'everyday-whole-wheat-bread',
    },
  };
  resetDetailState(legacySavedItem, undefined, [
    { ...canonicalRawItem, catalogId: canonicalRawItem.refId, dimensions: canonicalRawItem.catalog!.dimensions, loggable: canonicalRawItem },
    { ...canonicalCookedItem, catalogId: canonicalCookedItem.refId, dimensions: canonicalCookedItem.catalog!.dimensions, loggable: canonicalCookedItem },
  ]);
  await act(async () => { detail = create(<FoodDetailScreen />); await Promise.resolve(); });
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '7', 'a saved legacy-family snapshot reopens at its exact amount');
  await press(detail, 'food-detail-change-type');
  byTestId(detail.root, 'food-detail-dimension-Preparation-Cooked');
  await press(detail, 'food-detail-dimension-Preparation-Raw');
  await press(detail, 'food-detail-select');
  const redirectedSavedSnapshot = configureCalls[0].item.nutritionSnapshot as FoodNutritionSnapshot;
  assert.equal(redirectedSavedSnapshot.variant?.familyKey, 'everyday-whole-wheat-bread', 'redirected canonical variants remain selectable');
  assert.equal(redirectedSavedSnapshot.selected.amount, 7, 'redirected family editing preserves the saved amount');
  assert.deepEqual(redirectedSavedSnapshot.source, legacySevenOunces.source, 'redirected family editing preserves exact source identity');
  assert.equal(snapshotConfigurationId(redirectedSavedSnapshot), legacyConfigurationId, 'family-key redirection alone preserves configuration identity');
  await act(async () => detail.unmount());

  resetDetailState(rawItem, { basketId: 'edited-basket-id', item: rawItem, quantity: 1 }, [
    { ...rawItem, catalogId: rawItem.refId, dimensions: { Preparation: 'Raw' }, loggable: rawItem },
    { ...cookedItem, catalogId: cookedItem.refId, dimensions: { Preparation: 'Cooked' }, variantSummary: 'Cooked', loggable: cookedItem },
  ]);
  await act(async () => {
    detail = create(<FoodDetailScreen />);
    await Promise.resolve();
  });
  assert.match(textOf(detail.root), /200CALORIES/, 'actual detail screen initially renders authoritative calories');
  await press(detail, 'food-detail-plus');
  assert.match(textOf(detail.root), /100.5 G/i, 'actual plus control changes the visible selected amount');
  assert.match(textOf(detail.root), /201CALORIES/, 'actual plus control changes visible macros from the same snapshot');
  assert.doesNotMatch(textOf(detail.root), /\d+\.\d{2,}g(?:PROTEIN|CARBS|FAT)/, 'detail macro summaries round display to at most one decimal');
  await chooseUnit(detail, /oz/i);
  assert.equal(
    byTestId(detail.root, 'food-detail-amount-input').props.value,
    '100.5',
    'an explicit unit change preserves the displayed number rather than physical weight',
  );
  await chooseUnit(detail, /\bg\b/i);
  assert.equal(
    byTestId(detail.root, 'food-detail-amount-input').props.value,
    '100.5',
    'a weight-to-weight unit change also preserves the displayed number',
  );
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

  const wingSnapshot = (
    preparation: 'Roasted' | 'Fried',
    calories: number,
    dimensions: Record<string, string>,
  ): FoodNutritionSnapshot => ({
    ...snapshot,
    source: { ...snapshot.source, recordId: `wing-${preparation.toLowerCase()}`, revision: `sha256:${preparation}` },
    nutrients: snapshot.nutrients.map(nutrient => nutrient.id === '1008' ? { ...nutrient, amount: calories } : nutrient),
    variant: { familyKey: 'chicken-wings', summary: preparation, dimensions },
  });
  const roastedWing = detailedItem(wingSnapshot('Roasted', 252, { State: 'Cooked', Preparation: 'Roasted' }));
  const friedWing = {
    ...detailedItem(wingSnapshot('Fried', 289, { State: 'Cooked', Preparation: 'Fried', Coating: 'Coated' })),
    refId: 'wing-fried',
  };
  resetDetailState(roastedWing, { basketId: 'wing-basket', item: roastedWing, quantity: 1 }, [
    { ...roastedWing, catalogId: roastedWing.refId, dimensions: roastedWing.catalog!.dimensions, loggable: roastedWing },
    { ...friedWing, catalogId: friedWing.refId, dimensions: friedWing.catalog!.dimensions, loggable: friedWing },
  ]);
  await act(async () => { detail = create(<FoodDetailScreen />); await Promise.resolve(); });
  await press(detail, 'food-detail-change-type');
  assert.match(textOf(detail.root), /252CALORIES/);
  await press(detail, 'food-detail-dimension-Preparation-Fried');
  assert.match(textOf(detail.root), /289CALORIES/, 'Roasted switches directly to the exact Fried source');
  assert.equal(detail.root.findAll(node => node.props.testID === 'food-detail-confirm-variant').length, 0, 'incidental coating does not force confirmation');
  await press(detail, 'food-detail-dimension-Preparation-Roasted');
  assert.match(textOf(detail.root), /252CALORIES/, 'hidden Fried coating does not block returning to Roasted');
  await press(detail, 'food-detail-select');
  assert.equal(configureCalls[0].item.refId, roastedWing.refId, 'final save commits the exact displayed source after reversible exploration');
  await act(async () => detail.unmount());

  const skinOnWing = detailedItem(wingSnapshot('Roasted', 252, { State: 'Cooked', Preparation: 'Roasted', Skin: 'On' }));
  const skinOffWing = {
    ...detailedItem(wingSnapshot('Fried', 289, { State: 'Cooked', Preparation: 'Fried', Skin: 'Off' })),
    refId: 'wing-skin-off',
  };
  resetDetailState(skinOnWing, { basketId: 'skin-basket', item: skinOnWing, quantity: 1 }, [
    { ...skinOnWing, catalogId: skinOnWing.refId, dimensions: skinOnWing.catalog!.dimensions, loggable: skinOnWing },
    { ...skinOffWing, catalogId: skinOffWing.refId, dimensions: skinOffWing.catalog!.dimensions, loggable: skinOffWing },
  ]);
  await act(async () => { detail = create(<FoodDetailScreen />); await Promise.resolve(); });
  await press(detail, 'food-detail-change-type');
  await press(detail, 'food-detail-dimension-Preparation-Fried');
  assert(byTestId(detail.root, 'food-detail-confirm-variant'), 'a real incompatible skin choice requires explicit confirmation');
  await press(detail, 'food-detail-cancel-variant');
  assert.match(textOf(detail.root), /252CALORIES/, 'Cancel leaves the exact draft unchanged');
  await press(detail, 'food-detail-dimension-Preparation-Fried');
  await press(detail, 'food-detail-confirm-variant');
  assert.match(textOf(detail.root), /289CALORIES/, 'confirmation applies the complete supported source');
  await act(async () => detail.unmount());

  resetDetailState(rawItem);
  route.origin = 'library';
  route.date = '2026-09-08';
  route.meal = 'dinner';
  await act(async () => { detail = create(<FoodDetailScreen />); });
  assert.equal(configureCalls.length, 0, 'opening the actual detail screen from Library does not create a hidden basket selection');
  await press(detail, 'food-detail-favorite');
  assert.equal(configureCalls.length, 0, 'favoriting from Library does not create a hidden basket selection');
  await press(detail, 'food-detail-select');
  assert.equal(configureCalls.length, 0, 'Library explicit add bypasses the Add Food batch basket');
  assert.equal(submittedEntries.length, 1, 'Library explicit add submits exactly one visible food');
  assert.equal(submittedEntries[0].meal, 'dinner', 'Library detail preserves the chosen meal');
  assert.match(textOf(detail.root), /Added to Dinner/, 'Library explicit add renders an in-screen confirmation');
  await act(async () => detail.unmount());

  resetDetailState(rawItem);
  route.origin = 'library';
  route.meal = 'lunch';
  setSubmitOutcome({ outcome: 'rejected', message: 'Please review this food.' });
  await act(async () => { detail = create(<FoodDetailScreen />); });
  await press(detail, 'food-detail-select');
  assert.equal(configureCalls.length, 0, 'a rejected Library add still never leaks into the batch basket');
  assert.match(textOf(detail.root), /Please review this food/, 'a rejected direct add stays visible and reviewable on details');
  assert.match(textOf(detail.root), /Add to Lunch/, 'the failed direct add keeps its meal and explicit retry action');
  await act(async () => detail.unmount());

  const sharedSingleton: LoggableItem = {
    ...item,
    refId: 'source-singleton-id',
    name: 'Friendly Singleton',
    nutritionSnapshot: undefined,
    catalog: {
      catalogId: 'source-singleton-id',
      group: 'common',
      source: 'usda',
      sourceLabel: 'USDA FoodData Central',
      measures: [],
    },
  };
  resetDetailState(sharedSingleton);
  setDetailAccountKind('real');
  route.origin = 'library';
  route.meal = 'snack';
  setSubmitOutcome({ outcome: 'queued' });
  await act(async () => { detail = create(<FoodDetailScreen />); });
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '100', 'snapshotless shared foods retain their 100 g source baseline');
  assert.equal(textOf(byTestId(detail.root, 'food-detail-nutrition-heading')), 'Nutrition · 100 g');
  const directAdd = byTestId(detail.root, 'food-detail-select').props.onPress;
  await act(async () => {
    await Promise.all([directAdd(), directAdd()]);
    await Promise.resolve();
  });
  assert.equal(selectedCatalogFoods.length, 1, 'rapid repeated taps promote a snapshotless singleton once');
  assert.equal(savedConfigurations.length, 1, 'snapshotless shared singleton gets one private recents lookup copy');
  const singletonConfigurationId = snapshotConfigurationId(savedConfigurations[0].nutritionSnapshot);
  assert.match(singletonConfigurationId, /^cfg_/);
  assert.equal(savedConfigurations[0].id, singletonConfigurationId, 'shared singleton persists under its stable snapshot configuration id');
  assert.equal(savedConfigurations[0].nutritionSnapshot.selected.amount, 1, 'the persisted singleton keeps its original 100 g amount');
  assert.equal(savedConfigurations[0].name, 'Friendly Singleton', 'lookup copy retains the shown friendly name');
  assert.equal(submittedEntries.length, 1, 'rapid repeated queued add submits one recoverable queue entry');
  assert.equal(submittedEntries[0].refId, singletonConfigurationId, 'queued entry resolves through the persisted snapshot configuration id');
  assert.match(textOf(detail.root), /waiting to sync/, 'queued singleton remains visible as pending recovery');
  assert.equal(configureCalls.length, 0, 'queued Library singleton never enters the Add Food basket');
  await act(async () => detail.unmount());

  const demoBroccoli: LoggableItem = {
    ...sharedSingleton,
    refId: '30786967-2ada-4c26-b37c-7dd65b9115b7',
    name: 'Broccoli',
    serving: '100 g',
    calories: 34,
    protein: 2.8,
    carbs: 6.6,
    fat: 0.4,
    catalog: {
      ...sharedSingleton.catalog!,
      catalogId: '30786967-2ada-4c26-b37c-7dd65b9115b7',
    },
  };
  resetDetailState(demoBroccoli);
  // resetDetailState deliberately restores the explicit guided-demo scope.
  route.origin = 'library';
  route.date = '2026-08-22';
  route.meal = 'lunch';
  await act(async () => { detail = create(<FoodDetailScreen />); });
  await press(detail, 'food-detail-select');
  assert.equal(selectedCatalogFoods.length, 0, 'guided demo never calls the protected catalog-selection transport');
  assert.equal(savedConfigurations.length, 1, 'guided demo saves a local shared-food lookup copy');
  const demoConfigurationId = snapshotConfigurationId(savedConfigurations[0].nutritionSnapshot);
  assert.equal(savedConfigurations[0].id, demoConfigurationId, 'guided demo saves under its stable snapshot configuration id');
  assert.equal(submittedEntries.length, 1);
  assert.equal(submittedEntries[0].refId, demoConfigurationId);
  assert.equal(submittedEntries[0].calories, 34, 'guided demo logs the visible 34 calorie, 100 g singleton');
  assert.equal(submittedEntries[0].detail, '100 g', 'direct logging uses the real snapshot entry formatter');
  assert.match(textOf(detail.root), /Added to Lunch/, 'guided demo receives the normal visible success confirmation');
  await act(async () => detail.unmount());

  const legacyItem = { ...item, refId: 'legacy-food' };
  resetDetailState(legacyItem);
  await act(async () => { detail = create(<FoodDetailScreen />); });
  assert.match(textOf(detail.root), /Test food/, 'actual detail screen renders a legacy null-snapshot food');
  await press(detail, 'food-detail-plus');
  await press(detail, 'food-detail-select');
  assert.equal(configureCalls[0].item.nutritionSnapshot.selected.unitId, 'gram', 'legacy gram servings retain their documented source unit');
  assert.equal(configureCalls[0].item.nutritionSnapshot.selected.amount, 1.005, 'legacy weighed food keeps its stepped displayed amount');
  assert(
    closeTo(configureCalls[0].amount.quantity, configureCalls[0].item.nutritionSnapshot.selected.scale),
    'legacy snapshot saves its exact physical scale',
  );
  await act(async () => detail.unmount());

  const offGridSnapshot: FoodNutritionSnapshot = {
    ...snapshot,
    selected: { amount: 5.03, unitId: 'ounce', scale: 5.03 * 0.28349523125 },
  };
  resetDetailState(detailedItem(offGridSnapshot));
  await act(async () => { detail = create(<FoodDetailScreen />); });
  await press(detail, 'food-detail-minus');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '4.53', 'a half-ounce step is applied to the intentional off-grid amount');
  await act(async () => detail.unmount());

  const fiveOunceFavorite = selectSnapshotPortion(snapshot, 5, 'ounce');
  assert(fiveOunceFavorite);
  const existingFavoriteIds = new Set([snapshotConfigurationId(fiveOunceFavorite)]);
  const originalArrayIncludes = Array.prototype.includes;
  Array.prototype.includes = function includesWithFavorite<T>(this: T[], value: T, fromIndex?: number): boolean {
    if (
      this.length === 0 &&
      typeof value === 'string' &&
      value.startsWith('cfg_') &&
      existingFavoriteIds.has(value)
    ) return true;
    return originalArrayIncludes.call(this, value, fromIndex);
  };
  try {
    resetDetailState(detailedItem(snapshot));
    await act(async () => { detail = create(<FoodDetailScreen />); });
    assert.match(textOf(byTestId(detail.root, 'food-detail-favorite')), /Remove favorite/, 'the exact five-ounce configuration starts favorite');
    await act(async () => {
      byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('7');
    });
    assert.match(textOf(byTestId(detail.root, 'food-detail-favorite')), /Save as favorite/, 'an unblurred seven-ounce configuration is a distinct add-favorite action');
    await press(detail, 'food-detail-favorite');
    assert.equal(favoriteCalls[0].food.nutritionSnapshot.selected.amount, 7);
    assert.deepEqual(favoriteCalls[0].options, { favorite: true }, 'favorite mutation uses the pending configuration id and exact amount');
    await act(async () => {
      byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('5');
    });
    assert.match(textOf(byTestId(detail.root, 'food-detail-favorite')), /Remove favorite/, 'typing back to the existing five-ounce favorite restores remove state');
    await press(detail, 'food-detail-favorite');
    assert.equal(favoriteCalls[1].food.nutritionSnapshot.selected.amount, 5);
    assert.deepEqual(favoriteCalls[1].options, { favorite: false });
    await act(async () => detail.unmount());
  } finally {
    Array.prototype.includes = originalArrayIncludes;
  }

  resetDetailState(detailedItem(snapshot));
  await act(async () => { detail = create(<FoodDetailScreen />); });
  assert.equal(
    byTestId(detail.root, 'food-detail-amount-input').props.value,
    '5',
    'a genuinely fresh weighed catalog food is initialized to five ounces before selection',
  );
  const freshCalories = textOf(detail.root);
  await chooseUnit(detail, /oz/i);
  assert.equal(textOf(detail.root), freshCalories, 'tapping the selected unit is a complete no-op');
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('7.25');
  });
  await press(detail, 'food-detail-select');
  assert.equal(configureCalls[0].item.nutritionSnapshot.selected.amount, 7.25, 'Select consumes exact pending numeric input without relying on blur');
  await act(async () => detail.unmount());

  resetDetailState(detailedItem(snapshot));
  await act(async () => { detail = create(<FoodDetailScreen />); });
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('7');
  });
  await press(detail, 'food-detail-nutrition-toggle');
  assert.match(
    textOf(detail.root),
    /Sodium456\.4 mg/,
    'expanded Nutrition Facts follows the valid pending seven-ounce preview',
  );
  await chooseUnit(detail, /\bg\b/i);
  assert.equal(
    byTestId(detail.root, 'food-detail-amount-input').props.value,
    '7',
    'an explicit unit change consumes pending input while preserving its displayed number',
  );
  assert.match(textOf(detail.root), /14CALORIES/, 'the explicit seven-gram selection recomputes nutrition');
  await press(detail, 'food-detail-select');
  assert(closeTo(configureCalls[0].item.nutritionSnapshot.selected.amount, 7));
  assert(closeTo(configureCalls[0].item.calories, 200.125 * 0.07), 'final save preserves exact selected unit nutrition');
  await act(async () => detail.unmount());

  resetDetailState(roastedWing, { basketId: 'pending-wing', item: roastedWing, quantity: 1 }, [
    { ...roastedWing, catalogId: roastedWing.refId, dimensions: roastedWing.catalog!.dimensions, loggable: roastedWing },
    { ...friedWing, catalogId: friedWing.refId, dimensions: friedWing.catalog!.dimensions, loggable: friedWing },
  ]);
  await act(async () => { detail = create(<FoodDetailScreen />); await Promise.resolve(); });
  await press(detail, 'food-detail-change-type');
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('7');
  });
  await press(detail, 'food-detail-dimension-Preparation-Fried');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '7', 'pending seven ounces survives the Fried source transition');
  await press(detail, 'food-detail-dimension-Preparation-Roasted');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '7', 'Fried → Roasted retains the pending seven-ounce weight');
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('0');
  });
  await chooseUnit(detail, /\bg\b/i);
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '0', 'invalid pending input blocks unit conversion without being consumed');
  await press(detail, 'food-detail-dimension-Preparation-Fried');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '0', 'invalid pending input blocks direct type changes without being consumed');
  assert.equal(detail.root.findAll(node => node.props.testID === 'food-detail-confirm-variant').length, 0);
  await act(async () => detail.unmount());

  resetDetailState(skinOnWing, { basketId: 'invalid-conflict', item: skinOnWing, quantity: 1 }, [
    { ...skinOnWing, catalogId: skinOnWing.refId, dimensions: skinOnWing.catalog!.dimensions, loggable: skinOnWing },
    { ...skinOffWing, catalogId: skinOffWing.refId, dimensions: skinOffWing.catalog!.dimensions, loggable: skinOffWing },
  ]);
  await act(async () => { detail = create(<FoodDetailScreen />); await Promise.resolve(); });
  await press(detail, 'food-detail-change-type');
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('0');
  });
  await press(detail, 'food-detail-dimension-Preparation-Fried');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '0');
  assert.equal(
    detail.root.findAll(node => node.props.testID === 'food-detail-confirm-variant').length,
    0,
    'invalid pending input blocks even an incompatible type proposal',
  );
  await act(async () => detail.unmount());

  resetDetailState(detailedItem(snapshot));
  await act(async () => { detail = create(<FoodDetailScreen />); });
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('0');
  });
  await press(detail, 'food-detail-favorite');
  assert.equal(favoriteCalls.length, 0, 'invalid pending input blocks Favorite');
  await press(detail, 'food-detail-select');
  assert.equal(configureCalls.length, 0, 'invalid pending input blocks Select');
  assert.match(textOf(detail.root), /greater than zero/, 'invalid final action leaves an explicit reviewable error');
  await act(async () => detail.unmount());

  resetDetailState(detailedItem(snapshot));
  route.origin = 'library';
  await act(async () => { detail = create(<FoodDetailScreen />); });
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('6.75');
  });
  await press(detail, 'food-detail-favorite');
  assert.equal(favoriteCalls[0].food.nutritionSnapshot.selected.amount, 6.75, 'Favorite consumes exact pending input');
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('-2');
  });
  await press(detail, 'food-detail-select');
  assert.equal(submittedEntries.length, 0, 'invalid pending input blocks a Library add');
  await act(async () => detail.unmount());

  const beanSnapshot: FoodNutritionSnapshot = {
    ...snapshot,
    source: { ...snapshot.source, recordId: 'green-beans', revision: 'sha256:green-beans' },
    portions: [
      snapshot.portions[0],
      snapshot.portions[1],
      { id: 'ten-beans', label: '10 beans (4" long)', unit: 'bean', dimension: 'count', basisMultiplier: 0.55, grams: 55 },
      { id: 'cup-pieces', label: '1 cup 1/2" pieces', unit: 'cup', dimension: 'volume', basisMultiplier: 1, grams: 100 },
    ],
    selected: { amount: 1, unitId: 'cup-pieces', scale: 1 },
  };
  resetDetailState(detailedItem(beanSnapshot));
  await act(async () => { detail = create(<FoodDetailScreen />); });
  await openUnits(detail);
  assert.equal(unitOptions(detail.root).length, 4, 'the picker shows every documented unit at once');
  assert.equal(detail.root.findAll(node => node.props.testID === 'food-detail-more-units').length, 0, 'the old More units control is gone');
  assert.equal(detail.root.findAll(node => node.props.testID === 'food-detail-source-measure-ten-beans').length, 0, 'the old source accordion is gone');
  await press(detail, unitId(detail.root, /cup/i));
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '1', 'choosing the already displayed cup is a no-op');
  assert.match(textOf(detail.root), /1\/2" pieces/, 'the source inch qualifier remains visible separately');
  await press(detail, 'food-detail-minus');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '0.75', 'cups step by a useful quarter cup');
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('0.5');
  });
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onSubmitEditing();
  });
  assert.match(textOf(detail.root), /½ CUP/i, 'positive direct numeric input renders a readable fractional cup');
  await press(detail, 'food-detail-select');
  assert.equal(configureCalls[0].item.nutritionSnapshot.selected.amount, 0.5, 'the exact displayed half cup is saved without rounding');
  assert.equal(configureCalls[0].item.nutritionSnapshot.portions[3].label, '1 cup 1/2" pieces', 'saving preserves the source portion statement');
  await act(async () => detail.unmount());

  const fractionalSourceSnapshot: FoodNutritionSnapshot = {
    ...snapshot,
    source: { ...snapshot.source, recordId: 'fractional-source', revision: 'sha256:fractional-source' },
    portions: [
      { id: 'half-cup', label: '1/2 cup', unit: 'cup', dimension: 'volume', basisMultiplier: 1, grams: 120 },
      { id: 'four-ounce', label: '4 oz', unit: 'oz', dimension: 'weight', basisMultiplier: 1.134, grams: 113.3980925 },
      { id: 'gram', label: 'g', unit: 'g', dimension: 'weight', basisMultiplier: 0.01, grams: 1 },
    ],
    selected: { amount: 1, unitId: 'half-cup', scale: 1 },
  };
  const fractionalItem = detailedItem(fractionalSourceSnapshot);
  resetDetailState(fractionalItem);
  await act(async () => { detail = create(<FoodDetailScreen />); });
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '0.5', 'a 1/2-cup source displays its fractional amount');
  assert.equal(textOf(byTestId(detail.root, 'food-detail-nutrition-heading')), 'Nutrition · ½ cup');
  await openUnits(detail);
  assert.deepEqual(
    fractionalSourceSnapshot.portions.map(portion => portion.label),
    ['1/2 cup', '4 oz', 'g'],
    'fractional source and four-ounce source labels remain authentic',
  );
  assert.equal(unitOptions(detail.root).length, 3, 'fractional source still exposes every documented unit');
  await chooseUnit(detail, /\boz\b/i);
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '0.5', 'fractional pending amounts are preserved by explicit unit changes');
  assert.equal(textOf(byTestId(detail.root, 'food-detail-nutrition-heading')), 'Nutrition · 0.5 oz');
  await act(async () => detail.unmount());

  const legacyCustom: LoggableItem = {
    ...item,
    refId: 'custom-without-alternatives',
    name: 'My family recipe',
    serving: '1 serving',
    nutritionSnapshot: undefined,
    catalog: {
      catalogId: 'custom-without-alternatives',
      group: 'personal',
      source: 'user',
      sourceLabel: 'My Foods',
      measures: [],
    },
  };
  resetDetailState(legacyCustom);
  setDetailFavorites([legacyCustom.refId]);
  await act(async () => { detail = create(<FoodDetailScreen />); });
  assert.match(textOf(detail.root), /My family recipe/, 'legacy custom foods remain usable without a nutrition snapshot');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '1');
  assert.equal(textOf(byTestId(detail.root, 'food-detail-nutrition-heading')), 'Nutrition · 1 serving');
  assert.equal(
    byTestId(detail.root, 'food-detail-favorite').props.accessibilityLabel,
    'Remove My family recipe from favorites',
    'a custom legacy favorite id matches only the original serving baseline',
  );
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('2');
  });
  assert.equal(
    byTestId(detail.root, 'food-detail-favorite').props.accessibilityLabel,
    'Favorite My family recipe at 2 servings',
    'a changed custom serving is saved as a distinct configuration',
  );
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('1');
  });
  await press(detail, 'food-detail-unit-picker');
  assert(detail.root.findAll(node => node.props.testID === 'food-detail-units').length > 0, 'legacy foods expose their original source measure');
  assert.equal(unitOptions(detail.root).length, 1, 'a legacy custom food without alternatives has only its source measure');
  assert(unitId(detail.root, /serving/i), 'the source serving id is present without fabricated alternatives');
  await press(detail, 'food-detail-select');
  assert.equal(configureCalls[0].item.nutritionSnapshot.portions.length, 1, 'saving keeps the custom source-only snapshot intact');
  assert.equal(detail.root.findAll(node => node.props.testID === 'food-detail-more-units').length, 0);
  await act(async () => detail.unmount());

  const fractionalWingSnapshot: FoodNutritionSnapshot = {
    ...snapshot,
    portions: [{
      id: 'wing', label: '1 wing, any size', unit: 'undetermined', dimension: 'serving',
      basisMultiplier: 0.34, grams: 34, evidence: 'USDA source portion',
    }],
    selected: { amount: 0.5, unitId: 'wing', scale: 0.17 },
  };
  resetDetailState(detailedItem(fractionalWingSnapshot));
  await act(async () => { detail = create(<FoodDetailScreen />); });
  await press(detail, 'food-detail-minus');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '0.5', 'decreasing a half wing is a no-op rather than increasing it');
  await press(detail, 'food-detail-plus');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '1.5', 'a whole-count step applies to the intentional half wing');
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('0');
  });
  await press(detail, 'food-detail-plus');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '0', 'stepping validates pending typed input instead of using stale nutrition');
  assert.match(textOf(detail.root), /greater than zero/);
  await act(async () => detail.unmount());

  const drumetteSnapshot: FoodNutritionSnapshot = {
    ...snapshot,
    portions: [{
      id: 'drumette', label: '1 drumette', unit: 'undetermined', dimension: 'serving',
      basisMultiplier: 0.2775, grams: 27.75, evidence: 'USDA source portion',
    }],
    selected: { amount: 3, unitId: 'drumette', scale: 0.8325 },
  };
  resetDetailState(detailedItem(drumetteSnapshot));
  await act(async () => { detail = create(<FoodDetailScreen />); });
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('0');
  });
  await press(detail, 'food-detail-select');
  assert.match(textOf(detail.root), /greater than zero/);
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('2');
  });
  assert.doesNotMatch(textOf(detail.root), /greater than zero/, 'typing a valid replacement clears the stale validation error');
  assert.equal(
    textOf(byTestId(detail.root, 'food-detail-nutrition-heading')),
    'Nutrition · 2 drumettes',
    'valid unblurred input previews the exact mixed-case amount',
  );
  assert.match(textOf(detail.root), /111CALORIES/, 'valid unblurred input previews matching nutrition');
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('2.');
  });
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '2.', 'editable decimal text is not normalized while typing');
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('2.5');
  });
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '2.5');
  assert.equal(textOf(byTestId(detail.root, 'food-detail-nutrition-heading')), 'Nutrition · 2.5 drumettes');
  assert.match(textOf(detail.root), /139CALORIES/, 'fractional valid text previews exact nutrition before blur');
  await act(async () => detail.unmount());

  const tenthCupSnapshot: FoodNutritionSnapshot = {
    ...beanSnapshot,
    selected: { amount: 0.1, unitId: 'cup-pieces', scale: 0.1 },
  };
  resetDetailState(detailedItem(tenthCupSnapshot));
  await act(async () => { detail = create(<FoodDetailScreen />); });
  await press(detail, 'food-detail-minus');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '0.1', 'decreasing a tenth cup cannot jump upward to a quarter cup');
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
  assert.equal(byTestId(detail.root, 'food-detail-off-attribution').props.accessibilityRole, 'link');
  assert.equal(byTestId(detail.root, 'food-detail-off-license').props.accessibilityRole, 'link');
  assert.match(textOf(detail.root), /Open Food Facts.*ODbL 1\.0/, 'required attribution remains outside the removed Source accordion');
  await press(detail, 'food-detail-favorite');
  assert.equal(favoriteCalls[0].food.calories, 75.0375, 'OFF favorite retains unrounded selected root calories');
  assert.equal(favoriteCalls[0].food.protein, 3.675, 'OFF favorite retains unrounded selected protein');

  await act(async () => detail.unmount());
  resetDetailState(rawItem);
  setRecalledDetailItem(rawItem);
  await act(async () => { detail = create(<FoodDetailScreen />); });
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '100', 'recalled baseline weight stays 100 g, not the fresh five-ounce default');
  await press(detail, 'food-detail-select');
  assert.equal(configureCalls[0].item.nutritionSnapshot.selected.unitId, 'gram');
  assert.equal(configureCalls[0].item.nutritionSnapshot.selected.amount, 100);

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