/**
 * The App payments read model. The forecast must pick exactly the dates and
 * amounts the charger will: each projected charge is replayed through the
 * charger's own `dueBillingPeriod` + `charge_succeeded` transition and must
 * line up period for period.
 */
import { describe, expect, it } from "vitest";
import type {
  BillingOfficeAccessAttemptRow as Attempt,
  BillingOfficeAccessEventRow as AccessEvent,
  BillingOfficeAccessInstrumentRow as Instrument,
  BillingOfficeAccessSubscriptionRow as Row,
} from "../store";
import {
  buildAccessLedger,
  buildForecast,
  bucketStart,
  lastPayment,
  paymentFlagsAt,
  projectOffice,
  summarizeLedger,
  nextChargeDate,
  trialDaysLeft,
  type OfficeInput,
} from "./forecast";
import { accessPriceCents, coverageEndsAt, dueBillingPeriod, nextAccessState } from "./state";

const DAY = 86_400_000;
const NOW = new Date("2026-03-01T12:00:00.000Z");
const PRICES = { monthlyPriceCents: 19_900, yearlyPriceCents: 199_000 };
const at = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();

function row(patch: Partial<Row> = {}): Row {
  return {
    id: "sub-1", provider_id: "office-1", state: "paid_current", plan: "monthly",
    price_cents_override: null, included_period_started_at: at(-90), included_period_ends_at: at(-60),
    lifetime: false, paid_through: null, paid_through_source: null,
    current_period_start: null, current_period_end: null,
    grace_started_at: null, grace_ends_at: null, restricted_at: null,
    stripe_customer_id: "cus_1", setup_completed_at: at(-89), bank_verification_deadline: null,
    last_attempt_at: null, version: 0, created_at: at(-90),
    ...patch,
  } as Row;
}

function instrument(patch: Partial<Instrument> = {}): Instrument {
  return {
    id: `pm-${Math.random()}`, subscription_id: "sub-1", provider_id: "office-1", slot: "card_primary", kind: "card",
    stripe_payment_method_id: "pm_1", setup_intent_id: null, fingerprint: null, brand: "visa", last4: "4242",
    exp_month: 12, exp_year: 2030, bank_name: null, verification_status: "verified", verification_deadline: null,
    removed_at: null, staged_at: null, created_at: at(-89),
    ...patch,
  } as Instrument;
}

const HEALTHY = [
  instrument({ slot: "bank", kind: "bank", bank_name: "Chase", last4: "6789", exp_month: null, exp_year: null, brand: null }),
  instrument(),
];

function office(r: Row, instruments: Instrument[] = HEALTHY, name = "Glow Spa"): OfficeInput {
  return { providerId: r.provider_id, officeName: name, row: r, instruments };
}

const YEAR = { start: NOW, end: new Date(NOW.getTime() + 400 * DAY) };

/** Replays charges through the charger's own rules and returns the dates/amounts it collects. */
function chargerSchedule(start: Row, until: Date): Array<{ date: string; amountCents: number }> {
  const out: Array<{ date: string; amountCents: number }> = [];
  let r = start;
  for (let i = 0; i < 100; i += 1) {
    const anchor = coverageEndsAt(r)?.getTime() ?? Number.NaN;
    if (anchor > until.getTime()) break;
    const due = dueBillingPeriod(r, new Date(anchor));
    if (!due) break;
    out.push({ date: due.start.toISOString(), amountCents: accessPriceCents(r, PRICES) });
    r = { ...r, ...nextAccessState(r, { kind: "charge_succeeded", at: due.start, periodEnd: due.end, source: "stripe" }).patch };
  }
  return out;
}

