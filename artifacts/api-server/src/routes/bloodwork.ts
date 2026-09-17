import { createHash, randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CommitBloodworkReportParams, CorrectBloodworkResultBody, CorrectBloodworkResultParams,
  CreateBloodworkReportBody, CreateBloodworkReportParams, DeleteBloodworkReportParams,
  DeleteBloodworkReportQueryParams, GetBloodworkFilePageParams, GetBloodworkFileSourceParams,
  GetBloodworkReportParams, GetBloodworkReportQueryParams, ListBloodworkCorrectionsParams,
  ListBloodworkCorrectionsQueryParams, ListBloodworkReportsParams, ListBloodworkReportsQueryParams,
  ReviewBloodworkReportBody, ReviewBloodworkReportParams, ReviewBloodworkReportQueryParams,
  RetryBloodworkExtractionParams, RetryBloodworkExtractionQueryParams, UpdateBloodworkReportBody,
  UpdateBloodworkReportParams,
} from "@workspace/api-zod";
import { authorize, type Actor } from "../bloodwork/authorization";
import { objectStorage, ObjectNotFoundError, ObjectTooLargeError, UPLOAD_URL_TTL_SEC } from "../lib/objectStorage";
import { supabaseAdmin } from "../lib/supabase-admin";
import {
  BLOODWORK_MAX_FILE_BYTES, inspectBloodworkFile, renderBloodworkPage, BloodworkDocumentError,
} from "../bloodwork/documents";
import {
  detailDto, ensureRows, fetchAllRows, FILE_SELECT, REPORT_SELECT, fileDto, loadReport, reportDto, resultDto, rpc,
  type FileRow, type ReportRow,
} from "../bloodwork/repository";
import { recordUploadIntent } from "../jobs/upload-intents";
import { signalJob } from "../jobs/scheduler";
import { recordAdminAuditEvent, requestIdOf } from "../lib/admin-audit";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const enc = encodeURIComponent;
const BASE = "/bloodwork/patients/:patientId/reports";
const NO_STORE = "private, no-store, max-age=0";

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function invalid(res: Response, error = "Check the request and try again."): void {
  res.status(422).json({ error });
}

function audit(req: Request, actor: Actor, action: string, targetKind: string, targetId: string): void {
  void recordAdminAuditEvent({
    action,
    actorUserId: actor.actorUserId,
    actorKind: actor.kind === "patient" ? "patient" : actor.scope.actorKind,
    providerId: actor.kind === "staff" ? actor.scope.providerId : null,
    targetKind,
    targetId,
    requestId: requestIdOf(req),
    metadata: {},
  }).catch((error) => req.log.warn({ err: error, action }, "bloodwork audit write failed"));
}

router.use(BASE, (_req, res, next) => {
  res.setHeader("Cache-Control", NO_STORE);
  res.setHeader("Pragma", "no-cache");
  next();
});

router.get(BASE, async (req, res): Promise<void> => {
  if (!ListBloodworkReportsParams.safeParse(req.params).success ||
      !ListBloodworkReportsQueryParams.safeParse(req.query).success) { invalid(res); return; }
  try {
    const actor = await authorize(req, res, "read"); if (!actor) return;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const reportsRes = await supabaseAdmin("GET",
      `/rest/v1/patient_bloodwork_reports?patient_id=eq.${enc(actor.patientId)}&lifecycle_status=eq.committed` +
      (cursor ? `&uploaded_at=lt.${enc(cursor)}` : "") +
      `&select=${REPORT_SELECT}&order=uploaded_at.desc,id.desc&limit=21`);
    const reports = ensureRows<ReportRow>(reportsRes.status, reportsRes.json, "bloodwork list");
    const visible = reports.slice(0, 20);
    const observedAt = new Date().toISOString();
    const output = await Promise.all(visible.map(async (report) => {
      const filesRes = await supabaseAdmin("GET",
        `/rest/v1/patient_bloodwork_files?report_id=eq.${enc(report.id)}&select=${FILE_SELECT}&order=position.asc`);
      return reportDto(report, ensureRows<FileRow>(filesRes.status, filesRes.json, "bloodwork file counts"), observedAt);
    }));
    res.json({ reports: output, nextCursor: reports.length > 20 ? visible[visible.length - 1].uploaded_at : null });
  } catch (error) {
    req.log.error({ err: error }, "bloodwork list failed");
    res.status(503).json({ error: "Bloodwork is unavailable right now. Try again." });
  }
});

