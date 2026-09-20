import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

vi.mock("../lib/staff-auth", async (original) => {
  const actual = await original<typeof import("../lib/staff-auth")>();
  return {
    ...actual,
    requireHqPermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const token = String(req.headers.authorization ?? "").replace("Bearer ", "");
      if (!token) { res.status(401).json({ error: "Sign in to continue." }); return; }
      if (permission === "settings_manage" && token !== "manager") {
        res.status(403).json({ error: "Your HQ role does not have permission to do this." }); return;
      }
      res.locals.staff = { userId: "hq-user", role: "hq_admin", departmentRole: token === "manager" ? "admin" : "clinical" };
      next();
    },
  };
});
vi.mock("../lib/admin-audit", async (original) => {
  const actual = await original<typeof import("../lib/admin-audit")>();
  return { ...actual, recordAdminAuditEvent: vi.fn(async () => undefined) };
});
vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});
vi.mock("../lib/objectStorage", async (original) => {
  const actual = await original<typeof import("../lib/objectStorage")>();
  return {
    ...actual,
    objectStorage: {
      deleteObject: vi.fn(async () => undefined), deleteObjectStrict: vi.fn(async () => undefined),
      productImageUploadURL: vi.fn(async (productId: string, imageId: string) => ({ uploadUrl: "https://upload.test/put", objectPath: `/objects/product-images/${productId}/${imageId}` })),
      signedDownloadURL: vi.fn(async () => "https://signed.test/image"),
    },
  };
});
import router from "./billing-hq";
import { objectStorage as objectStorageMock } from "../lib/objectStorage";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { runWithBillingIdentity } from "../billing/stripe-environment";
import { __setStripeForTests, __setCredentialsForTests } from "../billing/stripe-client";

