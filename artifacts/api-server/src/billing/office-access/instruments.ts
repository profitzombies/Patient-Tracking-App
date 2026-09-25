/**
 * The payment instruments an office keeps on file with THINNR: one bank
 * account (ACH debit, charged first) and two distinct credit cards.
 *
 * These live on THINNR's OWN platform Stripe account — a customer per office —
 * not on the office's connected account. The connected account is where
 * patients pay the office; this is where the office pays us.
 */
import type Stripe from "stripe";
import { logger } from "../../lib/logger";
import { getStripe, isStripeMissing } from "../stripe-client";
import { currentBillingIdentity } from "../stripe-environment";
import { insert, selectMany, selectOne, update, type BillingOfficeAccessInstrumentRow as Instrument, type BillingOfficeAccessSubscriptionRow as Row, type OfficeAccessSlot } from "../store";
import { accessCustomerFields, defaultBillingDetails, loadOfficeIdentity, type OfficeIdentityFacts } from "./customer-identity";
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

/**
 * Every instrument row not yet removed: the three in service plus, while a
 * replacement bank waits on test deposits, that staged bank beside them.
 */
export async function listInstrumentRows(subscriptionId: string): Promise<Instrument[]> {
  return selectMany("billing_office_access_instruments", `subscription_id=eq.${q(subscriptionId)}&removed_at=is.null`);
}

/** The instruments in service — one per slot. A staged replacement is not one of them. */
export async function listAccessInstruments(subscriptionId: string): Promise<Instrument[]> {
  return (await listInstrumentRows(subscriptionId)).filter((row) => !row.staged_at);
}

