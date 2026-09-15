import { Router, type IRouter, type Request } from "express";
import { resolveOfficeScope } from "../auth/office-scope";
import { isExpoPushToken } from "../notifications/expo-push";
import { supabaseStaffNotificationStore, type StaffNotificationStore } from "../alerts/store";

const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
export function createStaffNotificationsRouter(store: StaffNotificationStore = supabaseStaffNotificationStore): IRouter {
  const router: IRouter = Router();
  const scope = async (req: Request) => resolveOfficeScope({
    authorization: req.headers.authorization, explicitOfficeId: null, hqPermission: "provider_read", requireUnlocked: true,
  });
  router.put("/staff-notifications/device", async (req, res) => {
    try {
      const resolved = await scope(req);
      if (resolved.kind !== "ok") { res.status(resolved.status).json({ error: resolved.message }); return; }
      if (resolved.scope.actorKind === "hq") { res.status(403).json({ error: "Staff notification devices are for office staff." }); return; }
      const body = req.body as Record<string, unknown>;
      if (!isExpoPushToken(body?.token) || typeof body.deviceId !== "string" || !DEVICE_ID_RE.test(body.deviceId) || (body.platform !== "ios" && body.platform !== "android")) {
        res.status(400).json({ error: "A valid Expo token, device id, and platform are required." }); return;
      }
      const result = await store.registerToken({ authUserId: resolved.scope.actorUserId, providerId: resolved.scope.providerId, token: body.token, deviceId: body.deviceId, platform: body.platform });
      res.json({ ok: true, tokenId: result.token.id, retired: result.retired });
    } catch (error) { req.log?.error({ err: error }, "staff push registration failed"); res.status(500).json({ error: "Could not register this device for notifications." }); }
  });
  router.delete("/staff-notifications/device", async (req, res) => {
    try {
      const resolved = await scope(req);
      if (resolved.kind !== "ok") { res.status(resolved.status).json({ error: resolved.message }); return; }
      if (resolved.scope.actorKind === "hq") { res.status(403).json({ error: "Staff notification devices are for office staff." }); return; }
      const body = req.body as Record<string, unknown>;
      const deviceId = typeof body?.deviceId === "string" && DEVICE_ID_RE.test(body.deviceId) ? body.deviceId : null;
      const retired = await store.unregisterTokens(resolved.scope.actorUserId, deviceId, body?.reason === "account_switch" ? "account_switch" : "signed_out");
      res.json({ ok: true, retired });
    } catch (error) { req.log?.error({ err: error }, "staff push unregister failed"); res.status(500).json({ error: "Could not update this device's notification registration." }); }
  });
  return router;
}
export default createStaffNotificationsRouter();