/**
 * Patient heartbeat: POST /patient-data/presence.
 *
 * The app calls this once when a real patient account resolves and again
 * each time it returns to the foreground, so opening the app counts as
 * "active today" even when nothing else is fetched. The write itself rides
 * the same throttled recorder every authenticated patient request uses
 * (resolvePatient notes presence as a side effect), so a chatty client
 * cannot spam the table.
 *
 * Identity only (`consent: "skip"`): opening the app is not a data access,
 * and a patient who still has to accept the current terms is still a
 * patient using the app.
 */
import { Router, type IRouter } from "express";
import { resolvePatient } from "../lib/patient-auth";

export const PATIENT_PRESENCE_PATH = "/patient-data/presence";

export function createPatientPresenceRouter(): IRouter {
  const router: IRouter = Router();
  router.post(PATIENT_PRESENCE_PATH, async (req, res) => {
    try {
      const auth = await resolvePatient(req, { consent: "skip" });
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error, ...auth.details });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      req.log?.error({ err: error }, "patient presence heartbeat failed");
      res.status(502).json({ error: "Couldn't record app activity right now." });
    }
  });
  return router;
}

export default createPatientPresenceRouter();
