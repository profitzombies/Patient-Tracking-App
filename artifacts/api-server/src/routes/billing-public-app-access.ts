/**
 * Public app-access checkout: the /pay/app-access/<token> page.
 *
 * The token (minted by the patient's entitlement endpoint) IS the patient's
 * authorization here — the page opens in an external browser with no app
 * session. Reads are keyed to the current billing mode by the identity
 * middleware; the checkout POST is a financial write and therefore demands
 * the X-Billing-Scope the page loaded with (`/checkout` suffix).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { verifyAppAccessCheckoutToken, type AppAccessCheckoutClaims } from "../billing/app-access/checkout-token";
import { appAccessCheckoutPreview, appAccessOrderStatus, createAppAccessSubscription } from "../billing/app-access/subscription";
import { BillingLinkError } from "../billing/links";
import { AppAccessPriceError } from "../billing/app-access/settings";
import { BillingSubscriptionError } from "../billing/subscriptions";
import { createLimiter } from "../coach/limits";

const router: IRouter = Router();
const limits = (burst: number) => createLimiter({
  burst, refillPerMinute: burst / 10, maxConcurrent: 20, dailyBudget: 100_000,
  dailyMessage: "Payment requests have reached their daily limit. Please try again tomorrow.",
  busyMessage: "Payments are busy right now. Please try again in a moment.",
  rapidMessage: "Too many payment requests. Please wait a moment.",
});
const readLimit = limits(120);
const checkoutLimit = limits(20);

async function limited(req: Request, res: Response, acquire: ReturnType<typeof limits>, work: (claims: AppAccessCheckoutClaims) => Promise<void>) {
  const slot = acquire(req.ip || req.socket.remoteAddress || "unknown");
  if (!slot.ok) { res.status(429).json({ error: slot.message }); return; }
  try {
    const claims = verifyAppAccessCheckoutToken(String(req.params.token ?? ""));
    if (!claims) { res.status(404).json({ error: "This checkout link has expired. Open it again from the app." }); return; }
    await work(claims);
  } catch (error) {
    // Payer resolution (links) and the price mirror (settings) answer with
    // their own typed errors; each carries the status the patient should see.
    if (error instanceof BillingSubscriptionError || error instanceof BillingLinkError || error instanceof AppAccessPriceError) {
      if (error.status >= 500) req.log?.error({ err: error }, "app access checkout failed");
      res.status(error.status).json({ error: error.message }); return;
    }
    req.log?.error({ err: error }, "app access checkout failed");
    res.status(503).json({ error: "Payments are temporarily unavailable." });
  } finally { slot.release(); }
}

router.get("/billing/public/app-access/:token", (req, res) => void limited(req, res, readLimit, async (claims) => {
  res.json(await appAccessCheckoutPreview(claims));
}));

router.post("/billing/public/app-access/:token/checkout", (req, res) => void limited(req, res, checkoutLimit, async (claims) => {
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length) {
    res.status(400).json({ error: "Checkout takes no options; the office's current price applies." }); return;
  }
  res.json(await createAppAccessSubscription(claims));
}));

router.get("/billing/public/app-access/:token/orders/:orderId", (req, res) => void limited(req, res, readLimit, async (claims) => {
  if (!z.string().uuid().safeParse(req.params.orderId).success) { res.status(404).json({ error: "Order not found." }); return; }
  res.json(await appAccessOrderStatus(String(req.params.orderId), claims.patientId));
}));

export default router;
