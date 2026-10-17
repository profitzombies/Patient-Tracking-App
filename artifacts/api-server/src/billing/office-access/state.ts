/**
 * The office access state machine.
 *
 * One office = one access subscription to THINNR. Every route, job and webhook
 * asks this module what the state is; none of them computes it ad hoc, and no
 * client request can set it.
 *
 * The state is *derivable*: `deriveAccessState` recomputes it from the stored
 * dates alone, so a stale `state` column can always be re-checked and repaired
 * rather than silently drifting. `nextAccessState` is the write side: it takes
 * one explicit input (setup completed, owner's first sign-in, period expiry,
 * charge success, charge failure, an HQ action) and returns the column patch
 * that input implies.
 */
import type {
  BillingOfficeAccessSubscriptionRow as Row,
  OfficeAccessPlan,
  OfficeAccessState,
  PaidThroughSource,
} from "../store";

export const ACCESS_STATES: readonly OfficeAccessState[] = [
  "setup_incomplete", "included_period", "paid_current", "past_due", "restricted",
] as const;

/**
 * Which moves the engine is allowed to make. Restriction is only ever reached
 * from `past_due` (the grace window must have run), and any state can be
 * lifted straight back to paid by a confirmed payment.
 */
export const ACCESS_TRANSITIONS: Record<OfficeAccessState, readonly OfficeAccessState[]> = {
  setup_incomplete: ["included_period", "paid_current", "past_due"],
  included_period: ["setup_incomplete", "paid_current", "past_due"],
  paid_current: ["included_period", "past_due"],
  past_due: ["included_period", "paid_current", "restricted"],
  restricted: ["included_period", "paid_current", "past_due"],
};

export function canTransition(from: OfficeAccessState, to: OfficeAccessState): boolean {
  return from === to || ACCESS_TRANSITIONS[from].includes(to);
}

export class AccessTransitionError extends Error {
  constructor(from: OfficeAccessState, to: OfficeAccessState) {
    super(`Illegal office access transition: ${from} → ${to}`);
  }
}

