import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CATALOG_SEARCH_BURST = "500";
  process.env.CATALOG_SEARCH_DAILY_BUDGET = "5000";
});

const auth = vi.hoisted(() => ({
  resolvePatient: vi.fn(async (): Promise<
    | { ok: true; patientId: string; authUserId: string }
    | { ok: false; status: number; error: string }
  > => ({ ok: true, patientId: "patient-1", authUserId: "user-1" })),
}));
vi.mock("../lib/patient-auth", () => ({ resolvePatient: auth.resolvePatient }));

const store = vi.hoisted(() => ({
  searchCatalog: vi.fn(async (): Promise<any[]> => []),
  searchCatalogGrouped: vi.fn<typeof import("../catalog/store").searchCatalogGrouped>(async () => []),
  getCatalogFamily: vi.fn(async (): Promise<any[]> => []),
  getCatalogItem: vi.fn(),
  recordSelection: vi.fn(),
  upsertOffCatalogItem: vi.fn(),
}));
vi.mock("../catalog/store", () => store);
const recognition = vi.hoisted(() => ({
  resolveCatalogQuery: vi.fn(async (query: string): Promise<{
    query: string; suggestions: string[]; correctedQuery?: string;
  }> => ({ query, suggestions: [] })),
}));
vi.mock("../catalog/query-resolution", () => recognition);

const off = vi.hoisted(() => ({
  searchOffProducts: vi.fn(),
  fetchOffProduct: vi.fn(),
}));
vi.mock("../barcode/off", () => off);
const facts = vi.hoisted(() => ({ upsertBarcodeFactsRecord: vi.fn() }));
vi.mock("../barcode/facts-store", () => facts);

import catalogRouter, { clearCatalogSearchCache, shouldSearchOff } from "./catalog";

const PRODUCT = {
  code: "3017624010701",
  product_name: "Nutella Hazelnut Spread",
  brands: "Ferrero",
  serving_size: "15 g",
  serving_quantity: 15,
  serving_quantity_unit: "g",
  nutrition_data_per: "100g",
  nutriments: {
    "energy-kcal_100g": 539,
    proteins_100g: 6.3,
    carbohydrates_100g: 57.5,
    fat_100g: 30.9,
  },
};

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(catalogRouter);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, error => error ? reject(error) : resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
afterEach(() => {
  vi.clearAllMocks();
  clearCatalogSearchCache();
  auth.resolvePatient.mockResolvedValue({ ok: true, patientId: "patient-1", authUserId: "user-1" });
  store.searchCatalog.mockResolvedValue([]);
  store.searchCatalogGrouped.mockResolvedValue([]);
  store.getCatalogFamily.mockResolvedValue([]);
  recognition.resolveCatalogQuery.mockImplementation(async query => ({ query, suggestions: [] }));
});

describe("catalog fallback guard", () => {
  it("rejects stale broad typing and accepts specific or explicit branded searches", () => {
    expect(shouldSearchOff("ri", false)).toBe(false);
    expect(shouldSearchOff("rice", false)).toBe(false);
    expect(shouldSearchOff("Nature Valley", false)).toBe(true);
    expect(shouldSearchOff("Oreo", true)).toBe(true);
  });
});