describe("projectOffice matches the charger", () => {
  it("monthly renewals land on the same dates and amounts the charger collects", () => {
    const r = row({ paid_through: at(10) });
    const projected = projectOffice(office(r), PRICES, YEAR, NOW).charges;
    expect(projected.map(({ date, amountCents }) => ({ date, amountCents }))).toEqual(chargerSchedule(r, YEAR.end));
    expect(projected).toHaveLength(13);
    expect(projected.every((c) => c.type === "renewal" && c.amountCents === 19_900)).toBe(true);
  });

  it("uses the office's HQ price override", () => {
    const r = row({ paid_through: at(3), price_cents_override: 12_345 });
    const projected = projectOffice(office(r), PRICES, YEAR, NOW).charges;
    expect(projected.map(({ date, amountCents }) => ({ date, amountCents }))).toEqual(chargerSchedule(r, YEAR.end));
    expect(new Set(projected.map((c) => c.amountCents))).toEqual(new Set([12_345]));
  });

  it("charges a yearly plan once per year at the yearly price", () => {
    const r = row({ plan: "yearly", paid_through: at(20) });
    const projected = projectOffice(office(r), PRICES, YEAR, NOW).charges;
    // 400-day window: this year's renewal and next year's.
    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({ date: at(20), amountCents: 199_000, plan: "yearly" });
    expect(projected[1].date).toBe(new Date(Date.UTC(2027, 2, 21, 12)).toISOString());
    expect(projected.map(({ date, amountCents }) => ({ date, amountCents }))).toEqual(chargerSchedule(r, YEAR.end));
  });

  it("marks the first charge at the trial end as a trial conversion, then renewals", () => {
    const r = row({ state: "included_period", included_period_started_at: at(-16), included_period_ends_at: at(14) });
    const projected = projectOffice(office(r), PRICES, YEAR, NOW).charges;
    expect(projected[0]).toMatchObject({ date: at(14), type: "trial_conversion" });
    expect(projected.slice(1).every((c) => c.type === "renewal")).toBe(true);
    expect(projected.map(({ date, amountCents }) => ({ date, amountCents }))).toEqual(chargerSchedule(r, YEAR.end));
    expect(trialDaysLeft(r, NOW)).toBe(14);
  });

  it("holds the next charge until an included period that outlasts the paid-through date ends", () => {
    // Paid through next month, then HQ corrected the reseller agreement date
    // and the included period now runs for most of the year.
    const r = row({ state: "included_period", paid_through: at(30), included_period_started_at: at(-65), included_period_ends_at: at(300) });
    expect(nextChargeDate(r)?.toISOString()).toBe(at(300));
    expect(trialDaysLeft(r, NOW)).toBe(300);
    const projected = projectOffice(office(r), PRICES, YEAR, NOW);
    expect(projected.outstanding).toBeNull();
    expect(projected.charges[0]).toMatchObject({ date: at(300), type: "trial_conversion" });
    expect(projected.charges.every((c) => Date.parse(c.date) >= Date.parse(at(300)))).toBe(true);
    expect(projected.charges.map(({ date, amountCents }) => ({ date, amountCents }))).toEqual(chargerSchedule(r, YEAR.end));
    // Paid coverage that already reaches past the included period is the normal case: no free window left.
    expect(trialDaysLeft(row({ paid_through: at(40), included_period_ends_at: at(10) }), NOW)).toBeNull();
    expect(nextChargeDate(row({ paid_through: at(40), included_period_ends_at: at(10) }))?.toISOString()).toBe(at(40));
  });

  it("reports a lapsed period as outstanding, never as future revenue", () => {
    const r = row({ state: "past_due", paid_through: at(-5), grace_started_at: at(-5), grace_ends_at: at(2) });
    const { charges, outstanding } = projectOffice(office(r), PRICES, YEAR, NOW);
    expect(outstanding).toMatchObject({ since: at(-5), amountCents: 19_900, state: "past_due" });
    // The next future charge is where a recovered payment would leave paid_through.
    const recovered = { ...r, paid_through: dueBillingPeriod(r, NOW)!.end.toISOString() };
    expect(charges[0].date).toBe(recovered.paid_through);
    expect(charges.every((c) => Date.parse(c.date) > NOW.getTime())).toBe(true);
    expect(charges.every((c) => c.atRisk && c.riskReasons.includes("past_due"))).toBe(true);
  });

  it("skips lifetime and free offices entirely", () => {
    expect(projectOffice(office(row({ lifetime: true, paid_through: at(1) })), PRICES, YEAR, NOW)).toEqual({ charges: [], outstanding: null });
    expect(projectOffice(office(row({ paid_through: at(1), price_cents_override: 0 })), PRICES, YEAR, NOW).charges).toEqual([]);
  });

  it("only lists charges inside the window", () => {
    const r = row({ paid_through: at(10) });
    const window = { start: new Date(NOW.getTime() + 40 * DAY), end: new Date(NOW.getTime() + 100 * DAY) };
    const projected = projectOffice(office(r), PRICES, window, NOW).charges;
    expect(projected.length).toBe(2);
    expect(projected.every((c) => Date.parse(c.date) >= window.start.getTime() && Date.parse(c.date) <= window.end.getTime())).toBe(true);
  });
});

