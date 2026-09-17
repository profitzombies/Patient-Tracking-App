import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  PrebuiltCartError, checkoutPrebuiltCart, publicCartCheckoutStatus, publicCartDetails, publicCartPeek,
  startCartPhone, verifyCartCode,
} from "../billing/prebuilt-carts";
import { createLimiter } from "../coach/limits";

const router: IRouter = Router();
const limits = (burst: number) => createLimiter({
  burst, refillPerMinute: burst / 10, maxConcurrent: 20, dailyBudget: 100_000,
  dailyMessage: "Payment requests have reached their daily limit. Please try again tomorrow.",
  busyMessage: "Payments are busy right now. Please try again in a moment.",
  rapidMessage: "Too many payment requests. Please wait a moment.",
});
const readLimit = limits(120);
const sendLimit = limits(10);
const checkLimit = limits(20);
const checkoutLimit = limits(20);
async function limited(req: Request, res: Response, acquire: ReturnType<typeof limits>, work: () => Promise<void>) {
  const slot = acquire(req.ip || req.socket.remoteAddress || "unknown");
  if (!slot.ok) { res.status(429).json({ error: slot.message }); return; }
  try { await work(); } finally { slot.release(); }
}
function fail(req: Request, res: Response, error: unknown) {
  if (error instanceof PrebuiltCartError) {
    const attemptsLeft = (error as PrebuiltCartError & { attempts_left?: number }).attempts_left;
    res.status(error.status).json({ error: error.message, ...(error.field ? { field: error.field } : {}),
      ...(attemptsLeft !== undefined ? { attempts_left: attemptsLeft } : {}) });
    return;
  }
  req.log?.error({ err: error }, "public cart request failed");
  res.status(503).json({ error: "Payments are temporarily unavailable." });
}
const Address = z.object({
  name: z.string().trim().min(1), line1: z.string().trim().min(1), line2: z.string().trim().nullable(),
  city: z.string().trim().min(1), state: z.string().trim().min(1), postal_code: z.string().trim().min(3),
  country: z.string().trim().length(2), phone: z.string().trim().nullable(),
});
router.get("/billing/public/carts/:token", (req, res) => void limited(req, res, readLimit, async () => {
  try { res.json(await publicCartPeek(String(req.params.token))); } catch (error) { fail(req, res, error); }
}));
router.post("/billing/public/carts/:token/phone", (req, res) => void limited(req, res, sendLimit, async () => {
  try { res.json(await startCartPhone(String(req.params.token), req.body?.phone)); } catch (error) { fail(req, res, error); }
}));
router.post("/billing/public/carts/:token/verify", (req, res) => void limited(req, res, checkLimit, async () => {
  try { res.json(await verifyCartCode(String(req.params.token), req.body?.request_id, req.body?.code)); } catch (error) { fail(req, res, error); }
}));
router.get("/billing/public/carts/:token/details", (req, res) => void limited(req, res, readLimit, async () => {
  try { res.json(await publicCartDetails(String(req.params.token), req.header("X-Cart-Session"))); } catch (error) { fail(req, res, error); }
}));
router.post("/billing/public/carts/:token/checkout", (req, res) => void limited(req, res, checkoutLimit, async () => {
  const parsed = z.object({
    shipping_address: Address, payment_method_id: z.string().trim().min(1).max(200),
    payer: z.object({ name: z.string().trim().min(1), email: z.string().email(), phone: z.string() }).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the checkout." }); return; }
  try {
    const result = await checkoutPrebuiltCart(String(req.params.token), req.header("X-Cart-Session"), parsed.data);
    res.status(result.status === "failed" ? 402 : 200).json(result);
  } catch (error) { fail(req, res, error); }
}));
router.get("/billing/public/carts/:token/status", (req, res) => void limited(req, res, readLimit, async () => {
  try { res.json(await publicCartCheckoutStatus(String(req.params.token), req.header("X-Cart-Session"))); } catch (error) { fail(req, res, error); }
}));
export default router;