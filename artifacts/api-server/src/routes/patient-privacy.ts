/**
 * Patient privacy routes — consent, self-service export, account deletion.
 *
 *  - GET  /patient-data/privacy               consent + latest export + deletion state
 *  - PUT  /patient-data/consent               record consent for the CURRENT policy version
 *  - POST /patient-data/export                queue an archive (one in flight at a time)
 *  - GET  /patient-data/export                latest archive job
 *  - GET  /patient-data/export/:id/download-url  short-lived signed link (410 once expired)
 *  - POST /patient-data/deletion              request deletion (grace period starts)
 *  - DELETE /patient-data/deletion            cancel a pending request
 *
 * Every route resolves the caller's patient row from the bearer session, so
 * demo personas and staff sessions never reach any of it (401/403). Writes
 * are audited with actorKind "patient"; the audit rows carry ids only.
 */
import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";
import { objectStorage } from "../lib/objectStorage";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { resolvePatient } from "../lib/patient-auth";
import { createLimiter, envLimit } from "../coach/limits";
import { clientIp } from "../auth/ledger";
import { CONSENT_POLICY_VERSION, CONSENT_SELECT, consentDto, loadLatestConsent, type ConsentRow } from "../privacy/consent";
import {
  PATIENT_EXPORT_SELECT,
  drainPatientExports,
  patientExportDto,
  patientExportTtlHours,
  type PatientExportRow,
} from "../privacy/exports";
import { DELETION_SELECT, deletionGraceSeconds, type DeletionRequestRow } from "../privacy/purge";

const router: IRouter = Router();
const enc = encodeURIComponent;

export const EXPORT_DOWNLOAD_URL_TTL_SEC = 300;

const acquireWriteSlot = createLimiter({
  burst: envLimit("PATIENT_PRIVACY_WRITE_BURST", 10),
  refillPerMinute: 4,
  maxConcurrent: 4,
  dailyBudget: envLimit("PATIENT_PRIVACY_WRITE_DAILY_BUDGET", 200),
  dailyMessage: "Too many requests today. Please try again tomorrow.",
  busyMessage: "We're a little busy right now. Please try again in a moment.",
  rapidMessage: "Too many requests from this connection. Please wait a moment and try again.",
});

function requestIdOf(req: Request): string | null {
  return req.headers["x-request-id"]?.toString() ?? null;
}

function audit(req: Request, input: Omit<Parameters<typeof recordAdminAuditEvent>[0], "requestId" | "actorKind">): void {
  recordAdminAuditEvent({ ...input, actorKind: "patient", requestId: requestIdOf(req) }).catch((error) =>
    req.log?.error({ err: error, action: input.action }, "patient privacy audit failed"),
  );
}

// ── Shared reads ────────────────────────────────────────────────────────────

export interface DeletionDto {
  requestedAt: string;
  purgeAfter: string;
  status: "pending";
}

export function deletionDto(row: DeletionRequestRow | null): DeletionDto | null {
  if (!row || row.status !== "pending") return null;
  return { requestedAt: row.requested_at, purgeAfter: row.purge_after, status: "pending" };
}

export async function loadPendingDeletion(patientId: string): Promise<DeletionRequestRow | null> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/patient_deletion_requests?patient_id=eq.${enc(patientId)}&status=eq.pending&select=${DELETION_SELECT}&limit=1`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`deletion lookup failed (${result.status})`);
  return (result.json[0] as DeletionRequestRow | undefined) ?? null;
}

export async function loadLatestExport(patientId: string): Promise<PatientExportRow | null> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/patient_data_exports?patient_id=eq.${enc(patientId)}&select=${PATIENT_EXPORT_SELECT}&order=created_at.desc&limit=1`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`export lookup failed (${result.status})`);
  return (result.json[0] as PatientExportRow | undefined) ?? null;
}

/** The `privacy` block the app hydrates (also embedded in /patient-data/state). */
export async function loadPrivacyState(patientId: string) {
  const [consent, latestExport, deletion] = await Promise.all([
    loadLatestConsent(patientId),
    loadLatestExport(patientId),
    loadPendingDeletion(patientId),
  ]);
  return {
    consent: consentDto(consent),
    export: latestExport ? patientExportDto(latestExport) : null,
    deletion: deletionDto(deletion),
  };
}

