/**
 * The patient side of app access, end to end against a PostgREST-shaped
 * fake and a scripted Stripe:
 *
 *   - the checkout token: minted for any provider id shape (production ids
 *     are `live-<hex>`, not UUIDs), refused when expired, tampered or
 *     malformed;
 *   - the signed-in entitlement read: available/locked plus a checkout link
 *     ONLY when the office charges and no open subscription exists;
 *   - the public /pay/app-access/<token> routes: preview, a checkout that
 *     writes the subscription + first order + line item with the flat 30%
 *     THINNR share BEFORE talking to Stripe, creates the Stripe subscription
 *     on the office's CONNECTED account at the mirrored price, refuses a
 *     second open subscription, cleans up honestly when Stripe fails, and the
 *     order status the done page polls;
 *   - the subscription's status feeding back into the entitlement (active →
 *     available, canceled-but-paid-through → available, lapsed → locked).
 */
import crypto from "node:crypto";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://app-access.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.BILLING_PUBLIC_ORIGIN = "https://billing.example";
  process.env.BILLING_DEPLOYMENT_ID = "deploy";
});

type Row = Record<string, any>;
const PROVIDER = "live-0f3c2b7a9d8e4f1a8c6b5d4e3f2a1b0c";
const OTHER_PROVIDER = "live-ffffffffffffffffffffffffffffffff";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";

const session = vi.hoisted(() => ({ patientId: null as string | null, providerId: null as string | null }));
vi.mock("../lib/patient-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/patient-auth")>();
  return {
    ...actual,
    resolvePatient: vi.fn(async (req: { headers: Record<string, unknown> }) => {
      if (actual.bearerToken(req) === null || !session.patientId) return { ok: false as const, status: 401, error: "Sign in first." };
      return { ok: true as const, patientId: session.patientId, authUserId: "user-1", providerId: session.providerId, consent: { satisfied: true } };
    }),
  };
});

const stripe = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; account: string | undefined; params: any }>,
  failSubscriptionCreate: false,
  subscriptions: new Map<string, any>(),
}));
vi.mock("../billing/stripe-client", async (original) => {
  const actual = await original<typeof import("../billing/stripe-client")>();
  const record = (method: string, params: any, opts?: { stripeAccount?: string }) => stripe.calls.push({ method, account: opts?.stripeAccount, params });
  const missing = (id: string) => Object.assign(new Error(`No such object: ${id}`), { code: "resource_missing" });
  const fake = {
    products: {
      retrieve: async (id: string, _p: unknown, opts?: any) => { record("products.retrieve", id, opts); return { id }; },
      create: async (params: any, opts?: any) => { record("products.create", params, opts); return { id: "prod_app" }; },
    },
    prices: {
      retrieve: async (id: string, _p: unknown, opts?: any) => {
        record("prices.retrieve", id, opts);
        if (id !== "price_app_699") throw missing(id);
        return { id, active: true, unit_amount: 699, recurring: { interval: "week", interval_count: 2 } };
      },
      create: async (params: any, opts?: any) => { record("prices.create", params, opts); return { id: `price_app_${params.unit_amount}` }; },
      update: async (id: string, params: any, opts?: any) => { record("prices.update", { id, ...params }, opts); return { id, ...params }; },
    },
    customers: {
      create: async (params: any, opts?: any) => { record("customers.create", params, opts); return { id: "cus_pat" }; },
      update: async (id: string, params: any, opts?: any) => { record("customers.update", { id, ...params }, opts); return { id }; },
    },
    subscriptions: {
      create: async (params: any, opts?: any) => {
        record("subscriptions.create", params, opts);
        if (stripe.failSubscriptionCreate) throw new Error("Stripe is down");
        const id = `sub_${stripe.subscriptions.size + 1}`;
        const sub = { id, status: "incomplete", latest_invoice: `in_first_${id}`, current_period_end: 1_790_000_000 };
        stripe.subscriptions.set(id, sub);
        return sub;
      },
      retrieve: async (id: string, _p: unknown, opts?: any) => {
        record("subscriptions.retrieve", id, opts);
        const sub = stripe.subscriptions.get(id);
        if (!sub) throw missing(id);
        return sub;
      },
      cancel: async (id: string, _p: unknown, opts?: any) => {
        record("subscriptions.cancel", id, opts);
        const sub = stripe.subscriptions.get(id);
        if (!sub) throw missing(id);
        sub.status = "canceled";
        return sub;
      },
    },
    invoices: {
      retrieve: async (id: string, _p: unknown, opts?: any) => {
        record("invoices.retrieve", id, opts);
        return { id, total: 699, payment_intent: { id: `pi_${id}`, client_secret: `secret_${id}` } };
      },
    },
  };
  return {
    ...actual,
    getStripe: async () => fake,
    getPublishableKey: async () => "pk_test_fake",
    isSandbox: async () => true,
    isStripeMissing: (error: unknown) => (error as { code?: string })?.code === "resource_missing",
  };
});

