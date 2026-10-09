/**
 * CSV export jobs for HQ and office staff.
 *
 *   POST /exports                    request one (202 + job)
 *   GET  /exports                    the caller's recent jobs
 *   GET  /exports/:id                poll one job
 *   GET  /exports/:id/download-url   short-lived signed link for a ready job
 *   POST /exports/:id/cancel         stop a queued/running job (audited)
 *   GET  /exports/office-bundle/estimate?office=   HQ: patient count + size estimate
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
import { requireFreshCode } from "../auth/fresh-code";
import { supabaseAdmin } from "../lib/supabase-admin";
import { getBillingModeStatus } from "../billing/mode-state";
import { parseRange } from "./operational-rollups";
import {
  authorizeExport,
  exportFileName,
  EXPORT_KINDS,
  EXPORT_KIND_LABELS,
  APP_PAYMENT_KINDS,
  HQ_OFFICE_KINDS,
  capturesBillingIdentity,
  PATIENT_KINDS,
  RANGED_KINDS,
  resolveExportRequester,
  type ExportKind,
  type ExportRequester,
} from "../exports/kinds";
import { drainQueuedExports, type ExportJobRow, type ExportPartRow } from "../exports/worker";
import { bundleStateOf, countOfficePatients, countOfficeTombstones, OFFICE_BUNDLE_BUILD_DAYS } from "../exports/office-bundle";
import { OFFICE_BUNDLE_JOB_NAME } from "../jobs/definitions/office-bundle-export";
import { signalJob } from "../jobs/scheduler";
import { loadOrgPolicy } from "../lib/org-policy";
import { hasHqPermission } from "../lib/staff-auth";

const router: IRouter = Router();
const enc = encodeURIComponent;

/**
 * How long a finished export stays downloadable: the organization's export
 * link lifetime policy (HQ settings). EXPORT_TTL_HOURS remains only as the
 * value used when the policy cannot be read at all.
 */
export function exportTtlHoursFallback(): number {
  const raw = process.env.EXPORT_TTL_HOURS;
  if (raw === undefined || raw.trim() === "") return 24;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 && value <= 24 * 7 ? value : 24;
}
export async function exportTtlHours(): Promise<number> {
  try {
    return (await loadOrgPolicy()).exportLinkHours;
  } catch {
    return exportTtlHoursFallback();
  }
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
  /** Patient-level kinds (patient_record) name the one patient. */
  patientId: z.string().regex(/^[0-9a-f-]{36}$/i).optional().nullable(),
  /** Office bundles: also list purged patients' PII-free tombstones. */
  includeTombstones: z.boolean().optional(),
});

export const EXPORT_JOB_SELECT =
  "id,kind,status,requested_by,requester_kind,requester_role,provider_id,params,file_name,object_path,size_bytes,row_count,error,attempts,created_at,started_at,completed_at,expires_at,download_count,last_downloaded_at,parts,cancel_requested_at";

export type ExportJobStatus = "queued" | "running" | "ready" | "failed" | "expired" | "cancelled";

export interface ExportProgress {
  stage: "collecting" | "writing" | "ready" | "patients" | "office";
  partsDone: number | null;
  partsTotal: number | null;
  /** Office bundles: patients packed so far / in the office, bytes landed. */
  patientsDone: number | null;
  patientsTotal: number | null;
  bytesWritten: number | null;
}

function progressOf(row: Pick<ExportJobRow, "kind" | "params" | "parts">): ExportProgress | null {
  const params = row.params ?? {};
  if (row.kind === "office_bundle") {
    const bundle = bundleStateOf(params);
    if (!bundle) return { stage: "collecting", partsDone: 0, partsTotal: null, patientsDone: null, patientsTotal: null, bytesWritten: 0 };
    return {
      stage: bundle.stage,
      partsDone: Array.isArray(row.parts) ? row.parts.length : 0,
      partsTotal: null,
      patientsDone: bundle.patientsDone,
      patientsTotal: bundle.patientsTotal,
      bytesWritten: bundle.bytesWritten,
    };
  }
  const raw = params.progress;
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const stage = p.stage === "collecting" || p.stage === "writing" || p.stage === "ready" ? p.stage : null;
  if (!stage) return null;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return { stage, partsDone: num(p.partsDone), partsTotal: num(p.partsTotal), patientsDone: null, patientsTotal: null, bytesWritten: null };
}

