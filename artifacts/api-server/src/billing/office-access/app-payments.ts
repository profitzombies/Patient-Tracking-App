/**
 * Loaders for the HQ App payments page and its reports. Every read goes
 * through the billing store, so rows are already scoped to the current
 * Test/Live billing identity (the request's, or an export job's frozen one).
 *
 * Only office-access tables are read here: nothing from patient shop orders,
 * office sales, or the Connect ledger can leak into app revenue.
 */
import { supabaseAdmin } from "../../lib/supabase-admin";
import {
  selectMany,
  type BillingOfficeAccessAttemptRow as Attempt,
  type BillingOfficeAccessEventRow as AccessEvent,
  type BillingOfficeAccessInstrumentRow as Instrument,
  type BillingOfficeAccessSubscriptionRow as Row,
} from "../store";
import {
  buildAccessLedger,
  buildForecast,
  instrumentSummaries,
  lastPayment,
  nextChargeDate,
  paymentFlagsAt,
  summarizeLedger,
  trialDaysLeft,
  type ForecastBucket,
  type InstrumentSummary,
  type LastPayment,
  type OfficeInput,
  type PaymentRiskFlag,
} from "./forecast";
import { loadAccessBillingSettings } from "./settings";
import { accessPriceCents } from "./state";

export interface AccessOffice {
  provider_id: string;
  office_name: string | null;
  provider_name: string | null;
  access_disabled?: boolean | null;
  /** reseller (default) or software; decides which included-period default applies. */
  office_kind?: string | null;
  /** `YYYY-MM-DD` when HQ recorded the reseller agreement; anchors a reseller's included period. */
  reseller_agreement_signed_on?: string | null;
}

/** Live offices (an offboarded office no longer owes for access). */
export async function loadAccessOffices(): Promise<AccessOffice[]> {
  const result = await supabaseAdmin(
    "GET",
    "/rest/v1/providers?select=provider_id,office_name,provider_name,access_disabled,office_kind,reseller_agreement_signed_on&offboarding_status=neq.offboarded&limit=2000",
  );
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`office list failed (${result.status})`);
  return result.json as AccessOffice[];
}

