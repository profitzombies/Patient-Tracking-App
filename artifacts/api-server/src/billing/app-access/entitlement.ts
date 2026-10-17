/**
 * App access entitlement — the ONE rule that decides whether a patient's
 * premium AI features (coach, photo and menu reads, barcode lookup) are
 * available or locked.
 *
 * Pure: every input is a value, nothing here reads a table or a clock. The
 * patient endpoint, the server-side gate on every premium route and the office
 * roster all call this same function, so the app, the API and the staff
 * screens can never disagree about a patient's state.
 *
 * The rule, in order:
 *   1. THINNR program → free through protocol day 42 of the CURRENT episode
 *      (a provider restart opens a new episode, so a new free window).
 *   2. Any other program → free for the office's trial length, counted in
 *      local days from account activation (default 7 days).
 *   3. Office does not charge → always available.
 *   4. Otherwise → available only while the app-access subscription is
 *      active, or until the end of a period that was already paid for
 *      (cancelled-at-period-end, or a lapse Stripe is still dunning).
 */
import { PROTOCOL_LENGTH_DAYS, programDayBetween } from "@workspace/diet-programs";
import type { AppAccessCadence } from "../store";

export type AppAccessReason =
  /** On the THINNR protocol: free through protocol day 42 of the current episode. */
  | "protocol_window"
  /** On another program: inside the office's free trial. */
  | "trial"
  /** The office does not charge for the app's premium features. */
  | "office_not_charging"
  /** A paid app-access subscription covers today. */
  | "subscribed"
  /** The free window ended and no subscription covers today. */
  | "locked";

/** How the staff screens describe a locked / covered patient in one word. */
export type AppAccessSubscriptionState =
  /** Never started an app-access subscription. */
  | "none"
  | "active"
  /** Stripe is retrying a failed renewal; access holds through the paid period. */
  | "past_due"
  /** Cancelled (or lapsed) — access ends (or ended) with the paid period. */
  | "canceled";

export interface AppAccessOfficeSettings {
  enabled: boolean;
  price_cents: number | null;
  cadence: AppAccessCadence;
  trial_days: number;
}

