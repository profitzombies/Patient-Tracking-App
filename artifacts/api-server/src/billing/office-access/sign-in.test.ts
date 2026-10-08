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
}));

vi.mock("../mode-state", () => ({ getBillingModeStatus: mocks.selected }));
vi.mock("./settings", () => ({ loadAccessBillingSettings: async () => ({ includedPeriodDays: 365 }) }));
vi.mock("./subscription", async () => {
  const environment = await import("../stripe-environment");
  return {
    ensureAccessSubscription: async (providerId: string) => {
      mocks.seen.push({ step: "ensure", identity: environment.currentBillingIdentity() });
      return { id: "sub-1", provider_id: providerId, included_period_started_at: mocks.started };
    },
    applyAccessInput: async (input: { input: { kind: string } }) => {
      mocks.seen.push({ step: input.input.kind, identity: environment.currentBillingIdentity() });
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
  mocks.started = null;
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

  it("does not restart a period that already started", async () => {
    mocks.started = "2026-01-10T08:00:00.000Z";
    await noteOwnerDashboardSignInForSelectedMode({ providerId: "office-1", staffClass: "provider", authUserId: "owner-1" });
    expect(mocks.seen.map((entry) => entry.step)).toEqual(["ensure"]);
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
