/**
 * The HQ office access routes over the in-memory access store: the board and
 * its counts, one office's detail (including an office nothing has touched
 * yet), and each HQ write — included period, lifetime, trial reset, price
 * override, paid-through with a source, and an offline payment that clears a
 * restriction. Permission gating is proven here too: reads need
 * `financial_read`, writes need `provider_manage`, and no route can complete
 * an office's payment setup for it.
 *
 * The state machine itself is proven in billing/office-access/engine.test.ts;
 * these tests check the wire shape and who may call what.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ tables: {} as Record<string, any[]>, seq: 0, audits: [] as any[] }));

vi.mock("../billing/store", () => {
  const rows = (table: string) => (db.tables[table] ??= []);
  const parse = (query: string) => {
    const params = new URLSearchParams(query);
    const filters: Array<(row: any) => boolean> = [];
    let order: Array<[string, string]> = [];
    let limit = Infinity;
    for (const [key, value] of params) {
      if (key === "select") continue;
      if (key === "order") { order = value.split(",").map((part) => part.split(".") as [string, string]); continue; }
      if (key === "limit") { limit = Number(value); continue; }
      if (value === "is.null") { filters.push((row) => row[key] === null || row[key] === undefined); continue; }
      const inList = /^in\.\((.*)\)$/.exec(value);
      if (inList) { const set = inList[1].split(","); filters.push((row) => set.includes(String(row[key]))); continue; }
      const cmp = /^(gte|lt)\.(.*)$/.exec(value);
      if (cmp) {
        const bound = decodeURIComponent(cmp[2]);
        filters.push((row) => (cmp[1] === "gte" ? String(row[key]) >= bound : String(row[key]) < bound));
        continue;
      }
      const eq = /^eq\.(.*)$/.exec(value);
      if (!eq) throw new Error(`fake store: unsupported filter ${key}=${value}`);
      filters.push((row) => String(row[key]) === decodeURIComponent(eq[1]));
    }
    return { filters, order, limit };
  };
  const query = (table: string, q: string) => {
    const { filters, order, limit } = parse(q);
    let out = rows(table).filter((row) => filters.every((keep) => keep(row)));
    for (const [key, dir] of [...order].reverse()) {
      out = out.sort((a, b) => (String(a[key] ?? "") < String(b[key] ?? "") ? -1 : 1) * (dir === "desc" ? -1 : 1));
    }
    return out.slice(0, limit);
  };
  const defaults = (table: string): Record<string, unknown> => {
    if (table === "billing_office_access_subscriptions") {
      return {
        state: "setup_incomplete", plan: "monthly", price_cents_override: null,
        included_period_started_at: null, included_period_ends_at: null, lifetime: false,
        paid_through: null, paid_through_source: null, current_period_start: null, current_period_end: null,
        grace_started_at: null, grace_ends_at: null, restricted_at: null, stripe_customer_id: null,
        setup_completed_at: null, bank_verification_deadline: null, last_attempt_at: null, version: 0,
      };
    }
    if (table === "billing_office_access_instruments") return { removed_at: null, verification_status: "verified", verification_deadline: null };
    if (table === "billing_office_access_attempts") return { status: "processing", stripe_payment_intent_id: null, failure_code: null, failure_message: null, settled_at: null, failed_at: null };
    return {};
  };
  return {
    selectMany: async (table: string, q = "") => query(table, q),
    selectOne: async (table: string, q = "") => query(table, q)[0] ?? null,
    insert: async (table: string, row: any) => {
      const stored = { id: `${table.replace("billing_office_access_", "")}-${++db.seq}`, created_at: new Date().toISOString(), ...defaults(table), ...row };
      rows(table).push(stored);
      return stored;
    },
    insertIgnore: async (table: string, row: any) => { rows(table).push(row); return row; },
    upsert: async (table: string, row: any) => { rows(table).push(row); return row; },
    update: async (table: string, q: string, patch: any) => {
      const hits = query(table, q);
      for (const hit of hits) Object.assign(hit, patch);
      return hits[0] ?? null;
    },
    remove: async () => undefined,
    nowIso: () => new Date().toISOString(),
  };
});

vi.mock("../lib/org-policy", () => ({
  loadOrgPolicy: async () => ({
    accessBilling: {
      monthlyPriceCents: 20_000, yearlyPriceCents: 200_000,
      includedPeriodDays: 365, gracePeriodDays: 7,
      normalSharePercent: 60, restrictedSharePercent: 100,
      softwareIncludedPeriodDays: 30,
    },
  }),
}));

vi.mock("../lib/admin-audit", () => ({
  recordAdminAuditEvent: async (event: any) => { db.audits.push(event); },
  requestIdOf: () => null,
}));

vi.mock("../lib/audit-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/audit-events")>();
  return {
    ...actual,
    resolveAuditNames: async () => ({ actors: new Map([["hq-user", "Dana Reeve"]]), offices: new Map(), targets: new Map() }),
  };
});

/** Bearer tokens name the caller's HQ permissions; anything else is forbidden. */
const GRANTS: Record<string, string[]> = {
  "hq-manage": ["financial_read", "provider_manage"],
  "hq-read": ["financial_read"],
};
vi.mock("../lib/staff-auth", () => ({
  requireHqPermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = String(req.headers.authorization ?? "").replace("Bearer ", "");
    if (!GRANTS[token]?.includes(permission)) { res.status(403).json({ error: "Forbidden." }); return; }
    res.locals.staff = { userId: "hq-user", email: "dana@thinnr.example.com" };
    next();
  },
}));

