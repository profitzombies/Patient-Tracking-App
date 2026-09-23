import { liveBillingEffectsAllowed } from "./lifecycle-scopes";
import type { EmailTemplateId, EmailVariables } from "@workspace/email-templates";
import { logger } from "../lib/logger";
import { MAX_EMAIL_ATTEMPTS, attemptDelivery, fanOutToContacts } from "./customer-email-ledger";
import { formatReceiptTimestamp } from "./receipts";
import {
  insertIgnore, selectMany, selectOne, update,
  type BillingCustomerEmailRow, type BillingOrderRow, type BillingPayerRow, type BillingShipmentRow, type BillingSubscriptionRow,
} from "./store";
import { getOrderBundle, getProvider, type ProviderSummary } from "./store-orders";

/**
 * Branded shop emails, sent by THINNR from trusted server transitions.
 *
 * Every send goes through `notifyOnce`: a claim row keyed by the transition is
 * inserted BEFORE the message is composed, so replays (webhook redelivery,
 * job re-runs, staff double taps) find the claim and send nothing. The claim
 * row is also the delivery ledger (customer-email-ledger.ts): a failed attempt
 * schedules a retry instead of giving up, and staff resends link back to it.
 * Nothing in here throws: a failed email is logged on the claim row and never
 * blocks the money or state transition that triggered it.
 */

export const RENEWAL_REMINDER_DEFAULT_DAYS = 3;
/** Days before the next shipment the renewal reminder goes out (BILLING_RENEWAL_REMINDER_DAYS). */
export function renewalReminderDays(): number {
  const raw = process.env.BILLING_RENEWAL_REMINDER_DAYS;
  if (raw == null || raw.trim() === "") return RENEWAL_REMINDER_DEFAULT_DAYS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 14 ? Math.floor(parsed) : RENEWAL_REMINDER_DEFAULT_DAYS;
}

/** Where the patient app lives (the mobile app's web build); links degrade to none when unknown. */
export function patientAppOrigin(): string | null {
  const configured = process.env.PATIENT_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const expo = process.env.REPLIT_EXPO_DEV_DOMAIN?.trim();
  return expo ? `https://${expo}` : null;
}
/** Deep links into the patient app's subscription screen; `skip` pre-selects the skip action. */
export function subscriptionLinks(subscriptionId: string): { manage: string; skip: string } {
  const origin = patientAppOrigin();
  if (!origin) return { manage: "", skip: "" };
  // The patient app's Billing screen (app/billing.tsx) reads ?subscription=
  // to focus that plan and ?action=skip to open the skip confirmation.
  const manage = `${origin}/billing?subscription=${encodeURIComponent(subscriptionId)}`;
  return { manage, skip: `${manage}&action=skip` };
}

