import type Stripe from "stripe";
import { registerBillingWebhookHandlers } from "./webhook-handlers";
import { dispatchStripeEvent, type WebhookEndpointKind } from "./webhooks";
import { insert, nowIso, selectOne, update, BillingStoreError } from "./store";

const CLAIM_LEASE_MS = 5 * 60_000;
function claimFilter(eventId: string, claimedAt: string | null): string {
  return `stripe_event_id=eq.${encodeURIComponent(eventId)}&processed_at=is.null&claimed_at=${
    claimedAt === null ? "is.null" : `eq.${encodeURIComponent(claimedAt)}`}`;
}

export async function claimStripeEvent(event: {
  id: string; type: string; account?: string | null; livemode: boolean;
}, kind: WebhookEndpointKind, payload: Record<string, unknown>): Promise<
  { kind: "claimed"; claimedAt: string } | { kind: "processed" } | { kind: "busy" }
> {
  let claimedAt = nowIso();
  try {
    await insert("billing_webhook_events", {
      stripe_event_id: event.id, kind, type: event.type, account: event.account ?? null,
      livemode: event.livemode, received_at: claimedAt, claimed_at: claimedAt,
      processed_at: null, error: null, payload,
    });
    return { kind: "claimed", claimedAt };
  } catch (error) {
    if (!(error instanceof BillingStoreError) || (error.status !== 409 && !/duplicate|unique/i.test(error.message))) throw error;
  }
  const existing = await selectOne("billing_webhook_events", `stripe_event_id=eq.${encodeURIComponent(event.id)}`);
  if (!existing) throw new BillingStoreError("Webhook claim disappeared.", 503);
  if (existing.processed_at) return { kind: "processed" };
  const stale = !existing.claimed_at || Date.now() - Date.parse(existing.claimed_at) >= CLAIM_LEASE_MS;
  if (!existing.error && !stale) return { kind: "busy" };
  if (claimedAt === existing.claimed_at) claimedAt = new Date(Date.parse(claimedAt) + 1).toISOString();
  const reclaimed = await update("billing_webhook_events", claimFilter(event.id, existing.claimed_at), {
    claimed_at: claimedAt, error: null, payload,
  });
  return reclaimed ? { kind: "claimed", claimedAt } : { kind: "busy" };
}

export async function processStripeEvent(event: Stripe.Event, kind: WebhookEndpointKind): Promise<"processed" | "duplicate" | "busy"> {
  const claim = await claimStripeEvent(event, kind, event as unknown as Record<string, unknown>);
  if (claim.kind !== "claimed") return claim.kind === "processed" ? "duplicate" : "busy";
  try {
    await registerBillingWebhookHandlers();
    await dispatchStripeEvent(event, { kind, account: event.account ?? null, livemode: event.livemode });
    const completed = await update("billing_webhook_events", claimFilter(event.id, claim.claimedAt), {
      processed_at: nowIso(), error: null,
    });
    if (!completed) throw new Error("Webhook processing lease was lost.");
    return "processed";
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Unknown handler error";
    await update("billing_webhook_events", claimFilter(event.id, claim.claimedAt), {
      error: message,
    }).catch(() => undefined);
    throw error;
  }
}