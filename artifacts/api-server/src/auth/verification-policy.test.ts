import { describe, expect, it } from "vitest";
import { normalizeRoutePath, remoteVerificationFamily, verificationModeFor } from "./verification-policy";

describe("verification policy", () => {
  it("verifies ordinary patient and staff traffic locally", () => {
    for (const [method, url] of [
      ["GET", "/api/patient-data/diary?day=2026-09-18"],
      ["POST", "/api/patient-data/diary/entries"],
      ["GET", "/api/office/roster"],
      ["PATCH", "/api/office/patients/p1"],
      ["GET", "/api/office/team"],
      ["GET", "/api/hq/accounts"],
      ["POST", "/api/coach/chat"],
      ["GET", "/api/billing/office/orders"],
      ["GET", "/api/patient-data/billing/subscriptions"],
      ["GET", "/api/exports/kinds"],
    ] as const) {
      expect(verificationModeFor({ method, originalUrl: url }), `${method} ${url}`).toBe("local");
    }
  });

  it("confirms money movements, privacy/deletion, and security settings with Supabase Auth", () => {
    const remote: Array<[string, string, string]> = [
      ["POST", "/api/billing/office/sales", "billing writes"],
      ["DELETE", "/api/billing/office/subscriptions/s1", "billing writes"],
      ["POST", "/api/patient-data/billing/checkout", "billing writes"],
      ["GET", "/api/patient-data/privacy", "privacy and deletion"],
      ["POST", "/api/patient-data/consent", "privacy and deletion"],
      ["POST", "/api/patient-data/export", "privacy and deletion"],
      ["POST", "/api/patient-data/deletion", "privacy and deletion"],
      ["GET", "/api/hq/patient-deletions", "privacy and deletion"],
      ["GET", "/api/security/me/sessions", "security settings"],
      ["POST", "/api/security/me/sign-out-others", "security settings"],
      ["GET", "/api/office/team/m1/sessions", "security settings"],
      ["POST", "/api/office/patients/p1/sign-out", "security settings"],
      ["POST", "/api/hq-team/h1/sign-out", "security settings"],
    ];
    for (const [method, url, family] of remote) {
      expect(remoteVerificationFamily({ method, originalUrl: url }), `${method} ${url}`).toBe(family);
    }
  });

  it("matches the same routes with or without the /api mount and ignores query strings", () => {
    expect(normalizeRoutePath("/api/security/me?x=1")).toBe("/security/me");
    expect(normalizeRoutePath("/security/me/")).toBe("/security/me");
    expect(verificationModeFor({ method: "GET", originalUrl: "/security/me" })).toBe("remote");
    expect(verificationModeFor({ method: "GET", url: "/security/me" })).toBe("remote");
    expect(verificationModeFor(undefined)).toBe("local");
    expect(verificationModeFor({ method: "GET", originalUrl: "/api/securityish" })).toBe("local");
  });
});
