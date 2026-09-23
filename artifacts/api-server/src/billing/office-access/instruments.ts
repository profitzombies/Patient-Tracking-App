/**
 * The payment instruments an office keeps on file with THINNR: one bank
 * account (ACH debit, charged first) and two distinct credit cards.
 *
 * These live on THINNR's OWN platform Stripe account — a customer per office —
 * not on the office's connected account. The connected account is where
 * patients pay the office; this is where the office pays us.
 */
import type Stripe from "stripe";
import { getStripe } from "../stripe-client";
import { insert, selectMany, update, type BillingOfficeAccessInstrumentRow as Instrument, type BillingOfficeAccessSubscriptionRow as Row, type OfficeAccessSlot } from "../store";
import { BANK_VERIFICATION_WINDOW_HOURS } from "./settings";
import { applyAccessInput, ensureAccessSubscription, recordAccessEvent, type AccessActor, SYSTEM_ACTOR } from "./subscription";

/** The order the charge waterfall walks. */
export const WATERFALL_SLOTS: readonly OfficeAccessSlot[] = ["bank", "card_primary", "card_backup"] as const;

export class AccessInstrumentError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) { super(message); }
}

export const DUPLICATE_CARD_MESSAGE =
  "The backup card must be a different card from the primary one.";

function q(value: string): string { return encodeURIComponent(value); }

export async function listAccessInstruments(subscriptionId: string): Promise<Instrument[]> {
  return selectMany("billing_office_access_instruments", `subscription_id=eq.${q(subscriptionId)}&removed_at=is.null`);
}

/** The instruments the waterfall may actually try, in order. */
export function chargeableInstruments(instruments: Instrument[]): Instrument[] {
  const bySlot = new Map(instruments.filter((row) => !row.removed_at).map((row) => [row.slot, row]));
  return WATERFALL_SLOTS.flatMap((slot) => {
    const row = bySlot.get(slot);
    if (!row) return [];
    // An unverified bank account cannot be debited; the cards carry the period.
    if (row.kind === "bank" && row.verification_status !== "verified") return [];
    return [row];
  });
}

/**
 * The office's Stripe customer on the platform account, created once and
 * reused. The customer is keyed by the office so a retried setup cannot leave
 * two customers holding one instrument each.
 */
export async function ensureAccessCustomer(row: Row): Promise<string> {
  if (row.stripe_customer_id) return row.stripe_customer_id;
  const stripe = await getStripe();
  const customer = await stripe.customers.create(
    { metadata: { thinnr_provider_id: row.provider_id, thinnr_purpose: "office_access" } },
    { idempotencyKey: `office-access-customer:${row.id}` },
  );
  const updated = await update(
    "billing_office_access_subscriptions",
    `id=eq.${q(row.id)}&stripe_customer_id=is.null`,
    { stripe_customer_id: customer.id },
  );
  return updated?.stripe_customer_id ?? row.stripe_customer_id ?? customer.id;
}

function bankVerification(
  method: Stripe.PaymentMethod,
  setupIntent: Stripe.SetupIntent | null,
): "verified" | "pending" {
  // Instant (Financial Connections) verification completes the SetupIntent
  // outright; a microdeposit account stays in requires_action until the two
  // amounts come back days later.
  if (setupIntent) return setupIntent.status === "succeeded" ? "verified" : "pending";
  return method.us_bank_account?.financial_connections_account ? "verified" : "pending";
}

export interface AttachInput {
  providerId: string;
  slot: OfficeAccessSlot;
  paymentMethodId: string;
  /** The SetupIntent that collected the instrument; decides bank verification. */
  setupIntentId?: string | null;
  actor?: AccessActor;
}

/**
 * Attach one instrument to the office's platform customer and persist it.
 *
 * A second card that is the same *physical* card as the first is refused on
 * Stripe's fingerprint, which survives a re-issued number, a different expiry
 * and a wallet token — last four and expiry would not catch any of those.
 */
