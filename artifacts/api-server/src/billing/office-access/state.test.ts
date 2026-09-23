/**
 * The office access state machine and the recovery schedule, as pure logic.
 *
 * These are the rules the money depends on: what state the stored dates
 * justify, which transitions the engine may make, when the included period
 * starts (once), when the grace clock starts (at the failure notification),
 * and which day of the window a retry belongs to.
 */
import { describe, expect, it } from "vitest";
import type { BillingOfficeAccessSubscriptionRow as Row } from "../store";
import {
  AccessTransitionError, accessIsRestricted, accessPriceCents, canTransition, deriveAccessState,
  dueBillingPeriod, nextAccessState, periodEnd,
} from "./state";
import { DUNNING_OFFSET_DAYS, cycleForOffset, dueDunningCycle, graceElapsed } from "./dunning";

const DAY = 86_400_000;
const NOW = new Date("2026-03-01T12:00:00.000Z");

function row(patch: Partial<Row> = {}): Row {
  return {
    id: "sub-1", provider_id: "office-1", state: "setup_incomplete", plan: "monthly",
    price_cents_override: null, included_period_started_at: null, included_period_ends_at: null,
    lifetime: false, paid_through: null, paid_through_source: null,
    current_period_start: null, current_period_end: null,
    grace_started_at: null, grace_ends_at: null, restricted_at: null,
    stripe_customer_id: "cus_1", setup_completed_at: null, bank_verification_deadline: null,
    last_attempt_at: null, version: 0, created_at: NOW.toISOString(),
    ...patch,
  } as Row;
}
const at = (offsetDays: number): string => new Date(NOW.getTime() + offsetDays * DAY).toISOString();

describe("deriveAccessState", () => {
  it("reads setup_incomplete until the instruments are on file", () => {
    expect(deriveAccessState(row(), NOW)).toBe("setup_incomplete");
  });

  it("treats a lifetime office as permanently inside its included period", () => {
    const lifetime = row({ lifetime: true, paid_through: at(-30), grace_started_at: at(-10), restricted_at: at(-3) });
    expect(deriveAccessState(lifetime, NOW)).toBe("included_period");
  });

  it("keeps an office in its included period before the end date", () => {
    expect(deriveAccessState(row({ included_period_ends_at: at(5) }), NOW)).toBe("included_period");
  });

  it("lets a confirmed payment outrank an open grace clock and a restriction", () => {
    const paid = row({
      setup_completed_at: at(-60), paid_through: at(30),
      grace_started_at: at(-8), grace_ends_at: at(-1), restricted_at: at(-1),
    });
    expect(deriveAccessState(paid, NOW)).toBe("paid_current");
  });

  it("is past due inside the grace window and restricted after it", () => {
    const base = { setup_completed_at: at(-60), grace_started_at: at(-3) };
    expect(deriveAccessState(row({ ...base, grace_ends_at: at(4) }), NOW)).toBe("past_due");
    expect(deriveAccessState(row({ ...base, grace_ends_at: at(-1) }), NOW)).toBe("restricted");
    expect(accessIsRestricted(row({ ...base, grace_ends_at: at(-1) }), NOW)).toBe(true);
  });

  it("re-derives the same answer from the dates alone, so a stale column can be repaired", () => {
    const drifted = row({ state: "paid_current", setup_completed_at: at(-60), grace_started_at: at(-9), grace_ends_at: at(-2) });
    expect(deriveAccessState(drifted, NOW)).toBe("restricted");
  });
});

describe("transitions", () => {
  it("only reaches restricted from past due", () => {
    expect(canTransition("past_due", "restricted")).toBe(true);
    expect(canTransition("included_period", "restricted")).toBe(false);
    expect(canTransition("paid_current", "restricted")).toBe(false);
  });

  it("refuses an illegal move", () => {
    const stale = row({ state: "paid_current", setup_completed_at: at(-60), grace_started_at: at(-9), grace_ends_at: at(-2), restricted_at: at(-2) });
    expect(() => nextAccessState(stale, { kind: "period_expiry", at: NOW })).toThrow(AccessTransitionError);
  });

  it("will not restrict on any input other than the window elapsing", () => {
    const lapsed = row({ state: "past_due", setup_completed_at: at(-60), grace_started_at: at(-9), grace_ends_at: at(-2) });
    expect(nextAccessState(lapsed, { kind: "period_expiry", at: NOW }).state).toBe("past_due");
    expect(nextAccessState(lapsed, { kind: "grace_elapsed", at: NOW }).state).toBe("restricted");
  });
});

