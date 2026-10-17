/**
 * The office access engine end to end, over an in-memory store and a fake
 * Stripe: instrument setup, the charge waterfall, the late ACH paths that
 * arrive by webhook days later, the recovery schedule, and the HQ overrides.
 *
 * The risky behaviours proven here are the ones money depends on: falling
 * through bank → card → card and stopping at the first success, refusing a
 * backup card that is the same physical card, never submitting a second debit
 * for a period that is already paid or still in flight, and starting the grace
 * clock from the failure NOTIFICATION rather than the original charge date.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ tables: {} as Record<string, any[]>, seq: 0, audits: [] as any[] }));
const stripeState = vi.hoisted(() => ({
  intents: [] as any[],
  customers: 0,
  attached: [] as string[],
  /** payment method id → what a charge on it does. */
  outcomes: {} as Record<string, "succeeded" | "processing" | "decline">,
  methods: {} as Record<string, any>,
  setupIntents: {} as Record<string, any>,
  /** Every customer create/update call, in order. */
  customerCalls: [] as Array<{ op: "create" | "update"; id?: string; params: any }>,
  detached: [] as string[],
  methodUpdates: [] as Array<{ id: string; params: any }>,
  cancelledSetups: [] as string[],
}));
const office = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
}));

vi.mock("../store", () => {
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
      const eq = /^eq\.(.*)$/.exec(value);
      if (!eq) throw new Error(`fake store: unsupported filter ${key}=${value}`);
      filters.push((row) => String(row[key]) === eq[1]);
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
      const stored = {
        id: `${table.replace("billing_office_access_", "")}-${++db.seq}`,
        created_at: new Date().toISOString(), ...defaults(table), ...row,
      };
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

vi.mock("../../lib/org-policy", () => ({
  loadOrgPolicy: async () => ({
    accessBilling: {
      monthlyPriceCents: 20_000, yearlyPriceCents: 200_000,
      includedPeriodDays: 365, gracePeriodDays: 7,
      normalSharePercent: 60, restrictedSharePercent: 100,
    },
  }),
}));

vi.mock("../../lib/admin-audit", () => ({
  recordAdminAuditEvent: async (event: any) => { db.audits.push(event); },
  requestIdOf: () => null,
}));

/** The claim RPC, mirrored in JS; the SQL itself is proven in claim.sql.test.ts. */
vi.mock("../../lib/supabase-admin", () => ({
  supabaseAdmin: async (_method: string, path: string, body: any) => {
    if (path.startsWith("/rest/v1/providers?")) return { status: 200, json: office.row ? [office.row] : [] };
    if (!path.endsWith("/rpc/claim_office_access_charge")) return { status: 404, json: null };
    const attempts = (db.tables.billing_office_access_attempts ?? []).filter(
      (row) => row.subscription_id === body.p_subscription_id && row.period_start === body.p_period_start,
    );
    if (attempts.some((row) => row.status === "succeeded" || row.status === "processing")) return { status: 200, json: null };
    if (body.p_cycle !== null && body.p_cycle !== undefined) {
      if (attempts.some((row) => row.cycle === body.p_cycle)) return { status: 200, json: null };
      return { status: 200, json: body.p_cycle };
    }
    return { status: 200, json: attempts.reduce((max, row) => Math.max(max, row.cycle), 0) + 1 };
  },
}));

const OFFICE_ID = "office-1";
const stripe = {
  customers: {
    create: async (params: any) => {
      const id = `cus_${++stripeState.customers}`;
      stripeState.customerCalls.push({ op: "create", id, params });
      return { id, ...params };
    },
    update: async (id: string, params: any) => { stripeState.customerCalls.push({ op: "update", id, params }); return { id, ...params }; },
    retrieve: async (id: string) => ({ id, metadata: { thinnr_provider_id: OFFICE_ID, thinnr_purpose: "office_access" }, invoice_settings: {} }),
    listPaymentMethods: async (id: string) => ({
      data: Object.values(stripeState.methods).filter((m: any) => m.customer === id),
    }),
  },
  paymentMethods: {
    retrieve: async (id: string) => stripeState.methods[id],
    attach: async (id: string, params: any) => {
      stripeState.attached.push(id);
      if (stripeState.methods[id]) stripeState.methods[id].customer = params.customer;
      return stripeState.methods[id];
    },
    detach: async (id: string) => {
      stripeState.detached.push(id);
      if (stripeState.methods[id]) stripeState.methods[id].customer = null;
      return stripeState.methods[id];
    },
    update: async (id: string, params: any) => {
      stripeState.methodUpdates.push({ id, params });
      const method = stripeState.methods[id];
      if (method) method.billing_details = { ...(method.billing_details ?? {}), ...params.billing_details };
      return method;
    },
  },
  setupIntents: {
    retrieve: async (id: string) => stripeState.setupIntents[id],
    cancel: async (id: string) => { stripeState.cancelledSetups.push(id); return { id, status: "canceled" }; },
  },
  paymentIntents: {
    create: async (params: any) => {
      const outcome = stripeState.outcomes[params.payment_method] ?? "succeeded";
      const intent = { id: `pi_${stripeState.intents.length + 1}`, status: outcome === "decline" ? "requires_payment_method" : outcome, params,
        last_payment_error: outcome === "decline" ? { code: "card_declined", decline_code: "insufficient_funds", message: "Declined." } : undefined };
      stripeState.intents.push(intent);
      if (outcome === "decline") {
        const error: any = new Error("Declined.");
        error.code = "card_declined"; error.decline_code = "insufficient_funds"; error.payment_intent = intent;
        throw error;
      }
      return intent;
    },
  },
};
vi.mock("../stripe-client", () => ({ getStripe: async () => stripe }));

import { chargeAccessPeriod } from "./charge";
import { runDunningStep, runOfficeAccessBilling } from "./dunning";
import { DUPLICATE_CARD_MESSAGE, accessSetupStatus, attachAccessInstrument, listAccessInstruments } from "./instruments";
import { recordOfflinePayment, resetTrial, setIncludedPeriod } from "./admin";
import { anchorIncludedPeriodToAgreement } from "./agreement";
import { noteOwnerDashboardSignIn } from "./sign-in";
import { accessHistory, findAccessSubscription } from "./subscription";
import { registerOfficeAccessWebhookHandlers } from "./webhooks";
import { dispatchStripeEvent, resetStripeEventHandlers } from "../webhooks";

const DAY = 86_400_000;
const OFFICE = "office-1";
const PLATFORM = { kind: "platform" as const, account: null, livemode: false };

function card(id: string, fingerprint: string, last4 = "4242"): any {
  return { id, type: "card", card: { fingerprint, brand: "visa", last4, exp_month: 12, exp_year: 2030 } };
}
function bank(id: string, options: { instant?: boolean } = {}): any {
  return {
    id, type: "us_bank_account",
    us_bank_account: { fingerprint: `fp_${id}`, last4: "6789", bank_name: "Test Bank", financial_connections_account: options.instant ? "fca_1" : null },
  };
}

async function setUpOffice(options: { bankInstant?: boolean } = {}): Promise<void> {
  stripeState.methods.pm_bank = bank("pm_bank", { instant: options.bankInstant ?? true });
  stripeState.methods.pm_card1 = card("pm_card1", "fp_card_a", "4242");
  stripeState.methods.pm_card2 = card("pm_card2", "fp_card_b", "1881");
  await attachAccessInstrument({ providerId: OFFICE, slot: "bank", paymentMethodId: "pm_bank" });
  await attachAccessInstrument({ providerId: OFFICE, slot: "card_primary", paymentMethodId: "pm_card1" });
  await attachAccessInstrument({ providerId: OFFICE, slot: "card_backup", paymentMethodId: "pm_card2" });
}

/** An office whose included period has already lapsed, so a charge is due. */
async function dueOffice(now: Date, options: { bankInstant?: boolean } = {}): Promise<void> {
  await setUpOffice(options);
  const row = (await findAccessSubscription(OFFICE))!;
  Object.assign(row, {
    state: "included_period",
    included_period_started_at: new Date(now.getTime() - 400 * DAY).toISOString(),
    included_period_ends_at: new Date(now.getTime() - DAY).toISOString(),
  });
}

beforeEach(() => {
  db.tables = {}; db.seq = 0; db.audits = [];
  stripeState.intents = []; stripeState.customers = 0; stripeState.attached = [];
  stripeState.outcomes = {}; stripeState.methods = {}; stripeState.setupIntents = {}; stripeState.cancelledSetups = [];
  stripeState.customerCalls = []; stripeState.detached = []; stripeState.methodUpdates = [];
  office.row = {
    provider_id: OFFICE, provider_name: "Dr. Ada Lane", office_name: "Lane Aesthetics", email: "owner@lane.test",
    phone: "(813) 555-0100", address_line_1: "1 Main St", address_line_2: null, city: "Tampa", state: "FL", postal_code: "33602",
  };
  resetStripeEventHandlers();
  registerOfficeAccessWebhookHandlers();
});

describe("setting up instruments", () => {
  it("stores one bank account and two cards and completes setup", async () => {
    await setUpOffice();
    const row = (await findAccessSubscription(OFFICE))!;
    expect(row.stripe_customer_id).toBe("cus_1");
    const instruments = await listAccessInstruments(row.id);
    expect(instruments.map((i) => i.slot).sort()).toEqual(["bank", "card_backup", "card_primary"]);
    expect(accessSetupStatus(instruments).complete).toBe(true);
    expect(row.setup_completed_at).not.toBeNull();
    expect(row.state).toBe("setup_incomplete");
  });

  it("refuses a backup card that is the same physical card as the primary", async () => {
    stripeState.methods.pm_card1 = card("pm_card1", "fp_same", "4242");
    // Re-issued number, different expiry, different last four — same card.
    stripeState.methods.pm_card2 = { ...card("pm_card2", "fp_same", "9999"), card: { fingerprint: "fp_same", brand: "visa", last4: "9999", exp_month: 1, exp_year: 2032 } };
    await attachAccessInstrument({ providerId: OFFICE, slot: "card_primary", paymentMethodId: "pm_card1" });
    await expect(
      attachAccessInstrument({ providerId: OFFICE, slot: "card_backup", paymentMethodId: "pm_card2" }),
    ).rejects.toThrow(DUPLICATE_CARD_MESSAGE);
  });

  it("gives a microdeposit bank account a 48-hour verification deadline", async () => {
    stripeState.methods.pm_bank = bank("pm_bank");
    stripeState.setupIntents.seti_1 = { id: "seti_1", status: "requires_action", payment_method: "pm_bank" };
    const stored = await attachAccessInstrument({ providerId: OFFICE, slot: "bank", paymentMethodId: "pm_bank", setupIntentId: "seti_1" });
    expect(stored.verification_status).toBe("pending");
    const deadline = Date.parse(stored.verification_deadline!) - Date.now();
    expect(deadline).toBeGreaterThan(47 * 3_600_000);
    expect(deadline).toBeLessThanOrEqual(48 * 3_600_000);
    const status = accessSetupStatus(await listAccessInstruments(stored.subscription_id));
    expect(status.bankVerificationPending).toBe(true);
    expect(status.bankVerificationOverdue).toBe(false);
    expect(accessSetupStatus(await listAccessInstruments(stored.subscription_id), new Date(Date.now() + 49 * 3_600_000)).bankVerificationOverdue).toBe(true);
  });
});

describe("the charge waterfall", () => {
  it("stops at the first success", async () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    await dueOffice(now);
    const row = (await findAccessSubscription(OFFICE))!;
    const outcome = await chargeAccessPeriod({ row, now });
    expect(outcome.status).toBe("succeeded");
    expect(stripeState.intents).toHaveLength(1);
    expect(stripeState.intents[0].params.payment_method).toBe("pm_bank");
    expect(stripeState.intents[0].params.amount).toBe(20_000);
    const after = (await findAccessSubscription(OFFICE))!;
    expect(after.state).toBe("paid_current");
    expect(after.paid_through_source).toBe("stripe");
  });

  it("falls through the bank and the primary card to the backup card", async () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    await dueOffice(now);
    stripeState.outcomes = { pm_bank: "decline", pm_card1: "decline", pm_card2: "succeeded" };
    const row = (await findAccessSubscription(OFFICE))!;
    const outcome = await chargeAccessPeriod({ row, now });
    expect(outcome.status === "succeeded" && outcome.slot).toBe("card_backup");
    expect(stripeState.intents.map((i) => i.params.payment_method)).toEqual(["pm_bank", "pm_card1", "pm_card2"]);
    const attempts = db.tables.billing_office_access_attempts;
    expect(attempts.map((a: any) => `${a.slot}:${a.status}`)).toEqual([
      "bank:failed", "card_primary:failed", "card_backup:succeeded",
    ]);
    expect(attempts[0].failure_code).toBe("insufficient_funds");
  });

  it("skips a bank account that is not verified yet", async () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    await dueOffice(now);
    const instruments = await listAccessInstruments((await findAccessSubscription(OFFICE))!.id);
    Object.assign(instruments.find((i) => i.kind === "bank")!, { verification_status: "pending" });
    await chargeAccessPeriod({ row: (await findAccessSubscription(OFFICE))!, now });
    expect(stripeState.intents.map((i) => i.params.payment_method)).toEqual(["pm_card1"]);
  });

  it("starts the grace clock when everything on file fails", async () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    await dueOffice(now);
    stripeState.outcomes = { pm_bank: "decline", pm_card1: "decline", pm_card2: "decline" };
    const outcome = await chargeAccessPeriod({ row: (await findAccessSubscription(OFFICE))!, now });
    expect(outcome.status).toBe("failed");
    const after = (await findAccessSubscription(OFFICE))!;
    expect(after.state).toBe("past_due");
    expect(after.grace_started_at).toBe(now.toISOString());
    expect(after.grace_ends_at).toBe(new Date(now.getTime() + 7 * DAY).toISOString());
  });

  it("does not charge the same period twice", async () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    await dueOffice(now);
    await chargeAccessPeriod({ row: (await findAccessSubscription(OFFICE))!, now });
    const again = await chargeAccessPeriod({
      row: { ...(await findAccessSubscription(OFFICE))!, paid_through: null }, now,
    });
    expect(again.status === "skipped" && again.reason).toBe("already_claimed");
    expect(stripeState.intents).toHaveLength(1);
  });

  it("waits for an accepted ACH debit instead of falling through to the cards", async () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    await dueOffice(now);
    stripeState.outcomes = { pm_bank: "processing" };
    const outcome = await chargeAccessPeriod({ row: (await findAccessSubscription(OFFICE))!, now });
    expect(outcome.status).toBe("processing");
    expect(stripeState.intents).toHaveLength(1);
    const blocked = await chargeAccessPeriod({ row: (await findAccessSubscription(OFFICE))!, now });
    expect(blocked.status === "skipped" && blocked.reason).toBe("already_claimed");
  });
});