import { mintAppAccessCheckoutToken, verifyAppAccessCheckoutToken, APP_ACCESS_CHECKOUT_TOKEN_TTL_SEC } from "../billing/app-access/checkout-token";
import { APP_ACCESS_PRODUCT_ID } from "../billing/app-access/catalog";
import { runWithBillingIdentity } from "../billing/stripe-environment";
import publicRouter from "./billing-public-app-access";
import patientRouter from "./patient-billing";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A small PostgREST stand-in: eq/neq/is/in/gt/lt filters, or=(), order, limit, ignore-duplicates. */
class Backend {
  tables: Record<string, Row[]> = {};
  seq = 0;
  reset() {
    this.tables = {
      patients: [], providers: [], billing_connected_accounts: [], billing_office_settings: [], billing_app_access_prices: [],
      billing_subscriptions: [], billing_orders: [], billing_order_items: [], billing_payers: [], billing_catalog_changes: [],
      billing_mode_state: [{ mode: "test", version: 1, platform_account_id: "acct_platform" }],
    };
    this.seq = 0;
  }
  private match(row: Row, clause: string): boolean {
    const group = clause.match(/^(and|or)\((.*)\)$/);
    if (group) {
      const parts: string[] = []; let depth = 0; let start = 0;
      for (let i = 0; i < group[2].length; i += 1) {
        const ch = group[2][i];
        if (ch === "(") depth += 1; else if (ch === ")") depth -= 1;
        else if (ch === "," && depth === 0) { parts.push(group[2].slice(start, i)); start = i + 1; }
      }
      parts.push(group[2].slice(start));
      return group[1] === "or" ? parts.some((p) => this.match(row, p)) : parts.every((p) => this.match(row, p));
    }
    const dot = clause.indexOf(".");
    const column = clause.slice(0, dot);
    const rest = clause.slice(dot + 1);
    const op = rest.slice(0, rest.indexOf("."));
    const raw = rest.slice(rest.indexOf(".") + 1);
    const value = row[column];
    switch (op) {
      case "eq": return String(value ?? "") === raw;
      case "neq": return String(value ?? "") !== raw;
      case "is": return raw === "null" ? value == null : Boolean(value) === (raw === "true");
      case "in": return raw.replace(/^\(|\)$/g, "").split(",").includes(String(value));
      case "gt": return String(value) > raw;
      case "lt": return String(value) < raw;
      default: throw new Error(`Unsupported fake filter ${clause}`);
    }
  }
  private select(url: URL, rows: Row[]): Row[] {
    const clauses: string[] = [];
    url.searchParams.forEach((raw, key) => {
      if (["select", "order", "limit", "on_conflict"].includes(key)) return;
      clauses.push(key === "or" || key === "and" ? `${key}${raw}` : `${key}.${raw}`);
    });
    return rows.filter((row) => clauses.every((clause) => this.match(row, clause)));
  }
  handle(href: string, init?: RequestInit): Response {
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const table = url.pathname.replace("/rest/v1/", "");
    const rows = this.tables[table];
    if (!rows) return json(404, { message: `Unknown fake table ${table}` });
    // Every billing row carries its payment identity (the store filters on it).
    if (table.startsWith("billing_") && table !== "billing_mode_state") rows.forEach((row) => {
      row.stripe_mode ??= "test"; row.stripe_platform_account_id ??= "acct_platform";
    });
    if (method === "GET") {
      let selected = this.select(url, rows);
      const order = url.searchParams.get("order");
      if (order) {
        const [column, direction] = order.split(",")[0].split(".");
        selected = [...selected].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (direction === "desc" ? -1 : 1));
      }
      const limit = Number(url.searchParams.get("limit"));
      return json(200, limit ? selected.slice(0, limit) : selected);
    }
    if (method === "POST") {
      const incoming = JSON.parse(String(init?.body ?? "{}"));
      const dup = (incoming.id && rows.some((r) => r.id === incoming.id))
        || (table === "billing_app_access_prices" && rows.some((r) => r.provider_id === incoming.provider_id))
        || (table === "billing_office_settings" && rows.some((r) => r.provider_id === incoming.provider_id));
      if (dup) return json(409, { code: "23505", message: `duplicate key value violates unique constraint "${table}_pkey"` });
      this.seq += 1;
      const stamp = new Date(Date.UTC(2026, 2, 1, 0, 0, this.seq)).toISOString();
      const row = { id: incoming.id ?? crypto.randomUUID(), created_at: stamp, updated_at: stamp, ...incoming };
      rows.push(row);
      return json(201, [row]);
    }
    if (method === "PATCH") {
      const patch = JSON.parse(String(init?.body ?? "{}"));
      const changed = this.select(url, rows);
      changed.forEach((row) => Object.assign(row, patch));
      return json(200, changed);
    }
    return json(405, {});
  }
}

