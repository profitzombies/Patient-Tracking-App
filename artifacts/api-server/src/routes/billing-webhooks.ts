import express, { Router, type IRouter, type Request, type Response } from "express";
import { getEndpointSecret } from "../billing/webhook-endpoints";
import { registerBillingWebhookHandlers } from "../billing/webhook-handlers";
import { getStripe } from "../billing/stripe-client";
import { dispatchStripeEvent, type WebhookEndpointKind } from "../billing/webhooks";
import { insert, nowIso, selectOne, update, BillingStoreError } from "../billing/store";

const router: IRouter = Router();
router.use(express.raw({ type: "application/json" }));
const CLAIM_LEASE_MS = 5 * 60_000;

function claimFilter(eventId: string, claimedAt: string | null): string {
  return `stripe_event_id=eq.${encodeURIComponent(eventId)}&processed_at=is.null&claimed_at=${
    claimedAt === null ? "is.null" : `eq.${encodeURIComponent(claimedAt)}`
  }`;
}

async function claimEvent(event: {
  id: string; type: string; account?: string | null; livemode: boolean;
}, kind: WebhookEndpointKind, payload: Record<string, unknown>): Promise<
  { kind: "claimed"; claimedAt: string } | { kind: "processed" } | { kind: "busy" }
> {
  let claimedAt = nowIso();
  try {
    await insert("billing_webhook_events", {
      stripe_event_id: event.id, kind, type: event.type,
      account: event.account ?? null, livemode: event.livemode, received_at: claimedAt,
      claimed_at: claimedAt, processed_at: null, error: null, payload,
    });
    return { kind: "claimed", claimedAt };
  } catch (error) {
    if (!(error instanceof BillingStoreError) || (error.status !== 409 && !/duplicate|unique/i.test(error.message))) {
      throw error;
    }
  }
  const existing = await selectOne("billing_webhook_events", `stripe_event_id=eq.${encodeURIComponent(event.id)}`);
  if (!existing) throw new BillingStoreError("Webhook claim disappeared.", 503);
  if (existing.processed_at) return { kind: "processed" };
  const stale = !existing.claimed_at || Date.now() - Date.parse(existing.claimed_at) >= CLAIM_LEASE_MS;
  if (!existing.error && !stale) return { kind: "busy" };
  // A conditional claim must change the compared value. This also keeps two
  // contenders safe when their clocks land in the same millisecond.
  if (claimedAt === existing.claimed_at) {
    claimedAt = new Date(Date.parse(claimedAt) + 1).toISOString();
  }
  const reclaimed = await update("billing_webhook_events", claimFilter(event.id, existing.claimed_at), {
    claimed_at: claimedAt, error: null, payload,
  });
  return reclaimed ? { kind: "claimed", claimedAt } : { kind: "busy" };
}

async function webhook(kind: WebhookEndpointKind, req: Request, res: Response): Promise<void> {
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string" || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: "Invalid webhook signature." }); return;
  }
  let event;
  try {
    const [stripe, secret] = await Promise.all([getStripe(), getEndpointSecret(kind)]);
    event = stripe.webhooks.constructEvent(req.body, signature, secret);
  } catch {
    res.status(400).json({ error: "Invalid webhook signature." }); return;
  }
  let claimedAt: string;
  try {
    const claim = await claimEvent(event, kind, event as unknown as Record<string, unknown>);
    if (claim.kind === "processed") {
      res.status(200).json({ received: true, duplicate: true }); return;
    }
    if (claim.kind === "busy") {
      // A non-success response is required here. A 200 would tell Stripe to
      // discard the delivery even if the current worker dies before dispatch.
      res.status(500).json({ received: true, in_progress: true }); return;
    }
    claimedAt = claim.claimedAt;
  } catch (error) {
    req.log?.error({ err: error }, "billing webhook record failed");
    res.status(503).json({ error: "Webhook storage is unavailable." }); return;
  }
  try {
    await registerBillingWebhookHandlers();
    await dispatchStripeEvent(event, { kind, account: event.account ?? null, livemode: event.livemode });
    const completed = await update("billing_webhook_events", claimFilter(event.id, claimedAt), {
      processed_at: nowIso(), error: null,
    });
    if (!completed) throw new Error("Webhook processing lease was lost.");
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Unknown handler error";
    req.log?.error({ err: error, eventId: event.id, type: event.type }, "billing webhook handler failed");
    await update("billing_webhook_events", claimFilter(event.id, claimedAt), { error: message }).catch(() => undefined);
    res.status(500).json({ error: "Webhook processing failed." });
    return;
  }
  res.status(200).json({ received: true });
}
router.post("/platform", (req, res) => void webhook("platform", req, res));
router.post("/connect", (req, res) => void webhook("connect", req, res));
export default router;