describe("late ACH results", () => {
  async function submitDebit(now: Date): Promise<void> {
    await dueOffice(now);
    stripeState.outcomes = { pm_bank: "processing" };
    await chargeAccessPeriod({ row: (await findAccessSubscription(OFFICE))!, now });
  }

  it("marks the office paid when the debit settles days later", async () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    await submitDebit(now);
    vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
    await dispatchStripeEvent(
      { type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } } as any, PLATFORM,
    );
    const after = (await findAccessSubscription(OFFICE))!;
    expect(after.state).toBe("paid_current");
    expect(db.tables.billing_office_access_attempts[0].status).toBe("succeeded");
    vi.useRealTimers();
  });

  it("starts the grace clock at the bounce notification, not the charge date", async () => {
    const charged = new Date("2026-05-01T00:00:00.000Z");
    await submitDebit(charged);
    stripeState.outcomes = { pm_card1: "decline", pm_card2: "decline" };
    const bounced = new Date("2026-05-05T09:00:00.000Z");
    vi.setSystemTime(bounced);
    await dispatchStripeEvent(
      { type: "payment_intent.payment_failed", data: { object: { id: "pi_1", last_payment_error: { code: "debit_not_authorized", message: "Bounced." } } } } as any,
      PLATFORM,
    );
    const after = (await findAccessSubscription(OFFICE))!;
    // The cards were tried immediately, and the seven days run from the bounce.
    expect(stripeState.intents.map((i) => i.params.payment_method)).toEqual(["pm_bank", "pm_card1", "pm_card2"]);
    expect(after.state).toBe("past_due");
    expect(Date.parse(after.grace_started_at!)).toBe(bounced.getTime());
    expect(Date.parse(after.grace_ends_at!)).toBe(bounced.getTime() + 7 * DAY);
    vi.useRealTimers();
  });

  it("recovers automatically when a card works after the bounce", async () => {
    const charged = new Date("2026-05-01T00:00:00.000Z");
    await submitDebit(charged);
    vi.setSystemTime(new Date("2026-05-05T09:00:00.000Z"));
    await dispatchStripeEvent(
      { type: "payment_intent.payment_failed", data: { object: { id: "pi_1", last_payment_error: { code: "debit_not_authorized" } } } } as any,
      PLATFORM,
    );
    const after = (await findAccessSubscription(OFFICE))!;
    expect(after.state).toBe("paid_current");
    expect(after.grace_started_at).toBeNull();
    vi.useRealTimers();
  });

  it("treats a dispute on an access charge as non-payment", async () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    await dueOffice(now);
    await chargeAccessPeriod({ row: (await findAccessSubscription(OFFICE))!, now });
    expect((await findAccessSubscription(OFFICE))!.state).toBe("paid_current");
    vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));
    await dispatchStripeEvent(
      { type: "charge.dispute.created", data: { object: { payment_intent: "pi_1", reason: "fraudulent" } } } as any, PLATFORM,
    );
    expect((await findAccessSubscription(OFFICE))!.state).toBe("past_due");
    vi.useRealTimers();
  });

  it("ignores events from a connected account", async () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    await submitDebit(now);
    await dispatchStripeEvent(
      { type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } } as any,
      { kind: "connect", account: "acct_office", livemode: false } as any,
    );
    expect(db.tables.billing_office_access_attempts[0].status).toBe("processing");
  });
});

