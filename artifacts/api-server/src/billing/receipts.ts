import type { EmailTemplateId, EmailVariables } from "@workspace/email-templates";
import { BRANDED_EMAIL_FROM_NAME, brandedFromAddress, EmailNotConfiguredError, sendTemplatedEmail } from "../email/transport";
import { logger } from "../lib/logger";
import { publicOrigin } from "./app-origin";
import { liveBillingEffectsAllowed } from "./lifecycle-scopes";
import type { BillingOrderItemRow, BillingOrderRow, BillingPayerRow, BillingSubscriptionRow } from "./store";
import type { ProviderSummary } from "./store-orders";

/** Display name patients see on every billing email. */
export const BILLING_EMAIL_FROM_NAME = BRANDED_EMAIL_FROM_NAME;
/** Receipt timestamps are rendered in this zone (THINNR's home office). */
export const BILLING_EMAIL_TIME_ZONE = "America/New_York";

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
/** "Sep 14, 2026, 3:24 PM EDT" in the billing time zone. */
export function formatReceiptTimestamp(iso: string | null | undefined, now: Date = new Date()): string {
  const date = iso ? new Date(iso) : now;
  const safe = Number.isNaN(date.getTime()) ? now : date;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BILLING_EMAIL_TIME_ZONE, month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(safe);
}
/**
 * Billing mail goes out as "THINNR Weight Loss <address>", reusing the
 * verified sending address configured for sign-in emails. A bare address
 * or an address that already carries a display name both work.
 */
export function billingFromAddress(configured: string): string {
  return brandedFromAddress(configured);
}
/** Fulfillment never fails on mail: missing configuration warns, vendor errors are logged. */
async function deliver(to: string | null, templateId: EmailTemplateId, variables: EmailVariables): Promise<void> {
  if (!to) return;
  try {
    await sendTemplatedEmail({ to, templateId, variables, sender: "branded" });
  } catch (error) {
    if (error instanceof EmailNotConfiguredError) {
      logger.warn("billing email delivery is not configured");
      return;
    }
    logger.error({ err: error, templateId }, "billing email delivery failed");
  }
}
function firstName(payer: BillingPayerRow): string {
  return (payer.name ?? "").trim().split(/\s+/)[0] ?? "";
}
function officeLabel(office: ProviderSummary): string {
  return office.office_name || office.provider_name || "Your provider";
}

export async function sendReceipt(input: {
  order: BillingOrderRow; items: BillingOrderItemRow[]; payer: BillingPayerRow;
  office: ProviderSummary; subscription?: BillingSubscriptionRow | null;
}): Promise<void> {
  if (!liveBillingEffectsAllowed()) return;
  const { order, items, payer, office, subscription } = input;
  let cancel = "";
  if (subscription) {
    // Building the link needs the public origin; a misconfigured origin must
    // not turn a paid order into a failed webhook, so it degrades to no link.
    try { cancel = `${publicOrigin()}/pay/cancel/${subscription.cancel_token}`; }
    catch (error) { logger.error({ err: error, order: order.id }, "billing receipt could not build the cancel link"); }
  }
  const address = order.shipping_address as Record<string, string | null>;
  const cityLine = [address.city, [address.state, address.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const shipTo = [address.name, address.line1, address.line2, cityLine, address.country].filter(Boolean).join(", ");
  await deliver(payer.email, "order-receipt", {
    name: firstName(payer),
    orderNumber: order.order_number,
    placedAt: formatReceiptTimestamp(order.paid_at ?? order.created_at),
    officeName: officeLabel(office),
    items: items.map((item) => `${item.product_name_snapshot}${item.quantity > 1 ? ` × ${item.quantity}` : ""} · ${money(item.unit_price_cents * item.quantity)}`).join("\n"),
    subtotal: money(order.subtotal_cents),
    shipping: money(order.shipping_charge_cents),
    tax: money(order.tax_cents),
    total: money(order.total_cents),
    shipTo: shipTo || "No shipping address on file",
    renewalNote: subscription ? `This order renews every ${subscription.cadence_weeks ?? 4} weeks.` : "",
    cancelLink: cancel,
    contactEmail: office.email ?? "",
  });
}

export function trackingUrl(carrier: string | null, tracking: string): string | null {
  const key = carrier?.toLowerCase() ?? "";
  if (key.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tracking)}`;
  if (key.includes("ups")) return `https://www.ups.com/track?tracknum=${encodeURIComponent(tracking)}`;
  if (key.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tracking)}`;
  return null;
}
export async function sendShippedNotice(input: { order: BillingOrderRow; payer: BillingPayerRow; office: ProviderSummary }): Promise<void> {
  const tracking = input.order.tracking_number ?? "";
  await deliver(input.payer.email, "order-shipped", {
    name: firstName(input.payer),
    orderNumber: input.order.order_number,
    officeName: officeLabel(input.office),
    carrier: input.order.carrier ?? "Carrier",
    trackingNumber: tracking || "Not provided",
    trackingLink: tracking ? trackingUrl(input.order.carrier, tracking) ?? "" : "",
  });
}
export async function sendCancellationNotice(input: {
  subscription: BillingSubscriptionRow; payer: BillingPayerRow; productName: string; office?: ProviderSummary | null;
}): Promise<void> {
  await deliver(input.payer.email, "subscription-cancelled", {
    name: firstName(input.payer),
    productName: input.productName,
    officeName: input.office ? officeLabel(input.office) : "your provider office",
  });
}

export async function sendPaymentFailed(input: {
  subscription: BillingSubscriptionRow; payer: BillingPayerRow; productName: string;
  office: ProviderSummary; amountCents: number; hostedInvoiceUrl: string;
}): Promise<void> {
  if (!liveBillingEffectsAllowed()) return;
  try {
    let cancel = "";
    try { cancel = `${publicOrigin()}/pay/cancel/${input.subscription.cancel_token}`; }
    catch (error) { logger.error({ err: error, subscription: input.subscription.id }, "billing dunning email could not build the cancel link"); }
    await deliver(input.payer.email, "subscription-payment-failed", {
      name: firstName(input.payer),
      officeName: officeLabel(input.office),
      productName: input.productName,
      amount: money(input.amountCents),
      paymentLink: input.hostedInvoiceUrl,
      cancelLink: cancel,
    });
  } catch (error) {
    logger.error({ err: error, subscription: input.subscription.id }, "billing dunning email preparation failed");
  }
}
