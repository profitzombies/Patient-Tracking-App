/**
 * The setup gate: the question every office request asks before it is allowed
 * to do anything. The engine decides what an office is charged; this decides
 * whether the office is in.
 *
 * The behaviours proven here are the ones the gate can get dangerously wrong:
 * letting an office in before its money arrangements exist, keeping an office
 * out while its bank account is legitimately awaiting microdeposits, and
 * forgetting to put it back out when that 48-hour window runs out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ tables: {} as Record<string, any[]>, seq: 0 }));
const stripeState = vi.hoisted(() => ({ methods: {} as Record<string, any>, setupIntents: {} as Record<string, any>, customers: 0 }));

vi.mock("../store", () => {
  const rows = (table: string) => (db.tables[table] ??= []);
  const query = (table: string, q: string) => {
    const params = new URLSearchParams(q);
    let out = rows(table);
    let limit = Infinity;
    for (const [key, value] of params) {
      if (key === "select") continue;
      if (key === "order") continue;
      if (key === "limit") { limit = Number(value); continue; }
      if (value === "is.null") { out = out.filter((row) => row[key] === null || row[key] === undefined); continue; }
      const eq = /^eq\.(.*)$/.exec(value);
      if (!eq) throw new Error(`fake store: unsupported filter ${key}=${value}`);
      out = out.filter((row) => String(row[key]) === eq[1]);
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
        plan_selected_at: null, disclosure_acknowledged_at: null, disclosure_acknowledged_by: null, disclosure_version: null,
      };
    }
    if (table === "billing_office_access_instruments") {
      return { removed_at: null, verification_status: "verified", verification_deadline: null, setup_intent_id: null };
    }
    return {};
  };
  return {
    selectMany: async (table: string, q = "") => query(table, q),
    selectOne: async (table: string, q = "") => query(table, q)[0] ?? null,
    insert: async (table: string, row: any) => {
      const stored = { id: `${table}-${++db.seq}`, created_at: new Date().toISOString(), ...defaults(table), ...row };
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

const policy = vi.hoisted(() => ({
  version: 9,
  accessBilling: {
    monthlyPriceCents: 20_000, yearlyPriceCents: 200_000, includedPeriodDays: 365,
    gracePeriodDays: 7, normalSharePercent: 60, restrictedSharePercent: 100,
    disclosureText: "HQ wording the office must accept.",
  },
}));
vi.mock("../../lib/org-policy", () => ({ loadOrgPolicy: async () => policy }));
vi.mock("../../lib/admin-audit", () => ({ recordAdminAuditEvent: async () => undefined, requestIdOf: () => null }));
vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: async () => ({ status: 200, json: null }) }));

const stripe = {
  customers: { create: async () => ({ id: `cus_${++stripeState.customers}` }) },
  paymentMethods: {
    retrieve: async (id: string) => stripeState.methods[id],
    attach: async (id: string) => stripeState.methods[id],
  },
  setupIntents: { retrieve: async (id: string) => stripeState.setupIntents[id] },
};
vi.mock("../stripe-client", () => ({ getStripe: async () => stripe }));

import { attachAccessInstrument } from "./instruments";
import { findAccessSubscription } from "./subscription";
import {
  AccessSetupError, accessGateFacts, accessGateSatisfied, accessSetupSnapshot,
  acknowledgeAccessDisclosure, clearBankVerificationUrlCache, refreshBankVerification, selectAccessPlan,
} from "./setup";

const OFFICE = "office-1";
const HOUR = 3_600_000;
const ACTOR = { kind: "provider" as const, userId: "owner-1" };

function card(id: string, fingerprint: string, last4: string): any {
  return { id, type: "card", card: { fingerprint, brand: "visa", last4, exp_month: 12, exp_year: 2030 } };
}
function bankMethod(id: string, instant: boolean): any {
  return {
    id, type: "us_bank_account",
    us_bank_account: { fingerprint: `fp_${id}`, last4: "6789", bank_name: "Test Bank", financial_connections_account: instant ? "fca_1" : null },
  };
}

/** Everything the gate wants except the plan and the disclosure. */
async function addInstruments(options: { bankInstant?: boolean } = {}): Promise<void> {
  stripeState.methods.pm_bank = bankMethod("pm_bank", options.bankInstant ?? true);
  stripeState.methods.pm_card1 = card("pm_card1", "fp_a", "4242");
  stripeState.methods.pm_card2 = card("pm_card2", "fp_b", "1881");
  await attachAccessInstrument({ providerId: OFFICE, slot: "bank", paymentMethodId: "pm_bank", setupIntentId: "seti_bank" });
  await attachAccessInstrument({ providerId: OFFICE, slot: "card_primary", paymentMethodId: "pm_card1" });
  await attachAccessInstrument({ providerId: OFFICE, slot: "card_backup", paymentMethodId: "pm_card2" });
}