router.post(BASE, async (req, res): Promise<void> => {
  const params = CreateBloodworkReportParams.safeParse(req.params);
  const body = CreateBloodworkReportBody.safeParse(req.body);
  if (!params.success || !body.success) { invalid(res); return; }
  try {
    const actor = await authorize(req, res, "patient"); if (!actor) return;
    const files = body.data.files;
    const pdf = files.length === 1 && files[0].mimeType === "application/pdf";
    if ((!pdf && files.some((f) => f.mimeType === "application/pdf")) ||
        (pdf && files.length !== 1)) { invalid(res, "Choose one PDF or 1–10 images, not both."); return; }
    const hashInput = files.map(({ clientFileId, mimeType, size }, position) => ({ clientFileId, mimeType, size, position }));
    const manifestHash = createHash("sha256").update(JSON.stringify(hashInput)).digest("hex");
    const manifest = hashInput.map((file) => ({ ...file, fileId: randomUUID() }));
    let created;
    try {
      created = await rpc("bloodwork_create_report", {
        p_patient_id: actor.patientId, p_client_request_id: body.data.clientRequestId,
        p_title: body.data.title, p_report_date: body.data.reportDate?.toISOString().slice(0, 10) ?? null,
        p_manifest: manifest, p_manifest_hash: manifestHash,
      });
    } catch (error) {
      if (error instanceof Error && ((error as Error & { code?: string }).code ?? "").includes("idempotency_conflict")) {
        res.status(409).json({ error: "That save key was already used for different files." }); return;
      }
      throw error;
    }
    const reportId = String(created?.reportId ?? created?.reportid ?? "");
    const staged = await loadReport(actor.patientId, reportId, true);
    if (!staged) throw new Error("created bloodwork report missing");
    const uploads = staged.report.lifecycle_status === "committed" ? [] : await Promise.all(staged.files.map(async (file) => {
      const grant = await objectStorage.bloodworkUploadURL(actor.patientId, reportId, file.id);
      await recordUploadIntent({ objectPath: grant.objectPath, surface: "bloodwork", ownerId: actor.patientId });
      return {
        fileId: file.id, clientFileId: file.client_file_id, uploadUrl: grant.uploadUrl,
        expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SEC * 1000).toISOString(),
      };
    }));
    res.status(created?.created === true ? 201 : 200).json({ reportId, uploads });
  } catch (error) {
    req.log.error({ err: error }, "bloodwork staging failed");
    res.status(503).json({ error: "Could not prepare this report upload. Try again." });
  }
});

