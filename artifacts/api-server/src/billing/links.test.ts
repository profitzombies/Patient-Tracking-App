import { beforeEach, describe, expect, it, vi } from "vitest";

const admin = vi.hoisted(() => vi.fn());
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: admin }));
import { BillingLinkError, resolveActiveLink, touchLinkUse, withClaimedLinkUse } from "./links";

const link = {
  id: "11111111-1111-4111-8111-111111111111", token: "token", provider_id: "office-1",
  patient_id: null, created_by: "owner-1", label: null, active: true, expires_at: null,
  uses: 0, last_used_at: null, product_id: null, max_uses: 1, created_at: "2026-10-01T00:00:00Z",
};
const response = (json: unknown) => ({ status: 200, json, contentRange: null });

beforeEach(() => admin.mockReset());

describe("payment link availability and claims", () => {
  it.each([
    { active: false },
    { expires_at: "2020-01-01T00:00:00Z" },
    { uses: 1, max_uses: 1 },
  ])("rejects an inactive, expired, or exhausted public link", async (patch) => {
    admin.mockResolvedValue(response([{ ...link, ...patch }]));
    await expect(resolveActiveLink("token")).rejects.toMatchObject({
      status: 404, message: "This payment link is no longer active.",
    });
  });

  it("allows only one concurrent single-use claim and suppresses the legacy post-Stripe touch", async () => {
    let available = true;
    admin.mockImplementation(async (...args: unknown[]) => {
      if (!args.length) return response(null);
      const path = String(args[1] ?? "");
      if (path.endsWith("billing_claim_payment_link_use")) {
        if (!available) return response(false);
        available = false;
        return response(true);
      }
      throw new Error(`unexpected ${path}`);
    });
    const checkout = () => withClaimedLinkUse(link.id, async () => {
      await touchLinkUse(link.id);
      return "created";
    });
    const results = await Promise.allSettled([checkout(), checkout()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BillingLinkError);
    expect(rejected.reason).toMatchObject({ status: 409, message: "This payment link has already been used." });
    expect(admin.mock.calls.filter((args) => String(args[1]).includes("billing_claim_payment_link_use"))).toHaveLength(2);
  });
});