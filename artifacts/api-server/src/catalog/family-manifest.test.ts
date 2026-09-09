import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface Variant {
  familyKey: string;
  variantSummary: string;
  dimensions: Record<string, string>;
  source: { release: string; recordId: string; revision: string };
  nutrients: Array<{ id: string; amount: number }>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.resolve(
  here,
  "../../../../docs/usda-import/reviewed-food-family-variants-v2.json",
), "utf8")) as { entries: Variant[] };
const family = (key: string) => manifest.entries.filter(entry => entry.familyKey === key);

describe("reviewed food family source manifest", () => {
  it("pins distinct raw and cooked records for every supported beef leanness", () => {
    const beef = family("ground-beef");
    expect(beef).toHaveLength(9);
    for (const lean of ["80%", "85%", "90%", "95%"]) {
      const variants = beef.filter(entry => entry.dimensions.leanness.startsWith(lean));
      expect(variants.map(entry => entry.dimensions.state).sort()).toEqual(["cooked", "raw"]);
      expect(new Set(variants.map(entry => entry.source.recordId)).size).toBe(2);
    }
  });

  it("contains genuine poultry, egg, rice, and yogurt alternatives", () => {
    expect(new Set(family("chicken-breast").map(entry => entry.dimensions.skin)))
      .toEqual(new Set(["eaten", "not eaten"]));
    expect(family("chicken-breast").some(entry => entry.dimensions.preparation === "grilled")).toBe(true);
    expect(new Set(family("chicken-thighs").map(entry => entry.dimensions.skin)))
      .toEqual(new Set(["eaten", "not eaten"]));
    expect(new Set(family("chicken-wings").map(entry => entry.dimensions.preparation)))
      .toEqual(new Set(["baked, broiled, or roasted", "fried", "raw"]));
    for (const key of ["chicken-breast", "chicken-thighs", "chicken-wings"]) {
      expect(new Set(family(key).map(entry => entry.dimensions.state)))
        .toEqual(new Set(["cooked", "raw"]));
    }
    expect(new Set(family("eggs").map(entry => entry.dimensions.form)))
      .toEqual(new Set(["whole", "white"]));
    expect(new Set(family("rice").map(entry => entry.dimensions.state)))
      .toEqual(new Set(["cooked", "dry"]));
    expect(new Set(family("yogurt").map(entry => entry.dimensions["fat level"])))
      .toEqual(new Set(["whole milk", "low fat", "skim milk"]));
  });

  it("pins revisions and complete unrounded source macro baselines", () => {
    for (const entry of manifest.entries) {
      expect(entry.source.revision).toBe(`${entry.source.release}:${entry.source.recordId}`);
      const nutrients = new Map(entry.nutrients.map(nutrient => [nutrient.id, nutrient.amount]));
      for (const id of ["1008", "1003", "1005", "1004"]) {
        expect(nutrients.has(id), `${entry.familyKey}/${entry.source.recordId}/${id}`).toBe(true);
      }
    }
  });
});