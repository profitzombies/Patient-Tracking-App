import { beforeEach, describe, expect, it, vi } from "vitest";

const admin = vi.hoisted(() => vi.fn());
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: admin }));
vi.mock("../routes/operational-rollups", () => ({ loadOfficeRollups: vi.fn() }));
import { GENERATORS } from "./generators";
import type { ExportScope } from "./kinds";

const scope: ExportScope = {
  billingIdentity: { mode: "test", platformAccountId: "acct_fixture" },
  providerId: "office-1", officeName: "Harbor", requesterKind: "provider", requesterRole: null,
  range: { start: "2026-10-01", end: "2026-10-31" }, patient: null,
};
const response = (json: unknown) => ({ status: 200, json, contentRange: null });

beforeEach(() => {
  admin.mockReset().mockImplementation(async (_method: string, path: string) => {
    if (path.startsWith("/rest/v1/billing_orders?")) return response([{
      id: "o1", order_number: "TH-1", created_at: "2026-10-02T10:00:00Z", provider_id: "office-1",
      patient_id: "patient-1", kind: "one_time", status: "paid", subtotal_cents: 10000,
      shipping_charge_cents: 1000, tax_cents: 825, total_cents: 11825,
      application_fee_collected_cents: 2500, stripe_fee_cents: 373, office_net_cents: 8952,
      stripe_invoice_id: "in_1", stripe_payment_intent_id: "pi_1", stripe_charge_id: "ch_1",
      stripe_balance_transaction_id: "txn_1", billing_payers: { name: "Pat One" },
      billing_order_items: [{ product_name_snapshot: "Program", quantity: 1 }],
      billing_refunds: [{ amount_cents: 500 }], providers: { office_name: "Harbor" },
    }]);
    if (path.startsWith("/rest/v1/billing_connected_accounts?")) return response([{
      provider_id: "office-1", stripe_account_id: "acct_1",
    }]);
    if (path.startsWith("/rest/v1/billing_subscriptions?")) return response([{
      id: "s1", created_at: "2026-10-03T10:00:00Z", provider_id: "office-1", status: "active",
      unit_price_cents: 10000, current_period_end: "2026-11-03T10:00:00Z", payment_failure_count: 0,
      paused_at: null, pending_product_id: "product-2", pending_unit_price_cents: 12500,
      pending_effective_at: "2026-11-03T10:00:00Z", pending_product: { name: "Program Plus" },
      billing_payers: { name: "Pat One" },
      billing_products: { name: "Program" }, providers: { office_name: "Harbor" },
    }]);
    if (path.startsWith("/rest/v1/billing_payouts?")) return response([{
      id: "p1", provider_id: "office-1", stripe_payout_id: "po_1", amount_cents: 8952,
      status: "paid", arrival_date: "2026-10-05", method: "standard",
      created_at: "2026-10-04T10:00:00Z", providers: { office_name: "Harbor" },
    }]);
    throw new Error(`unexpected ${path}`);
  });
});

describe("billing CSV generators", () => {
  it("emits the documented transaction columns and dollar values", async () => {
    const sheet = await GENERATORS.billing_transactions(scope);
    expect(sheet.header).toHaveLength(20);
    expect(sheet.rows[0]).toHaveLength(sheet.header.length);
    expect(sheet.rows[0].slice(7, 15)).toEqual(["100.00", "10.00", "8.25", "118.25", "25.00", "3.73", "89.52", "5.00"]);
  });

  it("emits subscription and payout fixture rows matching their headers", async () => {
    const subscriptions = await GENERATORS.billing_subscriptions(scope);
    const payouts = await GENERATORS.billing_payouts(scope);
    expect(subscriptions.rows[0]).toHaveLength(subscriptions.header.length);
    expect(subscriptions.rows[0][4]).toBe("100.00");
    expect(subscriptions.rows[0][8]).toBe("Program Plus ($125.00) from 2026-11-03");
    expect(payouts.rows[0]).toHaveLength(payouts.header.length);
    expect(payouts.rows[0][3]).toBe("89.52");
  });
});