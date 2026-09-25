/**
 * The charge waterfall: bill one office for one period against THINNR's own
 * platform Stripe account.
 *
 * Instruments are tried in a fixed order — bank account (ACH), then the
 * primary card, then the backup card — stopping at the first success. Every
 * attempt is recorded, including the ACH debits that are merely accepted and
 * will not settle for days.
 *
 * Two things keep this safe to call twice for the same period: the
 * `claim_office_access_charge` RPC (which refuses a period that is already
 * paid or has a debit in flight, under a per-subscription advisory lock) and a
 * Stripe idempotency key derived from the period, cycle and slot.
 *
 * Note there is no Stripe Subscription or Invoice object anywhere in here.
 * Charging PaymentIntents directly is what keeps Stripe's own dunning and
 * Smart Retries out of the picture: the recovery schedule in dunning.ts is the
 * only thing that retries.
 */
import type Stripe from "stripe";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { getStripe } from "../stripe-client";
import { insert, update, type BillingOfficeAccessAttemptRow as Attempt, type BillingOfficeAccessSubscriptionRow as Row, type OfficeAccessSlot } from "../store";
import { chargeableInstruments, listAccessInstruments } from "./instruments";
import { loadAccessBillingSettings } from "./settings";
import { accessPriceCents, dueBillingPeriod, isLifetime } from "./state";
import { applyAccessInput, findAccessSubscription, type AccessActor, SYSTEM_ACTOR } from "./subscription";

export type ChargeSkipReason =
  | "lifetime" | "not_setup" | "not_due" | "already_claimed" | "no_instruments" | "zero_price";

export type ChargeOutcome =
  | { status: "skipped"; reason: ChargeSkipReason; row: Row }
  | { status: "succeeded"; row: Row; slot: OfficeAccessSlot; periodEnd: Date; cycle: number }
  /** An ACH debit Stripe accepted; the webhook decides whether it settles. */
  | { status: "processing"; row: Row; slot: OfficeAccessSlot; cycle: number }
  | { status: "failed"; row: Row; cycle: number; tried: OfficeAccessSlot[] };

function q(value: string): string { return encodeURIComponent(value); }

/**
 * Claim a cycle for this period, or nothing when the period is already paid
 * for or a debit is still in flight.
 */
export async function claimChargeCycle(
  subscriptionId: string, periodStart: Date, cycle?: number,
): Promise<number | null> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/claim_office_access_charge", {
    p_subscription_id: subscriptionId,
    p_period_start: periodStart.toISOString(),
    p_cycle: cycle ?? null,
  });
  if (result.status >= 300) throw new Error(`Office access charge claim failed (${result.status}).`);
  const value = typeof result.json === "number" ? result.json : Number(result.json);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function failureOf(error: unknown): { code: string; message: string } {
  const value = error as { code?: unknown; decline_code?: unknown; type?: unknown; message?: unknown };
  const code = typeof value?.decline_code === "string" ? value.decline_code
    : typeof value?.code === "string" ? value.code
    : typeof value?.type === "string" ? value.type
    : "charge_failed";
  const message = typeof value?.message === "string" ? value.message : "The payment could not be completed.";
  return { code, message: message.slice(0, 500) };
}

async function chargeOne(input: {
  stripe: Stripe;
  row: Row;
  customerId: string;
  /**
   * Read only once the `processing` attempt row exists. A replacement saved
   * before that point is charged in place of the method the waterfall first
   * saw; one saved after it finds the attempt and leaves the old method
   * attached until this charge settles (see retireInstruments).
   */
  resolvePaymentMethod: () => Promise<string>;
  slot: OfficeAccessSlot;
  amountCents: number;
  period: { start: Date; end: Date };
  cycle: number;
}): Promise<{ attempt: Attempt; intent: Stripe.PaymentIntent | null; failure: { code: string; message: string } | null }> {
  // Recorded before Stripe is called: a crash mid-flight leaves a `processing`
  // row, which the claim RPC treats as "do not submit another debit".
  const attempt = await insert("billing_office_access_attempts", {
    subscription_id: input.row.id,
    provider_id: input.row.provider_id,
    period_start: input.period.start.toISOString(),
    period_end: input.period.end.toISOString(),
    cycle: input.cycle,
    slot: input.slot,
    plan: input.row.plan,
    amount_cents: input.amountCents,
    status: "processing",
  });
  const paymentMethodId = await input.resolvePaymentMethod();
  const idempotencyKey = `office-access:${input.row.id}:${input.period.start.toISOString()}:${input.cycle}:${input.slot}`;
  try {
    const intent = await input.stripe.paymentIntents.create({
      amount: input.amountCents,
      currency: "usd",
      customer: input.customerId,
      payment_method: paymentMethodId,
      payment_method_types: [input.slot === "bank" ? "us_bank_account" : "card"],
      confirm: true,
      off_session: true,
      description: `THINNR access (${input.row.plan})`,
      metadata: {
        thinnr_purpose: "office_access",
        thinnr_provider_id: input.row.provider_id,
        thinnr_subscription_id: input.row.id,
        thinnr_attempt_id: attempt.id,
        thinnr_period_start: input.period.start.toISOString(),
        thinnr_period_end: input.period.end.toISOString(),
        thinnr_cycle: String(input.cycle),
      },
    }, { idempotencyKey });
    const patch: Partial<Attempt> = { stripe_payment_intent_id: intent.id };
    if (intent.status === "succeeded") {
      patch.status = "succeeded";
      patch.settled_at = new Date().toISOString();
    } else if (intent.status === "processing") {
      patch.status = "processing";
    } else {
      patch.status = "failed";
      patch.failed_at = new Date().toISOString();
      patch.failure_code = intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code ?? intent.status;
      patch.failure_message = intent.last_payment_error?.message?.slice(0, 500) ?? "The payment was not completed.";
    }
    const saved = await update("billing_office_access_attempts", `id=eq.${q(attempt.id)}`, patch);
    return {
      attempt: saved ?? { ...attempt, ...patch },
      intent,
      failure: patch.status === "failed" ? { code: patch.failure_code!, message: patch.failure_message! } : null,
    };
  } catch (error) {
    const failure = failureOf(error);
    const saved = await update("billing_office_access_attempts", `id=eq.${q(attempt.id)}`, {
      status: "failed", failed_at: new Date().toISOString(),
      failure_code: failure.code, failure_message: failure.message,
      stripe_payment_intent_id: (error as { payment_intent?: { id?: string } })?.payment_intent?.id ?? null,
    });
    return { attempt: saved ?? attempt, intent: null, failure };
  }
}

