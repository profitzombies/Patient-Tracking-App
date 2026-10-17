/**
 * App payments read model: what each office will be charged for platform
 * access, when, on what, and how much actually came in.
 *
 * Everything here is pure: callers load the office-access rows and hand them
 * in. The projection walks the SAME rules the charger walks — the period
 * starts where coverage ends (`coverageEndsAt`: the later of `paid_through`
 * and the included period's end), each period is `periodEnd(plan, start)`
 * long, and the amount is
 * `accessPriceCents` (the office override, else the HQ list price) — so a
 * forecast date is the date `dueBillingPeriod` will pick up, never a guess.
 *
 * Money already owed (the access period has lapsed unpaid) is OUTSTANDING,
 * never future revenue: the owed period is reported once on its own and the
 * projection continues from the end of that period, which is exactly where a
 * recovered charge would leave `paid_through`.
 */
import type {
  BillingOfficeAccessAttemptRow as Attempt,
  BillingOfficeAccessEventRow as AccessEvent,
  BillingOfficeAccessInstrumentRow as Instrument,
  BillingOfficeAccessSubscriptionRow as Row,
  OfficeAccessPlan,
  OfficeAccessSlot,
  OfficeAccessState,
} from "../store";
import { chargeableInstruments } from "./instruments";
import { accessPriceCents, coverageEndsAt, deriveAccessState, periodEnd } from "./state";

const DAY_MS = 86_400_000;

export type PaymentRiskFlag = "no_method" | "card_expiring" | "bank_unverified";
export type ChargeType = "trial_conversion" | "renewal";
export type ForecastBucket = "week" | "month";

export interface Prices { monthlyPriceCents: number; yearlyPriceCents: number }

/** The instruments actually in service: not removed, not a staged replacement. */
export function inService(instruments: Instrument[]): Instrument[] {
  return instruments.filter((row) => !row.removed_at && !row.staged_at);
}

/** A card works through the last day of its expiry month (UTC). */
export function cardValidUntil(instrument: Pick<Instrument, "kind" | "exp_month" | "exp_year">): Date | null {
  if (instrument.kind !== "card" || !instrument.exp_month || !instrument.exp_year) return null;
  return new Date(Date.UTC(instrument.exp_year, instrument.exp_month, 1));
}

/**
 * What would stop a charge on `at` from going through on the first try:
 * nothing chargeable left, a card on file that will have expired, or a bank
 * account that is not verified (the waterfall skips it).
 */
export function paymentFlagsAt(instruments: Instrument[], at: Date): PaymentRiskFlag[] {
  const live = inService(instruments);
  const flags: PaymentRiskFlag[] = [];
  const expired = (row: Instrument) => {
    const until = cardValidUntil(row);
    return until !== null && until.getTime() <= at.getTime();
  };
  const usable = chargeableInstruments(live).filter((row) => !expired(row));
  if (!usable.length) flags.push("no_method");
  if (live.some(expired)) flags.push("card_expiring");
  const bank = live.find((row) => row.kind === "bank");
  if (bank && bank.verification_status !== "verified") flags.push("bank_unverified");
  return flags;
}

export interface InstrumentSummary {
  slot: OfficeAccessSlot;
  kind: "bank" | "card";
  brand: string | null;
  bankName: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  verificationStatus: "verified" | "pending" | "failed";
}

const SLOT_ORDER: Record<OfficeAccessSlot, number> = { bank: 0, card_primary: 1, card_backup: 2 };

export function instrumentSummaries(instruments: Instrument[]): InstrumentSummary[] {
  return inService(instruments)
    .sort((a, b) => SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot])
    .map((row) => ({
      slot: row.slot, kind: row.kind, brand: row.brand, bankName: row.bank_name, last4: row.last4,
      expMonth: row.exp_month, expYear: row.exp_year, verificationStatus: row.verification_status,
    }));
}