router.post(`${BASE}/:reportId/commit`, async (req, res): Promise<void> => {
  if (!CommitBloodworkReportParams.safeParse(req.params).success) { invalid(res); return; }
  const started = performance.now();
  const timing = { readMs: 0, inspectionMs: 0, immutableSaveMs: 0, commitSaveMs: 0, detailMs: 0 };
  try {
    const actor = await authorize(req, res, "patient"); if (!actor) return;
    const reportId = first(req.params.reportId);
    const staged = await loadReport(actor.patientId, reportId, true);
    if (!staged) { res.status(404).json({ error: "Report not found." }); return; }
    if (staged.report.lifecycle_status === "committed") {
      if (staged.report.extraction_status === "queued") signalJob("bloodwork-extraction");
      res.json(await detailDto(actor.patientId, reportId)); return;
    }
    const committed: Array<Record<string, unknown>> = [];
    for (const file of staged.files) {
      let stored;
      let phaseStarted = performance.now();
      try { stored = await objectStorage.readObjectBounded(file.staging_object_path, BLOODWORK_MAX_FILE_BYTES); }
      catch (error) {
        if (error instanceof ObjectNotFoundError) { res.status(422).json({ error: "One or more files did not finish uploading." }); return; }
        if (error instanceof ObjectTooLargeError) { res.status(413).json({ error: "Bloodwork files must be 20 MB or smaller." }); return; }
        throw error;
      }
      timing.readMs += performance.now() - phaseStarted;
      const bytes = stored.bytes;
      if (stored.sizeBytes !== Number(file.declared_size_bytes)) {
        res.status(422).json({ error: "An uploaded file size did not match the selected file." }); return;
      }
      let inspection;
      phaseStarted = performance.now();
      try { inspection = await inspectBloodworkFile(bytes, file.declared_mime_type); }
      catch (error) {
        if (error instanceof BloodworkDocumentError) {
          res.status(error.code === "FILE_TOO_LARGE" ? 413 : 422).json({ error: error.message, code: error.code }); return;
        }
        throw error;
      }
      timing.inspectionMs += performance.now() - phaseStarted;
      const objectPath = `/objects/patients/${actor.patientId}/bloodwork/reports/${reportId}/${file.id}`;
      phaseStarted = performance.now();
      await objectStorage.saveBufferImmutable(objectPath, Buffer.from(bytes), inspection.mimeType);
      timing.immutableSaveMs += performance.now() - phaseStarted;
      committed.push({ id: file.id, objectPath, mimeType: inspection.mimeType, size: bytes.byteLength,
        pageCount: inspection.pageCount, width: inspection.width, height: inspection.height, sha256: inspection.sha256 });
    }
    const saveStarted = performance.now();
    const committedMetadata = await rpc("bloodwork_commit_report", {
      p_patient_id: actor.patientId, p_report_id: reportId, p_files: committed,
    });
    if (committedMetadata !== true) {
      await Promise.all(committed.map((item) => objectStorage.deleteObjectStrict(String(item.objectPath))));
      res.status(409).json({ error: "This upload expired. Start a new report upload." });
      return;
    }
    timing.commitSaveMs = performance.now() - saveStarted;
    // The committed queue row is durable. This best-effort hint only advances
    // eligible leased work; it must never make an already saved upload fail.
    signalJob("bloodwork-extraction");
    const detailStarted = performance.now();
    const detail = await detailDto(actor.patientId, reportId);
    if (!detail) throw new Error("committed report missing");
    timing.detailMs = performance.now() - detailStarted;
    // Deliberately not req.log: performance evidence has no patient/report IDs,
    // names, paths, hashes, signed URLs, source contents, or model responses.
    logger.info({
      ...Object.fromEntries(Object.entries(timing).map(([key, value]) => [key, Math.round(value)])),
      totalMs: Math.round(performance.now() - started),
      files: committed.length, pages: detail.report.pageCount,
      bytes: committed.reduce((sum, file) => sum + Number(file.size), 0),
    }, "bloodwork_commit_timing");
    audit(req, actor, "bloodwork.report_committed", "bloodwork_report", reportId);
    res.json(detail);
  } catch (error) {
    req.log.error({ err: error }, "bloodwork commit failed");
    res.status(503).json({ error: "Could not save this report. Your upload can be retried." });
  }
});

router.get(`${BASE}/:reportId`, async (req, res): Promise<void> => {
  if (!GetBloodworkReportParams.safeParse(req.params).success ||
      !GetBloodworkReportQueryParams.safeParse(req.query).success) { invalid(res); return; }
  try {
    const actor = await authorize(req, res, "read"); if (!actor) return;
    const detail = await detailDto(actor.patientId, first(req.params.reportId));
    if (!detail) { res.status(404).json({ error: "Report not found." }); return; }
    res.json(detail);
  } catch (error) { req.log.error({ err: error }, "bloodwork detail failed"); res.status(503).json({ error: "Bloodwork is unavailable right now." }); }
});

router.patch(`${BASE}/:reportId`, async (req, res): Promise<void> => {
  const params = UpdateBloodworkReportParams.safeParse(req.params);
  const body = UpdateBloodworkReportBody.safeParse(req.body);
  if (!params.success || !body.success) { invalid(res); return; }
  try {
    const actor = await authorize(req, res, "patient"); if (!actor) return;
    const rows = await rpc("bloodwork_update_report", {
      p_patient_id: actor.patientId, p_report_id: first(req.params.reportId),
      p_expected_version: body.data.expectedVersion, p_title: body.data.title,
      p_report_date: body.data.reportDate?.toISOString().slice(0, 10) ?? null,
    }) as ReportRow[];
    if (!rows.length) { res.status(409).json({ error: "This report changed. Reload and try again." }); return; }
    const loaded = await loadReport(actor.patientId, rows[0].id);
    audit(req, actor, "bloodwork.report_updated", "bloodwork_report", rows[0].id);
    res.json(reportDto(rows[0], loaded?.files ?? []));
  } catch (error) { req.log.error({ err: error }, "bloodwork update failed"); res.status(503).json({ error: "Could not update this report." }); }
});

