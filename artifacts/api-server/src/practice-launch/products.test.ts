import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ prices: [] as Record<string, unknown>[], rpc: vi.fn() }));
vi.mock("../billing/store", () => ({
  selectMany: async (table: string) => table === "billing_products"
    ? [{ id:"control", name:"Control", floor_price_cents:5999, active:true }] : state.prices,
}));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: state.rpc }));
vi.mock("../billing/catalog", () => ({
  getSettings: async () => ({ shipping_charge_cents:1000, shipping_cost_cents:1000,
    card_fee_bps:290,card_fee_fixed_cents:30,subscribe_save_enabled:true,subscribe_save_percent:10 }),
  subscribeSavePercent: () => 10,
  subscriptionUnitPrice: (price: number, percent: number) => price - Math.round(price * percent / 100),
}));
vi.mock("../billing/stripe-environment", () => ({
  currentBillingIdentity: () => ({ mode:"test",platformAccountId:"acct_platform" }),
}));
import { getLaunchProducts, saveLaunchProducts, suggestedPriceCents } from "./products";
beforeEach(() => { state.prices = []; state.rpc.mockReset().mockResolvedValue({status:200,json:{version:1}}); });
describe("practice setup product defaults", () => {
  it("defaults every product to its Retail MSRP, not a multiple of the THINNR fee", async () => {
    expect(suggestedPriceCents(5999)).toBe(5999);
    expect((await getLaunchProducts("office"))[0]).toMatchObject({
      enabled:true,sellPriceCents:5999,suggestedPriceCents:5999,existingPrice:false,subscriptionEnabled:true,
    });
  });
  it("prefills existing custom prices and disabled state without performing a write", async () => {
    state.prices = [{product_id:"control",sell_price_cents:9999,subscription_enabled:false,enabled:false}];
    expect((await getLaunchProducts("office"))[0]).toMatchObject({
      enabled:false,sellPriceCents:9999,existingPrice:true,subscriptionEnabled:false,
    });
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("rejects fractional cents before any mutation and surfaces stale versions", async () => {
    const product = {productId:"control",enabled:true,sellPriceCents:5999,subscriptionEnabled:true};
    await expect(saveLaunchProducts("office","owner",0,[{...product,sellPriceCents:1.5}])).rejects.toThrow();
    expect(state.rpc).not.toHaveBeenCalled();
    state.rpc.mockResolvedValue({status:400,json:{code:"40001",message:"Refresh"}});
    await expect(saveLaunchProducts("office","owner",0,[product])).rejects.toMatchObject({status:409});
  });
});