export interface LastPayment {
  at: string;
  amountCents: number;
  outcome: "succeeded" | "failed" | "processing" | "reversed" | "offline";
  slot: OfficeAccessSlot | null;
  failureCode: string | null;
}

/** The most recent payment result: the newest attempt, or a later offline payment. */
export function lastPayment(attempts: Attempt[], events: AccessEvent[]): LastPayment | null {
  const candidates: LastPayment[] = attempts.map((attempt) => ({
    at: attempt.failed_at ?? attempt.settled_at ?? attempt.created_at,
    amountCents: attempt.amount_cents,
    outcome: attempt.status === "failed" && attempt.settled_at ? "reversed" : attempt.status,
    slot: attempt.slot,
    failureCode: attempt.failure_code,
  }));
  for (const event of events) {
    if (event.event !== "offline_payment") continue;
    candidates.push({ at: event.created_at, amountCents: centsOf(event.detail.amountCents), outcome: "offline", slot: null, failureCode: null });
  }
  candidates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return candidates[0] ?? null;
}

function centsOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function ms(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** When the next charge is due, per the charger's own anchor. Null for lifetime / free / no clock. */
export function nextChargeDate(row: Row): Date | null {
  if (row.lifetime) return null;
  return coverageEndsAt(row);
}

export function trialDaysLeft(row: Row, now: Date): number | null {
  if (row.lifetime) return null;
  const end = ms(row.included_period_ends_at);
  if (end === null || end <= now.getTime()) return null;
  // Paid coverage that already reaches past the included period makes the
  // period moot; an included period extended beyond what was paid for is a
  // real free window again.
  if ((ms(row.paid_through) ?? Number.NEGATIVE_INFINITY) >= end) return null;
  return Math.ceil((end - now.getTime()) / DAY_MS);
}

export interface OfficeInput {
  providerId: string;
  officeName: string;
  row: Row;
  instruments: Instrument[];
  /** A debit for the owed period is still clearing (ACH): outstanding, but money may be on its way. */
  paymentInFlight?: boolean;
}

export interface ScheduledCharge {
  providerId: string;
  officeName: string;
  date: string;
  type: ChargeType;
  plan: OfficeAccessPlan;
  amountCents: number;
  atRisk: boolean;
  riskReasons: Array<PaymentRiskFlag | "past_due" | "restricted" | "setup_incomplete">;
}

export interface OutstandingBalance {
  providerId: string;
  officeName: string;
  state: OfficeAccessState;
  since: string;
  plan: OfficeAccessPlan;
  amountCents: number;
  inFlight: boolean;
}

/**
 * Every charge the office will be asked for inside `[start, end]`, plus the
 * period it already owes (if any). `now` decides what is owed versus future.
 */
export function projectOffice(
  office: OfficeInput,
  prices: Prices,
  window: { start: Date; end: Date },
  now: Date,
): { charges: ScheduledCharge[]; outstanding: OutstandingBalance | null } {
  const { row } = office;
  const empty = { charges: [], outstanding: null };
  if (row.lifetime) return empty;
  const amountCents = accessPriceCents(row, prices);
  // A zero price is a free office: the charger grants the period, nothing is collected.
  if (amountCents <= 0) return empty;
  const anchor = nextChargeDate(row);
  if (!anchor) return empty;
  const state = deriveAccessState(row, now);

  let cursor = anchor;
  let outstanding: OutstandingBalance | null = null;
  if (cursor.getTime() <= now.getTime()) {
    outstanding = {
      providerId: office.providerId, officeName: office.officeName, state,
      since: cursor.toISOString(), plan: row.plan, amountCents,
      inFlight: office.paymentInFlight === true,
    };
    cursor = periodEnd(row.plan, cursor);
  }

  const stateRisk: ScheduledCharge["riskReasons"] =
    state === "past_due" || state === "restricted" ? [state] : !row.setup_completed_at ? ["setup_incomplete"] : [];
  const trialEnd = ms(row.included_period_ends_at);
  const charges: ScheduledCharge[] = [];
  for (let guard = 0; guard < 1000 && cursor.getTime() <= window.end.getTime(); guard += 1) {
    if (cursor.getTime() >= window.start.getTime()) {
      const reasons = [...stateRisk, ...paymentFlagsAt(office.instruments, cursor)];
      charges.push({
        providerId: office.providerId, officeName: office.officeName,
        date: cursor.toISOString(),
        type: trialEnd === cursor.getTime() && (ms(row.paid_through) ?? Number.NEGATIVE_INFINITY) < trialEnd ? "trial_conversion" : "renewal",
        plan: row.plan, amountCents, atRisk: reasons.length > 0, riskReasons: reasons,
      });
    }
    cursor = periodEnd(row.plan, cursor);
  }
  return { charges, outstanding };
}

export interface ForecastPeriod {
  key: string;
  start: string;
  totalCents: number;
  renewalCents: number;
  trialConversionCents: number;
  monthlyCents: number;
  yearlyCents: number;
  atRiskCents: number;
  count: number;
}

/** The bucket a date falls into: the UTC Monday of its week, or its UTC month. */
export function bucketStart(date: Date, bucket: ForecastBucket): Date {
  if (bucket === "month") return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * DAY_MS);
}

