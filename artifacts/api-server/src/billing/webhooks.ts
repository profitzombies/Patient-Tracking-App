/**
 * Stripe webhook dispatch registry.
 *
 * Each billing module registers handlers for the event types it owns
 * (accounts.ts owns account events, orders.ts owns invoice and charge events, and so on) via
 * `onStripeEvent`. The route verifies the signature, records the event in
 * `billing_webhook_events` for idempotency, then calls `dispatchStripeEvent`.
 * Handlers must be idempotent: Stripe retries, and a replayed event must not
 * double-write ledger lines.
 */
import type Stripe from "stripe";

export type WebhookEndpointKind = "platform" | "connect";

export interface StripeEventContext {
  kind: WebhookEndpointKind;
  /** Connected account id for Connect events; null for platform events. */
  account: string | null;
  livemode: boolean;
  /** Set by reconciliation so a newer webhook-owned subscription state wins. */
  expectedSubscriptionUpdatedAt?: string;
}

export type StripeEventHandler = (event: Stripe.Event, ctx: StripeEventContext) => Promise<void>;

const handlers = new Map<string, StripeEventHandler[]>();

export function onStripeEvent(type: string, handler: StripeEventHandler): void {
  const list = handlers.get(type) ?? [];
  list.push(handler);
  handlers.set(type, list);
}

/** Exposed for tests. */
export function resetStripeEventHandlers(): void {
  handlers.clear();
}

export function registeredStripeEventTypes(): string[] {
  return [...handlers.keys()].sort();
}

export async function dispatchStripeEvent(event: Stripe.Event, ctx: StripeEventContext): Promise<void> {
  const list = handlers.get(event.type) ?? [];
  for (const handler of list) {
    await handler(event, ctx);
  }
}