describe("the recovery schedule", () => {
  async function inGrace(): Promise<Date> {
    const failedAt = new Date("2026-05-01T00:00:00.000Z");
    await dueOffice(failedAt);
    stripeState.outcomes = { pm_bank: "decline", pm_card1: "decline", pm_card2: "decline" };
    await chargeAccessPeriod({ row: (await findAccessSubscription(OFFICE))!, now: failedAt });
    return failedAt;
  }

  it("retries on day two and leaves the office past due", async () => {
    const start = await inGrace();
    const day2 = new Date(start.getTime() + 2 * DAY);
    const step = await runDunningStep((await findAccessSubscription(OFFICE))!, day2);
    expect(step.action).toBe("charged");
    const attempts = db.tables.billing_office_access_attempts.filter((a: any) => a.cycle === 3);
    expect(attempts.map((a: any) => a.slot)).toEqual(["bank", "card_primary", "card_backup"]);
    expect((await findAccessSubscription(OFFICE))!.state).toBe("past_due");
  });

  it("does not run the same recovery cycle twice", async () => {
    const start = await inGrace();
    const day2 = new Date(start.getTime() + 2 * DAY);
    await runDunningStep((await findAccessSubscription(OFFICE))!, day2);
    const charges = stripeState.intents.length;
    await runDunningStep((await findAccessSubscription(OFFICE))!, new Date(day2.getTime() + 3_600_000));
    expect(stripeState.intents).toHaveLength(charges);
  });

  it("restricts the office at the end of day seven", async () => {
    const start = await inGrace();
    const beforeEnd = new Date(start.getTime() + 7 * DAY - 60_000);
    expect((await runDunningStep((await findAccessSubscription(OFFICE))!, beforeEnd)).action).not.toBe("restricted");
    expect((await findAccessSubscription(OFFICE))!.state).toBe("past_due");

    const end = new Date(start.getTime() + 7 * DAY);
    expect((await runDunningStep((await findAccessSubscription(OFFICE))!, end)).action).toBe("restricted");
    const after = (await findAccessSubscription(OFFICE))!;
    expect(after.state).toBe("restricted");
    expect(after.restricted_at).toBe(end.toISOString());
    const notices = (await accessHistory(OFFICE)).filter((event) => event.event === "dunning_notice");
    expect(notices.some((event) => event.detail.notice === "restricted")).toBe(true);
  });

  it("returns a restricted office to paid the moment a payment lands", async () => {
    const start = await inGrace();
    await runDunningStep((await findAccessSubscription(OFFICE))!, new Date(start.getTime() + 7 * DAY));
    expect((await findAccessSubscription(OFFICE))!.state).toBe("restricted");
    stripeState.outcomes = {};
    const paidAt = new Date(start.getTime() + 9 * DAY);
    const outcome = await chargeAccessPeriod({ row: (await findAccessSubscription(OFFICE))!, cycle: 99, now: paidAt });
    expect(outcome.status).toBe("succeeded");
    const after = (await findAccessSubscription(OFFICE))!;
    expect(after.state).toBe("paid_current");
    expect(after.restricted_at).toBeNull();
  });

  it("counts without writing when the job runs dry", async () => {
    await inGrace();
    const counts: Record<string, number> = {};
    const before = stripeState.intents.length;
    await runOfficeAccessBilling({
      now: new Date("2026-05-08T00:00:00.000Z"), dryRun: true,
      tally: (key) => { counts[key] = (counts[key] ?? 0) + 1; },
      failItem: () => undefined, checkpoint: () => undefined,
    });
    expect(counts.wouldRestrict).toBe(1);
    expect(stripeState.intents).toHaveLength(before);
  });
});

