import { describe, expect, it } from "vitest";
import {
  applicationFeePercentFor, belowMinimum, breakEvenMinimum, computeOrderFees,
  estimateStripeFee, hqProfit, thinnrSharePerUnit,
} from "./fees";

const settings = {
  shipping_charge_cents: 1000,
  shipping_cost_cents: 1000,
  card_fee_bps: 290,
  card_fee_fixed_cents: 30,
};

describe("billing fee math", () => {
  it.each([
    ["Control / Regulate / Detox", 5999, 3599, 3767],
    ["Fiber", 2999, 1799, 1913],
    ["Creatine+ / B-Active", 8999, 5399, 5621],
    ["Maintenance Stack (both)", 9999, 5999, 6239],
    ["Boost", 11999, 7199, 7475],
    ["Maintenance + Detox Stack", 14999, 8999, 9329],
  ])("%s reproduces the contract table", (_name, floor, share, minimum) => {
    expect(thinnrSharePerUnit(floor)).toBe(share);
    expect(breakEvenMinimum(floor, settings)).toBe(minimum);
  });

  it("truncates one-cent shares and handles no shipping", () => {
    expect(thinnrSharePerUnit(1)).toBe(0);
    expect(breakEvenMinimum(1, { ...settings, shipping_charge_cents: 0 })).toBe(31);
  });

  it("computes quantities and multiple product lines", () => {
    expect(computeOrderFees([
      { floor_price_cents: 5999, quantity: 3 },
      { floor_price_cents: 2999, quantity: 2 },
    ], settings)).toEqual({
      thinnr_share_cents: 14395,
      shipping_charge_cents: 1000,
      application_fee_cents: 15395,
    });
  });

  it("estimates Stripe fees and HQ profit in cents", () => {
    expect(estimateStripeFee(6999, settings)).toBe(233);
    expect(hqProfit(4599, 433, 1000)).toBe(3166);
  });

  it("rounds subscription percentages upward without exceeding 100", () => {
    const percent = applicationFeePercentFor(4599, 6999);
    expect(percent).toBe(65.71);
    expect(Math.ceil(6999 * percent / 100)).toBeGreaterThanOrEqual(4599);
    expect(applicationFeePercentFor(200, 100)).toBe(100);
  });

  it("flags only offered prices below the current minimum", () => {
    expect(belowMinimum(3766, 5999, settings)).toBe(true);
    expect(belowMinimum(3767, 5999, settings)).toBe(false);
    expect(belowMinimum(null, 5999, settings)).toBe(false);
  });
});