describe("catalog routes", () => {
  it("groups before the six-result limit and returns a version-bound cursor", async () => {
    store.searchCatalogGrouped.mockResolvedValue(Array.from({ length: 7 }, (_, index) => ({
      id: `food-${index}`, kind: "generic", name: `Family ${index}`, brand: null,
      serving: "100 g", serving_grams: 100, calories: 100, protein: 10, carbs: 10,
      fat: 2, measures: [], source: "usda_fdc", source_id: String(index),
      barcode: null, quality_status: "reviewed", approvals: [],
      resultKey: index === 0 ? "family:everyday-pasta" : `family:family-${index}`,
      familyKey: index === 0 ? "everyday-pasta" : `family-${index}`,
      ...(index === 0 ? { familyKeyAliases: ["bulk-cooked-pasta"] } : {}),
      variantSummary: "Reviewed default", dimensions: {}, choiceRequired: false,
      nutritionSnapshot: { version: 1 },
    })));
    const response = await fetch(`${base}/catalog/search?q=chicken&grouped=true&limit=6&approvedOnly=true`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      results: unknown[]; hasMore: boolean; nextCursor: string; rankingVersion: string;
    };
    expect(store.searchCatalogGrouped).toHaveBeenCalledWith("patient-1", "chicken", true, 7, 0);
    expect(recognition.resolveCatalogQuery).toHaveBeenCalledWith("chicken", "patient-1");
    expect(body.results).toHaveLength(6);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toEqual(expect.any(String));
    expect(body.rankingVersion).toBe("food-families-v7");
    expect(body.results[0]).toMatchObject({
      familyKey: "everyday-pasta",
      familyKeyAliases: ["bulk-cooked-pasta"],
    });
    expect(body.results[1]).not.toHaveProperty("familyKeyAliases");

    const next = await fetch(`${base}/catalog/search?q=chicken&grouped=true&limit=6&approvedOnly=true&cursor=${encodeURIComponent(body.nextCursor)}`);
    expect(next.status).toBe(200);
    expect(store.searchCatalogGrouped).toHaveBeenLastCalledWith("patient-1", "chicken", true, 7, 6);
  });

  it("rejects a cursor when the query context changes", async () => {
    store.searchCatalogGrouped.mockResolvedValue(Array.from({ length: 7 }, (_, index) => ({
      id: `food-${index}`, kind: "generic", name: `Food ${index}`, brand: null,
      serving: "100 g", serving_grams: 100, calories: 1, protein: 1, carbs: 1, fat: 1,
      measures: [], source: "usda_fdc", source_id: String(index), barcode: null,
      quality_status: "reviewed", approvals: [],
    })));
    const first = await fetch(`${base}/catalog/search?q=rice&grouped=true`);
    const cursor = (await first.json() as { nextCursor: string }).nextCursor;
    const changed = await fetch(`${base}/catalog/search?q=apple&grouped=true&cursor=${encodeURIComponent(cursor)}`);
    expect(changed.status).toBe(400);
    expect(await changed.json()).toEqual({ error: "Search changed. Please restart this food search." });
  });

  it("returns complete source-specific family variants", async () => {
    store.getCatalogFamily.mockResolvedValue([{
      id: "apple-1", kind: "generic", name: "Apples", brand: null, serving: "100 g",
      serving_grams: 100, calories: 52, protein: 0.26, carbs: 13.81, fat: 0.17,
      measures: [], source: "usda_fdc", source_id: "2709215", barcode: null,
      quality_status: "reviewed", approvals: [], resultKey: "family:apples:apple-1",
      familyKey: "everyday-pasta", variantSummary: "Raw", dimensions: { state: "raw" },
      familyKeyAliases: ["bulk-cooked-pasta"],
      choiceRequired: false, nutritionSnapshot: { version: 1 },
    }, {
      id: "apple-2", kind: "generic", name: "Apples", brand: null, serving: "100 g",
      serving_grams: 100, calories: 48, protein: 0.2, carbs: 12.8, fat: 0.1,
      measures: [], source: "usda_fdc", source_id: "alternate", barcode: null,
      quality_status: "reviewed", approvals: [], resultKey: "family:apples:apple-2",
      familyKey: "everyday-pasta", variantSummary: "Prepared", dimensions: { form: "prepared" },
      familyKeyAliases: ["bulk-cooked-pasta"],
      choiceRequired: false, nutritionSnapshot: { version: 1 },
    }]);
    const response = await fetch(`${base}/catalog/families/bulk-cooked-pasta?approvedOnly=false`);
    expect(response.status).toBe(200);
    expect(store.getCatalogFamily).toHaveBeenCalledWith("bulk-cooked-pasta", false);
    const body = await response.json() as { variants: Array<Record<string, unknown>> };
    expect(body.variants[0]).toMatchObject({
      familyKey: "everyday-pasta", familyKeyAliases: ["bulk-cooked-pasta"],
      sourceId: "2709215", nutritionSnapshot: { version: 1 },
    });
    expect(body.variants[1].familyKeyAliases).toEqual(["bulk-cooked-pasta"]);
    expect(body.variants).toHaveLength(2);
  });

  it("returns one family representative for an explicitly constrained beef query", async () => {
    store.searchCatalogGrouped.mockResolvedValue([{
      id: "beef-90-cooked", kind: "generic", name: "Ground Beef", brand: null,
      serving: "100 g", serving_grams: 100, calories: 230, protein: 28, carbs: 0, fat: 12,
      measures: [], source: "usda_fdc", source_id: "171794", barcode: null,
      quality_status: "reviewed", approvals: [], resultKey: "family:ground-beef",
      familyKey: "ground-beef", variantSummary: "90% lean / 10% fat · Cooked, pan-browned crumbles",
      dimensions: { leanness: "90% lean / 10% fat", state: "cooked" },
      choiceRequired: false, nutritionSnapshot: { version: 1 },
    }]);
    const response = await fetch(`${base}/catalog/search?q=90%2F10%20cooked%20ground%20beef&grouped=true`);
    expect(response.status).toBe(200);
    const body = await response.json() as { results: Array<Record<string, unknown>> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      resultKey: "family:ground-beef",
      familyKey: "ground-beef",
      sourceId: "171794",
      dimensions: { leanness: "90% lean / 10% fat", state: "cooked" },
    });
  });

  it("returns local results without calling OFF for a broad generic query", async () => {
    store.searchCatalog.mockResolvedValue([{
      id: "generic-1", kind: "generic", name: "Cooked white rice", brand: null,
      serving: "1 cup (158 g)", serving_grams: 158, calories: 205, protein: 4.3,
      carbs: 44.5, fat: 0.4, measures: [], source: "usda_fdc", source_id: "169756",
      barcode: null, quality_status: "reviewed", approvals: [],
    }]);
    const response = await fetch(`${base}/catalog/search?q=rice`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { results: unknown[] }).results).toHaveLength(1);
    expect(off.searchOffProducts).not.toHaveBeenCalled();
  });

  it("keeps packaged products behind the intentional packaged search choice", async () => {
    off.searchOffProducts.mockResolvedValue({ kind: "found", products: [{ ...PRODUCT, brands: "Heinz", product_name: "Heinz Ketchup" }] });
    const response = await fetch(`${base}/catalog/search?q=Heinz%20Ketchup&grouped=true&branded=true`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [], hasMore: false });
    expect(off.searchOffProducts).not.toHaveBeenCalled();
    const packaged = await fetch(`${base}/catalog/search?q=Heinz%20Ketchup&grouped=true&intent=packaged`);
    const body = await packaged.json() as { results: Array<{ brand: string | null }> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0].brand).toBe("Heinz");
    expect(off.searchOffProducts).toHaveBeenCalledWith("Heinz Ketchup", 20, undefined, 1);
  });

  it("advances packaged OFF pages without repeating product ids", async () => {
    off.searchOffProducts.mockImplementation(async () => ({
      kind: "found",
      products: Array.from({ length: 20 }, (_, index) => ({
        ...PRODUCT,
        code: `30176240${String(10000 + index).slice(-5)}`,
        product_name: `Packaged ${index}`,
      })),
    }));
    const first = await fetch(`${base}/catalog/search?q=Heinz&grouped=true&intent=packaged&limit=2`);
    const firstBody = await first.json() as { results: Array<{ id: string }>; nextCursor: string };
    const second = await fetch(`${base}/catalog/search?q=Heinz&grouped=true&intent=packaged&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`);
    const secondBody = await second.json() as { results: Array<{ id: string }> };
    expect(new Set(firstBody.results.map(value => value.id))).not.toEqual(new Set(secondBody.results.map(value => value.id)));
    expect(off.searchOffProducts).toHaveBeenCalledTimes(1);
    expect(off.searchOffProducts).toHaveBeenCalledWith("Heinz", 20, undefined, 1);
  });

  it("does not interleave product results into a short basic food page", async () => {
    const local = Array.from({ length: 4 }, (_, index): import("../catalog/store").CatalogItem => ({
      id: `local-${index}`, kind: "generic", name: `Heinz local ${index}`, brand: null,
      serving: "100 g", serving_grams: 100, calories: 1, protein: 1, carbs: 1, fat: 1,
      measures: [], source: "usda_fdc", source_id: `local-${index}`, barcode: null,
      quality_status: "reviewed", approvals: [],
    }));
    store.searchCatalogGrouped.mockImplementation(async (_patient, _query, _approved, _limit, offset) => offset === 0 ? local : []);
    off.searchOffProducts.mockResolvedValue({
      kind: "found",
      products: Array.from({ length: 20 }, (_, index) => ({
        ...PRODUCT, code: `30176241${String(10000 + index).slice(-5)}`, product_name: `Heinz OFF ${index}`,
      })),
    });
    const first = await fetch(`${base}/catalog/search?q=Heinz&grouped=true&branded=true&limit=6`);
    const firstBody = await first.json() as { results: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean };
    expect(firstBody.results.map(row => row.id)).toEqual([
      "local-0", "local-1", "local-2", "local-3",
    ]);
    expect(firstBody.hasMore).toBe(false);
    expect(firstBody.nextCursor).toBeNull();
    expect(off.searchOffProducts).not.toHaveBeenCalled();
  });

  it("offers ambiguous wording for explicit selection rather than searching another food", async () => {
    recognition.resolveCatalogQuery.mockResolvedValue({
      query: "pea", suggestions: ["Peas", "Pears"],
    });
    const response = await fetch(`${base}/catalog/search?q=pea&grouped=true`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      results: [], querySuggestions: ["Peas", "Pears"], hasMore: false, nextCursor: null,
    });
    expect(store.searchCatalogGrouped).not.toHaveBeenCalled();
    expect(off.searchOffProducts).not.toHaveBeenCalled();
  });

  it("uses an unambiguous spelling correction without changing the cursor's original input", async () => {
    recognition.resolveCatalogQuery.mockResolvedValue({
      query: "broccoli", suggestions: [], correctedQuery: "broccoli",
    });
    store.searchCatalogGrouped.mockResolvedValue(Array.from({ length: 7 }, (_, index) => ({
      id: `food-${index}`, kind: "generic", name: `Food ${index}`, brand: null,
      serving: "100 g", serving_grams: 100, calories: 1, protein: 1, carbs: 1, fat: 1,
      measures: [], source: "usda_fdc", source_id: String(index), barcode: null,
      quality_status: "reviewed", approvals: [],
    })));
    const first = await fetch(`${base}/catalog/search?q=brocoli&grouped=true`);
    const body = await first.json() as { correctedQuery: string; nextCursor: string };
    expect(body.correctedQuery).toBe("broccoli");
    expect(store.searchCatalogGrouped).toHaveBeenLastCalledWith("patient-1", "broccoli", false, 7, 0);
    const next = await fetch(`${base}/catalog/search?q=brocoli&grouped=true&cursor=${encodeURIComponent(body.nextCursor)}`);
    expect(next.status).toBe(200);
    expect(store.searchCatalogGrouped).toHaveBeenLastCalledWith("patient-1", "broccoli", false, 7, 6);
  });

  it("never calls packaged search to fill an unsupported or Approved-only query", async () => {
    for (const suffix of [
      "q=raw%20apple%20pie&grouped=true&branded=true",
      "q=ground%20turkey&grouped=true&branded=true",
      "q=Heinz&grouped=true&intent=packaged&approvedOnly=true",
    ]) {
      const response = await fetch(`${base}/catalog/search?${suffix}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ results: [], hasMore: false });
    }
    expect(off.searchOffProducts).not.toHaveBeenCalled();
  });

  it("scans past a raw OFF page of invalid rows to find eligible products", async () => {
    off.searchOffProducts.mockImplementation(async (_query, _limit, _log, page) => ({
      kind: "found",
      products: page === 1
        ? Array.from({ length: 20 }, (_, index) => ({ code: `30176242${String(10000 + index).slice(-5)}` }))
        : [{ ...PRODUCT, code: "3017624299999", product_name: "Eligible Heinz" }],
    }));
    const response = await fetch(`${base}/catalog/search?q=Heinz&grouped=true&intent=packaged&limit=1`);
    const body = await response.json() as { results: Array<{ id: string }>; hasMore: boolean };
    expect(body.results.map(row => row.id)).toEqual(["off:3017624299999"]);
    expect(body.hasMore).toBe(false);
    expect(off.searchOffProducts).toHaveBeenNthCalledWith(1, "Heinz", 20, undefined, 1);
    expect(off.searchOffProducts).toHaveBeenNthCalledWith(2, "Heinz", 20, undefined, 2);
  });

  it("allows the signed-out guided demo to read only the shared catalog", async () => {
    auth.resolvePatient.mockResolvedValue({ ok: false, status: 401, error: "Sign in required." });
    store.searchCatalog.mockResolvedValue([]);
    const response = await fetch(`${base}/catalog/search?q=Nutella%20Ferrero&branded=true`);
    expect(response.status).toBe(200);
    expect(store.searchCatalog).toHaveBeenCalledWith(null, "Nutella Ferrero", 20);
    expect(off.searchOffProducts).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ results: [], externalUnavailable: false });
  });

  it("ranks reviewed wing identities first while retaining canonical USDA details and weight measures", async () => {
    off.searchOffProducts.mockResolvedValue({ kind: "found", products: [] });
    store.searchCatalog.mockResolvedValue([
      {
        id: "technical", kind: "generic", name: "Chicken, broilers, giblets, cooked", brand: null,
        serving: "100 g", serving_grams: 100, calories: 200, protein: 20, carbs: 0, fat: 12,
        measures: [{ label: "100 g", grams: 100 }], source: "usda_fdc", source_id: "other",
        barcode: null, quality_status: "reviewed", approvals: [],
      },
      {
        id: "wing", kind: "generic",
        name: "Chicken wing, meat and skin, cooked, roasted", brand: null,
        serving: "100 g", serving_grams: 100, calories: 254, protein: 23.8, carbs: 0, fat: 16.9,
        measures: [{ label: "100 g", grams: 100 }, { label: "1 oz", grams: 28.349523125 }],
        source: "usda_fdc", source_id: "173630", barcode: null,
        quality_status: "reviewed", approvals: [],
      },
    ]);
    const response = await fetch(`${base}/catalog/search?q=chicken%20wings`, {
      headers: { Authorization: "Bearer test" },
    });
    const body = await response.json() as { results: unknown[] };
    expect(body.results[0]).toMatchObject({
        id: "wing",
        name: "Chicken Wings, Roasted (Meat and Skin)",
        canonicalName: "Chicken wing, meat and skin, cooked, roasted",
        servingGrams: 100,
        measures: [{ label: "100 g", grams: 100 }, { label: "1 oz", grams: 28.349523125 }],
        source: "usda_fdc",
    });
  });

  it("returns an owner-private food under its canonical raw id", async () => {
    store.searchCatalog.mockResolvedValue([{
      id: "custom_mf2k1x_7", kind: "personal", name: "My private soup", brand: null,
      serving: "1 bowl", serving_grams: null, calories: 120, protein: 6, carbs: 15,
      fat: 4, measures: [], source: "patient", source_id: "custom_mf2k1x_7",
      barcode: null, quality_status: "private", approvals: [],
      nutrition_snapshot: { version: 1 }, catalog_metadata: { configuration: "saved" },
    }]);
    const response = await fetch(`${base}/catalog/search?q=private`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(await response.json()).toMatchObject({
      results: [{
        id: "custom_mf2k1x_7", source: "patient", qualityStatus: "private",
        nutritionSnapshot: { version: 1 }, catalogMetadata: { configuration: "saved" },
      }],
    });
  });

  it("normalizes and deduplicates external results but does not persist search results", async () => {
    off.searchOffProducts.mockResolvedValue({ kind: "found", products: [PRODUCT, PRODUCT] });
    const response = await fetch(`${base}/catalog/search?q=Nutella%20Ferrero`, {
      headers: { Authorization: "Bearer test" },
    });
    const body = await response.json() as { results: Array<{ id: string }> };
    expect(body.results.map(row => row.id)).toEqual(["off:3017624010701"]);
    expect(store.upsertOffCatalogItem).not.toHaveBeenCalled();
    expect(facts.upsertBarcodeFactsRecord).not.toHaveBeenCalled();
  });

  it("promotes a validated external product only when selected and updates barcode compatibility", async () => {
    off.fetchOffProduct.mockResolvedValue({ kind: "found", product: PRODUCT });
    store.upsertOffCatalogItem.mockResolvedValue({
      id: "catalog-1", kind: "branded", name: "Nutella Hazelnut Spread", brand: "Ferrero",
      serving: "15 g", serving_grams: null, calories: 81, protein: 0.9, carbs: 8.6,
      fat: 4.6, measures: [], source: "openfoodfacts", source_id: "3017624010701",
      barcode: "3017624010701", quality_status: "community_verified", approvals: [],
    });
    const response = await fetch(`${base}/catalog/selections`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ id: "off:3017624010701" }),
    });
    expect(response.status).toBe(200);
    expect(store.upsertOffCatalogItem).toHaveBeenCalledTimes(1);
    expect(facts.upsertBarcodeFactsRecord).toHaveBeenCalledWith(expect.objectContaining({
      code: "3017624010701", source: "openfoodfacts",
    }));
    expect(store.recordSelection).toHaveBeenCalledWith("patient-1", "catalog-1");
  });

  it("returns approval metadata when a reviewed generic is selected", async () => {
    store.getCatalogItem.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111", kind: "generic", name: "Chicken breast",
      brand: null, serving: "3 oz (85 g)", serving_grams: 85, calories: 128, protein: 26,
      carbs: 0, fat: 2.7, measures: [], source: "usda_fdc", source_id: "171477",
      barcode: null, quality_status: "reviewed", approvals: [{
        id: "approved-chicken", name: "Official approved name", portion: null,
        phaseGuidance: null, constraints: { preparation: "skinless", lean: true },
      }],
    });
    const response = await fetch(`${base}/catalog/selections`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      food: { approvals: [{
        id: "approved-chicken", portion: null, phaseGuidance: null,
        constraints: { preparation: "skinless", lean: true },
      }] },
    });
  });

  it("never promotes a patient-private custom food", async () => {
    const response = await fetch(`${base}/catalog/selections`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ id: "custom_mine" }),
    });
    expect(await response.json()).toEqual({ selectedId: "custom_mine", persisted: false });
    expect(store.getCatalogItem).not.toHaveBeenCalled();
    expect(store.recordSelection).not.toHaveBeenCalled();
  });
});