/** The instruments the waterfall may actually try, in order. */
export function chargeableInstruments(instruments: Instrument[]): Instrument[] {
  const bySlot = new Map(instruments.filter((row) => !row.removed_at && !row.staged_at).map((row) => [row.slot, row]));
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
 * two customers holding one instrument each. It is created already carrying
 * the practice's name, owner, contact details and address, so HQ recognizes
 * it in Stripe instead of seeing "Unnamed customer".
 */
export async function ensureAccessCustomer(row: Row): Promise<string> {
  if (row.stripe_customer_id) return row.stripe_customer_id;
  const mode = currentBillingIdentity()?.mode ?? null;
  const facts = await loadOfficeIdentity(row.provider_id);
  const fields = facts
    ? accessCustomerFields(facts, mode)
    : { metadata: { thinnr_provider_id: row.provider_id, thinnr_purpose: "office_access", ...(mode ? { thinnr_payment_mode: mode } : {}) } };
  const stripe = await getStripe();
  const customer = await stripe.customers.create(
    fields,
    { idempotencyKey: `office-access-customer:v2:${row.id}` },
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

/**
 * Make sure the saved card or bank carries a holder name and email. The form
 * pre-fills both from the practice; a method collected without them (an older
 * client, a wallet that withheld them) is filled in from the same defaults.
 * Returns the name that ends up on the method.
 */
export async function ensureBillingDetails(
  stripe: Stripe,
  method: Stripe.PaymentMethod,
  facts: OfficeIdentityFacts | null,
  /** Stripe only updates attached methods; an unattached one keeps what the form sent. */
  attached = true,
): Promise<string | null> {
  const current = method.billing_details ?? ({} as Stripe.PaymentMethod.BillingDetails);
  const defaults = defaultBillingDetails(facts);
  const name = current.name?.trim() || defaults.name;
  const email = current.email?.trim() || defaults.email;
  const patch: Stripe.PaymentMethodUpdateParams.BillingDetails = {};
  if (name && name !== current.name) patch.name = name;
  if (email && email !== current.email) patch.email = email;
  if (attached && Object.keys(patch).length) await stripe.paymentMethods.update(method.id, { billing_details: patch });
  return name ?? null;
}

/** Stripe's default for the customer follows the primary card. */
async function setDefaultPaymentMethod(stripe: Stripe, customerId: string, paymentMethodId: string): Promise<void> {
  try {
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
  } catch (error) {
    // Charges name their method explicitly, so a missed default is cosmetic;
    // the next details sync or the back-fill sets it again.
    logger.warn({ err: error, customerId }, "office access: could not set the default payment method");
  }
}

function alreadyDetached(error: unknown): boolean {
  if (isStripeMissing(error)) return true;
  return error instanceof Error && /not attached/i.test(error.message);
}

/**
 * Detach replaced methods from the office's platform customer, so Stripe only
 * ever shows the three in service. THINNR's own history keeps the row.
 *
 * A method is only detached once no debit on its slot is still in flight: the
 * charge engine records a `processing` attempt before it calls Stripe, so a
 * replacement landing mid-charge leaves the old method attached until that
 * charge settles, and the billing job's sweep detaches it afterwards.
 */
export async function retireInstruments(
  subscriptionId: string,
  rows: Instrument[],
): Promise<{ detached: number; deferred: number }> {
  const outcome = { detached: 0, deferred: 0 };
  if (!rows.length) return outcome;
  const inUse = new Set((await listInstrumentRows(subscriptionId)).map((row) => row.stripe_payment_method_id));
  const stripe = await getStripe();
  for (const retired of rows) {
    if (retired.detached_at) continue;
    const stamp = { detached_at: new Date().toISOString() };
    // A bank dropped before its deposits were confirmed is not attached yet;
    // cancelling its SetupIntent stops a late confirmation attaching it.
    if (retired.kind === "bank" && retired.setup_intent_id && retired.verification_status !== "verified") {
      try { await stripe.setupIntents.cancel(retired.setup_intent_id); } catch { /* already settled or gone */ }
    }
    // The same method re-saved into a live row stays attached for that row.
    if (inUse.has(retired.stripe_payment_method_id)) {
      await update("billing_office_access_instruments", `id=eq.${q(retired.id)}`, stamp);
      continue;
    }
    const inFlight = await selectOne(
      "billing_office_access_attempts",
      `subscription_id=eq.${q(subscriptionId)}&slot=eq.${q(retired.slot)}&status=eq.processing`,
    );
    if (inFlight) { outcome.deferred += 1; continue; }
    try {
      await stripe.paymentMethods.detach(retired.stripe_payment_method_id);
    } catch (error) {
      if (!alreadyDetached(error)) {
        logger.warn({ err: error, instrument: retired.id }, "office access: detaching a replaced method failed; the sweep retries");
        outcome.deferred += 1;
        continue;
      }
    }
    await update("billing_office_access_instruments", `id=eq.${q(retired.id)}`, stamp);
    outcome.detached += 1;
  }
  return outcome;
}

/**
 * The browser's SetupIntent already attached the method to the office's
 * customer before THINNR saw it. A method THINNR refuses (a duplicate card,
 * the wrong kind for the slot) is detached again so it does not linger in
 * Stripe beside the three on file. Best effort: the refusal itself stands.
 */
async function discardRefused(stripe: Stripe, method: Stripe.PaymentMethod, customerId: string | null): Promise<void> {
  const owner = typeof method.customer === "string" ? method.customer : method.customer?.id ?? null;
  if (!customerId || owner !== customerId) return;
  try {
    await stripe.paymentMethods.detach(method.id);
  } catch (error) {
    if (!alreadyDetached(error)) logger.warn({ err: error, paymentMethod: method.id }, "office access: could not detach a refused method");
  }
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
 * Every slot is replace-only: a new method takes the old one's place in one
 * step, and nothing ever leaves a slot empty.
 *
 * A second card that is the same *physical* card as the first is refused on
 * Stripe's fingerprint, which survives a re-issued number, a different expiry
 * and a wallet token — last four and expiry would not catch any of those.
 *
 * A replacement bank that still needs test deposits is STAGED beside a
 * verified bank rather than replacing it: the office keeps a debitable bank
 * until the new one verifies (see recordBankVerification), and a failed or
 * expired replacement simply drops away.
 */
export async function attachAccessInstrument(input: AttachInput): Promise<Instrument> {
  const row = await ensureAccessSubscription(input.providerId);
  const stripe = await getStripe();
  const method = await stripe.paymentMethods.retrieve(input.paymentMethodId);
  const kind = method.type === "us_bank_account" ? "bank" : method.type === "card" ? "card" : null;
  if (!kind) {
    await discardRefused(stripe, method, row.stripe_customer_id);
    throw new AccessInstrumentError("That payment method type cannot be used for THINNR access.");
  }
  if ((input.slot === "bank") !== (kind === "bank")) {
    await discardRefused(stripe, method, row.stripe_customer_id);
    throw new AccessInstrumentError(
      input.slot === "bank" ? "The bank slot needs a bank account." : "The card slots need a credit card.",
    );
  }

  const all = await listInstrumentRows(row.id);
  const live = all.filter((other) => !other.staged_at);
  const sameMethod = all.find((other) => other.stripe_payment_method_id === input.paymentMethodId);
  if (sameMethod) {
    // A retried save of the method already in this slot is a no-op.
    if (sameMethod.slot === input.slot) return sameMethod;
    throw new AccessInstrumentError(
      kind === "card" ? DUPLICATE_CARD_MESSAGE : "That bank account is already on file.", 409,
      kind === "card" ? "duplicate_card" : "duplicate_method",
    );
  }
  const fingerprint = kind === "card" ? method.card?.fingerprint ?? null : method.us_bank_account?.fingerprint ?? null;
  if (kind === "card" && fingerprint) {
    const clash = live.find(
      (other) => other.kind === "card" && other.slot !== input.slot && other.fingerprint === fingerprint,
    );
    if (clash) {
      await discardRefused(stripe, method, row.stripe_customer_id);
      throw new AccessInstrumentError(DUPLICATE_CARD_MESSAGE, 409, "duplicate_card");
    }
  }

  const customerId = await ensureAccessCustomer(row);
  let setupIntent: Stripe.SetupIntent | null = null;
  if (input.setupIntentId) setupIntent = await stripe.setupIntents.retrieve(input.setupIntentId);
  const verification = kind === "bank" ? bankVerification(method, setupIntent) : "verified";
  const intentCustomer = typeof setupIntent?.customer === "string" ? setupIntent.customer : setupIntent?.customer?.id ?? null;
  // Stripe refuses to attach a bank account before its test deposits are
  // confirmed; the SetupIntent (made for this customer) attaches it itself
  // the moment they are. Everything else is attached now.
  const awaitingDeposits = kind === "bank" && verification === "pending" && intentCustomer === customerId;
  if (!awaitingDeposits) {
    await stripe.paymentMethods.attach(
      input.paymentMethodId,
      { customer: customerId },
      { idempotencyKey: `office-access-attach:${row.id}:${input.paymentMethodId}` },
    );
  }
  const billingName = await ensureBillingDetails(stripe, method, await loadOfficeIdentity(row.provider_id), !awaitingDeposits);
  const now = new Date();
  const deadline = kind === "bank" && verification === "pending"
    ? new Date(now.getTime() + BANK_VERIFICATION_WINDOW_HOURS * 3_600_000).toISOString()
    : null;

  const replaced = live.find((other) => other.slot === input.slot);
  const priorStaged = all.find((other) => other.slot === input.slot && other.staged_at);
  const stage = kind === "bank" && verification === "pending"
    && replaced?.kind === "bank" && replaced.verification_status === "verified";

  const retired: Instrument[] = [];
  if (priorStaged) {
    // A newer replacement supersedes one still waiting on deposits.
    await update("billing_office_access_instruments", `id=eq.${q(priorStaged.id)}`, { removed_at: now.toISOString() });
    retired.push(priorStaged);
  }
  // Replacing a slot keeps the old row for history.
  if (replaced && !stage) {
    await update("billing_office_access_instruments", `id=eq.${q(replaced.id)}`, { removed_at: now.toISOString() });
    retired.push(replaced);
  }
  let stored: Instrument;
  try {
    stored = await insert("billing_office_access_instruments", {
      subscription_id: row.id,
      provider_id: row.provider_id,
      slot: input.slot,
      kind,
      stripe_payment_method_id: input.paymentMethodId,
      setup_intent_id: input.setupIntentId ?? null,
      fingerprint,
      brand: kind === "card" ? method.card?.brand ?? null : null,
      last4: kind === "card" ? method.card?.last4 ?? null : method.us_bank_account?.last4 ?? null,
      exp_month: kind === "card" ? method.card?.exp_month ?? null : null,
      exp_year: kind === "card" ? method.card?.exp_year ?? null : null,
      bank_name: kind === "bank" ? method.us_bank_account?.bank_name ?? null : null,
      verification_status: verification,
      verification_deadline: deadline,
      staged_at: stage ? now.toISOString() : null,
      replaces_instrument_id: stage ? replaced!.id : null,
      billing_name: billingName,
    });
  } catch (error) {
    // Never leave the slot empty: put the method it was replacing back.
    if (replaced && !stage) {
      await update("billing_office_access_instruments", `id=eq.${q(replaced.id)}`, { removed_at: null });
    }
    throw error;
  }
  await recordAccessEvent({
    row,
    event: stage ? "instrument_replacement_staged" : replaced ? "instrument_replaced" : "instrument_added",
    actor: input.actor ?? SYSTEM_ACTOR,
    detail: { slot: input.slot, kind, verification },
  });
  if (!stage && input.slot === "card_primary") await setDefaultPaymentMethod(stripe, customerId, input.paymentMethodId);
  await retireInstruments(row.id, retired);
  await syncSetupCompletion(row.provider_id, input.actor);
  return stored;
}

/** The staged bank verified: it takes over the slot and the old bank retires. */
async function promoteStagedBank(row: Row, staged: Instrument, actor: AccessActor): Promise<void> {
  const current = (await listAccessInstruments(row.id)).find((other) => other.slot === staged.slot);
  const now = new Date().toISOString();
  if (current) await update("billing_office_access_instruments", `id=eq.${q(current.id)}`, { removed_at: now });
  await update("billing_office_access_instruments", `id=eq.${q(staged.id)}`, {
    staged_at: null, verification_status: "verified", verification_deadline: null,
  });
  await recordAccessEvent({
    row, event: "instrument_replaced", actor,
    detail: { slot: staged.slot, kind: staged.kind, verification: "verified", handover: true },
  });
  if (current) await retireInstruments(row.id, [current]);
}

/** The staged bank failed or ran out of time: it drops away, the old bank stays. */
async function dropStagedBank(row: Row, staged: Instrument, reason: "failed" | "expired", actor: AccessActor): Promise<void> {
  await update("billing_office_access_instruments", `id=eq.${q(staged.id)}`, {
    removed_at: new Date().toISOString(), verification_status: "failed",
  });
  await recordAccessEvent({ row, event: "bank_replacement_dropped", actor, detail: { slot: staged.slot, reason } });
  await retireInstruments(row.id, [staged]);
}

/**
 * Record the outcome of microdeposit verification. With a payment method id
 * it targets exactly that bank; without one it prefers a staged replacement
 * (the one waiting on deposits) over the bank already in service.
 */
export async function recordBankVerification(input: {
  providerId: string;
  verified: boolean;
  paymentMethodId?: string | null;
  actor?: AccessActor;
}): Promise<void> {
  const row = await ensureAccessSubscription(input.providerId);
  const banks = (await listInstrumentRows(row.id)).filter((other) => other.kind === "bank");
  const bank = input.paymentMethodId
    ? banks.find((other) => other.stripe_payment_method_id === input.paymentMethodId)
    : banks.find((other) => other.staged_at) ?? banks.find((other) => !other.staged_at);
  if (!bank) return;
  const actor = input.actor ?? SYSTEM_ACTOR;
  if (bank.staged_at) {
    if (input.verified) await promoteStagedBank(row, bank, actor);
    else await dropStagedBank(row, bank, "failed", actor);
    await syncSetupCompletion(row.provider_id, input.actor);
    return;
  }
  await update("billing_office_access_instruments", `id=eq.${q(bank.id)}`, {
    verification_status: input.verified ? "verified" : "failed",
    verification_deadline: input.verified ? null : bank.verification_deadline,
  });
  await recordAccessEvent({
    row, event: "bank_verification", actor,
    detail: { verified: input.verified },
  });
  await syncSetupCompletion(row.provider_id, input.actor);
}

/** True once a staged replacement bank's deposit window has run out. */
export function stagedExpired(staged: Instrument, now = new Date()): boolean {
  return Boolean(staged.verification_deadline) && Date.parse(staged.verification_deadline!) <= now.getTime();
}

/** Drop staged replacement banks whose deposit window ran out; the old bank stays. */
export async function expireStagedReplacements(row: Row, now = new Date(), known?: Instrument[]): Promise<number> {
  const staged = (known ?? await listInstrumentRows(row.id)).filter((other) => other.staged_at && stagedExpired(other, now));
  for (const item of staged) await dropStagedBank(row, item, "expired", SYSTEM_ACTOR);
  return staged.length;
}

/**
 * Housekeeping the billing job runs for every office: a staged bank past its
 * deposit deadline drops away, and replaced methods whose detach was deferred
 * (a charge was in flight, or Stripe hiccuped) are detached now.
 */
export async function maintainAccessInstruments(
  row: Row,
  now = new Date(),
): Promise<{ expired: number; detached: number; deferred: number }> {
  const expired = await expireStagedReplacements(row, now);
  const pending = (await selectMany(
    "billing_office_access_instruments",
    `subscription_id=eq.${q(row.id)}&detached_at=is.null`,
  )).filter((other) => other.removed_at);
  const outcome = await retireInstruments(row.id, pending);
  return { expired, ...outcome };
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