export function exportJobDto(row: ExportJobRow, now = Date.now()) {
  const params = row.params ?? {};
  const expiresMs = Date.parse(row.expires_at);
  const expired = row.status === "expired" || (Number.isFinite(expiresMs) && expiresMs <= now);
  const status = expired && (row.status === "ready" || row.status === "failed" || row.status === "cancelled") ? "expired" : row.status;
  return {
    id: row.id,
    kind: row.kind as ExportKind,
    label: EXPORT_KIND_LABELS[row.kind as ExportKind] ?? row.kind,
    status: status as ExportJobStatus,
    scope: {
      providerId: row.provider_id,
      officeName: typeof params.officeName === "string" ? params.officeName : null,
      patientId: typeof params.patientId === "string" ? params.patientId : null,
      patientName: typeof params.patientName === "string" ? params.patientName : null,
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
    /** When a worker claimed the job; null while still queued. */
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    downloadCount: row.download_count,
    downloadable: status === "ready" && Boolean(row.object_path),
    /** Multi-part archives: one entry per numbered ZIP part (null for CSVs). */
    parts:
      status === "ready" && Array.isArray(row.parts) && row.parts.length > 0
        ? row.parts.map((part) => ({ part: part.part, fileName: part.fileName, sizeBytes: part.sizeBytes, fileCount: part.fileCount }))
        : null,
    /** Build progress for multi-part archives while queued/running. */
    progress: status === "queued" || status === "running" ? progressOf(row) : null,
    /** Stored files the archive names but could not include (missing sources). */
    omittedFiles:
      typeof params.omitted === "number" ? params.omitted : row.kind === "office_bundle" ? (bundleStateOf(params)?.omittedFiles ?? null) : null,
    /** True while a running job has been asked to stop and the worker has not yet confirmed. */
    cancelRequested: status === "running" && Boolean(row.cancel_requested_at),
    /** Office bundles: whether purged-patient tombstones were requested. */
    includeTombstones: row.kind === "office_bundle" ? params.includeTombstones === true : null,
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
    `/rest/v1/data_exports?id=eq.${enc(jobId)}&requested_by=eq.${enc(userId)}&select=${EXPORT_JOB_SELECT}&limit=1`,
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
      patientId: body.patientId ?? null,
    });
    if (authorized.kind !== "ok") {
      res.status(authorized.status).json({ error: authorized.message });
      return;
    }
    // Every export moves patient data out of the system: fresh code first.
    if (!(await requireFreshCode(req, res, who.userId))) return;
    const scope = authorized.scope;
    if (capturesBillingIdentity(body.kind)) {
      scope.billingIdentity = await getBillingModeStatus();
    }

    const pending = await supabaseAdmin(
      "GET",
      `/rest/v1/data_exports?requested_by=eq.${enc(who.userId)}&status=in.(queued,running)&select=id&limit=${MAX_PENDING_PER_REQUESTER + 1}`,
    );
    if (pending.status >= 300 || !Array.isArray(pending.json)) throw new Error(`export backlog check failed (${pending.status})`);
    if (pending.json.length >= MAX_PENDING_PER_REQUESTER) {
      res.status(429).json({ error: "You already have several exports in progress. Wait for one to finish." });
      return;
    }

    // A whole-office bundle can take hours to build: the row gets a build
    // allowance now, and the job resets expiry to the link policy once the
    // bundle is ready.
    const bundle = HQ_OFFICE_KINDS.has(body.kind);
    const expiresAt = new Date(
      Date.now() + (bundle ? OFFICE_BUNDLE_BUILD_DAYS * 24 : await exportTtlHours()) * 3_600_000,
    ).toISOString();
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
          ...(scope.billingIdentity ? { billingIdentity: scope.billingIdentity } : {}),
          ...(scope.range ? { start: scope.range.start, end: scope.range.end } : {}),
          ...(scope.officeName ? { officeName: scope.officeName } : {}),
          ...(scope.patient ? { patientId: scope.patient.id, patientName: scope.patient.name } : {}),
          ...(bundle ? { includeTombstones: body.includeTombstones === true } : {}),
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
    // A patient's whole record leaving the office is audited against the
    // patient (so the office Audit page shows who asked for whose chart),
    // with the export id alongside so the download can be traced back.
    await recordAdminAuditEvent(
      bundle && scope.providerId
        ? {
            action: "office_bundle_export_requested",
            ...auditActor(who),
            providerId: scope.providerId,
            targetKind: "data_export",
            targetId: job.id,
            requestId: req.headers["x-request-id"]?.toString() ?? null,
            metadata: {
              kind: body.kind,
              office: scope.providerId,
              exportId: job.id,
              includeTombstones: body.includeTombstones === true,
              patients: await countOfficePatients(supabaseAdmin, scope.providerId).catch(() => null),
            },
          }
        : scope.patient
        ? {
            action: "patient_record_export_requested",
            ...auditActor(who),
            providerId: scope.providerId,
            targetKind: "patient",
            targetId: scope.patient.id,
            requestId: req.headers["x-request-id"]?.toString() ?? null,
            metadata: { kind: body.kind, office: scope.providerId ?? "all", exportId: job.id },
          }
        : {
            action: "data_export_requested",
            ...auditActor(who),
            providerId: scope.providerId,
            targetKind: "data_export",
            targetId: job.id,
            requestId: req.headers["x-request-id"]?.toString() ?? null,
            metadata: { kind: body.kind, office: scope.providerId ?? "all" },
          },
    );
    // Kick the worker so small exports finish before the first poll; bundles
    // belong to their own leased job.
    if (bundle) signalJob(OFFICE_BUNDLE_JOB_NAME);
    else void drainQueuedExports();
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
    // ?patient=<id> narrows the list to one patient's record exports (the
    // patient page); still pinned to the caller's own jobs.
    const patientId = typeof req.query.patient === "string" && /^[0-9a-f-]{36}$/i.test(req.query.patient) ? req.query.patient : null;
    const patientFilter = patientId ? `&params->>patientId=eq.${enc(patientId)}` : "";
    const rows = await supabaseAdmin(
      "GET",
      `/rest/v1/data_exports?requested_by=eq.${enc(who.userId)}${patientFilter}&select=${EXPORT_JOB_SELECT}&order=created_at.desc&limit=50`,
    );
    if (rows.status >= 300 || !Array.isArray(rows.json)) throw new Error(`export list failed (${rows.status})`);
    const now = Date.now();
    res.json({
      jobs: (rows.json as ExportJobRow[]).map((row) => exportJobDto(row, now)),
      available: availableKinds(who),
      ttlHours: await exportTtlHours(),
    });
  } catch (error) {
    req.log?.error({ err: error }, "export list failed");
    res.status(502).json({ error: "Could not load exports right now." });
  }
});

