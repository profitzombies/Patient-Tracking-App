#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { managementQuery } from "../usda-source/import.mjs";

const { values } = parseArgs({ options: { project: { type: "string" } } });
if (!/^[a-z0-9]+$/.test(values.project ?? "")) throw new Error("--project is required");
const manifest = JSON.parse(await readFile(resolve(
  import.meta.dirname,
  "../../../../docs/food-library-cleanup/everyday-food-identities-v3.json",
), "utf8"));
const query = managementQuery(values.project);
const ids = manifest.sourceIds.map(Number);
if (ids.length !== 100 || ids.some(id => !Number.isSafeInteger(id))) {
  throw new Error("invalid reviewed source identifiers");
}
const facts = await query(`select jsonb_agg(jsonb_build_object(
  'id',fdc_id,'rawMd5',md5(raw_food::text),
  'nutrients',(select count(*) from jsonb_array_elements(raw_food->'foodNutrients')n
    where jsonb_typeof(n->'amount')='number'),
  'portions',jsonb_array_length(coalesce(raw_food->'foodPortions','[]'))
)order by fdc_id) result from usda_source_foods
where release_id='sr-legacy-2018-04' and fdc_id=any(array[${ids.join(",")}]::bigint[])`);
if (facts.length !== 100) throw new Error(`expected 100 source rows, found ${facts.length}`);
const digest = createHash("sha256")
  .update(facts.map(fact => fact.rawMd5).join(""))
  .digest("hex");
const nutrients = facts.reduce((sum, fact) => sum + fact.nutrients, 0);
const portions = facts.reduce((sum, fact) => sum + fact.portions, 0);
const expected = manifest.sourceEvidence;
if (digest !== expected.orderedRawRecordMd5Sha256 ||
    nutrients !== expected.numericNutrientsReviewed ||
    portions !== expected.sourcePortionsReviewed) {
  throw new Error("source review evidence differs from the authoritative manifest");
}
console.log(JSON.stringify({ sourceRows: facts.length, nutrients, portions, digest }));