export function accessOfficeLabel(office: Pick<AccessOffice, "office_name" | "provider_name">): string {
  return office.office_name?.trim() || office.provider_name?.trim() || "Office";
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

export interface OfficePaymentFacts {
  instruments: InstrumentSummary[];
  trialDaysLeft: number | null;
  nextChargeCents: number | null;
  lastPayment: LastPayment | null;
  /** Problems that would stop the next charge going through first time. */
  paymentFlags: PaymentRiskFlag[];
}

/**
 * The extra board columns for every office with a subscription row: what is
 * on file, trial countdown, next charge amount, last result, and flags.
 */
export async function loadBoardPaymentFacts(rows: Row[], now: Date): Promise<Map<string, OfficePaymentFacts>> {
  const settings = await loadAccessBillingSettings();
  const [instruments, attempts, offline] = await Promise.all([
    selectMany("billing_office_access_instruments", "removed_at=is.null&limit=10000"),
    // The newest attempts are enough to find each office's latest result.
    selectMany("billing_office_access_attempts", `created_at=gte.${encodeURIComponent(new Date(now.getTime() - 400 * 86_400_000).toISOString())}&order=created_at.desc&limit=10000`),
    selectMany("billing_office_access_events", "event=eq.offline_payment&order=created_at.desc&limit=5000"),
  ]);
  const bySub = groupBy(instruments, (row) => row.subscription_id);
  const attemptsBySub = groupBy(attempts, (row) => row.subscription_id);
  const offlineBySub = groupBy(offline, (row) => row.subscription_id);
  const facts = new Map<string, OfficePaymentFacts>();
  for (const row of rows) {
    const onFile = bySub.get(row.id) ?? [];
    const next = nextChargeDate(row);
    const price = accessPriceCents(row, settings);
    const billable = !row.lifetime && price > 0 && next !== null;
    facts.set(row.provider_id, {
      instruments: instrumentSummaries(onFile),
      trialDaysLeft: trialDaysLeft(row, now),
      nextChargeCents: billable ? price : null,
      lastPayment: lastPayment(attemptsBySub.get(row.id) ?? [], offlineBySub.get(row.id) ?? []),
      // Flags are judged at the next charge date (or now, if that date has passed).
      paymentFlags: billable ? paymentFlagsAt(onFile, new Date(Math.max(next!.getTime(), now.getTime()))) : [],
    });
  }
  return facts;
}

/** Everything a projection needs: every live office with a subscription row. */
export async function loadForecastInputs(): Promise<{ offices: OfficeInput[]; prices: { monthlyPriceCents: number; yearlyPriceCents: number } }> {
  const [list, rows, instruments, processing, settings] = await Promise.all([
    loadAccessOffices(),
    selectMany("billing_office_access_subscriptions", "limit=5000"),
    selectMany("billing_office_access_instruments", "removed_at=is.null&limit=10000"),
    selectMany("billing_office_access_attempts", "status=eq.processing&limit=5000"),
    loadAccessBillingSettings(),
  ]);
  const byProvider = new Map(rows.map((row) => [row.provider_id, row]));
  const bySub = groupBy(instruments, (row) => row.subscription_id);
  const offices: OfficeInput[] = [];
  for (const office of list) {
    const row = byProvider.get(office.provider_id);
    if (!row) continue;
    const anchor = nextChargeDate(row);
    offices.push({
      providerId: office.provider_id,
      officeName: accessOfficeLabel(office),
      row,
      instruments: bySub.get(row.id) ?? [],
      paymentInFlight: anchor !== null && processing.some((attempt) =>
        attempt.subscription_id === row.id && Date.parse(attempt.period_start) === anchor.getTime()),
    });
  }
  return { offices, prices: { monthlyPriceCents: settings.monthlyPriceCents, yearlyPriceCents: settings.yearlyPriceCents } };
}

export async function loadForecast(window: { start: Date; end: Date }, bucket: ForecastBucket, now: Date) {
  const { offices, prices } = await loadForecastInputs();
  return buildForecast(offices, prices, window, bucket, now);
}

/** Days before the range start that an attempt may have been created and still settle inside it (ACH). */
const SETTLE_LOOKBACK_DAYS = 15;

export async function loadAccessLedger(start: Date, end: Date) {
  const from = encodeURIComponent(new Date(start.getTime() - SETTLE_LOOKBACK_DAYS * 86_400_000).toISOString());
  const until = encodeURIComponent(end.toISOString());
  const [list, rows, attempts, events, instruments] = await Promise.all([
    loadAccessOffices(),
    selectMany("billing_office_access_subscriptions", "limit=5000"),
    selectMany("billing_office_access_attempts", `created_at=gte.${from}&created_at=lt.${until}&order=created_at.asc&limit=20000`),
    selectMany("billing_office_access_events",
      `event=in.(offline_payment,payment_disputed)&created_at=gte.${encodeURIComponent(start.toISOString())}&created_at=lt.${until}&order=created_at.asc&limit=20000`),
    // Removed instruments included: an old charge names the card it went to.
    selectMany("billing_office_access_instruments", "limit=20000"),
  ]);
  // A dispute can land months after its charge: fetch those charges too.
  const missing = events.filter((event) => event.event === "payment_disputed" &&
    !attempts.some((row) => row.subscription_id === event.subscription_id && row.cycle === Number(event.detail.cycle) && row.slot === event.detail.slot));
  const extra: Attempt[] = [];
  for (const event of missing) {
    const found = await selectMany("billing_office_access_attempts",
      `subscription_id=eq.${encodeURIComponent(event.subscription_id)}&cycle=eq.${Number(event.detail.cycle) || 0}&slot=eq.${encodeURIComponent(String(event.detail.slot ?? ""))}&limit=5`);
    extra.push(...found);
  }
  const officeNames = new Map(list.map((office) => [office.provider_id, accessOfficeLabel(office)]));
  const plans = new Map(rows.map((row) => [row.provider_id, row.plan]));
  return buildAccessLedger({
    attempts: attempts as Attempt[],
    events: events as AccessEvent[],
    instruments: instruments as Instrument[],
    officeNames, plans, start, end,
    extraAttempts: extra,
  });
}

export async function loadCollected(start: Date, end: Date) {
  const entries = await loadAccessLedger(start, end);
  return { start: start.toISOString(), end: end.toISOString(), ...summarizeLedger(entries, start, end) };
}