router.post(`${BASE}/:reportId/review`, async (req, res): Promise<void> => {
  const params = ReviewBloodworkReportParams.safeParse(req.params);
  const query = ReviewBloodworkReportQueryParams.safeParse(req.query);
  const body = ReviewBloodworkReportBody.safeParse(req.body);
  if (!params.success || !query.success || !body.success) { invalid(res); return; }
  try {
    const actor = await authorize(req, res, "edit"); if (!actor) return;
    if (actor.kind !== "staff") {
      res.status(403).json({ error: "Only your care team can mark a report reviewed." });
      return;
    }
    const reportId = first(req.params.reportId);
    const reviewedAt = body.data.reviewed ? new Date().toISOString() : null;
    const response = await supabaseAdmin(
      "PATCH",
      `/rest/v1/patient_bloodwork_reports?id=eq.${enc(reportId)}&patient_id=eq.${enc(actor.patientId)}&lifecycle_status=eq.committed&extraction_status=eq.completed`,
      {
        reviewed_at: reviewedAt,
        reviewed_by: body.data.reviewed ? actor.actorUserId : null,
      },
      "return=representation",
    );
    const rows = ensureRows<ReportRow>(response.status, response.json, "bloodwork report review");
    if (!rows.length) { res.status(404).json({ error: "Report not found." }); return; }
    const loaded = await loadReport(actor.patientId, reportId);
    if (!loaded) { res.status(404).json({ error: "Report not found." }); return; }
    audit(
      req,
      actor,
      body.data.reviewed ? "bloodwork.report_reviewed" : "bloodwork.report_review_cleared",
      "bloodwork_report",
      reportId,
    );
    res.json(reportDto(loaded.report, loaded.files));
  } catch (error) {
    req.log.error({ err: error }, "bloodwork review failed");
    res.status(503).json({ error: "Could not update this report review." });
  }
});

router.delete(`${BASE}/:reportId`, async (req, res): Promise<void> => {
  const params = DeleteBloodworkReportParams.safeParse(req.params);
  const query = DeleteBloodworkReportQueryParams.safeParse(req.query);
  if (!params.success || !query.success) { invalid(res); return; }
  try {
    const actor = await authorize(req, res, "patient"); if (!actor) return;
    const deleted = await rpc("bloodwork_delete_report", {
      p_patient_id: actor.patientId, p_report_id: first(req.params.reportId),
      p_expected_version: query.data.expectedVersion,
    });
    if (deleted !== true) { res.status(409).json({ error: "This report changed. Reload and try again." }); return; }
    audit(req, actor, "bloodwork.report_deleted", "bloodwork_report", first(req.params.reportId));
    res.json({ deleted: true });
  } catch (error) { req.log.error({ err: error }, "bloodwork delete failed"); res.status(503).json({ error: "Could not remove this report." }); }
});

router.post(`${BASE}/:reportId/retry-extraction`, async (req, res): Promise<void> => {
  if (!RetryBloodworkExtractionParams.safeParse(req.params).success ||
      !RetryBloodworkExtractionQueryParams.safeParse(req.query).success) { invalid(res); return; }
  try {
    const actor = await authorize(req, res, "edit"); if (!actor) return;
    const reportId = first(req.params.reportId);
    if (await rpc("bloodwork_retry_extraction", { p_patient_id: actor.patientId, p_report_id: reportId }) !== true) {
      res.status(409).json({ error: "Only a failed extraction without saved results can be retried." }); return;
    }
    signalJob("bloodwork-extraction");
    const loaded = await loadReport(actor.patientId, reportId);
    if (!loaded) { res.status(404).json({ error: "Report not found." }); return; }
    audit(req, actor, "bloodwork.extraction_retried", "bloodwork_report", reportId);
    res.json(reportDto(loaded.report, loaded.files));
  } catch (error) { req.log.error({ err: error }, "bloodwork retry failed"); res.status(503).json({ error: "Could not retry extraction." }); }
});

async function authorizedFile(req: Request, res: Response): Promise<{ actor: Actor; file: FileRow } | null> {
  const actor = await authorize(req, res, "read"); if (!actor) return null;
  const loaded = await loadReport(actor.patientId, first(req.params.reportId));
  const file = loaded?.files.find((candidate) => candidate.id === first(req.params.fileId));
  if (!file?.object_path) { res.status(404).json({ error: "File not found." }); return null; }
  return { actor, file };
}

router.get(`${BASE}/:reportId/files/:fileId/source`, async (req, res): Promise<void> => {
  if (!GetBloodworkFileSourceParams.safeParse(req.params).success) { invalid(res); return; }
  try {
    const found = await authorizedFile(req, res); if (!found) return;
    const { bytes } = await objectStorage.readObjectBounded(found.file.object_path!, BLOODWORK_MAX_FILE_BYTES);
    res.setHeader("Content-Type", found.file.mime_type!);
    res.setHeader("Content-Length", String(bytes.byteLength));
    res.send(bytes);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) { res.status(404).json({ error: "File not found." }); return; }
    if (error instanceof ObjectTooLargeError) { res.status(422).json({ error: "This saved file is invalid." }); return; }
    req.log.error({ err: error }, "bloodwork source read failed"); res.status(503).json({ error: "Could not open this file." });
  }
});

