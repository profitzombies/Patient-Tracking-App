import assert from 'node:assert/strict';
import {
  availableNutritionPortions,
  formatNutritionAmount,
  initializeFreshNutritionSnapshot,
  nutritionPortionPresentation,
  nutritionPortionDimension,
  orderedNutritionPortions,
  parseNutritionSnapshot,
  scaledSnapshotMacros,
  selectSnapshotPortion,
  selectSnapshotDisplayedPortion,
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
  'explicit physical conversions (used for type/preparation changes, not the unit picker) do not double-scale',
);

const twoCups = selectSnapshotDisplayedPortion(snapshot, 2, 'cup-cooked')!;
const twoOunces = selectSnapshotDisplayedPortion(twoCups, formatNutritionAmount(twoCups).amount, 'ounce')!;
const twoGrams = selectSnapshotDisplayedPortion(twoOunces, formatNutritionAmount(twoOunces).amount, 'gram')!;
assert.equal(formatNutritionAmount(twoCups).text, '2 cups');
assert.equal(formatNutritionAmount(twoOunces).text, '2 oz');
assert.equal(formatNutritionAmount(twoGrams).text, '2 g', 'Food Details explicit unit choices preserve the number, never the physical amount');
assert.equal(scaledSnapshotMacros(twoCups)!.calories, 230 * 2.7);
assert.equal(scaledSnapshotMacros(twoOunces)!.calories, 230 * 2 * 0.28349523125);
assert.equal(scaledSnapshotMacros(twoGrams)!.calories, 230 * 0.02);
assert.deepEqual(twoGrams.basis, snapshot.basis);
assert.deepEqual(twoGrams.portions, rawPortions, 'unit changes never modify source evidence');

assert.equal(selectSnapshotPortion(snapshot, 0, 'gram'), null, 'zero selections stay invalid');
assert.equal(selectSnapshotPortion(snapshot, 1, 'missing'), null, 'missing units stay invalid');

const greenBeans = parseNutritionSnapshot({
  ...raw,
  source: { ...raw.source, recordId: 'usda-green-beans' },
  portions: [
    raw.portions[0],
    raw.portions[1],
    {
      id: 'ten-beans', label: '10 beans (4" long)', unit: 'bean', dimension: 'count',
      basisMultiplier: 0.55, grams: 55, evidence: 'USDA source amount 10 beans = 55 g',
    },
    {
      id: 'cup-pieces', label: '1 cup 1/2" pieces', unit: 'cup', dimension: 'volume',
      basisMultiplier: 1, grams: 100, evidence: 'USDA source amount 1 cup = 100 g',
    },
  ],
  selected: { amount: 1, unitId: 'ten-beans', scale: 0.55 },
});
assert(greenBeans);
assert.deepEqual(
  formatNutritionAmount(greenBeans),
  { text: '10 beans', amount: 10, unit: 'beans', qualifier: '4" long' },
  'a selected source bundle is one ten-bean bundle, while the inch qualifier stays descriptive',
);
assert.deepEqual(
  orderedNutritionPortions(greenBeans, { preserveSelected: false }).map(portion => portion.id),
  ['ounce', 'cup-pieces', 'gram', 'ten-beans'],
  'green beans prioritize ounces, cups and grams while retaining the awkward bundle under More units',
);
assert.equal(
  initializeFreshNutritionSnapshot(greenBeans, { foodName: 'Vegetable soup' }).selected.unitId,
  'cup-pieces',
  'the pure fresh initializer gives a documented liquid one source volume',
);
assert.equal(
  initializeFreshNutritionSnapshot(greenBeans, { foodName: 'Dried vegetable soup mix' }).selected.unitId,
  'ounce',
  'the pure liquid initializer excludes powders and dried mixes',
);
const oneBean = selectSnapshotDisplayedPortion(greenBeans, 1, 'ten-beans');
assert(oneBean);
assert.equal(oneBean.selected.amount, 0.1, 'one displayed bean is exactly one tenth of the immutable source bundle');
assert(Math.abs(oneBean.selected.scale - 0.055) < 1e-12, 'one bean uses the source multiplier once');
const halfCup = selectSnapshotDisplayedPortion(greenBeans, 0.5, 'cup-pieces');
assert(halfCup);
assert.equal(formatNutritionAmount(halfCup).text, '½ cup');
assert.equal(formatNutritionAmount(halfCup).qualifier, '1/2" pieces', 'an inch fraction never becomes a cup fraction');