async function finishSetup(): Promise<void> {
  await addInstruments();
  await selectAccessPlan({ providerId: OFFICE, plan: "yearly", actor: ACTOR });
  await acknowledgeAccessDisclosure({ providerId: OFFICE, version: policy.version, actor: ACTOR });
}

function snapshot(overrides: Partial<Parameters<typeof accessSetupSnapshot>[0]> = {}) {
  return accessSetupSnapshot({
    providerId: OFFICE, officeName: "Test Office", connect: "ready", sandbox: true,
    canManage: true, canChoosePlan: true, ...overrides,
  });
}

beforeEach(() => {
  db.tables = {}; db.seq = 0;
  stripeState.methods = {}; stripeState.setupIntents = {}; stripeState.customers = 0;
  clearBankVerificationUrlCache();
});

describe("the gate verdict", () => {
  it("keeps a brand new office out", async () => {
    expect(await accessGateSatisfied(OFFICE)).toBe(false);
  });

  it("still refuses an office that has every instrument but chose no plan", async () => {
    await addInstruments();
    const facts = await accessGateFacts(OFFICE);
    expect(facts.status.complete).toBe(true);
    expect(facts.planSelected).toBe(false);
    expect(facts.satisfied).toBe(false);
  });

  it("still refuses an office that never accepted the terms", async () => {
    await addInstruments();
    await selectAccessPlan({ providerId: OFFICE, plan: "monthly", actor: ACTOR });
    expect(await accessGateSatisfied(OFFICE)).toBe(false);
  });

  it("lets an office in once instruments, plan and disclosure are all in place", async () => {
    await finishSetup();
    expect(await accessGateSatisfied(OFFICE)).toBe(true);
  });

  it("lets a microdeposit office in on its cards, then puts it back out when the window lapses", async () => {
    await addInstruments({ bankInstant: false });
    await selectAccessPlan({ providerId: OFFICE, plan: "monthly", actor: ACTOR });
    await acknowledgeAccessDisclosure({ providerId: OFFICE, version: policy.version, actor: ACTOR });

    const pending = await accessGateFacts(OFFICE);
    expect(pending.status.bankVerificationPending).toBe(true);
    expect(pending.satisfied).toBe(true);

    const later = new Date(Date.now() + 49 * HOUR);
    const lapsed = await accessGateFacts(OFFICE, later);
    expect(lapsed.status.bankVerificationOverdue).toBe(true);
    expect(lapsed.satisfied).toBe(false);
  });
});

