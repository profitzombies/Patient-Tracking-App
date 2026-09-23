/**
 * Platform-account webhook handlers for office access charges.
 *
 * These matter most for ACH: a debit Stripe accepts today can settle — or
 * bounce — days later, and the bounce is the first moment we know the office
 * has not paid. The grace clock therefore starts from the notification we
 * receive here, not from the day the debit was submitted.
 *
 * Only platform events are ours; the offices' connected accounts carry the
 * patient payments, which other handlers own. De-duplication and the claim
 * lease come from the shared webhook processing path.
 */
import type Stripe from "stripe";
import { selectOne, update, type BillingOfficeAccessAttemptRow as Attempt } from "../store";
import { onStripeEvent, type StripeEventContext } from "../webhooks";
import { chargeAccessPeriod } from "./charge";
import { loadAccessBillingSettings } from "./settings";
import { applyAccessInput, findAccessSubscription, type AccessActor } from "./subscription";

const STRIPE_ACTOR: AccessActor = { kind: "stripe", userId: null };

function q(value: string): string { return encodeURIComponent(value); }

function isPlatform(ctx: StripeEventContext): boolean {
  return ctx.account === null;
}

async function attemptForIntent(paymentIntentId: string | null | undefined): Promise<Attempt | null> {
  if (!paymentIntentId) return null;
  return selectOne("billing_office_access_attempts", `stripe_payment_intent_id=eq.${q(paymentIntentId)}`);
}

/** A settlement (usually an ACH debit clearing days after submission). */
async function handleSucceeded(event: Stripe.Event, ctx: StripeEventContext): Promise<void> {
  if (!isPlatform(ctx)) return;
  const intent = event.data.object as Stripe.PaymentIntent;
  const attempt = await attemptForIntent(intent.id);
  if (!attempt || attempt.status === "succeeded") return;
  await update("billing_office_access_attempts", `id=eq.${q(attempt.id)}`, {
    status: "succeeded", settled_at: new Date().toISOString(), failure_code: null, failure_message: null,
  });
  const row = await findAccessSubscription(attempt.provider_id);
  if (!row) return;
  await applyAccessInput({
    row, actor: STRIPE_ACTOR, event: "charge_succeeded",
    input: { kind: "charge_succeeded", at: new Date(), periodEnd: new Date(attempt.period_end), source: "stripe" },
    detail: { slot: attempt.slot, cycle: attempt.cycle, settled: true },
  });
}

/**
 * A failure notification. For a bank debit this commonly arrives days later,
 * so the cards are tried immediately as the next cycle and, if nothing lands,
 * the recovery clock starts here.
 */
async function handleFailed(event: Stripe.Event, ctx: StripeEventContext): Promise<void> {
  if (!isPlatform(ctx)) return;
  const intent = event.data.object as Stripe.PaymentIntent;
  const attempt = await attemptForIntent(intent.id);
  if (!attempt || attempt.status === "failed") return;
  const now = new Date();
  const settled = attempt.status === "succeeded";
  await update("billing_office_access_attempts", `id=eq.${q(attempt.id)}`, {
    status: "failed", failed_at: now.toISOString(),
    failure_code: intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code ?? "payment_failed",
    failure_message: intent.last_payment_error?.message?.slice(0, 500) ?? "The payment failed.",
  });
  const row = await findAccessSubscription(attempt.provider_id);
  if (!row) return;
  const period = { start: new Date(attempt.period_start), end: new Date(attempt.period_end) };

  if (settled) {
    // The money had already been credited and was taken back.
    const settings = await loadAccessBillingSettings();
    const reversed = await applyAccessInput({
      row, actor: STRIPE_ACTOR, event: "payment_reversed",
      input: { kind: "payment_reversed", at: now, periodStart: period.start, graceDays: settings.gracePeriodDays },
      detail: { slot: attempt.slot, cycle: attempt.cycle },
    });
    await chargeAccessPeriod({
      row: reversed.row, period, cycle: attempt.cycle + 1,
      skipSlots: [attempt.slot], actor: STRIPE_ACTOR, now,
    });
    return;
  }

  // Fall through to the remaining instruments right away; a total failure
  // starts the clock from this instant inside chargeAccessPeriod.
  await chargeAccessPeriod({
    row, period, cycle: attempt.cycle + 1, skipSlots: [attempt.slot], actor: STRIPE_ACTOR, now,
  });
}

/** A dispute on a platform-side access charge is treated as non-payment. */
async function handleDispute(event: Stripe.Event, ctx: StripeEventContext): Promise<void> {
  if (!isPlatform(ctx)) return;
  const dispute = event.data.object as Stripe.Dispute;
  const intentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  const attempt = await attemptForIntent(intentId);
  if (!attempt) return;
  const row = await findAccessSubscription(attempt.provider_id);
  if (!row) return;
  const now = new Date();
  const settings = await loadAccessBillingSettings();
  await applyAccessInput({
    row, actor: STRIPE_ACTOR, event: "payment_disputed",
    input: {
      kind: "payment_reversed", at: now,
      periodStart: new Date(attempt.period_start), graceDays: settings.gracePeriodDays,
    },
    detail: { slot: attempt.slot, cycle: attempt.cycle, reason: dispute.reason ?? null },
  });
}

/** Microdeposit verification finishing (or failing) for the stored bank account. */
async function handleSetupIntent(event: Stripe.Event, ctx: StripeEventContext): Promise<void> {
  if (!isPlatform(ctx)) return;
  const intent = event.data.object as Stripe.SetupIntent;
  const paymentMethodId = typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id;
  if (!paymentMethodId) return;
  const instrument = await selectOne(
    "billing_office_access_instruments",
    `stripe_payment_method_id=eq.${q(paymentMethodId)}&removed_at=is.null`,
  );
  if (!instrument || instrument.kind !== "bank") return;
  const { recordBankVerification } = await import("./instruments");
  await recordBankVerification({
    providerId: instrument.provider_id,
    verified: event.type === "setup_intent.succeeded",
    actor: STRIPE_ACTOR,
  });
}

export function registerOfficeAccessWebhookHandlers(): void {
  onStripeEvent("payment_intent.succeeded", handleSucceeded);
  onStripeEvent("payment_intent.payment_failed", handleFailed);
  onStripeEvent("charge.dispute.created", handleDispute);
  onStripeEvent("setup_intent.succeeded", handleSetupIntent);
  onStripeEvent("setup_intent.setup_failed", handleSetupIntent);
}
