/**
 * What THINNR pre-fills into a new office's connected account. Stripe's
 * onboarding opens with these filled in; the office's own choice of business
 * type is never made for it (no company/individual block).
 */
import { describe, expect, it } from "vitest";
import { MED_SPA_MCC, inAppAccountPrefill } from "./accounts";

const office = {
  provider_id: "office-1", provider_name: "Dr. Ada Lane", office_name: "Lane Aesthetics", email: "owner@lane.test",
  phone: "(813) 555-0100", address_line_1: "1 Main St", address_line_2: null, city: "Tampa", state: "FL", postal_code: "33602",
};

describe("connected account pre-fill", () => {
  it("fills every business-profile field THINNR knows", () => {
    const prefill = inAppAccountPrefill(office);
    expect(prefill).toEqual({
      country: "US", email: "owner@lane.test", default_currency: "usd",
      business_profile: {
        name: "Lane Aesthetics", mcc: MED_SPA_MCC,
        product_description: expect.stringContaining("Lane Aesthetics"),
        support_email: "owner@lane.test", support_phone: "(813) 555-0100",
        support_address: { line1: "1 Main St", line2: undefined, city: "Tampa", state: "FL", postal_code: "33602", country: "US" },
      },
    });
    expect(MED_SPA_MCC).toBe("7298");
  });

  it("never chooses the business type for the office", () => {
    const prefill = inAppAccountPrefill(office) as Record<string, unknown>;
    expect(prefill).not.toHaveProperty("company");
    expect(prefill).not.toHaveProperty("individual");
    expect(prefill).not.toHaveProperty("business_type");
  });

  it("leaves out an incomplete address and falls back to the owner's name", () => {
    const prefill = inAppAccountPrefill({ ...office, office_name: null, city: null, phone: null });
    expect(prefill.business_profile!.name).toBe("Dr. Ada Lane");
    expect(prefill.business_profile!.support_address).toBeUndefined();
    expect(prefill.business_profile!.support_phone).toBeUndefined();
  });
});
