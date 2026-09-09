#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../../../");
const manifest = JSON.parse(await readFile(
  resolve(root, "docs/food-library-cleanup/everyday-food-identities-v3.json"),
  "utf8",
));
const spec = JSON.parse(await readFile(
  resolve(root, "docs/food-library-cleanup/golden-query-corpus-v3.json"),
  "utf8",
));

if (manifest.sourceIds.length !== 100 || manifest.displayNames.length !== 100) {
  throw new Error("everyday identity manifest must contain 100 aligned identities");
}
const generated = spec.generatedCases.flatMap(rule =>
  manifest.displayNames.map((name, index) => ({
    query: rule.template.replace("{identity}", name.toLowerCase()),
    expect: rule.expect,
    expectedFamily: `everyday-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    sourceId: String(manifest.sourceIds[index]),
  })),
);
const cases = [...generated, ...spec.explicitCases];
const distinct = new Set(cases.map(test => test.query.trim().toLowerCase()));
if (distinct.size < spec.distinctQueryMinimum) {
  throw new Error(`golden corpus has only ${distinct.size} distinct queries`);
}
const output = process.argv[2];
if (output) await writeFile(resolve(output), `${JSON.stringify(cases, null, 2)}\n`);
console.log(JSON.stringify({ cases: cases.length, distinctQueries: distinct.size }));