router.get("/patient-data/privacy", async (req, res) => {
  try {
    const auth = await resolvePatient(req, { consent: "skip" });
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, ...auth.details });
      return;
    }
    res.json(await loadPrivacyState(auth.patientId));
  } catch (error) {
    req.log?.error({ err: error }, "privacy state failed");
    res.status(502).json({ error: "Couldn’t load privacy settings right now." });
  }
});

// ── Consent ─────────────────────────────────────────────────────────────────

const ConsentBody = z.object({
  policyVersion: z.string().min(1).max(40),
  terms: z.literal(true),
  privacy: z.literal(true),
  healthData: z.literal(true),
  photoAnalysis: z.boolean(),
  appVersion: z.string().max(60).optional(),
  platform: z.string().max(20).optional(),
});

router.put("/patient-data/consent", async (req, res) => {
  const slot = acquireWriteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const auth = await resolvePatient(req, { consent: "skip" });
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, ...auth.details });
      return;
    }
    const parsed = ConsentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Every required agreement must be accepted." });
      return;
    }
    if (parsed.data.policyVersion !== CONSENT_POLICY_VERSION) {
      res.status(409).json({
        error: "Our terms have been updated. Please review the current version.",
        code: "POLICY_VERSION_OUTDATED",
        requiredVersion: CONSENT_POLICY_VERSION,
      });
      return;
    }
    const result = await supabaseAdmin(
      "POST",
      `/rest/v1/patient_consents?on_conflict=patient_id,policy_version&select=${CONSENT_SELECT}`,
      {
        patient_id: auth.patientId,
        policy_version: parsed.data.policyVersion,
        terms_accepted: true,
        privacy_accepted: true,
        health_data_accepted: true,
        photo_analysis_accepted: parsed.data.photoAnalysis,
        app_version: parsed.data.appVersion ?? null,
        platform: parsed.data.platform ?? null,
        recorded_at: new Date().toISOString(),
      },
      "resolution=merge-duplicates,return=representation",
    );
    if (result.status >= 300 || !Array.isArray(result.json) || result.json.length !== 1) {
      throw new Error(`consent write failed (${result.status})`);
    }
    audit(req, {
      action: "patient_consent_recorded",
      actorUserId: auth.authUserId,
      providerId: null,
      targetKind: "patient",
      targetId: auth.patientId,
      metadata: { policyVersion: parsed.data.policyVersion, photoAnalysis: parsed.data.photoAnalysis },
    });
    res.json({ consent: consentDto(result.json[0] as ConsentRow) });
  } catch (error) {
    req.log?.error({ err: error }, "consent write failed");
    res.status(502).json({ error: "Couldn’t save your consent right now. Please try again." });
  } finally {
    slot.release();
  }
});

// ── Export ──────────────────────────────────────────────────────────────────

router.get("/patient-data/export", async (req, res) => {
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, ...auth.details });
      return;
    }
    const latest = await loadLatestExport(auth.patientId);
    res.json({ export: latest ? patientExportDto(latest) : null });
  } catch (error) {
    req.log?.error({ err: error }, "export lookup failed");
    res.status(502).json({ error: "Couldn’t load your export right now." });
  }
});

router.post("/patient-data/export", async (req, res) => {
  const slot = acquireWriteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, ...auth.details });
      return;
    }
    const latest = await loadLatestExport(auth.patientId);
    if (latest && (latest.status === "queued" || latest.status === "running")) {
      res.status(409).json({ error: "An export is already being prepared.", export: patientExportDto(latest) });
      return;
    }
    const expiresAt = new Date(Date.now() + patientExportTtlHours() * 3600_000).toISOString();
    const inserted = await supabaseAdmin(
      "POST",
      `/rest/v1/patient_data_exports?select=${PATIENT_EXPORT_SELECT}`,
      { patient_id: auth.patientId, status: "queued", expires_at: expiresAt },
      "return=representation",
    );
    if (inserted.status >= 300 || !Array.isArray(inserted.json) || inserted.json.length !== 1) {
      throw new Error(`export insert failed (${inserted.status})`);
    }
    const row = inserted.json[0] as PatientExportRow;
    audit(req, {
      action: "patient_export_requested",
      actorUserId: auth.authUserId,
      providerId: null,
      targetKind: "patient",
      targetId: auth.patientId,
      metadata: { exportId: row.id },
    });
    // Small accounts are ready within seconds; the worker picks up the rest.
    void drainPatientExports();
    res.status(202).json({ export: patientExportDto(row) });
  } catch (error) {
    req.log?.error({ err: error }, "export request failed");
    res.status(502).json({ error: "Couldn’t start your export right now. Please try again." });
  } finally {
    slot.release();
  }
});

