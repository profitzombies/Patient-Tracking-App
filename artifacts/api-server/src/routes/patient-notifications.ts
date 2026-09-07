/**
 * Patient-side push endpoints and the internal scheduler trigger.
 *
 *   PUT    /patient-notifications/device       register this device's Expo push token
 *   DELETE /patient-notifications/device       retire this device's token (sign-out / account switch)
 *   GET    /patient-notifications/status       whether the account has an active device
 *   POST   /patient-notifications/:id/opened   the app opened a notification (deep link landed)
 *   POST   /internal/notifications/tick        run one scheduler tick (bearer NOTIFICATIONS_INTERNAL_TOKEN)
 *
 * The internal trigger answers 404 when no token is configured so the route
 * is invisible rather than merely locked; comparisons are constant-time.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { timingSafeEqual } from "crypto";
import { createLimiter } from "../coach/limits";
import { resolvePatient } from "../lib/patient-auth";
import { isExpoPushToken } from "../notifications/expo-push";
import { supabaseNotificationStore, type NotificationStore } from "../notifications/store";
import { runScheduledTick } from "../notifications/worker";

const router: IRouter = Router();

const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

const acquireInternalSlot = createLimiter({
  burst: 30,
  refillPerMinute: 30,
  maxConcurrent: 2,
  dailyBudget: 20_000,
  dailyMessage: "Too many tick requests today.",
  busyMessage: "A tick is already running.",
  rapidMessage: "Tick requests are arriving too quickly.",
});

export function createPatientNotificationsRouter(store: NotificationStore = supabaseNotificationStore): IRouter {
  const r: IRouter = Router();

  r.put("/patient-notifications/device", async (req: Request, res: Response) => {
    try {
      const auth = await resolvePatient(req);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!isExpoPushToken(body.token)) {
        res.status(400).json({ error: "A valid Expo push token is required." });
        return;
      }
      if (typeof body.deviceId !== "string" || !DEVICE_ID_RE.test(body.deviceId)) {
        res.status(400).json({ error: "A device id is required." });
        return;
      }
      if (body.platform !== "ios" && body.platform !== "android") {
        res.status(400).json({ error: "Platform must be ios or android." });
        return;
      }
      const result = await store.registerToken({
        patientId: auth.patientId,
        token: body.token,
        deviceId: body.deviceId,
        platform: body.platform,
      });
      res.json({ ok: true, tokenId: result.token.id, retired: result.retired });
    } catch (error) {
      req.log?.error({ err: error }, "push token registration failed");
      res.status(500).json({ error: "Could not register this device for notifications." });
    }
  });

  r.delete("/patient-notifications/device", async (req: Request, res: Response) => {
    try {
      const auth = await resolvePatient(req);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const deviceId = typeof body.deviceId === "string" && DEVICE_ID_RE.test(body.deviceId) ? body.deviceId : null;
      const reason = body.reason === "account_switch" ? "account_switch" : "signed_out";
      const count = await store.unregisterTokens(auth.patientId, deviceId, reason);
      res.json({ ok: true, retired: count });
    } catch (error) {
      req.log?.error({ err: error }, "push token unregister failed");
      res.status(500).json({ error: "Could not update this device's notification registration." });
    }
  });

  r.get("/patient-notifications/status", async (req: Request, res: Response) => {
    try {
      const auth = await resolvePatient(req);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
      const tokens = await store.activeTokens(auth.patientId);
      const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId : null;
      res.json({
        activeDevices: tokens.length,
        thisDevice: deviceId ? tokens.some((t) => t.device_id === deviceId) : false,
      });
    } catch (error) {
      req.log?.error({ err: error }, "push status failed");
      res.status(500).json({ error: "Could not load notification status." });
    }
  });

  r.post("/patient-notifications/:id/opened", async (req: Request, res: Response) => {
    try {
      const auth = await resolvePatient(req);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
      const id = String(req.params.id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.status(404).json({ error: "Notification not found." });
        return;
      }
      const row = await store.getNotification(id);
      if (!row || row.patient_id !== auth.patientId) {
        res.status(404).json({ error: "Notification not found." });
        return;
      }
      if (row.status === "opened") {
        res.json({ ok: true, status: "opened", openedAt: row.opened_at });
        return;
      }
      const now = new Date().toISOString();
      const updated = await store.updateNotification(id, {
        status: "opened",
        opened_at: now,
        delivered_at: row.delivered_at ?? now,
        finalized_at: row.finalized_at ?? now,
      });
      res.json({ ok: true, status: updated?.status ?? "opened", openedAt: updated?.opened_at ?? now });
    } catch (error) {
      req.log?.error({ err: error }, "notification opened failed");
      res.status(500).json({ error: "Could not record the open." });
    }
  });

  r.post("/internal/notifications/tick", async (req: Request, res: Response) => {
    const configured = process.env.NOTIFICATIONS_INTERNAL_TOKEN;
    if (!configured || configured.trim() === "") {
      res.status(404).json({ error: "Not found." });
      return;
    }
    const header = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const a = Buffer.from(presented);
    const b = Buffer.from(configured.trim());
    if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    const slot = acquireInternalSlot("internal-tick");
    if (!slot.ok) {
      res.status(429).json({ error: slot.message });
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await runScheduledTick({
        outreach: body.outreach === true ? true : body.outreach === false ? false : undefined,
        store,
      });
      res.json(result);
    } catch (error) {
      req.log?.error({ err: error }, "internal notification tick failed");
      res.status(500).json({ error: "Tick failed." });
    } finally {
      slot.release();
    }
  });

  return r;
}

router.use(createPatientNotificationsRouter());

export default router;