describe("the included period", () => {
  it("starts on the office owner's first dashboard sign-in and never restarts", async () => {
    const first = new Date("2026-01-10T08:00:00.000Z");
    vi.setSystemTime(first);
    await noteOwnerDashboardSignIn({ providerId: OFFICE, staffClass: "provider", authUserId: "user-1" });
    const started = (await findAccessSubscription(OFFICE))!;
    expect(started.included_period_started_at).toBe(first.toISOString());
    expect(started.included_period_ends_at).toBe(new Date(first.getTime() + 365 * DAY).toISOString());
    expect(started.state).toBe("included_period");

    vi.setSystemTime(new Date("2026-02-10T08:00:00.000Z"));
    await noteOwnerDashboardSignIn({ providerId: OFFICE, staffClass: "provider", authUserId: "user-1" });
    expect((await findAccessSubscription(OFFICE))!.included_period_ends_at).toBe(started.included_period_ends_at);
    vi.useRealTimers();
  });

  it("is never started by anyone who is not the office owner", async () => {
    await noteOwnerDashboardSignIn({ providerId: OFFICE, staffClass: "team_member", authUserId: "user-2" });
    await noteOwnerDashboardSignIn({ providerId: OFFICE, staffClass: "hq", authUserId: "user-3" });
    expect(await findAccessSubscription(OFFICE)).toBeNull();
  });
});

