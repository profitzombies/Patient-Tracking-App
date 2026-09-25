/**
 * HQ-only provider launch readiness check (System health). Read-only: it
 * reports vendor configuration and never changes Stripe, Resend or Twilio.
 */
import { Router, type IRouter } from "express";
import { requireHqPermission } from "../lib/staff-auth";
import { checkLaunchReadiness } from "../system/launch-readiness";

const router: IRouter = Router();

router.get("/hq/system-health/launch-readiness", requireHqPermission("settings_manage"), async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await checkLaunchReadiness());
  } catch (error) {
    req.log?.error({ err: error }, "launch readiness check failed");
    res.status(502).json({ error: "The launch readiness check could not run. Try again in a moment." });
  }
});

export default router;
