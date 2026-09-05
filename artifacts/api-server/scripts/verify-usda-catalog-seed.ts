import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  USDA_CATALOG_ALIAS_SEED_ROWS,
  USDA_CATALOG_APPROVAL_SEED_ROWS,
  USDA_CATALOG_EXPANDED_SEED_ROWS,
  USDA_CATALOG_SEED_ROWS,
} from '../src/catalog/usda-seed';
import { toTitleCase } from '../src/coach/text-style';

const migrationPath = fileURLToPath(
  new URL('../../../supabase/migrations/20260925100000_seed_usda_catalog.sql', import.meta.url),
);
const committed = readFileSync(migrationPath, 'utf8');
const rendered = execFileSync(
  'pnpm',
  ['exec', 'tsx', 'scripts/render-usda-catalog-seed.ts'],
  {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  },
);
const expansionMigrations = [
  '../../../supabase/migrations/20260925110000_seed_usda_catalog_expansion_1.sql',
  '../../../supabase/migrations/20260925120000_seed_usda_catalog_expansion_2.sql',
];

assert.equal(committed, rendered, 'committed SQL must be regenerated unchanged from shared seed data');
for (const [index, relativePath] of expansionMigrations.entries()) {
  const committedExpansion = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
  const renderedExpansion = execFileSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/render-usda-expanded-catalog-seed.ts', String(index + 1)],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.equal(
    committedExpansion,
    renderedExpansion,
    `committed expansion SQL part ${index + 1} must match its generated source`,
  );
}
assert.equal(USDA_CATALOG_SEED_ROWS.length, 259, 'all reviewed USDA essentials are seeded');
assert.equal(USDA_CATALOG_EXPANDED_SEED_ROWS.length, 5_000, '5,000 additional USDA foods are seeded');
assert.equal(
  new Set([
    ...USDA_CATALOG_SEED_ROWS.map(row => row.source_id),
    ...USDA_CATALOG_EXPANDED_SEED_ROWS.map(row => row.source_id),
  ]).size,
  5_259,
  'expanded source IDs never overlap the reviewed essentials',
);
assert.equal(USDA_CATALOG_APPROVAL_SEED_ROWS.length, 83, 'one conservative canonical link per mapped official item');
assert.ok(USDA_CATALOG_ALIAS_SEED_ROWS.length >= 259, 'each USDA food gets a searchable alias');
assert.equal(
  new Set(USDA_CATALOG_SEED_ROWS.map(row => row.source_id)).size,
  USDA_CATALOG_SEED_ROWS.length,
  'USDA upsert IDs are unique',
);
assert.ok(
  USDA_CATALOG_ALIAS_SEED_ROWS.some(row => row.legacy_id === 'fd_broccoli'),
  'legacy fd_* aliases are actually inserted',
);
const expandedRows = USDA_CATALOG_EXPANDED_SEED_ROWS;
assert.ok(
  expandedRows.every(row =>
    [row.calories, row.protein, row.carbs, row.fat, row.serving_grams]
      .every(value => Number.isFinite(value) && value >= 0) &&
    row.serving_grams > 0
  ),
  'every expanded row has complete nonnegative per-serving macros',
);
assert.ok(
  expandedRows.every(row =>
    row.provenance.provider === 'USDA FoodData Central' &&
    row.provenance.fdcId === row.source_id &&
    typeof row.provenance.sourceDescription === 'string' &&
    row.provenance.sourceDescription.length > 0 &&
    row.provenance.coachVerdict === 'unknown'
  ),
  'every expanded row keeps exact USDA source wording, attribution, and an honest classifier treatment',
);
const fiveOunceGrams = 5 * 28.349523125;
assert.ok(
  expandedRows.every(row =>
    row.provenance.portionPolicy === 'protein_5_oz'
      ? row.serving_label === '5 oz' &&
        Math.abs(row.serving_grams - Number(fiveOunceGrams.toFixed(2))) < 1e-12 &&
        row.provenance.sourcePortionId === null
      : row.provenance.portionPolicy === 'usda_household' &&
        typeof row.provenance.sourcePortionId === 'string' &&
        row.provenance.sourcePortionId.length > 0
  ),
  'protein rows use 5 oz and every other row uses a real USDA household portion',
);
for (const sourceId of ['167607', '167610', '167614']) {
  const food = expandedRows.find(row => row.source_id === sourceId);
  assert.ok(food, `representative category-24 protein ${sourceId} is included`);
  assert.equal(food?.provenance.foodCategoryId, '24');
  assert.equal(food?.provenance.portionPolicy, 'protein_5_oz');
  assert.equal(food?.serving_label, '5 oz');
}
assert.ok(
  expandedRows.every(row => row.name === toTitleCase(row.name)),
  'expanded names match the canonical Title Case helper at the USDA inbound seam',
);
assert.equal(
  createHash('sha256').update(JSON.stringify(expandedRows)).digest('hex'),
  '4f0d05508369dcc7734c16b3b412d34c46b00d0cf5b897bcbc227807037a9041',
  'expanded USDA rows stay deterministic',
);
assert.ok(
  USDA_CATALOG_APPROVAL_SEED_ROWS.every(row => row.official_name && row.constraints.reviewRationale),
  'approval seed preserves official name and reviewer provenance',
);
assert.ok(
  USDA_CATALOG_APPROVAL_SEED_ROWS.some(row => row.official_portion === null && row.phase_guidance === null),
  'source-absent official metadata remains null rather than invented',
);
assert.match(committed, /on conflict \(source, source_id\) do update/i);
assert.match(committed, /on conflict \(catalog_id, approved_food_id\) do update/i);
assert.doesNotMatch(committed, /patient_id|custom_food/i, 'shared seed carries no patient identity or private foods');

console.log(
  `USDA catalog SQL seed verified: ${USDA_CATALOG_SEED_ROWS.length} foods, ` +
  `${USDA_CATALOG_EXPANDED_SEED_ROWS.length} expanded foods, ` +
  `${USDA_CATALOG_ALIAS_SEED_ROWS.length} aliases, ${USDA_CATALOG_APPROVAL_SEED_ROWS.length} links`,
);