/**
 * The narrowed-for-nonpayment surface: what a restricted office may still
 * reach, and when an office counts as restricted at all.
 *
 * This policy is the one place every office-scoped route inherits its answer
 * from, so the allow-list and the date derivation are worth pinning exactly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findAccessSubscription = vi.fn();
vi.mock("../billing/office-access/subscription", () => ({
  findAccessSubscription: (...args: unknown[]) => findAccessSubscription(...args),
}));
// Callers of this policy are mostly not billing routes, so it resolves the
// workspace's selected Stripe scope itself before reading the isolated table.
vi.mock("../billing/mode-state", () => ({
  getBillingModeStatus: async () => ({ mode: "test", platformAccountId: "acct_test" }),
}));

const { isRestrictedAllowedPath, officeRestrictedForNonpayment, OFFICE_RESTRICTED_CAPABILITIES } =
  await import("./office-restriction");

const NOW = new Date("2026-03-01T12:00:00.000Z");
const DAY = 86_400_000;
const at = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY).toISOString();

function row(patch: Record<string, unknown> = {}) {
  return {
    id: "sub-1", provider_id: "office-1", state: "paid_current", plan: "monthly",
    price_cents_override: null, included_period_started_at: at(-90), included_period_ends_at: at(-60),
    lifetime: false, paid_through: at(30), paid_through_source: "charge",
    current_period_start: at(-1), current_period_end: at(29),
    grace_started_at: null, grace_ends_at: null, restricted_at: null,
    stripe_customer_id: "cus_1", setup_completed_at: at(-90), bank_verification_deadline: null,
    last_attempt_at: null, version: 3, created_at: at(-90),
    ...patch,
  };
}

describe("restricted office surface", () => {
  it("keeps payment, subscriptions, payouts, export and session paths open", () => {
    for (const path of [
      "/api/office/access",
      "/api/office/access/pay",
      "/api/billing/office/subscriptions",
      "/api/billing/office/subscriptions/sub_1/cancel",
      "/api/billing/office/payouts",
      "/api/billing/office/connect/sync",
      "/api/billing/office/status",
      "/api/exports",
      "/api/exports/jobs/123",
      "/api/security",
      "/api/auth/sign-in",
    ]) {
      expect(isRestrictedAllowedPath(path), path).toBe(true);
    }
  });

  it("refuses roster, messaging, sales, analytics, team and settings", () => {
    for (const path of [
      "/api/office/patients",
      "/api/office/roster",
      "/api/staff/conversations",
      "/api/billing/office/sales",
      "/api/billing/office/orders",
      "/api/office/team",
      "/api/office/settings",
      "/api/operational-rollups",
      "/api/office/alerts",
      "/api/office/invites",
    ]) {
      expect(isRestrictedAllowedPath(path), path).toBe(false);
    }
  });

  it("names exactly the four capabilities the office keeps", () => {
    expect([...OFFICE_RESTRICTED_CAPABILITIES]).toEqual([
      "office_access_billing",
      "patient_subscriptions",
      "payouts_and_connect",
      "patient_data_export",
    ]);
  });
});

describe("officeRestrictedForNonpayment", () => {
  beforeEach(() => {
    findAccessSubscription.mockReset();
  });

  it("is false for an office that was never billed", async () => {
    findAccessSubscription.mockResolvedValue(null);
    expect(await officeRestrictedForNonpayment("office-1", NOW)).toBe(false);
  });

  it("is false while the office is paid through", async () => {
    findAccessSubscription.mockResolvedValue(row());
    expect(await officeRestrictedForNonpayment("office-1", NOW)).toBe(false);
  });

  it("is false inside the recovery window", async () => {
    findAccessSubscription.mockResolvedValue(row({
      state: "past_due", paid_through: at(-3), current_period_end: at(-3),
      grace_started_at: at(-3), grace_ends_at: at(4),
    }));
    expect(await officeRestrictedForNonpayment("office-1", NOW)).toBe(false);
  });

  it("is true once the recovery window closes unpaid", async () => {
    findAccessSubscription.mockResolvedValue(row({
      state: "restricted", paid_through: at(-10), current_period_end: at(-10),
      grace_started_at: at(-10), grace_ends_at: at(-3), restricted_at: at(-3),
    }));
    expect(await officeRestrictedForNonpayment("office-1", NOW)).toBe(true);
  });

  it("lifts the moment a payment lands, with no HQ action", async () => {
    findAccessSubscription.mockResolvedValue(row({
      state: "restricted", paid_through: at(28), current_period_end: at(28),
      grace_started_at: at(-10), grace_ends_at: at(-3), restricted_at: at(-3),
    }));
    expect(await officeRestrictedForNonpayment("office-1", NOW)).toBe(false);
  });

  it("never narrows an office because the lookup failed", async () => {
    findAccessSubscription.mockImplementation(async () => { throw new Error("postgrest down"); });
    expect(await officeRestrictedForNonpayment("office-1", NOW)).toBe(false);
  });
});