function nextBucket(start: Date, bucket: ForecastBucket): Date {
  return bucket === "month"
    ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
    : new Date(start.getTime() + 7 * DAY_MS);
}

export interface Forecast {
  start: string;
  end: string;
  bucket: ForecastBucket;
  charges: ScheduledCharge[];
  periods: ForecastPeriod[];
  totals: {
    totalCents: number;
    renewalCents: number;
    trialConversionCents: number;
    monthlyCents: number;
    yearlyCents: number;
    atRiskCents: number;
    count: number;
  };
  outstanding: { totalCents: number; offices: OutstandingBalance[] };
}

export function buildForecast(
  offices: OfficeInput[],
  prices: Prices,
  window: { start: Date; end: Date },
  bucket: ForecastBucket,
  now: Date,
): Forecast {
  const charges: ScheduledCharge[] = [];
  const outstanding: OutstandingBalance[] = [];
  for (const office of offices) {
    const projected = projectOffice(office, prices, window, now);
    charges.push(...projected.charges);
    if (projected.outstanding) outstanding.push(projected.outstanding);
  }
  charges.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.officeName.localeCompare(b.officeName));
  outstanding.sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.officeName.localeCompare(b.officeName));

  // Every bucket the window touches is listed, empty ones included, so a chart has no gaps.
  const periods = new Map<string, ForecastPeriod>();
  for (let cursor = bucketStart(window.start, bucket); cursor.getTime() <= window.end.getTime(); cursor = nextBucket(cursor, bucket)) {
    const key = cursor.toISOString().slice(0, bucket === "month" ? 7 : 10);
    periods.set(key, {
      key, start: cursor.toISOString().slice(0, 10), totalCents: 0, renewalCents: 0, trialConversionCents: 0,
      monthlyCents: 0, yearlyCents: 0, atRiskCents: 0, count: 0,
    });
  }
  const totals = { totalCents: 0, renewalCents: 0, trialConversionCents: 0, monthlyCents: 0, yearlyCents: 0, atRiskCents: 0, count: 0 };
  for (const charge of charges) {
    const key = bucketStart(new Date(charge.date), bucket).toISOString().slice(0, bucket === "month" ? 7 : 10);
    for (const target of [periods.get(key), totals]) {
      if (!target) continue;
      target.totalCents += charge.amountCents;
      target.count += 1;
      if (charge.type === "trial_conversion") target.trialConversionCents += charge.amountCents;
      else target.renewalCents += charge.amountCents;
      if (charge.plan === "yearly") target.yearlyCents += charge.amountCents;
      else target.monthlyCents += charge.amountCents;
      if (charge.atRisk) target.atRiskCents += charge.amountCents;
    }
  }
  return {
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    bucket,
    charges,
    periods: [...periods.values()],
    totals,
    outstanding: { totalCents: outstanding.reduce((sum, item) => sum + item.amountCents, 0), offices: outstanding },
  };
}

