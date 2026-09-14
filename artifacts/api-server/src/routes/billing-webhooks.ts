import express, { Router, type IRouter, type Request, type Response } from "express";
import { getEndpointSecret } from "../billing/webhook-endpoints";
import { getStripe } from "../billing/stripe-client";
import { type WebhookEndpointKind } from "../billing/webhooks";
import { processStripeEvent } from "../billing/webhook-processing";

const router: IRouter = Router();
router.use(express.raw({ type: "application/json" }));
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
  try {
    const result = await processStripeEvent(event, kind);
    if (result === "duplicate") {
      res.status(200).json({ received: true, duplicate: true }); return;
    }
    if (result === "busy") {
      // A non-success response is required here. A 200 would tell Stripe to
      // discard the delivery even if the current worker dies before dispatch.
      res.status(500).json({ received: true, in_progress: true }); return;
    }
  } catch (error) {
    req.log?.error({ err: error, eventId: event.id, type: event.type }, "billing webhook handler failed");
    res.status(500).json({ error: "Webhook processing failed." });
    return;
  }
  res.status(200).json({ received: true });
}
router.post("/platform", (req, res) => void webhook("platform", req, res));
router.post("/connect", (req, res) => void webhook("connect", req, res));
export default router;