import express, { Router, type IRouter, type Request, type Response } from "express";
import {
  ingestVendorEvent, isWebhookConfigured, normalizeEvent, noteRejection, verifySignature, webhookSecret,
} from "../email/vendor-webhook";

/**
 * Email vendor delivery-event webhook (POST /api/email/webhooks/resend).
 * Raw body, Svix-style signature check, then exactly-once ingestion into the
 * vendor event inbox. Refusals are counted on the health row and logged
 * (never with the body or signature) so a misconfigured or forged stream is
 * visible on HQ System health. Unknown event types are acknowledged so the
 * vendor does not keep retrying them.
 */
const router: IRouter = Router();
router.use(express.raw({ type: () => true, limit: "256kb" }));

function header(req: Request, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" && value ? value : null;
}

async function refuse(req: Request, res: Response, reason: string): Promise<void> {
  req.log?.warn({ ip: req.ip, reason }, "email webhook rejected");
  if (isWebhookConfigured()) await noteRejection().catch((error) => req.log?.error({ err: error }, "email webhook rejection count failed"));
  res.status(reason === "not_configured" ? 503 : 400).json({ error: reason === "not_configured" ? "Email tracking is not enabled." : "Invalid webhook signature." });
}

router.post("/resend", async (req: Request, res: Response) => {
  if (!Buffer.isBuffer(req.body)) { await refuse(req, res, "missing_raw_body"); return; }
  const headers = { id: header(req, "svix-id"), timestamp: header(req, "svix-timestamp"), signature: header(req, "svix-signature") };
  const verdict = verifySignature(req.body, headers, webhookSecret());
  if (verdict !== "ok") { await refuse(req, res, verdict); return; }
  let payload: unknown;
  try { payload = JSON.parse(req.body.toString("utf8")); } catch { res.status(400).json({ error: "Malformed JSON." }); return; }
  const normalized = normalizeEvent(payload, headers.id as string);
  if (normalized.kind === "invalid") { res.status(400).json({ error: `Unusable event (${normalized.reason}).` }); return; }
  if (normalized.kind === "ignored") { res.status(200).json({ received: true, ignored: true }); return; }
  try {
    const result = await ingestVendorEvent(normalized.event);
    res.status(200).json({ received: true, duplicate: result.outcome === "duplicate", matched: result.matched });
  } catch (error) {
    // A 5xx asks the vendor to retry; storage is idempotent on the vendor event id.
    req.log?.error({ err: error, eventType: normalized.event.eventType }, "email webhook ingestion failed");
    res.status(500).json({ error: "Webhook processing failed." });
  }
});

export default router;
