/**
 * HQ audit trail — GET /api/hq/audit-events
 *
 * Every allow-listed event across every office, filterable by office
 * (`provider`), action, and a ≤ 366-day date window. Actor, office, and
 * target names are resolved server-side so the page shows people and
 * offices; the raw ids stay on the DTO for HQ drill-ins. Metadata passes
 * through the shared allowlist only.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireHqPermission } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import {
  AUDIT_ACTIONS,
  actorLabel,
  allowedActions,
  auditFilters,
  auditWindow,
  officeLabel,
  resolveAuditNames,
  safeMetadata,
  targetLabel,
  type AuditRow,
} from "../lib/audit-events";

const router: IRouter = Router();
const query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  provider: z.string().trim().min(1).max(240).optional(),
  action: z.string().trim().min(1).max(120).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
router.get("/hq/audit-events", requireHqPermission("audit_read"), async (req, res) => {
  const parsed = query.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Check audit event filters." }); return; }
  const q = parsed.data;
  const window = auditWindow({ action: q.action, from: q.from, to: q.to, actions: allowedActions });
  if (!window) { res.status(400).json({ error: "Check audit event filters." }); return; }
  const filters = auditFilters({
    actions: AUDIT_ACTIONS,
    action: q.action,
    from: q.from,
    toMs: window.toMs,
    provider: q.provider,
    limit: q.limit,
    offset: q.offset,
  });
  try {
    const result = await supabaseAdmin("GET", `/rest/v1/admin_audit_events?${filters.join("&")}`, undefined, "count=exact");
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`audit list failed (${result.status})`);
    const totalHeader = result.contentRange?.match(/\/(\d+)$/)?.[1];
    const total = totalHeader ? Number(totalHeader) : undefined;
    const rows = (result.json as AuditRow[]).filter((row) => allowedActions.has(String(row.action)));
    const names = await resolveAuditNames(rows);
    const events = rows.map((row) => ({
      id: Number(row.id),
      occurredAt: String(row.occurred_at),
      action: String(row.action),
      actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      actorKind: String(row.actor_kind),
      actorName: actorLabel(row, names),
      providerId: row.provider_id ? String(row.provider_id) : null,
      officeName: officeLabel(row, names),
      targetKind: row.target_kind ? String(row.target_kind) : null,
      targetId: row.target_id ? String(row.target_id) : null,
      targetName: targetLabel(row, names),
      requestId: row.request_id ? String(row.request_id) : null,
      metadata: safeMetadata(row.metadata),
    }));
    res.json({ events, ...(total !== undefined ? { total } : { hasMore: rows.length === q.limit }) });
  } catch (error) { req.log?.error({ err: error }, "HQ audit list failed"); res.status(502).json({ error: "Could not load audit events right now." }); }
});
export default router;