describe("inputs", () => {
  it("starts the included period on the owner's first sign-in and never again", () => {
    const first = nextAccessState(row(), { kind: "owner_first_sign_in", at: NOW, includedPeriodDays: 365 });
    expect(first.state).toBe("included_period");
    expect(first.patch.included_period_started_at).toBe(NOW.toISOString());
    expect(first.patch.included_period_ends_at).toBe(at(365));

    const again = nextAccessState(
      row({ state: "included_period", included_period_started_at: at(-10), included_period_ends_at: at(355) }),
      { kind: "owner_first_sign_in", at: NOW, includedPeriodDays: 365 },
    );
    expect(again.patch).toEqual({});
  });

  it("starts the grace clock at the failure notification and keeps that deadline", () => {
    const failed = nextAccessState(
      row({ state: "included_period", setup_completed_at: at(-60) }),
      { kind: "charge_failed", at: NOW, graceDays: 7 },
    );
    expect(failed.patch.grace_started_at).toBe(NOW.toISOString());
    expect(failed.patch.grace_ends_at).toBe(at(7));
    expect(failed.state).toBe("past_due");

    const later = nextAccessState(
      row({ state: "past_due", setup_completed_at: at(-60), grace_started_at: at(-2), grace_ends_at: at(5) }),
      { kind: "charge_failed", at: NOW, graceDays: 7 },
    );
    expect(later.patch.grace_ends_at).toBeUndefined();
  });

  it("clears the clock and the restriction when a payment lands", () => {
    const restricted = row({
      state: "restricted", setup_completed_at: at(-60),
      grace_started_at: at(-9), grace_ends_at: at(-2), restricted_at: at(-2),
    });
    const paid = nextAccessState(restricted, {
      kind: "charge_succeeded", at: NOW, periodEnd: new Date(NOW.getTime() + 30 * DAY), source: "stripe",
    });
    expect(paid.state).toBe("paid_current");
    expect(paid.patch).toMatchObject({ grace_started_at: null, grace_ends_at: null, restricted_at: null });
  });

  it("rolls access back to the start of a reversed period and restarts the clock", () => {
    const paid = row({ state: "paid_current", setup_completed_at: at(-60), paid_through: at(20) });
    const reversed = nextAccessState(paid, {
      kind: "payment_reversed", at: NOW, periodStart: new Date(NOW.getTime() - 10 * DAY), graceDays: 7,
    });
    expect(reversed.patch.paid_through).toBe(at(-10));
    expect(reversed.patch.grace_started_at).toBe(NOW.toISOString());
    expect(reversed.state).toBe("past_due");
  });

  it("restores access when HQ records a paid-through date", () => {
    const restricted = row({
      state: "restricted", setup_completed_at: at(-60),
      grace_started_at: at(-9), grace_ends_at: at(-2), restricted_at: at(-2),
    });
    const decision = nextAccessState(restricted, {
      kind: "hq_paid_through", at: NOW, paidThrough: new Date(NOW.getTime() + 60 * DAY), source: "offline",
    });
    expect(decision.state).toBe("paid_current");
    expect(decision.patch.paid_through_source).toBe("offline");
    expect(decision.patch.restricted_at).toBeNull();
  });
});

describe("periods and pricing", () => {
  it("advances by calendar month or year", () => {
    expect(periodEnd("monthly", new Date("2026-01-31T00:00:00Z")).toISOString()).toBe("2026-03-03T00:00:00.000Z");
    expect(periodEnd("yearly", new Date("2026-03-01T00:00:00Z")).toISOString()).toBe("2027-03-01T00:00:00.000Z");
  });

  it("bills from where paid access currently ends", () => {
    const due = dueBillingPeriod(row({ setup_completed_at: at(-60), included_period_ends_at: at(-1) }), NOW);
    expect(due?.start.toISOString()).toBe(at(-1));
    expect(dueBillingPeriod(row({ setup_completed_at: at(-60), included_period_ends_at: at(5) }), NOW)).toBeNull();
    expect(dueBillingPeriod(row({ lifetime: true, setup_completed_at: at(-60), included_period_ends_at: at(-1) }), NOW)).toBeNull();
    expect(dueBillingPeriod(row({ included_period_ends_at: at(-1) }), NOW)).toBeNull();
  });

  it("prefers the office's price override over the HQ list price", () => {
    const prices = { monthlyPriceCents: 20_000, yearlyPriceCents: 200_000 };
    expect(accessPriceCents(row(), prices)).toBe(20_000);
    expect(accessPriceCents(row({ plan: "yearly" }), prices)).toBe(200_000);
    expect(accessPriceCents(row({ price_cents_override: 15_000 }), prices)).toBe(15_000);
  });
});

describe("recovery schedule", () => {
  const graceStart = new Date("2026-03-01T00:00:00.000Z");
  const day = (n: number, hours = 0): Date => new Date(graceStart.getTime() + n * DAY + hours * 3_600_000);

  it("retries immediately and then on days 2, 4 and 6", () => {
    expect(DUNNING_OFFSET_DAYS).toEqual([0, 2, 4, 6]);
    expect(dueDunningCycle(graceStart.toISOString(), day(0))).toEqual({ cycle: 2, offsetDays: 0 });
    expect(dueDunningCycle(graceStart.toISOString(), day(1, 23))).toEqual({ cycle: 2, offsetDays: 0 });
    expect(dueDunningCycle(graceStart.toISOString(), day(2))).toEqual({ cycle: 3, offsetDays: 2 });
    expect(dueDunningCycle(graceStart.toISOString(), day(4))).toEqual({ cycle: 4, offsetDays: 4 });
    expect(dueDunningCycle(graceStart.toISOString(), day(6))).toEqual({ cycle: 5, offsetDays: 6 });
  });

  it("catches up with one attempt rather than a burst after an outage", () => {
    expect(dueDunningCycle(graceStart.toISOString(), day(5))).toEqual({ cycle: 4, offsetDays: 4 });
    expect(cycleForOffset(0)).toBe(2);
  });

  it("restricts only at the end of day seven", () => {
    const ends = new Date(graceStart.getTime() + 7 * DAY).toISOString();
    expect(graceElapsed({ grace_ends_at: ends }, day(6, 23))).toBe(false);
    expect(graceElapsed({ grace_ends_at: ends }, day(7))).toBe(true);
    expect(graceElapsed({ grace_ends_at: null }, day(9))).toBe(false);
  });
});
