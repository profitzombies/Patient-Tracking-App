import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { resolveOfficeScope } from "../auth/office-scope";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { supabaseAdmin } from "../lib/supabase-admin";

const router: IRouter = Router();
const reasons = ["no_activity_14d", "logging_lapsed", "check_in_overdue"] as const;
const UpdateFollowUp = z.object({ status: z.enum(["open", "resolved"]) });
const dateKey = /^\d{4}-\d{2}-\d{2}$/;
const enc = encodeURIComponent;
const RECORD_NOT_FOUND = "No patient record found for this office.";

function utcDateKey(value: string): number | null {
  if (!dateKey.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value
    ? milliseconds
    : null;
}

function followUpDto(row: Record<string, unknown>) {
  return {
    reason: String(row.reason),
    status: String(row.status),
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
  };
}
async function scope(req: Request, permission: "provider_read" | "provider_manage") {
  return resolveOfficeScope({
    authorization: req.headers.authorization,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
    hqPermission: permission,
    requireUnlocked: permission === "provider_manage",
  });
}

router.put("/office/patients/:patientId/follow-ups/:reason", async (req, res) => {
  const parsed = UpdateFollowUp.safeParse(req.body ?? {});
  const reason = String(req.params.reason ?? "");
  if (!parsed.success || !reasons.includes(reason as (typeof reasons)[number])) {
    res.status(400).json({ error: "Check the follow-up status and reason." }); return;
  }
  try {
    const resolved = await scope(req, "provider_manage");
    if (resolved.kind !== "ok") { res.status(resolved.status).json({ error: resolved.message }); return; }
    const office = resolved.scope, patientId = String(req.params.patientId);
    const patient = await supabaseAdmin("GET", `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(office.providerId)}&select=id&limit=1`);
    if (patient.status >= 300) throw new Error(`follow-up patient lookup failed (${patient.status})`);
    if (!Array.isArray(patient.json) || !patient.json[0]) { res.status(404).json({ error: RECORD_NOT_FOUND }); return; }
    const now = new Date().toISOString();
    let row: Record<string, unknown> | undefined;
    if (parsed.data.status === "open") {
      const existing = await supabaseAdmin("GET", `/rest/v1/patient_operational_follow_ups?patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(office.providerId)}&reason=eq.${enc(reason)}&status=eq.open&select=reason,status,created_at,resolved_at&limit=1`);
      if (existing.status >= 300) throw new Error(`follow-up lookup failed (${existing.status})`);
      row = Array.isArray(existing.json) ? existing.json[0] as Record<string, unknown> : undefined;
      if (!row) {
        const inserted = await supabaseAdmin("POST", "/rest/v1/patient_operational_follow_ups", { provider_id: office.providerId, patient_id: patientId, reason, status: "open", created_at: now, created_by: office.actorUserId }, "return=representation");
        if (inserted.status >= 300) {
          // A concurrent opener can win the partial-unique-index race. Its
          // durable open row is the idempotent result rather than an outage.
          if (inserted.status !== 409) throw new Error(`follow-up open failed (${inserted.status})`);
          const winner = await supabaseAdmin("GET", `/rest/v1/patient_operational_follow_ups?patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(office.providerId)}&reason=eq.${enc(reason)}&status=eq.open&select=reason,status,created_at,resolved_at&limit=1`);
          if (winner.status >= 300 || !Array.isArray(winner.json) || !winner.json[0]) throw new Error(`follow-up race lookup failed (${winner.status})`);
          row = winner.json[0] as Record<string, unknown>;
        } else row = (Array.isArray(inserted.json) ? inserted.json[0] : inserted.json) as Record<string, unknown>;
      }
    } else {
      const updated = await supabaseAdmin("PATCH", `/rest/v1/patient_operational_follow_ups?patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(office.providerId)}&reason=eq.${enc(reason)}&status=eq.open`, { status: "resolved", resolved_at: now, resolved_by: office.actorUserId }, "return=representation");
      if (updated.status >= 300) throw new Error(`follow-up resolve failed (${updated.status})`);
      row = Array.isArray(updated.json) ? updated.json[0] as Record<string, unknown> : undefined;
      if (!row) {
        const previous = await supabaseAdmin("GET", `/rest/v1/patient_operational_follow_ups?patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(office.providerId)}&reason=eq.${enc(reason)}&status=eq.resolved&select=reason,status,created_at,resolved_at&order=resolved_at.desc&limit=1`);
        if (previous.status >= 300) throw new Error(`follow-up resolved lookup failed (${previous.status})`);
        row = Array.isArray(previous.json) ? previous.json[0] as Record<string, unknown> : undefined;
      }
      if (!row) {
        const inserted = await supabaseAdmin("POST", "/rest/v1/patient_operational_follow_ups", { provider_id: office.providerId, patient_id: patientId, reason, status: "resolved", created_at: now, created_by: office.actorUserId, resolved_at: now, resolved_by: office.actorUserId }, "return=representation");
        if (inserted.status >= 300) throw new Error(`follow-up resolved create failed (${inserted.status})`);
        row = (Array.isArray(inserted.json) ? inserted.json[0] : inserted.json) as Record<string, unknown>;
      }
    }
    await recordAdminAuditEvent({ action: `patient_follow_up_${parsed.data.status}`, actorUserId: office.actorUserId, actorKind: office.actorKind, providerId: office.providerId, targetKind: "patient_follow_up", targetId: patientId, requestId: req.headers["x-request-id"]?.toString() ?? null, metadata: { reason } }).catch(error => req.log?.error({ err: error }, "patient follow-up audit failed"));
    res.json({ followUp: followUpDto(row) });
  } catch (error) { req.log?.error({ err: error }, "office follow-up failed"); res.status(502).json({ error: "Something went wrong on our side. Please try again." }); }
});

router.get("/office/engagement-trends", async (req, res) => {
  const start = typeof req.query.start === "string" ? req.query.start : "";
  const end = typeof req.query.end === "string" ? req.query.end : "";
  const startMs = utcDateKey(start), endMs = utcDateKey(end);
  if (startMs === null || endMs === null || startMs > endMs || (endMs - startMs) / 86_400_000 + 1 > 366) {
    res.status(400).json({ error: "Use valid start and end date keys spanning at most 366 days." }); return;
  }
  try {
    const resolved = await scope(req, "provider_read");
    if (resolved.kind !== "ok") { res.status(resolved.status).json({ error: resolved.message }); return; }
    const office = resolved.scope;
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/provider_engagement_daily", { p_provider_id: office.providerId, p_start: start, p_end: end });
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`engagement trends failed (${result.status})`);
    res.json({ office: { providerId: office.providerId, officeName: office.officeName }, range: { start, end }, asOf: new Date().toISOString(), definition: "Engaged patients are the distinct active, non-invited patients with a meal, water, check-in, progress photo, or weight record on that date.", points: result.json });
  } catch (error) { req.log?.error({ err: error }, "office engagement trends failed"); res.status(502).json({ error: "Something went wrong on our side. Please try again." }); }
});
export default router;