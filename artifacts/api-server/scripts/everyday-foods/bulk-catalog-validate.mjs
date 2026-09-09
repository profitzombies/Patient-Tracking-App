#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateManifest } from "./bulk-catalog-lib.mjs";

const root = resolve(import.meta.dirname, "../../../../");
const source = JSON.parse(await readFile(resolve(root, "docs/food-library-cleanup/bulk-catalog-source-v1.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "docs/food-library-cleanup/bulk-catalog-manifest-v1.json"), "utf8"));
const report = validateManifest(manifest, source, source.existingFamilies);
if (!report.valid) throw new Error(report.errors.join("\n"));
console.log(JSON.stringify(report));