const providers = [
  { provider_id: "office-1", office_name: "Beacon Hill", provider_name: null, access_disabled: false, offboarding_status: "active" },
  { provider_id: "office-2", office_name: "Cedar Park", provider_name: null, access_disabled: false, offboarding_status: "active", office_kind: "software" },
  { provider_id: "office-3", office_name: null, provider_name: "Dr Wells", access_disabled: true, offboarding_status: "active" },
];
vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: async (_method: string, path: string) => {
    if (path.startsWith("/rest/v1/providers")) {
      const one = /provider_id=eq\.([^&]+)/.exec(path);
      return { status: 200, json: one ? providers.filter((row) => row.provider_id === decodeURIComponent(one[1])) : providers };
    }
    return { status: 404, json: null };
  },
}));

import router from "./hq-office-access";
import { recordOfflinePayment, setIncludedPeriod } from "../billing/office-access/admin";
import { findAccessSubscription } from "../billing/office-access/subscription";

const DAY = 86_400_000;
const ACTOR = { kind: "hq" as const, userId: "hq-user" };

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { db.tables = {}; db.seq = 0; db.audits = []; });

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** An office already inside an included period. */
async function withIncludedPeriod(providerId: string, days: number): Promise<void> {
  await setIncludedPeriod({ providerId, actor: ACTOR, days });
}

/** An office whose recovery window closed unpaid. */
async function restrictedOffice(providerId: string): Promise<void> {
  await setIncludedPeriod({ providerId, actor: ACTOR, days: 0 });
  const row = (await findAccessSubscription(providerId))!;
  const now = Date.now();
  Object.assign(row, {
    state: "restricted",
    setup_completed_at: new Date(now - 60 * DAY).toISOString(),
    included_period_ends_at: new Date(now - 30 * DAY).toISOString(),
    current_period_start: new Date(now - 30 * DAY).toISOString(),
    current_period_end: new Date(now - 30 * DAY).toISOString(),
    grace_started_at: new Date(now - 10 * DAY).toISOString(),
    grace_ends_at: new Date(now - 3 * DAY).toISOString(),
    restricted_at: new Date(now - 3 * DAY).toISOString(),
  });
}

