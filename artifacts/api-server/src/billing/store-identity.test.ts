import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabaseAdmin } from "../lib/supabase-admin";
import { runWithBillingIdentity } from "./stripe-environment";
import { insert, selectMany, update, upsert } from "./store";

vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: vi.fn() }));
const db = vi.mocked(supabaseAdmin);
const testIdentity = { mode: "test" as const, platformAccountId: "acct_test_scope" };
beforeEach(() => db.mockReset().mockResolvedValue({ status: 200, json: [], contentRange: null }));
describe("billing persistence identity", () => {
  it("refuses transactional operations without a pinned identity", async () => {
    await expect(selectMany("billing_orders")).rejects.toThrow("Billing identity is required");
    expect(db).not.toHaveBeenCalled();
  });
  it("keeps catalog shared", async () => {
    await selectMany("billing_products");
    expect(db.mock.calls[0][1]).toBe("/rest/v1/billing_products");
  });
  it("scopes queries and updates to both mode and platform account", async () => {
    await runWithBillingIdentity(testIdentity, async () => {
      await selectMany("billing_orders", "status=eq.paid");
      await update("billing_orders", "id=eq.order", { status: "paid" });
    });
    for (const call of db.mock.calls) {
      expect(call[1]).toContain("stripe_mode=eq.test&stripe_platform_account_id=eq.acct_test_scope");
    }
  });
  it("writes the pinned identity, never a caller-supplied identity", async () => {
    await runWithBillingIdentity(testIdentity, () => insert("billing_orders", {
      stripe_mode: "live", stripe_platform_account_id: "acct_other",
    }));
    expect(db.mock.calls[0][2]).toMatchObject({ stripe_mode: "test", stripe_platform_account_id: "acct_test_scope" });
  });
  it("scopes natural conflict keys", async () => {
    await runWithBillingIdentity(testIdentity, () => upsert("billing_connected_accounts", { provider_id: "office" }, "provider_id"));
    expect(db.mock.calls[0][1]).toContain("on_conflict=provider_id%2Cstripe_mode%2Cstripe_platform_account_id");
  });
  it("isolates simultaneous async identities", async () => {
    await Promise.all(["test", "live"].map(mode => runWithBillingIdentity(
      { mode: mode as "test" | "live", platformAccountId: `acct_${mode}` },
      async () => { await Promise.resolve(); await selectMany("billing_orders"); },
    )));
    expect(db.mock.calls.map(call => call[1])).toEqual(expect.arrayContaining([
      "/rest/v1/billing_orders?stripe_mode=eq.test&stripe_platform_account_id=eq.acct_test",
      "/rest/v1/billing_orders?stripe_mode=eq.live&stripe_platform_account_id=eq.acct_live",
    ]));
  });
});