describe("HQ overrides", () => {
  const actor = { kind: "hq" as const, userId: "hq-1" };

  it("does not charge during an included period that a corrected agreement date extended past the paid-through date", async () => {
    // Paid through 2026-05-30 after a first charge (the period starts where
    // the lapsed included period ended, 04-30); then HQ corrects the reseller
    // agreement date so the included period runs to 2027-02-01.
    const firstCharge = new Date("2026-05-01T00:00:00.000Z");
    await dueOffice(firstCharge);
    expect((await chargeAccessPeriod({ row: (await findAccessSubscription(OFFICE))!, now: firstCharge })).status).toBe("succeeded");
    const paid = (await findAccessSubscription(OFFICE))!;
    expect(paid.paid_through).toBe("2026-05-30T00:00:00.000Z");

    const corrected = await anchorIncludedPeriodToAgreement({
      providerId: OFFICE, actor, now: new Date("2026-05-15T00:00:00.000Z"),
      facts: { officeKind: "reseller", resellerAgreementSignedOn: "2026-02-01" },
    });
    expect(corrected.included_period_ends_at).toBe("2027-02-01T00:00:00.000Z");
    expect(corrected.paid_through).toBe("2026-05-30T00:00:00.000Z");

    // The billing run passes the old paid-through date: nothing is due.
    const counts: Record<string, number> = {};
    const intentsBefore = stripeState.intents.length;
    const tick = {
      tally: (key: string) => { counts[key] = (counts[key] ?? 0) + 1; },
      failItem: () => undefined, checkpoint: () => undefined,
    };
    await runOfficeAccessBilling({ now: new Date("2026-06-02T00:00:00.000Z"), dryRun: true, ...tick });
    expect(counts.wouldCharge).toBeUndefined();
    await runOfficeAccessBilling({ now: new Date("2026-06-02T00:00:00.000Z"), dryRun: false, ...tick });
    expect(stripeState.intents).toHaveLength(intentsBefore);
    const untouched = (await findAccessSubscription(OFFICE))!;
    expect(untouched.state).toBe("included_period");
    expect(untouched.paid_through).toBe("2026-05-30T00:00:00.000Z");

    // Once the extended included period ends, the next charge collects from there.
    await runOfficeAccessBilling({ now: new Date("2027-02-01T00:00:00.000Z"), dryRun: false, ...tick });
    expect(stripeState.intents).toHaveLength(intentsBefore + 1);
    const charged = (await findAccessSubscription(OFFICE))!;
    expect(charged.state).toBe("paid_current");
    expect(charged.paid_through).toBe("2027-03-01T00:00:00.000Z");
  });

  it("makes an office complimentary for life", async () => {
    await setUpOffice();
    const row = await setIncludedPeriod({ providerId: OFFICE, actor, lifetime: true });
    expect(row.lifetime).toBe(true);
    expect(row.state).toBe("included_period");
    const now = new Date();
    expect((await chargeAccessPeriod({ row, now })).status).toBe("skipped");
    expect(db.audits.map((event) => event.action)).toContain("office_access_included_period_set");
  });

  it("restarts a trial from today", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    vi.setSystemTime(now);
    await noteOwnerDashboardSignIn({ providerId: OFFICE, staffClass: "provider", authUserId: "user-1" });
    const reset = await resetTrial({ providerId: OFFICE, actor, days: 30, now });
    expect(reset.included_period_started_at).toBe(now.toISOString());
    expect(reset.included_period_ends_at).toBe(new Date(now.getTime() + 30 * DAY).toISOString());
    vi.useRealTimers();
  });

  it("clears a restriction when HQ records an offline payment", async () => {
    const start = new Date("2026-05-01T00:00:00.000Z");
    await dueOffice(start);
    stripeState.outcomes = { pm_bank: "decline", pm_card1: "decline", pm_card2: "decline" };
    await chargeAccessPeriod({ row: (await findAccessSubscription(OFFICE))!, now: start });
    await runDunningStep((await findAccessSubscription(OFFICE))!, new Date(start.getTime() + 7 * DAY));
    expect((await findAccessSubscription(OFFICE))!.state).toBe("restricted");

    const now = new Date(start.getTime() + 8 * DAY);
    const row = await recordOfflinePayment({
      providerId: OFFICE, actor, paidThrough: new Date(now.getTime() + 30 * DAY), note: "Cheque", now,
    });
    expect(row.state).toBe("paid_current");
    expect(row.paid_through_source).toBe("offline");
    expect(row.restricted_at).toBeNull();
    expect(db.audits.map((event) => event.action)).toContain("office_access_offline_payment_recorded");
    const history = await accessHistory(OFFICE);
    expect(history.some((event) => event.event === "offline_payment" && event.actor_kind === "hq")).toBe(true);
  });
});