const DAY_MS = 86_400_000;
function ms(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function future(value: string | null, now: Date): boolean {
  const at = ms(value);
  return at !== null && at > now.getTime();
}

/** A "lifetime" office is in its included period forever. */
export function isLifetime(row: Pick<Row, "lifetime">): boolean {
  return row.lifetime === true;
}

/**
 * The state the stored dates justify right now. This is the authority: the
 * `state` column is a cached copy of it that the engine keeps in step.
 */
export function deriveAccessState(
  row: Pick<Row,
    | "lifetime" | "setup_completed_at" | "paid_through" | "included_period_ends_at"
    | "grace_started_at" | "grace_ends_at">,
  now: Date,
): OfficeAccessState {
  if (isLifetime(row)) return "included_period";
  // A confirmed payment outranks everything, including an open grace clock:
  // money that has landed restores access even after a restriction.
  if (future(row.paid_through, now)) return "paid_current";
  if (future(row.included_period_ends_at, now)) return "included_period";
  if (!row.setup_completed_at) return "setup_incomplete";
  if (row.grace_started_at) return future(row.grace_ends_at, now) ? "past_due" : "restricted";
  // Something that was paid for (or included) has lapsed and no failure has
  // been reported yet: past due until the next billing run settles it.
  if (row.paid_through || row.included_period_ends_at) return "past_due";
  // Instruments are on file but no clock has ever started — the owner has not
  // opened the dashboard yet. Nothing is owed, so nothing is overdue.
  return "setup_incomplete";
}

/** Whether patient payments should be taken at the restricted revenue share. */
export function accessIsRestricted(row: Parameters<typeof deriveAccessState>[0], now: Date): boolean {
  return deriveAccessState(row, now) === "restricted";
}

// ── Inputs ──────────────────────────────────────────────────────────────────

export type AccessInput =
  /** Bank account and both cards are stored; the office is billable. */
  | { kind: "setup_completed"; at: Date }
  /**
   * The office owner signed in to the provider dashboard for the first time.
   * `anchor` is where the included period runs from when it is not the
   * sign-in itself — a reseller's agreement date — see `includedPeriodAnchor`.
   */
  | { kind: "owner_first_sign_in"; at: Date; includedPeriodDays: number; anchor?: Date }
  /**
   * HQ recorded, changed or cleared the reseller agreement date: the included
   * period is re-anchored to `period` (agreement date, else the owner's first
   * sign-in), or cleared when neither is known so the next owner sign-in
   * starts it. Paid-through coverage is untouched, so it never shortens
   * anything already paid for.
   */
  | { kind: "agreement_anchor"; at: Date; period: { startedAt: Date; endsAt: Date } | null }
  /** Re-check only: the included period or the paid-through date may have lapsed. */
  | { kind: "period_expiry"; at: Date }
  /** A charge for `periodStart..periodEnd` was confirmed. */
  | { kind: "charge_succeeded"; at: Date; periodEnd: Date; source: PaidThroughSource }
  /**
   * Every stored instrument failed. `at` is the FAILURE NOTIFICATION instant,
   * which for an ACH bounce is the day the bounce arrived, not the day the
   * debit was submitted.
   */
  | { kind: "charge_failed"; at: Date; graceDays: number }
  /**
   * A confirmed payment was taken back (an ACH bounce reported after
   * settlement, or a dispute). Access rolls back to where the reversed period
   * began and the recovery clock starts from this notification.
   */
  | { kind: "payment_reversed"; at: Date; periodStart: Date; graceDays: number }
  /** The grace window elapsed with nothing collected. */
  | { kind: "grace_elapsed"; at: Date }
  /** HQ set or changed the included period (or made the office lifetime). */
  | { kind: "hq_included_period"; at: Date; endsAt: Date | null; lifetime: boolean; startedAt?: Date }
  /** HQ recorded that access is paid for through a date, from whatever source. */
  | { kind: "hq_paid_through"; at: Date; paidThrough: Date; source: PaidThroughSource }
  /** HQ changed the plan or the per-office price. */
  | { kind: "hq_terms"; at: Date; plan?: OfficeAccessPlan; priceCentsOverride?: number | null };

export type AccessPatch = Partial<Row>;

export interface AccessDecision {
  state: OfficeAccessState;
  patch: AccessPatch;
}

function iso(date: Date): string {
  return date.toISOString();
}

/**
 * The column patch an input implies, plus the state it lands the office in.
 * Callers persist the patch and record the transition; they never invent one.
 */
export function nextAccessState(row: Row, input: AccessInput, now = input.at): AccessDecision {
  const patch: AccessPatch = {};
  const after = { ...row } as Row;
  const set = <K extends keyof Row>(key: K, value: Row[K]): void => {
    patch[key] = value;
    after[key] = value;
  };

  switch (input.kind) {
    case "setup_completed":
      if (!row.setup_completed_at) set("setup_completed_at", iso(input.at));
      break;
    case "owner_first_sign_in":
      // Exactly once: a second owner sign-in never restarts or extends it.
      if (!row.owner_first_sign_in_at) set("owner_first_sign_in_at", iso(input.at));
      if (!row.included_period_started_at) {
        const period = includedPeriodFrom(input.anchor ?? input.at, input.includedPeriodDays);
        set("included_period_started_at", iso(period.startedAt));
        set("included_period_ends_at", iso(period.endsAt));
      }
      break;
    case "agreement_anchor": {
      // A complimentary office has no period to anchor.
      if (row.lifetime) break;
      const startedAt = input.period ? iso(input.period.startedAt) : null;
      const endsAt = input.period ? iso(input.period.endsAt) : null;
      if (row.included_period_started_at !== startedAt) set("included_period_started_at", startedAt);
      if (row.included_period_ends_at !== endsAt) set("included_period_ends_at", endsAt);
      // A period that now runs into the future is access again, like any HQ
      // grant; one that already elapsed leaves a recovery clock alone.
      if (input.period && input.period.endsAt.getTime() > input.at.getTime() && (row.grace_started_at || row.restricted_at)) {
        set("grace_started_at", null);
        set("grace_ends_at", null);
        set("restricted_at", null);
      }
      break;
    }
    case "period_expiry":
      break;
    case "charge_succeeded":
      set("paid_through", iso(input.periodEnd));
      set("paid_through_source", input.source);
      // A confirmed payment clears the recovery clock and the restriction.
      set("grace_started_at", null);
      set("grace_ends_at", null);
      set("restricted_at", null);
      break;
    case "charge_failed":
      // The clock only starts once per failure run; a later notification for
      // the same unpaid period keeps the original deadline.
      if (!row.grace_started_at) {
        set("grace_started_at", iso(input.at));
        set("grace_ends_at", iso(new Date(input.at.getTime() + input.graceDays * DAY_MS)));
      }
      break;
    case "payment_reversed": {
      const paidThrough = ms(row.paid_through);
      if (paidThrough !== null && paidThrough > input.periodStart.getTime()) {
        set("paid_through", iso(input.periodStart));
      }
      if (!row.grace_started_at) {
        set("grace_started_at", iso(input.at));
        set("grace_ends_at", iso(new Date(input.at.getTime() + input.graceDays * DAY_MS)));
      }
      break;
    }
    case "grace_elapsed":
      if (!row.restricted_at) set("restricted_at", iso(input.at));
      break;
    case "hq_included_period":
      set("lifetime", input.lifetime);
      set("included_period_ends_at", input.lifetime ? null : input.endsAt ? iso(input.endsAt) : null);
      // `startedAt` is how HQ restarts a trial; without it an existing start
      // date stands, so re-editing the end never rewrites history.
      if (input.startedAt) set("included_period_started_at", iso(input.startedAt));
      else if (!row.included_period_started_at && (input.lifetime || input.endsAt)) {
        set("included_period_started_at", iso(input.at));
      }
      if (input.lifetime || (input.endsAt && input.endsAt.getTime() > input.at.getTime())) {
        set("grace_started_at", null);
        set("grace_ends_at", null);
        set("restricted_at", null);
      }
      break;
    case "hq_paid_through":
      set("paid_through", iso(input.paidThrough));
      set("paid_through_source", input.source);
      if (input.paidThrough.getTime() > input.at.getTime()) {
        set("grace_started_at", null);
        set("grace_ends_at", null);
        set("restricted_at", null);
      }
      break;
    case "hq_terms":
      if (input.plan !== undefined) set("plan", input.plan);
      if (input.priceCentsOverride !== undefined) set("price_cents_override", input.priceCentsOverride);
      break;
  }

  const derived = deriveAccessState(after, now);
  // `grace_elapsed` is the only input allowed to produce a restriction, and it
  // only does so because the derived state already agrees the window closed.
  if (derived === "restricted" && input.kind !== "grace_elapsed" && !row.restricted_at) {
    return { state: row.state, patch };
  }
  if (!canTransition(row.state, derived)) throw new AccessTransitionError(row.state, derived);
  if (derived !== row.state) set("state", derived);
  return { state: derived, patch };
}

// ── Periods and pricing ─────────────────────────────────────────────────────

/** The included period that runs from `anchor` for `days` days. */
export function includedPeriodFrom(anchor: Date, days: number): { startedAt: Date; endsAt: Date } {
  return { startedAt: anchor, endsAt: new Date(anchor.getTime() + days * DAY_MS) };
}

/** A calendar date (`YYYY-MM-DD`) as the UTC midnight that starts it; null for anything else. */
export function agreementDateAt(signedOn: string | null | undefined): Date | null {
  if (!signedOn || !/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) return null;
  const at = new Date(`${signedOn}T00:00:00.000Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === signedOn ? at : null;
}

/**
 * Where an office's included period runs from. A THINNR reseller's period is
 * anchored to the day it signed its reseller agreement when HQ recorded one
 * (leadership expects billing 12 months after the agreement, however long the
 * owner takes to first sign in); otherwise, and for every software-only
 * office, it runs from the owner's first dashboard sign-in. Null until either
 * is known — the next owner sign-in then starts it.
 */
export function includedPeriodAnchor(input: {
  officeKind: "reseller" | "software";
  resellerAgreementSignedOn: string | null | undefined;
  ownerFirstSignInAt: string | null | undefined;
}): Date | null {
  const agreement = input.officeKind === "reseller" ? agreementDateAt(input.resellerAgreementSignedOn) : null;
  if (agreement) return agreement;
  const signedIn = ms(input.ownerFirstSignInAt ?? null);
  return signedIn === null ? null : new Date(signedIn);
}

/** The end of a billing period that starts at `from`. */
export function periodEnd(plan: OfficeAccessPlan, from: Date): Date {
  const end = new Date(from.getTime());
  if (plan === "yearly") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

/**
 * Where the office's current coverage runs out: the LATER of the paid-through
 * date and the included period's end. The two can disagree — HQ (or a
 * corrected reseller agreement date) may extend the included period past a
 * period that was already paid for — and charging must wait for both, exactly
 * as `deriveAccessState` treats either future date as access. Null when no
 * clock has started.
 */
export function coverageEndsAt(row: Pick<Row, "paid_through" | "included_period_ends_at">): Date | null {
  const paid = ms(row.paid_through);
  const included = ms(row.included_period_ends_at);
  if (paid === null && included === null) return null;
  return new Date(Math.max(paid ?? Number.NEGATIVE_INFINITY, included ?? Number.NEGATIVE_INFINITY));
}

/**
 * The period a billing run should collect for: it starts where the office's
 * coverage currently ends (`coverageEndsAt`). Null when the office is not
 * billable yet.
 */
export function dueBillingPeriod(row: Row, now: Date): { start: Date; end: Date } | null {
  if (isLifetime(row) || !row.setup_completed_at) return null;
  const startMs = coverageEndsAt(row)?.getTime() ?? null;
  if (startMs === null) return null;
  if (startMs > now.getTime()) return null;
  const start = new Date(startMs);
  return { start, end: periodEnd(row.plan, start) };
}

/** What this office pays for one period: its override, else the HQ list price. */
export function accessPriceCents(
  row: Pick<Row, "plan" | "price_cents_override">,
  prices: { monthlyPriceCents: number; yearlyPriceCents: number },
): number {
  if (row.price_cents_override !== null && row.price_cents_override !== undefined) return row.price_cents_override;
  return row.plan === "yearly" ? prices.yearlyPriceCents : prices.monthlyPriceCents;
}