/**
 * HQ: what an "entire office record" bundle would contain — the office's
 * patient count, purged-tombstone count, and a size estimate from the latest
 * data-growth snapshot (the office's share of database + storage bytes by
 * patient count). Null estimate when no snapshot exists yet.
 */
router.get("/exports/office-bundle/estimate", async (req, res) => {
  try {
    const who = await requester(req);
    if (!who) return;
    const office = typeof req.query.office === "string" ? req.query.office.trim() : "";
    const authorized = await authorizeExport({
      requester: who,
      authorization: req.headers.authorization,
      kind: "office_bundle",
      requestedOffice: office || null,
      range: null,
      patientId: null,
    });
    if (authorized.kind !== "ok") {
      res.status(authorized.status).json({ error: authorized.message });
      return;
    }
    const providerId = authorized.scope.providerId;
    if (!providerId) {
      res.status(400).json({ error: "Choose an office for this export." });
      return;
    }
    const [patientCount, tombstoneCount, networkPatients, snapshot] = await Promise.all([
      countOfficePatients(supabaseAdmin, providerId),
      countOfficeTombstones(supabaseAdmin, providerId),
      countOfficePatients(supabaseAdmin, null),
      latestSizeSnapshot(),
    ]);
    const share = networkPatients > 0 ? patientCount / networkPatients : 0;
    const estimatedBytes = snapshot ? Math.round(share * (snapshot.databaseBytes + snapshot.storageBytes)) : null;
    res.json({
      office: { id: providerId, name: authorized.scope.officeName },
      patientCount,
      tombstoneCount,
      estimatedBytes,
      snapshotDate: snapshot?.snapshotDate ?? null,
    });
  } catch (error) {
    req.log?.error({ err: error }, "office bundle estimate failed");
    res.status(502).json({ error: "Could not estimate that export right now." });
  }
});