describe("the office's identity in Stripe", () => {
  it("creates the customer already named after the practice and its owner", async () => {
    await setUpOffice();
    const created = stripeState.customerCalls.filter((call) => call.op === "create");
    expect(created).toHaveLength(1);
    expect(created[0].params).toMatchObject({
      name: "Lane Aesthetics",
      business_name: "Lane Aesthetics",
      individual_name: "Dr. Ada Lane",
      email: "owner@lane.test",
      phone: "(813) 555-0100",
      address: { line1: "1 Main St", city: "Tampa", state: "FL", postal_code: "33602", country: "US" },
      metadata: { thinnr_provider_id: OFFICE, thinnr_office_name: "Lane Aesthetics", thinnr_purpose: "office_access" },
    });
    expect(created[0].params.description).toContain("Lane Aesthetics");
  });

  it("puts the practice's name and email on a card saved without them, and remembers it", async () => {
    await setUpOffice();
    expect(stripeState.methods.pm_card1.billing_details).toMatchObject({ name: "Lane Aesthetics", email: "owner@lane.test" });
    const primary = (await listAccessInstruments((await findAccessSubscription(OFFICE))!.id)).find((i) => i.slot === "card_primary")!;
    expect(primary.billing_name).toBe("Lane Aesthetics");
  });

  it("keeps a name the office typed into the form", async () => {
    stripeState.methods.pm_card1 = { ...card("pm_card1", "fp_a"), billing_details: { name: "Ada Lane", email: "ada@lane.test" } };
    await attachAccessInstrument({ providerId: OFFICE, slot: "card_primary", paymentMethodId: "pm_card1" });
    expect(stripeState.methodUpdates.filter((u) => u.id === "pm_card1")).toHaveLength(0);
    expect(stripeState.methods.pm_card1.billing_details.name).toBe("Ada Lane");
  });

  it("makes the primary card Stripe's default for the customer", async () => {
    await setUpOffice();
    const defaults = stripeState.customerCalls.filter((call) => call.params.invoice_settings);
    expect(defaults.at(-1)!.params.invoice_settings.default_payment_method).toBe("pm_card1");
  });

  it("refreshes the customer in every payment mode when the office's details change", async () => {
    await setUpOffice();
    const { syncOfficeStripeIdentity, __setSyncModesForTests } = await import("./customer-identity");
    __setSyncModesForTests(() => [{ mode: "test", platformAccountId: "acct_test" }]);
    office.row = { ...office.row!, office_name: "Lane Aesthetics & Wellness", phone: "(813) 555-0199" };
    const outcomes = await syncOfficeStripeIdentity(OFFICE);
    __setSyncModesForTests(null);
    expect(outcomes).toEqual([{ mode: "test", updated: true }]);
    const last = stripeState.customerCalls.at(-1)!;
    expect(last).toMatchObject({ op: "update", id: "cus_1" });
    expect(last.params).toMatchObject({
      name: "Lane Aesthetics & Wellness", business_name: "Lane Aesthetics & Wellness", phone: "(813) 555-0199",
      metadata: { thinnr_payment_mode: "test", thinnr_office_name: "Lane Aesthetics & Wellness" },
      invoice_settings: { default_payment_method: "pm_card1" },
    });
  });

  it("never throws from a details sync, even when the office cannot be read", async () => {
    const { syncOfficeStripeIdentity, __setSyncModesForTests } = await import("./customer-identity");
    __setSyncModesForTests(() => [{ mode: "test", platformAccountId: "acct_test" }]);
    const outcomes = await syncOfficeStripeIdentity("no-such-office");
    __setSyncModesForTests(null);
    expect(outcomes).toEqual([{ mode: "test", updated: false }]);
  });
});