export const money = (cents: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
/** "Monday, October 12, 2026" in the billing time zone. */
export function formatShipmentDate(iso: string | null | undefined): string {
  if (!iso) return "your next renewal";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "your next renewal";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(date);
}
export function formatShipTo(address: Record<string, unknown> | null | undefined): string {
  const a = (address ?? {}) as Record<string, string | null | undefined>;
  const cityLine = [a.city, [a.state, a.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [a.name, a.line1, a.line2, cityLine, a.country].filter(Boolean).join(", ") || "No shipping address on file";
}
export function cardLabel(method: any): string {
  const brand = String(method?.card?.brand ?? "").trim();
  const last4 = String(method?.card?.last4 ?? "").trim();
  const pretty = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "Card";
  return last4 ? `${pretty} ending in ${last4}` : "your card on file";
}
export const planLabel = (productName: string, quantity: number | null | undefined, weeks: number | null | undefined): string =>
  `${productName}${(quantity ?? 1) > 1 ? ` × ${quantity}` : ""} every ${weeks ?? 4} weeks`;
const firstName = (payer: BillingPayerRow): string => (payer.name ?? "").trim().split(/\s+/)[0] ?? "";
const officeLabel = (office: ProviderSummary | null): string => office?.office_name || office?.provider_name || "your provider office";

export type NotifyOutcome = "sent" | "retrying" | "duplicate" | "skipped" | "failed";
interface NotifyRefs { provider_id?: string | null; subscription_id?: string | null; order_id?: string | null }

/**
 * Claims `dedupeKey` and, if this call won the claim, composes and delivers
 * the email through the ledger: the first attempt happens here, further
 * attempts (up to MAX_EMAIL_ATTEMPTS) are driven by the retry job. The payer's
 * additional contacts receive their own linked copies for order and shipment
 * notices. `compose` may return null to record a deliberate skip (no address,
 * missing rows). Never throws.
 */
export async function notifyOnce(
  dedupeKey: string, templateId: EmailTemplateId, refs: NotifyRefs,
  compose: () => Promise<{ to: string | null; variables: EmailVariables } | null>,
): Promise<NotifyOutcome> {
  if (!liveBillingEffectsAllowed()) return "skipped";
  let claimId: string | null = null;
  try {
    // A live request must not accidentally deliver a notification for a test row.
    const source = refs.order_id
      ? await selectOne("billing_orders", `id=eq.${encodeURIComponent(refs.order_id)}`)
      : refs.subscription_id
        ? await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(refs.subscription_id)}`) : null;
    if (!source || source.livemode !== true) return "skipped";
    const claim = await insertIgnore("billing_customer_emails", {
      dedupe_key: dedupeKey, template_id: templateId, provider_id: refs.provider_id ?? null, payer_id: source.payer_id ?? null,
      subscription_id: refs.subscription_id ?? null, order_id: refs.order_id ?? null, status: "claimed", kind: "automatic",
      attempts: 0, max_attempts: MAX_EMAIL_ATTEMPTS, attempt_log: [],
    }, "billing_customer_emails_dedupe_key_unique");
    if (!claim) return "duplicate";
    claimId = claim.id;
    const message = await compose();
    if (!message || !message.to) {
      await update("billing_customer_emails", `id=eq.${encodeURIComponent(claimId)}`, { status: "skipped", error: message ? "no email address" : "nothing to send" });
      return "skipped";
    }
    const recipient = message.to.trim().toLowerCase();
    const variables = { ...message.variables } as Record<string, string>;
    const composed = await update("billing_customer_emails", `id=eq.${encodeURIComponent(claimId)}`, { recipient, variables });
    const primary: BillingCustomerEmailRow = { ...claim, ...(composed ?? {}), recipient, variables };
    const outcome = await attemptDelivery(primary);
    await fanOutToContacts(primary);
    return outcome;
  } catch (error) {
    logger.error({ err: error, templateId, dedupeKey }, "customer email failed");
    if (claimId) {
      await update("billing_customer_emails", `id=eq.${encodeURIComponent(claimId)}`, {
        status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      }).catch(() => undefined);
    }
    return "failed";
  }
}

/** Payer, product name, and office for a subscription; null when the payer row is gone. */
export async function subscriptionContext(sub: BillingSubscriptionRow): Promise<{ payer: BillingPayerRow; productName: string; office: ProviderSummary | null } | null> {
  const [payer, product, office] = await Promise.all([
    selectOne("billing_payers", `id=eq.${encodeURIComponent(sub.payer_id)}`),
    selectOne("billing_products", `id=eq.${encodeURIComponent(sub.product_id)}`),
    getProvider(sub.provider_id).catch(() => null),
  ]);
  if (!payer) return null;
  return { payer, productName: product?.name ?? "your subscription", office };
}
const base = (ctx: { payer: BillingPayerRow; productName: string; office: ProviderSummary | null }, sub: BillingSubscriptionRow): EmailVariables => ({
  name: firstName(ctx.payer), productName: ctx.productName, officeName: officeLabel(ctx.office), manageLink: subscriptionLinks(sub.id).manage,
});
const subRefs = (sub: BillingSubscriptionRow): NotifyRefs => ({ provider_id: sub.provider_id, subscription_id: sub.id });

/** Subscription lifecycle events raised by patient or staff actions. */
export type SubscriptionEvent =
  | { kind: "moved"; previous: string | null }
  | { kind: "skipped"; skipped: string | null }
  | { kind: "paused" }
  | { kind: "resumed" }
  | { kind: "plan-changed"; previousPlan: string; newPlan: string }
  | { kind: "address-changed" }
  | { kind: "card-updated"; paymentMethod: any }
  | { kind: "cancelled" };

export async function notifySubscriptionEvent(sub: BillingSubscriptionRow, event: SubscriptionEvent): Promise<NotifyOutcome> {
  const stamp = event.kind === "paused" ? sub.paused_at ?? sub.updated_at
    : event.kind === "cancelled" ? sub.canceled_at ?? "period-end"
    : event.kind === "moved" || event.kind === "skipped" ? sub.next_shipment_at ?? sub.updated_at
    : event.kind === "card-updated" ? String(event.paymentMethod?.id ?? sub.updated_at)
    : sub.updated_at;
  const template: EmailTemplateId = event.kind === "moved" ? "subscription-shipment-moved"
    : event.kind === "skipped" ? "subscription-shipment-skipped"
    : event.kind === "paused" ? "subscription-paused"
    : event.kind === "resumed" ? "subscription-resumed"
    : event.kind === "plan-changed" ? "subscription-plan-changed"
    : event.kind === "address-changed" ? "subscription-address-changed"
    : event.kind === "cancelled" ? "subscription-cancelled"
    : "subscription-card-updated";
  return notifyOnce(`${event.kind}:${sub.id}:${stamp ?? "now"}`, template, subRefs(sub), async () => {
    const ctx = await subscriptionContext(sub);
    if (!ctx) return null;
    const next = formatShipmentDate(sub.next_shipment_at ?? sub.current_period_end);
    const extra: EmailVariables = event.kind === "moved" ? { previousDate: formatShipmentDate(event.previous), nextShipment: next }
      : event.kind === "skipped" ? { skippedDate: formatShipmentDate(event.skipped), nextShipment: next }
      : event.kind === "resumed" ? { nextShipment: next }
      : event.kind === "plan-changed" ? { previousPlan: event.previousPlan, newPlan: event.newPlan, effective: next }
      : event.kind === "address-changed" ? { shipTo: formatShipTo(sub.shipping_address) }
      : event.kind === "card-updated" ? { cardLabel: cardLabel(event.paymentMethod) }
      : {};
    return { to: ctx.payer.email, variables: { ...base(ctx, sub), ...extra } };
  });
}

/** First payment of a new subscription landed (webhook or reconcile outcome). */
export async function notifySubscriptionStarted(sub: BillingSubscriptionRow): Promise<NotifyOutcome> {
  return notifyOnce(`started:${sub.id}`, "subscription-started", subRefs(sub), async () => {
    const ctx = await subscriptionContext(sub);
    if (!ctx) return null;
    return {
      to: ctx.payer.email,
      variables: {
        ...base(ctx, sub), cadence: `every ${sub.cadence_weeks ?? 4} weeks`,
        amount: money(sub.unit_price_cents * (sub.quantity ?? 1) + sub.shipping_charge_cents),
        nextShipment: formatShipmentDate(sub.next_shipment_at ?? sub.current_period_end), shipTo: formatShipTo(sub.shipping_address),
      },
    };
  });
}

/** Renewal reminder for one upcoming shipment; keyed on the shipment date so a moved date earns a fresh reminder. */
export async function notifyRenewalReminder(sub: BillingSubscriptionRow, paymentMethod: any): Promise<NotifyOutcome> {
  const when = sub.next_shipment_at ?? sub.current_period_end;
  if (!when) return "skipped";
  return notifyOnce(`renewal-reminder:${sub.id}:${when}`, "subscription-renewal-reminder", subRefs(sub), async () => {
    const ctx = await subscriptionContext(sub);
    if (!ctx) return null;
    const links = subscriptionLinks(sub.id);
    if (!links.manage) throw new Error("patient app origin is not configured");
    return {
      to: ctx.payer.email,
      variables: {
        ...base(ctx, sub), nextShipment: formatShipmentDate(when),
        amount: money(sub.unit_price_cents * (sub.quantity ?? 1) + sub.shipping_charge_cents),
        cardLabel: cardLabel(paymentMethod), skipLink: links.skip, manageLink: links.manage,
      },
    };
  });
}

/**
 * Cart-level confirmation: fires once, when the last order of an in-app cart
 * settles. Orders outside a cart (payment links, renewals) keep the receipt only.
 */
export async function notifyOrderConfirmationIfCartComplete(order: BillingOrderRow): Promise<NotifyOutcome> {
  const cartId = order.cart_id;
  if (!cartId) return "skipped";
  const orders = await selectMany("billing_orders", `cart_id=eq.${encodeURIComponent(cartId)}&order=created_at.asc`).catch(() => [] as BillingOrderRow[]);
  if (!orders.length || orders.some((row) => row.status === "pending")) return "skipped";
  const paid = orders.filter((row) => row.status === "paid");
  if (!paid.length) return "skipped";
  return notifyOnce(`order-confirmation:cart:${cartId}`, "order-confirmation", { provider_id: order.provider_id, order_id: order.id }, async () => {
    const bundles = (await Promise.all(paid.map((row) => getOrderBundle(row.id).catch(() => null)))).filter((b): b is NonNullable<typeof b> => Boolean(b));
    if (!bundles.length) return null;
    const subs = await Promise.all(paid.map((row) => row.subscription_id
      ? selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(row.subscription_id)}`).catch(() => null) : Promise.resolve(null)));
    const items: string[] = [];
    const subscriptions: string[] = [];
    for (const bundle of bundles) {
      const sub = subs[paid.findIndex((row) => row.id === bundle.order.id)] ?? null;
      for (const item of bundle.items) {
        const amount = money(item.unit_price_cents * item.quantity);
        if (sub) subscriptions.push(`${planLabel(item.product_name_snapshot, item.quantity, sub.cadence_weeks)} · ${amount}`);
        else items.push(`${item.product_name_snapshot}${item.quantity > 1 ? ` × ${item.quantity}` : ""} · ${amount}`);
      }
    }
    const first = bundles[0];
    const firstSub = subs.find(Boolean) ?? null;
    return {
      to: first.payer.email,
      variables: {
        name: firstName(first.payer), officeName: officeLabel(first.office),
        placedAt: formatReceiptTimestamp(first.order.paid_at ?? first.order.created_at),
        orderNumbers: bundles.map((b) => b.order.order_number).join(", "),
        items: items.join("\n"), subscriptions: subscriptions.join("\n"),
        total: money(paid.reduce((sum, row) => sum + row.total_cents, 0)),
        shipTo: formatShipTo(first.order.shipping_address as Record<string, unknown>),
        manageLink: firstSub ? subscriptionLinks(firstSub.id).manage : "",
        contactEmail: first.office.email ?? "",
      },
    };
  });
}

