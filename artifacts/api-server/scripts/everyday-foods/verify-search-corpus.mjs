#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { managementQuery } from "../usda-source/import.mjs";

const { values } = parseArgs({ options: {
  project: { type: "string" },
  output: { type: "string" },
} });
if (!/^[a-z0-9]+$/.test(values.project ?? "")) throw new Error("--project is required");
const root = resolve(import.meta.dirname, "../../../../");
const identities = JSON.parse(await readFile(
  resolve(root, "docs/food-library-cleanup/everyday-food-identities-v3.json"), "utf8",
));
const spec = JSON.parse(await readFile(
  resolve(root, "docs/food-library-cleanup/golden-query-corpus-v3.json"), "utf8",
));
const generated = spec.generatedCases.flatMap(rule =>
  identities.displayNames.map((name, index) => ({
    query: rule.template.replace("{identity}", name.toLowerCase()),
    expect: rule.expect,
    expectedFamily: `everyday-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    sourceId: String(identities.sourceIds[index]),
  })),
);
const cases = [...generated, ...spec.explicitCases];
if (new Set(cases.map(test => test.query)).size < 250) throw new Error("corpus is too small");
const query = managementQuery(values.project);
// Availability comes from the actual supported tuples, not a test that accepts
// any empty answer as success. This also catches accidentally hiding raw/cooked
// options that the review has made selectable.
const familyRows = await query(`select jsonb_agg(jsonb_build_object(
  'key',family_key,'variants',get_food_catalog_family(family_key,false)
)) result from food_catalog_families where family_key like 'everyday-%'`);
const variantsByFamily = new Map(familyRows.map(row => [row.key, row.variants]));
const results = new Map();
for (let offset = 0; offset < cases.length; offset += 20) {
  const batch = cases.slice(offset, offset + 20);
  const rows = batch.map((test, index) =>
    `(${offset + index},'${test.query.replaceAll("'", "''")}',${test.approvedOnly ? "true" : "false"})`
  ).join(",");
  const values = await query(`select jsonb_agg(jsonb_build_object(
    'i',i,'rows',search_food_catalog_grouped(null,q,approved,7,0),
    'first',search_food_catalog_grouped(null,q,approved,1,0),
    'resolution',resolve_food_catalog_query(q,null)
  )order by i) result from(values${rows})x(i,q,approved)`);
  for (const value of values) results.set(value.i, value);
}
const failures = [];
for (const [index, test] of cases.entries()) {
  const value = results.get(index);
  const rows = value?.rows ?? [];
  const first = rows[0];
  if (!value || !Array.isArray(value.rows)) failures.push(`${test.query}: missing RPC result`);
  if (rows.length > 7) failures.push(`${test.query}: grouped lookahead exceeded seven`);
  if (new Set(rows.map(row => row.resultKey)).size !== rows.length) {
    failures.push(`${test.query}: repeated result identity before pagination`);
  }
  if (value?.first?.[0]?.id !== first?.id) failures.push(`${test.query}: limit one changed the winner`);
  if (test.expect === "family" && first?.familyKey !== test.expectedFamily) {
    failures.push(`${test.query}: expected ${test.expectedFamily}`);
  }
  if (test.expect === "family" && (
    first?.source_id !== test.sourceId ||
    first?.nutritionSnapshot?.source?.revision !== `${identities.releaseId}:${test.sourceId}`
  )) failures.push(`${test.query}: exact reviewed source/revision changed`);
  if (test.expect === "family-or-honest-empty") {
    const state = test.query.startsWith("raw ") ? "raw" : "cooked";
    const supported = (variantsByFamily.get(test.expectedFamily) ?? [])
      .filter(variant => variant.dimensions?.state === state);
    if (supported.length > 0 && rows.length === 0) failures.push(`${test.query}: supported state was hidden`);
    if (rows.some(row =>
      row.familyKey !== test.expectedFamily ||
      row.dimensions?.state !== state ||
      !supported.some(variant => variant.id === row.id)
    )) failures.push(`${test.query}: substituted an unsupported identity/state`);
  }
  if (test.firstFamily && first?.familyKey !== test.firstFamily) {
    failures.push(`${test.query}: expected first family ${test.firstFamily}`);
  }
  if (test.requiredFamilies?.some(key => !rows.some(row => row.familyKey === key))) {
    failures.push(`${test.query}: a familiar family disappeared from the broad result page`);
  }
  if (test.familiesBeforeSingletons) {
    const firstSingleton = rows.findIndex(row => !row.familyKey);
    if (firstSingleton >= 0 && rows.slice(firstSingleton).some(row => row.familyKey)) {
      failures.push(`${test.query}: technical singleton ranked ahead of a reviewed family`);
    }
  }
  if (test.expectEmpty && rows.length) failures.push(`${test.query}: expected empty`);
  if (test.correctedQuery && value.resolution?.correctedQuery !== test.correctedQuery) {
    failures.push(`${test.query}: correction mismatch`);
  }
  if (test.suggestions && !test.suggestions.every(s => value.resolution?.suggestions?.includes(s))) {
    failures.push(`${test.query}: suggestion mismatch`);
  }
  const names = rows.map(row => row.name.toLowerCase());
  if (test.requiredTokens && (
    !first || !test.requiredTokens.every(token => first.name.toLowerCase().includes(token))
  )) failures.push(`${test.query}: requested dish is not the first result`);
  if (test.approvedOnly && rows.some(row => !row.approvals?.length)) {
    failures.push(`${test.query}: ineligible approval entered the page`);
  }
  if (test.forbidden?.some(token => names.some(name => name.includes(token)))) {
    failures.push(`${test.query}: forbidden result`);
  }
  if (test.forbiddenFamilies?.some(key => rows.some(row => row.familyKey === key))) {
    failures.push(`${test.query}: forbidden family`);
  }
  if (test.forbiddenFirstResultTerms?.some(token =>
    first?.name?.toLowerCase().includes(token.toLowerCase())
  )) failures.push(`${test.query}: forbidden first result`);
}
if (failures.length) throw new Error(`corpus failures (${failures.length}): ${failures.slice(0, 12).join("; ")}`);
const paging = await query(`select jsonb_build_object(
  'first',search_food_catalog_grouped(null,'chicken',false,6,0),
  'second',search_food_catalog_grouped(null,'chicken',false,6,6),
  'lookahead',search_food_catalog_grouped(null,'chicken',false,7,0),
  'bridge',search_food_catalog_grouped(null,'chicken',false,6,3)
) result`);
const firstKeys = new Set(paging.first.map(row => row.resultKey));
if (paging.first.length !== 6 || paging.second.length === 0 ||
    paging.second.length > 6 || paging.second.some(row => firstKeys.has(row.resultKey))) {
  throw new Error("pagination limit/offset contract failed");
}
const combined = [...paging.first, ...paging.second].map(row => row.resultKey);
if (JSON.stringify(combined.slice(0, 7)) !==
    JSON.stringify(paging.lookahead.map(row => row.resultKey)) ||
    JSON.stringify(combined.slice(3, 9)) !==
    JSON.stringify(paging.bridge.map(row => row.resultKey))) {
  throw new Error("pagination skipped or reordered a result");
}
const report = {
  verifiedAt: new Date().toISOString(),
  cases: cases.length,
  distinctQueries: new Set(cases.map(test => test.query)).size,
  assertions: "Every case checks bounded unique identities and limit-one stability; exact names pin source/revision, prepared queries pin available tuples, explicit expectations all enforced.",
  failures: 0,
  paginationFirst: paging.first.length,
  paginationSecond: paging.second.length,
  paginationSkippedOrRepeated: 0,
};
if (values.output) await writeFile(resolve(values.output), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));