// ── Collected history ───────────────────────────────────────────────────────

export type LedgerEntryType = "charge" | "offline_payment" | "reversal" | "dispute";
export type LedgerOutcome = "succeeded" | "failed" | "processing" | "recorded" | "reversed" | "disputed";

export interface LedgerEntry {
  at: string;
  providerId: string;
  officeName: string;
  type: LedgerEntryType;
  outcome: LedgerOutcome;
  plan: OfficeAccessPlan | null;
  periodStart: string | null;
  periodEnd: string | null;
  slot: OfficeAccessSlot | null;
  methodType: "bank" | "card" | "offline" | null;
  methodLabel: string | null;
  last4: string | null;
  /** Positive money in, negative money taken back, zero for failed / in-flight attempts. */
  netCents: number;
  amountCents: number;
  failureCode: string | null;
  failureMessage: string | null;
}

/** The instrument that occupied `slot` at `at` (removed rows included). */
function instrumentAt(instruments: Instrument[], subscriptionId: string, slot: OfficeAccessSlot, at: string): Instrument | null {
  const t = Date.parse(at);
  const candidates = instruments
    .filter((row) => row.subscription_id === subscriptionId && row.slot === slot && Date.parse(row.created_at) <= t + 60_000)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return candidates.find((row) => !row.removed_at || Date.parse(row.removed_at) > t) ?? candidates[0] ?? null;
}

/**
 * Every access money movement: attempts (by when they settled or failed),
 * reversals of money that had landed, disputes, and offline payments HQ
 * recorded. Rows outside `[start, end)` are dropped.
 */
