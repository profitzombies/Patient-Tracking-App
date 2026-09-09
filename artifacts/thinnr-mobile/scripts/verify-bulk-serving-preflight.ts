/**
 * Read-only acceptance gate: build proposed snapshots with the real database
 * source helper, then exercise the real mobile parser and serving consumers.
 * This does NOT add the proposed records to the searchable catalog.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  availableNutritionPortions,
  formatNutritionAmount,
  initializeFreshNutritionSnapshot,
  nutritionPortionDimension,
  nutritionPortionPresentation,
  orderedNutritionPortions,
  parseNutritionSnapshot,
  scaledSnapshotMacros,
  selectSnapshotDisplayedPortion,
} from '../data/food-nutrition';
// @ts-expect-error The established management transport is a checked JS module.
import { managementQuery, sqlJson } from '../../api-server/scripts/usda-source/import.mjs';

interface Candidate {
  catalogId: string;
  sourceId: string;
  releaseId: string;
  familyKey: string;
  displayName: string;
  canonicalName: string;
  summary: string;
  category: string;
  dimensions: Record<string, string>;
  sourcePortions: Array<{ amount: number | null; grams: number; modifier: string | null; description: string | null }>;
}

async function main() {
const { values } = parseArgs({ options: {
  project: { type: 'string' },
  manifest: { type: 'string' },
  output: { type: 'string' },
} });
assert.match(values.project ?? '', /^[a-z0-9]+$/, '--project is required');
assert(values.manifest, '--manifest is required');
const manifestText = await readFile(resolve(values.manifest), 'utf8');
const manifest = JSON.parse(manifestText) as {
  version: string; accepted: Candidate[];
};
assert(Array.isArray(manifest.accepted) && manifest.accepted.length > 0, 'manifest has accepted candidates');
assert.equal(new Set(manifest.accepted.map(row => row.catalogId)).size, manifest.accepted.length);
const query = managementQuery(values.project);
const failures: string[] = [];
let snapshots = 0, sourcePortions = 0, displayedUnits = 0, liquidDefaults = 0;
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-10, Math.abs(b) * 1e-10);
for (let offset = 0; offset < manifest.accepted.length; offset += 25) {
  const batch = manifest.accepted.slice(offset, offset + 25);
  for (const row of batch) assert.match(row.sourceId, /^\d+$/);
  const inputs = batch.map(row => ({
    id: row.catalogId, source_id: row.sourceId, release_id: row.releaseId,
    family_key: row.familyKey, summary: row.summary, dimensions: row.dimensions,
  }));
  const rows = await query(`select jsonb_agg(jsonb_build_object(
    'id',id,'snapshot',public.build_food_catalog_source_snapshot(
      release_id,source_id::bigint,family_key,summary,dimensions,'generic_source'
    )
  )) result from jsonb_to_recordset(${sqlJson(inputs)}) as x(
    id text,source_id text,release_id text,family_key text,summary text,dimensions jsonb
  )`);
  assert.equal(rows.length, batch.length, 'every candidate was constructed');
  for (const row of rows) {
    const candidate = batch.find(value => value.catalogId === row.id)!;
    const context = `${candidate.sourceId} (${candidate.displayName})`;
    try {
      const snapshot = parseNutritionSnapshot(row.snapshot);
      assert(snapshot, `${context}: snapshot parses`);
      assert.equal(snapshot.source.revision, `${candidate.releaseId}:${candidate.sourceId}`);
      const before = JSON.stringify(snapshot);
      const usable = availableNutritionPortions(snapshot);
      assert(usable.length, `${context}: has supported serving evidence`);
      const fresh = initializeFreshNutritionSnapshot(snapshot, {
        foodName: candidate.displayName, canonicalName: candidate.canonicalName,
      });
      const primary = orderedNutritionPortions(fresh).slice(0, 3);
      assert(primary.length >= 1 && primary.length <= 3, `${context}: compact primary units`);
      assert(usable.some(portion => portion.id === fresh.selected.unitId), `${context}: default is a usable documented unit`);
      const freshLabel = formatNutritionAmount(fresh);
      assert(freshLabel.text && freshLabel.amount > 0, `${context}: readable positive default`);
      // A beverage known to be liquid cannot silently start in weight ounces
      // when a source-backed household volume is actually available.
      const liquid = candidate.category === 'beverages' &&
        !/\b(powder|dry|dried|mix|concentrat|undiluted|syrup|solid|instant)\w*/i.test(candidate.canonicalName);
      if (liquid && usable.some(portion => nutritionPortionDimension(portion) === 'volume')) {
        assert.equal(nutritionPortionDimension(usable.find(portion => portion.id === fresh.selected.unitId)!), 'volume',
          `${context}: liquid starts in documented volume, not weight ounces`);
        liquidDefaults++;
      }
      for (const portion of usable) {
        const presentation = nutritionPortionPresentation(portion);
        assert(presentation.sourceAmount > 0 && Number.isFinite(presentation.sourceAmount));
        assert(!/^(?:fluid|fl|cubic)$/i.test(presentation.singular),
          `${context}: multiword unit ${portion.label} is not truncated`);
        const one = selectSnapshotDisplayedPortion(snapshot, 1, portion.id);
        assert(one, `${context}: one ${presentation.singular} can be selected`);
        const label = formatNutritionAmount(one);
        assert.equal(label.amount, 1, `${context}: quantity is independent of source portion amount`);
        assert(!/^1\s+1\s+(cup|wing|drumette|bean)\b/i.test(label.text),
          `${context}: duplicate source count is not shown`);
        assert(close(one.selected.scale, portion.basisMultiplier / presentation.sourceAmount),
          `${context}: displayed unit uses the exact source multiplier`);
        const baseMacros = scaledSnapshotMacros(snapshot);
        const oneMacros = scaledSnapshotMacros(one);
        for (const key of ['calories', 'protein', 'carbs', 'fat'] as const) {
          assert(close(oneMacros[key], baseMacros[key] * one.selected.scale / snapshot.selected.scale),
            `${context}: ${key} follows the exact shown amount`);
        }
        displayedUnits++;
      }
      for (const [index, original] of candidate.sourcePortions.entries()) {
        const portion = snapshot.portions.find(value => value.id === `usda-portion-${index + 1}`);
        if (!portion) continue; // The canonical helper explicitly omits unusable source measures.
        assert.equal(portion.grams, original.grams, `${context}: literal source gram weight`);
        assert(close(portion.basisMultiplier, original.grams / 100), `${context}: original portion multiplier`);
        if (original.amount !== null && original.amount > 0) {
          assert(close(nutritionPortionPresentation(portion).sourceAmount, original.amount),
            `${context}: source amount ${original.amount} must survive label ${portion.label}`);
        }
        sourcePortions++;
      }
      assert.equal(JSON.stringify(snapshot), before, `${context}: initialization and display never mutate source data`);
      snapshots++;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
}
const report = {
  verifiedAt: new Date().toISOString(), version: manifest.version, mode: 'read-only-preflight',
  manifestSha256: createHash('sha256').update(manifestText).digest('hex'),
  candidates: manifest.accepted.length, snapshots, sourcePortions, displayedUnits, liquidDefaults,
  failures,
};
if (values.output) await writeFile(resolve(values.output), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, failures: failures.slice(0, 12) }));
assert.equal(failures.length, 0, `${failures.length} candidates failed real consumer checks; do not apply the manifest`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});