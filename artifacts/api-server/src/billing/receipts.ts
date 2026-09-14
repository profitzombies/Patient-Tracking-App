import { logger } from "../lib/logger";
import { publicOrigin } from "./app-origin";
import type { BillingOrderItemRow, BillingOrderRow, BillingPayerRow, BillingSubscriptionRow } from "./store";
import type { ProviderSummary } from "./store-orders";

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
function resend(): { key: string; from: string } | null {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.CLAIM_EMAIL_FROM;
  return key && from ? { key, from } : null;
}
async function deliver(to: string | null, subject: string, html: string, text: string): Promise<void> {
  if (!to) return;
  const credentials = resend();
  if (!credentials) {
    logger.warn("billing email delivery is not configured");
    return;
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: credentials.from, to: [to], subject, html, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Resend send failed (${response.status})`);
  } catch (error) {
    logger.error({ err: error }, "billing email delivery failed");
  }
}

export async function sendReceipt(input: {
  order: BillingOrderRow; items: BillingOrderItemRow[]; payer: BillingPayerRow;
  office: ProviderSummary; subscription?: BillingSubscriptionRow | null;
}): Promise<void> {
  const { order, items, payer, office, subscription } = input;
  const officeLabel = office.office_name || office.provider_name || "Your provider";
  const lines = items.map((item) => `${item.product_name_snapshot} × ${item.quantity}: ${money(item.unit_price_cents * item.quantity)}`);
  const address = order.shipping_address as Record<string, string | null>;
  const addressText = [address.name, address.line1, address.line2, address.city, address.state, address.postal_code, address.country].filter(Boolean).join(", ");
  const cancel = subscription ? `${publicOrigin()}/pay/cancel/${subscription.cancel_token}` : null;
  const text = [
    `Receipt ${order.order_number}`, officeLabel, ...lines,
    `Subtotal: ${money(order.subtotal_cents)}`, `Shipping: ${money(order.shipping_charge_cents)}`,
    `Tax: ${money(order.tax_cents)}`, `Total: ${money(order.total_cents)}`, `Ship to: ${addressText}`,
    ...(cancel ? ["This order renews every 4 weeks.", `Manage cancellation: ${cancel}`] : []),
    office.email ? `Contact: ${office.email}` : "",
  ].filter(Boolean).join("\n");
  await deliver(payer.email, `Receipt ${order.order_number}`, `<div><h1>Receipt ${esc(order.order_number)}</h1>${text.split("\n").map((line) => `<p>${esc(line)}</p>`).join("")}</div>`, text);
}

function trackingUrl(carrier: string | null, tracking: string): string | null {
  const key = carrier?.toLowerCase() ?? "";
  if (key.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tracking)}`;
  if (key.includes("ups")) return `https://www.ups.com/track?tracknum=${encodeURIComponent(tracking)}`;
  if (key.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tracking)}`;
  return null;
}
export async function sendShippedNotice(input: { order: BillingOrderRow; payer: BillingPayerRow; office: ProviderSummary }): Promise<void> {
  const tracking = input.order.tracking_number ?? "";
  const url = trackingUrl(input.order.carrier, tracking);
  const text = `Order ${input.order.order_number} has shipped.\nCarrier: ${input.order.carrier ?? "Carrier"}\nTracking: ${tracking}${url ? `\nTrack: ${url}` : ""}`;
  await deliver(input.payer.email, `Order ${input.order.order_number} has shipped`, `<div>${text.split("\n").map((line) => `<p>${esc(line)}</p>`).join("")}</div>`, text);
}
export async function sendCancellationNotice(input: { subscription: BillingSubscriptionRow; payer: BillingPayerRow; productName: string }): Promise<void> {
  const text = `${input.productName} will not renew after the current billing period.`;
  await deliver(input.payer.email, "Subscription cancellation confirmed", `<p>${esc(text)}</p>`, text);
}