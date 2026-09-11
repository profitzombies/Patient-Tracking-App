import assert from 'node:assert/strict';
import { FOOD_DB } from '../data/patient-data';
import {
  availableNutritionPortions,
  formatNutritionAmount,
  scaledSnapshotMacros,
} from '../data/food-nutrition';
import { createLegacyFoodDetailSnapshot } from '../data/food-detail-amount';
import type { LoggableItem } from '../hooks/useLoggableItems';

function seeded(id: string): LoggableItem {
  const food = FOOD_DB.find(candidate => candidate.id === id);
  assert(food, `missing seed ${id}`);
  return {
    ...food,
    kind: 'food',
    refId: food.id,
    sub: food.category,
    approved: true,
  };
}

function catalogItem(overrides: Partial<LoggableItem> = {}): LoggableItem {
  return {
    ...seeded('fd_brown_rice'),
    refId: 'catalog-rice',
    name: 'Catalog rice',
    serving: '1 cup',
    catalog: {
      catalogId: 'catalog-rice',
      group: 'common',
      source: 'usda',
      sourceLabel: 'USDA FoodData Central',
      measures: [],
    },
    ...overrides,
  };
}

const brownRice = createLegacyFoodDetailSnapshot(seeded('fd_brown_rice'));
assert(brownRice, 'Brown Rice receives a legacy snapshot');
assert.equal(brownRice.basis.amount, 1);
assert.equal(brownRice.basis.unit, 'cup');
assert.equal(brownRice.basis.grams, 195, 'Brown Rice uses the food-specific USDA cup weight');
assert.match(
  brownRice.portions[0].evidence ?? '',
  /USDA FoodData Central SR Legacy FDC 168875/,
);
assert.match(
  brownRice.portions[0].evidence ?? '',
  /https:\/\/fdc\.nal\.usda\.gov\/food-details\/168875\/nutrients/,
);
assert.deepEqual(
  brownRice.portions.map(portion => portion.id),
  ['legacy-source', 'ounce', 'gram'],
  'Brown Rice exposes only its documented source, ounce, and gram portions',
);
assert.equal(formatNutritionAmount(brownRice).text, '1 cup');
assert.deepEqual(scaledSnapshotMacros(brownRice), {
  calories: 216, protein: 5, carbs: 45, fat: 2,
});
assert.deepEqual(
  createLegacyFoodDetailSnapshot({ ...seeded('fd_brown_rice'), nutritionSnapshot: brownRice }),
  brownRice,
  'an existing snapshot is returned without changing its source or selection',
);
const twoCups = createLegacyFoodDetailSnapshot(seeded('fd_brown_rice'), { quantity: 2 });
assert(twoCups);
assert.equal(formatNutritionAmount(twoCups).text, '2 cups');
assert.equal(scaledSnapshotMacros(twoCups)?.calories, 432);

const common = createLegacyFoodDetailSnapshot(catalogItem());
assert(common, 'snapshotless common catalog rows receive normalized controls');
assert.equal(common.source.provider, 'USDA FoodData Central');
assert.equal(common.source.recordId, 'catalog-rice');

const branded = createLegacyFoodDetailSnapshot(catalogItem({
  refId: 'catalog-bar',
  name: 'Branded bar',
  serving: '1 bar',
  catalog: {
    catalogId: 'catalog-bar',
    group: 'branded',
    source: 'openfoodfacts',
    sourceLabel: 'Open Food Facts',
    measures: [],
  },
}));
assert(branded, 'snapshotless branded catalog rows receive normalized controls');
assert.equal(branded.source.provider, 'Open Food Facts');
assert.equal(branded.provenance, 'identified_product');

const recordedFourOunces = createLegacyFoodDetailSnapshot(catalogItem({
  refId: 'personal-four-ounces',
  name: 'Recorded four ounces',
  serving: '4 oz',
  catalog: {
    catalogId: 'personal-four-ounces',
    group: 'personal',
    source: 'personal',
    sourceLabel: 'My Foods',
    servingGrams: 113,
    measures: [{ label: '4 oz', grams: 113 }],
  },
}), { quantity: 1, ounces: 2 });
assert(recordedFourOunces);
assert.equal(recordedFourOunces.basis.grams, 113, 'recorded serving grams beat calculated 4 oz conversion');
assert.equal(formatNutritionAmount(recordedFourOunces).text, '2 oz', 'stored ounces preserve the displayed ounce amount');
assert.equal(recordedFourOunces.selected.scale, 0.5);

const measuredFourOunces = createLegacyFoodDetailSnapshot(catalogItem({
  refId: 'personal-measured-four-ounces',
  name: 'Measured four ounces',
  serving: '4 oz',
  catalog: {
    catalogId: 'personal-measured-four-ounces',
    group: 'personal',
    source: 'personal',
    sourceLabel: 'My Foods',
    measures: [{ label: '4 oz', grams: 113 }],
  },
}));
assert(measuredFourOunces);
assert.equal(measuredFourOunces.basis.grams, 113, 'an exact matching measure beats calculated weight');

const custom = createLegacyFoodDetailSnapshot(catalogItem({
  refId: 'custom-serving',
  name: 'Family recipe',
  serving: '1 serving',
  catalog: {
    catalogId: 'custom-serving',
    group: 'personal',
    source: 'personal',
    sourceLabel: 'My Foods',
    measures: [],
  },
}));
assert(custom);
assert.equal(availableNutritionPortions(custom).length, 0, 'undocumented custom servings gain no fabricated units');

assert.equal(createLegacyFoodDetailSnapshot({
  ...seeded('fd_brown_rice'),
  kind: 'recipe',
}), null, 'non-food rows do not enter the adapter');

console.log('food detail amount adapter checks passed');