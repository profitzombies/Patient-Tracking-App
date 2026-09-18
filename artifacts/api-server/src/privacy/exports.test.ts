import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildPatientArchive, type PatientArchiveSections } from "./exports";

function emptySections(): PatientArchiveSections {
  return {
    profile: null,
    consents: [],
    flags: null,
    diary: [],
    water: [],
    targets: null,
    library: { customFoods: [], savedRecipes: [], favorites: [], recents: [] },
    checkIns: [],
    measurements: { healthImports: [], bodyMeasurements: [], clinicWeights: [] },
    medications: { list: [], doseLogs: [] },
    photos: [],
    media: [],
    chat: [],
    coachMemory: { memories: [], exclusions: [] },
    appUsage: [{ day: "2026-10-01", first_seen_at: "2026-10-01T12:00:00Z", last_seen_at: "2026-10-01T12:05:00Z", platform: "ios" }],
    bloodwork: { reports: [], files: [], results: [], corrections: [], incompleteTranscriptionPages: [] },
    billing: {
      orders: [{
        order_number: "TH-100",
        created_at: "2026-10-01T00:00:00.000Z",
        items: [{ product_name_snapshot: "Plan", quantity: 1, unit_price_cents: 12000 }],
        subtotal_cents: 12000,
        shipping_charge_cents: 1000,
        tax_cents: 0,
        total_cents: 13000,
        status: "paid",
        fulfillment_status: "shipped",
      }],
      subscriptions: [{
        product: "Plan",
        status: "active",
        unit_price_cents: 12000,
        current_period_end: "2026-10-29T00:00:00.000Z",
      }],
    },
  };
}

describe("patient billing export", () => {
  it("includes billing history without Stripe identifiers", async () => {
    const archive = await buildPatientArchive("patient-1", {
      sections: emptySections(),
      generatedAt: new Date("2026-10-02T00:00:00.000Z"),
    });
    const zip = await JSZip.loadAsync(archive.buffer);
    const billing = JSON.parse(await zip.file("billing.json")!.async("string"));
    const appUsage = JSON.parse(await zip.file("app-usage.json")!.async("string"));
    expect(appUsage).toEqual([{ day: "2026-10-01", first_seen_at: "2026-10-01T12:00:00Z", last_seen_at: "2026-10-01T12:05:00Z", platform: "ios" }]);
    expect(billing.orders[0]).toMatchObject({
      order_number: "TH-100",
      total_cents: 13000,
      fulfillment_status: "shipped",
    });
    expect(billing.subscriptions[0]).toMatchObject({
      product: "Plan",
      unit_price_cents: 12000,
    });
    expect(JSON.stringify(billing)).not.toContain("stripe");
  });
});