router.get("/patient-data/export/:id/download-url", async (req, res) => {
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, ...auth.details });
      return;
    }
    const id = String(req.params.id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(404).json({ error: "Export not found." });
      return;
    }
    const lookup = await supabaseAdmin(
      "GET",
      `/rest/v1/patient_data_exports?id=eq.${enc(id)}&patient_id=eq.${enc(auth.patientId)}&select=${PATIENT_EXPORT_SELECT}&limit=1`,
    );
    if (lookup.status >= 300 || !Array.isArray(lookup.json)) throw new Error(`export lookup failed (${lookup.status})`);
    const row = lookup.json[0] as PatientExportRow | undefined;
    if (!row) {
      res.status(404).json({ error: "Export not found." });
      return;
    }
    const dto = patientExportDto(row);
    if (dto.status === "expired") {
      res.status(410).json({ error: "This export has expired. Request a new one." });
      return;
    }
    if (dto.status !== "ready" || !row.object_path) {
      res.status(409).json({ error: "This export isn’t ready yet.", export: dto });
      return;
    }
    const url = await objectStorage.signedDownloadURL(row.object_path, EXPORT_DOWNLOAD_URL_TTL_SEC);
    await supabaseAdmin("PATCH", `/rest/v1/patient_data_exports?id=eq.${enc(row.id)}`, {
      download_count: row.download_count + 1,
      last_downloaded_at: new Date().toISOString(),
    });
    audit(req, {
      action: "patient_export_downloaded",
      actorUserId: auth.authUserId,
      providerId: null,
      targetKind: "patient",
      targetId: auth.patientId,
      metadata: { exportId: row.id },
    });
    res.json({ url, expiresInSeconds: EXPORT_DOWNLOAD_URL_TTL_SEC, fileName: `thinnr-data-export-${row.id.slice(0, 8)}.zip` });
  } catch (error) {
    req.log?.error({ err: error }, "export download failed");
    res.status(502).json({ error: "Couldn’t prepare the download right now." });
  }
});

// ── Deletion ────────────────────────────────────────────────────────────────

const DeletionBody = z.object({ confirm: z.literal("DELETE") });

router.post("/patient-data/deletion", async (req, res) => {
  const slot = acquireWriteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const auth = await resolvePatient(req, { consent: "skip" });
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, ...auth.details });
      return;
    }
    if (!DeletionBody.safeParse(req.body).success) {
      res.status(400).json({ error: "Type DELETE to confirm." });
      return;
    }
    const existing = await loadPendingDeletion(auth.patientId);
    if (existing) {
      // Already scheduled: same answer, no second audit line.
      res.status(202).json({ deletion: deletionDto(existing) });
      return;
    }
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_deletion_request", {
      p_patient_id: auth.patientId,
      p_grace_seconds: deletionGraceSeconds(),
    });
    if (result.status >= 300 || !Array.isArray(result.json) || result.json.length !== 1) {
      throw new Error(`deletion request failed (${result.status})`);
    }
    const row = result.json[0] as DeletionRequestRow;
    audit(req, {
      action: "patient_deletion_requested",
      actorUserId: auth.authUserId,
      providerId: row.provider_id,
      targetKind: "patient",
      targetId: auth.patientId,
      metadata: { requestId: row.id, purgeAfter: row.purge_after },
    });
    res.status(202).json({ deletion: deletionDto(row) });
  } catch (error) {
    req.log?.error({ err: error }, "deletion request failed");
    res.status(502).json({ error: "Couldn’t schedule the deletion right now. Please try again." });
  } finally {
    slot.release();
  }
});

router.delete("/patient-data/deletion", async (req, res) => {
  try {
    const auth = await resolvePatient(req, { consent: "skip" });
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, ...auth.details });
      return;
    }
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_deletion_cancel", { p_patient_id: auth.patientId });
    if (result.status >= 300) throw new Error(`deletion cancel failed (${result.status})`);
    const cancelled = result.json === true;
    if (cancelled) {
      audit(req, {
        action: "patient_deletion_cancelled",
        actorUserId: auth.authUserId,
        providerId: null,
        targetKind: "patient",
        targetId: auth.patientId,
      });
    }
    res.json({ cancelled, deletion: null });
  } catch (error) {
    req.log?.error({ err: error }, "deletion cancel failed");
    res.status(502).json({ error: "Couldn’t cancel the deletion right now. Please try again." });
  }
});

export default router;
