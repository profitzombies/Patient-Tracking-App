import assert from 'node:assert/strict';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { NutritionFacts, nutrientDailyValuePercent } from '../components/patient/NutritionFacts';
import { DiaryEntryCalories, DiaryEntryNutritionLine } from '../components/patient/DiaryEntryNutrition';
import { selectSnapshotPortion, snapshotConfigurationId } from '../data/food-nutrition';
import type { FoodNutritionSnapshot } from '../data/food-nutrition';
import type { LoggableItem } from '../hooks/useLoggableItems';
import FoodDetailScreen from '../app/food/[id]';
import {
  configureCalls, favoriteCalls, resetDetailState, route, routerCalls, savedConfigurations,
  selectedCatalogFoods, setDetailAccountKind, setSubmitOutcome, submittedEntries,
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
  let detail!: ReturnType<typeof create>;
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
  await press(detail, 'food-detail-unit-ounce');
  await press(detail, 'food-detail-unit-gram');
  assert.match(textOf(detail.root), /100.5 G/i, 'actual unit controls round-trip without changing physical scale');
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
  const directAdd = byTestId(detail.root, 'food-detail-select').props.onPress;
  await act(async () => {
    await Promise.all([directAdd(), directAdd()]);
    await Promise.resolve();
  });
  assert.equal(selectedCatalogFoods.length, 1, 'rapid repeated taps promote a snapshotless singleton once');
  assert.equal(savedConfigurations.length, 1, 'snapshotless shared singleton gets one private recents lookup copy');
  assert.equal(savedConfigurations[0].id, 'stable-singleton-id');
  assert.equal(savedConfigurations[0].name, 'Friendly Singleton', 'lookup copy retains the shown friendly name');
  assert.equal(submittedEntries.length, 1, 'rapid repeated queued add submits one recoverable queue entry');
  assert.equal(submittedEntries[0].refId, 'stable-singleton-id', 'queued entry resolves through the persisted stable lookup id');
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
  assert.equal(savedConfigurations[0].id, demoBroccoli.refId);
  assert.equal(submittedEntries.length, 1);
  assert.equal(submittedEntries[0].calories, 34, 'guided demo logs the visible 34 calorie, 100 g singleton');
  assert.equal(submittedEntries[0].detail, '100 g');
  assert.match(textOf(detail.root), /Added to Lunch/, 'guided demo receives the normal visible success confirmation');
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
  await press(detail, 'food-detail-unit-ounce');
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
  await press(detail, 'food-detail-unit-gram');
  assert.equal(
    byTestId(detail.root, 'food-detail-amount-input').props.value,
    '198.4467',
    'an unblurred seven ounces shows readable converted grams',
  );
  assert.match(textOf(detail.root), /397CALORIES/, 'the ounce-to-gram conversion preserves pending macro totals');
  await press(detail, 'food-detail-select');
  assert(closeTo(configureCalls[0].item.nutritionSnapshot.selected.amount, 198.446661875));
  assert(closeTo(configureCalls[0].item.calories, 200.125 * 1.98446661875), 'final save preserves converted exact macro totals');
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
  await press(detail, 'food-detail-unit-gram');
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
  };
  resetDetailState(detailedItem(beanSnapshot));
  await act(async () => { detail = create(<FoodDetailScreen />); });
  assert.match(textOf(detail.root), /OuncesCupsGramsMore units/, 'green-bean primary controls stay compact and useful');
  await press(detail, 'food-detail-more-units');
  assert.match(
    textOf(byTestId(detail.root, 'food-detail-source-measure-ten-beans')),
    /Source measure: 10 beans \(4" long\) = 55 g/,
    'More units keeps the original ten-bean source bundle visible without changing one-bean editing',
  );
  await press(detail, 'food-detail-unit-cup-pieces');
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '1', 'choosing cups intentionally starts at one cup');
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
  assert.match(textOf(detail.root), /NUTRITION · 2 DRUMETTES111CALORIES/, 'valid unblurred input previews matching amount and nutrition');
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('2.');
  });
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '2.', 'editable decimal text is not normalized while typing');
  await act(async () => {
    byTestId(detail.root, 'food-detail-amount-input').props.onChangeText('2.5');
  });
  assert.equal(byTestId(detail.root, 'food-detail-amount-input').props.value, '2.5');
  assert.match(textOf(detail.root), /NUTRITION · 2.5 DRUMETTES139CALORIES/, 'fractional valid text previews exact nutrition before blur');
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