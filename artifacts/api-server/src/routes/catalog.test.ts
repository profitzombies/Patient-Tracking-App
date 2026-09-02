import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CATALOG_SEARCH_BURST = "500";
  process.env.CATALOG_SEARCH_DAILY_BUDGET = "5000";
});

const auth = vi.hoisted(() => ({
  resolvePatient: vi.fn(async () => ({ ok: true, patientId: "patient-1", authUserId: "user-1" })),
}));
vi.mock("../lib/patient-auth", () => ({ resolvePatient: auth.resolvePatient }));

const store = vi.hoisted(() => ({
  searchCatalog: vi.fn(async (): Promise<any[]> => []),
  getCatalogItem: vi.fn(),
  recordSelection: vi.fn(),
  upsertOffCatalogItem: vi.fn(),
}));
vi.mock("../catalog/store", () => store);

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

  it("returns an owner-private food under its canonical raw id", async () => {
    store.searchCatalog.mockResolvedValue([{
      id: "custom_mf2k1x_7", kind: "personal", name: "My private soup", brand: null,
      serving: "1 bowl", serving_grams: null, calories: 120, protein: 6, carbs: 15,
      fat: 4, measures: [], source: "patient", source_id: "custom_mf2k1x_7",
      barcode: null, quality_status: "private", approvals: [],
    }]);
    const response = await fetch(`${base}/catalog/search?q=private`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(await response.json()).toMatchObject({
      results: [{ id: "custom_mf2k1x_7", source: "patient", qualityStatus: "private" }],
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