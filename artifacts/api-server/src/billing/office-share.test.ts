/**
 * THINNR's share of a patient payment while an office is narrowed for
 * nonpayment.
 *
 * The rule the money depends on: the share is read at charge time, so a
 * restriction (or a recovery) only ever moves the NEXT charge — including the
 * next renewal of a subscription that already exists — and never a charge that
 * has already been processed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const officeRestrictedForNonpayment = vi.fn();
const loadAccessBillingSettings = vi.fn();

vi.mock("../lib/office-restriction", () => ({
  officeRestrictedForNonpayment: (...args: unknown[]) => officeRestrictedForNonpayment(...args),
}));
vi.mock("./office-access/settings", () => ({
  loadAccessBillingSettings: (...args: unknown[]) => loadAccessBillingSettings(...args),
  revenueSharePercent: (settings: { normalSharePercent: number; restrictedSharePercent: number }, restricted: boolean) =>
    restricted ? settings.restrictedSharePercent : settings.normalSharePercent,
}));

const { NORMAL_THINNR_SHARE_PERCENT, officeThinnrSharePercent, rescaleShare } = await import("./office-share");

describe("officeThinnrSharePercent", () => {
  beforeEach(() => {
    officeRestrictedForNonpayment.mockReset();
    loadAccessBillingSettings.mockReset();
    loadAccessBillingSettings.mockResolvedValue({ normalSharePercent: 60, restrictedSharePercent: 80 });
  });

  it("is the catalog share for an office in good standing", async () => {
    officeRestrictedForNonpayment.mockResolvedValue(false);
    expect(await officeThinnrSharePercent("office-1")).toBe(NORMAL_THINNR_SHARE_PERCENT);
    expect(NORMAL_THINNR_SHARE_PERCENT).toBe(60);
    expect(loadAccessBillingSettings).not.toHaveBeenCalled();
  });

  it("rises to the restricted share while the office is narrowed", async () => {
    officeRestrictedForNonpayment.mockResolvedValue(true);
    expect(await officeThinnrSharePercent("office-1")).toBe(80);
  });

  it("returns to the normal share as soon as the office pays", async () => {
    officeRestrictedForNonpayment.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await officeThinnrSharePercent("office-1")).toBe(80);
    expect(await officeThinnrSharePercent("office-1")).toBe(60);
  });

  it("falls back to the normal share when the state cannot be read", async () => {
    officeRestrictedForNonpayment.mockRejectedValue(new Error("unavailable"));
    expect(await officeThinnrSharePercent("office-1")).toBe(60);
  });

  it("asks about the office being charged, at the charge instant", async () => {
    officeRestrictedForNonpayment.mockResolvedValue(false);
    const now = new Date("2026-04-02T00:00:00.000Z");
    await officeThinnrSharePercent("office-9", now);
    expect(officeRestrictedForNonpayment).toHaveBeenCalledWith("office-9", now);
  });
});

describe("rescaleShare", () => {
  it("leaves a normal-share snapshot bit-for-bit unchanged", () => {
    for (const share of [0, 1, 999, 12_345]) {
      expect(rescaleShare(share, NORMAL_THINNR_SHARE_PERCENT)).toBe(share);
    }
  });

  it("lifts a 60%-of-floor share to 80% of the same floor", () => {
    // 60% of a $100.00 floor is $60.00; 80% of it is $80.00.
    expect(rescaleShare(6_000, 80)).toBe(8_000);
  });

  it("never rounds a cent up against the office", () => {
    expect(rescaleShare(601, 80)).toBe(801); // 601 * 80 / 60 = 801.33…
  });
});