export interface ChargeInput {
  row: Row;
  /** The period to bill; defaults to the one the subscription is due for. */
  period?: { start: Date; end: Date };
  /** A specific dunning cycle; defaults to the next unused one. */
  cycle?: number;
  /** Instruments to pass over — a bank account that just bounced, typically. */
  skipSlots?: readonly OfficeAccessSlot[];
  actor?: AccessActor;
  now?: Date;
}

/**
 * Bill one office for one period, walking the waterfall. Safe to call twice.
 */
export async function chargeAccessPeriod(input: ChargeInput): Promise<ChargeOutcome> {
  const now = input.now ?? new Date();
  const actor = input.actor ?? SYSTEM_ACTOR;
  let row = input.row;
  if (isLifetime(row)) return { status: "skipped", reason: "lifetime", row };
  if (!row.setup_completed_at) return { status: "skipped", reason: "not_setup", row };

  const period = input.period ?? dueBillingPeriod(row, now);
  if (!period) return { status: "skipped", reason: "not_due", row };

  const settings = await loadAccessBillingSettings();
  const amountCents = accessPriceCents(row, settings);
  if (amountCents <= 0) {
    // A zero price is a free office, not a failed charge: extend access.
    const result = await applyAccessInput({
      row, actor, event: "period_granted",
      input: { kind: "charge_succeeded", at: now, periodEnd: period.end, source: "hq_migration" },
      detail: { amountCents: 0 },
    });
    return { status: "skipped", reason: "zero_price", row: result.row };
  }

  const cycle = await claimChargeCycle(row.id, period.start, input.cycle);
  if (cycle === null) return { status: "skipped", reason: "already_claimed", row };

  const skip = new Set(input.skipSlots ?? []);
  const instruments = chargeableInstruments(await listAccessInstruments(row.id)).filter((row) => !skip.has(row.slot));
  if (!instruments.length) {
    const result = await applyAccessInput({
      row, actor, event: "charge_failed",
      input: { kind: "charge_failed", at: now, graceDays: settings.gracePeriodDays },
      detail: { reason: "no_instruments", cycle },
    });
    return { status: "skipped", reason: "no_instruments", row: result.row };
  }

  const stripe = await getStripe();
  const customerId = row.stripe_customer_id;
  if (!customerId) return { status: "skipped", reason: "not_setup", row };

  const tried: OfficeAccessSlot[] = [];
  await update("billing_office_access_subscriptions", `id=eq.${q(row.id)}`, { last_attempt_at: now.toISOString() });
  for (const instrument of instruments) {
    tried.push(instrument.slot);
    const outcome = await chargeOne({
      stripe, row, customerId, slot: instrument.slot, amountCents, period, cycle,
      resolvePaymentMethod: async () => {
        const current = chargeableInstruments(await listAccessInstruments(row.id)).find((item) => item.slot === instrument.slot);
        return current?.stripe_payment_method_id ?? instrument.stripe_payment_method_id;
      },
    });
    if (outcome.attempt.status === "succeeded") {
      const result = await applyAccessInput({
        row, actor, event: "charge_succeeded",
        input: { kind: "charge_succeeded", at: now, periodEnd: period.end, source: "stripe" },
        detail: { slot: instrument.slot, cycle, amountCents },
      });
      return { status: "succeeded", row: result.row, slot: instrument.slot, periodEnd: period.end, cycle };
    }
    if (outcome.attempt.status === "processing") {
      // An ACH debit is in flight. Do not fall through to the cards: the
      // money may still arrive, and the webhook drives what happens next.
      return { status: "processing", row, slot: instrument.slot, cycle };
    }
  }

  // Everything on file failed. The recovery clock starts now, at the moment we
  // learned about it.
  const result = await applyAccessInput({
    row, actor, event: "charge_failed",
    input: { kind: "charge_failed", at: now, graceDays: settings.gracePeriodDays },
    detail: { cycle, tried: tried.join(",") },
  });
  row = result.row;
  return { status: "failed", row, cycle, tried };
}

/** Convenience wrapper for callers that only hold a provider id. */
export async function chargeOfficeAccess(providerId: string, input: Omit<ChargeInput, "row"> = {}): Promise<ChargeOutcome | null> {
  const row = await findAccessSubscription(providerId);
  return row ? chargeAccessPeriod({ ...input, row }) : null;
}