describe("payment method flags", () => {
  it("flags a card that expires before the charge and no usable method when nothing else is left", () => {
    const card = instrument({ exp_month: 3, exp_year: 2026 });
    expect(paymentFlagsAt([card], new Date("2026-03-31T00:00:00Z"))).toEqual([]);
    expect(paymentFlagsAt([card], new Date("2026-04-01T00:00:00Z"))).toEqual(["no_method", "card_expiring"]);
  });

  it("flags an unverified bank but still counts the card as usable", () => {
    const flags = paymentFlagsAt([instrument({ slot: "bank", kind: "bank", verification_status: "pending" }), instrument()], NOW);
    expect(flags).toEqual(["bank_unverified"]);
  });

  it("ignores removed and staged instruments", () => {
    expect(paymentFlagsAt([instrument({ removed_at: at(-1) }), instrument({ staged_at: at(-1) })], NOW)).toEqual(["no_method"]);
  });

  it("puts charges whose office has a problem at risk", () => {
    const r = row({ paid_through: at(10) });
    const [first] = projectOffice(office(r, []), PRICES, YEAR, NOW).charges;
    expect(first).toMatchObject({ atRisk: true, riskReasons: ["no_method"] });
  });
});

describe("buildForecast", () => {
  const offices = [
    office(row({ paid_through: at(10) }), HEALTHY, "A"),
    office(row({ id: "sub-2", provider_id: "office-2", plan: "yearly", paid_through: at(20) }), HEALTHY, "B"),
    office(row({ id: "sub-3", provider_id: "office-3", paid_through: null, included_period_ends_at: at(5) }), [], "C"),
    office(row({ id: "sub-4", provider_id: "office-4", paid_through: at(-3), grace_started_at: at(-3), grace_ends_at: at(4) }), HEALTHY, "D"),
  ];
  const window = { start: NOW, end: new Date(NOW.getTime() + 30 * DAY - 1) };
  const forecast = buildForecast(offices, PRICES, window, "week", NOW);

  it("totals split by type and plan add back up to the total", () => {
    const t = forecast.totals;
    expect(t.renewalCents + t.trialConversionCents).toBe(t.totalCents);
    expect(t.monthlyCents + t.yearlyCents).toBe(t.totalCents);
    expect(t.yearlyCents).toBe(199_000);
    expect(t.trialConversionCents).toBe(19_900);
    expect(t.atRiskCents).toBe(19_900 + 19_900); // C has no method; D is past due (its next renewal lands in the window)
  });

  it("keeps the past-due balance out of future revenue", () => {
    expect(forecast.outstanding.totalCents).toBe(19_900);
    expect(forecast.outstanding.offices.map((o) => o.officeName)).toEqual(["D"]);
    expect(forecast.charges.some((c) => c.officeName === "D" && Date.parse(c.date) <= NOW.getTime())).toBe(false);
  });

  it("lists every week in the window, gap-free, and the periods sum to the totals", () => {
    const keys = forecast.periods.map((p) => p.key);
    expect(keys[0]).toBe(bucketStart(NOW, "week").toISOString().slice(0, 10));
    for (let i = 1; i < keys.length; i += 1) expect(Date.parse(keys[i]) - Date.parse(keys[i - 1])).toBe(7 * DAY);
    expect(forecast.periods.reduce((s, p) => s + p.totalCents, 0)).toBe(forecast.totals.totalCents);
  });
});

