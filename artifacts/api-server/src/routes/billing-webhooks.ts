import express, { Router, type IRouter, type Request, type Response } from "express";
import { getEndpointSecret } from "../billing/webhook-endpoints";
import { getStripe, getStripeCredentials } from "../billing/stripe-client";
import { runWithBillingIdentity } from "../billing/stripe-environment";
import type { WebhookMode } from "../billing/webhook-endpoints";
import { type WebhookEndpointKind } from "../billing/webhooks";
import { processStripeEvent } from "../billing/webhook-processing";

const router: IRouter = Router();
router.use(express.raw({ type: "application/json" }));
async function webhook(mode: WebhookMode, kind: WebhookEndpointKind, req: Request, res: Response): Promise<void> {
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string" || !Buffer.isBuffer(req.body)) {
    // Refused deliveries are logged (never the body or signature) so repeated
    // forgery attempts are visible in the server logs.
    req.log?.warn({ kind, ip: req.ip, reason: "missing_signature_or_raw_body" }, "billing webhook rejected");
    res.status(400).json({ error: "Invalid webhook signature." }); return;
  }
  let event;
  try {
    const [stripe, secret] = await Promise.all([getStripe(mode), getEndpointSecret(kind, mode)]);
    event = stripe.webhooks.constructEvent(req.body, signature, secret);
  } catch (error) {
    req.log?.warn({ kind, mode, ip: req.ip, reason: "invalid_signature_or_configuration" }, "billing webhook rejected");
    res.status(400).json({ error: "Invalid webhook signature." }); return;
  }
  if (event.livemode !== (mode === "live") || (kind === "connect" && !event.account)) {
    res.status(400).json({ error: "Webhook environment or account mismatch." }); return;
  }
  try {
    const credentials = await getStripeCredentials(mode);
    const result = await runWithBillingIdentity(
      { mode, platformAccountId: credentials.account_id },
      () => processStripeEvent(event, kind),
    );
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
for (const mode of ["test", "live"] as const) {
  for (const kind of ["platform", "connect"] as const) {
    router.post(`/${mode}/${kind}`, (req, res) => void webhook(mode, kind, req, res));
  }
}
// The old URL cannot prove its account/mode binding. Fail closed rather than
// routing delayed deliveries according to whichever mode staff selected today.
router.post(["/platform", "/connect"], (_req, res) => {
  res.status(410).json({ error: "Configure the mode-specific Stripe webhook endpoint." });
});
export default router;