const backend = new Backend();
const originalFetch = global.fetch;
let server: http.Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runWithBillingIdentity({ mode: "test", platformAccountId: "acct_platform" }, next));
  app.use("/api", publicRouter);
  app.use("/api", patientRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  global.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

const DAY = 86400_000;
const NOW = Date.now();
const iso = (daysFromNow: number) => new Date(NOW + daysFromNow * DAY).toISOString();
const dayKey = (daysFromNow: number) => iso(daysFromNow).slice(0, 10);

/** A non-THINNR patient whose 7-day trial ended a month ago, at an office that charges $6.99 every 2 weeks. */
function seed(options: { charges?: boolean; activatedDaysAgo?: number; programId?: string } = {}) {
  backend.reset();
  stripe.calls = []; stripe.failSubscriptionCreate = false; stripe.subscriptions.clear();
  const activated = iso(-(options.activatedDaysAgo ?? 30));
  for (const [id, provider] of [[PATIENT, PROVIDER], [STRANGER, OTHER_PROVIDER]] as const) {
    backend.tables.patients.push({
      id, provider_id: provider, first_name: "Pat", last_name: "Patient", name: null, email: `${id.slice(0, 4)}@example.com`, phone: null,
      program_id: options.programId ?? "mediterranean", program_start_date: activated.slice(0, 10), timezone: "America/Chicago",
      claimed_at: null, activation_updated_at: activated, created_at: activated, closed_at: null,
    });
  }
  for (const provider of [PROVIDER, OTHER_PROVIDER]) {
    backend.tables.providers.push({ provider_id: provider, provider_name: "Dr. Reyes", office_name: "Harbor Clinic", email: "office@example.com", phone: null, address_line_1: "1 Main", address_line_2: null, city: "Austin", state: "TX", postal_code: "78701" });
    backend.tables.billing_connected_accounts.push({ provider_id: provider, stripe_account_id: `acct_${provider.slice(-4)}`, disconnected_at: null, charges_enabled: true, payouts_enabled: true, details_submitted: true, livemode: false });
  }
  if (options.charges !== false) {
    backend.tables.billing_office_settings.push({ provider_id: PROVIDER, app_access_enabled: true, app_access_price_cents: 699, app_access_cadence: "2_weeks", app_access_trial_days: 7, version: 1, updated_at: iso(-10) });
    backend.tables.billing_app_access_prices.push({ provider_id: PROVIDER, price_cents: 699, cadence: "2_weeks", stripe_product_id: "prod_app", stripe_price_id: "price_app_699" });
  }
  session.patientId = PATIENT; session.providerId = PROVIDER;
}
function subscription(patch: Row): Row {
  const row = {
    id: crypto.randomUUID(), provider_id: PROVIDER, payer_id: crypto.randomUUID(), patient_id: PATIENT, product_id: APP_ACCESS_PRODUCT_ID,
    kind: "app_access", status: "active", stripe_subscription_id: "sub_existing", stripe_customer_id: "cus_pat", unit_price_cents: 699,
    current_period_end: iso(10), cancel_at_period_end: false, canceled_at: null, cadence_weeks: 2, quantity: 1, livemode: false,
    created_at: iso(-20), ...patch,
  };
  backend.tables.billing_subscriptions.push(row);
  return row;
}

beforeEach(() => {
  seed();
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (href.startsWith(process.env.SUPABASE_URL!)) return backend.handle(href, init);
    throw new Error(`unexpected fetch ${href}`);
  }) as typeof fetch;
});

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const res = await originalFetch(`${base}/api${path}`, {
    method, headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Row | null };
}
const entitlement = () => call("GET", "/patient-data/billing/app-access", { token: "tok" });
const tokenFromCheckoutUrl = (url: string) => url.slice(url.lastIndexOf("/") + 1);

