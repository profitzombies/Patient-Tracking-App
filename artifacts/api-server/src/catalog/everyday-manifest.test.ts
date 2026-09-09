import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../../");
const manifest = JSON.parse(readFileSync(path.join(
  root, "docs/food-library-cleanup/everyday-food-identities-v3.json",
), "utf8")) as {
  categories: string[];
  categorySize: number;
  sourceIds: number[];
  displayNames: string[];
  sourceEvidence: {
    distinctRecords: number;
    numericNutrientsReviewed: number;
    sourcePortionsReviewed: number;
    orderedRawRecordMd5Sha256: string;
  };
};
const corpus = JSON.parse(readFileSync(path.join(
  root, "docs/food-library-cleanup/golden-query-corpus-v3.json",
), "utf8")) as {
  generatedCases: Array<{ count: number }>;
  explicitCases: Array<{ query: string }>;
  distinctQueryMinimum: number;
};
const integrityMigration = readFileSync(path.join(
  root,
  "supabase/migrations/20261005030000_everyday_food_snapshot_and_constraint_integrity.sql",
), "utf8");
const ratioMigration = readFileSync(path.join(
  root,
  "supabase/migrations/20261005040000_everyday_food_ratio_null_guard.sql",
), "utf8");

describe("everyday food review manifest", () => {
  it("pins 100 distinct identities evenly across all ten required categories", () => {
    expect(manifest.categories).toHaveLength(10);
    expect(manifest.categorySize).toBe(10);
    expect(manifest.sourceIds).toHaveLength(100);
    expect(manifest.displayNames).toHaveLength(100);
    expect(new Set(manifest.sourceIds).size).toBe(100);
    expect(new Set(manifest.displayNames).size).toBe(100);
    expect(manifest.sourceEvidence.distinctRecords).toBe(100);
    expect(manifest.sourceEvidence.numericNutrientsReviewed).toBeGreaterThan(10_000);
    expect(manifest.sourceEvidence.sourcePortionsReviewed).toBeGreaterThan(250);
    expect(manifest.sourceEvidence.orderedRawRecordMd5Sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("defines a reproducible corpus comfortably above 250 distinct searches", () => {
    const generatedCount = corpus.generatedCases.reduce((sum, rule) => sum + rule.count, 0);
    expect(generatedCount + corpus.explicitCases.length).toBeGreaterThanOrEqual(320);
    expect(corpus.distinctQueryMinimum).toBeGreaterThanOrEqual(250);
    expect(new Set(corpus.explicitCases.map(test => test.query)).size)
      .toBe(corpus.explicitCases.length);
  });

  it("preserves source quantities and rejects unsupported explicit tuples", () => {
    expect(integrityMigration).toContain("source amount and descriptor preserved");
    expect(integrityMigration).toContain("p->>'label'='4 oz'");
    expect(integrityMigration).toContain("'provenance','generic_source'");
    expect(integrityMigration).toContain("food_catalog_variant_explicit_constraints_match");
    expect(ratioMigration).toContain("not coalesce");
    expect(corpus.explicitCases.some(test => test.query === "77/23 ground turkey")).toBe(true);
    expect(corpus.explicitCases.some(test => test.query === "poached broccoli")).toBe(true);
  });
});