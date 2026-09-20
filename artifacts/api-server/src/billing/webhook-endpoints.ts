import { publicOrigin } from "./app-origin";
import { BillingConfigError, isSandbox } from "./stripe-client";
import type { WebhookEndpointKind } from "./webhooks";

export type WebhookMode = "test" | "live";
/** Configure these event subscriptions in the Stripe Dashboard; never provision at boot. */
export const BILLING_WEBHOOK_EVENTS = {
  platform: ["account.application.deauthorized"],
  connect: [
    "account.updated", "capability.updated", "invoice.created", "invoice.paid", "invoice.payment_failed",
    "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
    "invoice.finalized", "charge.refunded", "refund.updated",
    "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed",
    "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated", "payout.paid", "payout.failed",
    "payment_intent.payment_failed",
  ],
} as const;

export interface BillingWebhookHealth {
  registered: boolean;
  endpoints: Array<{ kind: WebhookEndpointKind; url: string; enabled_events: number; status: string }>;
  last_error: string | null;
  last_checked_at: string | null;
}

export async function getEndpointSecret(kind: WebhookEndpointKind, mode: WebhookMode): Promise<string> {
  const name = `STRIPE_${mode.toUpperCase()}_${kind.toUpperCase()}_WEBHOOK_SECRET`;
  const secret = process.env[name]?.trim();
  if (!secret || !/^whsec_\S+$/.test(secret)) {
    throw new BillingConfigError(`Configure ${name} for billing webhook verification.`);
  }
  return secret;
}

/** Compatibility with startup/reconciliation callers. No Stripe or database mutations. */
export async function ensureBillingWebhookEndpoints(): Promise<void> {}
export function stopBillingWebhookEndpointRetry(): void {}

export async function getBillingWebhookHealth(): Promise<BillingWebhookHealth> {
  const endpoints: BillingWebhookHealth["endpoints"] = [];
  let error: string | null = null;
  try {
    const mode = await isSandbox() ? "test" : "live";
    for (const kind of ["platform", "connect"] as const) {
      let configured = true;
      try { await getEndpointSecret(kind, mode); } catch (cause) {
        configured = false;
        error = cause instanceof Error ? cause.message : "Webhook signing secret is missing.";
      }
      endpoints.push({
        kind, url: `${publicOrigin()}/api/billing/webhooks/${mode}/${kind}`,
        // A local secret cannot prove the Dashboard endpoint is enabled.
        enabled_events: 0, status: configured ? "configured_unverified" : "missing",
      });
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Webhook configuration is unavailable.";
  }
  return { registered: false, endpoints, last_error: error, last_checked_at: new Date().toISOString() };
}