router.get(`${BASE}/:reportId/files/:fileId/pages/:page`, async (req, res): Promise<void> => {
  const parsed = GetBloodworkFilePageParams.safeParse(req.params);
  if (!parsed.success) { invalid(res); return; }
  try {
    const found = await authorizedFile(req, res); if (!found) return;
    if (parsed.data.page > Number(found.file.page_count)) {
      res.status(404).json({ error: "Page not found." }); return;
    }
    const { bytes } = await objectStorage.readObjectBounded(found.file.object_path!, BLOODWORK_MAX_FILE_BYTES);
    const rendered = await renderBloodworkPage(bytes, found.file.mime_type!, parsed.data.page, undefined, {
      sha256: found.file.content_sha256 ?? null, pageCount: Number(found.file.page_count),
    });
    res.setHeader("Content-Type", rendered.mimeType);
    res.setHeader("Content-Length", String(rendered.bytes.byteLength));
    res.send(rendered.bytes);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) { res.status(404).json({ error: "Page not found." }); return; }
    if (error instanceof ObjectTooLargeError) { res.status(422).json({ error: "This saved file is invalid." }); return; }
    if (error instanceof BloodworkDocumentError) {
      res.status(error.code === "PAGE_OUT_OF_RANGE" ? 404 : 422).json({ error: error.message, code: error.code }); return;
    }
    req.log.error({ err: error }, "bloodwork page read failed"); res.status(503).json({ error: "Could not render this page." });
  }
});

router.put(`${BASE}/:reportId/results/:resultId`, async (req, res): Promise<void> => {
  const params = CorrectBloodworkResultParams.safeParse(req.params);
  const body = CorrectBloodworkResultBody.safeParse(req.body);
  if (!params.success || !body.success) { invalid(res); return; }
  try {
    const actor = await authorize(req, res, "edit"); if (!actor) return;
    const { expectedVersion, ...values } = body.data;
    const rows = await rpc("bloodwork_correct_result", {
      p_patient_id: actor.patientId, p_report_id: first(req.params.reportId),
      p_result_id: first(req.params.resultId), p_expected_version: expectedVersion,
      p_actor_role: actor.role, p_actor_user_id: actor.actorUserId, p_values: values,
    }) as Parameters<typeof resultDto>[0][];
    if (!rows.length) { res.status(409).json({ error: "This result changed. Reload and try again." }); return; }
    audit(req, actor, "bloodwork.result_corrected", "bloodwork_result", first(req.params.resultId));
    res.json(resultDto(rows[0]));
  } catch (error) { req.log.error({ err: error }, "bloodwork correction failed"); res.status(503).json({ error: "Could not save this correction." }); }
});

router.get(`${BASE}/:reportId/results/:resultId/corrections`, async (req, res): Promise<void> => {
  if (!ListBloodworkCorrectionsParams.safeParse(req.params).success ||
      !ListBloodworkCorrectionsQueryParams.safeParse(req.query).success) { invalid(res); return; }
  try {
    const actor = await authorize(req, res, "read"); if (!actor) return;
    const reportId = first(req.params.reportId); const resultId = first(req.params.resultId);
    const loaded = await loadReport(actor.patientId, reportId);
    if (!loaded || !loaded.results.some((result) => result.id === resultId)) {
      res.status(404).json({ error: "Result not found." }); return;
    }
    const rows = await fetchAllRows<Record<string, unknown>>(
      `/rest/v1/patient_bloodwork_corrections?patient_id=eq.${enc(actor.patientId)}&report_id=eq.${enc(reportId)}&result_id=eq.${enc(resultId)}` +
      "&select=id,result_id,actor_role,created_at,before_values,after_values,version&order=created_at.asc,id.asc",
      "bloodwork corrections",
    );
    res.json({ corrections: rows.map((row) => ({
      id: row.id, resultId: row.result_id, actorRole: row.actor_role, createdAt: row.created_at,
      before: row.before_values, after: row.after_values, version: row.version,
    })) });
  } catch (error) { req.log.error({ err: error }, "bloodwork corrections read failed"); res.status(503).json({ error: "Could not load correction history." }); }
});

export default router;