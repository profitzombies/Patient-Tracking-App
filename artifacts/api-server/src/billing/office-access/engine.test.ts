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

const stripe = {
  customers: { create: async () => ({ id: `cus_${++stripeState.customers}` }) },
  paymentMethods: {
    retrieve: async (id: string) => stripeState.methods[id],
    attach: async (id: string) => { stripeState.attached.push(id); return stripeState.methods[id]; },
  },
  setupIntents: { retrieve: async (id: string) => stripeState.setupIntents[id] },
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
  stripeState.outcomes = {}; stripeState.methods = {}; stripeState.setupIntents = {};
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
