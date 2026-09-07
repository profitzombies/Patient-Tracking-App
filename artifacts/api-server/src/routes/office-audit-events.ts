/**
 * Office audit trail — GET /api/office/audit-events
 *
 * An office owner or admin sees what happened in THEIR office: every
 * office-visible event whose provider_id is the caller's office, newest
 * first, with date and action filters and offset pagination. HQ can read the
 * same view for one office with `?office=` (audit_read).
 *
 * The office DTO carries names only — actor, office, and target resolve to
 * people and records server-side, and raw auth user ids / provider ids never
 * leave the API. Cross-office events cannot appear: the provider_id filter
 * is the resolved scope, never a client input, and rows without an office
 * (HQ-only actions) are excluded by construction.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  canManageOffice,
  resolveOfficeScope,
  respondOfficeScopeDenied,
} from "../auth/office-scope";
import { recordAccessDenied } from "../lib/admin-audit";
import { supabaseAdmin } from "../lib/supabase-admin";
import {
  OFFICE_VISIBLE_ACTIONS,
  actorLabel,
  auditFilters,
  auditWindow,
  officeVisibleActions,
  resolveAuditNames,
  safeMetadata,
  targetLabel,
  type AuditRow,
} from "../lib/audit-events";

const router: IRouter = Router();
export const OFFICE_AUDIT_PATH = "/office/audit-events";
export const AUDIT_MANAGERS_ONLY_MESSAGE = "Only office owners and admins can see the audit trail.";

const query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  action: z.string().trim().min(1).max(120).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  office: z.string().trim().min(1).max(240).optional(),
});

export interface OfficeAuditEventDto {
  id: number;
  occurredAt: string;
  action: string;
  actorName: string;
  actorKind: string;
  targetName: string | null;
  targetKind: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

router.get(OFFICE_AUDIT_PATH, async (req, res) => {
  const parsed = query.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Check audit event filters." }); return; }
  const q = parsed.data;
  const window = auditWindow({ action: q.action, from: q.from, to: q.to, actions: officeVisibleActions });
  if (!window) { res.status(400).json({ error: "Check audit event filters." }); return; }
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      explicitOfficeId: q.office ?? null,
      hqPermission: "audit_read",
      requireUnlocked: false,
    });
    if (resolved.kind !== "ok") { respondOfficeScopeDenied(req, res, resolved); return; }
    const scope = resolved.scope;
    if (!canManageOffice(scope)) {
      res.status(403).json({ error: AUDIT_MANAGERS_ONLY_MESSAGE });
      recordAccessDenied(req, {
        actorUserId: scope.actorUserId,
        actorKind: scope.actorKind,
        providerId: scope.providerId,
        reason: "permission",
        status: 403,
      });
      return;
    }
    const filters = auditFilters({
      actions: OFFICE_VISIBLE_ACTIONS,
      action: q.action,
      from: q.from,
      toMs: window.toMs,
      provider: scope.providerId,
      limit: q.limit,
      offset: q.offset,
    });
    const result = await supabaseAdmin("GET", `/rest/v1/admin_audit_events?${filters.join("&")}`, undefined, "count=exact");
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`office audit list failed (${result.status})`);
    const totalHeader = result.contentRange?.match(/\/(\d+)$/)?.[1];
    const total = totalHeader ? Number(totalHeader) : undefined;
    // Defense in depth: even if the store returned a stray row, only this
    // office's allow-listed events are shaped into the response.
    const rows = (result.json as AuditRow[]).filter(
      (row) => officeVisibleActions.has(String(row.action)) && String(row.provider_id ?? "") === scope.providerId,
    );
    const names = await resolveAuditNames(rows);
    const events: OfficeAuditEventDto[] = rows.map((row) => ({
      id: Number(row.id),
      occurredAt: String(row.occurred_at),
      action: String(row.action),
      actorName: actorLabel(row, names),
      actorKind: String(row.actor_kind),
      targetName: targetLabel(row, names),
      targetKind: row.target_kind ? String(row.target_kind) : null,
      metadata: safeMetadata(row.metadata),
    }));
    res.json({
      office: { name: scope.officeName },
      actions: OFFICE_VISIBLE_ACTIONS,
      events,
      ...(total !== undefined ? { total } : { hasMore: rows.length === q.limit }),
    });
  } catch (error) {
    req.log?.error({ err: error }, "office audit list failed");
    res.status(502).json({ error: "Could not load the audit trail right now." });
  }
});

export default router;
