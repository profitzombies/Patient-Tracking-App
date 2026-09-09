import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { managementQuery } from '../../api-server/scripts/usda-source/import.mjs';
import {
  parseNutritionSnapshot,
  scaledSnapshotMacros,
} from '../data/food-nutrition';

type SourceNutrient = {
  id?: unknown;
  name?: unknown;
  unit?: unknown;
  amount?: unknown;
};

type SourcePortion = {
  ordinal: number;
  amount?: unknown;
  modifier?: unknown;
  portionDescription?: unknown;
  measureUnit?: unknown;
  gramWeight?: unknown;
};

type ContractRow = {
  familyKey: string;
  catalogId: string;
  sourceId: string;
  snapshot: unknown;
  nutrients: SourceNutrient[];
  portions: SourcePortion[];
};

type LiteralPortionFixture = {
  fdcId: number;
  amount: number;
  modifier: string;
  gramWeight: number;
};

const { values } = parseArgs({
  options: { project: { type: 'string' } },
});
if (!/^[a-z0-9]+$/.test(values.project ?? '')) {
  throw new Error('Usage: tsx scripts/verify-everyday-snapshot-contracts.ts --project <confirmed-project-ref>');
}

async function main(): Promise<void> {
const manifest = JSON.parse(await readFile(resolve(
  __dirname,
  '../../../docs/food-library-cleanup/everyday-food-identities-v3.json',
), 'utf8')) as { sourceIds: number[] };
const cottageFixture = JSON.parse(await readFile(resolve(
  __dirname,
  'fixtures/usda-cottage-cheese-portion.json',
), 'utf8')) as LiteralPortionFixture;
assert(manifest.sourceIds.includes(cottageFixture.fdcId), 'literal USDA fixture belongs to the reviewed everyday set');

const query = managementQuery(values.project!);
const rows: ContractRow[] = [];
const pageSize = 20;
for (let offset = 0; ; offset += pageSize) {
  const page = await query(`
    select coalesce(jsonb_agg(jsonb_build_object(
      'familyKey',x.family_key,
      'catalogId',x.catalog_id,
      'sourceId',x.source_id,
      'snapshot',x.snapshot,
      'nutrients',x.nutrients,
      'portions',x.portions
    ) order by x.family_key,x.common_order,x.catalog_id),'[]'::jsonb) result
    from (
      select fam.family_key,v.common_order,c.id::text catalog_id,c.source_id,
        v.nutrition_snapshot snapshot,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',n->'nutrient'->>'id',
            'name',n->'nutrient'->>'name',
            'unit',n->'nutrient'->>'unitName',
            'amount',n->'amount'
          ) order by ord)
          from jsonb_array_elements(coalesce(s.raw_food->'foodNutrients','[]'::jsonb))
            with ordinality source_nutrient(n,ord)
        ),'[]'::jsonb) nutrients,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'ordinal',ord,
            'amount',p->'amount',
            'modifier',p->'modifier',
            'portionDescription',p->'portionDescription',
            'measureUnit',p->'measureUnit',
            'gramWeight',p->'gramWeight'
          ) order by ord)
          from jsonb_array_elements(coalesce(s.raw_food->'foodPortions','[]'::jsonb))
            with ordinality source_portion(p,ord)
        ),'[]'::jsonb) portions
      from food_catalog_family_variants v
      join food_catalog_families fam using(family_key)
      join food_catalog_items c on c.id=v.catalog_id
      join food_catalog_curation cur on cur.catalog_id=c.id
        and cur.eligibility='reviewed_family'
      join usda_source_foods s on s.fdc_id=c.source_id::bigint
        and s.release_id=v.nutrition_snapshot->'source'->>'release'
      where fam.family_key like 'everyday-%'
      order by fam.family_key,v.common_order,c.id
      limit ${pageSize} offset ${offset}
    ) x
  `) as ContractRow[];
  rows.push(...page);
  if (page.length < pageSize) break;
}

assert(rows.length >= 100, `expected all reviewed everyday variants, found ${rows.length}`);
assert.equal(
  new Set(rows.map(row => row.catalogId)).size,
  rows.length,
  'every reviewed everyday variant appears exactly once',
);
for (const sourceId of manifest.sourceIds) {
  assert(rows.some(row => Number(row.sourceId) === sourceId), `reviewed source ${sourceId} has a consumer snapshot`);
}

function sourceText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function usableSourceLabel(portion: SourcePortion): string | undefined {
  const description = sourceText(portion.portionDescription);
  const modifier = sourceText(portion.modifier);
  const measure = typeof portion.measureUnit === 'object' && portion.measureUnit !== null
    ? sourceText((portion.measureUnit as { name?: unknown }).name)
    : undefined;
  const descriptor = description ?? modifier ?? measure;
  if (!descriptor || /^(?:quantity|amount)\s+not\s+specified$/i.test(descriptor)) return undefined;
  return descriptor;
}

function numberText(value: number): string {
  return Number(value).toString();
}

function assertEvidenceContains(
  evidence: string,
  value: string,
  context: string,
): void {
  assert(
    evidence.toLocaleLowerCase().includes(value.toLocaleLowerCase()),
    `${context}: evidence must retain source value "${value}"`,
  );
}

let numericNutrients = 0;
let sourcePortions = 0;
let sourceZeros = 0;
let sourceMissingAmounts = 0;
for (const row of rows) {
  const context = `${row.familyKey}/${row.sourceId}`;
  const snapshot = parseNutritionSnapshot(row.snapshot);
  assert(snapshot, `${context}: actual API snapshot must pass the mobile parser`);
  assert.equal(
    snapshot.selected.scale,
    snapshot.selected.amount * (
      snapshot.portions.find(portion => portion.id === snapshot.selected.unitId)?.basisMultiplier ?? Number.NaN
    ),
    `${context}: selected scale is exact`,
  );

  const expectedNutrients = new Map<string, SourceNutrient>();
  const idsWithoutNumericAmount = new Set<string>();
  for (const nutrient of row.nutrients) {
    const id = sourceText(nutrient.id);
    if (!id) continue;
    if (typeof nutrient.amount === 'number' && Number.isFinite(nutrient.amount)) {
      if (!expectedNutrients.has(id)) expectedNutrients.set(id, nutrient);
      numericNutrients += 1;
      if (nutrient.amount === 0) sourceZeros += 1;
    } else {
      idsWithoutNumericAmount.add(id);
      sourceMissingAmounts += 1;
    }
  }
  assert.equal(snapshot.nutrients.length, expectedNutrients.size, `${context}: numeric source nutrients are neither lost nor invented`);
  for (const [id, source] of expectedNutrients) {
    const actual = snapshot.nutrients.find(nutrient => nutrient.id === id);
    assert(actual, `${context}: numeric nutrient ${id} is preserved`);
    assert.equal(actual.amount, source.amount, `${context}: nutrient ${id} amount is exact, including zero`);
    assert.equal(actual.name, source.name, `${context}: nutrient ${id} name is source-exact`);
    assert.equal(actual.unit, source.unit, `${context}: nutrient ${id} unit is source-exact`);
  }
  for (const id of idsWithoutNumericAmount) {
    if (!expectedNutrients.has(id)) {
      assert(!snapshot.nutrients.some(nutrient => nutrient.id === id), `${context}: missing nutrient ${id} was not fabricated as zero`);
    }
  }

  const expectedPortionIds = new Set(['g', 'oz']);
  for (const source of row.portions) {
    const label = usableSourceLabel(source);
    if (
      !label ||
      typeof source.gramWeight !== 'number' ||
      !Number.isFinite(source.gramWeight) ||
      source.gramWeight <= 0
    ) continue;
    sourcePortions += 1;
    const id = `usda-portion-${source.ordinal}`;
    expectedPortionIds.add(id);
    const actual = snapshot.portions.find(portion => portion.id === id);
    assert(actual, `${context}: source portion ${source.ordinal} is preserved`);
    assert.equal(actual.grams, source.gramWeight, `${context}: portion ${source.ordinal} gramWeight is exact`);
    assert(
      Math.abs(actual.basisMultiplier - source.gramWeight / 100) <= 1e-12,
      `${context}: portion ${source.ordinal} scale uses gramWeight`,
    );
    assert(actual.evidence, `${context}: portion ${source.ordinal} keeps readable source evidence`);
    assertEvidenceContains(actual.evidence!, numberText(source.gramWeight), `${context}: portion ${source.ordinal}`);
    if (typeof source.amount === 'number' && Number.isFinite(source.amount)) {
      assertEvidenceContains(actual.evidence!, numberText(source.amount), `${context}: portion ${source.ordinal}`);
      assertEvidenceContains(actual.label, numberText(source.amount), `${context}: portion ${source.ordinal} label`);
    }
    const modifier = sourceText(source.modifier);
    if (modifier) {
      assertEvidenceContains(actual.evidence!, modifier, `${context}: portion ${source.ordinal}`);
      assertEvidenceContains(actual.label, modifier, `${context}: portion ${source.ordinal} label`);
    } else {
      assertEvidenceContains(actual.label, label, `${context}: portion ${source.ordinal} label`);
    }
  }
  assert.deepEqual(
    new Set(snapshot.portions.map(portion => portion.id)),
    expectedPortionIds,
    `${context}: generated portions exactly match grams, ounces, and usable source portions`,
  );

  const macros = scaledSnapshotMacros(snapshot);
  assert(macros, `${context}: source macro nutrients are consumable`);
  for (const [field, nutrientId] of [
    ['calories', '1008'],
    ['protein', '1003'],
    ['carbs', '1005'],
    ['fat', '1004'],
  ] as const) {
    assert.equal(
      macros[field],
      expectedNutrients.get(nutrientId)?.amount,
      `${context}: root ${field} remains the selected total without double scaling`,
    );
  }
}

const cottage = rows.find(row => Number(row.sourceId) === cottageFixture.fdcId);
assert(cottage, 'reviewed Cottage Cheese snapshot exists');
const literalSource = cottage.portions.find(portion =>
  portion.amount === cottageFixture.amount &&
  portion.modifier === cottageFixture.modifier &&
  portion.gramWeight === cottageFixture.gramWeight);
assert(literalSource, 'immutable USDA Cottage Cheese source retains its recorded 4 oz = 113 g');
const cottageSnapshot = parseNutritionSnapshot(cottage.snapshot);
assert(cottageSnapshot);
const literalGenerated = cottageSnapshot.portions.find(portion =>
  portion.id === `usda-portion-${literalSource.ordinal}`);
assert(literalGenerated);
assert.equal(literalGenerated.label, '4 oz', 'Cottage Cheese says 4 oz, never an ambiguous oz');
assert.equal(literalGenerated.grams, cottageFixture.gramWeight);
assertEvidenceContains(literalGenerated.evidence!, '4', 'Cottage Cheese evidence');
assertEvidenceContains(literalGenerated.evidence!, 'oz', 'Cottage Cheese evidence');
assertEvidenceContains(literalGenerated.evidence!, numberText(cottageFixture.gramWeight), 'Cottage Cheese evidence');

assert(sourceZeros > 0, 'reviewed source set exercises literal zero nutrients');
// SR Legacy can supply numeric amounts on every nutrient row. Do not invent a
// null source row to satisfy a coverage count: report the real count, and check
// a deliberately partial consumer fixture independently of the live evidence.
const sample = parseNutritionSnapshot(rows[0].snapshot)!;
const optional = sample.nutrients.find(nutrient =>
  !['1008', '1003', '1004', '1005'].includes(nutrient.id));
assert(optional, 'live panel supplies an extended nutrient for the partial-panel fixture');
const partialFixture = parseNutritionSnapshot({
  ...sample,
  nutrients: sample.nutrients.filter(nutrient => nutrient.id !== optional.id),
});
assert(partialFixture, 'a deliberately partial nutrient panel remains usable');
assert(!partialFixture.nutrients.some(nutrient => nutrient.id === optional.id),
  'an omitted extended nutrient is not synthesized as zero');
console.log(JSON.stringify({
  snapshots: rows.length,
  numericNutrients,
  sourceZeros,
  sourceMissingAmounts,
  sourcePortions,
  parser: 'mobile FoodNutritionSnapshot',
}));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Snapshot contract verification failed');
  process.exitCode = 1;
});