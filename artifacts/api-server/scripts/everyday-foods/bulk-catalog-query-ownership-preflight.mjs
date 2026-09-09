#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { findQueryOwnershipConflicts } from "./bulk-catalog-lib.mjs";

const { values } = parseArgs({ options: {
  manifest: { type: "string" },
  "extra-corpus": { type: "string", multiple: true },
  reconciliation: { type: "string" },
  output: { type: "string" },
} });
const root = resolve(import.meta.dirname, "../../../../");
const readJson = async path => JSON.parse(await readFile(resolve(path), "utf8"));
const manifest = await readJson(values.manifest ??
  resolve(root, "docs/food-library-cleanup/bulk-catalog-manifest-v1.json"));
const identities = await readJson(resolve(
  root, "docs/food-library-cleanup/everyday-food-identities-v3.json"));
const spec = await readJson(resolve(
  root, "docs/food-library-cleanup/golden-query-corpus-v3.json"));
const originalCases = spec.generatedCases.flatMap(rule =>
  identities.displayNames.map(name => ({
    query: rule.template.replace("{identity}", name.toLowerCase()),
    expect: rule.expect,
    expectedFamily: `everyday-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  })));
const extraCases = (await Promise.all((values["extra-corpus"] ?? []).map(readJson))).flat();
const reconciliation = values.reconciliation
  ? await readJson(values.reconciliation) : { familyRedirects: [] };
const conflicts = findQueryOwnershipConflicts(
  manifest,
  [...originalCases, ...spec.explicitCases, ...extraCases],
  reconciliation.familyRedirects,
);
const report = {
  valid: conflicts.length === 0,
  manifestVersion: manifest.version,
  policy: "Literal punctuation/spacing is normalized; modifier words are retained. Contradictory ownership is flagged for review, never auto-merged.",
  conflicts,
};
const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (values.output) await writeFile(resolve(values.output), rendered);
console.log(rendered.trim());
if (!report.valid) process.exitCode = 1;