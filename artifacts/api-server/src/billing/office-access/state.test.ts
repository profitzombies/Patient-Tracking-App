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
  AccessTransitionError, accessIsRestricted, accessPriceCents, agreementDateAt, canTransition, coverageEndsAt, deriveAccessState,
  dueBillingPeriod, includedPeriodAnchor, includedPeriodFrom, nextAccessState, periodEnd,
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
      row({ state: "included_period", included_period_started_at: at(-10), included_period_ends_at: at(355), owner_first_sign_in_at: at(-10) }),
      { kind: "owner_first_sign_in", at: NOW, includedPeriodDays: 365 },
    );
    expect(again.patch).toEqual({});
  });

  it("remembers the owner's first sign-in apart from the period, once", () => {
    const first = nextAccessState(row(), { kind: "owner_first_sign_in", at: NOW, includedPeriodDays: 365 });
    expect(first.patch.owner_first_sign_in_at).toBe(NOW.toISOString());
    // A period HQ anchored before the owner ever signed in stands; only the sign-in is stamped.
    const anchored = row({ state: "included_period", included_period_started_at: at(-100), included_period_ends_at: at(265) });
    const signIn = nextAccessState(anchored, { kind: "owner_first_sign_in", at: NOW, includedPeriodDays: 365 });
    expect(signIn.patch).toEqual({ owner_first_sign_in_at: NOW.toISOString() });
    expect(signIn.state).toBe("included_period");
  });

  it("runs a reseller's period from its agreement date when the owner first signs in", () => {
    const agreement = agreementDateAt("2025-12-01") as Date;
    const started = nextAccessState(row(), { kind: "owner_first_sign_in", at: NOW, includedPeriodDays: 365, anchor: agreement });
    expect(started.state).toBe("included_period");
    expect(started.patch.included_period_started_at).toBe("2025-12-01T00:00:00.000Z");
    expect(started.patch.included_period_ends_at).toBe("2026-12-01T00:00:00.000Z");
    expect(started.patch.owner_first_sign_in_at).toBe(NOW.toISOString());

    // Signing in after the anchored window already closed: the period is
    // recorded as elapsed and nothing is owed until setup completes — the
    // office is never restricted on day one.
    const late = nextAccessState(row(), { kind: "owner_first_sign_in", at: NOW, includedPeriodDays: 365, anchor: agreementDateAt("2024-06-01") as Date });
    expect(late.state).toBe("setup_incomplete");
    expect(late.patch.included_period_ends_at).toBe("2025-06-01T00:00:00.000Z");
    const afterSetup = nextAccessState(
      row({ ...late.patch, state: late.state } as Partial<Row>),
      { kind: "setup_completed", at: NOW },
    );
    expect(afterSetup.state).toBe("past_due");
    // …and the first charge then covers the month that began where the included period ended.
    expect(dueBillingPeriod(row({ ...late.patch, setup_completed_at: NOW.toISOString() } as Partial<Row>), NOW)?.start.toISOString()).toBe("2025-06-01T00:00:00.000Z");
  });

  it("re-anchors the included period to an edited agreement date without touching paid coverage", () => {
    const period = includedPeriodFrom(agreementDateAt("2026-01-15") as Date, 365);
    const started = row({ state: "included_period", included_period_started_at: at(-30), included_period_ends_at: at(335), owner_first_sign_in_at: at(-30) });
    const moved = nextAccessState(started, { kind: "agreement_anchor", at: NOW, period });
    expect(moved.state).toBe("included_period");
    expect(moved.patch).toEqual({ included_period_started_at: "2026-01-15T00:00:00.000Z", included_period_ends_at: "2027-01-15T00:00:00.000Z" });
    // The same anchor again changes nothing (no history row, no version bump).
    expect(nextAccessState(row({ ...started, ...moved.patch }), { kind: "agreement_anchor", at: NOW, period }).patch).toEqual({});

    // Paid-through coverage outranks the included period, so an anchor that
    // lands in the past cannot shorten what the office already paid for.
    const paid = row({ state: "paid_current", setup_completed_at: at(-200), included_period_started_at: at(-400), included_period_ends_at: at(-35), paid_through: at(25) });
    const shortened = nextAccessState(paid, { kind: "agreement_anchor", at: NOW, period: includedPeriodFrom(agreementDateAt("2024-01-01") as Date, 365) });
    expect(shortened.state).toBe("paid_current");
    expect(shortened.patch.paid_through).toBeUndefined();
    expect(deriveAccessState({ ...paid, ...shortened.patch }, NOW)).toBe("paid_current");

    // A corrected date that extends the included period PAST what was paid
    // for is real included access again: the charger's boundary moves out to
    // the new end instead of charging at the old paid-through date.
    const paidSoon = row({ state: "paid_current", setup_completed_at: at(-200), included_period_started_at: at(-400), included_period_ends_at: at(-35), paid_through: at(25) });
    const extended = nextAccessState(paidSoon, { kind: "agreement_anchor", at: NOW, period });
    const extendedRow = row({ ...paidSoon, ...extended.patch });
    expect(extendedRow.paid_through).toBe(at(25));
    expect(coverageEndsAt(extendedRow)?.toISOString()).toBe("2027-01-15T00:00:00.000Z");
    expect(dueBillingPeriod(extendedRow, new Date(NOW.getTime() + 26 * DAY))).toBeNull();
    expect(dueBillingPeriod(extendedRow, new Date("2027-01-15T00:00:00.000Z"))?.start.toISOString()).toBe("2027-01-15T00:00:00.000Z");

    // A lifetime office has no period to anchor.
    expect(nextAccessState(row({ lifetime: true, state: "included_period" }), { kind: "agreement_anchor", at: NOW, period }).patch).toEqual({});
  });

  it("lifts a lapsed office back into a period that now runs into the future, and clears the period when no anchor is known", () => {
    const lapsed = row({ state: "past_due", setup_completed_at: at(-100), included_period_started_at: at(-400), included_period_ends_at: at(-35), grace_started_at: at(-3), grace_ends_at: at(4) });
    const period = includedPeriodFrom(agreementDateAt("2026-02-01") as Date, 365);
    const lifted = nextAccessState(lapsed, { kind: "agreement_anchor", at: NOW, period });
    expect(lifted.state).toBe("included_period");
    expect(lifted.patch).toMatchObject({ grace_started_at: null, grace_ends_at: null, restricted_at: null });
    // An anchor that already elapsed leaves the recovery clock where it is.
    const stillLapsed = nextAccessState(lapsed, { kind: "agreement_anchor", at: NOW, period: includedPeriodFrom(agreementDateAt("2024-02-01") as Date, 365) });
    expect(stillLapsed.state).toBe("past_due");
    expect(stillLapsed.patch.grace_started_at).toBeUndefined();

    const cleared = nextAccessState(
      row({ state: "included_period", included_period_started_at: at(-10), included_period_ends_at: at(355) }),
      { kind: "agreement_anchor", at: NOW, period: null },
    );
    expect(cleared.state).toBe("setup_incomplete");
    expect(cleared.patch).toMatchObject({ included_period_started_at: null, included_period_ends_at: null });
  });

  it("anchors a reseller to its agreement date, else to the first sign-in; a software office only to the sign-in", () => {
    expect(includedPeriodAnchor({ officeKind: "reseller", resellerAgreementSignedOn: "2026-01-15", ownerFirstSignInAt: at(-5) })?.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(includedPeriodAnchor({ officeKind: "reseller", resellerAgreementSignedOn: null, ownerFirstSignInAt: at(-5) })?.toISOString()).toBe(at(-5));
    expect(includedPeriodAnchor({ officeKind: "reseller", resellerAgreementSignedOn: null, ownerFirstSignInAt: null })).toBeNull();
    expect(includedPeriodAnchor({ officeKind: "software", resellerAgreementSignedOn: "2026-01-15", ownerFirstSignInAt: at(-5) })?.toISOString()).toBe(at(-5));
    // Only a real calendar date anchors anything.
    expect(agreementDateAt("2026-02-30")).toBeNull();
    expect(agreementDateAt("15/01/2026")).toBeNull();
    expect(agreementDateAt("2026-01-15T10:00:00Z")).toBeNull();
    expect(agreementDateAt(undefined)).toBeNull();
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

  it("waits for BOTH paid coverage and the included period before billing again", () => {
    // Paid through June, but a corrected reseller agreement grants included
    // access well past that: nothing is due at the paid-through date, and the
    // first charge starts where the included period ends.
    const extended = row({ setup_completed_at: at(-200), paid_through: at(-10), included_period_ends_at: at(300) });
    expect(coverageEndsAt(extended)?.toISOString()).toBe(at(300));
    expect(deriveAccessState(extended, NOW)).toBe("included_period");
    expect(dueBillingPeriod(extended, NOW)).toBeNull();
    const later = new Date(NOW.getTime() + 301 * DAY);
    expect(dueBillingPeriod(extended, later)?.start.toISOString()).toBe(at(300));
    // The usual order (paid access runs past the included period) is unchanged.
    expect(coverageEndsAt(row({ paid_through: at(20), included_period_ends_at: at(-40) }))?.toISOString()).toBe(at(20));
    expect(coverageEndsAt(row({ paid_through: null, included_period_ends_at: at(-40) }))?.toISOString()).toBe(at(-40));
    expect(coverageEndsAt(row())).toBeNull();
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
