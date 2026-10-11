import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { FOOD_DB, type FoodItem } from '../data/patient-data';
import { isApprovedFood } from '../data/approved-foods';
import {
  applyRememberedFamilyConfigurations,
  boundedLocalResults,
  foodItemToCatalogFood,
  includeBrandedFallback,
  localCatalogMatches,
  mergeCatalogResults,
  useFoodCatalogSearch,
  type FoodCatalogSearchState,
} from '../hooks/useFoodCatalogSearch';
import {
  catalogErrorMessage,
  catalogFoodSnapshot,
  parseCatalogFood,
  parseCatalogSearch,
  preserveSelectedCatalogDraft,
  runAccountGuardedSteps,
} from '../lib/food-catalog';
import {
  defaultSelection,
  buildFoodLogEntry,
  FoodLoggingProvider,
  selectionScale,
  selectionMatchesItemConfiguration,
  selectionDisplayText,
  supportsOunces,
  useFoodLogging,
  getItemNutritionSnapshot,
  foodResultDisplayText,
  initializeFreshItemSnapshot,
  withItemNutritionSnapshot,
  type FoodLoggingContextValue,
} from '../context/FoodLoggingContext';
import { PatientAccountContext, SIGNED_OUT_ACCOUNT_STATE } from '../context/PatientAccountContext';
import { snapshotConfigurationId } from '../data/food-nutrition';

const commonWire = {
  id: 'catalog-rice',
  kind: 'generic',
  name: 'White rice, cooked',
  brand: null,
  serving: '1 cup (158 g)',
  servingGrams: 158,
  calories: 205,
  protein: 4.3,
  carbs: 44.5,
  fat: 0.4,
  measures: [],
  source: 'usda_fdc',
  sourceId: 'fdc-1',
  barcode: null,
  qualityStatus: 'reviewed',
  approvals: [{ id: 'rice', name: 'Rice', portion: '1 cup', phaseGuidance: 'Phase 2' }],
};
const personalWire = {
  ...commonWire,
  id: 'custom:mine',
  kind: 'personal',
  name: 'My rice bowl',
  source: 'patient',
  approvals: [],
};
const brandedWire = {
  ...commonWire,
  id: 'off:0123456789012',
  kind: 'branded',
  name: 'Rice crackers',
  brand: 'Example',
  source: 'openfoodfacts',
  qualityStatus: 'community',
  approvals: [],
};

const parsed = parseCatalogSearch({
  results: [{ ...commonWire, familyKey: 'everyday-rice', familyKeyAliases: [' bulk-rice ', '', 42, 'bulk-rice'] }, personalWire, brandedWire],
  externalUnavailable: true,
  querySuggestions: ['chicken wings', '', 42, 'wing'],
  correctedQuery: 'chicken wings',
});
assert.equal(parsed.common.length, 1);
assert.equal(parsed.personal.length, 1);
assert.equal(parsed.branded.length, 1);
assert.equal(parsed.common[0].sourceLabel, 'USDA FoodData Central');
assert.equal(parsed.personal[0].sourceLabel, 'My Foods');
assert.equal(parsed.personal[0].id, 'mine', 'custom:<id> results normalize to the local custom id');
assert.equal(parsed.branded[0].sourceLabel, 'Open Food Facts');
assert.equal(parsed.common[0].approved, true, 'approval comes only from explicit relationships');
assert.equal(parsed.common[0].servingGrams, 158, 'serving grams survive mobile parsing');
assert.deepEqual(parsed.common[0].familyKeyAliases, ['bulk-rice'], 'family redirect aliases are safely parsed and deduplicated');
assert.equal(parsed.branded[0].approved, false);
assert.equal(parsed.upstreamUnavailable, true, 'local results survive external failure');
assert.deepEqual(parsed.querySuggestions, ['chicken wings', 'wing'], 'mobile safely parses compact query suggestions');
assert.equal(parsed.correctedQuery, 'chicken wings', 'mobile retains a quiet corrected-query hint');
assert.equal(
  catalogErrorMessage(new Error('HTTP 404: <!DOCTYPE html><pre>Cannot GET /api/catalog/search</pre>')),
  'Shared food search is unavailable right now. Please try again.',
  'raw proxy HTML never reaches the patient',
);
assert.equal(
  includeBrandedFallback(false),
  false,
  'basic food search never requests packaged products as filler',
);
assert.equal(
  includeBrandedFallback(false, 'packaged'),
  true,
  'the explicit packaged intent requests packaged products',
);
assert.equal(
  includeBrandedFallback(true),
  false,
  'approved-only search never requests community-sourced branded results',
);

