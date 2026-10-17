/**
 * The owner's first dashboard sign-in starts the included period. The staff
 * sign-in routes carry no billing identity, and every office-access row is
 * Stripe-scoped, so the period must be started under the payments mode HQ
 * has selected — otherwise the store refuses the read and the period never
 * starts at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentBillingIdentity, runWithBillingIdentity, type BillingIdentity } from "../stripe-environment";

const mocks = vi.hoisted(() => ({
  selected: vi.fn(),
  seen: [] as Array<{ step: string; identity: unknown }>,
  started: null as string | null,
  signedIn: null as string | null,
  officeKind: "reseller" as string,
  agreement: null as string | null,
  starts: [] as Array<{ includedPeriodDays: number; officeKind: string; anchor?: string; event: string }>,
}));

vi.mock("../mode-state", () => ({ getBillingModeStatus: mocks.selected }));
vi.mock("./settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings")>()),
  loadAccessBillingSettings: async () => ({ includedPeriodDays: 365, softwareIncludedPeriodDays: 30 }),
}));
vi.mock("../../lib/supabase-admin", () => ({
  supabaseAdmin: async (_method: string, path: string) => ({
    status: 200,
    json: path.startsWith("/rest/v1/providers")
      ? [{ provider_id: "office-1", office_kind: mocks.officeKind, reseller_agreement_signed_on: mocks.agreement }]
      : [],
  }),
}));
vi.mock("./subscription", async () => {
  const environment = await import("../stripe-environment");
  return {
    ensureAccessSubscription: async (providerId: string) => {
      mocks.seen.push({ step: "ensure", identity: environment.currentBillingIdentity() });
      return { id: "sub-1", provider_id: providerId, included_period_started_at: mocks.started, owner_first_sign_in_at: mocks.signedIn };
    },
    applyAccessInput: async (input: { input: { kind: string; includedPeriodDays: number; anchor?: Date }; event: string; detail: { officeKind: string } }) => {
      mocks.seen.push({ step: input.input.kind, identity: environment.currentBillingIdentity() });
      mocks.starts.push({
        includedPeriodDays: input.input.includedPeriodDays, officeKind: input.detail.officeKind, event: input.event,
        ...(input.input.anchor ? { anchor: input.input.anchor.toISOString() } : {}),
      });
    },
  };
});

import { noteOwnerDashboardSignInForSelectedMode } from "./sign-in";

const LIVE: BillingIdentity = { mode: "live", platformAccountId: "acct_live_platform" };
const TEST: BillingIdentity = { mode: "test", platformAccountId: "acct_test_platform" };

beforeEach(() => {
  mocks.selected.mockReset();
  mocks.selected.mockResolvedValue({ ...LIVE, version: 3 });
  mocks.seen = [];
  mocks.starts = [];
  mocks.started = null;
  mocks.signedIn = null;
  mocks.officeKind = "reseller";
  mocks.agreement = null;
});

describe("starting the included period from a staff sign-in", () => {
  it("runs under the payments mode HQ has selected", async () => {
    expect(currentBillingIdentity()).toBeUndefined();
    await noteOwnerDashboardSignInForSelectedMode({ providerId: "office-1", staffClass: "provider", authUserId: "owner-1" });
    expect(mocks.selected).toHaveBeenCalledTimes(1);
    expect(mocks.seen).toEqual([
      { step: "ensure", identity: LIVE },
      { step: "owner_first_sign_in", identity: LIVE },
    ]);
    // The identity is scoped to the call; nothing leaks into the sign-in route.
    expect(currentBillingIdentity()).toBeUndefined();
  });

  it("keeps an identity the caller already holds instead of re-reading the selection", async () => {
    await runWithBillingIdentity(TEST, () =>
      noteOwnerDashboardSignInForSelectedMode({ providerId: "office-1", staffClass: "provider", authUserId: "owner-1" }));
    expect(mocks.selected).not.toHaveBeenCalled();
    expect(mocks.seen.map((entry) => entry.identity)).toEqual([TEST, TEST]);
  });

  it("gives a software-only office the software included period, a reseller the reseller one", async () => {
    await noteOwnerDashboardSignInForSelectedMode({ providerId: "office-1", staffClass: "provider", authUserId: "owner-1" });
    expect(mocks.starts).toEqual([{ includedPeriodDays: 365, officeKind: "reseller", event: "included_period_started" }]);
    mocks.starts = [];
    mocks.officeKind = "software";
    await noteOwnerDashboardSignInForSelectedMode({ providerId: "office-1", staffClass: "provider", authUserId: "owner-1" });
    expect(mocks.starts).toEqual([{ includedPeriodDays: 30, officeKind: "software", event: "included_period_started" }]);
  });

  it("anchors a reseller's period to its recorded agreement date, not to the sign-in", async () => {
    mocks.agreement = "2026-01-15";
    await noteOwnerDashboardSignInForSelectedMode({ providerId: "office-1", staffClass: "provider", authUserId: "owner-1" });
    expect(mocks.starts).toEqual([{ includedPeriodDays: 365, officeKind: "reseller", event: "included_period_started", anchor: "2026-01-15T00:00:00.000Z" }]);
    // A software-only office's clock is the sign-in even with a date on the row.
    mocks.starts = [];
    mocks.officeKind = "software";
    await noteOwnerDashboardSignInForSelectedMode({ providerId: "office-1", staffClass: "provider", authUserId: "owner-1" });
    expect(mocks.starts).toEqual([{ includedPeriodDays: 30, officeKind: "software", event: "included_period_started" }]);
  });

  it("does not restart a period that already started", async () => {
    mocks.started = "2026-01-10T08:00:00.000Z";
    mocks.signedIn = "2026-01-10T08:00:00.000Z";
    await noteOwnerDashboardSignInForSelectedMode({ providerId: "office-1", staffClass: "provider", authUserId: "owner-1" });
    expect(mocks.seen.map((entry) => entry.step)).toEqual(["ensure"]);
  });

  it("only records the sign-in when HQ anchored the period before the owner ever signed in", async () => {
    mocks.started = "2026-01-15T00:00:00.000Z";
    mocks.agreement = "2026-01-15";
    await noteOwnerDashboardSignInForSelectedMode({ providerId: "office-1", staffClass: "provider", authUserId: "owner-1" });
    expect(mocks.seen.map((entry) => entry.step)).toEqual(["ensure", "owner_first_sign_in"]);
    expect(mocks.starts[0].event).toBe("owner_first_sign_in");
  });

  it("never reads the payments mode for anyone but the office owner", async () => {
    await noteOwnerDashboardSignInForSelectedMode({ providerId: "office-1", staffClass: "team_member", authUserId: "staff-1" });
    await noteOwnerDashboardSignInForSelectedMode({ providerId: "office-1", staffClass: "hq", authUserId: "hq-1" });
    await noteOwnerDashboardSignInForSelectedMode({ providerId: "", staffClass: "provider", authUserId: "owner-1" });
    expect(mocks.selected).not.toHaveBeenCalled();
    expect(mocks.seen).toEqual([]);
  });

  it("writes nothing and reports the failure when the selected mode cannot be read", async () => {
    mocks.selected.mockRejectedValue(new Error("Payments mode is unavailable."));
    await expect(noteOwnerDashboardSignInForSelectedMode({ providerId: "office-1", staffClass: "provider", authUserId: "owner-1" }))
      .rejects.toThrow("Payments mode is unavailable.");
    expect(mocks.seen).toEqual([]);
  });
});
