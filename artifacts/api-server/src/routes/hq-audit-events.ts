import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireHqPermission } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";

const router: IRouter = Router();
const query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  provider: z.string().trim().min(1).max(240).optional(),
  action: z.string().trim().min(1).max(120).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const allowedActions = new Set([
  "patient_invitation_created",
  "patient_invitation_resent",
  "patient_follow_up_open",
  "patient_follow_up_resolved",
  "patient_profile_updated",
  "patient_status_changed",
  "patient_note_added",
  "patient_note_deleted",
  "patient_weight_recorded",
  "patient_weight_updated",
  "patient_weight_removed",
  "patient_measurements_recorded",
  "patient_measurements_removed",
  "provider_account_created",
  "provider_account_updated",
  "hq_team_invited",
  "hq_team_updated",
  "hq_team_revoked",
  "hq_settings_updated",
  "hq_file_uploaded",
  "hq_file_deleted",
  "conversation_transcript_read",
  "data_export_requested",
  "data_export_downloaded",
]);
const allowedMetadata = new Set(["reason", "role", "status", "field", "fields", "from", "to", "size", "contentType", "thread", "kind", "office", "rows", "noteId", "weightId", "visitId", "areaCount", "dateKey"]);
const enc = encodeURIComponent;
function utcDate(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}
function dto(row: Record<string, unknown>) {
  const source = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
  const metadata = Object.fromEntries(Object.entries(source).filter(([key, value]) => allowedMetadata.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)));
  return { id: Number(row.id), occurredAt: String(row.occurred_at), action: String(row.action), actorUserId: row.actor_user_id ? String(row.actor_user_id) : null, actorKind: String(row.actor_kind), providerId: row.provider_id ? String(row.provider_id) : null, targetKind: row.target_kind ? String(row.target_kind) : null, targetId: row.target_id ? String(row.target_id) : null, requestId: row.request_id ? String(row.request_id) : null, metadata };
}
router.get("/hq/audit-events", requireHqPermission("audit_read"), async (req, res) => {
  const parsed = query.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Check audit event filters." }); return; }
  const q = parsed.data;
  const fromMs = utcDate(q.from), toMs = utcDate(q.to);
  if (
    (q.action && !allowedActions.has(q.action)) ||
    (q.from && fromMs === null) ||
    (q.to && toMs === null) ||
    (fromMs !== null && toMs !== null && (fromMs > toMs || (toMs - fromMs) / 86_400_000 + 1 > 366))
  ) {
    res.status(400).json({ error: "Check audit event filters." }); return;
  }
  const filters = [
    "select=id,occurred_at,action,actor_user_id,actor_kind,provider_id,target_kind,target_id,request_id,metadata",
    `action=in.(${[...allowedActions].join(",")})`,
    "order=occurred_at.desc,id.desc",
    `limit=${q.limit}`,
    `offset=${q.offset}`,
  ];
  if (q.provider) filters.push(`provider_id=eq.${enc(q.provider)}`);
  if (q.action) filters.push(`action=eq.${enc(q.action)}`);
  if (q.from) filters.push(`occurred_at=gte.${enc(`${q.from}T00:00:00Z`)}`);
  if (q.to && toMs !== null) filters.push(`occurred_at=lt.${enc(new Date(toMs + 86_400_000).toISOString())}`);
  try {
    const result = await supabaseAdmin("GET", `/rest/v1/admin_audit_events?${filters.join("&")}`, undefined, "count=exact");
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`audit list failed (${result.status})`);
    const totalHeader = result.contentRange?.match(/\/(\d+)$/)?.[1];
    const total = totalHeader ? Number(totalHeader) : undefined;
    const events = result.json
      .filter((row) => allowedActions.has(String((row as Record<string, unknown>).action)))
      .map((row) => dto(row as Record<string, unknown>));
    res.json({ events, ...(total !== undefined ? { total } : { hasMore: result.json.length === q.limit }) });
  } catch (error) { req.log?.error({ err: error }, "HQ audit list failed"); res.status(502).json({ error: "Could not load audit events right now." }); }
});
export default router;
