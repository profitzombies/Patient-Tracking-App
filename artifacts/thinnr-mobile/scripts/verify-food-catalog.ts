import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { FOOD_DB, type FoodItem } from '../data/patient-data';
import { isApprovedFood } from '../data/approved-foods';
import {
  includeBrandedFallback,
  localCatalogMatches,
  mergeCatalogResults,
} from '../hooks/useFoodCatalogSearch';
import {
  catalogErrorMessage,
  catalogFoodSnapshot,
  parseCatalogFood,
  parseCatalogSearch,
} from '../lib/food-catalog';
import {
  defaultSelection,
  buildFoodLogEntry,
  FoodLoggingProvider,
  selectionScale,
  supportsOunces,
  useFoodLogging,
  type FoodLoggingContextValue,
} from '../context/FoodLoggingContext';

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
  results: [commonWire, personalWire, brandedWire],
  externalUnavailable: true,
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
assert.equal(parsed.branded[0].approved, false);
assert.equal(parsed.upstreamUnavailable, true, 'local results survive external failure');
assert.equal(
  catalogErrorMessage(new Error('HTTP 404: <!DOCTYPE html><pre>Cannot GET /api/catalog/search</pre>')),
  'Shared food search is unavailable right now. Please try again.',
  'raw proxy HTML never reaches the patient',
);
assert.equal(
  includeBrandedFallback(false),
  true,
  'normal mobile search requests the server-guarded branded fallback',
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
    calories: 360,
    protein: 34,
    carbs: 0,
    fat: 24,
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
act(() => basket!.configure(ounceItem, { quantity: 1, ounces: 6 }));
assert.equal(basket!.selected[0].ounces, 6, 'detail changes update only the configured food');
assert.equal(basket!.selected[1].quantity, 1, 'other selected amounts remain unchanged');
act(() => {
  basket!.remember(ounceItem);
  assert.equal(basket!.recalled(ounceItem.refId)?.name, ounceItem.name, 'detail navigation recall is synchronous');
});
act(() => basket!.toggle(riceItem));
assert.deepEqual(basket!.selected.map(entry => entry.item.refId), [ounceItem.refId]);
act(() => renderer?.unmount());

const approved = FOOD_DB.find(food => isApprovedFood(food.id));
assert.ok(approved, 'seed library should retain at least one approved compatibility id');
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

console.log('food catalog mobile contract checks passed');