async function latestSizeSnapshot(): Promise<{ snapshotDate: string; databaseBytes: number; storageBytes: number } | null> {
  const res = await supabaseAdmin(
    "GET",
    "/rest/v1/system_size_snapshots?kind=in.(database,storage_total)&select=snapshot_date,kind,total_bytes&order=snapshot_date.desc&limit=4",
  );
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`size snapshot read failed (${res.status})`);
  const rows = res.json as Array<{ snapshot_date: string; kind: string; total_bytes: number | string }>;
  const database = rows.find((row) => row.kind === "database");
  if (!database) return null;
  const storage = rows.find((row) => row.kind === "storage_total" && row.snapshot_date === database.snapshot_date);
  return { snapshotDate: database.snapshot_date, databaseBytes: Number(database.total_bytes), storageBytes: storage ? Number(storage.total_bytes) : 0 };
}

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
    // Multi-part archives: ?part=N picks the numbered part (default 1).
    const parts: ExportPartRow[] = Array.isArray(job.parts) ? job.parts : [];
    const rawPart = req.query.part;
    const partNumber = rawPart === undefined ? 1 : Number(rawPart);
    const part = parts.length > 0 ? parts.find((entry) => entry.part === partNumber) ?? null : partNumber === 1 ? null : undefined;
    if (part === undefined || (parts.length > 0 && !part)) {
      res.status(404).json({ error: "That export has no such part." });
      return;
    }
    const objectPath = part ? part.objectPath : job.object_path;
    const fileName = part ? part.fileName : job.file_name;
    const url = await objectStorage.signedDownloadURL(objectPath, DOWNLOAD_URL_TTL_SEC);
    await supabaseAdmin(
      "PATCH",
      `/rest/v1/data_exports?id=eq.${enc(job.id)}`,
      { download_count: job.download_count + 1, last_downloaded_at: new Date().toISOString() },
    );
    const patientId = typeof job.params?.patientId === "string" ? job.params.patientId : null;
    await recordAdminAuditEvent(
      HQ_OFFICE_KINDS.has(job.kind as ExportKind) && job.provider_id
        ? {
            action: "office_bundle_export_downloaded",
            ...auditActor(who),
            providerId: job.provider_id,
            targetKind: "data_export",
            targetId: job.id,
            requestId: req.headers["x-request-id"]?.toString() ?? null,
            metadata: { kind: job.kind, office: job.provider_id, exportId: job.id, part: part?.part ?? 1, parts: Math.max(parts.length, 1) },
          }
        : PATIENT_KINDS.has(job.kind as ExportKind) && patientId
        ? {
            action: "patient_record_export_downloaded",
            ...auditActor(who),
            providerId: job.provider_id,
            targetKind: "patient",
            targetId: patientId,
            requestId: req.headers["x-request-id"]?.toString() ?? null,
            metadata: { kind: job.kind, exportId: job.id, part: part?.part ?? 1, parts: Math.max(parts.length, 1) },
          }
        : {
            action: "data_export_downloaded",
            ...auditActor(who),
            providerId: job.provider_id,
            targetKind: "data_export",
            targetId: job.id,
            requestId: req.headers["x-request-id"]?.toString() ?? null,
            metadata: { kind: job.kind, rows: job.row_count ?? 0 },
          },
    );
    res.json({ url, fileName, expiresInSeconds: DOWNLOAD_URL_TTL_SEC, part: part?.part ?? null });
  } catch (error) {
    req.log?.error({ err: error }, "export download failed");
    res.status(502).json({ error: "Could not prepare that download right now." });
  }
});

/**
 * Cancel one of the caller's own exports that has not finished. A queued
 * job is flipped to cancelled here (the claim RPC only takes queued rows, so
 * it can never start); a running job is stamped `cancel_requested_at` and the
 * worker stops at its next checkpoint, deletes the parts it wrote, and marks
 * the row cancelled. Both are audited against the patient (record exports)
 * or the export itself, with the export id alongside.
 */
