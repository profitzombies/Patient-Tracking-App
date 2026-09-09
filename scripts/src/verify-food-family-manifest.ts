import { readFile } from "node:fs/promises";

interface Entry {
  familyKey: string;
  source: { release: string; recordId: string; revision: string; canonicalName: string };
  basis: { amount: number; unit: string; grams?: number };
  aliases: string[];
  nutrients: Array<{ id: string; name: string; unit: string; amount: number }>;
  portions: Array<{ grams: number; evidence: unknown }>;
  eligibility: { readyRelease: boolean; completeMacros: boolean };
}

const expected = new Set([
  "ground-beef", "chicken-breast", "chicken-thighs", "chicken-wings", "eggs",
  "rice", "apples", "bananas", "yogurt", "meatballs", "ketchup",
]);
const path = new URL("../../docs/usda-import/reviewed-food-families-v1.json", import.meta.url);
const manifest = JSON.parse(await readFile(path, "utf8")) as {
  version: number;
  reviewVersion: string;
  entries: Entry[];
};

if (manifest.version !== 1 || manifest.reviewVersion !== "food-families-v1") {
  throw new Error("Food family manifest version is invalid.");
}
if (manifest.entries.length !== expected.size) throw new Error("Manifest must contain eleven families.");
for (const entry of manifest.entries) {
  if (!expected.delete(entry.familyKey)) throw new Error(`Unexpected/duplicate family ${entry.familyKey}.`);
  if (!entry.source.release || !entry.source.recordId || !entry.source.canonicalName) {
    throw new Error(`${entry.familyKey} does not pin an exact source record.`);
  }
  if (entry.source.revision !== `${entry.source.release}:${entry.source.recordId}`) {
    throw new Error(`${entry.familyKey} source revision is not pinned.`);
  }
  if (entry.basis.amount !== 100 || entry.basis.unit !== "g" || entry.basis.grams !== 100) {
    throw new Error(`${entry.familyKey} has an unsupported nutrient basis.`);
  }
  if (!entry.eligibility.readyRelease || !entry.eligibility.completeMacros) {
    throw new Error(`${entry.familyKey} is not eligible for promotion.`);
  }
  const ids = new Set(entry.nutrients.map(nutrient => nutrient.id));
  if (ids.size !== entry.nutrients.length) throw new Error(`${entry.familyKey} has duplicate nutrient ids.`);
  for (const id of ["1008", "1003", "1005", "1004"]) {
    if (!ids.has(id)) throw new Error(`${entry.familyKey} is missing required nutrient ${id}.`);
  }
  if (entry.nutrients.some(nutrient => !Number.isFinite(nutrient.amount) || nutrient.amount < 0)) {
    throw new Error(`${entry.familyKey} has an invalid nutrient amount.`);
  }
  if (entry.portions.some(portion => !(portion.grams > 0) || !portion.evidence)) {
    throw new Error(`${entry.familyKey} has invalid portion evidence.`);
  }
}
if (expected.size) throw new Error(`Missing families: ${[...expected].join(", ")}.`);

const variantsPath = new URL("../../docs/usda-import/reviewed-food-family-variants-v2.json", import.meta.url);
const variants = JSON.parse(await readFile(variantsPath, "utf8")) as {
  version: number;
  reviewVersion: string;
  entries: Array<Entry & { dimensions: Record<string, string>; variantSummary: string }>;
};
const requiredCounts: Record<string, number> = {
  "ground-beef": 9,
  "chicken-breast": 5,
  "chicken-thighs": 3,
  "chicken-wings": 4,
  eggs: 6,
  rice: 4,
  yogurt: 4,
};
if (variants.version !== 2 || variants.reviewVersion !== "food-families-v2") {
  throw new Error("Food family variant manifest version is invalid.");
}
for (const [familyKey, count] of Object.entries(requiredCounts)) {
  const family = variants.entries.filter(entry => entry.familyKey === familyKey);
  if (family.length !== count) throw new Error(`${familyKey} must contain ${count} exact variants.`);
  const sourceIds = new Set(family.map(entry => `${entry.source.release}:${entry.source.recordId}`));
  if (sourceIds.size !== family.length) throw new Error(`${familyKey} contains a duplicate exact source.`);
  for (const entry of family) {
    if (entry.source.revision !== `${entry.source.release}:${entry.source.recordId}`) {
      throw new Error(`${familyKey} has an unpinned revision.`);
    }
    if (!entry.variantSummary || !Object.keys(entry.dimensions).length) {
      throw new Error(`${familyKey} has an unexplained tuple.`);
    }
    const ids = new Set(entry.nutrients.map(nutrient => nutrient.id));
    if (!["1008", "1003", "1005", "1004"].every(id => ids.has(id))) {
      throw new Error(`${familyKey} variant ${entry.source.recordId} is missing macros.`);
    }
  }
}