describe("the board", () => {
  it("lists every live office, counts the states, and says honestly when nothing has happened yet", async () => {
    await withIncludedPeriod("office-1", 20);
    await restrictedOffice("office-2");

    const { status, body } = await call("GET", "/hq/office-access", { token: "hq-read" });
    expect(status).toBe(200);
    expect(body.offices).toHaveLength(3);
    const byId = Object.fromEntries(body.offices.map((row: any) => [row.providerId, row]));
    expect(byId["office-1"].state).toBe("included_period");
    expect(byId["office-2"].state).toBe("restricted");
    // Nothing has touched office-3: null, not a zeroed-out subscription.
    expect(byId["office-3"].state).toBeNull();
    expect(byId["office-3"].priceCents).toBeNull();
    expect(byId["office-3"].officeName).toBe("Dr Wells");
    expect(byId["office-3"].locked).toBe(true);

    expect(body.counts).toMatchObject({ total: 3, notStarted: 1, includedPeriod: 1, restricted: 1 });
    // The 20-day included period is inside the "ending soon" window.
    expect(body.counts.trialsEndingSoon).toBe(1);
    expect(body.policy).toMatchObject({ monthlyPriceCents: 20_000, gracePeriodDays: 7, maxIncludedPeriodDays: 1095 });
    expect(body.trialEndingSoonDays).toBeGreaterThan(0);
  });

  it("reports the grace days an office has left", async () => {
    await setIncludedPeriod({ providerId: "office-1", actor: ACTOR, days: 0 });
    const row = (await findAccessSubscription("office-1"))!;
    Object.assign(row, { state: "past_due", grace_ends_at: new Date(Date.now() + 3 * DAY).toISOString() });

    const { body } = await call("GET", "/hq/office-access", { token: "hq-read" });
    const office = body.offices.find((item: any) => item.providerId === "office-1");
    expect(office.graceDaysLeft).toBe(3);
  });

  it("is refused without financial read", async () => {
    expect((await call("GET", "/hq/office-access", { token: "nobody" })).status).toBe(403);
    expect((await call("GET", "/hq/office-access")).status).toBe(403);
  });

  it("shows what is on file, the trial countdown, next charge amount, last result and flags", async () => {
    await withIncludedPeriod("office-1", 20);
    const row = (await findAccessSubscription("office-1"))!;
    Object.assign(row, { setup_completed_at: new Date().toISOString(), price_cents_override: 15_000 });
    const later = new Date(Date.now() + 400 * DAY);
    db.tables.billing_office_access_instruments = [
      { id: "i1", subscription_id: row.id, provider_id: "office-1", slot: "bank", kind: "bank", bank_name: "Chase", last4: "6789",
        brand: null, exp_month: null, exp_year: null, verification_status: "pending", removed_at: null, created_at: new Date().toISOString() },
      { id: "i2", subscription_id: row.id, provider_id: "office-1", slot: "card_primary", kind: "card", bank_name: null, last4: "4242",
        brand: "visa", exp_month: later.getUTCMonth() + 1, exp_year: later.getUTCFullYear(), verification_status: "verified", removed_at: null,
        created_at: new Date().toISOString() },
    ];
    db.tables.billing_office_access_attempts = [
      { id: "a1", subscription_id: row.id, provider_id: "office-1", period_start: new Date().toISOString(), period_end: new Date().toISOString(),
        cycle: 0, slot: "card_primary", plan: "monthly", amount_cents: 15_000, status: "failed", failure_code: "card_declined",
        failure_message: null, settled_at: null, failed_at: new Date(Date.now() - DAY).toISOString(), created_at: new Date(Date.now() - DAY).toISOString() },
    ];

    const { body } = await call("GET", "/hq/office-access", { token: "hq-read" });
    const office = body.offices.find((item: any) => item.providerId === "office-1");
    expect(office.trialDaysLeft).toBe(20);
    expect(office.nextChargeCents).toBe(15_000);
    expect(office.instruments.map((item: any) => [item.slot, item.last4, item.verificationStatus])).toEqual([
      ["bank", "6789", "pending"], ["card_primary", "4242", "verified"],
    ]);
    expect(office.lastPayment).toMatchObject({ outcome: "failed", failureCode: "card_declined", amountCents: 15_000 });
    // The card still carries the charge; only the unverified bank is flagged.
    expect(office.paymentFlags).toEqual(["bank_unverified"]);
    const untouched = body.offices.find((item: any) => item.providerId === "office-3");
    expect(untouched).toMatchObject({ instruments: [], trialDaysLeft: null, nextChargeCents: null, lastPayment: null, paymentFlags: [] });
  });
});

function dayKey(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
}