describe("collected history", () => {
  const base = {
    subscription_id: "sub-1", provider_id: "office-1", cycle: 0, plan: "monthly" as const,
    stripe_payment_intent_id: null, failure_code: null, failure_message: null, settled_at: null, failed_at: null,
  };
  const attempts: Attempt[] = [
    { ...base, id: "a1", period_start: at(-40), period_end: at(-10), slot: "bank", amount_cents: 19_900, status: "succeeded", settled_at: at(-38), created_at: at(-40) },
    { ...base, id: "a2", period_start: at(-10), period_end: at(20), slot: "card_primary", amount_cents: 19_900, status: "failed", failure_code: "card_declined", failed_at: at(-10), created_at: at(-10) },
    { ...base, id: "a3", period_start: at(-10), period_end: at(20), cycle: 1, slot: "card_backup", amount_cents: 19_900, status: "failed", settled_at: at(-9), failed_at: at(-2), failure_code: "insufficient_funds", created_at: at(-9) },
  ] as Attempt[];
  const events: AccessEvent[] = [
    { id: 1, subscription_id: "sub-1", provider_id: "office-1", event: "offline_payment", from_state: null, to_state: null, actor_user_id: "hq", actor_kind: "hq", detail: { amountCents: 5_000, paidThrough: at(50) }, created_at: at(-1) },
  ] as AccessEvent[];
  const instruments = [
    instrument({ slot: "bank", kind: "bank", bank_name: "Chase", last4: "6789", brand: null }),
    instrument({ slot: "card_primary", last4: "4242" }),
    instrument({ slot: "card_backup", last4: "1111", brand: "mastercard" }),
  ];
  const range = { start: new Date(NOW.getTime() - 60 * DAY), end: NOW };
  const entries = buildAccessLedger({
    attempts, events, instruments, officeNames: new Map([["office-1", "Glow Spa"]]), plans: new Map([["office-1", "monthly"]]),
    start: range.start, end: range.end,
  });

  it("lists every attempt with its method, a reversal for money taken back, and offline payments", () => {
    expect(entries.map((e) => [e.type, e.outcome, e.last4, e.netCents])).toEqual([
      ["charge", "succeeded", "6789", 19_900],
      ["charge", "failed", "4242", 0],
      ["charge", "succeeded", "1111", 19_900],
      ["reversal", "reversed", "1111", -19_900],
      ["offline_payment", "recorded", null, 5_000],
    ]);
  });

  it("summarizes by month with net = collected + offline − reversed", () => {
    const { totals, months } = summarizeLedger(entries, range.start, range.end);
    expect(totals).toMatchObject({ collectedCents: 39_800, offlineCents: 5_000, reversedCents: 19_900, failedCount: 1, succeededCount: 2 });
    expect(totals.netCents).toBe(39_800 + 5_000 - 19_900);
    expect(months.reduce((s, m) => s + m.netCents, 0)).toBe(totals.netCents);
  });

  it("last payment is the newest result, offline included", () => {
    expect(lastPayment(attempts, [])).toMatchObject({ outcome: "reversed", failureCode: "insufficient_funds" });
    expect(lastPayment(attempts, events)).toMatchObject({ outcome: "offline", amountCents: 5_000 });
  });
});
