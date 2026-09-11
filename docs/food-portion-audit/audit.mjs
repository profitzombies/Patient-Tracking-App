// Read-only, offline audit. Run from the workspace root with Node.
// No application, database, provider API, patient module, or AI client is loaded.
// Only temporary archive extraction is written; the JSON receipt goes to stdout.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, mkdtempSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFoods } from '../../artifacts/api-server/scripts/usda-source/reader.mjs';

const root = resolve(import.meta.dirname, '../..');
const json = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
const sha = content => createHash('sha256').update(content).digest('hex');
const close = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-10);
const sources = new Map();
const releases = [];
const nonPositiveSourcePortions = [];
const temp = mkdtempSync(join(tmpdir(), 'thinnr-food-audit-'));
try {
  for (const [id, zipName] of [
    ['sr-legacy-2018-04', 'sr-legacy-2018.zip'],
    ['fndds-2021-2023', 'fndds-2021-2023.zip'],
    ['foundation-2026-04', 'foundation-2026-04.zip'],
  ]) {
    const manifest = json(`docs/usda-import/manifests/${id}.json`);
    const zip = join(root, '.cache/usda-source-downloads', zipName);
    const members = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
    const member = members.find(name => name.split('/').at(-1) === manifest.filename);
    assert(member, `Missing pinned JSON member: ${id}`);
    const file = join(temp, manifest.filename);
    const fd = openSync(file, 'w', 0o600);
    try { execFileSync('unzip', ['-p', zip, member], { stdio: ['ignore', fd, 'pipe'] }); }
    finally { closeSync(fd); }
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    const actualSha256 = digest.digest('hex');
    assert.equal(actualSha256, manifest.sha256, `Original archive hash: ${id}`);
    const stats = { id, sha256: actualSha256, sourceUrl: manifest.sourceUrl,
      foods: 0, portions: 0, missingAmounts: 0, nonUnitAmounts: 0,
      nonPositiveGrams: 0, withoutPortions: 0 };
    for await (const food of readFoods(file, { ...manifest, allowNullRecords: true })) {
      const portions = food.foodPortions ?? [];
      stats.foods++;
      stats.portions += portions.length;
      if (!portions.length) stats.withoutPortions++;
      for (const p of portions) {
        if (typeof p.amount !== 'number') stats.missingAmounts++;
        else if (p.amount !== 1) stats.nonUnitAmounts++;
        if (!(p.gramWeight > 0)) {
          stats.nonPositiveGrams++;
          nonPositiveSourcePortions.push({ release: id, fdcId: food.fdcId,
            description: food.description, portion: p });
        }
      }
      // Public USDA facts only. No patient or provider-restricted payloads.
      sources.set(`${id}:${food.fdcId}`, {
        release: id, fdcId: food.fdcId, description: food.description, portions,
        nutrients: food.foodNutrients.filter(n => [1008, 1003, 1004, 1005].includes(n.nutrient.id)
          && typeof n.amount === 'number').map(n => ({
          id: String(n.nutrient.id), name: n.nutrient.name, unit: n.nutrient.unitName, amount: n.amount,
        })),
      });
    }
    assert.equal(stats.foods, manifest.foods);
    assert.equal(stats.portions, manifest.portions);
    releases.push(stats);
    rmSync(file);
  }
} finally { rmSync(temp, { recursive: true, force: true }); }

// Evaluate actual pure application exports, with a strict local import allowlist.
// React context creation is inert; account hooks and API methods cannot run.
const require = createRequire(join(root, 'package.json'));
const ts = require('typescript');
const files = {
  nutrition: 'artifacts/thinnr-mobile/data/food-nutrition.ts',
  measures: 'artifacts/thinnr-mobile/data/ingredient-measures.ts',
  ingredients: 'artifacts/thinnr-mobile/data/ingredient-nutrition.ts',
  logging: 'artifacts/thinnr-mobile/context/FoodLoggingContext.tsx',
  catalog: 'artifacts/thinnr-mobile/lib/food-catalog.ts',
};
const allowed = new Set(Object.values(files).map(path => join(root, path)));
const cache = new Map();
function load(path) {
  assert(allowed.has(path), `Unapproved audit import: ${path}`);
  if (cache.has(path)) return cache.get(path);
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const localRequire = specifier => {
    if (specifier === 'react') return { createContext: () => ({}) };
    if (specifier === './PatientAccountContext') return { usePatientAccount: () => { throw Error('Account access forbidden'); } };
    if (specifier === '@workspace/api-client-react') return new Proxy({}, {
      get: () => () => { throw Error('Provider/network access forbidden'); },
    });
    const base = specifier.startsWith('@/') ? join(root, 'artifacts/thinnr-mobile', specifier.slice(2))
      : resolve(dirname(path), specifier);
    return load(`${base}.ts`);
  };
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  cache.set(path, module.exports);
  return module.exports;
}
const n = load(join(root, files.nutrition));
const i = load(join(root, files.ingredients));
const logging = load(join(root, files.logging));
const catalog = load(join(root, files.catalog));
const evidence = {
  schemaVersion: 1,
  scope: 'Offline source/code audit, not a live database census or a patient-history audit',
  checkoutCommitAtRun: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  codeHashes: Object.fromEntries(Object.values(files).map(p => [p, sha(readFileSync(join(root, p)))])),
  releases,
  nonPositiveSourcePortions,
};

