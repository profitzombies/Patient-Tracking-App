import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(router);
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
