#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildManifest, findQueryOwnershipConflicts, identityParts, TARGET_ADDITIONAL,
  validateManifest,
} from "./bulk-catalog-lib.mjs";

const root = resolve(import.meta.dirname, "../../../../");
const source = JSON.parse(await readFile(resolve(root, "docs/food-library-cleanup/bulk-catalog-source-v1.json"), "utf8"));
const preflight = JSON.parse(await readFile(resolve(root, "docs/food-library-cleanup/bulk-serving-preflight-v1.json"), "utf8"));
const rejected = new Set(preflight.failures.filter(value => /\bsnapshot parses$/.test(value))
  .map(value => value.match(/^(\d+)/)?.[1]).filter(Boolean));
const first = buildManifest(source, source.existingFamilies, rejected);
const second = buildManifest(source, source.existingFamilies, rejected);
assert.deepEqual(first, second, "generation must be deterministic");
assert.ok(first.accepted.length <= TARGET_ADDITIONAL);
assert.equal(new Set(first.accepted.map(x => x.catalogId)).size, first.accepted.length);
assert.ok(first.accepted.every(x => x.acceptanceEvidence.length >= 7));
assert.ok(first.accepted.every(x => x.sourcePortions.every(p => p.grams == null || Number(p.grams) > 0)));
const ownershipFixture = findQueryOwnershipConflicts({
  families: [
    { familyKey: "bulk-cooked-pasta", displayName: "Cooked Pasta", aliases: ["cooked pasta"] },
    { familyKey: "bulk-raw-sugar", displayName: "Raw Sugar", aliases: ["raw sugar"] },
  ],
}, [
  { query: "cooked pasta", expectedFamily: "everyday-pasta", expect: "family-or-honest-empty" },
  { query: "raw sugar", expectedFamily: "everyday-sugar", expect: "family-or-honest-empty" },
]);
assert.deepEqual(ownershipFixture.map(row => row.normalizedQuery), ["cooked pasta", "raw sugar"]);
assert.equal(findQueryOwnershipConflicts({
  families: [{ familyKey: "bulk-cooked-pasta", displayName: "Cooked Pasta", aliases: ["cooked pasta"] }],
}, [{ query: "cooked pasta", expectedFamily: "everyday-pasta", expect: "family-or-honest-empty" }],
[
  { historicalFamily: "bulk-cooked-pasta", canonicalFamily: "everyday-pasta" },
]).length, 0);
const identity = description => identityParts({ description }).name;
assert.equal(identity("Cheese, cheddar, sharp"), "Cheddar Cheese");
assert.equal(identity("Beans, black, mature seeds, cooked"), "Black Beans");
assert.equal(identity("Pasta, whole-wheat, cooked"), "Whole-Wheat Pasta");
assert.equal(identity("Chicken, broilers or fryers, breast, meat only, cooked, roasted"), "Chicken Breast");
assert.equal(identity("Turkey, all classes, wing, meat and skin, cooked"), "Turkey Wing");
assert.equal(identity("Pork, fresh, loin, tenderloin, raw"), "Pork Tenderloin");
assert.equal(identity("Spices, pepper, black"), "Black Pepper");
assert.equal(identity("Tea, hibiscus, brewed"), "Tea");
assert.equal(identity("Milk, chocolate, whole"), "Chocolate Milk");
assert.equal(identity("Cereals ready-to-eat, wheat, puffed"), "Puffed Wheat Cereal");
assert.equal(identity("Lentils, sprouted, raw"), "Lentil Sprouts");
assert.equal(identity("Alfalfa seeds, sprouted, raw"), "Alfalfa Sprouts");
assert.ok(!first.families.some(f => /^(Octopu|Asparagu|Couscou|Molasse)$/.test(f.displayName)));
assert.ok(!first.accepted.some(row => /\b(human milk|game meat|people with diabetes)\b/i.test(row.canonicalName)));
assert.ok(!first.accepted.some(row => rejected.has(row.sourceId)));
assert.ok(!first.accepted.some(row => row.familyKey === "meatballs" && /\bmeatless\b/i.test(row.canonicalName)));
assert.ok(!first.accepted.some(row => row.familyKey === "rice" && /\bcereals? ready-to-eat\b/i.test(row.canonicalName)));
assert.ok(first.accepted.filter(row => /^milk,\s*chocolate\b/i.test(row.canonicalName))
  .every(row => row.displayName === "Chocolate Milk" && row.dimensions.flavor === "chocolate"));
assert.ok(first.accepted.filter(row => /\bcereals? ready-to-eat\b/i.test(row.canonicalName))
  .every(row => /Cereal/i.test(row.displayName) && row.dimensions.form === "ready-to-eat"));
assert.ok(first.accepted.filter(row => /\bsprouted\b/i.test(row.canonicalName))
  .every(row => /Sprouts/i.test(row.displayName) && row.dimensions.form === "sprouted"));
const result = validateManifest(first, source, source.existingFamilies);
assert.equal(result.valid, true, result.errors.join("\n"));
console.log(JSON.stringify({ deterministic: true, ...result }));