// Compare every locally frozen source portion against the original release.
const comparisons = [];
for (const [file, rows] of [
  ['docs/food-library-cleanup/source-review-records-v3.json',
    json('docs/food-library-cleanup/source-review-records-v3.json').records.map(r => ({
      release: r.source.release, id: r.source.id, portions: r.portions,
    }))],
  ['docs/food-library-cleanup/bulk-catalog-source-v1.json',
    json('docs/food-library-cleanup/bulk-catalog-source-v1.json').records.map(r => ({
      release: r.releaseId, id: r.fdcId, portions: r.portions,
    }))],
]) {
  const result = { file, sha256: sha(readFileSync(join(root, file))), rows: rows.length,
    portions: 0, discrepancies: [] };
  for (const row of rows) {
    const source = sources.get(`${row.release}:${row.id}`);
    assert(source, `Source exists: ${row.release}:${row.id}`);
    assert.equal(row.portions.length, source.portions.length, `Portion count: ${row.id}`);
    for (const p of row.portions) {
      result.portions++;
      const original = source.portions.find(value => value.id === p.id);
      assert(original, `Portion exists: ${row.id}/${p.id}`);
      for (const [field, raw] of [
        ['amount', original.amount], ['grams', original.gramWeight],
        ['modifier', original.modifier], ['description', original.portionDescription],
        ['unit', original.measureUnit?.name],
      ]) {
        if ((p[field] ?? null) !== (raw ?? null)) result.discrepancies.push({
          source: `${row.release}:${row.id}`, portionId: p.id, field, stored: p[field], original: raw,
        });
      }
    }
  }
  comparisons.push(result);
}
evidence.sourceComparisons = comparisons;

const gram = { id: 'g', label: 'grams', unit: 'g', dimension: 'weight', grams: 1, basisMultiplier: 0.01 };
function snapshot(source, portions) {
  return {
    version: 1, source: { provider: 'USDA FoodData Central', recordId: String(source.fdcId),
      release: source.release, revision: `${source.release}:${source.fdcId}`, canonicalName: source.description },
    basis: { amount: 100, unit: 'g', label: '100 g', grams: 100 },
    nutrients: source.nutrients, portions,
    selected: { amount: 100, unitId: 'g', scale: 1 }, provenance: 'generic_source',
  };
}

// Historical reviewed projections: show amount-loss where the old label was
// generated from modifier alone, NOT an assertion about current live rows.
const oldProjections = [];
const reviewedNutrients = { records: 0, nutrientEntries: 0, discrepancies: [] };
for (const file of ['reviewed-food-families-v1', 'reviewed-food-family-variants-v2']) {
  for (const entry of json(`docs/usda-import/${file}.json`).entries) {
    const source = sources.get(`${entry.source.release}:${entry.source.recordId}`);
    assert(source);
    reviewedNutrients.records++;
    for (const nutrient of entry.nutrients.filter(value => ['1008', '1003', '1004', '1005'].includes(value.id))) {
      reviewedNutrients.nutrientEntries++;
      const raw = source.nutrients.find(value => value.id === nutrient.id);
      if (!raw || raw.unit !== nutrient.unit || raw.amount !== nutrient.amount) {
        reviewedNutrients.discrepancies.push({ file, source: entry.source.recordId, nutrient, raw });
      }
    }
    for (const p of entry.portions) {
      const raw = source.portions.find(portion => String(portion.id) === p.id);
      assert(raw && raw.gramWeight === p.grams);
      if (typeof raw.amount !== 'number' || raw.amount === 1) continue;
      const portion = { id: p.id, label: p.label, unit: p.unit, dimension: 'weight',
        grams: p.grams, basisMultiplier: p.grams / 100 };
      const displayed = n.nutritionPortionPresentation(portion).sourceAmount;
      if (displayed !== raw.amount) oldProjections.push({
        file, family: entry.familyKey, source: `${source.release}:${source.fdcId}`,
        description: source.description, portionId: raw.id, sourceAmount: raw.amount,
        sourceModifier: raw.modifier, sourceGrams: raw.gramWeight, projectionLabel: p.label,
        parsedDisplayAmount: displayed, selectedSourceCalories: source.nutrients.find(n => n.id === '1008')?.amount * p.grams / 100,
      });
    }
  }
}
evidence.historicalAmountLoss = oldProjections;
evidence.reviewedMacroComparisons = reviewedNutrients;

