import { beforeEach, expect, it, vi } from "vitest";
import { supabaseAdmin } from "../lib/supabase-admin";
import { GENERATORS, pageAll } from "./generators";
import { withExportBillingIdentity } from "./billing-identity";
import { runWithBillingIdentity } from "../billing/stripe-environment";
import type { ExportScope } from "./kinds";
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: vi.fn() }));
const db = vi.mocked(supabaseAdmin);
const scope: ExportScope = {
  providerId: "office", officeName: "Office", requesterKind: "hq", requesterRole: null,
  range: { start: "2026-01-01", end: "2026-01-31" }, patient: null,
  billingIdentity: { mode: "test", platformAccountId: "acct_frozen" },
};
beforeEach(() => db.mockReset().mockResolvedValue({ status: 200, json: [], contentRange: null }));
it("uses frozen job identity even after the current mode switches", async () => {
  await runWithBillingIdentity({mode:"live",platformAccountId:"acct_new"}, () => GENERATORS.billing_transactions(scope));
  const path = String(db.mock.calls[0][1]);
  expect(path).toContain("stripe_mode=eq.test&stripe_platform_account_id=eq.acct_frozen");
  expect(path).not.toContain("acct_new");
});
it("fails old financial jobs closed rather than guessing an identity", async () => {
  await expect(async () => GENERATORS.billing_payouts({...scope,billingIdentity:undefined})).rejects.toThrow("frozen billing identity");
  expect(db).not.toHaveBeenCalled();
});
it("scopes bundle-only financial tables, too", async () => {
  await withExportBillingIdentity(scope, () => pageAll("/rest/v1/billing_refunds?select=id"));
  expect(String(db.mock.calls[0][1])).toContain("stripe_mode=eq.test&stripe_platform_account_id=eq.acct_frozen");
});