const archivedFourOunces = parseNutritionSnapshot({
  ...raw,
  source: { ...raw.source, recordId: 'usda-cottage-cheese' },
  portions: [{
    id: 'source-four-ounce', label: '4 oz', unit: 'oz', dimension: 'weight',
    basisMultiplier: 1.13, grams: 113, evidence: 'USDA source amount 4 oz = 113 g',
  }],
  selected: { amount: 1, unitId: 'source-four-ounce', scale: 1.13 },
});
assert(archivedFourOunces);
assert.equal(nutritionPortionPresentation(archivedFourOunces.portions[0]).sourceAmount, 4);
assert.equal(formatNutritionAmount(archivedFourOunces).text, '4 oz');
assert.equal(archivedFourOunces.portions[0].grams, 113, 'USDA 4 oz = 113 g remains recorded, not recalculated as 113.4 g');
const eightArchivedOunces = selectSnapshotDisplayedPortion(archivedFourOunces, 8, 'source-four-ounce');
assert(eightArchivedOunces);
assert.equal(eightArchivedOunces.selected.amount, 2, 'display editing retains source amount as a multiplier');
assert.equal(eightArchivedOunces.portions[0].grams, 113, 'editing never rewrites archived source grams');

const mixedCup = nutritionPortionPresentation({
  id: 'mixed-cup', label: '1 1/2 cups chopped', unit: 'cup', dimension: 'volume',
  basisMultiplier: 1, grams: 150,
});
assert.equal(mixedCup.sourceAmount, 1.5, 'mixed-number source amounts are parsed before plain integers');
assert.equal(mixedCup.singular, 'cup');
assert.equal(mixedCup.qualifier, 'chopped');
const unicodeHalfCup = nutritionPortionPresentation({
  id: 'unicode-cup', label: '½ cup', unit: 'cup', dimension: 'volume',
  basisMultiplier: 0.5, grams: 50,
});
assert.equal(unicodeHalfCup.sourceAmount, 0.5, 'a leading unicode fraction is a source amount');
const fluidOunce = {
  id: 'fluid-ounce', label: '1 fluid ounce', unit: 'fl oz', dimension: 'weight' as const,
  basisMultiplier: 0.3, grams: 30,
};
assert.equal(nutritionPortionPresentation(fluidOunce).singular, 'fluid ounce');
assert.equal(nutritionPortionPresentation(fluidOunce).shortLabel, 'Fluid ounces');
assert.equal(nutritionPortionDimension(fluidOunce), 'volume', 'fluid ounces remain volume and are never treated as weighed ounces');
const acaiBeverage = parseNutritionSnapshot({
  ...raw,
  source: { ...raw.source, recordId: '173175', canonicalName: 'Beverages, acai berry drink' },
  portions: [raw.portions[0], raw.portions[1], fluidOunce],
  selected: { amount: 100, unitId: 'gram', scale: 1 },
});
assert(acaiBeverage);
assert.equal(
  initializeFreshNutritionSnapshot(acaiBeverage).selected.unitId,
  'fluid-ounce',
  'real Acai-style plural beverage metadata defaults to its raw fluid-ounce source volume',
);
const cubicInch = {
  id: 'cubic-inch', label: '1 cubic inch', unit: 'undetermined', dimension: 'serving' as const,
  basisMultiplier: 0.17, grams: 17, evidence: 'USDA source amount 1 cubic inch',
};
assert.equal(nutritionPortionPresentation(cubicInch).singular, 'cubic inch', 'real singular cubic-inch labels stay intact');
assert.equal(nutritionPortionPresentation(cubicInch).shortLabel, 'Cubic inches');
assert.equal(nutritionPortionDimension(cubicInch), 'volume');
const sourceWing = {
  id: 'wing', label: '1 wing, any size', unit: 'undetermined', dimension: 'serving' as const,
  basisMultiplier: 0.34, grams: 34, evidence: 'USDA source portion',
};
assert.equal(nutritionPortionDimension(sourceWing), 'count', 'documented source serving nouns behave as exact count portions');
assert.equal(nutritionPortionPresentation(sourceWing).qualifier, 'any size');

console.log('food portion visibility checks passed');
