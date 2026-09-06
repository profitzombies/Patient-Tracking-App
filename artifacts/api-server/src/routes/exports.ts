/**
 * CSV export jobs for HQ and office staff.
 *
 *   POST /exports                    request one (202 + job)
 *   GET  /exports                    the caller's recent jobs
 *   GET  /exports/:id                poll one job
 *   GET  /exports/:id/download-url   short-lived signed link for a ready job
 *
 * Scope is authorised and frozen at request time (see exports/kinds.ts);
 * every later read is pinned to `requested_by = caller`, so a job id alone
 * never unlocks someone else's file. Requests and downloads are audited
 * with metadata only (kind, office, row count) — never file contents.
 */
import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { objectStorage } from "../lib/objectStorage";
import { supabaseAdmin } from "../lib/supabase-admin";
import { parseRange } from "./operational-rollups";
import {
  authorizeExport,
  exportFileName,
  EXPORT_KINDS,
  EXPORT_KIND_LABELS,
  RANGED_KINDS,
  resolveExportRequester,
  type ExportKind,
  type ExportRequester,
} from "../exports/kinds";
import { drainQueuedExports, type ExportJobRow } from "../exports/worker";

const router: IRouter = Router();
const enc = encodeURIComponent;

/** How long a finished export stays downloadable. */
export function exportTtlHours(): number {
  const raw = process.env.EXPORT_TTL_HOURS;
  if (raw === undefined || raw.trim() === "") return 24;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 && value <= 24 * 7 ? value : 24;
}
/** Signed download links are single-use in spirit: minutes, not hours. */
export const DOWNLOAD_URL_TTL_SEC = 300;
/** Per-requester ceiling on jobs still queued/running. */
const MAX_PENDING_PER_REQUESTER = 5;

