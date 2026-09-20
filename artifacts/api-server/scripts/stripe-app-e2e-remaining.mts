/**
 * Genuine TEST-only follow-on checks. Uses the existing fixture and its guards.
 * No webhook replay: status assertions wait for actual Stripe delivery.
 * Cleanup is deliberately durable: failure leaves state for explicit retry.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getStripe, connectedOpts } from "../src/billing/stripe-client";
import { runWithBillingIdentity } from "../src/billing/stripe-environment";
import { insert, selectMany, selectOne, update } from "../src/billing/store";
import { refundOrder } from "../src/billing/orders";
import { cancelSubscription } from "../src/billing/subscriptions";

process.env.STRIPE_APP_E2E_IMPORT_ONLY = "1";
const { guard, create, confirm, waitOrder } = await import("./stripe-app-e2e-run.mts");
const state = JSON.parse(readFileSync(resolve("../../.local/state/stripe-app-e2e.json"), "utf8"));
const evidencePath = resolve("../../.local/state/stripe-app-e2e-remaining.json");
const evidence: Record<string, any> = { started_at: new Date().toISOString(), checks: {}, cleanup: {} };
const save = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
const scoped = <T,>(work: () => Promise<T>) => runWithBillingIdentity(state.identity, work);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const query = `provider_id=eq.${encodeURIComponent(state.provider_id)}`;
await guard();
const stripe = await getStripe("test");
const opts = connectedOpts(state.account_id);
const cleanupOnly = process.argv.includes("--cleanup-only");
let clockId: string | undefined = cleanupOnly ? JSON.parse(readFileSync(evidencePath, "utf8")).clock_id : undefined;
async function wait<T>(label: string, work: () => Promise<T | false>, timeout = 160_000): Promise<T> {
  const end = Date.now() + timeout;
  do {
    const result = await work();
    if (result) return result;
    await sleep(2500);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
async function advance(time: number) {
  await stripe.testHelpers.testClocks.advance(clockId!, { frozen_time: time }, opts);
  await wait("test clock ready", async () => (await stripe.testHelpers.testClocks.retrieve(clockId!, {}, opts)).status === "ready");
}
async function feeCheck(order: any) {
  const charge = await stripe.charges.retrieve(order.stripe_charge_id, { expand: ["balance_transaction"] }, opts);
  const bt = charge.balance_transaction as any;
  if (!bt || typeof bt === "string") throw new Error("Charge balance transaction unavailable");
  const stripeFee = bt.fee_details.filter((f: any) => f.type === "stripe_fee").reduce((n: number, f: any) => n + f.amount, 0);
  const appFee = order.application_fee_collected_cents ?? order.application_fee_cents;
  const feeId = typeof charge.application_fee === "string" ? charge.application_fee : charge.application_fee?.id;
  const actualFee = feeId ? await stripe.applicationFees.retrieve(feeId) : null;
  const actualAppFee = actualFee ? actualFee.amount - actualFee.amount_refunded : 0;
  return {
    total: order.total_cents, app_fee: appFee, stripe_fee: order.stripe_fee_cents,
    stripe_fee_actual: stripeFee, app_fee_actual: actualAppFee, net: order.office_net_cents,
    pass: appFee === actualAppFee && order.stripe_fee_cents === stripeFee && order.office_net_cents === order.total_cents - actualAppFee - stripeFee,
  };
}
try {
  if (!cleanupOnly) {
  // Same link request twice models double-submit/lost initialization response;
  // do not confirm either intent, so an unsafe duplicate cannot double-charge.
  const [duplicateA, duplicateB] = await Promise.all([create("one_time"), create("one_time")]);
  evidence.checks.public_link_duplicate_submit = {
    same_order: duplicateA.body.order_id === duplicateB.body.order_id,
    same_intent: duplicateA.body.client_secret.split("_secret_")[0] === duplicateB.body.client_secret.split("_secret_")[0],
    charged: false,
    scope: "public payment link, not authenticated patient cart",
  };
  const authentication = await create("one_time");
  const challenge = await confirm(authentication.body.client_secret, "pm_card_threeDSecure2Required");
  evidence.checks.authentication_required = {
    status: challenge.status, next_action: challenge.next_action?.type,
    pass: challenge.status === "requires_action", challenge_completion: "requires browser; not verified",
  };
  save();

  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: state.provider_id }, opts);
  clockId = clock.id;
  evidence.clock_id = clockId;
  save();
  const customer = await stripe.customers.create({ test_clock: clockId, name: "Synthetic Stripe Verification", metadata: { e2e_provider: state.provider_id } }, opts);
  await scoped(() => insert("billing_payers", {
    provider_id: state.provider_id, patient_id: null, name: "Synthetic Stripe Verification",
    email: "stripe-app-e2e@example.invalid", phone: null, stripe_customer_id: customer.id,
  }));
  const subscription = await create("subscription");
  await confirm(subscription.body.client_secret, "pm_card_visa");
  const initial = await waitOrder(subscription.body.order_id, ["paid"]);
  evidence.checks.initial_fee_net = await feeCheck(initial);
  const sub = await scoped(() => selectOne("billing_subscriptions", `id=eq.${initial.subscription_id}`));
  if (!sub) throw new Error("Subscription row unavailable");
  let remote = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, {}, opts);
  let periodEnd = (remote.items.data[0] as any).current_period_end;
  await advance(periodEnd + 1);
  // Automatic finalization waits an hour after invoice.created acknowledgement.
  await sleep(5000);
  await advance(periodEnd + 7200);
  const renewal = await wait("scheduled renewal projected paid", async () => {
    const rows = await scoped(() => selectMany("billing_orders", `${query}&kind=eq.subscription_renewal&status=eq.paid`));
    return rows[0] ?? false;
  });
  evidence.checks.scheduled_renewal = { pass: true, kind: renewal.kind, fee_net: await feeCheck(renewal) };
  save();
  const declined = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: customer.id }, opts);
  await stripe.subscriptions.update(remote.id, { default_payment_method: declined.id }, opts);
  remote = await stripe.subscriptions.retrieve(remote.id, {}, opts);
  periodEnd = (remote.items.data[0] as any).current_period_end;
  await advance(periodEnd + 1);
  await sleep(5000);
  await advance(periodEnd + 7200);
  const failed = await wait("failed renewal projected", async () => {
    const row = await scoped(() => selectOne("billing_subscriptions", `id=eq.${sub.id}`));
    return row?.status === "past_due" ? row : false;
  });
  evidence.checks.failed_renewal = { pass: true, status: failed.status };
  const good = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id }, opts);
  await stripe.subscriptions.update(remote.id, { default_payment_method: good.id }, opts);
  remote = await stripe.subscriptions.retrieve(remote.id, {}, opts);
  const invoiceId = typeof remote.latest_invoice === "string" ? remote.latest_invoice : remote.latest_invoice!.id;
  await stripe.invoices.pay(invoiceId, {}, connectedOpts(state.account_id, `e2e-recover:${invoiceId}`));
  const recovered = await wait("recovered renewal projected", async () => {
    const order = await scoped(() => selectOne("billing_orders", `${query}&stripe_invoice_id=eq.${invoiceId}&status=eq.paid`));
    return order ?? false;
  });
  evidence.checks.renewal_recovery = { pass: true, fee_net: await feeCheck(recovered) };
  }
} catch (error) {
  evidence.error = (error as Error).message.replace(/\b(?:sk|pk)_(?:test|live)_\S+|\bwhsec_\S+|pi_\S+_secret_\S+/g, "[redacted]");
  process.exitCode = 1;
} finally {
  try {
    // Never delete local financial records until remote money/subscriptions have
    // been unwound. Stripe's immutable test history remains intentional evidence.
    for (const sub of await scoped(() => selectMany("billing_subscriptions", query))) {
      if (sub.status !== "canceled") await scoped(() => cancelSubscription(sub.id, { at_period_end: false }));
    }
    for (const order of await scoped(() => selectMany("billing_orders", query))) {
      if (["paid", "partially_refunded"].includes(order.status)) {
        if (order.stripe_payment_intent_id) await scoped(() => refundOrder(order.id, { reason: "Synthetic launch verification cleanup" }, null));
        else if (order.stripe_charge_id) {
          // Preserve the app defect in evidence, but still unwind TEST money.
          const charge = await stripe.charges.retrieve(order.stripe_charge_id, {}, opts);
          if (charge.livemode) throw new Error("Refusing live cleanup charge");
          if (!charge.refunded) await stripe.refunds.create({ charge: charge.id }, connectedOpts(state.account_id, `e2e-cleanup:${charge.id}`));
          evidence.cleanup.direct_refund_required = true;
        }
      }
      if (order.stripe_payment_intent_id) {
        const pi = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id, {}, opts);
        if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(pi.status)) {
          // Invoice-owned intents cannot be canceled directly: void the invoice.
          if (order.stripe_invoice_id) {
            const inv = await stripe.invoices.retrieve(order.stripe_invoice_id, {}, opts);
            if (inv.status === "open") await stripe.invoices.voidInvoice(inv.id, {}, opts);
          } else await stripe.paymentIntents.cancel(pi.id, {}, opts);
        }
      }
    }
    if (clockId) await stripe.testHelpers.testClocks.del(clockId, {}, opts);
    evidence.cleanup.remote = "subscriptions canceled, paid app orders refunded, pending invoices voided, clock deleted";
    evidence.cleanup.email_claims = (await scoped(() => selectMany("billing_customer_emails", query))).length;
    evidence.cleanup.warehouse = (await scoped(() => selectMany("billing_warehouse_submissions", query))).map(row => ({ state: row.state, reason: row.skipped_reason }));
  } catch (error) {
    evidence.cleanup.error = (error as Error).message;
    process.exitCode = 1;
  }
  evidence.finished_at = new Date().toISOString();
  save();
  console.log(JSON.stringify(evidence, null, 2));
}