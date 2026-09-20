import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ selection: vi.fn(), offering: vi.fn() }));
vi.mock("./mode-state", () => ({ getBillingModeStatus: mocks.selection }));
vi.mock("./catalog", () => ({ officeOffering: mocks.offering }));
import { buildProductSuggestion } from "./product-suggestions";
import { currentBillingIdentity, runWithBillingIdentity } from "./stripe-environment";

describe("staff suggestion offering identity", () => {
  it("pins default offering validation to the selected deployment identity", async () => {
    mocks.selection.mockResolvedValue({ mode: "live", platformAccountId: "acct_live" });
    mocks.offering.mockImplementation(async () => {
      expect(currentBillingIdentity()).toEqual({ mode: "live", platformAccountId: "acct_live" });
      return [];
    });
    await expect(buildProductSuggestion("office", { mode: "individual", items: [{ productId: "missing", purchase: "one_time", quantity: 1 }] }))
      .rejects.toThrow("That product isn't on your office's price list.");
    expect(currentBillingIdentity()).toBeUndefined();
  });
  it("preserves an already pinned identity instead of rereading selection", async () => {
    mocks.selection.mockClear();
    mocks.offering.mockImplementation(async () => {
      expect(currentBillingIdentity()).toEqual({ mode: "test", platformAccountId: "acct_test" });
      return [];
    });
    await runWithBillingIdentity({ mode: "test", platformAccountId: "acct_test" }, () =>
      buildProductSuggestion("office", { mode: "individual", items: [] }));
    expect(mocks.selection).not.toHaveBeenCalled();
  });
  it("does not substitute another mode when configuration is unavailable", async () => {
    mocks.selection.mockRejectedValue(new Error("Payment mode unavailable"));
    mocks.offering.mockClear();
    await expect(buildProductSuggestion("office", { mode: "individual", items: [] })).rejects.toThrow("Payment mode unavailable");
    expect(mocks.offering).not.toHaveBeenCalled();
  });
});