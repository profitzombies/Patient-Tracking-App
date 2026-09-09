import assert from 'node:assert/strict';
import {
  availableNutritionPortions,
  parseNutritionSnapshot,
  scaledSnapshotMacros,
  selectSnapshotPortion,
  visibleNutritionPortions,
} from '../data/food-nutrition';

const raw = {
  version: 1,
  source: {
    provider: 'usda',
    recordId: 'beef-real-portions',
    release: 'Foundation',
    revision: 'source-revision',
  },
  basis: { amount: 100, unit: 'g', label: '100 g', grams: 100 },
  nutrients: [
    { id: '1008', name: 'Energy', unit: 'kcal', amount: 230 },
    { id: '1003', name: 'Protein', unit: 'g', amount: 20 },
    { id: '1005', name: 'Carbohydrate, by difference', unit: 'g', amount: 0 },
    { id: '1004', name: 'Total lipid (fat)', unit: 'g', amount: 17 },
  ],
  portions: [
    {
      id: 'gram',
      label: 'grams',
      unit: 'g',
      dimension: 'weight',
      basisMultiplier: 0.01,
      grams: 1,
      evidence: 'USDA 100 g nutrient basis',
    },
    {
      id: 'ounce',
      label: 'ounces',
      unit: 'oz',
      dimension: 'weight',
      basisMultiplier: 0.28349523125,
      grams: 28.349523125,
      evidence: 'Exact avoirdupois conversion from USDA gram basis',
    },
    {
      id: 'cup-cooked',
      label: '1 cup, cooked',
      unit: 'undetermined',
      dimension: 'volume',
      basisMultiplier: 1.35,
      grams: 135,
      evidence: 'USDA portionDescription: 1 cup, cooked',
    },
    {
      id: 'medium-slice',
      label: '1 medium slice',
      unit: 'undetermined',
      dimension: 'count',
      basisMultiplier: 0.6,
      grams: 60,
      evidence: 'USDA portionDescription: 1 medium slice',
    },
    {
      id: 'one-almond',
      label: '1 almond',
      unit: 'almond',
      dimension: 'serving',
      basisMultiplier: 0.012,
      grams: 1.2,
      evidence: 'USDA source amount 1 almond = 1.2 g',
    },
    {
      id: 'pound',
      label: 'pounds',
      unit: 'lb',
      dimension: 'weight',
      basisMultiplier: 4.5359237,
      grams: 453.59237,
      evidence: 'Source weight',
    },
    {
      id: 'unknown',
      label: 'Quantity not specified',
      unit: 'undetermined',
      dimension: 'count',
      basisMultiplier: 1.2,
      grams: 120,
      evidence: 'USDA portionDescription: Quantity not specified',
    },
    {
      id: 'generic-serving',
      label: 'serving',
      unit: 'serving',
      dimension: 'serving',
      basisMultiplier: 1,
      evidence: 'Generic serving without a household measure',
    },
  ],
  selected: { amount: 100, unitId: 'gram', scale: 1 },
  provenance: 'generic_source',
} as const;

const snapshot = parseNutritionSnapshot(raw);
assert(snapshot, 'portion fixture parses');
const rawPortions = structuredClone(snapshot.portions);

assert.deepEqual(
  availableNutritionPortions(snapshot).map(portion => portion.id),
  ['gram', 'ounce', 'cup-cooked', 'medium-slice', 'one-almond'],
  'new choices include meaningful documented source portions even when their source dimension is serving',
);
assert.deepEqual(snapshot.portions, rawPortions, 'filtering never removes or rewrites raw source evidence');
assert.equal(snapshot.portions.length, raw.portions.length, 'the persistent snapshot keeps every raw portion');

const historicalRaw = {
  ...raw,
  selected: { amount: 1, unitId: 'unknown', scale: 1.2 },
} as const;
const historical = parseNutritionSnapshot(historicalRaw);
assert(historical, 'a previously saved vague selection remains valid');
assert.equal(
  availableNutritionPortions(historical).some(portion => portion.id === 'unknown'),
  false,
  'a vague historical unit is not offered for a new configuration',
);
assert.equal(
  visibleNutritionPortions(historical).some(portion => portion.id === 'unknown'),
  true,
  'the currently selected historical unit remains visible',
);
assert.equal(
  visibleNutritionPortions(historical, { preserveSelected: false }).some(
    portion => portion.id === 'unknown',
  ),
  false,
);
assert(selectSnapshotPortion(historical, 2, 'unknown'), 'raw historical unit remains selectable for persistence validation');

const fiveOunces = selectSnapshotPortion(snapshot, 5, 'ounce');
assert(fiveOunces);
assert.equal(
  Math.round(scaledSnapshotMacros(fiveOunces)!.calories),
  326,
  'the exact 5 oz beef display remains 326 calories',
);
const grams = selectSnapshotPortion(
  fiveOunces,
  fiveOunces.selected.scale / snapshot.portions[0].basisMultiplier,
  'gram',
);
assert(grams);
const ouncesAgain = selectSnapshotPortion(
  grams,
  grams.selected.scale / snapshot.portions[1].basisMultiplier,
  'ounce',
);
assert(ouncesAgain);
assert(Math.abs(ouncesAgain.selected.amount - 5) < 1e-12, 'gram/ounce round trips retain the source scale');
assert.deepEqual(
  scaledSnapshotMacros(ouncesAgain),
  scaledSnapshotMacros(fiveOunces),
  'unit round trips do not double-scale root nutrient fields',
);

assert.equal(selectSnapshotPortion(snapshot, 0, 'gram'), null, 'zero selections stay invalid');
assert.equal(selectSnapshotPortion(snapshot, 1, 'missing'), null, 'missing units stay invalid');

console.log('food portion visibility checks passed');