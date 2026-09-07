/**
 * HQ visibility into patient account deletions.
 *
 *  - GET  /hq/patient-deletions?status=      lifecycle rows (ids and counts only — no PII)
 *  - POST /hq/patient-deletions/:id/retry    re-arm a failed purge right now
 *
 * Failed purges are the point: a half-done purge must be seen and finished,
 * never left quietly stuck. The list is the same table the worker drives.
 */
import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { DELETION_SELECT, drainDuePurges, type DeletionRequestRow } from "../privacy/purge";

const router: IRouter = Router();
const enc = encodeURIComponent;

const STATUSES = ["pending", "cancelled", "purging", "purged", "failed"] as const;

const Query = z.object({
  status: z.enum(STATUSES).optional(),
  limit: z.coerce.number().min(1).max(200).default(100),
});

export interface HqPatientDeletionDto {
  id: string;
  patientId: string;
  providerId: string | null;
  status: DeletionRequestRow["status"];
  requestedAt: string;
  purgeAfter: string;
  cancelledAt: string | null;
  startedAt: string | null;
  purgedAt: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  steps: Record<string, unknown>;
}

export function hqDeletionDto(row: DeletionRequestRow): HqPatientDeletionDto {
  return {
    id: row.id,
    patientId: row.patient_id,
    providerId: row.provider_id,
    status: row.status,
    requestedAt: row.requested_at,
    purgeAfter: row.purge_after,
    cancelledAt: row.cancelled_at,
    startedAt: row.started_at,
    purgedAt: row.purged_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    steps: row.steps && typeof row.steps === "object" ? row.steps : {},
  };
}

function staffOf(res: Response): StaffIdentity {
  return res.locals.staff as StaffIdentity;
}

router.get("/hq/patient-deletions", requireHqPermission("audit_read"), async (req, res) => {
  const parsed = Query.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Check the deletion filters." });
    return;
  }
  try {
    const filters = [`select=${DELETION_SELECT}`, "order=requested_at.desc", `limit=${Math.floor(parsed.data.limit)}`];
    if (parsed.data.status) filters.push(`status=eq.${enc(parsed.data.status)}`);
    const [list, counts] = await Promise.all([
      supabaseAdmin("GET", `/rest/v1/patient_deletion_requests?${filters.join("&")}`),
      supabaseAdmin("GET", `/rest/v1/patient_deletion_requests?select=status&limit=5000`),
    ]);
    if (list.status >= 300 || !Array.isArray(list.json)) throw new Error(`deletion list failed (${list.status})`);
    if (counts.status >= 300 || !Array.isArray(counts.json)) throw new Error(`deletion counts failed (${counts.status})`);
    const summary: Record<(typeof STATUSES)[number], number> = { pending: 0, cancelled: 0, purging: 0, purged: 0, failed: 0 };
    for (const row of counts.json as Array<{ status: string }>) {
      if (row.status in summary) summary[row.status as (typeof STATUSES)[number]] += 1;
    }
    res.json({ deletions: (list.json as DeletionRequestRow[]).map(hqDeletionDto), summary });
  } catch (error) {
    req.log?.error({ err: error }, "HQ deletion list failed");
    res.status(502).json({ error: "Could not load account deletions right now." });
  }
});

router.post("/hq/patient-deletions/:id/retry", requireHqPermission("provider_manage"), async (req, res) => {
  const id = String(req.params.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(404).json({ error: "Deletion request not found." });
    return;
  }
  try {
    const patched = await supabaseAdmin(
      "PATCH",
      `/rest/v1/patient_deletion_requests?id=eq.${enc(id)}&status=eq.failed&select=${DELETION_SELECT}`,
      { next_attempt_at: new Date().toISOString(), last_error: null },
      "return=representation",
    );
    if (patched.status >= 300 || !Array.isArray(patched.json)) throw new Error(`deletion retry failed (${patched.status})`);
    const row = patched.json[0] as DeletionRequestRow | undefined;
    if (!row) {
      res.status(409).json({ error: "Only a failed purge can be retried." });
      return;
    }
    const staff = staffOf(res);
    await recordAdminAuditEvent({
      action: "patient_deletion_retried",
      actorUserId: staff.userId,
      actorKind: "hq",
      providerId: row.provider_id,
      targetKind: "patient",
      targetId: row.patient_id,
      requestId: req.headers["x-request-id"]?.toString() ?? null,
      metadata: { requestId: row.id, attempt: row.attempts },
    }).catch((error) => req.log?.error({ err: error }, "deletion retry audit failed"));
    void drainDuePurges();
    res.json({ deletion: hqDeletionDto(row) });
  } catch (error) {
    req.log?.error({ err: error }, "HQ deletion retry failed");
    res.status(502).json({ error: "Could not retry that purge right now." });
  }
});

export default router;