describe("checkout token", () => {
  it("binds a patient to a free-text provider id and refuses expiry, tampering and junk", () => {
    const token = mintAppAccessCheckoutToken(PATIENT, PROVIDER, NOW);
    expect(token.split(".")).toHaveLength(4);
    expect(verifyAppAccessCheckoutToken(token, NOW)).toEqual({ patientId: PATIENT, providerId: PROVIDER, exp: Math.floor(NOW / 1000) + APP_ACCESS_CHECKOUT_TOKEN_TTL_SEC });
    expect(verifyAppAccessCheckoutToken(token, NOW + APP_ACCESS_CHECKOUT_TOKEN_TTL_SEC * 1000)).toBeNull();
    const [p, prov, exp, sig] = token.split(".");
    expect(verifyAppAccessCheckoutToken(`${STRANGER}.${prov}.${exp}.${sig}`, NOW)).toBeNull();
    expect(verifyAppAccessCheckoutToken(`${p}.${Buffer.from(OTHER_PROVIDER).toString("base64url")}.${exp}.${sig}`, NOW)).toBeNull();
    expect(verifyAppAccessCheckoutToken(`${p}.${prov}.${Number(exp) + 60}.${sig}`, NOW)).toBeNull();
    expect(verifyAppAccessCheckoutToken(`${p}.${prov}.${exp}.${sig.slice(0, -1)}0`, NOW)).toBeNull();
    expect(verifyAppAccessCheckoutToken("", NOW)).toBeNull();
    expect(verifyAppAccessCheckoutToken("a.b.c", NOW)).toBeNull();
    expect(verifyAppAccessCheckoutToken(`${p}.${prov}.${exp}.${sig}.extra`, NOW)).toBeNull();
    // UUID-shaped provider ids (fixtures) work too.
    const fixture = mintAppAccessCheckoutToken(PATIENT, "office-1", NOW);
    expect(verifyAppAccessCheckoutToken(fixture, NOW)?.providerId).toBe("office-1");
  });
});

describe("patient entitlement read", () => {
  it("requires a session", async () => {
    expect((await call("GET", "/patient-data/billing/app-access")).status).toBe(401);
  });

  it("locks a non-THINNR patient after the trial and offers a checkout link", async () => {
    const res = await entitlement();
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      available: false, reason: "locked", office_charges: true, price_cents: 699, cadence: "2_weeks",
      free_window: { kind: "trial", ends_on: dayKey(-30 + 6) }, subscription: null, subscription_id: null,
    });
    const url = res.json!.checkout_url as string;
    expect(url.startsWith("https://billing.example/pay/app-access/")).toBe(true);
    expect(verifyAppAccessCheckoutToken(tokenFromCheckoutUrl(url))).toMatchObject({ patientId: PATIENT, providerId: PROVIDER });
  });

  it("keeps a patient inside the free window available, with no link while nothing is owed", async () => {
    seed({ activatedDaysAgo: 2 });
    const trial = await entitlement();
    expect(trial.json).toMatchObject({ available: true, reason: "trial", free_window: { kind: "trial", ends_on: dayKey(-2 + 6) }, checkout_url: expect.any(String) });
    seed({ activatedDaysAgo: 30, programId: "thinnr" });
    const protocol = await entitlement();
    expect(protocol.json).toMatchObject({ available: true, reason: "protocol_window", free_window: { kind: "protocol", ends_on: dayKey(-30 + 42) } });
  });

  it("never offers a link when the office does not charge", async () => {
    seed({ charges: false });
    const res = await entitlement();
    expect(res.json).toMatchObject({ available: true, reason: "office_not_charging", office_charges: false, price_cents: null, checkout_url: null });
  });

  it("reflects the subscription: active and canceled-but-paid-through are available, lapsed is locked", async () => {
    const active = subscription({ status: "active" });
    let res = await entitlement();
    expect(res.json).toMatchObject({ available: true, reason: "subscribed", subscription: { state: "active", cancel_at_period_end: false }, subscription_id: active.id, checkout_url: null });

    backend.tables.billing_subscriptions = [];
    const canceled = subscription({ status: "canceled", cancel_at_period_end: true, canceled_at: iso(-1), current_period_end: iso(5) });
    res = await entitlement();
    expect(res.json).toMatchObject({ available: true, reason: "subscribed", subscription: { state: "canceled", current_period_end: canceled.current_period_end } });
    // A cancelled subscription is closed: the patient may start a new one.
    expect(res.json!.checkout_url).toEqual(expect.any(String));

    backend.tables.billing_subscriptions = [];
    subscription({ status: "canceled", canceled_at: iso(-20), current_period_end: iso(-6) });
    res = await entitlement();
    expect(res.json).toMatchObject({ available: false, reason: "locked", subscription: { state: "canceled" }, checkout_url: expect.any(String) });

    backend.tables.billing_subscriptions = [];
    subscription({ status: "past_due", current_period_end: iso(-1) });
    res = await entitlement();
    expect(res.json).toMatchObject({ available: true, reason: "subscribed", subscription: { state: "past_due" }, checkout_url: null });
  });
});