export interface AppAccessSubscriptionFacts {
  status: string;
  /** ISO instant the current paid period ends (null until the first payment lands). */
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

export interface AppAccessEntitlementInput {
  /** The patient's local calendar day (YYYY-MM-DD), never the server's UTC date. */
  todayKey: string;
  /** The instant "now" for comparing against a paid-through instant. */
  now: Date;
  programId: string | null;
  /** Start of the patient's CURRENT protocol episode (YYYY-MM-DD); null = not on a dated protocol. */
  episodeStartedOn: string | null;
  /** When the account became active (ISO instant); the trial counts from this day in the patient's zone. */
  activatedAt: string | null;
  /** The patient's IANA timezone, used to place `activatedAt` on a local day. */
  timeZone: string | null;
  office: AppAccessOfficeSettings;
  subscription: AppAccessSubscriptionFacts | null;
}

export interface AppAccessEntitlement {
  available: boolean;
  reason: AppAccessReason;
  /**
   * The patient's free window: the THINNR protocol (current episode) or the
   * office's trial, with its last FREE local day (YYYY-MM-DD). Reported even
   * once it has passed so the app can say "your trial ended on …"; null when
   * no window applies (not on a dated protocol / activation unknown).
   */
  free_window: { kind: "protocol" | "trial"; ends_on: string } | null;
  /** Whether the office charges at all (the app hides every upgrade affordance when false). */
  office_charges: boolean;
  price_cents: number | null;
  cadence: AppAccessCadence | null;
  subscription: {
    state: AppAccessSubscriptionState;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
}

export const THINNR_PROGRAM_ID = "thinnr";

/** Subscription statuses that cover today outright (Stripe keeps dunning past-due ones open). */
const COVERING_STATUSES = new Set(["active", "past_due", "unpaid"]);

function addDays(dayKey: string, days: number): string {
  const base = Date.parse(`${dayKey}T00:00:00Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

function isDayKey(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

/** YYYY-MM-DD of an instant in the patient's zone (UTC when the zone is unknown/invalid). */
export function localDayOf(instant: string, timeZone: string | null): string | null {
  const at = new Date(instant);
  if (!Number.isFinite(at.getTime())) return null;
  if (typeof timeZone === "string" && timeZone.trim()) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
    } catch {
      // Unknown zone: UTC below.
    }
  }
  return at.toISOString().slice(0, 10);
}

/** Last free local day of the THINNR protocol window for an episode start, or null off the protocol. */
export function protocolFreeUntil(programId: string | null, episodeStartedOn: string | null): string | null {
  if ((programId ?? THINNR_PROGRAM_ID) !== THINNR_PROGRAM_ID) return null;
  if (!isDayKey(episodeStartedOn)) return null;
  // programDayBetween counts the day N days after the start as day N (the
  // enrollment day itself is day 1), so day 42 is start + 42 days.
  return addDays(episodeStartedOn, PROTOCOL_LENGTH_DAYS);
}

/** Last free local day of a non-THINNR trial; null when the activation moment is unknown. */
export function trialFreeUntil(activatedAt: string | null, timeZone: string | null, trialDays: number): string | null {
  if (!activatedAt) return null;
  const startDay = localDayOf(activatedAt, timeZone);
  if (!startDay) return null;
  const days = Math.max(0, Math.floor(trialDays));
  // A trial of N days covers the activation day plus the next N-1 days;
  // zero days means no free window at all (the activation day is already locked).
  return days === 0 ? addDays(startDay, -1) : addDays(startDay, days - 1);
}

export function subscriptionState(sub: AppAccessSubscriptionFacts | null): AppAccessSubscriptionState {
  if (!sub) return "none";
  if (sub.status === "canceled") return "canceled";
  if (sub.status === "past_due" || sub.status === "unpaid") return "past_due";
  if (sub.status === "active") return "active";
  // 'incomplete' (first payment never landed) covers nothing.
  return "none";
}

/** True while a subscription — in any status — still covers `now`. */
export function subscriptionCovers(sub: AppAccessSubscriptionFacts | null, now: Date): boolean {
  if (!sub) return false;
  if (COVERING_STATUSES.has(sub.status)) return true;
  // Cancelled (or lapsed) subscriptions keep access through the period that
  // was already paid for; after that instant they cover nothing.
  if (sub.status === "canceled" && sub.current_period_end) {
    const end = Date.parse(sub.current_period_end);
    return Number.isFinite(end) && end > now.getTime();
  }
  return false;
}

export function evaluateAppAccess(input: AppAccessEntitlementInput): AppAccessEntitlement {
  const office = input.office;
  const charges = office.enabled && office.price_cents !== null && office.price_cents > 0;
  const price = charges ? office.price_cents : null;
  const cadence = charges ? office.cadence : null;
  const sub = input.subscription;
  const subscription = sub
    ? { state: subscriptionState(sub), current_period_end: sub.current_period_end, cancel_at_period_end: sub.cancel_at_period_end }
    : null;

  const onProtocol = (input.programId ?? THINNR_PROGRAM_ID) === THINNR_PROGRAM_ID;
  let free_window: AppAccessEntitlement["free_window"] = null;
  let insideWindow = false;
  if (onProtocol) {
    const until = protocolFreeUntil(input.programId, input.episodeStartedOn);
    if (until !== null) {
      free_window = { kind: "protocol", ends_on: until };
      // Before the start day the window has not opened yet, but the patient
      // is on a protocol that is about to begin: free, not locked.
      insideWindow = programDayBetween(input.episodeStartedOn, input.todayKey) <= PROTOCOL_LENGTH_DAYS;
    }
  } else {
    const until = trialFreeUntil(input.activatedAt, input.timeZone, office.trial_days);
    if (until !== null) {
      free_window = { kind: "trial", ends_on: until };
      insideWindow = input.todayKey <= until;
    }
  }
  const base = { office_charges: charges, price_cents: price, cadence, subscription, free_window };

  if (insideWindow) {
    return { ...base, available: true, reason: free_window!.kind === "protocol" ? "protocol_window" : "trial" };
  }
  if (!charges) return { ...base, available: true, reason: "office_not_charging" };
  if (subscriptionCovers(sub, input.now)) return { ...base, available: true, reason: "subscribed" };
  return { ...base, available: false, reason: "locked" };
}

/**
 * The one-word state staff screens show for a patient (roster + record):
 * which window or subscription state explains the patient's access today.
 */
export type AppAccessStaffState =
  | "free_protocol" | "free_trial" | "not_charged" | "subscribed" | "canceling" | "past_due" | "lapsed" | "trial_ended" | "locked";

export function staffState(entitlement: AppAccessEntitlement): AppAccessStaffState {
  switch (entitlement.reason) {
    case "protocol_window": return "free_protocol";
    case "trial": return "free_trial";
    case "office_not_charging": return "not_charged";
    case "subscribed":
      if (entitlement.subscription?.state === "past_due") return "past_due";
      if (entitlement.subscription?.state === "canceled" || entitlement.subscription?.cancel_at_period_end) return "canceling";
      return "subscribed";
    case "locked":
      // Lapsed = a subscription once covered the patient; otherwise the free
      // window simply ran out (named "trial ended" for trial patients).
      if (entitlement.subscription && entitlement.subscription.state !== "none") return "lapsed";
      return entitlement.free_window?.kind === "trial" ? "trial_ended" : "locked";
  }
}
