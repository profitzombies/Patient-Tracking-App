import { createHash } from 'node:crypto';

import {
  APPROVED_CATALOG_REVIEW,
  LEGACY_FOOD_CATALOG_ALIAS,
  approvedItemIdsForCatalogFood,
  catalogFoodIdForLegacyId,
} from '../data/catalog-cross-reference';
import { APPROVED_ITEMS } from '../data/approved-foods';
import { FOOD_DB } from '../data/patient-data';
import { USDA_ESSENTIALS } from '../data/usda-essentials';

let checks = 0;
let failures = 0;
function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${label}`);
  }
}

assert('several hundred reviewed essentials', USDA_ESSENTIALS.length >= 250);
assert('seed count is pinned', USDA_ESSENTIALS.length === 259);
assert('USDA IDs are unique', new Set(USDA_ESSENTIALS.map(food => food.id)).size === USDA_ESSENTIALS.length);

for (const food of USDA_ESSENTIALS) {
  assert(`${food.id}: normalized 100 g basis`, food.basisGrams === 100);
  assert(`${food.id}: stable source id`, food.id === `usda_${food.provenance.fdcId}`);
  assert(`${food.id}: reviewed provenance`, food.quality === 'reviewed' && food.provenance.provider === 'USDA FoodData Central');
  assert(`${food.id}: searchable alias`, food.aliases.length > 0 && food.aliases.every(Boolean));
  assert(`${food.id}: exact 100 g measure`, food.measures.some(m => m.label === '100 g' && m.grams === 100));
  assert(
    `${food.id}: exact ounce measure`,
    food.measures.some(m => m.label === '1 oz' && Math.abs(m.grams - 28.349523125) < 1e-12),
  );
  const n = food.nutrients;
  assert(
    `${food.id}: finite nonnegative macros`,
    [n.calories, n.proteinGrams, n.carbohydrateGrams, n.fatGrams]
      .every(value => Number.isFinite(value) && value >= 0),
  );
  // Broad corruption tripwires, not nutritional judgments.
  assert(`${food.id}: plausible energy`, n.calories <= 950);
  assert(`${food.id}: plausible macro mass`, n.proteinGrams <= 100 && n.carbohydrateGrams <= 100 && n.fatGrams <= 100);
}

const approvedIds = new Set(APPROVED_ITEMS.map(item => item.id));
assert('one review outcome per official item', APPROVED_CATALOG_REVIEW.length === APPROVED_ITEMS.length);
assert(
  'approved review IDs exactly cover official IDs',
  APPROVED_CATALOG_REVIEW.every(review => approvedIds.has(review.approvedItemId)) &&
    new Set(APPROVED_CATALOG_REVIEW.map(review => review.approvedItemId)).size === approvedIds.size,
);
for (const review of APPROVED_CATALOG_REVIEW) {
  assert(
    `${review.approvedItemId}: mapping disposition is honest`,
    review.status === 'mapped' ? review.catalogIds.length > 0 : review.catalogIds.length === 0,
  );
}

assert('custom ID cannot gain badge', approvedItemIdsForCatalogFood('custom_patient_food').length === 0);
assert('unknown ID cannot gain badge', approvedItemIdsForCatalogFood('usda_not_real').length === 0);
assert('legacy-looking ID cannot gain badge', approvedItemIdsForCatalogFood('fd_broccoli').length === 0);

const legacyIds = FOOD_DB.map(food => food.id);
assert(
  'every legacy fd_* ID has an explicit compatibility disposition',
  legacyIds.every(id => Object.prototype.hasOwnProperty.call(LEGACY_FOOD_CATALOG_ALIAS, id)),
);
for (const id of legacyIds) {
  const alias = LEGACY_FOOD_CATALOG_ALIAS[id];
  assert(`${id}: supported alias resolves or is explicitly null`, alias === null || catalogFoodIdForLegacyId(id) !== undefined);
}

const digest = createHash('sha256').update(JSON.stringify(USDA_ESSENTIALS)).digest('hex');
// Pinning catches source edits, reordering, and normalization drift.
assert(
  `reproducible seed digest (${digest})`,
  digest === '2297483c4a9761f1ca6ab2721ae85061b1ab472d3096af76fe96516534c2473b',
);

if (failures > 0) {
  console.error(`\n✗ USDA essentials check: ${failures} failure(s) across ${checks} checks`);
  process.exit(1);
}
console.log(`✓ USDA essentials check: ${checks} checks passed`);
console.log(`  ${USDA_ESSENTIALS.length} USDA rows; ${APPROVED_CATALOG_REVIEW.filter(r => r.status === 'mapped').length}/${APPROVED_ITEMS.length} official items mapped`);