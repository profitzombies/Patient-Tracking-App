import assert from 'node:assert/strict';
import {
  parseNutritionSnapshot,
  rescaleSnapshotSelection,
  scaledSnapshotNutrients,
  scaledSnapshotMacros,
  selectSnapshotPortion,
  snapshotConfigurationKey,
  snapshotConfigurationId,
} from '../data/food-nutrition';

const raw = {
  version: 1,
  source: {
    provider: 'usda',
    recordId: '171077',
    release: 'foundation-2026',
    revision: 'sha256:exact',
  },
  basis: { amount: 100, unit: 'g', label: '100 g', grams: 100 },
  nutrients: [
    { id: 'energy', name: 'Energy', unit: 'kcal', amount: 155.123456 },
    { id: 'fiber', name: 'Dietary Fiber', unit: 'g', amount: 0 },
  ],
  portions: [
    {
      id: 'gram',
      label: 'gram',
      unit: 'g',
      dimension: 'weight',
      basisMultiplier: 0.01,
      grams: 1,
      evidence: 'USDA weight basis',
    },
  ],
  selected: { amount: 100, unitId: 'gram', scale: 1 },
  provenance: 'generic_source',
} as const;

const snapshot = parseNutritionSnapshot(raw);
assert(snapshot, 'valid exact baseline parses');
const half = selectSnapshotPortion(snapshot, 50, 'gram');
assert(half, 'supported portion selection succeeds');
assert.equal(scaledSnapshotNutrients(half)[0].amount, 77.561728);
assert.equal(scaledSnapshotNutrients(half)[1].amount, 0, 'an actual zero remains present');

const repeated = rescaleSnapshotSelection(half, 2);
assert(repeated);
assert.equal(repeated.selected.scale, 1);
assert.deepEqual(
  scaledSnapshotNutrients(repeated),
  scaledSnapshotNutrients(snapshot),
  'repeated edits return to the original unrounded baseline',
);
assert.equal(snapshotConfigurationKey(snapshot), snapshotConfigurationKey(repeated));
assert.equal(snapshotConfigurationId(snapshot), snapshotConfigurationId(repeated));
assert.match(snapshotConfigurationId(snapshot), /^cfg_[a-z0-9]+_[a-z0-9]+$/);

assert.equal(
  parseNutritionSnapshot({ ...raw, selected: { amount: 0, unitId: 'gram', scale: 0 } }),
  null,
  'zero selected amounts are rejected',
);
assert.equal(
  parseNutritionSnapshot({ ...raw, selected: { amount: 50, unitId: 'gram', scale: 1 } }),
  null,
  'a dishonest selected scale is rejected',
);
assert.equal(
  parseNutritionSnapshot({ ...raw, nutrients: [raw.nutrients[0], raw.nutrients[0]] }),
  null,
  'duplicate nutrient ids are rejected rather than summed',
);
assert.equal(
  parseNutritionSnapshot({ ...raw, nutrients: [{ ...raw.nutrients[0], amount: Number.NaN }] }),
  null,
  'non-finite amounts are rejected',
);
assert.equal(parseNutritionSnapshot(null), null, 'null is not a supplied snapshot');

function macroFixture(
  provider: string,
  nutrients: Array<{ id: string; name: string; unit: string; amount: number }>,
) {
  return parseNutritionSnapshot({
    ...raw,
    source: { provider, recordId: `${provider}-macro`, revision: 'exact' },
    nutrients,
    selected: { amount: 30, unitId: 'gram', scale: 0.3 },
  });
}

const off = macroFixture('open_food_facts', [
  // Both records are common in OFF payloads. kcal must win, not whichever
  // duplicate energy record happened to arrive last.
  { id: 'off:energy', name: 'Energy', unit: 'kJ', amount: 418.4 },
  { id: 'off:energy-kcal', name: 'Energy', unit: 'kcal', amount: 100 },
  { id: 'off:proteins', name: 'Protein', unit: 'g', amount: 100 },
  { id: 'off:carbohydrates', name: 'Carbohydrate, by difference', unit: 'mg', amount: 100_000 },
  { id: 'off:fat', name: 'Total lipid (fat)', unit: 'g', amount: 100 },
]);
assert(off);
assert.deepEqual(
  scaledSnapshotMacros(off),
  { calories: 30, protein: 30, carbs: 30, fat: 30 },
  'OFF 100 g facts decode to exact selected 30 g totals with unit conversion',
);

const label = macroFixture('personal_label', [
  { id: 'energy', name: 'Calories', unit: 'kcal', amount: 210.25 },
  { id: 'protein', name: 'Protein', unit: 'g', amount: 20.5 },
  { id: 'carbohydrate', name: 'Total Carbohydrate', unit: 'g', amount: 12.25 },
  { id: 'fat', name: 'Total Fat', unit: 'g', amount: 8.75 },
]);
assert(label);
assert.deepEqual(
  scaledSnapshotMacros(label),
  { calories: 63.074999999999996, protein: 6.1499999999999995, carbs: 3.675, fat: 2.625 },
  'personal-label IDs retain unrounded selected totals',
);

const usda = macroFixture('usda', [
  { id: '1008', name: 'Energy', unit: 'kJ', amount: 418.4 },
  { id: '1003', name: 'Protein', unit: 'mg', amount: 100_000 },
  { id: '1005', name: 'Carbohydrate, by difference', unit: 'g', amount: 100 },
  { id: '1004', name: 'Total lipid (fat)', unit: 'g', amount: 100 },
]);
assert(usda);
const usdaMacros = scaledSnapshotMacros(usda);
assert(usdaMacros);
assert(Math.abs(usdaMacros.calories - 30) < 1e-12, 'USDA kJ converts to 30 selected kcal');
assert.deepEqual(
  { protein: usdaMacros.protein, carbs: usdaMacros.carbs, fat: usdaMacros.fat },
  { protein: 30, carbs: 30, fat: 30 },
  'USDA IDs decode mg and g while retaining selected totals',
);

console.log('food nutrition snapshot checks passed');