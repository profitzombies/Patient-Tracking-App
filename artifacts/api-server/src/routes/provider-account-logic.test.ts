import { describe, expect, it } from "vitest";
import { effectiveProviderCode, isActivePatientStatus } from "./provider-accounts";
import { providerAcceptsNewStaff } from "./staff-logins";

describe("live provider account invariants", () => {
  it("counts both migrated and claim-fixture active patient spellings", () => {
    expect(isActivePatientStatus("activated")).toBe(true);
    expect(isActivePatientStatus("active")).toBe(true);
    expect(isActivePatientStatus("unactivated")).toBe(false);
    expect(isActivePatientStatus("disabled")).toBe(false);
  });

  it("shows a valid six-digit onboarding code in preference to the legacy id", () => {
    expect(effectiveProviderCode("654321", "12345")).toBe("654321");
  });

  it("falls back to a valid five-digit legacy provider id", () => {
    expect(effectiveProviderCode(null, "12345")).toBe("12345");
  });

  it("never exposes invalid codes or internal live ids", () => {
    expect(effectiveProviderCode("12345", "live-1234567890abcdef")).toBeNull();
    expect(effectiveProviderCode("not-a-code", "123456")).toBeNull();
    expect(effectiveProviderCode(null, "live-12345")).toBeNull();
  });

  it("allows staff provisioning only for one existing unlocked provider", () => {
    expect(providerAcceptsNewStaff([{ provider_id: "p1", access_disabled: false }])).toBe(true);
    expect(providerAcceptsNewStaff([{ provider_id: "p1", access_disabled: null }])).toBe(true);
    expect(providerAcceptsNewStaff([])).toBe(false);
    expect(providerAcceptsNewStaff([{ provider_id: "p1", access_disabled: true }])).toBe(false);
    expect(providerAcceptsNewStaff([{ provider_id: "p1", access_disabled: false }], [{ account_id: "p1" }])).toBe(false);
    expect(providerAcceptsNewStaff([{ provider_id: "p1" }, { provider_id: "p1" }])).toBe(false);
  });
});