assert.equal(
  parseCatalogFood({ ...brandedWire, calories: undefined }, 'branded'),
  null,
  'incomplete community records never become loggable',
);

// A promoted branded row has a server UUID for diary/favorites but retains the
// original off: lookup id. The private snapshot is therefore enough for
// recents/favorites and Library to resolve after a reload or while offline,
// and it suppresses the matching next network result.
const promoted = { ...parsed.branded[0], id: 'catalog-uuid', catalogId: 'catalog-uuid', lookupId: brandedWire.id };
const offlineSnapshot = catalogFoodSnapshot(promoted);
const offline = localCatalogMatches([offlineSnapshot], new Set(), 'rice', false);
assert.equal(offline.branded[0].id, 'catalog-uuid', 'private selection snapshot reopens offline');
assert.equal(offline.branded[0].sourceLabel, 'Open Food Facts');
assert.equal(
  mergeCatalogResults(offline.branded, parsed.branded).length,
  1,
  'the saved UUID snapshot and off: search result render once',
);
assert.equal(offlineSnapshot.catalogShared, true, 'snapshot is explicitly private catalog state');
assert.equal(offlineSnapshot.catalogServingGrams, 158, 'serving grams persist in the private snapshot');

const ounceWire = parseCatalogFood({
  ...commonWire,
  canonicalName: 'Chicken, broilers or fryers, wing, meat and skin, cooked, roasted',
  name: 'Chicken Wings, Roasted (Meat and Skin)',
  serving: '100 g',
  servingGrams: 100,
  calories: 254,
  protein: 23.8,
  carbs: 0,
  fat: 16.9,
  measures: [{ label: '100 g', grams: 100 }, { label: '1 oz', grams: 28.349523125 }],
}, 'common');
assert.ok(ounceWire);
const ounceItem = {
  refId: ounceWire.catalogId,
  kind: 'food' as const,
  name: ounceWire.name,
  sub: 'Common Foods',
  serving: ounceWire.serving,
  calories: ounceWire.calories,
  protein: ounceWire.protein,
  carbs: ounceWire.carbs,
  fat: ounceWire.fat,
  approved: false,
  catalog: {
    catalogId: ounceWire.catalogId,
    group: ounceWire.group,
    source: ounceWire.source,
    sourceLabel: ounceWire.sourceLabel,
    servingGrams: ounceWire.servingGrams,
    measures: ounceWire.measures,
    canonicalName: ounceWire.canonicalName,
  },
};
assert.equal(supportsOunces(ounceItem), true, 'trusted ounce measure enables weight controls');
assert.equal(defaultSelection(ounceItem).ounces, 5, 'shared generic foods default to five ounces');
assert.ok(Math.abs(selectionScale(defaultSelection(ounceItem)) - 1.41747615625) < 0.000001);
assert.deepEqual(
  buildFoodLogEntry(defaultSelection(ounceItem), { dateKey: '2026-08-22', meal: 'dinner' }),
  {
    dateKey: '2026-08-22',
    meal: 'dinner',
    kind: 'food',
    refId: 'catalog-rice',
    name: 'Chicken Wings, Roasted (Meat and Skin)',
    detail: '5 oz · 142 g',
    quantity: 1.41747615625,
    calories: 360.0389436875,
    protein: 33.73593251875,
    carbs: 0,
    fat: 23.955347040624996,
  },
  'weight logging preserves the chosen ounces and recalculated nutrition as one diary snapshot',
);
assert.match(ounceWire.canonicalName ?? '', /^Chicken, broilers/, 'canonical USDA wording survives friendly labels');

