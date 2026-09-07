/**
 * Office-scoped notification timeline for the live patient record.
 *
 *   GET /office/patients/:id/notifications?office=<hq only>
 *
 * The patient lookup is scoped in the same query as the roster detail route:
 * an unknown id and another office's id answer the identical 404 and no
 * outbox rows are read. Returns the newest notifications (any kind) with
 * their derived event timelines plus the roster's outreach chip state, so the
 * record and the roster never disagree.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { resolveOfficeScope } from "../auth/office-scope";
import { supabaseAdmin } from "../lib/supabase-admin";
import { supabaseNotificationStore, type NotificationStore } from "../notifications/store";
import { buildTimeline, outreachRosterDto, type OutreachStateRpcRow } from "../notifications/timeline";

const enc = encodeURIComponent;
const RECORD_NOT_FOUND = "Patient record not found.";
const SERVER_ERROR = "The patient record is unavailable right now.";
const TIMELINE_LIMIT = 50;

export function createOfficeNotificationsRouter(store: NotificationStore = supabaseNotificationStore): IRouter {
  const router: IRouter = Router();

  router.get("/office/patients/:id/notifications", async (req: Request, res: Response) => {
    try {
      const resolved = await resolveOfficeScope({
        authorization: req.headers.authorization,
        explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
        hqPermission: "provider_read",
        requireUnlocked: false,
      });
      if (resolved.kind !== "ok") {
        res.status(resolved.status).json({ error: resolved.message });
        return;
      }
      const scope = resolved.scope;
      const patientId = String(req.params.id ?? "");
      const found = await supabaseAdmin(
        "GET",
        `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}&select=id&limit=1`,
      );
      if (found.status >= 300) throw new Error(`patient lookup failed (${found.status})`);
      if (!Array.isArray(found.json) || !found.json[0]) {
        res.status(404).json({ error: RECORD_NOT_FOUND });
        return;
      }
      const [rows, states] = await Promise.all([
        store.listPatientNotifications(patientId, TIMELINE_LIMIT),
        supabaseAdmin("POST", "/rest/v1/rpc/provider_outreach_states", { p_provider_id: scope.providerId }),
      ]);
      if (states.status >= 300) throw new Error(`outreach state load failed (${states.status})`);
      const attempts = await store.listAttempts(rows.map((row) => row.id));
      const stateRow = (Array.isArray(states.json) ? (states.json as OutreachStateRpcRow[]) : []).find(
        (row) => String(row.patient_id) === patientId,
      );
      res.json({
        patientId,
        outreach: outreachRosterDto(stateRow),
        notifications: buildTimeline(rows, attempts),
      });
    } catch (error) {
      req.log?.error({ err: error }, "office notification timeline failed");
      res.status(502).json({ error: SERVER_ERROR });
    }
  });

  return router;
}

const router: IRouter = createOfficeNotificationsRouter();
export default router;