// Actual recipe-name conversion rules, compared with distinct source states.
evidence.ingredientCandidates = [];
for (const pattern of [
  /^Spinach, (raw|cooked, boiled, drained, without salt)$/,
  /^Quinoa, (uncooked|cooked)$/,
  /^Lentils, (raw|mature seeds, cooked, boiled, without salt)$/,
  /^Strawberries, raw$/,
  /^Nuts, almonds$/,
  /^Broccoli, (raw|cooked, boiled, drained, without salt)$/,
]) {
  for (const source of sources.values()) {
    if (source.release !== 'sr-legacy-2018-04' || !pattern.test(source.description)) continue;
    for (const p of source.portions.filter(p => /\bcup\b/.test(p.modifier ?? ''))) {
      for (const name of [source.description,
        ...(/Spinach, cooked/.test(source.description) ? ['spinach, cooked'] : []),
        ...(/Broccoli, cooked/.test(source.description) ? ['broccoli, cooked'] : []),
        ...(/Quinoa, uncooked/.test(source.description) ? ['quinoa, rinsed'] : []),
        ...(/Lentils, raw/.test(source.description) ? ['dried green lentils, rinsed'] : []),
        ...(/Strawberries/.test(source.description) ? ['strawberries, sliced'] : []),
        ...(/Nuts, almonds/.test(source.description) && /cup, (sliced|ground|slivered)$/.test(p.modifier)
          ? [`almonds, ${p.modifier.slice(5)}`] : []),
      ]) {
        const ounces = i.conversionFactorFor(name, 'cup', 'oz');
        const sourceGramsPerCup = p.gramWeight / p.amount;
        evidence.ingredientCandidates.push({
          source: `${source.release}:${source.fdcId}`, description: source.description,
          sourceNutrientsPer100g: source.nutrients,
          portion: { id: p.id, amount: p.amount, modifier: p.modifier, gramWeight: p.gramWeight },
          inputName: name, inferredOuncesPerCup: ounces,
          inferredGramsPerCup: ounces === null ? null : ounces * logging.GRAMS_PER_OUNCE,
          sourceGramsPerCup,
          gramDifferencePercent: ounces === null ? null : 100 * (ounces * logging.GRAMS_PER_OUNCE / sourceGramsPerCup - 1),
          reviewNote: 'Candidate comparison only: input must match the exact portion cut/state before claiming an error.',
        });
      }
    }
  }
}
const cottage = sources.get('sr-legacy-2018-04:172179');
const fourOz = cottage.portions.find(p => p.amount === 4 && p.modifier === 'oz');
assert.equal(fourOz.gramWeight, 113);
const sourcePortion = { id: 'source-four-oz', label: '4 oz', unit: 'oz', dimension: 'weight',
  grams: fourOz.gramWeight, basisMultiplier: fourOz.gramWeight / 100 };
const selected = n.selectSnapshotDisplayedPortion(snapshot(cottage, [gram, sourcePortion]), 8, sourcePortion.id);
assert.equal(selected.selected.scale, 2.26);
evidence.controls = {
  multiUnitSource: { source: 'sr-legacy-2018-04:172179', portion: fourOz,
    eightDisplayedOzScale: selected.selected.scale, eightDisplayedOzGrams: selected.selected.scale * 100,
    displayed: n.formatNutritionAmount(selected).text,
    exactFourOzGrams: 4 * logging.GRAMS_PER_OUNCE },
  pureVolumeCupToFluidOunces: i.conversionFactor('cup', 'fl oz'),
  pureVolumeCupToWeightOunces: i.conversionFactor('cup', 'oz'),
  unknownFoodCupToWeightOunces: i.conversionFactorFor('unrecognized audit ingredient', 'cup', 'oz'),
  milkCupToWeightOunces: i.conversionFactorFor('milk', 'cup', 'oz'),
};
assert.equal(evidence.controls.pureVolumeCupToFluidOunces, 8);
assert.equal(evidence.controls.unknownFoodCupToWeightOunces, null);
assert.equal(evidence.controls.milkCupToWeightOunces, null);