describe("public app-access checkout", () => {
  async function freshToken(): Promise<string> {
    const res = await entitlement();
    return tokenFromCheckoutUrl(res.json!.checkout_url as string);
  }

  it("answers 404 for an expired or forged token", async () => {
    expect((await call("GET", "/billing/public/app-access/not-a-token")).status).toBe(404);
    const expired = mintAppAccessCheckoutToken(PATIENT, PROVIDER, NOW - 2 * APP_ACCESS_CHECKOUT_TOKEN_TTL_SEC * 1000);
    expect((await call("GET", `/billing/public/app-access/${expired}`)).status).toBe(404);
    expect((await call("POST", `/billing/public/app-access/${expired}/checkout`, { body: {} })).status).toBe(404);
  });

  it("previews the office's current price and whether the patient already subscribes", async () => {
    const token = await freshToken();
    const preview = await call("GET", `/billing/public/app-access/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.json).toEqual({ office_name: "Harbor Clinic", price_cents: 699, cadence: "2_weeks", cadence_label: "every 2 weeks", already_subscribed: false, sandbox: true });
    subscription({ status: "active" });
    expect((await call("GET", `/billing/public/app-access/${token}`)).json).toMatchObject({ already_subscribed: true });
  });

  it("refuses when the office stopped charging between the link and the page", async () => {
    const token = await freshToken();
    backend.tables.billing_office_settings[0].app_access_enabled = false;
    expect((await call("GET", `/billing/public/app-access/${token}`)).status).toBe(409);
    expect((await call("POST", `/billing/public/app-access/${token}/checkout`, { body: {} })).status).toBe(409);
    expect(backend.tables.billing_subscriptions).toHaveLength(0);
  });

  it("starts the subscription on the office's connected account with the flat 30% share snapshotted", async () => {
    const token = await freshToken();
    const res = await call("POST", `/billing/public/app-access/${token}/checkout`, { body: {} });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      client_secret: "secret_in_first_sub_1", stripe_account_id: `acct_${PROVIDER.slice(-4)}`, publishable_key: "pk_test_fake",
      sandbox: true, price_cents: 699, cadence: "2_weeks", cadence_label: "every 2 weeks", office_name: "Harbor Clinic",
    });
    expect(res.json!.order_number).toMatch(/^TH-[A-Z0-9]{6}$/);

    const [sub] = backend.tables.billing_subscriptions;
    expect(sub).toMatchObject({
      provider_id: PROVIDER, patient_id: PATIENT, product_id: APP_ACCESS_PRODUCT_ID, kind: "app_access", status: "incomplete",
      unit_price_cents: 699, shipping_charge_cents: 0, application_fee_cents: 209, cadence_weeks: 2, quantity: 1,
      stripe_subscription_id: "sub_1", stripe_customer_id: "cus_pat", next_shipment_at: null,
    });
    expect(typeof sub.cancel_token).toBe("string");
    const [order] = backend.tables.billing_orders;
    expect(order).toMatchObject({
      id: res.json!.order_id, kind: "subscription_initial", subscription_id: sub.id, status: "pending", subtotal_cents: 699,
      shipping_charge_cents: 0, total_cents: 699, application_fee_cents: 209, thinnr_share_percent: 30, hard_cost_cents: 0,
      fulfillment_status: "not_required", stripe_invoice_id: "in_first_sub_1", stripe_payment_intent_id: "pi_in_first_sub_1",
      metadata: { app_access: { cadence: "2_weeks" } },
    });
    expect(backend.tables.billing_order_items[0]).toMatchObject({ order_id: order.id, product_id: APP_ACCESS_PRODUCT_ID, quantity: 1, unit_price_cents: 699, floor_price_cents_snapshot: 0, thinnr_share_cents: 209 });
    expect(backend.tables.billing_payers[0]).toMatchObject({ provider_id: PROVIDER, patient_id: PATIENT, stripe_customer_id: "cus_pat" });

    const created = stripe.calls.find((c) => c.method === "subscriptions.create")!;
    expect(created.account).toBe(`acct_${PROVIDER.slice(-4)}`);
    expect(created.params).toMatchObject({
      customer: "cus_pat", items: [{ price: "price_app_699" }], payment_behavior: "default_incomplete",
      metadata: { thinnr_subscription_id: sub.id, thinnr_order_id: order.id, thinnr_kind: "app_access" },
    });
    // The percent Stripe applies never collects more than the floored 209¢ share.
    expect(Math.floor(699 * created.params.application_fee_percent / 100)).toBe(209);
    expect(created.params.application_fee_percent).toBeLessThanOrEqual(30);
    // The customer carries no shipping profile: nothing ships.
    const customer = stripe.calls.find((c) => c.method === "customers.create")!;
    expect(customer.params.shipping).toBeUndefined();
    expect(stripe.calls.every((c) => c.account === `acct_${PROVIDER.slice(-4)}`)).toBe(true);
    // No new Stripe price was minted: the mirror already matched.
    expect(stripe.calls.some((c) => c.method === "prices.create")).toBe(false);

    const status = await call("GET", `/billing/public/app-access/${token}/orders/${order.id}`);
    expect(status.json).toEqual({ status: "pending", subscription_status: "incomplete" });
    expect((await call("GET", `/billing/public/app-access/${token}/orders/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call("GET", `/billing/public/app-access/${token}/orders/nope`)).status).toBe(404);
  });

  it("mints the Stripe price lazily when the office saved a new amount without a mirror", async () => {
    backend.tables.billing_office_settings[0].app_access_price_cents = 10000;
    backend.tables.billing_office_settings[0].app_access_cadence = "monthly";
    const token = await freshToken();
    const res = await call("POST", `/billing/public/app-access/${token}/checkout`, { body: {} });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ price_cents: 10000, cadence: "monthly", cadence_label: "monthly" });
    const minted = stripe.calls.find((c) => c.method === "prices.create")!;
    expect(minted.params).toMatchObject({ unit_amount: 10000, recurring: { interval: "month", interval_count: 1 } });
    expect(stripe.calls.find((c) => c.method === "prices.update")!.params).toMatchObject({ id: "price_app_699", active: false });
    expect(backend.tables.billing_app_access_prices[0]).toMatchObject({ price_cents: 10000, cadence: "monthly", stripe_price_id: "price_app_10000" });
    expect(backend.tables.billing_subscriptions[0]).toMatchObject({ unit_price_cents: 10000, application_fee_cents: 3000, cadence_weeks: 4 });
  });

  it("rejects options in the body and a second open subscription", async () => {
    const token = await freshToken();
    expect((await call("POST", `/billing/public/app-access/${token}/checkout`, { body: { price_cents: 1 } })).status).toBe(400);
    subscription({ status: "active" });
    const res = await call("POST", `/billing/public/app-access/${token}/checkout`, { body: {} });
    expect(res.status).toBe(409);
    expect(res.json!.error).toMatch(/already have/);
    expect(backend.tables.billing_orders).toHaveLength(0);
  });

  it("retires an abandoned first attempt on Stripe before opening another (two payment tabs cannot both charge)", async () => {
    const token = await freshToken();
    expect((await call("POST", `/billing/public/app-access/${token}/checkout`, { body: {} })).status).toBe(200);
    const first = backend.tables.billing_subscriptions.find((row) => row.status === "incomplete")!;
    expect(first.stripe_subscription_id).toBe("sub_1");
    stripe.calls = [];
    const again = await call("POST", `/billing/public/app-access/${token}/checkout`, { body: {} });
    expect(again.status).toBe(200);
    // Order of operations: the OLD Stripe subscription is checked and cancelled
    // on the connected account (voiding its open invoice) before the new one exists.
    const methods = stripe.calls.map((c) => c.method);
    expect(methods.indexOf("subscriptions.retrieve")).toBeLessThan(methods.indexOf("subscriptions.cancel"));
    expect(methods.indexOf("subscriptions.cancel")).toBeLessThan(methods.indexOf("subscriptions.create"));
    expect(stripe.calls.find((c) => c.method === "subscriptions.cancel")).toMatchObject({ params: "sub_1", account: `acct_${PROVIDER.slice(-4)}` });
    expect(stripe.subscriptions.get("sub_1").status).toBe("canceled");
    const statuses = backend.tables.billing_subscriptions.map((row) => row.status).sort();
    expect(statuses).toEqual(["canceled", "incomplete"]);
    expect(backend.tables.billing_subscriptions.find((row) => row.id === first.id)).toMatchObject({ status: "canceled", canceled_at: expect.any(String) });
    // The abandoned first order is closed too, so the "done" page of the stale tab shows it as not paid.
    const orders = backend.tables.billing_orders.filter((row) => row.subscription_id === first.id);
    expect(orders.map((row) => row.status)).toEqual(["canceled"]);
    expect(backend.tables.billing_subscriptions.filter((row) => row.status === "incomplete")).toHaveLength(1);
    expect(backend.tables.billing_subscriptions.find((row) => row.status === "incomplete")!.stripe_subscription_id).toBe("sub_2");
  });

  it("refuses a second checkout when Stripe already shows the first attempt paid (webhook still in flight)", async () => {
    const token = await freshToken();
    expect((await call("POST", `/billing/public/app-access/${token}/checkout`, { body: {} })).status).toBe(200);
    const first = backend.tables.billing_subscriptions[0];
    stripe.subscriptions.get("sub_1").status = "active";
    stripe.calls = [];
    const again = await call("POST", `/billing/public/app-access/${token}/checkout`, { body: {} });
    expect(again.status).toBe(409);
    expect(again.json!.error).toMatch(/already have/);
    expect(stripe.calls.map((c) => c.method)).not.toContain("subscriptions.cancel");
    expect(stripe.calls.map((c) => c.method)).not.toContain("subscriptions.create");
    // The paid attempt's row is untouched for the webhook to activate.
    expect(backend.tables.billing_subscriptions).toHaveLength(1);
    expect(backend.tables.billing_subscriptions[0]).toMatchObject({ id: first.id, status: "incomplete", stripe_subscription_id: "sub_1" });
  });

  it("releases the slot locally when Stripe no longer knows the abandoned attempt", async () => {
    const token = await freshToken();
    expect((await call("POST", `/billing/public/app-access/${token}/checkout`, { body: {} })).status).toBe(200);
    stripe.subscriptions.delete("sub_1");
    const again = await call("POST", `/billing/public/app-access/${token}/checkout`, { body: {} });
    expect(again.status).toBe(200);
    expect(backend.tables.billing_subscriptions.map((row) => row.status).sort()).toEqual(["canceled", "incomplete"]);
  });

  it("fails honestly when Stripe cannot create the subscription", async () => {
    const token = await freshToken();
    stripe.failSubscriptionCreate = true;
    const res = await call("POST", `/billing/public/app-access/${token}/checkout`, { body: {} });
    expect(res.status).toBe(502);
    expect(backend.tables.billing_orders[0]).toMatchObject({ status: "failed", metadata: { app_access: { cadence: "2_weeks" }, error: "Stripe is down" } });
    expect(backend.tables.billing_subscriptions[0]).toMatchObject({ status: "canceled" });
    // The patient still gets a (fresh) offer afterwards.
    expect((await entitlement()).json!.checkout_url).toEqual(expect.any(String));
  });

  it("keeps one patient's token from reaching another office's patient", async () => {
    const forged = mintAppAccessCheckoutToken(STRANGER, PROVIDER, NOW);
    const res = await call("POST", `/billing/public/app-access/${forged}/checkout`, { body: {} });
    // The stranger is not this office's patient: payer resolution refuses.
    expect(res.status).toBe(404);
    expect(res.json!.error).toBe("Patient not found.");
    expect(backend.tables.billing_subscriptions.filter((row) => row.patient_id === STRANGER && row.status === "incomplete")).toHaveLength(0);
  });
});
