import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  USDA_CATALOG_ALIAS_SEED_ROWS,
  USDA_CATALOG_APPROVAL_SEED_ROWS,
  USDA_CATALOG_SEED_ROWS,
} from '../src/catalog/usda-seed';

const migrationPath = fileURLToPath(
  new URL('../../../supabase/migrations/20260925100000_seed_usda_catalog.sql', import.meta.url),
);
const committed = readFileSync(migrationPath, 'utf8');
const rendered = execFileSync(
  'pnpm',
  ['exec', 'tsx', 'scripts/render-usda-catalog-seed.ts'],
  { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
);

assert.equal(committed, rendered, 'committed SQL must be regenerated unchanged from shared seed data');
assert.equal(USDA_CATALOG_SEED_ROWS.length, 259, 'all reviewed USDA foods are seeded');
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
  `${USDA_CATALOG_ALIAS_SEED_ROWS.length} aliases, ${USDA_CATALOG_APPROVAL_SEED_ROWS.length} links`,
);