describe("replacing a card or bank", () => {
  it("detaches the replaced card, keeps its history, and leaves exactly three on file", async () => {
    await setUpOffice();
    stripeState.methods.pm_card3 = card("pm_card3", "fp_card_c", "5555");
    await attachAccessInstrument({ providerId: OFFICE, slot: "card_primary", paymentMethodId: "pm_card3" });
    expect(stripeState.detached).toEqual(["pm_card1"]);
    const all = db.tables.billing_office_access_instruments;
    const old = all.find((i: any) => i.stripe_payment_method_id === "pm_card1");
    expect(old.removed_at).not.toBeNull();
    expect(old.detached_at).not.toBeNull();
    const live = await listAccessInstruments((await findAccessSubscription(OFFICE))!.id);
    expect(live.map((i) => i.stripe_payment_method_id).sort()).toEqual(["pm_bank", "pm_card2", "pm_card3"]);
    expect(stripeState.customerCalls.at(-1)!.params.invoice_settings.default_payment_method).toBe("pm_card3");
    expect(db.tables.billing_office_access_events.map((e: any) => e.event)).toContain("instrument_replaced");
  });

  it("refuses to replace a card with the office's other card, and detaches the refused copy", async () => {
    await setUpOffice();
    stripeState.methods.pm_card2_again = { ...card("pm_card2_again", "fp_card_b", "1881"), customer: "cus_1" };
    await expect(
      attachAccessInstrument({ providerId: OFFICE, slot: "card_primary", paymentMethodId: "pm_card2_again" }),
    ).rejects.toThrow(DUPLICATE_CARD_MESSAGE);
    expect(stripeState.detached).toEqual(["pm_card2_again"]);
    const live = await listAccessInstruments((await findAccessSubscription(OFFICE))!.id);
    expect(live.find((i) => i.slot === "card_primary")!.stripe_payment_method_id).toBe("pm_card1");
  });

  it("refuses moving the backup card into the primary slot", async () => {
    await setUpOffice();
    await expect(
      attachAccessInstrument({ providerId: OFFICE, slot: "card_primary", paymentMethodId: "pm_card2" }),
    ).rejects.toThrow(DUPLICATE_CARD_MESSAGE);
    expect(stripeState.detached).toEqual([]);
  });

  it("treats a retried save of the same card as a no-op", async () => {
    await setUpOffice();
    await attachAccessInstrument({ providerId: OFFICE, slot: "card_backup", paymentMethodId: "pm_card2" });
    expect(stripeState.detached).toEqual([]);
    expect(db.tables.billing_office_access_instruments).toHaveLength(3);
  });

  it("puts the old card back if saving its replacement fails, so the slot is never empty", async () => {
    await setUpOffice();
    stripeState.methods.pm_card3 = card("pm_card3", "fp_card_c", "5555");
    const store = await import("../store");
    const spy = vi.spyOn(store, "insert").mockRejectedValueOnce(new Error("database down"));
    await expect(
      attachAccessInstrument({ providerId: OFFICE, slot: "card_primary", paymentMethodId: "pm_card3" }),
    ).rejects.toThrow("database down");
    spy.mockRestore();
    const live = await listAccessInstruments((await findAccessSubscription(OFFICE))!.id);
    expect(live.find((i) => i.slot === "card_primary")!.stripe_payment_method_id).toBe("pm_card1");
    expect(stripeState.detached).toEqual([]);
  });

  it("does not detach a card while a charge on its slot is still in flight; the job finishes it", async () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    await dueOffice(now);
    const row = (await findAccessSubscription(OFFICE))!;
    db.tables.billing_office_access_attempts = [{
      id: "attempt-x", subscription_id: row.id, slot: "card_primary", status: "processing", cycle: 1,
      period_start: now.toISOString(),
    }];
    stripeState.methods.pm_card3 = card("pm_card3", "fp_card_c", "5555");
    await attachAccessInstrument({ providerId: OFFICE, slot: "card_primary", paymentMethodId: "pm_card3" });
    expect(stripeState.detached).toEqual([]);
    db.tables.billing_office_access_attempts[0].status = "succeeded";
    const { maintainAccessInstruments } = await import("./instruments");
    const kept = await maintainAccessInstruments(row);
    expect(kept.detached).toBe(1);
    expect(stripeState.detached).toEqual(["pm_card1"]);
  });

  it("charges the slot's current card when it was replaced after the waterfall was read", async () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    await dueOffice(now);
    stripeState.outcomes = { pm_bank: "decline" };
    stripeState.methods.pm_card3 = card("pm_card3", "fp_card_c", "5555");
    const row = (await findAccessSubscription(OFFICE))!;
    const original = stripe.paymentIntents.create;
    let swapped = false;
    stripe.paymentIntents.create = async (params: any) => {
      // The replacement lands between the bank decline and the card attempt.
      if (!swapped && params.payment_method === "pm_bank") {
        swapped = true;
        try { return await original(params); } finally {
          await attachAccessInstrument({ providerId: OFFICE, slot: "card_primary", paymentMethodId: "pm_card3" });
        }
      }
      return original(params);
    };
    try {
      const outcome = await chargeAccessPeriod({ row, now });
      expect(outcome.status).toBe("succeeded");
    } finally {
      stripe.paymentIntents.create = original;
    }
    expect(stripeState.intents.map((i) => i.params.payment_method)).toEqual(["pm_bank", "pm_card3"]);
  });
});