describe("forecast and collected history", () => {
  it("projects the charges in the window at each office's price and keeps past due as outstanding", async () => {
    await withIncludedPeriod("office-1", 10);
    Object.assign((await findAccessSubscription("office-1"))!, { setup_completed_at: new Date().toISOString(), price_cents_override: 15_000 });
    await restrictedOffice("office-2");

    const { status, body } = await call("GET", `/hq/office-access/forecast?start=${dayKey(0)}&end=${dayKey(29)}&bucket=week`, { token: "hq-read" });
    expect(status).toBe(200);
    expect(body.estimate).toBe(true);
    expect(body.bucket).toBe("week");
    const office1 = body.charges.filter((c: any) => c.providerId === "office-1");
    expect(office1).toHaveLength(1);
    expect(office1[0]).toMatchObject({ type: "trial_conversion", amountCents: 15_000, plan: "monthly" });
    // The restricted office owes one period now (outstanding); its future renewal is at risk.
    expect(body.outstanding.offices).toEqual([expect.objectContaining({ providerId: "office-2", amountCents: 20_000, state: "restricted" })]);
    expect(body.outstanding.totalCents).toBe(20_000);
    expect(body.totals.totalCents).toBe(body.charges.reduce((s: number, c: any) => s + c.amountCents, 0));
  });

  it("rejects a missing, reversed or over-long window", async () => {
    expect((await call("GET", "/hq/office-access/forecast", { token: "hq-read" })).status).toBe(400);
    expect((await call("GET", `/hq/office-access/forecast?start=${dayKey(10)}&end=${dayKey(0)}`, { token: "hq-read" })).status).toBe(400);
    expect((await call("GET", `/hq/office-access/forecast?start=${dayKey(0)}&end=${dayKey(500)}`, { token: "hq-read" })).status).toBe(400);
    expect((await call("GET", `/hq/office-access/collected?start=2026-02-30&end=${dayKey(0)}`, { token: "hq-read" })).status).toBe(400);
  });

  it("summarizes collected app revenue by month and outcome", async () => {
    await withIncludedPeriod("office-1", 0);
    const row = (await findAccessSubscription("office-1"))!;
    const t = (days: number) => new Date(Date.now() + days * DAY).toISOString();
    db.tables.billing_office_access_attempts = [
      { id: "a1", subscription_id: row.id, provider_id: "office-1", period_start: t(-5), period_end: t(25), cycle: 0, slot: "card_primary",
        plan: "monthly", amount_cents: 20_000, status: "succeeded", failure_code: null, failure_message: null, settled_at: t(-5), failed_at: null, created_at: t(-5) },
      { id: "a2", subscription_id: row.id, provider_id: "office-1", period_start: t(-6), period_end: t(24), cycle: 0, slot: "bank",
        plan: "monthly", amount_cents: 20_000, status: "failed", failure_code: "insufficient_funds", failure_message: null, settled_at: null, failed_at: t(-6), created_at: t(-6) },
    ];
    db.tables.billing_office_access_events = [
      { id: 1, subscription_id: row.id, provider_id: "office-1", event: "offline_payment", detail: { amountCents: 7_500 }, created_at: t(-2) },
      { id: 2, subscription_id: row.id, provider_id: "office-1", event: "hq_terms", detail: {}, created_at: t(-2) },
    ];
    const { status, body } = await call("GET", `/hq/office-access/collected?start=${dayKey(-30)}&end=${dayKey(0)}`, { token: "hq-read" });
    expect(status).toBe(200);
    expect(body.totals).toMatchObject({ collectedCents: 20_000, offlineCents: 7_500, failedCount: 1, failedCents: 20_000, netCents: 27_500 });
    expect(body.months.reduce((s: number, m: any) => s + m.netCents, 0)).toBe(27_500);
  });

  it("is refused without financial read", async () => {
    expect((await call("GET", `/hq/office-access/forecast?start=${dayKey(0)}&end=${dayKey(29)}`, { token: "nobody" })).status).toBe(403);
    expect((await call("GET", `/hq/office-access/collected?start=${dayKey(-30)}&end=${dayKey(0)}`)).status).toBe(403);
  });
});