/** Shipment status transitions (shipped, delivered) from staff, HQ, or carrier updates. */
export async function notifyShipmentTransition(order: BillingOrderRow, shipment: BillingShipmentRow, previousStatus: string | null): Promise<NotifyOutcome> {
  if (shipment.status === previousStatus) return "skipped";
  if (shipment.status !== "shipped" && shipment.status !== "delivered") return "skipped";
  const stamp = shipment.status === "shipped" ? shipment.shipped_at : shipment.delivered_at;
  const refs: NotifyRefs = { provider_id: order.provider_id, order_id: order.id, subscription_id: order.subscription_id };
  const bundle = async () => getOrderBundle(order.id);
  if (shipment.status === "shipped") {
    return notifyOnce(`shipped:${order.id}:${stamp ?? "now"}`, "order-shipped", refs, async () => {
      const b = await bundle();
      if (!b) return null;
      const tracking = shipment.tracking_number ?? "";
      return {
        to: b.payer.email,
        variables: {
          name: firstName(b.payer), orderNumber: b.order.order_number, officeName: officeLabel(b.office),
          carrier: shipment.carrier ?? "Carrier", trackingNumber: tracking || "Not provided", trackingLink: tracking ? shipment.tracking_url ?? "" : "",
        },
      };
    });
  }
  return notifyOnce(`delivered:${order.id}:${stamp ?? "now"}`, "order-delivered", refs, async () => {
    const b = await bundle();
    if (!b) return null;
    return {
      to: b.payer.email,
      variables: {
        name: firstName(b.payer), orderNumber: b.order.order_number, officeName: officeLabel(b.office),
        deliveredAt: formatReceiptTimestamp(shipment.delivered_at), contactEmail: b.office.email ?? "",
      },
    };
  });
}
