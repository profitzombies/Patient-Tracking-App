#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { managementQuery, sqlJson } from "../usda-source/import.mjs";
import { validateManifest } from "./bulk-catalog-lib.mjs";

const { values } = parseArgs({ options: {
  project: { type: "string" },
  apply: { type: "boolean", default: false },
} });
assert.match(values.project ?? "", /^[a-z0-9]+$/, "--project is required");
const root = resolve(import.meta.dirname, "../../../../");
const docs = resolve(root, "docs/food-library-cleanup");
const manifestText = await readFile(resolve(docs, "bulk-catalog-manifest-v1.json"), "utf8");
const manifest = JSON.parse(manifestText);
const source = JSON.parse(await readFile(resolve(docs, "bulk-catalog-source-v1.json"), "utf8"));
const preflight = JSON.parse(await readFile(resolve(docs, "bulk-serving-preflight-v1.json"), "utf8"));
const hash = text => createHash("sha256").update(text).digest("hex");
const validation = validateManifest(manifest, source, source.existingFamilies);
assert(validation.valid, validation.errors.join("; "));
assert.equal(preflight.manifestSha256, hash(manifestText), "preflight must cover this exact manifest");
assert.equal(preflight.snapshots, manifest.accepted.length, "every accepted source must pass the actual mobile consumer");
assert.deepEqual(preflight.failures, [], "failed serving candidates cannot be applied");
const sql = await readFile(resolve(root, "supabase/migrations/20261005110000_bulk_everyday_food_catalog.sql"), "utf8");
if (!values.apply) {
  console.log(JSON.stringify({
    mode: "dry-run", validated: true, candidates: manifest.accepted.length,
    manifestSha256: hash(manifestText), migrationSha256: hash(sql), writes: 0,
  }));
  process.exit(0);
}

const query = managementQuery(values.project);
const candidateIds = sqlJson(manifest.accepted.map(row => row.catalogId));
const priorKeys = sqlJson(source.existingFamilies.map(family => family.familyKey));
const auditSql = `with accepted as(
  select value::uuid id from jsonb_array_elements_text(${candidateIds})
), prior_families as(
  select value family_key from jsonb_array_elements_text(${priorKeys})
)
select jsonb_build_object(
  'archiveRecords',(select count(*)from usda_source_foods),
  'archiveDigest',(select md5(string_agg(md5(to_jsonb(s)::text),''order by release_id,fdc_id))from usda_source_foods s),
  'catalogRecords',(select count(*)from food_catalog_items),
  'eligible',(select count(*)from food_catalog_curation where eligibility<>'excluded'),
  'excluded',(select count(*)from food_catalog_curation where eligibility='excluded'),
  'reviewed',(select count(*)from food_catalog_curation where eligibility='reviewed_family'),
  'safeSingletons',(select count(*)from food_catalog_curation where eligibility='safe_singleton'),
  'foodFamilies',(select count(*)from food_catalog_families),
  'usefulAdditionalVariants',(select count(*)from food_catalog_family_variants)-
    (select count(*)from food_catalog_families),
  'priorFamiliesDigest',(select md5(string_agg(md5(to_jsonb(f)::text),''order by f.family_key))
    from food_catalog_families f join prior_families p using(family_key)),
  'priorVariantsDigest',(select md5(string_agg(md5(to_jsonb(v)::text),''order by v.family_key,v.catalog_id))
    from food_catalog_family_variants v where not exists(select 1 from accepted a where a.id=v.catalog_id)),
  'untouchedCatalogDigest',(select md5(string_agg(md5(to_jsonb(c)::text),''order by c.id))
    from food_catalog_items c where not exists(select 1 from accepted a where a.id=c.id)),
  'newReviewed',(select count(*)from food_catalog_curation q join accepted a on a.id=q.catalog_id
    where q.eligibility='reviewed_family'and q.review_version='bulk-catalog-v1')
) result`;
const before = await query(auditSql);
assert.equal(before.newReviewed, 0, "batch already or partially applied; inspect the receipt, never blindly replay");
assert.equal(before.eligible, manifest.frozenBaseline.eligible, "eligibility denominator changed");
assert.equal(before.reviewed, manifest.frozenBaseline.reviewed, "reviewed baseline changed");
const receiptPath = resolve(docs, "quarter-catalog-reconciliation.json");
const receipt = {
  startedAt: new Date().toISOString(), manifestSha256: hash(manifestText),
  migrationSha256: hash(sql), before, status: "before-apply",
};
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
// Apply the canonical migration verbatim. The trailing read gives the
// management transport one result after COMMIT; it does not alter the batch.
const applied = await query(`${sql}\nselect jsonb_build_object('applied',true) result;`);
assert.equal(applied.applied, true);
const after = await query(auditSql);
receipt.after = after;
receipt.completedAt = new Date().toISOString();
receipt.status = "applied-awaiting-reconciliation";
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
for (const key of [
  "archiveRecords", "archiveDigest", "catalogRecords", "eligible", "excluded",
  "priorFamiliesDigest", "priorVariantsDigest", "untouchedCatalogDigest",
]) assert.equal(after[key], before[key], `${key}: immutable or untouched data changed`);
assert.equal(after.reviewed, before.reviewed + manifest.accepted.length);
assert.equal(after.newReviewed, manifest.accepted.length);
assert.equal(after.safeSingletons, before.safeSingletons - manifest.accepted.length);
receipt.status = "verified";
receipt.reviewedCoverage = after.reviewed / before.eligible;
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({
  status: receipt.status, accepted: after.newReviewed, reviewed: after.reviewed,
  denominator: before.eligible, coverage: receipt.reviewedCoverage,
  foodFamilies: after.foodFamilies, usefulAdditionalVariants: after.usefulAdditionalVariants,
  archiveAndPriorDataUnchanged: true,
}));