describe("one office", () => {
  it("returns terms, attempts and attributed history", async () => {
    await withIncludedPeriod("office-1", 30);
    const row = (await findAccessSubscription("office-1"))!;
    (db.tables.billing_office_access_attempts ??= []).push({
      id: "attempt-1", subscription_id: row.id, provider_id: "office-1", cycle: 1, slot: "card_primary", plan: "monthly",
      amount_cents: 20_000, status: "failed", failure_code: "card_declined", failure_message: "Declined.",
      period_start: new Date(Date.now() - 10 * DAY).toISOString(), period_end: new Date().toISOString(),
      settled_at: null, failed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });

    const { status, body } = await call("GET", "/hq/office-access/office-1", { token: "hq-read" });
    expect(status).toBe(200);
    expect(body.office).toEqual({ providerId: "office-1", officeName: "Beacon Hill", officeKind: "reseller" });
    expect(body.policy).toMatchObject({ officeKind: "reseller", includedPeriodDays: 365, resellerIncludedPeriodDays: 365, softwareIncludedPeriodDays: 30 });
    expect(body.subscription.state).toBe("included_period");
    expect(body.subscription.priceCents).toBe(20_000);
    expect(body.attempts[0]).toMatchObject({ status: "failed", failureCode: "card_declined", amountCents: 20_000 });
    expect(body.history.length).toBeGreaterThan(0);
    expect(body.history[0].actorName).toBe("Dana Reeve");
    // Setup is reported, never granted: no instruments means nothing is on file.
    expect(body.instruments).toEqual([]);
    expect(body.setup.complete).toBe(false);
    expect(body.setup.missing.sort()).toEqual(["bank", "card_backup", "card_primary"]);
  });

  it("reports an untouched office as no subscription rather than zeros", async () => {
    const { status, body } = await call("GET", "/hq/office-access/office-2", { token: "hq-read" });
    expect(status).toBe(200);
    expect(body.subscription).toBeNull();
    expect(body.setup).toBeNull();
    expect(body.attempts).toEqual([]);
    // office-2 is software-only: the standard window reported is the software default.
    expect(body.policy.includedPeriodDays).toBe(30);
    expect(body.policy.resellerIncludedPeriodDays).toBe(365);
  });

  it("404s an office that is not on the platform", async () => {
    expect((await call("GET", "/hq/office-access/nope", { token: "hq-read" })).status).toBe(404);
  });
});

