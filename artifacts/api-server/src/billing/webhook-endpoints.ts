import Stripe from "stripe";
import { logger } from "../lib/logger";
import { publicOrigin } from "./app-origin";
import { getStripe, isSandbox } from "./stripe-client";
import { selectOne, upsert } from "./store";
import type { WebhookEndpointKind } from "./webhooks";

const EVENTS = {
  platform: ["account.application.deauthorized"],
  connect: [
    "account.updated", "capability.updated", "invoice.created", "invoice.paid", "invoice.payment_failed",
    "customer.subscription.updated", "customer.subscription.deleted", "charge.refunded",
    "charge.dispute.created", "charge.dispute.closed", "payout.paid", "payout.failed",
    "payment_intent.payment_failed",
  ],
} as const;
const secretCache = new Map<WebhookEndpointKind, string>();
function endpointUrl(kind: WebhookEndpointKind): string {
  return `${publicOrigin()}/api/billing/webhooks/${kind}`;
}
export async function getEndpointSecret(kind: WebhookEndpointKind): Promise<string> {
  const cached = secretCache.get(kind);
  if (cached) return cached;
  const row = await selectOne("billing_webhook_endpoints", `url=eq.${encodeURIComponent(endpointUrl(kind))}`);
  if (!row?.secret) throw new Error(`Billing ${kind} webhook is not configured.`);
  secretCache.set(kind, row.secret);
  return row.secret;
}
async function savedEndpointIsLive(stripe: Stripe, endpointId: string | null | undefined): Promise<boolean> {
  if (!endpointId) return false;
  try {
    const endpoint = await stripe.webhookEndpoints.retrieve(endpointId);
    return endpoint.status === "enabled";
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError && error.code === "resource_missing") return false;
    throw error;
  }
}
export async function ensureEndpoint(kind: WebhookEndpointKind): Promise<void> {
  const url = endpointUrl(kind);
  const saved = await selectOne("billing_webhook_endpoints", `url=eq.${encodeURIComponent(url)}`);
  const stripe = await getStripe();
  // A saved row only proves an endpoint existed on the account that was connected when it was written.
  // Re-keying the Stripe connection leaves the row behind with a secret the new account never issued.
  if (saved?.secret && (await savedEndpointIsLive(stripe, saved.stripe_endpoint_id))) {
    secretCache.set(kind, saved.secret);
    return;
  }
  if (saved?.secret) logger.warn({ kind, url }, "saved billing webhook endpoint is missing in Stripe; re-registering");
  secretCache.delete(kind);
  const listed = await stripe.webhookEndpoints.list({ limit: 100 });
  for (const endpoint of listed.data.filter((candidate) => candidate.url === url)) {
    await stripe.webhookEndpoints.del(endpoint.id);
  }
  const created = await stripe.webhookEndpoints.create({
    url, enabled_events: [...EVENTS[kind]],
    ...(kind === "connect" ? { connect: true } : {}),
  });
  if (!created.secret) throw new Error("Stripe did not return a webhook signing secret.");
  await upsert("billing_webhook_endpoints", {
    kind, url, stripe_endpoint_id: created.id, secret: created.secret, livemode: !(await isSandbox()),
  }, "url");
  secretCache.set(kind, created.secret);
}
export async function ensureBillingWebhookEndpoints(): Promise<void> {
  if (process.env.BILLING_WEBHOOKS_DISABLED === "1" || process.env.NODE_ENV === "test") return;
  try { await ensureEndpoint("platform"); await ensureEndpoint("connect"); }
  catch (error) { logger.warn({ err: error }, "billing webhook endpoint setup skipped"); }
}