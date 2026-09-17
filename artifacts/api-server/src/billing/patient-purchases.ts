import { listCards } from "./cards";
import { list, orderDto, paidStatuses, subscriptionDto } from "./patient-dtos";
import { shipmentsForOrders } from "./shipments";
import { selectMany, selectOne, type BillingOrderItemRow, type BillingOrderRow, type BillingRefundRow } from "./store";
import type { PatientPaymentProblem, PatientPurchasesCard, PatientPurchasesSummary } from "./types";

const enc = encodeURIComponent;
/** Orders returned in full (items + shipment); totals still count every order. */
export const RECENT_ORDER_LIMIT = 10;
const ACTIVE_STATUSES = new Set(["active", "past_due", "unpaid"]);

/**
 * True when the patient has a subscription staff would call "active": the
 * roster signal and the summary count share this one definition so a row
 * flagged on the roster always shows a matching subscription on the record.
 * Past-due and unpaid subscriptions still count (Stripe keeps them open
 * while dunning); canceled and never-started ones do not.
 */
export function isActiveSubscriptionStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

/** Patient ids in the office with at least one active subscription (roster signal). */
export async function activeSubscriptionPatientIds(providerId: string): Promise<Set<string>> {
  const rows = await selectMany("billing_subscriptions",
    `provider_id=eq.${enc(providerId)}&status=in.(${[...ACTIVE_STATUSES].join(",")})&select=patient_id,status`);
  return new Set(rows.map((row) => row.patient_id).filter((id): id is string => typeof id === "string" && id.length > 0));
}

/**
 * Card on file, read only: the payer's Stripe customer is never created here
 * and any Stripe failure degrades to "unknown" so the rest of the panel still
 * renders.
 */
async function savedCard(patientId: string, providerId: string): Promise<PatientPurchasesCard> {
  const none: PatientPurchasesCard = { state: "none", brand: null, last4: null, exp_month: null, exp_year: null };
  const [payer, account] = await Promise.all([
    selectOne("billing_payers", `patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(providerId)}`),
    selectOne("billing_connected_accounts", `provider_id=eq.${enc(providerId)}&disconnected_at=is.null`),
  ]);
  if (!payer?.stripe_customer_id || !account) return none;
  try {
    const cards = await listCards(payer.stripe_customer_id, account);
    const card = cards.cards.find((row) => row.is_default) ?? cards.cards[0];
    if (!card) return none;
    return { state: "on_file", brand: card.brand, last4: card.last4, exp_month: card.exp_month, exp_year: card.exp_year };
  } catch {
    return { state: "unknown", brand: null, last4: null, exp_month: null, exp_year: null };
  }
}

/**
 * Per-patient purchases at ONE office. Both filters are always applied: a
 * patient moved between practices never shows the prior office's activity to
 * the new one, and a patient id from another office simply has no rows here
 * (the route turns that into 404 after checking the roster).
 */
export async function loadPatientPurchases(patientId: string, providerId: string): Promise<PatientPurchasesSummary> {
  const [loadedOrders, loadedSubscriptions, card] = await Promise.all([
    selectMany("billing_orders", `patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(providerId)}&order=created_at.desc,id.desc`),
    selectMany("billing_subscriptions", `patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(providerId)}&order=created_at.desc`),
    savedCard(patientId, providerId),
  ]);
  // Newest first regardless of how the rows arrived: the recent slice below
  // must be the latest orders, never the first N the store happened to return.
  const orders = [...loadedOrders].sort(newestFirst);
  const subscriptions = [...loadedSubscriptions].sort(newestFirst);
  const recent = orders.slice(0, RECENT_ORDER_LIMIT);
  const allOrderIds = orders.map((row) => row.id);
  const recentIds = recent.map((row) => row.id);
  const productIds = [...new Set(subscriptions.map((row) => row.product_id))];
  const [loadedItems, loadedRefunds, products, shipments] = await Promise.all([
    recentIds.length ? selectMany("billing_order_items", `order_id=${list(recentIds)}`) : [],
    allOrderIds.length ? selectMany("billing_refunds", `order_id=${list(allOrderIds)}&status=eq.succeeded`) : [],
    productIds.length ? selectMany("billing_products", `id=${list(productIds)}`) : [],
    shipmentsForOrders(recentIds),
  ]);
  const items = loadedItems as BillingOrderItemRow[];
  const refunds = loadedRefunds as BillingRefundRow[];
  const productsById = new Map(products.map((row) => [row.id, row.name]));

  const paidOrders = orders.filter((row) => paidStatuses.has(row.status));
  const lifetimePaid = paidOrders.reduce((sum, row) => sum + row.total_cents, 0);
  const lifetimeRefunded = refunds.reduce((sum, row) => sum + row.amount_cents, 0);
  const lastPaidAt = paidOrders.map((row) => row.paid_at ?? row.created_at).sort().at(-1) ?? null;

  return {
    patient_id: patientId,
    subscriptions: subscriptions.map((row) => subscriptionDto(row, productsById.get(row.product_id) ?? "Subscription")),
    orders: recent.map((order) => orderDto(
      order, items.filter((item) => item.order_id === order.id),
      refunds.filter((refund) => refund.order_id === order.id), shipments.get(order.id) ?? null,
    )),
    totals: {
      order_count: orders.length,
      lifetime_paid_cents: lifetimePaid,
      lifetime_refunded_cents: lifetimeRefunded,
      lifetime_net_cents: lifetimePaid - lifetimeRefunded,
      last_paid_at: lastPaidAt,
      active_subscription_count: subscriptions.filter((row) => isActiveSubscriptionStatus(row.status)).length,
    },
    saved_card: card,
    last_payment_problem: lastPaymentProblem(orders, subscriptions),
  };
}

function newestFirst(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  return b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
}

/** Subscription statuses Stripe keeps open while it retries a failed renewal. */
const DUNNING_STATUSES = new Set(["past_due", "unpaid"]);

/**
 * Newest failed charge across renewals and one-off orders. A renewal failure
 * is only "current" while the subscription is still dunning (status past_due
 * or unpaid): a paid retry flips the status back to active and a cancellation
 * flips it to canceled without clearing the historical failure fields, so the
 * status, not the failure count, decides whether the problem is still live.
 */
function lastPaymentProblem(
  orders: BillingOrderRow[],
  subscriptions: Array<{ id: string; status: string; last_payment_failed_at: string | null; last_failure_message: string | null; last_hosted_invoice_url: string | null }>,
): PatientPaymentProblem | null {
  const candidates: PatientPaymentProblem[] = [];
  for (const row of subscriptions) {
    if (!row.last_payment_failed_at || !DUNNING_STATUSES.has(row.status)) continue;
    candidates.push({
      source: "subscription", subscription_id: row.id, order_id: null, order_number: null,
      at: row.last_payment_failed_at, message: row.last_failure_message, hosted_invoice_url: row.last_hosted_invoice_url,
    });
  }
  for (const row of orders) {
    if (row.status !== "failed") continue;
    candidates.push({
      source: "order", subscription_id: row.subscription_id, order_id: row.id, order_number: row.order_number,
      // Checkout and the renewal webhook both persist the decline in failure_message.
      at: row.updated_at ?? row.created_at, message: row.failure_message ?? null, hosted_invoice_url: null,
    });
  }
  candidates.sort((a, b) => b.at.localeCompare(a.at));
  return candidates[0] ?? null;
}
