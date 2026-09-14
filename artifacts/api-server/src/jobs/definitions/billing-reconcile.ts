import type Stripe from "stripe";
import { markOrderPaidFromInvoice } from "../../billing/orders";
import { mirrorPayout } from "../../billing/payouts";
import { connectedOpts, getStripe } from "../../billing/stripe-client";
import { selectMany, selectOne, update } from "../../billing/store";
import { processStripeEvent } from "../../billing/webhook-processing";
import { dispatchStripeEvent } from "../../billing/webhooks";
import { registerBillingWebhookHandlers } from "../../billing/webhook-handlers";
import type { JobContext, JobDefinition } from "../types";

const MINUTE_MS = 60_000;
const DAY_SECONDS = 86_400;
function pendingMinutes(): number {
  const raw = process.env.BILLING_RECONCILE_PENDING_MINUTES;
  if (raw == null || raw.trim() === "") return 60;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
}
function context(account: string, livemode: boolean, expectedSubscriptionUpdatedAt?: string) {
  return { kind: "connect" as const, account, livemode, expectedSubscriptionUpdatedAt };
}

async function reconcilePending(ctx: JobContext, stripe: Stripe): Promise<void> {
  const cutoff = new Date(ctx.now.getTime() - pendingMinutes() * MINUTE_MS).toISOString();
  let cursor = "";
  for (;;) {
    ctx.checkpoint();
    const rows = await selectMany("billing_orders",
      `status=eq.pending&created_at=lt.${encodeURIComponent(cutoff)}${cursor ? `&created_at=gt.${encodeURIComponent(cursor)}` : ""}&order=created_at.asc&limit=100`);
    if (!rows.length) break;
    if (ctx.dryRun) {
      ctx.tally("pendingDue", rows.length);
    } else {
      for (const order of rows) {
        ctx.tally("pendingScanned");
        try {
          const account = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(order.provider_id)}`);
          if (!account) throw new Error("Connected account not found.");
          let invoice: any = null;
          let paymentIntent: any = null;
          if (order.stripe_invoice_id) {
            invoice = await stripe.invoices.retrieve(order.stripe_invoice_id, {}, connectedOpts(account.stripe_account_id));
          } else if (order.stripe_payment_intent_id) {
            paymentIntent = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id, {}, connectedOpts(account.stripe_account_id));
          } else {
            throw new Error("Order has no Stripe invoice or payment intent.");
          }
          const stripeStatus = invoice?.status ?? paymentIntent?.status ?? "unknown";
          if (invoice?.status === "paid" || paymentIntent?.status === "succeeded") {
            const paidInvoice = invoice ?? {
              id: `reconcile:${paymentIntent.id}`, metadata: { thinnr_order_id: order.id },
              payment_intent: paymentIntent.id, amount_paid: paymentIntent.amount_received,
            };
            if (order.kind === "subscription_renewal" || order.kind === "subscription_initial") {
              const event = { id: `reconcile:${order.id}`, type: "invoice.paid", account: account.stripe_account_id,
                livemode: order.livemode, data: { object: paidInvoice } } as unknown as Stripe.Event;
              await dispatchStripeEvent(event, context(account.stripe_account_id, order.livemode));
            } else {
              await markOrderPaidFromInvoice(paidInvoice, context(account.stripe_account_id, order.livemode));
            }
            ctx.tally("pendingPaid");
          } else if (invoice?.status === "void" || invoice?.status === "uncollectible" || paymentIntent?.status === "canceled") {
            await update("billing_orders", `id=eq.${encodeURIComponent(order.id)}&status=eq.pending`, {
              status: "canceled", canceled_reason: `reconciled:${stripeStatus}`,
            });
            ctx.tally("pendingCanceled");
          } else if (ctx.now.getTime() - Date.parse(order.created_at) > 24 * 60 * MINUTE_MS) {
            await update("billing_orders", `id=eq.${encodeURIComponent(order.id)}&status=eq.pending`, { status: "failed" });
            ctx.tally("pendingFailed");
          } else {
            ctx.tally("pendingStillOpen");
          }
        } catch (error) {
          ctx.failItem(`order:${order.id}`, error);
        }
      }
    }
    cursor = rows[rows.length - 1].created_at;
    if (rows.length < 100) break;
  }
}

async function reconcileSubscriptions(ctx: JobContext, stripe: Stripe): Promise<void> {
  const cutoff = new Date(ctx.now.getTime() - 6 * 60 * MINUTE_MS).toISOString();
  const rows = await selectMany("billing_subscriptions",
    `status=neq.canceled&updated_at=lt.${encodeURIComponent(cutoff)}&order=updated_at.asc&limit=500`);
  for (const row of rows) {
    ctx.checkpoint();
    try {
      if (!row.stripe_subscription_id) throw new Error("Subscription has no Stripe id.");
      const account = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(row.provider_id)}`);
      if (!account) throw new Error("Connected account not found.");
      const value: any = await stripe.subscriptions.retrieve(row.stripe_subscription_id, {}, connectedOpts(account.stripe_account_id));
      const before = `${row.status}:${row.current_period_end}:${row.cancel_at_period_end}`;
      await dispatchStripeEvent({ id: `reconcile:${row.id}`, type: "customer.subscription.updated",
        account: account.stripe_account_id, livemode: row.livemode, data: { object: value } } as unknown as Stripe.Event,
       context(account.stripe_account_id, row.livemode, row.updated_at));
      const period = value.current_period_end ?? value.items?.data?.[0]?.current_period_end;
      const after = `${value.status}:${period ? new Date(period * 1000).toISOString() : null}:${Boolean(value.cancel_at_period_end)}`;
      ctx.tally("subscriptionsSynced");
      if (before !== after) ctx.tally("subscriptionsChanged");
    } catch (error) {
      ctx.failItem(`subscription:${row.id}`, error);
    }
  }
}