export function buildAccessLedger(input: {
  attempts: Attempt[];
  /** Older charges a dispute in range may point at; looked up, never listed. */
  extraAttempts?: Attempt[];
  events: AccessEvent[];
  instruments: Instrument[];
  officeNames: Map<string, string>;
  plans: Map<string, OfficeAccessPlan>;
  start: Date;
  end: Date;
}): LedgerEntry[] {
  const name = (providerId: string) => input.officeNames.get(providerId) ?? "Office";
  const method = (attempt: Attempt, at: string) => {
    const instrument = instrumentAt(input.instruments, attempt.subscription_id, attempt.slot, at);
    return {
      methodType: instrument?.kind ?? (attempt.slot === "bank" ? "bank" as const : "card" as const),
      methodLabel: instrument ? (instrument.kind === "bank" ? instrument.bank_name : instrument.brand) : null,
      last4: instrument?.last4 ?? null,
    };
  };
  const entries: LedgerEntry[] = [];
  for (const attempt of input.attempts) {
    const reversed = attempt.status === "failed" && Boolean(attempt.settled_at);
    const at = reversed ? attempt.settled_at! : attempt.status === "succeeded" ? attempt.settled_at ?? attempt.created_at
      : attempt.status === "failed" ? attempt.failed_at ?? attempt.created_at : attempt.created_at;
    const base = {
      providerId: attempt.provider_id, officeName: name(attempt.provider_id), plan: attempt.plan,
      periodStart: attempt.period_start, periodEnd: attempt.period_end, slot: attempt.slot,
      ...method(attempt, attempt.created_at), amountCents: attempt.amount_cents,
    };
    entries.push({
      ...base, at, type: "charge",
      outcome: reversed ? "succeeded" : attempt.status,
      netCents: reversed || attempt.status === "succeeded" ? attempt.amount_cents : 0,
      failureCode: reversed ? null : attempt.failure_code,
      failureMessage: reversed ? null : attempt.failure_message,
    });
    if (reversed) {
      entries.push({
        ...base, at: attempt.failed_at ?? attempt.updated_at ?? attempt.settled_at!, type: "reversal", outcome: "reversed",
        netCents: -attempt.amount_cents, failureCode: attempt.failure_code, failureMessage: attempt.failure_message,
      });
    }
  }
  for (const event of input.events) {
    if (event.event === "offline_payment") {
      const amountCents = centsOf(event.detail.amountCents);
      entries.push({
        at: event.created_at, providerId: event.provider_id, officeName: name(event.provider_id),
        type: "offline_payment", outcome: "recorded", plan: input.plans.get(event.provider_id) ?? null,
        periodStart: null, periodEnd: typeof event.detail.paidThrough === "string" ? event.detail.paidThrough : null,
        slot: null, methodType: "offline", methodLabel: "Offline", last4: null,
        netCents: amountCents, amountCents, failureCode: null, failureMessage: null,
      });
    } else if (event.event === "payment_disputed") {
      const attempt = [...input.attempts, ...(input.extraAttempts ?? [])].find((row) =>
        row.subscription_id === event.subscription_id && row.cycle === Number(event.detail.cycle) && row.slot === event.detail.slot);
      const amountCents = attempt?.amount_cents ?? 0;
      entries.push({
        at: event.created_at, providerId: event.provider_id, officeName: name(event.provider_id),
        type: "dispute", outcome: "disputed", plan: attempt?.plan ?? input.plans.get(event.provider_id) ?? null,
        periodStart: attempt?.period_start ?? null, periodEnd: attempt?.period_end ?? null,
        slot: attempt?.slot ?? (typeof event.detail.slot === "string" ? event.detail.slot as OfficeAccessSlot : null),
        ...(attempt ? method(attempt, attempt.created_at) : { methodType: null, methodLabel: null, last4: null }),
        netCents: -amountCents, amountCents,
        failureCode: typeof event.detail.reason === "string" ? event.detail.reason : null, failureMessage: null,
      });
    }
  }
  const startMs = input.start.getTime();
  const endMs = input.end.getTime();
  return entries
    .filter((entry) => {
      const t = Date.parse(entry.at);
      return t >= startMs && t < endMs;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.officeName.localeCompare(b.officeName));
}

export interface CollectedMonth {
  key: string;
  collectedCents: number;
  offlineCents: number;
  reversedCents: number;
  netCents: number;
  succeededCount: number;
  failedCount: number;
  failedCents: number;
  processingCount: number;
}

export function summarizeLedger(entries: LedgerEntry[], start: Date, end: Date) {
  const months = new Map<string, CollectedMonth>();
  const blank = (key: string): CollectedMonth => ({
    key, collectedCents: 0, offlineCents: 0, reversedCents: 0, netCents: 0,
    succeededCount: 0, failedCount: 0, failedCents: 0, processingCount: 0,
  });
  for (let cursor = bucketStart(start, "month"); cursor.getTime() < end.getTime(); cursor = nextBucket(cursor, "month")) {
    const key = cursor.toISOString().slice(0, 7);
    months.set(key, blank(key));
  }
  const totals = blank("total");
  for (const entry of entries) {
    const key = entry.at.slice(0, 7);
    const month = months.get(key) ?? blank(key);
    months.set(key, month);
    for (const target of [month, totals]) {
      if (entry.type === "charge") {
        if (entry.outcome === "succeeded") { target.collectedCents += entry.amountCents; target.succeededCount += 1; }
        else if (entry.outcome === "failed") { target.failedCount += 1; target.failedCents += entry.amountCents; }
        else if (entry.outcome === "processing") target.processingCount += 1;
      } else if (entry.type === "offline_payment") target.offlineCents += entry.amountCents;
      else target.reversedCents += entry.amountCents;
      target.netCents += entry.netCents;
    }
  }
  return { months: [...months.values()].sort((a, b) => a.key.localeCompare(b.key)), totals };
}
