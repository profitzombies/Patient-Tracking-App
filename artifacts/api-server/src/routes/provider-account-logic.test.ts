import { describe, expect, it } from "vitest";
import { isActivePatientStatus } from "./provider-accounts";
import { providerAcceptsNewStaff } from "./staff-logins";

describe("live provider account invariants", () => {
  it("counts both migrated and claim-fixture active patient spellings", () => {
    expect(isActivePatientStatus("activated")).toBe(true);
    expect(isActivePatientStatus("active")).toBe(true);
    expect(isActivePatientStatus("unactivated")).toBe(false);
    expect(isActivePatientStatus("disabled")).toBe(false);
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