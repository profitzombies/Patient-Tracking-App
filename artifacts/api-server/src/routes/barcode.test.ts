/**
 * Barcode lookup route tests with mocked module boundaries: the facts store
 * is an in-memory map and the Open Food Facts client is a stub, so the
 * suite proves the lookup ORDER (hot cache → shared table → upstream) and
 * the explicit outcomes without any network.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Generous limiter knobs so functional tests never trip the per-IP budget
// (barcode-limits.test.ts drains a tiny budget deliberately, in its own
// module graph). Hoisted: must run before the route module reads them.
vi.hoisted(() => {
  process.env.BARCODE_LOOKUP_BURST = "500";
  process.env.BARCODE_LOOKUP_DAILY_BUDGET = "2000";
});

const factsStore = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    getBarcodeFactsRecord: vi.fn(async (code: string) => rows.get(code) ?? null),
    upsertBarcodeFactsRecord: vi.fn(async (row: { code: string }) => {
      rows.set(row.code, row as Record<string, unknown>);
    }),
  };
});
vi.mock("../barcode/facts-store", () => ({
  getBarcodeFactsRecord: factsStore.getBarcodeFactsRecord,
  upsertBarcodeFactsRecord: factsStore.upsertBarcodeFactsRecord,
}));

const off = vi.hoisted(() => ({ fetchOffProduct: vi.fn() }));
vi.mock("../barcode/off", () => ({ fetchOffProduct: off.fetchOffProduct }));

import barcodeRouter, { clearBarcodeHotCache } from "./barcode";

const NUTELLA_PRODUCT = {
  product_name: "Nutella",
  brands: "Ferrero",
  serving_size: "15 g",
  serving_quantity: 15,
  nutriments: {
    "energy-kcal_serving": 80.4,
    proteins_serving: 0.96,
    carbohydrates_serving: 8.6,
    fat_serving: 4.74,
  },
};

const SEEDED_ROW = {
  code: "0038000138416",
  name: "Corn Flakes",
  brand: "Kellogg's",
  serving: "30 g",
  calories: 114,
  protein: 2.1,
  carbs: 25.2,
  fat: 0.3,
  source: "openfoodfacts",
};

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  const app = express();
  app.use(barcodeRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
);

afterEach(() => {
  factsStore.rows.clear();
  factsStore.getBarcodeFactsRecord.mockClear();
  factsStore.upsertBarcodeFactsRecord.mockClear();
  off.fetchOffProduct.mockReset();
  clearBarcodeHotCache();
});

const lookup = (code: string) => fetch(`${baseUrl}/barcode/${encodeURIComponent(code)}`);

describe("GET /barcode/:code", () => {
  it("answers 400 for non-barcode input without touching table or upstream", async () => {
    for (const bad of ["123", "30176ABC10701", "123456789012345"]) {
      const response = await lookup(bad);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain("barcode");
    }
    expect(factsStore.getBarcodeFactsRecord).not.toHaveBeenCalled();
    expect(off.fetchOffProduct).not.toHaveBeenCalled();
  });

  it("serves a table hit without calling the third party, keying UPC-A to GTIN-13", async () => {
    factsStore.rows.set(SEEDED_ROW.code, SEEDED_ROW);
    // 12-digit UPC-A form of the seeded 13-digit key.
    const response = await lookup("038000138416");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.result).toBe("found");
    expect(body.source).toBe("table");
    expect(body.food).toMatchObject({
      code: "0038000138416",
      name: "Corn Flakes",
      brand: "Kellogg's",
      serving: "30 g",
      calories: 114,
      protein: 2.1,
      carbs: 25.2,
      fat: 0.3,
    });
    expect(off.fetchOffProduct).not.toHaveBeenCalled();
    expect(factsStore.upsertBarcodeFactsRecord).not.toHaveBeenCalled();
  });

  it("looks a miss up in Open Food Facts, normalizes it, and saves it to the shared table", async () => {
    off.fetchOffProduct.mockResolvedValue({ kind: "found", product: NUTELLA_PRODUCT });
    const response = await lookup("3017624010701");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.result).toBe("found");
    expect(body.source).toBe("openfoodfacts");
    expect(body.food).toMatchObject({
      code: "3017624010701",
      name: "Nutella",
      brand: "Ferrero",
      serving: "15 g",
      calories: 80,
      protein: 1,
      carbs: 8.6,
      fat: 4.7,
      nutritionSnapshot: {
        version: 1,
        source: { provider: "Open Food Facts", recordId: "3017624010701" },
        basis: { amount: 1, unit: "serving", label: "15 g", grams: 15 },
        nutrients: expect.arrayContaining([
          { id: "off:energy-kcal", name: "Energy", unit: "kcal", amount: 80.4 },
          { id: "off:proteins", name: "Protein", unit: "g", amount: 0.96 },
        ]),
        selected: { amount: 1, unitId: "serving", scale: 1 },
        provenance: "identified_product",
      },
    });
    expect(factsStore.upsertBarcodeFactsRecord).toHaveBeenCalledTimes(1);
    expect(factsStore.rows.get("3017624010701")).toMatchObject({
      code: "3017624010701",
      name: "Nutella",
      brand: "Ferrero",
      source: "openfoodfacts",
      nutrition_snapshot: expect.objectContaining({ version: 1 }),
    });
  });

  it("serves an immediate repeat from the hot cache without table or upstream", async () => {
    off.fetchOffProduct.mockResolvedValue({ kind: "found", product: NUTELLA_PRODUCT });
    await lookup("3017624010701");
    const repeat = await lookup("3017624010701");
    const body = (await repeat.json()) as Record<string, unknown>;
    expect(body.result).toBe("found");
    expect(body.source).toBe("cache");
    expect(off.fetchOffProduct).toHaveBeenCalledTimes(1);
    expect(factsStore.getBarcodeFactsRecord).toHaveBeenCalledTimes(1);
  });

  it("stores every accepted variant under one canonical key", async () => {
    off.fetchOffProduct.mockResolvedValue({ kind: "found", product: NUTELLA_PRODUCT });
    await lookup("00038000138416"); // GTIN-14 form
    expect(factsStore.rows.has("0038000138416")).toBe(true);
    clearBarcodeHotCache();
    const second = await lookup("038000138416"); // UPC-A form, same article
    const body = (await second.json()) as Record<string, unknown>;
    expect(body.source).toBe("table");
    expect(off.fetchOffProduct).toHaveBeenCalledTimes(1);
  });

  it("still reaches the upstream when the table read fails", async () => {
    factsStore.getBarcodeFactsRecord.mockRejectedValueOnce(new Error("supabase down"));
    off.fetchOffProduct.mockResolvedValue({ kind: "found", product: NUTELLA_PRODUCT });
    const response = await lookup("3017624010701");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.result).toBe("found");
    expect(body.source).toBe("openfoodfacts");
  });

  it("still answers found when the table save fails, and logs it as a miss next time", async () => {
    factsStore.upsertBarcodeFactsRecord.mockRejectedValueOnce(new Error("write denied"));
    off.fetchOffProduct.mockResolvedValue({ kind: "found", product: NUTELLA_PRODUCT });
    const response = await lookup("3017624010701");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.result).toBe("found");
    expect(factsStore.rows.has("3017624010701")).toBe(false);
  });

  it("answers an honest not_found for unknown codes and never saves anything", async () => {
    off.fetchOffProduct.mockResolvedValue({ kind: "not_found" });
    const response = await lookup("9999999999994");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string; message: string };
    expect(body.result).toBe("not_found");
    expect(body.message).toContain("label");
    expect(factsStore.upsertBarcodeFactsRecord).not.toHaveBeenCalled();
    // Not-found outcomes are not hot-cached: a later scan retries the lookup.
    await lookup("9999999999994");
    expect(off.fetchOffProduct).toHaveBeenCalledTimes(2);
  });

  it("treats a product without a usable panel as not_found pointing at the label scanner", async () => {
    off.fetchOffProduct.mockResolvedValue({
      kind: "found",
      product: { product_name: "Mystery Snack", nutriments: { "energy-kcal_100g": 400 } },
    });
    const response = await lookup("3017624010701");
    const body = (await response.json()) as { result: string; message: string };
    expect(body.result).toBe("not_found");
    expect(body.message).toContain("found the product");
    expect(body.message).toContain("label");
    expect(factsStore.upsertBarcodeFactsRecord).not.toHaveBeenCalled();
  });

  it("answers 502 on upstream failure instead of inventing a result", async () => {
    off.fetchOffProduct.mockResolvedValue({ kind: "error" });
    const response = await lookup("3017624010701");
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("unavailable");
    expect(factsStore.upsertBarcodeFactsRecord).not.toHaveBeenCalled();
  });
});
