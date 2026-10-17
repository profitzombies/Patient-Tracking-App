/**
 * Re-anchoring an office's included period to its reseller agreement date.
 *
 * HQ records the date on the account; the included period then runs from
 * that day for the organization's reseller period, whatever the owner's first
 * sign-in. Clearing the date falls back to the real first sign-in when it is
 * known, else leaves the clock for the next sign-in to start. Software-only
 * offices and lifetime offices are left alone, and the work runs under the
 * payments mode HQ selected because the account routes carry no identity.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentBillingIdentity, type BillingIdentity } from "../stripe-environment";

const mocks = vi.hoisted(() => ({
  selected: vi.fn(),
  row: {} as Record<string, unknown>,
  applied: [] as Array<{ input: Record<string, unknown>; event: string; detail: Record<string, unknown>; identity: unknown }>,
  outcomes: [] as Array<{ row: Record<string, unknown>; changed: boolean }>,
  reads: 0,
  admin: vi.fn(),
}));

vi.mock("../mode-state", () => ({ getBillingModeStatus: mocks.selected }));
vi.mock("./settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings")>()),
  loadAccessBillingSettings: async () => ({ includedPeriodDays: 365, softwareIncludedPeriodDays: 30 }),
}));
vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("./subscription", async () => {
  const environment = await import("../stripe-environment");
  return {
    ensureAccessSubscription: async () => { mocks.reads += 1; return mocks.row; },
    applyAccessInput: async (call: { input: Record<string, unknown>; event: string; detail: Record<string, unknown> }) => {
      mocks.applied.push({ input: call.input, event: call.event, detail: call.detail, identity: environment.currentBillingIdentity() });
      const outcome = mocks.outcomes.shift();
      if (outcome) return outcome;
      return { row: { ...mocks.row, applied: true }, changed: true };
    },
  };
});

import { AgreementAnchorConflictError, agreementAnchorRecordedForSelectedMode, agreementIncludedPeriod, anchorIncludedPeriodToAgreement, anchorIncludedPeriodToAgreementForSelectedMode } from "./agreement";

const LIVE: BillingIdentity = { mode: "live", platformAccountId: "acct_live_platform" };
const NOW = new Date("2026-03-01T12:00:00.000Z");
const actor = { kind: "hq" as const, userId: "hq-1" };

beforeEach(() => {
  mocks.selected.mockReset();
  mocks.selected.mockResolvedValue({ ...LIVE, version: 3 });
  mocks.applied = [];
  mocks.outcomes = [];
  mocks.reads = 0;
  mocks.row = {
    id: "sub-1", provider_id: "office-1", state: "included_period", lifetime: false, version: 2,
    included_period_started_at: "2026-02-20T09:00:00.000Z", included_period_ends_at: "2027-02-20T09:00:00.000Z",
    owner_first_sign_in_at: "2026-02-20T09:00:00.000Z",
  };
});

describe("anchoring the included period to the reseller agreement", () => {
  it("moves the period to the agreement date plus the organization's reseller period", async () => {
    await anchorIncludedPeriodToAgreement({ providerId: "office-1", actor, now: NOW, facts: { officeKind: "reseller", resellerAgreementSignedOn: "2026-01-15" } });
    expect(mocks.applied).toHaveLength(1);
    const [call] = mocks.applied;
    expect(call.event).toBe("agreement_anchored");
    expect(call.input).toMatchObject({ kind: "agreement_anchor", at: NOW });
    const period = call.input.period as { startedAt: Date; endsAt: Date };
    expect(period.startedAt.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2027-01-15T00:00:00.000Z");
    expect(call.detail).toMatchObject({ anchor: "agreement", includedPeriodDays: 365, resellerAgreementSignedOn: "2026-01-15" });
  });

  it("falls back to the owner's real first sign-in when the date is cleared, and clears the period when there was none", async () => {
    await anchorIncludedPeriodToAgreement({ providerId: "office-1", actor, now: NOW, facts: { officeKind: "reseller", resellerAgreementSignedOn: null } });
    const period = mocks.applied[0].input.period as { startedAt: Date; endsAt: Date };
    expect(period.startedAt.toISOString()).toBe("2026-02-20T09:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2027-02-20T09:00:00.000Z");
    expect(mocks.applied[0].detail.anchor).toBe("owner_first_sign_in");

    mocks.applied = [];
    mocks.row = { ...mocks.row, owner_first_sign_in_at: null };
    await anchorIncludedPeriodToAgreement({ providerId: "office-1", actor, now: NOW, facts: { officeKind: "reseller", resellerAgreementSignedOn: null } });
    expect(mocks.applied[0].input.period).toBeNull();
    expect(mocks.applied[0].detail.anchor).toBeNull();
  });

  it("leaves a software-only office alone whatever date is on its row", async () => {
    const row = await anchorIncludedPeriodToAgreement({ providerId: "office-1", actor, now: NOW, facts: { officeKind: "software", resellerAgreementSignedOn: "2026-01-15" } });
    expect(mocks.applied).toEqual([]);
    expect(row).toBe(mocks.row);
  });

  it("re-reads and tries again when the period write loses a version race, and does not pass a lost write off as success", async () => {
    // First attempt loses to a concurrent sign-in that stamped the fallback
    // anchor and bumped the version; the winner's row comes back unchanged.
    const winner = { ...mocks.row, version: 3, owner_first_sign_in_at: "2026-02-21T10:00:00.000Z" };
    mocks.outcomes = [{ row: winner, changed: false }];
    const row = await anchorIncludedPeriodToAgreement({ providerId: "office-1", actor, now: NOW, facts: { officeKind: "reseller", resellerAgreementSignedOn: "2026-01-15" } });
    expect(mocks.applied).toHaveLength(2);
    expect(mocks.reads).toBe(2);
    expect((row as unknown as Record<string, unknown>).applied).toBe(true);

    // A row that already sits on the agreement period is simply done: no
    // retry, no further write.
    mocks.applied = [];
    mocks.row = { ...mocks.row, included_period_started_at: "2026-01-15T00:00:00.000Z", included_period_ends_at: "2027-01-15T00:00:00.000Z" };
    mocks.outcomes = [{ row: mocks.row, changed: false }];
    await anchorIncludedPeriodToAgreement({ providerId: "office-1", actor, now: NOW, facts: { officeKind: "reseller", resellerAgreementSignedOn: "2026-01-15" } });
    expect(mocks.applied).toHaveLength(1);

    // Losing every attempt surfaces a conflict instead of a silent miss.
    mocks.applied = [];
    mocks.row = { ...mocks.row, included_period_started_at: "2026-02-20T09:00:00.000Z", included_period_ends_at: "2027-02-20T09:00:00.000Z" };
    mocks.outcomes = [1, 2, 3, 4].map(() => ({ row: mocks.row, changed: false }));
    await expect(anchorIncludedPeriodToAgreement({ providerId: "office-1", actor, now: NOW, facts: { officeKind: "reseller", resellerAgreementSignedOn: "2026-01-15" } }))
      .rejects.toBeInstanceOf(AgreementAnchorConflictError);
    expect(mocks.applied).toHaveLength(3);
  });

  it("runs under the payments mode HQ selected when the caller holds no identity", async () => {
    expect(currentBillingIdentity()).toBeUndefined();
    await anchorIncludedPeriodToAgreementForSelectedMode({ providerId: "office-1", actor, now: NOW, facts: { officeKind: "reseller", resellerAgreementSignedOn: "2026-01-15" } });
    expect(mocks.selected).toHaveBeenCalledTimes(1);
    expect(mocks.applied[0].identity).toEqual(LIVE);
    expect(currentBillingIdentity()).toBeUndefined();
  });

  it("knows whether an anchoring for this exact date ever landed, reading the history under the selected mode", async () => {
    mocks.admin.mockReset();
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [{ id: "evt-1" }] }).mockResolvedValueOnce({ status: 200, json: [] });
    expect(await agreementAnchorRecordedForSelectedMode({ providerId: "office-1", resellerAgreementSignedOn: "2026-01-15" })).toBe(true);
    expect(await agreementAnchorRecordedForSelectedMode({ providerId: "office-1", resellerAgreementSignedOn: "2026-03-01" })).toBe(false);
    const paths = mocks.admin.mock.calls.map((call) => String(call[1]));
    expect(paths[0]).toContain("/rest/v1/billing_office_access_events?");
    expect(paths[0]).toContain("provider_id=eq.office-1");
    expect(paths[0]).toContain("event=eq.agreement_anchored");
    expect(paths[0]).toContain("detail->>resellerAgreementSignedOn=eq.2026-01-15");
    expect(paths[1]).toContain("detail->>resellerAgreementSignedOn=eq.2026-03-01");
    expect(mocks.selected).toHaveBeenCalled();
  });

  it("states where billing starts for the HQ screens: agreement date + reseller period, nothing for software or no date", () => {
    expect(agreementIncludedPeriod({ officeKind: "reseller", resellerAgreementSignedOn: "2026-01-15" }, 365)?.endsAt.toISOString()).toBe("2027-01-15T00:00:00.000Z");
    expect(agreementIncludedPeriod({ officeKind: "reseller", resellerAgreementSignedOn: null }, 365)).toBeNull();
    expect(agreementIncludedPeriod({ officeKind: "software", resellerAgreementSignedOn: "2026-01-15" }, 30)).toBeNull();
  });
});