export async function attachAccessInstrument(input: AttachInput): Promise<Instrument> {
  const row = await ensureAccessSubscription(input.providerId);
  const stripe = await getStripe();
  const method = await stripe.paymentMethods.retrieve(input.paymentMethodId);
  const kind = method.type === "us_bank_account" ? "bank" : method.type === "card" ? "card" : null;
  if (!kind) throw new AccessInstrumentError("That payment method type cannot be used for THINNR access.");
  if ((input.slot === "bank") !== (kind === "bank")) {
    throw new AccessInstrumentError(
      input.slot === "bank" ? "The bank slot needs a bank account." : "The card slots need a credit card.",
    );
  }

  const fingerprint = kind === "card" ? method.card?.fingerprint ?? null : method.us_bank_account?.fingerprint ?? null;
  const existing = await listAccessInstruments(row.id);
  if (kind === "card" && fingerprint) {
    const clash = existing.find(
      (other) => other.kind === "card" && other.slot !== input.slot && other.fingerprint === fingerprint,
    );
    if (clash) throw new AccessInstrumentError(DUPLICATE_CARD_MESSAGE, 409, "duplicate_card");
  }

  const customerId = await ensureAccessCustomer(row);
  await stripe.paymentMethods.attach(
    input.paymentMethodId,
    { customer: customerId },
    { idempotencyKey: `office-access-attach:${row.id}:${input.paymentMethodId}` },
  );

  let setupIntent: Stripe.SetupIntent | null = null;
  if (input.setupIntentId) setupIntent = await stripe.setupIntents.retrieve(input.setupIntentId);
  const verification = kind === "bank" ? bankVerification(method, setupIntent) : "verified";
  const now = new Date();
  const deadline = kind === "bank" && verification === "pending"
    ? new Date(now.getTime() + BANK_VERIFICATION_WINDOW_HOURS * 3_600_000).toISOString()
    : null;

  // Replacing a slot keeps the old row for history.
  const replaced = existing.find((other) => other.slot === input.slot);
  if (replaced) {
    await update("billing_office_access_instruments", `id=eq.${q(replaced.id)}`, { removed_at: now.toISOString() });
  }
  const stored = await insert("billing_office_access_instruments", {
    subscription_id: row.id,
    provider_id: row.provider_id,
    slot: input.slot,
    kind,
    stripe_payment_method_id: input.paymentMethodId,
    fingerprint,
    brand: kind === "card" ? method.card?.brand ?? null : null,
    last4: kind === "card" ? method.card?.last4 ?? null : method.us_bank_account?.last4 ?? null,
    exp_month: kind === "card" ? method.card?.exp_month ?? null : null,
    exp_year: kind === "card" ? method.card?.exp_year ?? null : null,
    bank_name: kind === "bank" ? method.us_bank_account?.bank_name ?? null : null,
    verification_status: verification,
    verification_deadline: deadline,
  });
  await recordAccessEvent({
    row, event: replaced ? "instrument_replaced" : "instrument_added", actor: input.actor ?? SYSTEM_ACTOR,
    detail: { slot: input.slot, kind, verification },
  });
  await syncSetupCompletion(row.provider_id, input.actor);
  return stored;
}

/** Record the outcome of microdeposit verification for the stored bank account. */
export async function recordBankVerification(input: {
  providerId: string;
  verified: boolean;
  actor?: AccessActor;
}): Promise<void> {
  const row = await ensureAccessSubscription(input.providerId);
  const bank = (await listAccessInstruments(row.id)).find((other) => other.kind === "bank");
  if (!bank) return;
  await update("billing_office_access_instruments", `id=eq.${q(bank.id)}`, {
    verification_status: input.verified ? "verified" : "failed",
    verification_deadline: input.verified ? null : bank.verification_deadline,
  });
  await recordAccessEvent({
    row, event: "bank_verification", actor: input.actor ?? SYSTEM_ACTOR,
    detail: { verified: input.verified },
  });
  await syncSetupCompletion(row.provider_id, input.actor);
}

export interface AccessSetupStatus {
  complete: boolean;
  missing: OfficeAccessSlot[];
  /** Set while a microdeposit bank account still has to be verified. */
  bankVerificationPending: boolean;
  bankVerificationDeadline: string | null;
  /** True once that 48-hour deadline has passed with the account unverified. */
  bankVerificationOverdue: boolean;
}

/**
 * What the (separate) setup-gate surface needs to know. Setup is complete once
 * all three slots hold an instrument; a bank account awaiting microdeposits
 * does not block completion but does carry a 48-hour deadline.
 */
export function accessSetupStatus(instruments: Instrument[], now = new Date()): AccessSetupStatus {
  const live = instruments.filter((row) => !row.removed_at);
  const missing = WATERFALL_SLOTS.filter((slot) => !live.some((row) => row.slot === slot));
  const bank = live.find((row) => row.kind === "bank");
  const pending = bank?.verification_status === "pending";
  const deadline = pending ? bank?.verification_deadline ?? null : null;
  return {
    complete: missing.length === 0,
    missing,
    bankVerificationPending: pending,
    bankVerificationDeadline: deadline,
    bankVerificationOverdue: Boolean(deadline) && Date.parse(deadline!) <= now.getTime(),
  };
}

/** Stamp setup completion (and the bank deadline) once all three slots exist. */
export async function syncSetupCompletion(providerId: string, actor?: AccessActor): Promise<Row> {
  const row = await ensureAccessSubscription(providerId);
  const status = accessSetupStatus(await listAccessInstruments(row.id));
  if (!status.complete || row.setup_completed_at) return row;
  const now = new Date();
  const result = await applyAccessInput({
    row, input: { kind: "setup_completed", at: now }, actor, event: "setup_completed",
    detail: { bankVerificationPending: status.bankVerificationPending },
  });
  if (status.bankVerificationDeadline && !result.row.bank_verification_deadline) {
    await update("billing_office_access_subscriptions", `id=eq.${q(result.row.id)}`, {
      bank_verification_deadline: status.bankVerificationDeadline,
    });
  }
  return result.row;
}
