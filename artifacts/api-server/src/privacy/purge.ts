/**
 * Account deletion lifecycle and the purge that ends it.
 *
 *   request (grace period) ──cancel-on-sign-in──▶ cancelled
 *          │ purge_after passes
 *          ▼
 *   claim (leased) ─▶ purge steps ─▶ purged
 *                          │ any step throws
 *                          ▼
 *                       failed (retry with backoff; HQ can retry by hand)
 *
 * Purge steps, in this order and each idempotent on re-run:
 *   1. storage  — delete every object under the patient's media prefix
 *                 (photos, chat images, food/recipe images, export archives).
 *                 Needs nothing from the rows, so it is safe to run before
 *                 they go — and a re-run after the rows are gone still works.
 *   2. rows     — `patient_purge_rows` RPC: one transaction that writes the
 *                 PII-free tombstone, deletes every row in every public
 *                 table carrying patient_id (enumerated live in SQL), detaches
 *                 append-only analytics rows, and deletes the patient row.
 *                 Push tokens, notifications, consents, and exports are
 *                 patient_id tables, so they go here too.
 *   3. auth     — delete the GoTrue user (the auth_user_id was captured on
 *                 the request row at request time). GoTrue cascades sessions,
 *                 refresh tokens, identities, and MFA factors. 404 = already
 *                 gone = done.
 *
 * The request row itself has no FK to the patient and survives, carrying
 * per-step counts in `steps` so HQ can see exactly what happened.
 */
import { logger } from "../lib/logger";
import { objectStorage } from "../lib/objectStorage";
import { supabaseAdmin } from "../lib/supabase-admin";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { PATIENT_MEDIA_PREFIX } from "../routes/patient-media";

const enc = encodeURIComponent;

export const DELETION_SELECT =
  "id,patient_id,provider_id,auth_user_id,status,requested_at,purge_after,cancelled_at,started_at,purged_at,attempts,next_attempt_at,lease_owner,lease_until,last_error,steps";

export interface DeletionRequestRow {
  id: string;
  patient_id: string;
  provider_id: string | null;
  auth_user_id: string | null;
  status: "pending" | "cancelled" | "purging" | "purged" | "failed";
  requested_at: string;
  purge_after: string;
  cancelled_at: string | null;
  started_at: string | null;
  purged_at: string | null;
  attempts: number;
  next_attempt_at: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  last_error: string | null;
  steps: Record<string, unknown>;
}

/** Grace period before a purge runs. Seconds override wins (staging); blank env = default. */
export function deletionGraceSeconds(): number {
  const seconds = process.env.PATIENT_DELETION_GRACE_SECONDS;
  if (seconds !== undefined && seconds.trim() !== "") {
    const value = Number(seconds);
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  const days = process.env.PATIENT_DELETION_GRACE_DAYS;
  if (days !== undefined && days.trim() !== "") {
    const value = Number(days);
    if (Number.isFinite(value) && value >= 0) return Math.floor(value * 86_400);
  }
  return 7 * 86_400;
}

/** Attempts before the worker stops retrying on its own (HQ retry still works). */
export const MAX_AUTOMATIC_ATTEMPTS = 8;

export function retryDelaySeconds(attempt: number): number {
  // 5 min, 10, 20, 40, 80, 160, ... capped at 6 hours.
  return Math.min(6 * 3600, 300 * 2 ** Math.max(0, attempt - 1));
}

export interface PurgeSummary {
  patientRowDeleted: boolean;
  tombstone: boolean;
  analyticsDetached: number;
  tables: Record<string, number>;
  authUserId: string | null;
}

export interface PurgeDeps {
  deleteStoragePrefix: (prefix: string) => Promise<number>;
  purgeRows: (requestId: string) => Promise<PurgeSummary>;
  deleteAuthUser: (userId: string) => Promise<"deleted" | "absent">;
  finish: (input: {
    requestId: string;
    status: "purged" | "failed";
    error?: string | null;
    steps: Record<string, unknown>;
    retryAfterSeconds?: number | null;
  }) => Promise<void>;
  audit: (input: Parameters<typeof recordAdminAuditEvent>[0]) => Promise<void>;
  now?: () => Date;
}

export const defaultPurgeDeps: PurgeDeps = {
  deleteStoragePrefix: (prefix) => objectStorage.deletePrefixStrict(prefix),
  async purgeRows(requestId) {
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_purge_rows", { p_request_id: requestId });
    if (result.status >= 300 || !result.json || typeof result.json !== "object") {
      throw new Error(`row purge failed (${result.status})`);
    }
    const summary = result.json as Record<string, unknown>;
    return {
      patientRowDeleted: summary.patientRowDeleted === true,
      tombstone: summary.tombstone === true,
      analyticsDetached: Number(summary.analyticsDetached ?? 0),
      tables: (summary.tables && typeof summary.tables === "object" ? summary.tables : {}) as Record<string, number>,
      authUserId: typeof summary.authUserId === "string" ? summary.authUserId : null,
    };
  },
  async deleteAuthUser(userId) {
    const result = await supabaseAdmin("DELETE", `/auth/v1/admin/users/${enc(userId)}`);
    if (result.status === 404) return "absent";
    if (result.status >= 300) throw new Error(`auth user delete failed (${result.status})`);
    return "deleted";
  },
  async finish(input) {
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_deletion_finish", {
      p_request_id: input.requestId,
      p_status: input.status,
      p_error: input.error ?? null,
      p_steps: input.steps,
      p_retry_after_seconds: input.retryAfterSeconds ?? null,
    });
    if (result.status >= 300) throw new Error(`deletion finish failed (${result.status})`);
  },
  audit: (input) => recordAdminAuditEvent(input),
};

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300) || "Purge failed.";
}

