import { Router, type IRouter, type Request, type Response } from "express";
import { normalizeIdentifier } from "../claim/normalize";
import {
  checkTwilioVerification,
  DeliveryNotConfiguredError,
  startTwilioVerification,
} from "../claim/delivery";

const router: IRouter = Router();
const windowMs = 60 * 60 * 1000;
const sendLimit = 5;
const verifyLimit = 12;
const attempts = new Map<string, number[]>();

function isEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function acquire(key: string, limit: number): boolean {
  const now = Date.now();
  const active = (attempts.get(key) ?? []).filter((at) => now - at < windowMs);
  if (active.length >= limit) {
    attempts.set(key, active);
    return false;
  }
  active.push(now);
  attempts.set(key, active);
  return true;
}

function normalizedPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const identifier = normalizeIdentifier(value);
  return identifier?.kind === "phone" ? identifier.e164 : null;
}

function deliveryError(error: unknown): { status: number; message: string } {
  if (error instanceof DeliveryNotConfiguredError) {
    return { status: 503, message: error.message };
  }
  if (error instanceof Error && error.message.includes("(403)")) {
    return {
      status: 403,
      message:
        "Twilio blocked this recipient. Verify the destination number for testing or approve the account's Primary Compliance Profile.",
    };
  }
  return {
    status: 502,
    message: "Twilio could not send the code. Check the Verify logs and try again.",
  };
}

router.post("/test/twilio/send", async (req: Request, res: Response) => {
  if (!isEnabled()) return res.status(404).json({ error: "Not found." });
  const phone = normalizedPhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({ error: "Enter a valid phone number with its country code." });
  }
  const ip = clientIp(req);
  if (
    !acquire(`send:ip:${ip}`, sendLimit) ||
    !acquire(`send:phone:${phone}`, sendLimit)
  ) {
    return res.status(429).json({ error: "Too many codes requested. Try again later." });
  }
  try {
    await startTwilioVerification(phone);
    return res.json({ sent: true });
  } catch (error) {
    req.log.error({ err: error }, "Twilio test verification send failed");
    const result = deliveryError(error);
    return res.status(result.status).json({ error: result.message });
  }
});

router.post("/test/twilio/check", async (req: Request, res: Response) => {
  if (!isEnabled()) return res.status(404).json({ error: "Not found." });
  const phone = normalizedPhone(req.body?.phone);
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!phone || !/^\d{4,10}$/.test(code)) {
    return res.status(400).json({ error: "Enter the phone number and verification code." });
  }
  const ip = clientIp(req);
  if (
    !acquire(`check:ip:${ip}`, verifyLimit) ||
    !acquire(`check:phone:${phone}`, verifyLimit)
  ) {
    return res.status(429).json({ error: "Too many verification attempts. Try again later." });
  }
  try {
    const verified = await checkTwilioVerification(phone, code);
    return res.json({ verified });
  } catch (error) {
    req.log.error({ err: error }, "Twilio test verification check failed");
    return res.status(502).json({ error: "Twilio could not check that code. Try again." });
  }
});

export default router;