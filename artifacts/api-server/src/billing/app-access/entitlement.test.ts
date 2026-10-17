/**
 * The app-access entitlement rule, exhaustively.
 *
 * Pure function, so every branch is pinned with values: the THINNR protocol
 * window (and a provider restart opening a new one), the office-configurable
 * trial for other programs, an office that does not charge, every
 * subscription status, the paid-through grace after a cancellation, and the
 * one-word staff states the roster derives from the same result.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateAppAccess, localDayOf, protocolFreeUntil, staffState, subscriptionCovers, subscriptionState, trialFreeUntil,
  type AppAccessEntitlementInput, type AppAccessOfficeSettings, type AppAccessSubscriptionFacts,
} from "./entitlement";

const CHARGING: AppAccessOfficeSettings = { enabled: true, price_cents: 699, cadence: "2_weeks", trial_days: 7 };
const FREE: AppAccessOfficeSettings = { enabled: false, price_cents: null, cadence: "monthly", trial_days: 7 };

function input(overrides: Partial<AppAccessEntitlementInput> = {}): AppAccessEntitlementInput {
  return {
    todayKey: "2026-03-10",
    now: new Date("2026-03-10T15:00:00Z"),
    programId: "thinnr",
    episodeStartedOn: "2026-03-01",
    activatedAt: "2026-03-01T14:00:00Z",
    timeZone: "America/Chicago",
    office: CHARGING,
    subscription: null,
    ...overrides,
  };
}

function sub(overrides: Partial<AppAccessSubscriptionFacts> = {}): AppAccessSubscriptionFacts {
  return { status: "active", current_period_end: "2026-03-24T15:00:00Z", cancel_at_period_end: false, ...overrides };
}

describe("THINNR protocol window", () => {
  it("is free through protocol day 42 of the current episode", () => {
    expect(protocolFreeUntil("thinnr", "2026-03-01")).toBe("2026-04-12");
    const onDay42 = evaluateAppAccess(input({ todayKey: "2026-04-12" }));
    expect(onDay42).toMatchObject({ available: true, reason: "protocol_window", free_window: { kind: "protocol", ends_on: "2026-04-12" } });
  });

  it("locks on day 43 when the office charges and nothing covers the patient", () => {
    const day43 = evaluateAppAccess(input({ todayKey: "2026-04-13" }));
    expect(day43).toMatchObject({ available: false, reason: "locked", free_window: { kind: "protocol", ends_on: "2026-04-12" } });
    expect(staffState(day43)).toBe("locked");
  });

  it("treats a missing program id as the THINNR program", () => {
    expect(evaluateAppAccess(input({ programId: null })).reason).toBe("protocol_window");
  });

  it("is free before the episode starts (a protocol about to begin is not a lock)", () => {
    expect(evaluateAppAccess(input({ todayKey: "2026-02-20" })).reason).toBe("protocol_window");
  });

  it("opens a new free window when the provider restarts the protocol", () => {
    const lapsedRound = evaluateAppAccess(input({ episodeStartedOn: "2025-12-01", todayKey: "2026-03-10" }));
    expect(lapsedRound.available).toBe(false);
    const restarted = evaluateAppAccess(input({ episodeStartedOn: "2026-03-09", todayKey: "2026-03-10" }));
    expect(restarted).toMatchObject({ available: true, reason: "protocol_window", free_window: { ends_on: "2026-04-20" } });
  });

  it("has no window without a dated episode, so it falls through to charging", () => {
    expect(protocolFreeUntil("thinnr", null)).toBeNull();
    expect(protocolFreeUntil("thinnr", "not-a-day")).toBeNull();
    const undated = evaluateAppAccess(input({ episodeStartedOn: null }));
    expect(undated).toMatchObject({ available: false, reason: "locked", free_window: null });
    expect(evaluateAppAccess(input({ episodeStartedOn: null, office: FREE })).reason).toBe("office_not_charging");
  });
});

describe("trial for other programs", () => {
  it("covers the activation day plus the next N-1 local days", () => {
    // 2026-03-01T04:30Z is still Feb 28 in Chicago: the trial counts from the LOCAL day.
    expect(trialFreeUntil("2026-03-01T04:30:00Z", "America/Chicago", 7)).toBe("2026-03-06");
    expect(trialFreeUntil("2026-03-01T04:30:00Z", "UTC", 7)).toBe("2026-03-07");
    expect(trialFreeUntil("2026-03-01T04:30:00Z", "Not/AZone", 7)).toBe("2026-03-07");
    expect(trialFreeUntil("2026-03-01T04:30:00Z", null, 1)).toBe("2026-03-01");
  });

  it("is free inside the trial and locked the day after", () => {
    const glp1 = (todayKey: string) => evaluateAppAccess(input({ programId: "glp1", todayKey }));
    expect(glp1("2026-03-07")).toMatchObject({ available: true, reason: "trial", free_window: { kind: "trial", ends_on: "2026-03-07" } });
    const after = glp1("2026-03-08");
    expect(after).toMatchObject({ available: false, reason: "locked" });
    expect(staffState(after)).toBe("trial_ended");
  });

  it("honours the office's trial length, including zero days", () => {
    const office = { ...CHARGING, trial_days: 30 };
    expect(evaluateAppAccess(input({ programId: "none", office, todayKey: "2026-03-30" })).reason).toBe("trial");
    expect(evaluateAppAccess(input({ programId: "none", office, todayKey: "2026-03-31" })).reason).toBe("locked");
    expect(trialFreeUntil("2026-03-01T14:00:00Z", "UTC", 0)).toBe("2026-02-28");
    const none = evaluateAppAccess(input({ programId: "none", office: { ...CHARGING, trial_days: 0 }, todayKey: "2026-03-01" }));
    expect(none).toMatchObject({ available: false, reason: "locked", free_window: { kind: "trial", ends_on: "2026-02-28" } });
  });

  it("ignores the protocol episode for non-THINNR programs", () => {
    const result = evaluateAppAccess(input({ programId: "glp1", episodeStartedOn: "2026-03-09", todayKey: "2026-03-20" }));
    expect(result.reason).toBe("locked");
  });

  it("has no window when activation is unknown", () => {
    expect(trialFreeUntil(null, "UTC", 7)).toBeNull();
    expect(trialFreeUntil("garbage", "UTC", 7)).toBeNull();
    expect(evaluateAppAccess(input({ programId: "glp1", activatedAt: null })).free_window).toBeNull();
  });
});

describe("office that does not charge", () => {
  it("is always available with no price, even after every window", () => {
    const result = evaluateAppAccess(input({ office: FREE, todayKey: "2027-01-01" }));
    expect(result).toMatchObject({ available: true, reason: "office_not_charging", office_charges: false, price_cents: null, cadence: null });
    expect(staffState(result)).toBe("not_charged");
  });

  it("does not charge when enabled without a usable price", () => {
    for (const price of [null, 0]) {
      const result = evaluateAppAccess(input({ office: { ...CHARGING, price_cents: price }, todayKey: "2027-01-01" }));
      expect(result.reason).toBe("office_not_charging");
      expect(result.office_charges).toBe(false);
    }
  });

  it("still reports the free window inside it", () => {
    const result = evaluateAppAccess(input({ office: FREE }));
    expect(result).toMatchObject({ reason: "protocol_window", office_charges: false });
  });
});

describe("subscription coverage", () => {
  const after = (subscription: AppAccessSubscriptionFacts | null, extra: Partial<AppAccessEntitlementInput> = {}) =>
    evaluateAppAccess(input({ todayKey: "2027-01-01", now: new Date("2027-01-01T12:00:00Z"), subscription, ...extra }));

  it("covers while active, past_due and unpaid (Stripe is still dunning)", () => {
    for (const status of ["active", "past_due", "unpaid"]) {
      const result = after(sub({ status, current_period_end: "2026-12-01T00:00:00Z" }));
      expect(result).toMatchObject({ available: true, reason: "subscribed", price_cents: 699, cadence: "2_weeks" });
    }
    expect(staffState(after(sub({ status: "active" })))).toBe("subscribed");
    expect(staffState(after(sub({ status: "past_due" })))).toBe("past_due");
    expect(staffState(after(sub({ status: "unpaid" })))).toBe("past_due");
  });

  it("keeps access through the paid period after a cancellation, then locks as lapsed", () => {
    const now = new Date("2027-01-01T12:00:00Z");
    expect(subscriptionCovers(sub({ status: "canceled", current_period_end: "2027-01-01T12:00:01Z" }), now)).toBe(true);
    expect(subscriptionCovers(sub({ status: "canceled", current_period_end: "2027-01-01T12:00:00Z" }), now)).toBe(false);
    expect(subscriptionCovers(sub({ status: "canceled", current_period_end: null }), now)).toBe(false);

    const graced = after(sub({ status: "canceled", current_period_end: "2027-01-05T00:00:00Z" }));
    expect(graced).toMatchObject({ available: true, reason: "subscribed" });
    expect(staffState(graced)).toBe("canceling");

    const lapsed = after(sub({ status: "canceled", current_period_end: "2026-12-31T00:00:00Z" }));
    expect(lapsed).toMatchObject({ available: false, reason: "locked", subscription: { state: "canceled" } });
    expect(staffState(lapsed)).toBe("lapsed");
  });

  it("marks an active subscription scheduled to end as cancelling", () => {
    expect(staffState(after(sub({ cancel_at_period_end: true })))).toBe("canceling");
  });

  it("gives an incomplete first payment no coverage and no lapse", () => {
    expect(subscriptionState(sub({ status: "incomplete" }))).toBe("none");
    expect(subscriptionCovers(sub({ status: "incomplete" }), new Date())).toBe(false);
    const result = after(sub({ status: "incomplete", current_period_end: null }));
    expect(result).toMatchObject({ available: false, reason: "locked", subscription: { state: "none" } });
    expect(staffState(result)).toBe("locked");
    expect(staffState(after(sub({ status: "incomplete" }), { programId: "glp1" }))).toBe("trial_ended");
  });

  it("does not need a subscription inside a free window", () => {
    const result = evaluateAppAccess(input({ subscription: sub({ status: "canceled", current_period_end: "2026-01-01T00:00:00Z" }) }));
    expect(result).toMatchObject({ available: true, reason: "protocol_window", subscription: { state: "canceled" } });
  });

  it("reports the subscription even when the office stopped charging", () => {
    const result = after(sub(), { office: FREE });
    expect(result).toMatchObject({ reason: "office_not_charging", subscription: { state: "active" }, price_cents: null });
  });
});

describe("localDayOf", () => {
  it("places an instant on the patient's local day, falling back to UTC", () => {
    expect(localDayOf("2026-03-01T04:30:00Z", "America/Chicago")).toBe("2026-02-28");
    expect(localDayOf("2026-03-01T04:30:00Z", "Asia/Tokyo")).toBe("2026-03-01");
    expect(localDayOf("2026-03-01T04:30:00Z", "   ")).toBe("2026-03-01");
    expect(localDayOf("nope", "UTC")).toBeNull();
  });
});
