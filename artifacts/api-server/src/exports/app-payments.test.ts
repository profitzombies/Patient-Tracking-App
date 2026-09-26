/**
 * The three App payments reports (what offices pay THINNR for the platform):
 * every read is office-access only and pinned to the job's frozen Test/Live
 * identity, and the CSVs carry the columns HQ asked for. Nothing from the
 * patient shop, office sales or the Connect ledger is ever requested.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const admin = vi.hoisted(() => vi.fn());
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: admin }));
vi.mock("../routes/operational-rollups", () => ({ loadOfficeRollups: vi.fn() }));
vi.mock("../lib/org-policy", () => ({
  loadOrgPolicy: async () => ({
    accessBilling: {
      monthlyPriceCents: 20_000, yearlyPriceCents: 200_000, includedPeriodDays: 30,
      gracePeriodDays: 7, normalSharePercent: 60, restrictedSharePercent: 100,
    },
  }),
}));
import { GENERATORS } from "./generators";
import type { ExportScope } from "./kinds";

const DAY = 86_400_000;
const now = Date.now();
const iso = (days: number) => new Date(now + days * DAY).toISOString();
const day = (days: number) => iso(days).slice(0, 10);

const scope = (range: { start: string; end: string } | null): ExportScope => ({
  billingIdentity: { mode: "test", platformAccountId: "acct_fixture" },
  providerId: null, officeName: null, requesterKind: "hq", requesterRole: "admin", range, patient: null,
});

const sub = (patch: Record<string, unknown>) => ({
  plan: "monthly", price_cents_override: null, included_period_started_at: iso(-60), included_period_ends_at: iso(-30),
  lifetime: false, paid_through: null, paid_through_source: null, current_period_start: null, current_period_end: null,
  grace_started_at: null, grace_ends_at: null, restricted_at: null, stripe_customer_id: "cus", setup_completed_at: iso(-59),
  bank_verification_deadline: null, last_attempt_at: null, version: 1, created_at: iso(-60), state: "paid_current",
  ...patch,
});

const TABLES: Record<string, unknown[]> = {
  providers: [
    { provider_id: "p-a", office_name: "Aspen Spa", provider_name: null },
    { provider_id: "p-b", office_name: "Birch Clinic", provider_name: null },
    { provider_id: "p-c", office_name: "Cove Med", provider_name: null },
  ],
  billing_office_access_subscriptions: [
    sub({ id: "s-a", provider_id: "p-a", paid_through: iso(10), price_cents_override: 15_000 }),
    sub({ id: "s-b", provider_id: "p-b", plan: "yearly", paid_through: null, included_period_ends_at: iso(20), setup_completed_at: iso(-1) }),
    sub({ id: "s-c", provider_id: "p-c", paid_through: iso(-4), grace_started_at: iso(-4), grace_ends_at: iso(3), state: "past_due" }),
  ],
  billing_office_access_instruments: [
    { id: "i1", subscription_id: "s-a", provider_id: "p-a", slot: "bank", kind: "bank", bank_name: "Chase", last4: "6789", brand: null,
      exp_month: null, exp_year: null, verification_status: "verified", removed_at: null, created_at: iso(-59) },
    { id: "i2", subscription_id: "s-a", provider_id: "p-a", slot: "card_primary", kind: "card", bank_name: null, last4: "4242", brand: "visa",
      exp_month: 12, exp_year: 2099, verification_status: "verified", removed_at: null, created_at: iso(-59) },
    { id: "i3", subscription_id: "s-b", provider_id: "p-b", slot: "bank", kind: "bank", bank_name: "Wells", last4: "1111", brand: null,
      exp_month: null, exp_year: null, verification_status: "pending", removed_at: null, created_at: iso(-1) },
  ],
  billing_office_access_attempts: [
    { id: "a1", subscription_id: "s-a", provider_id: "p-a", period_start: iso(-20), period_end: iso(10), cycle: 0, slot: "bank",
      plan: "monthly", amount_cents: 15_000, status: "succeeded", failure_code: null, failure_message: null,
      settled_at: iso(-18), failed_at: null, created_at: iso(-20) },
    { id: "a2", subscription_id: "s-c", provider_id: "p-c", period_start: iso(-4), period_end: iso(26), cycle: 0, slot: "card_primary",
      plan: "monthly", amount_cents: 20_000, status: "failed", failure_code: "card_declined", failure_message: "Declined",
      settled_at: null, failed_at: iso(-4), created_at: iso(-4) },
  ],
  billing_office_access_events: [],
};

const paths: string[] = [];
beforeEach(() => {
  paths.length = 0;
  admin.mockReset().mockImplementation(async (_method: string, path: string) => {
    paths.push(path);
    const table = /^\/rest\/v1\/([a-z_]+)/.exec(path)?.[1] ?? "";
    if (!(table in TABLES)) throw new Error(`app payments reports must not read ${table}`);
    const rows = table === "billing_office_access_attempts" && path.includes("status=eq.processing") ? [] : TABLES[table];
    return { status: 200, json: rows, contentRange: null };
  });
});

function column(sheet: { header: string[]; rows: unknown[][] }, name: string, row: number): unknown {
  return sheet.rows[row][sheet.header.indexOf(name)];
}

describe("app payments reports", () => {
  it("billable offices: one row per office with plan, price, what is on file, next charge and problems", async () => {
    const sheet = await GENERATORS.app_payments_offices(scope(null));
    expect(sheet.rows.map((row) => row[0])).toEqual(["Aspen Spa", "Birch Clinic", "Cove Med"]);
    for (const row of sheet.rows) expect(row).toHaveLength(sheet.header.length);
    expect(column(sheet, "Price (USD)", 0)).toBe("150.00");
    expect(column(sheet, "Price override", 0)).toBe("Yes");
    expect(column(sheet, "Next charge date", 0)).toBe(day(10));
    expect(column(sheet, "Bank last four", 0)).toBe("6789");
    expect(column(sheet, "Primary card last four", 0)).toBe("4242");
    expect(column(sheet, "Primary card expiry", 0)).toBe("12/2099");
    expect(column(sheet, "Last payment result", 0)).toBe("succeeded");
    expect(column(sheet, "Trial days left", 1)).toBe(20);
    expect(column(sheet, "Price (USD)", 1)).toBe("2000.00");
    expect(column(sheet, "Payment problems", 1)).toBe("No usable payment method; Bank not verified");
    expect(column(sheet, "Last payment result", 2)).toBe("failed");
  });

  it("scheduled charges and forecast: line items, month and window totals, and past due kept apart as outstanding", async () => {
    const sheet = await GENERATORS.app_payments_forecast(scope({ start: day(0), end: day(29) }));
    const types = sheet.rows.map((row) => row[0]);
    const charges = sheet.rows.filter((row) => row[0] === "Scheduled charge");
    expect(charges.map((row) => [row[2], row[3], row[5]])).toEqual(expect.arrayContaining([
      ["Aspen Spa", "Renewal", "150.00"],
      ["Birch Clinic", "Trial conversion", "2000.00"],
      ["Cove Med", "Renewal", "200.00"],
    ]));
    expect(types).toContain("Month total");
    const window = sheet.rows.find((row) => row[0] === "Window total")!;
    expect(window[5]).toBe("2350.00");
    const owed = sheet.rows.filter((row) => row[0] === "Outstanding (past due)");
    expect(owed).toHaveLength(1);
    expect(owed[0][2]).toBe("Cove Med");
    expect(owed[0][5]).toBe("200.00");
    // The owed period is not in the window total: 150 + 2000 + next month's 200 only.
    expect(charges.filter((row) => row[2] === "Cove Med")).toHaveLength(1);
  });

  it("app payment transactions: every attempt in range with method, amount and outcome", async () => {
    const sheet = await GENERATORS.app_payments_transactions(scope({ start: day(-30), end: day(0) }));
    expect(sheet.rows).toHaveLength(2);
    const [first, second] = sheet.rows;
    expect(first.slice(1, 5)).toEqual(["Aspen Spa", "p-a", "Charge attempt", "succeeded"]);
    expect(column(sheet, "Method type", 0)).toBe("bank");
    expect(column(sheet, "Last four", 0)).toBe("6789");
    expect(column(sheet, "Net (USD)", 0)).toBe("150.00");
    expect(second.slice(1, 5)).toEqual(["Cove Med", "p-c", "Charge attempt", "failed"]);
    expect(column(sheet, "Net (USD)", 1)).toBe("0.00");
    expect(column(sheet, "Failure code", 1)).toBe("card_declined");
  });

  it("reads only office-access tables, each pinned to the frozen Test/Live identity", async () => {
    await GENERATORS.app_payments_offices(scope(null));
    await GENERATORS.app_payments_forecast(scope({ start: day(0), end: day(29) }));
    await GENERATORS.app_payments_transactions(scope({ start: day(-30), end: day(0) }));
    const billing = paths.filter((path) => path.startsWith("/rest/v1/billing_"));
    expect(billing.length).toBeGreaterThan(0);
    for (const path of billing) {
      expect(path).toMatch(/^\/rest\/v1\/billing_office_access_/);
      expect(path).toContain("stripe_mode=eq.test");
      expect(path).toContain("stripe_platform_account_id=eq.acct_fixture");
    }
  });

  it("refuses to run without a frozen billing identity", async () => {
    await expect((async () => GENERATORS.app_payments_offices({ ...scope(null), billingIdentity: undefined }))()).rejects.toThrow(/frozen billing identity/);
  });
});
