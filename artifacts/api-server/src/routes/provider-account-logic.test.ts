import { describe, expect, it } from "vitest";
import {
  effectiveProviderCode,
  isActivePatientStatus,
  supportProviderAccountDto,
} from "./provider-accounts";
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

  it("limits the Support provider DTO to contact and status fields", () => {
    const dto = supportProviderAccountDto({
      id: "provider-1",
      providerId: "provider-1",
      officeName: "Example Office",
      providerName: "Dr Example",
      providerRole: "Practitioner",
      status: "active",
      email: "provider@example.com",
      phone: "555-0100",
      city: "Austin",
      state: "TX",
      joinedKey: "2026-08-01",
      providerCode: "123456",
      plan: "Concierge",
      pricing: { monthly: 1200 },
      location: { latitude: 1, longitude: 2 },
      activePatientCount: 24,
      lock: { lockedAt: "2026-08-02T00:00:00Z" },
      greetingName: "Example",
      newEnrollments: 3,
      recurringRevenue: 1200,
      enrollmentRevenue: 300,
      activeSubscriptions: 12,
      deliveriesInWindow: 9,
      engagementRate: 0.8,
      avgPoundsLost: 10,
      goalCompletion: 0.7,
      retention: 0.9,
    });

    expect(dto).toEqual({
      id: "provider-1",
      providerId: "provider-1",
      officeName: "Example Office",
      providerName: "Dr Example",
      providerRole: "Practitioner",
      status: "active",
      email: "provider@example.com",
      phone: "555-0100",
      city: "Austin",
      state: "TX",
      joinedKey: "2026-08-01",
    });
    expect(dto).not.toHaveProperty("providerCode");
    expect(dto).not.toHaveProperty("plan");
    expect(dto).not.toHaveProperty("pricing");
    expect(dto).not.toHaveProperty("location");
    expect(dto).not.toHaveProperty("activePatientCount");
    expect(dto).not.toHaveProperty("lock");
    expect(dto).not.toHaveProperty("greetingName");
    expect(dto).not.toHaveProperty("newEnrollments");
    expect(dto).not.toHaveProperty("recurringRevenue");
    expect(dto).not.toHaveProperty("enrollmentRevenue");
    expect(dto).not.toHaveProperty("activeSubscriptions");
    expect(dto).not.toHaveProperty("deliveriesInWindow");
    expect(dto).not.toHaveProperty("engagementRate");
    expect(dto).not.toHaveProperty("avgPoundsLost");
    expect(dto).not.toHaveProperty("goalCompletion");
    expect(dto).not.toHaveProperty("retention");
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