type Row = Record<string, unknown>;
const originalFetch = global.fetch;
let server: http.Server;
let base = "";
let settings: Row;
let product: Row;
let second: Row;
let images: Row[];
let extra: Row[];
let changes: Row[];
let aiSummaryCalls: Row[] = [];
let aiSummaryStatus = 200;
const order: Row = {
  id: "0a1b2c3d-0000-4000-8000-000000000001", order_number: "TH-TEST01", provider_id: "live-office", payer_id: "payer-1",
  kind: "one_time", status: "paid", fulfillment_status: "to_ship", total_cents: 12998, application_fee_cents: 7198,
  application_fee_collected_cents: 7198, office_net_cents: 5423, stripe_fee_cents: 377, livemode: false,
  created_at: new Date().toISOString(), paid_at: new Date().toISOString(),
};
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await originalFetch(`${base}${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => req.path.endsWith("/mode") ? next() : runWithBillingIdentity({ mode: "test", platformAccountId: "acct_synthetic" }, next));
  app.use(router);
  server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  global.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
beforeEach(() => {
  settings = { id: 1, shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290,
    card_fee_fixed_cents: 30, subscribe_save_enabled: false, subscribe_save_percent: 10,
    version: 2, updated_by: null, updated_at: null, created_at: "2026-01-01T00:00:00Z" };
  product = { id: "product-1", slug: "control", name: "Control", description: "", floor_price_cents: 5999, hard_cost_cents: 433,
    active: true, status: "active", retired_at: null, archived_at: null, sort_order: 1, stripe_tax_code: null, created_at: "2026-01-01T00:00:00Z" };
  second = { ...product, id: "product-2", slug: "regulate", name: "Regulate", sort_order: 2 };
  images = [];
  extra = [];
  changes = [];
  aiSummaryCalls = [];
  aiSummaryStatus = 200;
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Row : {};
    if (url.pathname === "/rest/v1/billing_settings") {
      if (method === "GET") return response([settings]);
      if (method === "PATCH") {
        if (Number(url.searchParams.get("version")?.replace("eq.", "")) !== settings.version) return response([]);
        settings = { ...settings, ...body }; return response([settings]);
      }
    }
    if (url.pathname === "/rest/v1/billing_products") {
      const raw = url.searchParams.get("id") ?? "";
      const wanted = raw.startsWith("in.(") ? raw.slice(4, -1).split(",") : raw ? [raw.replace("eq.", "")] : null;
      const idFilter = wanted?.length === 1 ? wanted[0] : undefined;
      if (method === "GET") {
        const rows = [product, second, ...extra].filter((row) => !wanted || wanted.includes(String(row.id))).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
        return response(rows);
      }
      if (method === "PATCH") {
        if (idFilter === second.id) { second = { ...second, ...body }; return response([second]); }
        product = { ...product, ...body }; return response([product]);
      }
      if (method === "POST") { const created = { ...product, id: "product-3", ...body }; extra.push(created); return response([created], 201); }
    }
    if (url.pathname === "/rest/v1/billing_product_images") {
      const productFilter = url.searchParams.get("product_id")?.replace("eq.", "");
      const idFilter = url.searchParams.get("id")?.replace("eq.", "");
      if (method === "GET") return response(images.filter((row) => (!productFilter || row.product_id === productFilter) && (!idFilter || row.id === idFilter)));
      if (method === "PATCH") { images = images.map((row) => row.id === idFilter ? { ...row, ...body } : row); return response(images.filter((row) => row.id === idFilter)); }
      if (method === "DELETE") { images = images.filter((row) => row.id !== idFilter); return response([]); }
    }
    if (url.pathname === "/rest/v1/billing_office_prices") return response([]);
    if (url.pathname === "/rest/v1/billing_catalog_changes") {
      if (method === "POST") { changes.push(body); return response([{ id: `change-${changes.length}`, ...body }], 201); }
      return response(changes.map((row, index) => ({ id: `change-${index + 1}`, created_at: "2026-09-14T15:04:05Z", provider_id: null, ...row })));
    }
    if (url.pathname === "/rest/v1/hq_memberships") {
      // Only hand back the columns the route selected, so a dropped column shows up as a missing field.
      const selected = (url.searchParams.get("select") ?? "").split(",");
      const row: Record<string, string> = { id: "member-1", auth_user_id: "hq-user", display_name: "Andrew Admin" };
      return response([Object.fromEntries(Object.entries(row).filter(([key]) => selected.includes(key)))]);
    }
    if (url.pathname === "/rest/v1/profiles") return response([]);
    if (url.pathname === "/rest/v1/providers") {
      return response([{ provider_id: "live-office", office_name: "Cassandra's Med Spa", provider_name: "Cassandra MacMillan", email: null, phone: null }]);
    }
    if (url.pathname === "/rest/v1/rpc/ai_usage_summary") {
      aiSummaryCalls.push(body);
      if (aiSummaryStatus !== 200) return response({ message: "boom" }, aiSummaryStatus);
      return response({
        from: body.p_from, to: body.p_to,
        totals: { calls: 12, ok_calls: 11, error_calls: 1, aborted_calls: 0, prompt_tokens: 100000, cached_tokens: 60000,
          completion_tokens: 20000, reasoning_tokens: 8000, cost_micros: 2_500_000, unpriced_calls: 0, ai_patients: 4, active_patients: 10 },
        unattributed: { calls: 2, cost_micros: 10_000 },
        by_day: [{ day: "2026-09-17", calls: 12, prompt_tokens: 100000, cached_tokens: 60000, completion_tokens: 20000, cost_micros: 2_500_000, ai_patients: 4 }],
        by_office: [{ provider_id: "live-office", office_name: "Cassandra's Med Spa", provider_name: "Cassandra MacMillan", calls: 10,
          prompt_tokens: 90000, cached_tokens: 60000, completion_tokens: 18000, cost_micros: 2_400_000, ai_patients: 4, active_patients: 8 }],
        by_surface: [{ surface: "coach.chat", calls: 10, error_calls: 1, prompt_tokens: 90000, cached_tokens: 60000, completion_tokens: 18000,
          reasoning_tokens: 8000, cost_micros: 2_400_000, avg_latency_ms: 4000, p95_latency_ms: 9000 }],
        by_model: [{ model: "gpt-5.6-terra", calls: 10, prompt_tokens: 90000, cached_tokens: 60000, completion_tokens: 18000, cost_micros: 2_400_000, unpriced: false },
          { model: "mystery-model", calls: 2, prompt_tokens: 10000, cached_tokens: 0, completion_tokens: 2000, cost_micros: 0, unpriced: true }],
      });
    }
    if (url.pathname === "/rest/v1/billing_orders") return response([order]);
    if (url.pathname === "/rest/v1/billing_order_items") return response([{ id: "item-1", order_id: order.id, product_name_snapshot: "Control", quantity: 2 }]);
    if (url.pathname === "/rest/v1/billing_payers") return response([{ id: "payer-1", patient_id: null, name: "Pat Example", email: "pat@example.com", phone: null }]);
    if (url.pathname === "/rest/v1/billing_refunds") return response([{ id: "refund-1", order_id: order.id, amount_cents: 500, created_at: new Date().toISOString() }]);
    if (url.pathname.startsWith("/rest/v1/billing_") && method === "GET") return response([]);
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
});
describe("billing HQ catalog routes", () => {
  it("allows financial readers to read the catalog", async () => {
    const result = await call("GET", "/billing/hq/catalog", "reader");
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ settings: { version: 2 }, products: [{ name: "Control", break_even_minimum_cents: 3767, status: "active", image_url: null }, { name: "Regulate" }] });
  });
  it("requires settings_manage for catalog writes", async () => {
    const result = await call("POST", "/billing/hq/catalog/products/product-1/retire", "reader");
    expect(result.status).toBe(403);
    expect(product.active).toBe(true);
  });
  it("returns 409 for a stale settings version", async () => {
    const result = await call("PUT", "/billing/hq/catalog/settings", "manager", {
      shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290,
      card_fee_fixed_cents: 30, expected_version: 1,
    });
    expect(result.status).toBe(409);
  });
  it("retires and reactivates products", async () => {
    const retired = await call("POST", "/billing/hq/catalog/products/product-1/retire", "manager");
    expect(retired.status).toBe(200); expect((retired.json as { product: { active: boolean } }).product.active).toBe(false);
    const active = await call("POST", "/billing/hq/catalog/products/product-1/reactivate", "manager");
    expect(active.status).toBe(200); expect((active.json as { product: { active: boolean } }).product.active).toBe(true);
  });
  it("moves products through draft, active, retired, and archived", async () => {
    const draft = await call("POST", "/billing/hq/catalog/products/product-1/status", "manager", { status: "draft" });
    expect(draft.status).toBe(200);
    expect(draft.json).toMatchObject({ product: { status: "draft", active: false, retired_at: null } });
    const published = await call("POST", "/billing/hq/catalog/products/product-1/status", "manager", { status: "active" });
    expect(published.json).toMatchObject({ product: { status: "active", active: true } });
    const archived = await call("POST", "/billing/hq/catalog/products/product-1/status", "manager", { status: "archived" });
    expect(archived.json).toMatchObject({ product: { status: "archived", active: false } });
    expect((archived.json as { product: { archived_at: string | null } }).product.archived_at).toBeTruthy();
    expect(changes.map((row) => row.kind)).toEqual(["product_updated", "product_published", "product_archived"]);
    const bad = await call("POST", "/billing/hq/catalog/products/product-1/status", "manager", { status: "deleted" });
    expect(bad.status).toBe(400);
  });
  it("creates products with a description and a chosen starting status", async () => {
    const created = await call("POST", "/billing/hq/catalog/products", "manager", {
      name: "Night Blend", description: "Evening support", floor_price_cents: 4999, hard_cost_cents: 800, status: "draft",
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ product: { slug: "night-blend", status: "draft", active: false, image_url: null, images: [] } });
  });
  it("records a floor-price change without staff-entered product text", async () => {
    const result = await call("PUT", "/billing/hq/catalog/products/product-1", "manager", { floor_price_cents: 6499 });
    expect(result.status).toBe(200);
    expect(recordAdminAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "billing_product_floor_updated",
      targetId: "product-1",
      metadata: { product_id: "product-1", floor_price_cents: 6499 },
    }));
  });
  it("exposes product-page content, cadences, and subscribe-and-save with older rows reading as the 4-week plan", async () => {
    const result = await call("GET", "/billing/hq/catalog", "reader");
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      settings: { subscribe_save_enabled: false, subscribe_save_percent: 10 },
      products: [{
        category: "supplement", tagline: "", format: "", benefits: [], how_to_take: "", facts_title: "", facts: [], faqs: [], disclaimer: "",
        offered_cadences_weeks: [4], default_cadence_weeks: 4,
      }, { name: "Regulate", offered_cadences_weeks: [4] }],
    });
  });
  it("saves product-page content and cadences, auditing them like prices", async () => {
    const page = {
      category: "drops", tagline: "Supports Any Weight Loss", format: "Sublingual Drops",
      benefits: ["Sublingual drops - easy administration"], how_to_take: "Take as directed by your THINNR provider.",
      facts_title: "Active Ingredients (HPUS)", facts: [{ name: "Chelidonium", detail: null }],
      faqs: [{ question: "Any side effects?", answer: "Homeopathic products typically have little to no side effects." }],
      disclaimer: "*Claims are based on traditional homeopathic practice.",
      offered_cadences_weeks: [8, 2, 4], default_cadence_weeks: 8,
    };
    const result = await call("PUT", "/billing/hq/catalog/products/product-1", "manager", page);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ product: { ...page, offered_cadences_weeks: [2, 4, 8] } });
    expect(changes).toEqual([expect.objectContaining({
      kind: "product_updated",
      before: expect.objectContaining({ tagline: "", offered_cadences_weeks: [4], default_cadence_weeks: 4 }),
      after: expect.objectContaining({ tagline: "Supports Any Weight Loss", category: "drops", offered_cadences_weeks: [2, 4, 8], default_cadence_weeks: 8 }),
    })]);
  });
  it("saves the coach suggestion rule with the product and reads it back, rejecting unknown signals", async () => {
    const before = await call("GET", "/billing/hq/catalog", "reader");
    expect((before.json as { products: Array<{ coach_suggestion: unknown }> }).products[0].coach_suggestion).toEqual({
      signals: [], avoid_signals: [], phrasing: "", bloodwork_covered: false, topics: [],
    });
    const coach_suggestion = {
      signals: ["low_protein", "stall"], avoid_signals: ["bloodwork_kidney_flag"],
      phrasing: "Frame it as protecting lean mass.", bloodwork_covered: false,
      topics: ["Lifting ", "gym", "lifting"],
    };
    // Topics are normalized with the rule: trimmed, lowercased, de-duplicated.
    const stored = { ...coach_suggestion, topics: ["lifting", "gym"] };
    const result = await call("PUT", "/billing/hq/catalog/products/product-1", "manager", { coach_suggestion });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ product: { coach_suggestion: stored } });
    const after = await call("GET", "/billing/hq/catalog", "reader");
    expect((after.json as { products: Array<{ coach_suggestion: unknown }> }).products[0].coach_suggestion).toEqual(stored);
    expect(changes).toEqual([expect.objectContaining({
      kind: "product_updated",
      after: expect.objectContaining({ coach_suggestion: stored }),
    })]);
    const rejected = await call("PUT", "/billing/hq/catalog/products/product-1", "manager", {
      coach_suggestion: { ...coach_suggestion, signals: ["cures_everything"] },
    });
    expect(rejected.status).toBe(400);
  });
  it("rejects a default cadence that is not offered, an unknown cadence, and an empty set", async () => {
    const wrongDefault = await call("PUT", "/billing/hq/catalog/products/product-1", "manager", { offered_cadences_weeks: [2, 6], default_cadence_weeks: 4 });
    expect(wrongDefault).toMatchObject({ status: 400, json: { field: "default_cadence_weeks" } });
    const unknown = await call("PUT", "/billing/hq/catalog/products/product-1", "manager", { offered_cadences_weeks: [3] });
    expect(unknown.status).toBe(400);
    const empty = await call("PUT", "/billing/hq/catalog/products/product-1", "manager", { offered_cadences_weeks: [] });
    expect(empty.status).toBe(400);
    expect(product.offered_cadences_weeks).toBeUndefined();
    expect(changes).toEqual([]);
  });
  it("turns subscribe-and-save on with a percent, and keeps it when an older client omits it", async () => {
    const on = await call("PUT", "/billing/hq/catalog/settings", "manager", {
      shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30,
      subscribe_save_enabled: true, subscribe_save_percent: 15, expected_version: 2,
    });
    expect(on).toMatchObject({ status: 200, json: { settings: { subscribe_save_enabled: true, subscribe_save_percent: 15, version: 3 } } });
    expect(recordAdminAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "billing_settings_updated", metadata: { keys_changed: 6 } }));
    const legacy = await call("PUT", "/billing/hq/catalog/settings", "manager", {
      shipping_charge_cents: 1100, shipping_cost_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30, expected_version: 3,
    });
    expect(legacy).toMatchObject({ status: 200, json: { settings: { shipping_charge_cents: 1100, subscribe_save_enabled: true, subscribe_save_percent: 15 } } });
    const tooHigh = await call("PUT", "/billing/hq/catalog/settings", "manager", {
      shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30,
      subscribe_save_enabled: true, subscribe_save_percent: 95, expected_version: 4,
    });
    expect(tooHigh).toMatchObject({ status: 400, json: { field: "subscribe_save_percent" } });
  });
  it("reorders products and records the new order", async () => {
    const result = await call("PUT", "/billing/hq/catalog/order", "manager", { ids: ["product-2", "product-1"] });
    expect(result.status).toBe(200);
    expect((result.json as { products: { id: string }[] }).products.map((row) => row.id)).toEqual(["product-2", "product-1"]);
    expect(changes).toEqual([expect.objectContaining({ kind: "products_reordered", before: { order: ["control", "regulate"] }, after: { order: ["regulate", "control"] } })]);
    const stale = await call("PUT", "/billing/hq/catalog/order", "manager", { ids: ["product-9"] });
    expect(stale.status).toBe(409);
  });
  it("manages product images: default follows removal, and the cap is enforced", async () => {
    images = [1, 2, 3, 4, 5].map((n) => ({
      id: `image-${n}`, product_id: "product-1", object_path: `/objects/product-images/product-1/image-${n}`, content_type: "image/png",
      size_bytes: 100, sort_order: n, is_default: n === 1, created_by: "hq-user", created_at: "2026-01-01T00:00:00Z",
    }));
    const full = await call("POST", "/billing/hq/catalog/products/product-1/images/upload-url", "manager", { content_type: "image/png", size: 100 });
    expect(full.status).toBe(409);
    const badType = await call("POST", "/billing/hq/catalog/products/product-2/images/upload-url", "manager", { content_type: "image/gif", size: 100 });
    expect(badType.status).toBe(415);
    const detail = await call("GET", "/billing/hq/catalog/products/product-1", "reader");
    expect(detail.json).toMatchObject({ product: { image_count: 5, image_url: "/api/billing/public/product-images/image-1" } });
    const promoted = await call("POST", "/billing/hq/catalog/products/product-1/images/image-3/default", "manager");
    expect((promoted.json as { product: { image_url: string } }).product.image_url).toBe("/api/billing/public/product-images/image-3");
    const removed = await call("DELETE", "/billing/hq/catalog/products/product-1/images/image-3", "manager");
    expect(removed.status).toBe(200);
    expect(removed.json).toMatchObject({ product: { image_count: 4, image_url: "/api/billing/public/product-images/image-1" } });
    expect(changes.map((row) => row.kind)).toEqual(["product_default_image", "product_image_removed"]);
  });
  it("answers a retried finalize with the saved product instead of discarding the live object", async () => {
    images = [{
      id: "11111111-1111-4111-8111-111111111111", product_id: "product-1", object_path: "/objects/product-images/product-1/11111111-1111-4111-8111-111111111111",
      content_type: "image/png", size_bytes: 100, sort_order: 1, is_default: true, created_by: "hq-user", created_at: "2026-01-01T00:00:00Z",
    }];
    const retry = await call("POST", "/billing/hq/catalog/products/product-1/images", "manager", {
      image_id: "11111111-1111-4111-8111-111111111111", object_path: images[0].object_path, content_type: "image/png", size: 100,
    });
    expect(retry.status).toBe(201);
    expect(retry.json).toMatchObject({ product: { image_count: 1 } });
    expect(vi.mocked(objectStorageMock.deleteObjectStrict)).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });
  it("names the HQ teammate behind each catalog change", async () => {
    await call("POST", "/billing/hq/catalog/products/product-1/retire", "manager");
    const history = await call("GET", "/billing/hq/catalog/changes", "reader");
    expect(history.status).toBe(200);
    expect(history.json).toMatchObject({ items: [{ kind: "product_retired", actor_name: "Andrew Admin", actor_member_id: "member-1", product_name: "Control" }] });
  });
});
describe("billing HQ provider detail", () => {
  it("returns recent orders and 30-day activity for one office", async () => {
    const result = await call("GET", "/billing/hq/providers/live-office", "reader");
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      office: { provider_id: "live-office", office_name: "Cassandra's Med Spa" },
      account: null,
      activity_30d: { collected_cents: 12998, thinnr_fee_cents: 7198, refunded_cents: 500, net_cents: 5423, orders: 1, to_ship: 1 },
      recent_orders: [{ order_number: "TH-TEST01", items_label: "Control × 2", item_count: 2, payer: { name: "Pat Example" } }],
    });
    // Recent orders are hydrated with one items read and one payers read for
    // the whole page, never a bundle of reads per order.
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => new URL(String(input instanceof Request ? input.url : input)));
    expect(calls.filter((url) => url.pathname === "/rest/v1/billing_order_items")).toHaveLength(1);
    expect(calls.filter((url) => url.pathname === "/rest/v1/billing_payers")).toHaveLength(1);
    expect(calls.find((url) => url.pathname === "/rest/v1/billing_order_items")?.searchParams.get("order_id")).toContain(String(order.id));
  });
  it("404s for an unknown office", async () => {
    const result = await call("GET", "/billing/hq/providers/nope", "reader");
    expect(result.status).toBe(404);
  });
});

describe("billing HQ AI costs", () => {
  it("summarizes the usage ledger for a range with cache share and per-patient cost", async () => {
    const result = await call("GET", "/billing/hq/ai-costs?from=2026-09-01&to=2026-09-18", "reader");
    expect(result.status).toBe(200);
    expect(aiSummaryCalls).toEqual([{ p_from: "2026-09-01", p_to: "2026-09-18" }]);
    const json = result.json as Record<string, any>;
    expect(json.totals).toMatchObject({
      calls: 12, cost_usd: 2.5, cached_share: 0.6, active_patients: 10, ai_patients: 4,
      cost_per_active_patient_usd: 0.25, cost_per_ai_patient_usd: 0.625,
    });
    expect(json.unattributed).toEqual({ calls: 2, cost_usd: 0.01 });
    expect(json.by_office[0]).toMatchObject({ provider_id: "live-office", office_name: "Cassandra's Med Spa", cost_usd: 2.4, active_patients: 8, cost_per_active_patient_usd: 0.3 });
    expect(json.by_surface[0]).toMatchObject({ surface: "coach.chat", model: "gpt-5.6-terra", cached_share: 60000 / 90000, p95_latency_ms: 9000 });
    expect(json.by_model[1]).toMatchObject({ model: "mystery-model", unpriced: true, rate: null });
    expect(json.by_model[0].rate).toEqual({ input: 1.25, cached: 0.125, output: 10 });
    expect(json.models).toEqual(expect.arrayContaining([{ surface: "coach.chat", model: "gpt-5.6-terra", overridden: false }]));
    expect(typeof json.pricing_version).toBe("string");
  });
  it("defaults to the last 30 days and rejects malformed or oversized ranges", async () => {
    const result = await call("GET", "/billing/hq/ai-costs", "reader");
    expect(result.status).toBe(200);
    const [{ p_from, p_to }] = aiSummaryCalls as { p_from: string; p_to: string }[];
    expect(Math.round((Date.parse(`${p_to}T00:00:00Z`) - Date.parse(`${p_from}T00:00:00Z`)) / 86_400_000)).toBe(29);
    expect((await call("GET", "/billing/hq/ai-costs?from=2026-09-18&to=2026-09-01", "reader")).status).toBe(400);
    expect((await call("GET", "/billing/hq/ai-costs?from=yesterday", "reader")).status).toBe(400);
    expect((await call("GET", "/billing/hq/ai-costs?from=2024-01-01&to=2026-09-18", "reader")).status).toBe(400);
  });
  it("answers 503 when the summary RPC fails", async () => {
    aiSummaryStatus = 500;
    expect((await call("GET", "/billing/hq/ai-costs", "reader")).status).toBe(503);
  });
});

describe("HQ payment mode HTTP contract", () => {
  let selection: { mode: string; version: number; platform_account_id: string } | null;
  let storageStatus = 200;
  let writes: Row[];
  const suffixes = ["SECRET_KEY", "PUBLISHABLE_KEY", "PLATFORM_ACCOUNT_ID", "CONNECT_CLIENT_ID", "PLATFORM_WEBHOOK_SECRET", "CONNECT_WEBHOOK_SECRET"];
  function configure(mode: "test" | "live") {
    const values = [`sk_${mode}_synthetic`, `pk_${mode}_synthetic`, "acct_synthetic", "ca_synthetic", "whsec_platformsynthetic", "whsec_connectsynthetic"];
    suffixes.forEach((suffix, index) => vi.stubEnv(`STRIPE_${mode.toUpperCase()}_${suffix}`, values[index]));
  }
  beforeEach(() => {
    selection = null; writes = []; storageStatus = 200;
    vi.stubEnv("BILLING_DEPLOYMENT_ID", "synthetic-route-suite");
    for (const mode of ["TEST", "LIVE"]) for (const suffix of suffixes) vi.stubEnv(`STRIPE_${mode}_${suffix}`, "");
    __setCredentialsForTests(null);
    __setStripeForTests({ accounts: { retrieve: vi.fn(async () => ({ id: "acct_synthetic" })) } } as unknown as Stripe);
    const fixtureFetch = global.fetch;
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/rest/v1/billing_mode_state") {
        expect(url.searchParams.get("deployment_id")).toBe("eq.synthetic-route-suite");
        if (storageStatus !== 200) return response({ code: "42P01", message: "synthetic internal database diagnostic" }, storageStatus);
        return response(selection ? [selection] : []);
      }
      if (url.pathname === "/rest/v1/rpc/switch_billing_mode") {
        const body = JSON.parse(String(init?.body)) as Row;
        writes.push(body);
        if (body.p_expected_version !== (selection?.version ?? 0)) return response({ code: "40001" }, 409);
        selection = { mode: String(body.p_mode), platform_account_id: String(body.p_platform_account_id), version: (selection?.version ?? 0) + 1 };
        return response(selection);
      }
      return fixtureFetch(input, init);
    }) as typeof fetch;
  });
  afterEach(() => { __setStripeForTests(null); __setCredentialsForTests(null); vi.unstubAllEnvs(); });
  it("reports safe default Test and missing key names without needing Stripe credentials", async () => {
    const result = await call("GET", "/billing/hq/mode", "reader");
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ mode: "test", version: 0, configuration: { test: { configured: false }, live: { configured: false } } });
    expect(result.json).toHaveProperty("configuration.test.missing.length", 6);
    expect(writes).toHaveLength(0);
  });
  it("reports missing deployment setup without pretending a saved mode was loaded", async () => {
    vi.stubEnv("BILLING_DEPLOYMENT_ID", "");
    configure("live");
    const result = await call("GET", "/billing/hq/mode", "manager");
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ mode: "test", version: null, selection_loaded: false,
      setup: { ready: false, missing: ["BILLING_DEPLOYMENT_ID"] } });
    expect((await call("PUT", "/billing/hq/mode", "manager", { mode: "live", expected_version: 0, confirm_live: true })).status).toBe(503);
    expect(writes).toHaveLength(0);
  });
  it("reports unavailable mode storage with migration guidance and blocks switches", async () => {
    storageStatus = 404;
    configure("live");
    const result = await call("GET", "/billing/hq/mode", "manager");
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ version: null, selection_loaded: false,
      setup: { ready: false, missing: ["billing_mode_state"] } });
    expect(result.json).toHaveProperty("setup.message", expect.stringContaining("migration"));
    expect(JSON.stringify(result.json)).not.toContain("synthetic internal database diagnostic");
    expect((await call("PUT", "/billing/hq/mode", "manager", { mode: "live", expected_version: 0, confirm_live: true })).status).toBe(503);
    expect(writes).toHaveLength(0);
  });
  it("requires sign-in and settings permission before any mode mutation", async () => {
    expect((await call("GET", "/billing/hq/mode", "")).status).toBe(401);
    expect((await call("PUT", "/billing/hq/mode", "reader", { mode: "live", expected_version: 0, confirm_live: true })).status).toBe(403);
    expect(writes).toHaveLength(0);
  });
  it("rejects invalid mode, missing version and missing explicit Live confirmation", async () => {
    configure("live");
    for (const body of [{ mode: "production", expected_version: 0 }, { mode: "live", confirm_live: true }, { mode: "live", expected_version: 0 }, { mode: "live", expected_version: 0, confirm_live: false }]) {
      expect((await call("PUT", "/billing/hq/mode", "manager", body)).status).toBe(400);
    }
    expect(writes).toHaveLength(0);
  });
  it("blocks absent and wrong-mode target credentials without leaking any key values", async () => {
    const input = { mode: "live", expected_version: 0, confirm_live: true };
    expect((await call("PUT", "/billing/hq/mode", "manager", input)).status).toBe(503);
    configure("live");
    vi.stubEnv("STRIPE_LIVE_SECRET_KEY", "sk_test_syntheticwrongmode");
    const status = await call("GET", "/billing/hq/mode", "reader");
    expect(status.json).toHaveProperty("configuration.live.configured", false);
    expect(JSON.stringify(status.json)).not.toContain("sk_test_syntheticwrongmode");
    expect((await call("PUT", "/billing/hq/mode", "manager", input)).status).toBe(503);
    expect(writes).toHaveLength(0);
  });
  it("persists an explicitly confirmed switch and rejects the competing stale version", async () => {
    configure("live"); configure("test");
    const results = await Promise.all([0, 1].map(() => call("PUT", "/billing/hq/mode", "manager", { mode: "live", expected_version: 0, confirm_live: true })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(writes[0]).toMatchObject({ p_actor_user_id: "hq-user", p_confirm_live: true, p_deployment_id: "synthetic-route-suite" });
    expect((await call("GET", "/billing/hq/mode", "reader")).json).toMatchObject({ mode: "live", version: 1 });
    const back = await call("PUT", "/billing/hq/mode", "manager", { mode: "test", expected_version: 1 });
    expect(back.status).toBe(200);
    expect(back.json).toMatchObject({ mode: "test", version: 2 });
    expect(JSON.stringify(back.json)).not.toContain("sk_test_synthetic");
  });
});
