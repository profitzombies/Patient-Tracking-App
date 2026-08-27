/**
 * Per-IP limiter posture for the barcode lookup, in its OWN module graph so
 * the tiny staged budget cannot starve the functional suite: the env knobs
 * are read once when the route module loads.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.BARCODE_LOOKUP_BURST = "3";
  process.env.BARCODE_LOOKUP_DAILY_BUDGET = "50";
});

const factsStore = vi.hoisted(() => ({
  getBarcodeFactsRecord: vi.fn(async (code: string) => ({
    code,
    name: "Cached Product",
    brand: null,
    serving: "30 g",
    calories: 100,
    protein: 1,
    carbs: 2,
    fat: 3,
    source: "openfoodfacts",
  })),
  upsertBarcodeFactsRecord: vi.fn(async () => {}),
}));
vi.mock("../barcode/facts-store", () => ({
  getBarcodeFactsRecord: factsStore.getBarcodeFactsRecord,
  upsertBarcodeFactsRecord: factsStore.upsertBarcodeFactsRecord,
}));

const off = vi.hoisted(() => ({ fetchOffProduct: vi.fn() }));
vi.mock("../barcode/off", () => ({ fetchOffProduct: off.fetchOffProduct }));

import barcodeRouter from "./barcode";

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

describe("barcode lookup rate limiting", () => {
  it("denies the request after the staged burst with a retryable 429", async () => {
    // Distinct valid codes so the hot cache is irrelevant to the count.
    const codes = ["3017624010701", "0038000138416", "20724696", "5000159484695"];
    const statuses: number[] = [];
    for (const code of codes) {
      const response = await fetch(`${baseUrl}/barcode/${code}`);
      statuses.push(response.status);
      if (response.status === 429) {
        const body = (await response.json()) as { error?: string };
        expect(body.error).toContain("too quickly");
      }
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
    expect(off.fetchOffProduct).not.toHaveBeenCalled();
  });
});