describe("the setup snapshot", () => {
  it("reports each step and what is still missing", async () => {
    const fresh = await snapshot({ connect: "pending" });
    expect(fresh.complete).toBe(false);
    expect(fresh.steps.map((step) => [step.id, step.status])).toEqual([
      ["connect", "pending"], ["bank", "todo"], ["card_primary", "todo"],
      ["card_backup", "todo"], ["plan", "todo"], ["disclosure", "todo"],
    ]);
    expect(fresh.steps[0].detail).toContain("reviewing");

    await finishSetup();
    const done = await snapshot();
    expect(done.complete).toBe(true);
    expect(done.steps.every((step) => step.status === "done")).toBe(true);
    expect(done.connectAlreadyDone).toBe(true);
  });

  it("is not complete while the office has yet to connect Stripe, however ready its own instruments are", async () => {
    await finishSetup();
    expect((await snapshot({ connect: "not_started" })).complete).toBe(false);
  });

  it("shows both cards apart, the real prices and the HQ disclosure", async () => {
    await finishSetup();
    const view = await snapshot();
    expect(view.instruments.map((item) => [item.slot, item.last4])).toEqual([
      ["bank", "6789"], ["card_primary", "4242"], ["card_backup", "1881"],
    ]);
    expect(view.plan).toMatchObject({ selected: "yearly", monthlyPriceCents: 20_000, yearlyPriceCents: 200_000, priceCents: 200_000 });
    expect(view.disclosure).toMatchObject({ text: policy.accessBilling.disclosureText, version: policy.version });
    expect(view.disclosure.acknowledgedAt).not.toBeNull();
  });

  it("dates the first charge at the end of the included period and says what the next period buys", async () => {
    await finishSetup();
    const row = (await findAccessSubscription(OFFICE))!;
    const ends = new Date(Date.now() + 30 * 24 * HOUR).toISOString();
    Object.assign(row, { state: "included_period", included_period_ends_at: ends });
    const view = await snapshot();
    expect(view.plan.firstChargeAt).toBe(ends);
    // A yearly plan buys the year that follows the first charge.
    expect(Date.parse(view.plan.nextPeriodEndsAt!) - Date.parse(ends)).toBeGreaterThan(300 * 24 * HOUR);
  });

  it("hands back Stripe's own microdeposit page rather than asking for the amounts", async () => {
    await addInstruments({ bankInstant: false });
    stripeState.setupIntents.seti_bank = {
      id: "seti_bank", status: "requires_action",
      next_action: { verify_with_microdeposits: { hosted_verification_url: "https://stripe.test/verify" } },
    };
    const view = await snapshot();
    expect(view.bank).toMatchObject({ verificationPending: true, overdue: false, windowHours: 48, verificationUrl: "https://stripe.test/verify" });
    expect(view.bank.deadline).not.toBeNull();
  });

  it("asks Stripe for the microdeposit page once rather than on every setup click", async () => {
    await addInstruments({ bankInstant: false });
    stripeState.setupIntents.seti_bank = {
      id: "seti_bank", status: "requires_action",
      next_action: { verify_with_microdeposits: { hosted_verification_url: "https://stripe.test/verify" } },
    };
    const retrieve = vi.spyOn(stripe.setupIntents, "retrieve");
    try {
      expect((await snapshot()).bank.verificationUrl).toBe("https://stripe.test/verify");
      expect((await snapshot()).bank.verificationUrl).toBe("https://stripe.test/verify");
      expect(retrieve).toHaveBeenCalledTimes(1);
    } finally { retrieve.mockRestore(); }
  });

  it("records the verification once Stripe reports the SetupIntent succeeded", async () => {
    await addInstruments({ bankInstant: false });
    stripeState.setupIntents.seti_bank = { id: "seti_bank", status: "requires_action" };
    expect(await refreshBankVerification({ providerId: OFFICE, actor: ACTOR })).toEqual({ verified: false });

    stripeState.setupIntents.seti_bank = { id: "seti_bank", status: "succeeded" };
    expect(await refreshBankVerification({ providerId: OFFICE, actor: ACTOR })).toEqual({ verified: true });
    const facts = await accessGateFacts(OFFICE);
    expect(facts.status.bankVerificationPending).toBe(false);
  });

  it("refuses to verify when there is no bank account on file", async () => {
    await expect(refreshBankVerification({ providerId: OFFICE, actor: ACTOR })).rejects.toBeInstanceOf(AccessSetupError);
  });
});

describe("plan and disclosure", () => {
  it("answers a plan choice or acknowledgment with fresh state built from the written row", async () => {
    await addInstruments();
    const planned = await selectAccessPlan({ providerId: OFFICE, plan: "yearly", actor: ACTOR });
    let view = await snapshot({ row: planned });
    expect(view.plan.selected).toBe("yearly");
    expect(view.steps.find((step) => step.id === "plan")?.status).toBe("done");
    expect(view.complete).toBe(false);
    const acknowledged = await acknowledgeAccessDisclosure({ providerId: OFFICE, version: policy.version, actor: ACTOR });
    view = await snapshot({ row: acknowledged });
    expect(view.disclosure.acknowledgedAt).not.toBeNull();
    expect(view.complete).toBe(true);
    // Connect and sandbox may arrive still in flight; the snapshot waits for them.
    view = await snapshot({ row: acknowledged, connect: Promise.resolve("not_started"), sandbox: Promise.resolve(false) });
    expect(view).toMatchObject({ complete: false, connect: { state: "not_started", sandbox: false } });
  });


  it("treats the plan as chosen only once the office actually chose it", async () => {
    const before = await accessGateFacts(OFFICE);
    // The column has always carried a default, so its value proves nothing.
    expect(before.row.plan).toBe("monthly");
    expect(before.planSelected).toBe(false);
    await selectAccessPlan({ providerId: OFFICE, plan: "monthly", actor: ACTOR });
    expect((await accessGateFacts(OFFICE)).planSelected).toBe(true);
  });

  it("sends a paying office to support rather than silently repricing it", async () => {
    await selectAccessPlan({ providerId: OFFICE, plan: "monthly", actor: ACTOR });
    const row = (await findAccessSubscription(OFFICE))!;
    Object.assign(row, { paid_through: new Date().toISOString() });
    await expect(selectAccessPlan({ providerId: OFFICE, plan: "yearly", actor: ACTOR }))
      .rejects.toMatchObject({ status: 409, code: "plan_locked" });
  });

  it("keeps an acknowledgment valid after HQ rewrites the wording", async () => {
    await finishSetup();
    policy.accessBilling.disclosureText = "Rewritten terms.";
    policy.version = 10;
    const view = await snapshot();
    expect(view.disclosure.text).toBe("Rewritten terms.");
    // Re-gating every office on an HQ copy edit would lock them all out.
    expect(view.complete).toBe(true);
    policy.accessBilling.disclosureText = "HQ wording the office must accept.";
    policy.version = 9;
  });
});