// Exercise the real basket provider: snapshots survive independent search
// result lifetimes, can be configured in detail, and toggle independently.
const riceItem = {
  refId: 'catalog-rice-2',
  kind: 'food' as const,
  name: 'Brown Rice',
  sub: 'Common Foods',
  serving: '1 cup',
  calories: 216,
  protein: 5,
  carbs: 45,
  fat: 1.8,
  approved: true,
};
let basket: FoodLoggingContextValue | undefined;
function BasketProbe() {
  basket = useFoodLogging();
  return null;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
act(() => {
  renderer = create(React.createElement(
    FoodLoggingProvider,
    null,
    React.createElement(BasketProbe),
  ));
});
assert.ok(basket);
act(() => basket!.toggle(ounceItem));
act(() => basket!.toggle(riceItem));
assert.deepEqual(
  basket!.selected.map(entry => entry.item.name),
  ['Chicken Wings, Roasted (Meat and Skin)', 'Brown Rice'],
  'foods accumulated from separate searches remain in one stable basket',
);
assert.equal(basket!.selected[0].ounces, 5);
act(() => basket!.configure(ounceItem, { quantity: 1, ounces: 6 }, basket!.selected[0].basketId));
assert.equal(basket!.selected[0].ounces, 6, 'detail changes update only the configured food');
assert.equal(basket!.selected[1].quantity, 1, 'other selected amounts remain unchanged');
act(() => {
  basket!.remember(ounceItem);
  assert.equal(basket!.recalled(ounceItem.refId)?.name, ounceItem.name, 'detail navigation recall is synchronous');
});
act(() => basket!.toggle(riceItem));
assert.deepEqual(basket!.selected.map(entry => entry.item.refId), [ounceItem.refId]);
act(() => renderer?.unmount());

const exactSnapshot = {
  version: 1 as const,
  source: { provider: 'usda', recordId: 'egg-1', revision: '2026-09' },
  basis: { amount: 100, unit: 'g', label: '100 g', grams: 100 },
  nutrients: [
    { id: '1008', name: 'Energy', unit: 'kcal', amount: 143.125 },
    { id: '1003', name: 'Protein', unit: 'g', amount: 12.56 },
    { id: '1005', name: 'Carbohydrate', unit: 'g', amount: 0.72 },
    { id: '1004', name: 'Total fat', unit: 'g', amount: 9.51 },
  ],
  portions: [{ id: 'large-egg', label: '1 large egg', unit: 'egg', dimension: 'count' as const, basisMultiplier: 0.5, grams: 50 }],
  selected: { amount: 1, unitId: 'large-egg', scale: 0.5 },
  provenance: 'generic_source' as const,
};
const promotedTechnical = {
  ...parsed.common[0],
  id: 'stable-promoted-id',
  catalogId: 'stable-promoted-id',
  name: 'Chicken, broilers or fryers, wing, meat and skin, cooked, roasted',
  familyKey: undefined,
  dimensions: undefined,
  nutritionSnapshot: undefined,
};
const reviewedDraft = {
  ...parsed.common[0],
  id: 'source-wing',
  catalogId: 'source-wing',
  name: 'Chicken Wings',
  familyKey: 'chicken-wings',
  variantSummary: 'Roasted · meat and skin',
  dimensions: { preparation: 'roasted', skin: 'meat and skin' },
  nutritionSnapshot: exactSnapshot,
};
const promotedDraft = preserveSelectedCatalogDraft(reviewedDraft, promotedTechnical);
assert.equal(promotedDraft.catalogId, 'stable-promoted-id', 'promotion adopts only the stable selected identity');
assert.equal(promotedDraft.name, 'Chicken Wings', 'promotion retains the name shown to the patient');
assert.deepEqual(promotedDraft.dimensions, reviewedDraft.dimensions, 'promotion retains exact family dimensions');
assert.equal(promotedDraft.nutritionSnapshot, exactSnapshot, 'promotion retains exact source baseline, units, and selected totals');
const exactEgg = withItemNutritionSnapshot({
  refId: 'egg',
  kind: 'food',
  name: 'Large Egg',
  sub: 'Eggs',
  serving: '1 large egg',
  calories: 143.125,
  protein: 12.56,
  carbs: 0.72,
  fat: 9.51,
  approved: true,
}, exactSnapshot);
assert.equal(getItemNutritionSnapshot(exactEgg)?.selected.scale, 0.5);
assert.deepEqual(
  { quantity: defaultSelection(exactEgg).quantity, ounces: defaultSelection(exactEgg).ounces },
  { quantity: 0.5, ounces: undefined },
  'an exact snapshot keeps its reviewed selected scale and never receives a 1-serving or 5-ounce default',
);
const eggEntry = buildFoodLogEntry(defaultSelection(exactEgg), { dateKey: '2026-08-22', meal: 'breakfast' });
assert.equal(eggEntry.quantity, 0.5);
assert.equal(eggEntry.calories, 71.5625, 'persisted macros retain unrounded source precision');
assert.equal(eggEntry.nutritionSnapshot?.nutrients[0].amount, 143.125, 'logged snapshot retains unrounded original basis');
const editedEggSnapshot = {
  ...exactSnapshot,
  selected: { amount: 2, unitId: 'large-egg', scale: 1 },
};
assert.notEqual(
  snapshotConfigurationId(editedEggSnapshot),
  snapshotConfigurationId(exactSnapshot),
  'changing a cfg amount produces a new exact private configuration id',
);
const reopenedEditedEgg = withItemNutritionSnapshot({
  refId: snapshotConfigurationId(editedEggSnapshot),
  kind: 'food',
  name: 'Large Egg',
  sub: 'Common Foods',
  serving: '1 large egg',
  calories: 143.125,
  protein: 12.56,
  carbs: 0.72,
  fat: 9.51,
  approved: true,
}, editedEggSnapshot);
assert.equal(reopenedEditedEgg.nutritionSnapshot?.selected.amount, 2);
assert.equal(reopenedEditedEgg.calories, 143.125, 'recent cfg reopens with its new amount and matching selected root total');
const offSnapshot = {
  ...exactSnapshot,
  source: { provider: 'openfoodfacts', recordId: '0123456789012', revision: 'panel-1' },
  nutrients: [
    { id: 'energy-kj', name: 'Energy', unit: 'kJ', amount: 418.4 },
    { id: 'proteins', name: 'Proteins', unit: 'g', amount: 10.25 },
    { id: 'carbohydrates', name: 'Carbohydrates', unit: 'g', amount: 20.5 },
    { id: 'fat', name: 'Fat', unit: 'g', amount: 3.75 },
  ],
};
const offItem = withItemNutritionSnapshot({
  refId: 'off:0123456789012',
  kind: 'food',
  name: 'Example Product',
  sub: 'Example',
  serving: '100 g',
  calories: 999,
  protein: 999,
  carbs: 999,
  fat: 999,
  approved: false,
}, offSnapshot);
assert.ok(Math.abs(offItem.calories - 50) < 1e-10);
assert.deepEqual(
  [offItem.protein, offItem.carbs, offItem.fat],
  [5.125, 10.25, 1.875],
  'OFF selected roots derive once from unit-safe snapshot macros rather than stale wire totals',
);

const cooked90Snapshot = {
  version: 1 as const,
  source: { provider: 'usda', recordId: 'beef-90-cooked', revision: '1' },
  basis: { amount: 100, unit: 'g', label: '100 g', grams: 100 },
  nutrients: [
    { id: '1008', name: 'Energy', unit: 'kcal', amount: 230 },
    { id: '1003', name: 'Protein', unit: 'g', amount: 25.1 },
    { id: '1005', name: 'Carbohydrate', unit: 'g', amount: 0 },
    { id: '1004', name: 'Total fat', unit: 'g', amount: 14.2 },
  ],
  portions: [{
    id: 'ounce',
    label: '1 oz',
    unit: 'oz',
    dimension: 'weight' as const,
    basisMultiplier: 28.349523125 / 100,
    grams: 28.349523125,
  }],
  variant: {
    familyKey: 'ground-beef',
    summary: '90% lean · cooked',
    dimensions: { leanness: '90% lean', state: 'cooked' },
  },
  selected: {
    amount: 5.03,
    unitId: 'ounce',
    scale: 5.03 * 28.349523125 / 100,
  },
  provenance: 'generic_source' as const,
};
const liquidSnapshot = {
  ...cooked90Snapshot,
  source: { ...cooked90Snapshot.source, canonicalName: 'Soup, tomato, canned' },
  portions: [
    { id: 'gram', label: 'g', unit: 'g', dimension: 'weight' as const, basisMultiplier: 0.01, grams: 1 },
    { id: 'ounce', label: 'oz', unit: 'oz', dimension: 'weight' as const, basisMultiplier: 0.28349523125, grams: 28.349523125 },
    {
      id: 'cup', label: '1 cup', unit: 'undetermined', dimension: 'serving' as const,
      basisMultiplier: 2.45, grams: 245, evidence: 'USDA source amount 1 cup = 245 g',
    },
  ],
  selected: { amount: 100, unitId: 'gram', scale: 1 },
};
const liquidItem = {
  refId: 'fresh-liquid', kind: 'food' as const, name: 'Tomato soup', sub: 'Common Foods',
  serving: '100 g', calories: 50, protein: 1, carbs: 10, fat: 1, approved: true,
};
assert.equal(
  initializeFreshItemSnapshot(liquidItem, liquidSnapshot).selected.unitId,
  'cup',
  'source metadata and a liquid identity choose one documented volume without a density guess',
);
assert.equal(
  initializeFreshItemSnapshot({ ...liquidItem, name: 'Dried tomato soup mix' }, liquidSnapshot).selected.unitId,
  'ounce',
  'powders and dried liquid mixes remain weighed foods',
);
const initializedLiquid = defaultSelection({ ...liquidItem, nutritionSnapshot: liquidSnapshot });
assert(
  selectionMatchesItemConfiguration(initializedLiquid, { ...liquidItem, nutritionSnapshot: liquidSnapshot }),
  'the original baseline search item matches its initialized basket configuration for toggle/deselect',
);
const cooked90Item = withItemNutritionSnapshot({
  refId: 'cfg-cooked-90',
  kind: 'food',
  name: 'Ground Beef',
  sub: 'Common Foods',
  serving: '100 g',
  calories: 327.805854,
  protein: 0,
  carbs: 0,
  fat: 0,
  approved: true,
}, cooked90Snapshot);
const cookedSelection = { basketId: 'basket-beef', item: cooked90Item, quantity: cooked90Snapshot.selected.scale };
let summaryRenderer: ReactTestRenderer | undefined;
act(() => {
  summaryRenderer = create(React.createElement(
    'basket-summary',
    null,
    selectionDisplayText(cookedSelection),
  ));
});
const renderedSummary = summaryRenderer!.root.findByType('basket-summary').children.join('');
assert.match(renderedSummary, /90% lean · cooked/);
assert.match(renderedSummary, /5\.03 oz/);
assert.match(renderedSummary, /328 cal/);
assert.doesNotMatch(renderedSummary, /467|100 g|1\.4 ×/);
act(() => summaryRenderer?.unmount());
act(() => {
  summaryRenderer = create(React.createElement(
    'favorite-subline',
    null,
    foodResultDisplayText(cooked90Item),
  ));
});
const renderedFavorite = summaryRenderer!.root.findByType('favorite-subline').children.join('');
assert.match(renderedFavorite, /90% lean · cooked/);
assert.match(renderedFavorite, /5\.03 oz/);
assert.doesNotMatch(renderedFavorite, /100 g|327\.805854|467/);
act(() => summaryRenderer?.unmount());

// The provider renders no previous owner's basket on the very first account
// switch render; no effect/timer is required to clear private selections.
let accountState = SIGNED_OUT_ACCOUNT_STATE;
act(() => {
  renderer = create(React.createElement(
    PatientAccountContext.Provider,
    { value: accountState },
    React.createElement(FoodLoggingProvider, null, React.createElement(BasketProbe)),
  ));
});
act(() => basket!.toggle(riceItem));
assert.equal(basket!.selected.length, 1);
accountState = {
  resolving: false,
  account: { kind: 'unresolved' },
  accountNotice: 'Unavailable',
  retryResolve: () => {},
};
act(() => renderer!.update(React.createElement(
  PatientAccountContext.Provider,
  { value: accountState },
  React.createElement(FoodLoggingProvider, null, React.createElement(BasketProbe)),
)));
assert.equal(basket!.selected.length, 0, 'account switch hides the old basket synchronously');
assert.equal(basket!.recalled(riceItem.refId), undefined, 'account switch clears detail recall synchronously');
accountState = SIGNED_OUT_ACCOUNT_STATE;
act(() => renderer!.update(React.createElement(
  PatientAccountContext.Provider,
  { value: accountState },
  React.createElement(FoodLoggingProvider, null, React.createElement(BasketProbe)),
)));
assert.equal(basket!.selected.length, 0, 'switching A → B → A cannot restore A’s destroyed basket');
act(() => renderer?.unmount());

const remembered90 = foodItemToCatalogFood({
  id: 'cfg-90-raw',
  name: 'Ground Beef 90% Lean, Raw',
  serving: '4 oz',
  calories: 200,
  protein: 22,
  carbs: 0,
  fat: 12,
  category: 'Common Foods',
  catalogShared: true,
  nutritionSnapshot: {
    ...exactSnapshot,
    source: { provider: 'usda', recordId: 'beef-90-raw', revision: '1' },
    variant: {
      familyKey: 'ground-beef',
      summary: '90% lean · raw',
      dimensions: { leanness: '90% lean', state: 'raw' },
    },
  },
});
const remembered95 = {
  ...remembered90,
  id: 'cfg-95-cooked',
  catalogId: 'cfg-95-cooked',
  name: 'Ground Beef 95% Lean, Cooked',
  variantSummary: '95% lean · cooked',
  dimensions: { leanness: '95% lean', state: 'cooked' },
  nutritionSnapshot: {
    ...remembered90.nutritionSnapshot!,
    source: { provider: 'usda', recordId: 'beef-95-cooked', revision: '1' },
    variant: {
      familyKey: 'ground-beef',
      summary: '95% lean · cooked',
      dimensions: { leanness: '95% lean', state: 'cooked' },
    },
  },
};
const server90 = {
  ...remembered90,
  id: 'server-90',
  catalogId: 'server-90',
  nutritionSnapshot: undefined,
};
const rememberedLegacyBread = {
  ...remembered90,
  id: 'cfg-legacy-bread-7oz',
  catalogId: 'cfg-legacy-bread-7oz',
  familyKey: 'bulk-whole-wheat-bread',
  name: 'Whole Wheat Bread',
  variantSummary: 'whole wheat',
  dimensions: { grain: 'whole wheat' },
  nutritionSnapshot: {
    ...remembered90.nutritionSnapshot!,
    source: { provider: 'usda', recordId: 'whole-wheat-bread-source', revision: 'source-revision-1' },
    portions: [{
      id: 'ounce',
      label: 'oz',
      unit: 'oz',
      dimension: 'weight' as const,
      basisMultiplier: 0.28349523125,
      grams: 28.349523125,
    }],
    selected: { amount: 7, unitId: 'ounce', scale: 7 * 0.28349523125 },
    variant: {
      familyKey: 'bulk-whole-wheat-bread',
      summary: 'whole wheat',
      dimensions: { grain: 'whole wheat' },
    },
  },
};
const canonicalBreadResult = {
  ...server90,
  id: 'canonical-bread-default',
  catalogId: 'canonical-bread-default',
  familyKey: 'everyday-whole-wheat-bread',
  familyKeyAliases: ['bulk-whole-wheat-bread'],
  name: 'Whole Wheat Bread',
  variantSummary: 'whole wheat',
  dimensions: { grain: 'whole wheat' },
};
const restoredLegacyBread = applyRememberedFamilyConfigurations(
  [canonicalBreadResult],
  [rememberedLegacyBread],
  'whole wheat bread',
)[0];
assert.equal(restoredLegacyBread, rememberedLegacyBread, 'a listed legacy family alias restores the exact remembered configuration');
assert.equal(restoredLegacyBread.nutritionSnapshot?.selected.amount, 7, 'redirect restoration keeps the remembered seven-ounce portion');
assert.deepEqual(
  restoredLegacyBread.nutritionSnapshot?.source,
  rememberedLegacyBread.nutritionSnapshot.source,
  'redirect restoration keeps the immutable source identity',
);
assert.equal(
  snapshotConfigurationId(restoredLegacyBread.nutritionSnapshot!),
  snapshotConfigurationId(rememberedLegacyBread.nutritionSnapshot),
  'redirect restoration keeps the exact configuration id',
);
const unrelatedBreadResult = { ...canonicalBreadResult, familyKeyAliases: ['another-retired-family'] };
assert.equal(
  applyRememberedFamilyConfigurations([unrelatedBreadResult], [rememberedLegacyBread], 'whole wheat bread')[0],
  unrelatedBreadResult,
  'an unrelated family cannot restore a remembered configuration',
);
assert.equal(
  applyRememberedFamilyConfigurations([server90], [remembered95, remembered90], 'ground beef')[0].catalogId,
  'cfg-95-cooked',
  'generic family query restores the most recent exact compatible configuration',
);
assert.equal(
  applyRememberedFamilyConfigurations([server90], [remembered95, remembered90], '90% ground beef raw')[0].catalogId,
  'cfg-90-raw',
  'explicit type constraints are applied before remembered defaults',
);
const wholeMilkResult = {
  ...server90,
  familyKey: 'milk',
  name: 'Milk',
  dimensions: { fat: 'whole' },
  variantSummary: 'whole',
};
const rememberedNonfatMilk = {
  ...remembered90,
  familyKey: 'milk',
  name: 'Milk',
  variantSummary: 'nonfat',
  dimensions: { fat: 'nonfat' },
};
assert.equal(
  applyRememberedFamilyConfigurations([wholeMilkResult], [rememberedNonfatMilk], 'whole milk')[0],
  wholeMilkResult,
  'expanded-family remembered defaults cannot replace an explicit whole-milk constraint',
);
assert.equal(
  applyRememberedFamilyConfigurations(
    [{ ...server90, approved: true }],
    [{ ...remembered90, approved: false }],
    'ground beef',
    true,
  )[0].catalogId,
  'server-90',
  'approved-only search retains the authoritative approved row instead of restoring an ineligible sibling',
);
const custom: FoodItem = {
  id: 'custom:local',
  name: 'Private Rice',
  category: 'My Foods',
  serving: '1 bowl',
  calories: 200,
  protein: 5,
  carbs: 40,
  fat: 2,
};
const offlineRows = boundedLocalResults(localCatalogMatches(
  [{
    ...offlineSnapshot,
    nutritionSnapshot: exactSnapshot,
  }, custom],
  new Set([custom.id]),
  'rice',
  false,
));
assert.ok(offlineRows.length <= 6);
assert.ok(offlineRows.every(row => row.sourceLabel.startsWith('Saved on this device')));

// Real hook flow with a held response: switching accounts aborts and invalidates
// the old generation even when a transport ignores AbortSignal and resolves.
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}
const heldSearches: Array<Deferred<ReturnType<typeof parseCatalogSearch>>> = [];
const heldSearch = () => {
  const next = deferred<ReturnType<typeof parseCatalogSearch>>();
  heldSearches.push(next);
  return next.promise;
};
let searchState: FoodCatalogSearchState | undefined;
function SearchProbe(props: { foods: FoodItem[] }) {
  searchState = useFoodCatalogSearch(props.foods, [], 'rice', false, 'basic', heldSearch);
  return null;
}
async function verifyHeldSearch() {
let guardCurrent = true;
let customSubmitCalls = 0;
const heldCustom = deferred<{ id: string }>();
const customRun = runAccountGuardedSteps(
  () => heldCustom.promise,
  async value => { customSubmitCalls += 1; return value.id; },
  () => guardCurrent,
);
guardCurrent = false;
heldCustom.resolve({ id: 'old-custom' });
assert.equal((await customRun).status, 'stale');
assert.equal(customSubmitCalls, 0, 'held old-account custom-food save cannot continue into submission');

guardCurrent = true;
let promotionSaveCalls = 0;
const heldPromotion = deferred<{ catalogId: string }>();
const promotionRun = runAccountGuardedSteps(
  () => heldPromotion.promise,
  async value => { promotionSaveCalls += 1; return value.catalogId; },
  () => guardCurrent,
);
guardCurrent = false;
heldPromotion.resolve({ catalogId: 'old-promoted-food' });
assert.equal((await promotionRun).status, 'stale');
assert.equal(promotionSaveCalls, 0, 'held old-account promotion cannot save a private configuration');

let searchAccount = SIGNED_OUT_ACCOUNT_STATE;
act(() => {
  renderer = create(React.createElement(
    PatientAccountContext.Provider,
    { value: searchAccount },
    React.createElement(SearchProbe, { foods: [offlineSnapshot] }),
  ));
});
await act(async () => {
  await new Promise(resolve => setTimeout(resolve, 320));
});
assert.equal(heldSearches.length, 1);
searchAccount = {
  resolving: false,
  account: { kind: 'unresolved' },
  accountNotice: 'Unavailable',
  retryResolve: () => {},
};
act(() => {
  renderer!.update(React.createElement(
    PatientAccountContext.Provider,
    { value: searchAccount },
    React.createElement(SearchProbe, { foods: [custom] }),
  ));
});
await act(async () => {
  await new Promise(resolve => setTimeout(resolve, 320));
});
assert.equal(heldSearches.length, 2);
await act(async () => {
  heldSearches[0].resolve(parseCatalogSearch({ results: [commonWire] }));
  await Promise.resolve();
});
assert.ok(
  !(searchState?.results ?? []).some(row => row.catalogId === commonWire.id),
  'held old-account response cannot render after the account switch',
);
await act(async () => {
  heldSearches[1].resolve(parseCatalogSearch({ results: [] }));
  await Promise.resolve();
});
assert.equal(searchState?.remoteAttempted, true);

searchAccount = SIGNED_OUT_ACCOUNT_STATE;
act(() => {
  renderer!.update(React.createElement(
    PatientAccountContext.Provider,
    { value: searchAccount },
    React.createElement(SearchProbe, { foods: [offlineSnapshot] }),
  ));
});
await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)); });
assert.equal(heldSearches.length, 3);
await act(async () => {
  heldSearches[2].resolve({
    ...parseCatalogSearch({ results: [commonWire] }),
    hasMore: true,
    nextCursor: 'page-2',
  });
  await Promise.resolve();
});
act(() => searchState!.showMore());
act(() => searchState!.showMore());
assert.equal(heldSearches.length, 4, 'Show more starts exactly one held page request');
searchAccount = {
  resolving: false,
  account: { kind: 'unresolved' },
  accountNotice: 'Unavailable',
  retryResolve: () => {},
};
act(() => {
  renderer!.update(React.createElement(
    PatientAccountContext.Provider,
    { value: searchAccount },
    React.createElement(SearchProbe, { foods: [custom] }),
  ));
});
await act(async () => {
  heldSearches[3].resolve(parseCatalogSearch({
    results: [{ ...commonWire, id: 'old-account-page', catalogId: 'old-account-page' }],
  }));
  await Promise.resolve();
});
assert.ok(
  !(searchState?.results ?? []).some(row => row.catalogId === 'old-account-page'),
  'held old-account Show more page cannot append after account switch',
);
act(() => renderer?.unmount());
}

const approved = FOOD_DB.find(food => isApprovedFood(food.id));
assert.ok(approved, 'seed library should retain at least one approved compatibility id');
const local = localCatalogMatches(
  [custom, approved],
  new Set([custom.id]),
  approved.name.split(' ')[0],
  false,
);
assert.ok(local.common.some(food => food.id === approved.id), 'legacy seeded foods remain searchable');
const personal = localCatalogMatches([custom], new Set([custom.id]), 'private', false);
assert.equal(personal.personal[0].source, 'personal', 'patient foods stay in the private group');
const remotePersonal = parseCatalogSearch({ results: [{ ...personalWire, id: `custom:${custom.id}`, name: custom.name }] });
assert.equal(
  mergeCatalogResults(personal.personal, remotePersonal.personal).length,
  1,
  'custom:<id> search results merge with the local raw custom id',
);
assert.equal(
  localCatalogMatches([custom], new Set([custom.id]), 'private', true).personal.length,
  0,
  'approved-only never elevates a custom food',
);

verifyHeldSearch().then(() => {
  console.log('food catalog mobile contract checks passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});