async function replayWebhooks(ctx: JobContext): Promise<void> {
  const cutoff = new Date(ctx.now.getTime() - 10 * MINUTE_MS).toISOString();
  const claimCutoff = new Date(ctx.now.getTime() - 5 * MINUTE_MS).toISOString();
  const rows = await selectMany("billing_webhook_events",
    `processed_at=is.null&received_at=lt.${encodeURIComponent(cutoff)}&or=(claimed_at.is.null,claimed_at.lt.${encodeURIComponent(claimCutoff)})&order=received_at.asc&limit=200`);
  for (const row of rows) {
    ctx.checkpoint();
    const attempts = Number((row as any).retry_count ?? 0);
    if (attempts > 10) { ctx.tally("replayGivenUp"); continue; }
    try {
      const result = await processStripeEvent(row.payload as unknown as Stripe.Event, row.kind as "platform" | "connect");
      if (result === "processed" || result === "duplicate") ctx.tally("replayed");
    } catch (error) {
      await update("billing_webhook_events", `stripe_event_id=eq.${encodeURIComponent(row.stripe_event_id)}`, {
        retry_count: attempts + 1,
      } as any).catch(() => undefined);
      ctx.tally("replayFailed");
      ctx.failItem(`webhook:${row.stripe_event_id}`, error);
    }
  }
}

async function syncPayouts(ctx: JobContext, stripe: Stripe): Promise<void> {
  const accounts = await selectMany("billing_connected_accounts", "payouts_enabled=eq.true&disconnected_at=is.null");
  for (const account of accounts) {
    ctx.checkpoint();
    try {
      const newest = await selectOne("billing_payouts",
        `provider_id=eq.${encodeURIComponent(account.provider_id)}&order=created_at.desc`);
      const firstRun = Math.floor((ctx.now.getTime() - 90 * DAY_SECONDS * 1000) / 1000);
      const overlap = newest ? Math.floor(Date.parse(newest.created_at) / 1000) - 2 * DAY_SECONDS : firstRun;
      const payouts = await stripe.payouts.list({ created: { gte: overlap }, limit: 100 }, connectedOpts(account.stripe_account_id));
      for (const payout of payouts.data) {
        ctx.tally("payoutsSeen");
        if (await mirrorPayout(account.provider_id, payout)) ctx.tally("payoutsUpserted");
      }
    } catch (error) {
      ctx.failItem(`payouts:${account.provider_id}`, error);
    }
  }
}

export async function reconcileBilling(ctx: JobContext): Promise<void> {
  const stripe = await getStripe();
  await registerBillingWebhookHandlers();
  await reconcilePending(ctx, stripe);
  if (ctx.dryRun) return;
  await reconcileSubscriptions(ctx, stripe);
  await replayWebhooks(ctx);
  await syncPayouts(ctx, stripe);
}

export const billingReconcileJob: JobDefinition = {
  name: "billing-reconcile",
  title: "Billing reconciliation",
  description: "Repairs stale orders, subscriptions, webhooks, and connected-account payouts from Stripe.",
  intervalMs: 30 * MINUTE_MS,
  leaseSeconds: 20 * 60,
  run: reconcileBilling,
};