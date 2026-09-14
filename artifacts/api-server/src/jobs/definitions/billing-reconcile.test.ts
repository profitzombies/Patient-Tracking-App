import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../types";

const mocks = vi.hoisted(() => ({
  selectMany: vi.fn(),
  selectOne: vi.fn(),
  update: vi.fn(),
  getStripe: vi.fn(),
  register: vi.fn(),
}));
vi.mock("../../billing/store", () => ({
  selectMany: mocks.selectMany, selectOne: mocks.selectOne, update: mocks.update,
}));
vi.mock("../../billing/stripe-client", () => ({
  getStripe: mocks.getStripe, connectedOpts: (id: string) => ({ stripeAccount: id }),
}));
vi.mock("../../billing/webhook-handlers", () => ({ registerBillingWebhookHandlers: mocks.register }));
vi.mock("../../billing/orders", () => ({ markOrderPaidFromInvoice: vi.fn() }));
vi.mock("../../billing/payouts", () => ({ mirrorPayout: vi.fn() }));
vi.mock("../../billing/webhook-processing", () => ({ processStripeEvent: vi.fn() }));
vi.mock("../../billing/webhooks", () => ({ dispatchStripeEvent: vi.fn() }));

import { billingReconcileJob, reconcileBilling } from "./billing-reconcile";

function context(dryRun: boolean): JobContext & { counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  return {
    dryRun, now: new Date("2026-10-13T12:00:00Z"), counts, leaseLost: false,
    tally(key, by = 1) { counts[key] = (counts[key] ?? 0) + by; },
    checkpoint: vi.fn(), failItem: vi.fn(), log: vi.fn(),
  };
}

describe("billing reconciliation job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStripe.mockResolvedValue({});
    mocks.selectMany.mockResolvedValue([]);
  });

  it("uses the scheduled lease and interval", () => {
    expect(billingReconcileJob).toMatchObject({ name: "billing-reconcile", intervalMs: 1_800_000, leaseSeconds: 1_200 });
  });

  it("keeps dry runs side-effect free and reports pending due rows", async () => {
    mocks.selectMany.mockResolvedValueOnce([
      { id: "one", status: "pending", created_at: "2026-10-13T10:00:00Z" },
      { id: "two", status: "pending", created_at: "2026-10-13T10:01:00Z" },
    ]);
    const ctx = context(true);
    await reconcileBilling(ctx);
    expect(ctx.counts).toEqual({ pendingDue: 2 });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.selectOne).not.toHaveBeenCalled();
    expect(ctx.checkpoint).toHaveBeenCalled();
  });

  it("stops immediately when a batch checkpoint loses its lease", async () => {
    const ctx = context(false);
    (ctx.checkpoint as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error("lease lost"); });
    await expect(reconcileBilling(ctx)).rejects.toThrow("lease lost");
    expect(mocks.selectMany).not.toHaveBeenCalled();
  });

  it("compare-and-sets stale pending cancellation", async () => {
    mocks.getStripe.mockResolvedValue({
      invoices: { retrieve: vi.fn().mockResolvedValue({ status: "void" }) },
    });
    mocks.selectMany
      .mockResolvedValueOnce([{
        id: "order-1", provider_id: "office-1", status: "pending",
        stripe_invoice_id: "in_void", created_at: "2026-10-13T10:00:00Z",
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    mocks.selectOne.mockResolvedValue({ stripe_account_id: "acct_1" });
    await reconcileBilling(context(false));
    expect(mocks.update).toHaveBeenCalledWith(
      "billing_orders", "id=eq.order-1&status=eq.pending",
      expect.objectContaining({ status: "canceled" }),
    );
  });
});