// Deliberately synthetic corruption probes: NEVER classified as observed food rows.
const badPortion = { id: 'cup', label: '1 cup', unit: 'cup', dimension: 'volume',
  grams: 200, basisMultiplier: 1.5 };
const bad = snapshot(cottage, [gram, badPortion]);
bad.selected = { amount: 1, unitId: 'cup', scale: 1.5 };
const noDensity = structuredClone(bad);
delete noDensity.portions[1].grams;
const badScale = structuredClone(bad);
badScale.selected.scale = 2;
const partial = structuredClone(bad);
partial.portions[1].basisMultiplier = 2;
partial.selected.scale = 2;
partial.nutrients = partial.nutrients.filter(n => n.id === '1008');
const baseline = Object.fromEntries(cottage.nutrients.map(n => [n.id, n.amount]));
const food = { kind: 'food', refId: 'synthetic-audit-only', name: 'Synthetic audit food', serving: '100 g',
  calories: baseline['1008'], protein: baseline['1003'], carbs: baseline['1005'], fat: baseline['1004'],
  nutritionSnapshot: partial };
const log = logging.buildFoodLogEntry({ basketId: 'audit', item: food, quantity: 2 },
  { dateKey: '2000-01-01', meal: 'lunch' });
const malformedCatalog = catalog.parseCatalogFood({ id: 'audit', name: food.name, serving: '100 g',
  calories: food.calories, protein: food.protein, carbs: food.carbs, fat: food.fat, nutritionSnapshot: badScale }, 'common');
evidence.syntheticProbes = {
  inconsistentGramSnapshotAccepted: n.parseNutritionSnapshot(bad) !== null,
  claimedGrams: 200, scaledBasisGrams: bad.selected.scale * bad.basis.grams,
  mismatchedSelectedScaleRejected: n.parseNutritionSnapshot(badScale) === null,
  noDensityVolumeSelectable: n.availableNutritionPortions(noDensity).some(p => p.id === 'cup'),
  partialMacroSnapshotAccepted: n.parseNutritionSnapshot(partial) !== null,
  partialMacroLog: { selectedScale: log.quantity, loggedCalories: log.calories,
    expectedScaledCalories: food.calories * 2 },
  malformedCatalogSnapshotDroppedButFoodAccepted: !!malformedCatalog && !malformedCatalog.nutritionSnapshot,
  countUnitNotBoundToMeasure: {
    eggToOz: i.conversionFactorFor('egg', 'egg', 'oz'),
    dozenToOz: i.conversionFactorFor('egg', 'dozen', 'oz'),
  },
};
assert(evidence.syntheticProbes.inconsistentGramSnapshotAccepted);
assert(evidence.syntheticProbes.mismatchedSelectedScaleRejected);
assert.equal(evidence.syntheticProbes.partialMacroLog.loggedCalories, food.calories);
assert(!close(evidence.syntheticProbes.partialMacroLog.loggedCalories, food.calories * 2));

// FOOD_DB only: never import or print the adjacent patient/diary module.
const patientSource = readFileSync(join(root, 'artifacts/thinnr-mobile/data/patient-data.ts'), 'utf8');
const foodsOnly = patientSource.split('export const FOOD_DB: FoodItem[] = [')[1]?.split('\n];')[0];
assert(foodsOnly);
evidence.staticFoodInventory = {
  rows: (foodsOnly.match(/^\s*f\('/gm) ?? []).length,
  sourceReferencesInRows: (foodsOnly.match(/nutritionSnapshot|catalogServingGrams|catalogMeasures/g) ?? []).length,
  limitation: 'Static seeds have serving text/macros, not record-level source provenance; no source correction asserted.',
};
console.log(JSON.stringify(evidence, null, 2));
// Emit discrepancies for inspection, but never describe a divergent rerun as
// successful verification. Checkout metadata can change; source facts may not.
assert(comparisons.every(result => result.discrepancies.length === 0),
  'Frozen source projections diverge from the pinned archives; inspect the emitted receipt');
assert.equal(reviewedNutrients.discrepancies.length, 0,
  'Reviewed nutrient projections diverge from the pinned archives; inspect the emitted receipt');