describe("replacing a verified bank with one that needs test deposits", () => {
  async function stageReplacement(): Promise<void> {
    await setUpOffice({ bankInstant: true });
    stripeState.methods.pm_bank2 = bank("pm_bank2");
    const customer = (await findAccessSubscription(OFFICE))!.stripe_customer_id;
    stripeState.setupIntents.seti_2 = { id: "seti_2", status: "requires_action", payment_method: "pm_bank2", customer };
    stripeState.attached = [];
    await attachAccessInstrument({ providerId: OFFICE, slot: "bank", paymentMethodId: "pm_bank2", setupIntentId: "seti_2" });
  }

  it("keeps the old bank in service and chargeable until the new one verifies", async () => {
    await stageReplacement();
    const row = (await findAccessSubscription(OFFICE))!;
    const live = await listAccessInstruments(row.id);
    expect(live.find((i) => i.slot === "bank")!.stripe_payment_method_id).toBe("pm_bank");
    expect(stripeState.detached).toEqual([]);
    // Stripe refuses to attach an unverified bank; its SetupIntent attaches it on verification.
    expect(stripeState.attached).not.toContain("pm_bank2");
    expect(stripeState.methodUpdates.map((u) => u.id)).not.toContain("pm_bank2");
    const now = new Date("2030-05-01T00:00:00.000Z");
    Object.assign(row, {
      state: "included_period",
      included_period_started_at: new Date(now.getTime() - 400 * DAY).toISOString(),
      included_period_ends_at: new Date(now.getTime() - DAY).toISOString(),
    });
    const outcome = await chargeAccessPeriod({ row, now });
    expect(outcome.status).toBe("succeeded");
    expect(stripeState.intents[0].params.payment_method).toBe("pm_bank");
  });

  it("hands the slot over when the deposits verify, then detaches the old bank", async () => {
    await stageReplacement();
    await dispatchStripeEvent(
      { type: "setup_intent.succeeded", data: { object: { id: "seti_2", payment_method: "pm_bank2" } } } as any, PLATFORM,
    );
    const live = await listAccessInstruments((await findAccessSubscription(OFFICE))!.id);
    const bankRow = live.find((i) => i.slot === "bank")!;
    expect(bankRow.stripe_payment_method_id).toBe("pm_bank2");
    expect(bankRow.verification_status).toBe("verified");
    expect(bankRow.staged_at).toBeNull();
    expect(stripeState.detached).toEqual(["pm_bank"]);
  });

  it("drops the replacement and keeps the old bank when verification fails", async () => {
    await stageReplacement();
    await dispatchStripeEvent(
      { type: "setup_intent.setup_failed", data: { object: { id: "seti_2", payment_method: "pm_bank2" } } } as any, PLATFORM,
    );
    const live = await listAccessInstruments((await findAccessSubscription(OFFICE))!.id);
    const bankRow = live.find((i) => i.slot === "bank")!;
    expect(bankRow.stripe_payment_method_id).toBe("pm_bank");
    expect(bankRow.verification_status).toBe("verified");
    expect(stripeState.detached).toEqual(["pm_bank2"]);
    expect(stripeState.cancelledSetups).toEqual(["seti_2"]);
  });

  it("drops the replacement when its deposit window runs out", async () => {
    await stageReplacement();
    const { maintainAccessInstruments } = await import("./instruments");
    const row = (await findAccessSubscription(OFFICE))!;
    const kept = await maintainAccessInstruments(row, new Date(Date.now() + 49 * 3_600_000));
    expect(kept.expired).toBe(1);
    const live = await listAccessInstruments(row.id);
    expect(live.find((i) => i.slot === "bank")!.stripe_payment_method_id).toBe("pm_bank");
    expect(stripeState.detached).toEqual(["pm_bank2"]);
    // A late confirmation cannot attach it after it was dropped.
    expect(stripeState.cancelledSetups).toEqual(["seti_2"]);
  });
});

describe("the one-time identity back-fill", () => {
  const TEST = { mode: "test" as const, platformAccountId: "acct_test" };

  async function legacyOffice(): Promise<void> {
    // An office set up before customers carried a name, with one replaced
    // card still attached and a card an abandoned form left behind.
    await setUpOffice();
    for (const method of Object.values(stripeState.methods) as any[]) method.billing_details = {};
    for (const row of db.tables.billing_office_access_instruments) row.billing_name = null;
    stripeState.methods.pm_old = { ...card("pm_old", "fp_old", "0005"), customer: "cus_1" };
    db.tables.billing_office_access_instruments.push({
      ...db.tables.billing_office_access_instruments[1], id: "instruments-old", stripe_payment_method_id: "pm_old",
      removed_at: new Date(Date.now() - DAY).toISOString(), detached_at: null,
    });
    stripeState.methods.pm_stray = { ...card("pm_stray", "fp_stray", "0077"), customer: "cus_1", created: Math.floor((Date.now() - 2 * DAY) / 1000) };
    stripeState.methods.pm_fresh = { ...card("pm_fresh", "fp_fresh", "0088"), customer: "cus_1", created: Math.floor(Date.now() / 1000) };
    stripeState.customerCalls = []; stripeState.detached = []; stripeState.methodUpdates = [];
  }

  it("reports what it would change on a dry run and writes nothing", async () => {
    await legacyOffice();
    const { backfillAccessIdentity } = await import("./identity-backfill");
    const { runWithBillingIdentity } = await import("../stripe-environment");
    const report = await runWithBillingIdentity(TEST, () => backfillAccessIdentity({ apply: false }));
    const [entry] = report.offices;
    expect(entry.customerChanges).toEqual(expect.arrayContaining(["name", "business_name", "individual_name", "email", "address", "metadata", "default_payment_method"]));
    expect(entry.methodNamesFilled).toBe(3);
    expect(entry.replacedDetached).toBe(1);
    expect(entry.untrackedDetached).toEqual(["pm_stray"]);
    expect(stripeState.customerCalls).toEqual([]);
    expect(stripeState.detached).toEqual([]);
    expect(stripeState.methodUpdates).toEqual([]);
    expect(db.tables.billing_office_access_instruments.every((row: any) => row.billing_name === null)).toBe(true);
  });

  it("names the customer, fills method names and leaves only the three in service when applied", async () => {
    await legacyOffice();
    const { backfillAccessIdentity } = await import("./identity-backfill");
    const { runWithBillingIdentity } = await import("../stripe-environment");
    await runWithBillingIdentity(TEST, () => backfillAccessIdentity({ apply: true }));
    const update = stripeState.customerCalls.find((call) => call.op === "update")!;
    expect(update.params).toMatchObject({
      name: "Lane Aesthetics", individual_name: "Dr. Ada Lane",
      metadata: { thinnr_payment_mode: "test", thinnr_provider_id: OFFICE },
      invoice_settings: { default_payment_method: "pm_card1" },
    });
    expect(stripeState.detached.sort()).toEqual(["pm_old", "pm_stray"]);
    const attached = Object.values(stripeState.methods).filter((m: any) => m.customer === "cus_1").map((m: any) => m.id).sort();
    // The form opened moments ago is left alone.
    expect(attached).toEqual(["pm_bank", "pm_card1", "pm_card2", "pm_fresh"]);
    const live = await listAccessInstruments((await findAccessSubscription(OFFICE))!.id);
    expect(live.every((row) => row.billing_name === "Lane Aesthetics")).toBe(true);
  });
});