router.post("/exports/:id/cancel", async (req, res) => {
  try {
    const who = await requester(req);
    if (!who) return;
    const job = await ownJob(req.params.id, who.userId);
    if (!job) {
      res.status(404).json({ error: "That export isn't available." });
      return;
    }
    const before = exportJobDto(job);
    if (before.status !== "queued" && before.status !== "running") {
      res.status(409).json({ error: before.status === "ready" ? "That export already finished." : "That export is no longer running." });
      return;
    }
    const now = new Date().toISOString();
    let outcome: "cancelled" | "stopping" | null = null;
    if (job.status === "queued") {
      const flipped = await supabaseAdmin(
        "PATCH",
        `/rest/v1/data_exports?id=eq.${enc(job.id)}&status=eq.queued`,
        { status: "cancelled", cancel_requested_at: now, completed_at: now, error: null },
        "return=representation",
      );
      if (flipped.status >= 300) throw new Error(`export cancel failed (${flipped.status})`);
      if (Array.isArray(flipped.json) && flipped.json.length === 1) outcome = "cancelled";
    }
    if (!outcome) {
      // Queued a moment ago but claimed since, or running all along: ask the worker.
      const stamped = await supabaseAdmin(
        "PATCH",
        `/rest/v1/data_exports?id=eq.${enc(job.id)}&status=eq.running&cancel_requested_at=is.null`,
        { cancel_requested_at: now },
        "return=representation",
      );
      if (stamped.status >= 300) throw new Error(`export cancel request failed (${stamped.status})`);
      if (Array.isArray(stamped.json) && stamped.json.length === 1) outcome = "stopping";
    }
    const fresh = (await ownJob(job.id, who.userId)) ?? job;
    if (!outcome) {
      const dto = exportJobDto(fresh);
      if (dto.status === "running" && dto.cancelRequested) {
        // Already asked: idempotent.
        res.json({ job: dto });
        return;
      }
      res.status(409).json({ error: dto.status === "ready" ? "That export already finished." : "That export is no longer running." });
      return;
    }
    const patientId = typeof job.params?.patientId === "string" ? job.params.patientId : null;
    await recordAdminAuditEvent(
      PATIENT_KINDS.has(job.kind as ExportKind) && patientId
        ? {
            action: "patient_record_export_cancelled",
            ...auditActor(who),
            providerId: job.provider_id,
            targetKind: "patient",
            targetId: patientId,
            requestId: req.headers["x-request-id"]?.toString() ?? null,
            metadata: { kind: job.kind, office: job.provider_id ?? "all", exportId: job.id, wasRunning: outcome === "stopping" },
          }
        : {
            action: "data_export_cancelled",
            ...auditActor(who),
            providerId: job.provider_id,
            targetKind: "data_export",
            targetId: job.id,
            requestId: req.headers["x-request-id"]?.toString() ?? null,
            metadata: { kind: job.kind, office: job.provider_id ?? "all", wasRunning: outcome === "stopping" },
          },
    );
    res.json({ job: exportJobDto(fresh) });
  } catch (error) {
    req.log?.error({ err: error }, "export cancel failed");
    res.status(502).json({ error: "Could not cancel that export right now." });
  }
});

/** Which kinds the caller may request, plus whether each needs an office / a patient. */
export function availableKinds(who: ExportRequester): Array<{ kind: ExportKind; label: string; ranged: boolean; needsOffice: boolean; needsPatient: boolean }> {
  const all: ExportKind[] = [...EXPORT_KINDS];
  const kinds =
    who.kind === "office"
      ? all.filter((kind) => kind !== "provider_directory" && !HQ_OFFICE_KINDS.has(kind) && !APP_PAYMENT_KINDS.has(kind) &&
          (!kind.startsWith("billing_") || who.officeRole !== "staff") &&
          (!PATIENT_KINDS.has(kind) || who.officeRole !== "staff"))
      : all.filter((kind) => {
          if (kind.startsWith("billing_") || APP_PAYMENT_KINDS.has(kind)) return hasHqPermission(who.identity, "financial_read");
          if (PATIENT_KINDS.has(kind) || HQ_OFFICE_KINDS.has(kind)) return hasHqPermission(who.identity, "provider_manage");
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
    needsOffice: who.kind === "hq" && (kind === "patient_activity" || PATIENT_KINDS.has(kind) || HQ_OFFICE_KINDS.has(kind)),
    needsPatient: PATIENT_KINDS.has(kind),
  }));
}

export default router;