export function patientStoragePrefix(patientId: string): string {
  return `${PATIENT_MEDIA_PREFIX}${patientId}/`;
}

/**
 * Run every purge step for one claimed request. Never throws: the outcome
 * lands on the request row (purged, or failed with the step that broke and
 * when to retry) and in the audit log.
 */
export async function runPurge(request: DeletionRequestRow, deps: PurgeDeps = defaultPurgeDeps): Promise<"purged" | "failed"> {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const steps: Record<string, unknown> = { ...(request.steps ?? {}) };
  let step = "storage";
  try {
    const objects = await deps.deleteStoragePrefix(patientStoragePrefix(request.patient_id));
    steps.storage = { ok: true, objects, at: now() };

    step = "rows";
    const summary = await deps.purgeRows(request.id);
    const tableCount = Object.keys(summary.tables).length;
    const rowCount = Object.values(summary.tables).reduce((sum, n) => sum + Number(n || 0), 0);
    steps.rows = {
      ok: true,
      tables: tableCount,
      rows: rowCount,
      tombstone: summary.tombstone,
      patientRowDeleted: summary.patientRowDeleted,
      analyticsDetached: summary.analyticsDetached,
      at: now(),
    };
    if (!summary.tombstone) throw new Error("tombstone missing after row purge");

    step = "auth";
    const authUserId = request.auth_user_id ?? summary.authUserId;
    if (authUserId) {
      const outcome = await deps.deleteAuthUser(authUserId);
      steps.auth = { ok: true, outcome, at: now() };
    } else {
      steps.auth = { ok: true, outcome: "none", at: now() };
    }

    await deps.finish({ requestId: request.id, status: "purged", steps });
    await deps
      .audit({
        action: "patient_deletion_purged",
        actorUserId: null,
        actorKind: "system",
        providerId: request.provider_id,
        targetKind: "patient",
        targetId: request.patient_id,
        requestId: null,
        metadata: { requestId: request.id, attempt: request.attempts, objects: Number((steps.storage as { objects: number }).objects), tables: tableCount, rows: rowCount },
      })
      .catch((error) => logger.error({ err: error }, "deletion purge audit failed"));
    return "purged";
  } catch (error) {
    logger.error({ err: error, requestId: request.id, step }, "patient purge step failed");
    steps[step] = { ok: false, error: shortError(error), at: now() };
    const retryAfterSeconds = request.attempts < MAX_AUTOMATIC_ATTEMPTS ? retryDelaySeconds(request.attempts) : null;
    try {
      await deps.finish({ requestId: request.id, status: "failed", error: `${step}: ${shortError(error)}`, steps, retryAfterSeconds });
    } catch (finishError) {
      logger.error({ err: finishError, requestId: request.id }, "patient purge failure not recorded");
    }
    await deps
      .audit({
        action: "patient_deletion_failed",
        actorUserId: null,
        actorKind: "system",
        providerId: request.provider_id,
        targetKind: "patient",
        targetId: request.patient_id,
        requestId: null,
        metadata: { requestId: request.id, attempt: request.attempts, step },
      })
      .catch((auditError) => logger.error({ err: auditError }, "deletion failure audit failed"));
    return "failed";
  }
}

const LEASE_OWNER = `api-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

let draining: Promise<number> | null = null;

/** Claim every due deletion (pending past its grace, failed past its retry, or stale lease) and purge it. */
export function drainDuePurges(maxRequests = 5, deps: PurgeDeps = defaultPurgeDeps): Promise<number> {
  if (draining) return draining;
  draining = (async () => {
    let ran = 0;
    try {
      const claimed = await supabaseAdmin("POST", "/rest/v1/rpc/claim_due_patient_deletions", {
        p_owner: LEASE_OWNER,
        p_limit: maxRequests,
        p_lease_seconds: 600,
      });
      if (claimed.status >= 300 || !Array.isArray(claimed.json)) {
        throw new Error(`deletion claim failed (${claimed.status})`);
      }
      for (const request of claimed.json as DeletionRequestRow[]) {
        await runPurge(request, deps);
        ran += 1;
      }
    } catch (error) {
      logger.error({ err: error }, "deletion drain stopped");
    } finally {
      draining = null;
    }
    return ran;
  })();
  return draining;
}