describe("HQ writes", () => {
  it("sets an included period and refuses more than three years", async () => {
    const granted = await call("POST", "/hq/office-access/office-1/included-period", { token: "hq-manage", body: { days: 90 } });
    expect(granted.status).toBe(200);
    expect(granted.body.subscription.state).toBe("included_period");
    const endsAt = Date.parse(granted.body.subscription.includedPeriodEndsAt);
    expect(Math.round((endsAt - Date.now()) / DAY)).toBe(90);

    const tooLong = await call("POST", "/hq/office-access/office-1/included-period", { token: "hq-manage", body: { days: 1096 } });
    expect(tooLong.status).toBe(400);
  });

  it("switches an office to lifetime and back", async () => {
    const lifetime = await call("POST", "/hq/office-access/office-1/included-period", { token: "hq-manage", body: { lifetime: true } });
    expect(lifetime.body.subscription.lifetime).toBe(true);
    expect(lifetime.body.subscription.nextChargeAt).toBeNull();

    const back = await call("POST", "/hq/office-access/office-1/included-period", { token: "hq-manage", body: { lifetime: false, days: 30 } });
    expect(back.body.subscription.lifetime).toBe(false);
    expect(back.body.subscription.includedPeriodEndsAt).not.toBeNull();
  });

  it("resets a trial to a fresh period from now", async () => {
    await withIncludedPeriod("office-1", 2);
    const reset = await call("POST", "/hq/office-access/office-1/reset-trial", { token: "hq-manage", body: { days: 60 } });
    expect(reset.status).toBe(200);
    expect(reset.body.subscription.state).toBe("included_period");
    const startedAt = Date.parse(reset.body.subscription.includedPeriodStartedAt);
    expect(Math.abs(startedAt - Date.now())).toBeLessThan(10_000);
    expect(Math.round((Date.parse(reset.body.subscription.includedPeriodEndsAt) - Date.now()) / DAY)).toBe(60);
  });

  it("describes a software-only office with its own included period and resets its trial to that default", async () => {
    const detail = await call("GET", "/hq/office-access/office-2", { token: "hq-read" });
    expect(detail.status).toBe(200);
    expect(detail.body.office).toEqual({ providerId: "office-2", officeName: "Cedar Park", officeKind: "software" });
    expect(detail.body.policy).toMatchObject({ officeKind: "software", includedPeriodDays: 30, resellerIncludedPeriodDays: 365 });
    const board = await call("GET", "/hq/office-access", { token: "hq-read" });
    expect(board.body.offices.find((item: any) => item.providerId === "office-2").officeKind).toBe("software");
    expect(board.body.offices.find((item: any) => item.providerId === "office-1").officeKind).toBe("reseller");
    // Reset without a length: the software default, not the reseller year.
    const reset = await call("POST", "/hq/office-access/office-2/reset-trial", { token: "hq-manage", body: {} });
    expect(reset.status).toBe(200);
    expect(Math.round((Date.parse(reset.body.subscription.includedPeriodEndsAt) - Date.now()) / DAY)).toBe(30);
    const resellerReset = await call("POST", "/hq/office-access/office-1/reset-trial", { token: "hq-manage", body: {} });
    expect(Math.round((Date.parse(resellerReset.body.subscription.includedPeriodEndsAt) - Date.now()) / DAY)).toBe(365);
  });

  it("overrides the price and restores the list price", async () => {
    const overridden = await call("POST", "/hq/office-access/office-1/terms", { token: "hq-manage", body: { plan: "yearly", priceCentsOverride: 150_000 } });
    expect(overridden.body.subscription.plan).toBe("yearly");
    expect(overridden.body.subscription.priceCents).toBe(150_000);
    expect(overridden.body.subscription.priceCentsOverride).toBe(150_000);

    const cleared = await call("POST", "/hq/office-access/office-1/terms", { token: "hq-manage", body: { priceCentsOverride: null } });
    expect(cleared.body.subscription.priceCentsOverride).toBeNull();
    expect(cleared.body.subscription.priceCents).toBe(200_000);
  });

  it("records a paid-through date with the source HQ chose", async () => {
    const paidThrough = new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10);
    const { status, body } = await call("POST", "/hq/office-access/office-1/paid-through", {
      token: "hq-manage",
      body: { paidThrough, source: "hq_migration" },
    });
    expect(status).toBe(200);
    expect(body.subscription.paidThrough?.slice(0, 10)).toBe(paidThrough);
    expect(body.subscription.paidThroughSource).toBe("hq_migration");
    expect(body.subscription.state).toBe("paid_current");
    // The migrated office still has to add its own bank account and cards.
    expect(body.subscription.setupCompletedAt).toBeNull();
  });

  it("rejects a paid-through date that is not a date", async () => {
    const { status } = await call("POST", "/hq/office-access/office-1/paid-through", { token: "hq-manage", body: { paidThrough: "whenever", source: "offline" } });
    expect(status).toBe(400);
  });

  it("clears a restriction when an offline payment is recorded", async () => {
    await restrictedOffice("office-1");
    const before = await call("GET", "/hq/office-access/office-1", { token: "hq-read" });
    expect(before.body.subscription.state).toBe("restricted");

    const paidThrough = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
    const { status, body } = await call("POST", "/hq/office-access/office-1/offline-payment", {
      token: "hq-manage",
      body: { paidThrough, amountCents: 20_000 },
    });
    expect(status).toBe(200);
    expect(body.subscription.state).toBe("paid_current");
    expect(body.subscription.restrictedAt).toBeNull();
    expect(body.subscription.graceEndsAt).toBeNull();
    expect(body.subscription.paidThroughSource).toBe("offline");

    const after = await call("GET", "/hq/office-access/office-1", { token: "hq-read" });
    expect(after.body.subscription.state).toBe("paid_current");
    expect(after.body.history.some((entry: any) => entry.event === "offline_payment" && entry.actorKind === "hq")).toBe(true);
  });

  it("attributes every change to the HQ user who made it", async () => {
    await call("POST", "/hq/office-access/office-1/reset-trial", { token: "hq-manage", body: { days: 30 } });
    const { body } = await call("GET", "/hq/office-access/office-1", { token: "hq-read" });
    const entry = body.history.find((row: any) => row.event === "trial_reset");
    expect(entry).toMatchObject({ actorKind: "hq", actorUserId: "hq-user", actorName: "Dana Reeve" });
    expect(db.audits.map((event) => event.action)).toContain("office_access_trial_reset");
  });

  it("refuses every write to a reader and to an unknown caller", async () => {
    const writes: Array<[string, unknown]> = [
      ["included-period", { days: 30 }],
      ["reset-trial", {}],
      ["terms", { plan: "monthly" }],
      ["paid-through", { paidThrough: "2027-01-01", source: "offline" }],
      ["offline-payment", { paidThrough: "2027-01-01" }],
    ];
    for (const [path, body] of writes) {
      expect((await call("POST", `/hq/office-access/office-1/${path}`, { token: "hq-read", body })).status).toBe(403);
      expect((await call("POST", `/hq/office-access/office-1/${path}`, { body })).status).toBe(403);
    }
    expect(await findAccessSubscription("office-1")).toBeNull();
  });
});
