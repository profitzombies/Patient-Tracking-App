import { describe, expect, it } from "vitest";
import {
  findProduct,
  loadProductCatalog,
  matchProducts,
  productCardPayload,
  productGroundingText,
} from "./products";

describe("product catalog", () => {
  it("loads the curated catalog with unique ids and complete entries", () => {
    const catalog = loadProductCatalog();
    expect(catalog.length).toBe(9);
    const ids = catalog.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const product of catalog) {
      expect(product.name.length).toBeGreaterThan(0);
      expect(product.description.length).toBeGreaterThan(0);
      expect(product.price).toBeGreaterThan(0);
      expect(product.facts.length).toBeGreaterThan(0);
      expect(product.topics.length).toBeGreaterThan(0);
      expect(product.sourceUrl.startsWith("https://getthinnr.com/products/")).toBe(true);
      expect(product.sourceNote.length).toBeGreaterThan(0);
    }
  });
});

describe("matchProducts", () => {
  it("offers Creatine+ for a muscle-building message", () => {
    const ids = matchProducts("I've been lifting and want to build muscle").map((p) => p.id);
    expect(ids).toContain("prod7");
  });

  it("offers nothing for ordinary program questions", () => {
    expect(matchProducts("What should I eat today?")).toEqual([]);
    expect(matchProducts("Is grapefruit approved?")).toEqual([]);
    expect(matchProducts("What phase am I in right now?")).toEqual([]);
  });

  it("matches phrases across punctuation differences", () => {
    const ids = matchProducts("Should I take creatine+ daily?").map((p) => p.id);
    expect(ids).toContain("prod7");
    const glp = matchProducts("I'm also on a GLP-1 right now").map((p) => p.id);
    expect(glp).toContain("prod2");
  });

  it("respects word boundaries", () => {
    // "fiberglass" must not look like the Fiber product topic.
    expect(matchProducts("My tub is fiberglass").map((p) => p.id)).not.toContain("prod8");
  });

  it("can offer multiple products when the message spans topics", () => {
    const ids = matchProducts(
      "I want to build muscle and my blood sugar spikes after meals",
    ).map((p) => p.id);
    expect(ids).toContain("prod7");
    expect(ids).toContain("prod5");
  });
});

describe("findProduct / productCardPayload", () => {
  it("finds catalog products by id and rejects unknown ids", () => {
    expect(findProduct("prod7")?.name).toBe("Creatine+");
    expect(findProduct("prod999")).toBeUndefined();
  });

  it("builds the card payload from catalog fields only", () => {
    const product = findProduct("prod7");
    expect(product).toBeDefined();
    expect(productCardPayload(product!)).toEqual({
      id: "prod7",
      name: "Creatine+",
      line: product!.cardLine,
      price: product!.price,
    });
  });
});

describe("productGroundingText", () => {
  it("contains verbatim catalog copy, prices, and sources", () => {
    const text = productGroundingText();
    expect(text).toContain("Creatine+: Powerful Muscle & Mind Support");
    expect(text).toContain("Price: $55 (demo pricing)");
    expect(text).toContain("(Source: https://getthinnr.com/products/creatine-plus)");
  });

  it("leaves editorial metadata (ids, topics) out of the grounding text", () => {
    const text = productGroundingText();
    expect(text).not.toContain("prod7");
    expect(text).not.toContain('"topics"');
  });
});