const RequestBody = z.object({
  kind: z.enum(EXPORT_KINDS),
  office: z.string().trim().min(1).max(240).optional().nullable(),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const JOB_SELECT =
  "id,kind,status,requested_by,requester_kind,requester_role,provider_id,params,file_name,object_path,size_bytes,row_count,error,attempts,created_at,started_at,completed_at,expires_at,download_count,last_downloaded_at";

export function exportJobDto(row: ExportJobRow, now = Date.now()) {
  const params = row.params ?? {};
  const expiresMs = Date.parse(row.expires_at);
  const expired = row.status === "expired" || (Number.isFinite(expiresMs) && expiresMs <= now);
  const status = expired && (row.status === "ready" || row.status === "failed") ? "expired" : row.status;
  return {
    id: row.id,
    kind: row.kind as ExportKind,
    label: EXPORT_KIND_LABELS[row.kind as ExportKind] ?? row.kind,
    status: status as "queued" | "running" | "ready" | "failed" | "expired",
    scope: {
      providerId: row.provider_id,
      officeName: typeof params.officeName === "string" ? params.officeName : null,
    },
    range:
      typeof params.start === "string" && typeof params.end === "string"
        ? { start: params.start, end: params.end }
        : null,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    rowCount: row.row_count,
    error: status === "failed" ? row.error : status === "expired" && row.error ? row.error : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    downloadCount: row.download_count,
    downloadable: status === "ready" && Boolean(row.object_path),
  };
}

export type ExportJobDto = ReturnType<typeof exportJobDto>;

async function requester(req: Request): Promise<ExportRequester | null> {
  const resolved = await resolveExportRequester(req.headers.authorization);
  if (resolved.kind !== "ok") {
    req.res?.status(resolved.status).json({ error: resolved.message });
    return null;
  }
  return resolved.requester;
}

async function ownJob(jobId: string, userId: string): Promise<ExportJobRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/data_exports?id=eq.${enc(jobId)}&requested_by=eq.${enc(userId)}&select=${JOB_SELECT}&limit=1`,
  );
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`export lookup failed (${res.status})`);
  return (res.json[0] as ExportJobRow | undefined) ?? null;
}

function auditActor(who: ExportRequester): { actorUserId: string; actorKind: "hq" | "provider" | "team_member" } {
  return who.kind === "hq"
    ? { actorUserId: who.userId, actorKind: "hq" }
    : { actorUserId: who.userId, actorKind: who.actorKind };
}

router.post("/exports", async (req, res) => {
  const parsed = RequestBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Choose an export type (and a valid date range)." });
    return;
  }
  const body = parsed.data;
  const range = RANGED_KINDS.has(body.kind) ? parseRange({ start: body.start, end: body.end }) : null;
  if (RANGED_KINDS.has(body.kind) && !range) {
    res.status(400).json({ error: "Use valid start and end date keys spanning at most 366 days." });
    return;
  }
  try {
    const who = await requester(req);
    if (!who) return;
    const authorized = await authorizeExport({
      requester: who,
      authorization: req.headers.authorization,
      kind: body.kind,
      requestedOffice: body.office ?? null,
      range,
    });
    if (authorized.kind !== "ok") {
      res.status(authorized.status).json({ error: authorized.message });
      return;
    }
    const scope = authorized.scope;

    const pending = await supabaseAdmin(
      "GET",
      `/rest/v1/data_exports?requested_by=eq.${enc(who.userId)}&status=in.(queued,running)&select=id&limit=${MAX_PENDING_PER_REQUESTER + 1}`,
    );
    if (pending.status >= 300 || !Array.isArray(pending.json)) throw new Error(`export backlog check failed (${pending.status})`);
    if (pending.json.length >= MAX_PENDING_PER_REQUESTER) {
      res.status(429).json({ error: "You already have several exports in progress. Wait for one to finish." });
      return;
    }

    const expiresAt = new Date(Date.now() + exportTtlHours() * 3_600_000).toISOString();
    const inserted = await supabaseAdmin(
      "POST",
      "/rest/v1/data_exports",
      {
        kind: body.kind,
        status: "queued",
        requested_by: who.userId,
        requester_kind: scope.requesterKind,
        requester_role: scope.requesterRole,
        provider_id: scope.providerId,
        params: {
          ...(scope.range ? { start: scope.range.start, end: scope.range.end } : {}),
          ...(scope.officeName ? { officeName: scope.officeName } : {}),
        },
        file_name: exportFileName(body.kind, scope),
        expires_at: expiresAt,
      },
      "return=representation",
    );
    if (inserted.status >= 300 || !Array.isArray(inserted.json) || inserted.json.length !== 1) {
      throw new Error(`export insert failed (${inserted.status})`);
    }
    const job = inserted.json[0] as ExportJobRow;
    await recordAdminAuditEvent({
      action: "data_export_requested",
      ...auditActor(who),
      providerId: scope.providerId,
      targetKind: "data_export",
      targetId: job.id,
      requestId: req.headers["x-request-id"]?.toString() ?? null,
      metadata: { kind: body.kind, office: scope.providerId ?? "all" },
    });
    // Kick the worker so small exports finish before the first poll.
    void drainQueuedExports();
    res.status(202).json({ job: exportJobDto(job) });
  } catch (error) {
    req.log?.error({ err: error }, "export request failed");
    res.status(502).json({ error: "Could not start that export right now." });
  }
});

router.get("/exports", async (req, res) => {
  try {
    const who = await requester(req);
    if (!who) return;
    const rows = await supabaseAdmin(
      "GET",
      `/rest/v1/data_exports?requested_by=eq.${enc(who.userId)}&select=${JOB_SELECT}&order=created_at.desc&limit=50`,
    );
    if (rows.status >= 300 || !Array.isArray(rows.json)) throw new Error(`export list failed (${rows.status})`);
    const now = Date.now();
    res.json({
      jobs: (rows.json as ExportJobRow[]).map((row) => exportJobDto(row, now)),
      available: availableKinds(who),
      ttlHours: exportTtlHours(),
    });
  } catch (error) {
    req.log?.error({ err: error }, "export list failed");
    res.status(502).json({ error: "Could not load exports right now." });
  }
});

router.get("/exports/:id", async (req, res) => {
  try {
    const who = await requester(req);
    if (!who) return;
    const job = await ownJob(req.params.id, who.userId);
    if (!job) {
      res.status(404).json({ error: "That export isn't available." });
      return;
    }
    res.json({ job: exportJobDto(job) });
  } catch (error) {
    req.log?.error({ err: error }, "export poll failed");
    res.status(502).json({ error: "Could not load that export right now." });
  }
});

router.get("/exports/:id/download-url", async (req, res) => {
  try {
    const who = await requester(req);
    if (!who) return;
    const job = await ownJob(req.params.id, who.userId);
    if (!job) {
      res.status(404).json({ error: "That export isn't available." });
      return;
    }
    const dto = exportJobDto(job);
    if (dto.status === "expired") {
      res.status(410).json({ error: "That export has expired. Request it again." });
      return;
    }
    if (dto.status !== "ready" || !job.object_path) {
      res.status(409).json({ error: dto.status === "failed" ? "That export failed." : "That export isn't ready yet." });
      return;
    }
    const url = await objectStorage.signedDownloadURL(job.object_path, DOWNLOAD_URL_TTL_SEC);
    await supabaseAdmin(
      "PATCH",
      `/rest/v1/data_exports?id=eq.${enc(job.id)}`,
      { download_count: job.download_count + 1, last_downloaded_at: new Date().toISOString() },
    );
    await recordAdminAuditEvent({
      action: "data_export_downloaded",
      ...auditActor(who),
      providerId: job.provider_id,
      targetKind: "data_export",
      targetId: job.id,
      requestId: req.headers["x-request-id"]?.toString() ?? null,
      metadata: { kind: job.kind, rows: job.row_count ?? 0 },
    });
    res.json({ url, fileName: job.file_name, expiresInSeconds: DOWNLOAD_URL_TTL_SEC });
  } catch (error) {
    req.log?.error({ err: error }, "export download failed");
    res.status(502).json({ error: "Could not prepare that download right now." });
  }
});

/** Which kinds the caller may request, plus whether each needs an office. */
export function availableKinds(who: ExportRequester): Array<{ kind: ExportKind; label: string; ranged: boolean; needsOffice: boolean }> {
  const all: ExportKind[] = [...EXPORT_KINDS];
  const kinds =
    who.kind === "office"
      ? all.filter((kind) => kind !== "provider_directory")
      : all.filter((kind) => {
          const role = who.identity.departmentRole;
          if (role === "super_admin" || role === "admin") return true;
          if (role === "clinical") return kind === "office_comparison" || kind === "training_completion";
          if (role === "support") return kind === "provider_directory";
          return kind === "training_completion";
        });
  return kinds.map((kind) => ({
    kind,
    label: EXPORT_KIND_LABELS[kind],
    ranged: RANGED_KINDS.has(kind),
    needsOffice: who.kind === "hq" && kind === "patient_activity",
  }));
}

export default router;
