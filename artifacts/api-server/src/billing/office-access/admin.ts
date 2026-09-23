/**
 * The HQ-driven operations on an office's access subscription.
 *
 * These are engine functions, not routes: the HQ screens are a separate piece
 * of work and will call them. Every one of them goes through the state machine
 * and leaves both an access-history row and a shared audit record, so nobody
 * can quietly change what an office owes.
 */
import { selectOne, type BillingOfficeAccessSubscriptionRow as Row, type OfficeAccessPlan, type PaidThroughSource } from "../store";
import { loadAccessBillingSettings } from "./settings";
import { accessPriceCents, deriveAccessState } from "./state";
import { applyAccessInput, ensureAccessSubscription, type AccessActor } from "./subscription";

const DAY_MS = 86_400_000;
/** HQ may grant up to three years of included access; lifetime is separate. */
export const MAX_INCLUDED_PERIOD_DAYS = 3 * 365;

export class AccessAdminError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function clampIncludedDays(days: number): number {
  if (!Number.isFinite(days) || days < 0) throw new AccessAdminError("The included period must be a number of days.");
  if (days > MAX_INCLUDED_PERIOD_DAYS) throw new AccessAdminError("The included period cannot exceed three years.");
  return Math.round(days);
}

/** Set (or clear) the included period, or make the office complimentary for life. */
export async function setIncludedPeriod(input: {
  providerId: string;
  actor: AccessActor;
  lifetime?: boolean;
  /** Days from now; omit to leave the end date alone. */
  days?: number;
  endsAt?: Date | null;
  /** Restart the period from now (a trial reset) rather than editing its end. */
  restart?: boolean;
  now?: Date;
}): Promise<Row> {
  const now = input.now ?? new Date();
  const row = await ensureAccessSubscription(input.providerId);
  const lifetime = input.lifetime ?? row.lifetime;
  let endsAt: Date | null = input.endsAt ?? null;
  if (input.days !== undefined) endsAt = new Date(now.getTime() + clampIncludedDays(input.days) * DAY_MS);
  else if (input.endsAt === undefined) endsAt = row.included_period_ends_at ? new Date(row.included_period_ends_at) : null;

  const result = await applyAccessInput({
    row, actor: input.actor, event: input.restart ? "trial_reset" : "hq_included_period",
    input: {
      kind: "hq_included_period", at: now, lifetime, endsAt: lifetime ? null : endsAt,
      ...(input.restart ? { startedAt: now } : {}),
    },
    detail: { lifetime, endsAt: endsAt ? endsAt.toISOString() : null, restart: Boolean(input.restart) },
    auditAction: input.restart ? "office_access_trial_reset" : "office_access_included_period_set",
  });
  return result.row;
}

/** Restart the included period from now for a stated number of days. */
export async function resetTrial(input: {
  providerId: string; actor: AccessActor; days?: number; now?: Date;
}): Promise<Row> {
  const settings = await loadAccessBillingSettings();
  return setIncludedPeriod({
    providerId: input.providerId, actor: input.actor, now: input.now, restart: true, lifetime: false,
    days: input.days ?? settings.includedPeriodDays,
  });
}

/** Override what this office pays per period, or switch its plan. */
export async function setAccessTerms(input: {
  providerId: string;
  actor: AccessActor;
  plan?: OfficeAccessPlan;
  /** Cents per period; null restores the HQ list price. */
  priceCentsOverride?: number | null;
  now?: Date;
}): Promise<Row> {
  if (input.priceCentsOverride !== undefined && input.priceCentsOverride !== null) {
    if (!Number.isInteger(input.priceCentsOverride) || input.priceCentsOverride < 0) {
      throw new AccessAdminError("The price override must be a whole number of cents.");
    }
  }
  const row = await ensureAccessSubscription(input.providerId);
  const result = await applyAccessInput({
    row, actor: input.actor, event: "hq_terms",
    // A plan change takes effect at the next renewal; the current paid-through
    // date is deliberately left alone (no proration).
    input: { kind: "hq_terms", at: input.now ?? new Date(), plan: input.plan, priceCentsOverride: input.priceCentsOverride },
    detail: { plan: input.plan ?? row.plan, priceCentsOverride: input.priceCentsOverride ?? null },
    auditAction: "office_access_terms_set",
  });
  return result.row;
}

/**
 * Record that an office is already paid for through a date — the migration
 * path for offices that were being billed somewhere else. Stripe billing
 * resumes from that date.
 */
export async function recordPaidThrough(input: {
  providerId: string;
  actor: AccessActor;
  paidThrough: Date;
  source: PaidThroughSource;
  note?: string;
  now?: Date;
}): Promise<Row> {
  const now = input.now ?? new Date();
  if (!(input.paidThrough instanceof Date) || Number.isNaN(input.paidThrough.getTime())) {
    throw new AccessAdminError("A paid-through date is required.");
  }
  const row = await ensureAccessSubscription(input.providerId);
  const result = await applyAccessInput({
    row, actor: input.actor, event: "hq_paid_through",
    input: { kind: "hq_paid_through", at: now, paidThrough: input.paidThrough, source: input.source },
    detail: { paidThrough: input.paidThrough.toISOString(), source: input.source, note: input.note ?? null },
    auditAction: "office_access_paid_through_recorded",
  });
  return result.row;
}

/**
 * Record a payment taken outside Stripe (a cheque, a bank transfer, a charge
 * run on another Stripe account). It extends paid-through and clears any
 * restriction, exactly as a successful automatic charge would.
 */
export async function recordOfflinePayment(input: {
  providerId: string;
  actor: AccessActor;
  paidThrough: Date;
  amountCents?: number;
  note?: string;
  now?: Date;
}): Promise<Row> {
  const row = await ensureAccessSubscription(input.providerId);
  const settings = await loadAccessBillingSettings();
  const result = await applyAccessInput({
    row, actor: input.actor, event: "offline_payment",
    input: {
      kind: "charge_succeeded", at: input.now ?? new Date(),
      periodEnd: input.paidThrough, source: "offline",
    },
    detail: {
      paidThrough: input.paidThrough.toISOString(),
      amountCents: input.amountCents ?? accessPriceCents(row, settings),
      note: input.note ?? null,
    },
    auditAction: "office_access_offline_payment_recorded",
  });
  return result.row;
}

export interface AccessSummary {
  providerId: string;
  state: Row["state"];
  plan: OfficeAccessPlan;
  priceCents: number;
  lifetime: boolean;
  includedPeriodEndsAt: string | null;
  paidThrough: string | null;
  paidThroughSource: PaidThroughSource | null;
  graceEndsAt: string | null;
  restrictedAt: string | null;
  setupCompletedAt: string | null;
  bankVerificationDeadline: string | null;
}

/** The engine's read model. Derived fresh, so a stale column cannot mislead. */
export async function accessSummary(providerId: string, now = new Date()): Promise<AccessSummary | null> {
  const row = await selectOne("billing_office_access_subscriptions", `provider_id=eq.${encodeURIComponent(providerId)}`);
  if (!row) return null;
  const settings = await loadAccessBillingSettings();
  return {
    providerId,
    state: deriveAccessState(row, now),
    plan: row.plan,
    priceCents: accessPriceCents(row, settings),
    lifetime: row.lifetime,
    includedPeriodEndsAt: row.included_period_ends_at,
    paidThrough: row.paid_through,
    paidThroughSource: row.paid_through_source,
    graceEndsAt: row.grace_ends_at,
    restrictedAt: row.restricted_at,
    setupCompletedAt: row.setup_completed_at,
    bankVerificationDeadline: row.bank_verification_deadline,
  };
}
