/**
 * Office offboarding stepper (HQ only).
 *
 * The BAA's "return or destroy" clause as a procedure:
 *   1. start     — offboarding_status = offboarding; every staff login of the
 *                  office is revoked and the directory stops issuing codes.
 *   2. bundle    — the whole-office record bundle (the existing office bundle
 *                  export job) is requested on the office's behalf.
 *   3. handover  — who received the bundle, on which date, the office's
 *                  written choice (retain in cold retention vs destroy after
 *                  hand-back) and a reference to the signed letter.
 *   4. seal      — every chart goes through the account-closure primitive
 *                  (leased job); retain-until follows the clinical retention
 *                  policy, or a short destroy date when the office chose
 *                  destroy. Blocked while the office is under legal hold.
 *   5. complete  — offboarding_status = offboarded (+ access_disabled so the
 *                  SQL rollups exclude it). Blocked by a hold or unsealed charts.
 *
 * Every step is idempotent (repeating a finished step returns the current
 * state with 200) and audited. Destruction itself runs through the existing
 * purge with tombstones; the certificate is a CSV of those tombstones.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { requireFreshCode } from "../auth/fresh-code";
import { revokeUserSessions } from "../auth/session-revocations";
import { OFFICE_BUNDLE_BUILD_DAYS } from "../exports/office-bundle";
import { exportFileName } from "../exports/kinds";
import type { ExportJobRow, ExportPartRow } from "../exports/worker";
import { OFFICE_BUNDLE_JOB_NAME } from "../jobs/definitions/office-bundle-export";
import { loadSealProgress, OFFICE_OFFBOARDING_SEAL_JOB_NAME, officeHoldActive, type SealProgress } from "../jobs/definitions/office-offboarding-seal";
import { signalJob } from "../jobs/scheduler";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { objectStorage } from "../lib/objectStorage";
import { offboardingStatusOf, type OfficeOffboardingStatus } from "../lib/office-status";
import { loadOrgPolicy } from "../lib/org-policy";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { DOWNLOAD_URL_TTL_SEC, EXPORT_JOB_SELECT, exportJobDto, type ExportJobDto } from "./exports";

const router: IRouter = Router();
const enc = encodeURIComponent;

/** Days between a destroy hand-over and the scheduled purge of the sealed charts. */
export const OFFBOARDING_DESTROY_DAYS = 30;

const PROVIDER_SELECT = "provider_id,provider_name,office_name,auth_user_id,access_disabled,offboarding_status,offboarding_started_at,offboarded_at";
const RECORD_SELECT =
  "provider_id,started_at,started_by,access_disabled_at,staff_sessions_revoked,bundle_export_id,bundle_requested_at,handover_received_by,handover_received_on,handover_choice,handover_letter_reference,handover_note,handover_recorded_at,handover_recorded_by,seal_started_at,seal_started_by,seal_retain_until,seal_completed_at,seal_patients_total,seal_patients_done,seal_patients_held,offboarded_at,offboarded_by,updated_at";

interface ProviderRow {
  provider_id: string;
  provider_name: string | null;
  office_name: string | null;
  auth_user_id: string | null;
  access_disabled: boolean | null;
  offboarding_status?: string | null;
  offboarding_started_at?: string | null;
  offboarded_at?: string | null;
}

interface RecordRow {
  provider_id: string;
  started_at: string;
  started_by: string | null;
  access_disabled_at: string | null;
  staff_sessions_revoked: number;
  bundle_export_id: string | null;
  bundle_requested_at: string | null;
  handover_received_by: string | null;
  handover_received_on: string | null;
  handover_choice: "retain" | "destroy" | null;
  handover_letter_reference: string | null;
  handover_note: string | null;
  handover_recorded_at: string | null;
  handover_recorded_by: string | null;
  seal_started_at: string | null;
  seal_started_by: string | null;
  seal_retain_until: string | null;
  seal_completed_at: string | null;
  seal_patients_total: number | null;
  seal_patients_done: number | null;
  seal_patients_held: number | null;
  offboarded_at: string | null;
  offboarded_by: string | null;
  updated_at: string;
}

export type OffboardingStep = "start" | "bundle" | "handover" | "seal" | "complete";

const HandoverInput = z.object({
  receivedBy: z.string().trim().min(1, "Record who received the bundle.").max(200),
  receivedOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date (YYYY-MM-DD)."),
  choice: z.enum(["retain", "destroy"]),
  letterReference: z.string().trim().min(1, "Reference the office's signed letter.").max(500),
  note: z.string().trim().max(2000).optional().default(""),
});

const BundleInput = z.object({ includeTombstones: z.boolean().optional().default(true) });

function requestId(req: Request): string | null {
  return req.headers["x-request-id"]?.toString() ?? null;
}

function officeName(row: ProviderRow): string {
  return String(row.office_name ?? row.provider_name ?? row.provider_id);
}

async function loadProvider(providerId: string): Promise<ProviderRow | null> {
  const res = await supabaseAdmin("GET", `/rest/v1/providers?provider_id=eq.${enc(providerId)}&select=${PROVIDER_SELECT}&limit=1`);
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`provider lookup failed (${res.status})`);
  return (res.json[0] as ProviderRow | undefined) ?? null;
}

async function loadRecord(providerId: string): Promise<RecordRow | null> {
  const res = await supabaseAdmin("GET", `/rest/v1/provider_offboardings?provider_id=eq.${enc(providerId)}&select=${RECORD_SELECT}&limit=1`);
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`offboarding lookup failed (${res.status})`);
  return (res.json[0] as RecordRow | undefined) ?? null;
}

async function patchRecord(providerId: string, patch: Record<string, unknown>): Promise<RecordRow> {
  const res = await supabaseAdmin(
    "PATCH",
    `/rest/v1/provider_offboardings?provider_id=eq.${enc(providerId)}`,
    { ...patch, updated_at: new Date().toISOString() },
    "return=representation",
  );
  if (res.status >= 300 || !Array.isArray(res.json) || res.json.length !== 1) throw new Error(`offboarding update failed (${res.status})`);
  return res.json[0] as RecordRow;
}

async function patchProvider(providerId: string, patch: Record<string, unknown>): Promise<void> {
  const res = await supabaseAdmin("PATCH", `/rest/v1/providers?provider_id=eq.${enc(providerId)}`, patch);
  if (res.status >= 300) throw new Error(`provider status update failed (${res.status})`);
}

async function loadBundle(exportId: string | null): Promise<ExportJobRow | null> {
  if (!exportId) return null;
  const res = await supabaseAdmin("GET", `/rest/v1/data_exports?id=eq.${enc(exportId)}&select=${EXPORT_JOB_SELECT}&limit=1`);
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`bundle lookup failed (${res.status})`);
  return (res.json[0] as ExportJobRow | undefined) ?? null;
}

/** Clinical retention window from the organization policy (days); the SQL closure applies the same policy. */
async function clinicalRetentionDays(): Promise<number> {
  const policy = await loadOrgPolicy();
  return policy.retention.clinicalRecordDays;
}

export interface OffboardingStateDto {
  providerId: string;
  officeName: string;
  status: OfficeOffboardingStatus;
  /** Which step is next (null once offboarded). */
  nextStep: OffboardingStep | null;
  /** True while an office-level legal hold blocks sealing and completion. */
  legalHold: boolean;
  destroyAfterDays: number;
  started: { at: string; by: string | null; sessionsRevoked: number } | null;
  bundle: ExportJobDto | null;
  handover: {
    receivedBy: string;
    receivedOn: string;
    choice: "retain" | "destroy";
    letterReference: string;
    note: string;
    recordedAt: string;
    recordedBy: string | null;
  } | null;
  seal: {
    startedAt: string;
    retainUntil: string | null;
    completedAt: string | null;
    progress: SealProgress;
  } | null;
  offboardedAt: string | null;
  certificateAvailable: boolean;
}

function nextStepOf(status: OfficeOffboardingStatus, record: RecordRow | null, bundle: ExportJobRow | null): OffboardingStep | null {
  if (status === "offboarded") return null;
  if (status === "active" || !record) return "start";
  if (!record.bundle_export_id || !bundle || bundle.status === "failed" || bundle.status === "cancelled" || bundle.status === "expired") return "bundle";
  if (!record.handover_recorded_at) return "handover";
  if (!record.seal_started_at || !record.seal_completed_at) return "seal";
  return "complete";
}

export async function offboardingState(provider: ProviderRow, record: RecordRow | null): Promise<OffboardingStateDto> {
  const status = offboardingStatusOf(provider.offboarding_status);
  const [bundle, hold, progress] = await Promise.all([
    loadBundle(record?.bundle_export_id ?? null),
    officeHoldActive(provider.provider_id),
    record?.seal_started_at ? loadSealProgress(provider.provider_id) : Promise.resolve<SealProgress | null>(null),
  ]);
  const bundleDto = bundle ? exportJobDto(bundle) : null;
  return {
    providerId: provider.provider_id,
    officeName: officeName(provider),
    status,
    nextStep: nextStepOf(status, record, bundleDto ? ({ ...bundle, status: bundleDto.status } as ExportJobRow) : null),
    legalHold: hold,
    destroyAfterDays: OFFBOARDING_DESTROY_DAYS,
    started: record ? { at: record.started_at, by: record.started_by, sessionsRevoked: record.staff_sessions_revoked ?? 0 } : null,
    bundle: bundleDto,
    handover:
      record?.handover_recorded_at && record.handover_choice
        ? {
            receivedBy: record.handover_received_by ?? "",
            receivedOn: record.handover_received_on ?? "",
            choice: record.handover_choice,
            letterReference: record.handover_letter_reference ?? "",
            note: record.handover_note ?? "",
            recordedAt: record.handover_recorded_at,
            recordedBy: record.handover_recorded_by,
          }
        : null,
    seal:
      record?.seal_started_at && progress
        ? {
            startedAt: record.seal_started_at,
            retainUntil: record.seal_retain_until,
            completedAt: record.seal_completed_at,
            progress,
          }
        : null,
    offboardedAt: record?.offboarded_at ?? provider.offboarded_at ?? null,
    certificateAvailable: status === "offboarded",
  };
}

async function respondState(res: Response, provider: ProviderRow, status = 200): Promise<void> {
  const record = await loadRecord(provider.provider_id);
  res.status(status).json({ offboarding: await offboardingState(provider, record) });
}

type Handler = (input: {
  req: Request;
  res: Response;
  provider: ProviderRow;
  record: RecordRow | null;
  caller: StaffIdentity;
}) => Promise<void>;

/** Shared prologue: HQ permission (router-level), provider exists, fresh code for mutations. */
function step(handler: Handler, options: { mutation: boolean } = { mutation: true }) {
  return async (req: Request, res: Response) => {
    try {
      const caller = res.locals.staff as StaffIdentity;
      const provider = await loadProvider(String(req.params.id));
      if (!provider) {
        res.status(404).json({ error: "Provider account not found." });
        return;
      }
      if (options.mutation && !(await requireFreshCode(req, res, caller.userId))) return;
      const record = await loadRecord(provider.provider_id);
      await handler({ req, res, provider, record, caller });
    } catch (error) {
      req.log?.error({ err: error }, "office offboarding request failed");
      res.status(502).json({ error: "Could not complete that offboarding step right now." });
    }
  };
}

function audit(req: Request, caller: StaffIdentity, providerId: string, action: string, metadata: Record<string, string | number | boolean | null> = {}) {
  return recordAdminAuditEvent({
    action,
    actorUserId: caller.userId,
    actorKind: "hq",
    providerId,
    targetKind: "provider_account",
    targetId: providerId,
    requestId: requestId(req),
    metadata: { office: providerId, ...metadata },
  });
}

router.get("/provider-accounts/:id/offboarding", requireHqPermission("provider_read"), step(async ({ res, provider, record }) => {
  res.json({ offboarding: await offboardingState(provider, record) });
}, { mutation: false }));

/** Step 1: disable staff sign-in. Idempotent: an office already offboarding returns its state. */
router.post("/provider-accounts/:id/offboarding/start", requireHqPermission("provider_manage"), step(async ({ req, res, provider, record, caller }) => {
  const status = offboardingStatusOf(provider.offboarding_status);
  if (status !== "active" && record) {
    await respondState(res, provider);
    return;
  }
  const now = new Date().toISOString();
  // Flip the status FIRST so the directory and office scope fail closed
  // before any session is revoked; a crash between the two leaves the office
  // offboarding with sessions the next start call revokes.
  await patchProvider(provider.provider_id, { offboarding_status: "offboarding", offboarding_started_at: now });
  const members = await supabaseAdmin(
    "GET",
    `/rest/v1/team_members?provider_id=eq.${enc(provider.provider_id)}&auth_user_id=not.is.null&select=auth_user_id&limit=1000`,
  );
  if (members.status >= 300 || !Array.isArray(members.json)) throw new Error(`team lookup failed (${members.status})`);
  const userIds = new Set<string>();
  if (provider.auth_user_id) userIds.add(provider.auth_user_id);
  for (const row of members.json as Array<{ auth_user_id?: unknown }>) {
    if (typeof row.auth_user_id === "string" && row.auth_user_id) userIds.add(row.auth_user_id);
  }
  let revoked = 0;
  for (const userId of userIds) revoked += await revokeUserSessions({ userId, reason: "office_offboarded" });
  if (record) {
    await patchRecord(provider.provider_id, { access_disabled_at: now, staff_sessions_revoked: record.staff_sessions_revoked + revoked });
  } else {
    const inserted = await supabaseAdmin("POST", "/rest/v1/provider_offboardings", {
      provider_id: provider.provider_id,
      started_at: now,
      started_by: caller.userId,
      access_disabled_at: now,
      staff_sessions_revoked: revoked,
    });
    if (inserted.status >= 300) throw new Error(`offboarding insert failed (${inserted.status})`);
  }
  await audit(req, caller, provider.provider_id, "office_offboarding_started", { sessions: revoked, status: "offboarding" });
  const refreshed = await loadProvider(provider.provider_id);
  await respondState(res, refreshed ?? { ...provider, offboarding_status: "offboarding", offboarding_started_at: now }, 201);
}));

/** Step 2: request the whole-office bundle on the office's behalf. Idempotent while a bundle is queued/running/ready. */
router.post("/provider-accounts/:id/offboarding/bundle", requireHqPermission("provider_manage"), step(async ({ req, res, provider, record, caller }) => {
  if (!record || offboardingStatusOf(provider.offboarding_status) === "active") {
    res.status(409).json({ error: "Disable staff sign-in (step 1) before generating the bundle." });
    return;
  }
  if (offboardingStatusOf(provider.offboarding_status) === "offboarded") {
    await respondState(res, provider);
    return;
  }
  const parsed = BundleInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Check the bundle options and try again." });
    return;
  }
  const existing = await loadBundle(record.bundle_export_id);
  if (existing) {
    const dto = exportJobDto(existing);
    if (dto.status === "queued" || dto.status === "running" || dto.status === "ready") {
      await respondState(res, provider);
      return;
    }
  }
  const expiresAt = new Date(Date.now() + OFFICE_BUNDLE_BUILD_DAYS * 24 * 3_600_000).toISOString();
  const scope = {
    providerId: provider.provider_id,
    officeName: officeName(provider),
    requesterKind: "hq" as const,
    requesterRole: caller.departmentRole,
    range: null,
    patient: null,
  };
  const inserted = await supabaseAdmin(
    "POST",
    "/rest/v1/data_exports",
    {
      kind: "office_bundle",
      status: "queued",
      requested_by: caller.userId,
      requester_kind: "hq",
      requester_role: caller.departmentRole,
      provider_id: provider.provider_id,
      params: { officeName: scope.officeName, includeTombstones: parsed.data.includeTombstones, offboarding: true },
      file_name: exportFileName("office_bundle", scope),
      expires_at: expiresAt,
    },
    "return=representation",
  );
  if (inserted.status >= 300 || !Array.isArray(inserted.json) || inserted.json.length !== 1) {
    throw new Error(`bundle insert failed (${inserted.status})`);
  }
  const job = inserted.json[0] as ExportJobRow;
  await patchRecord(provider.provider_id, { bundle_export_id: job.id, bundle_requested_at: new Date().toISOString() });
  await audit(req, caller, provider.provider_id, "office_offboarding_bundle_requested", { exportId: job.id, kind: "office_bundle" });
  signalJob(OFFICE_BUNDLE_JOB_NAME);
  await respondState(res, provider, 202);
}));

/** Bundle part download for the HQ offboarding page (the export routes pin downloads to their requester). */
router.get("/provider-accounts/:id/offboarding/bundle/download-url", requireHqPermission("provider_manage"), step(async ({ req, res, provider, record, caller }) => {
  const job = await loadBundle(record?.bundle_export_id ?? null);
  if (!job) {
    res.status(404).json({ error: "No bundle has been generated for this office." });
    return;
  }
  const dto = exportJobDto(job);
  if (dto.status === "expired") {
    res.status(410).json({ error: "That bundle has expired. Generate it again." });
    return;
  }
  if (dto.status !== "ready" || !job.object_path) {
    res.status(409).json({ error: dto.status === "failed" ? "That bundle failed." : "That bundle isn't ready yet." });
    return;
  }
  const parts: ExportPartRow[] = Array.isArray(job.parts) ? job.parts : [];
  const partNumber = req.query.part === undefined ? 1 : Number(req.query.part);
  const part = parts.length > 0 ? parts.find((entry) => entry.part === partNumber) ?? null : partNumber === 1 ? null : undefined;
  if (part === undefined || (parts.length > 0 && !part)) {
    res.status(404).json({ error: "That bundle has no such part." });
    return;
  }
  const url = await objectStorage.signedDownloadURL(part ? part.objectPath : job.object_path, DOWNLOAD_URL_TTL_SEC);
  await supabaseAdmin("PATCH", `/rest/v1/data_exports?id=eq.${enc(job.id)}`, {
    download_count: job.download_count + 1,
    last_downloaded_at: new Date().toISOString(),
  });
  await recordAdminAuditEvent({
    action: "office_bundle_export_downloaded",
    actorUserId: caller.userId,
    actorKind: "hq",
    providerId: provider.provider_id,
    targetKind: "data_export",
    targetId: job.id,
    requestId: requestId(req),
    metadata: { kind: job.kind, office: provider.provider_id, exportId: job.id, part: part?.part ?? 1, parts: Math.max(parts.length, 1) },
  });
  res.json({ url, fileName: part ? part.fileName : job.file_name, expiresInSeconds: DOWNLOAD_URL_TTL_SEC, part: part?.part ?? null });
}, { mutation: false }));

/** Step 3: record the hand-over. Re-recordable until the seal starts. */
router.post("/provider-accounts/:id/offboarding/handover", requireHqPermission("provider_manage"), step(async ({ req, res, provider, record, caller }) => {
  if (!record || offboardingStatusOf(provider.offboarding_status) === "active") {
    res.status(409).json({ error: "Disable staff sign-in (step 1) before recording the hand-over." });
    return;
  }
  if (record.seal_started_at) {
    res.status(409).json({ error: "The hand-over record is locked once sealing has started." });
    return;
  }
  const bundle = await loadBundle(record.bundle_export_id);
  if (!bundle || exportJobDto(bundle).status !== "ready") {
    res.status(409).json({ error: "Generate the office bundle (step 2) and wait for it to be ready before recording the hand-over." });
    return;
  }
  const parsed = HandoverInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: issue?.message ?? "Check the hand-over form and try again.", field: typeof issue?.path?.[0] === "string" ? issue.path[0] : undefined });
    return;
  }
  const received = new Date(`${parsed.data.receivedOn}T00:00:00Z`);
  if (Number.isNaN(received.getTime()) || received.getTime() > Date.now() + 24 * 3_600_000) {
    res.status(400).json({ error: "The hand-over date cannot be in the future.", field: "receivedOn" });
    return;
  }
  await patchRecord(provider.provider_id, {
    handover_received_by: parsed.data.receivedBy,
    handover_received_on: parsed.data.receivedOn,
    handover_choice: parsed.data.choice,
    handover_letter_reference: parsed.data.letterReference,
    handover_note: parsed.data.note || null,
    handover_recorded_at: new Date().toISOString(),
    handover_recorded_by: caller.userId,
  });
  await audit(req, caller, provider.provider_id, "office_offboarding_handover_recorded", {
    choice: parsed.data.choice,
    dateKey: parsed.data.receivedOn,
    exportId: bundle.id,
    hasNote: parsed.data.note.length > 0,
  });
  await respondState(res, provider);
}));

/** Step 4: seal every chart. Blocked by an office legal hold; idempotent once started. */
router.post("/provider-accounts/:id/offboarding/seal", requireHqPermission("provider_manage"), step(async ({ req, res, provider, record, caller }) => {
  if (!record || offboardingStatusOf(provider.offboarding_status) === "active") {
    res.status(409).json({ error: "Disable staff sign-in (step 1) before sealing charts." });
    return;
  }
  if (record.seal_started_at) {
    if (!record.seal_completed_at) signalJob(OFFICE_OFFBOARDING_SEAL_JOB_NAME);
    await respondState(res, provider);
    return;
  }
  if (!record.handover_recorded_at || !record.handover_choice) {
    res.status(409).json({ error: "Record the hand-over (step 3) before sealing charts." });
    return;
  }
  if (await officeHoldActive(provider.provider_id)) {
    res.status(409).json({ error: "This office is under a legal hold. Lift the hold before sealing charts.", code: "legal_hold" });
    return;
  }
  const now = new Date();
  const retainUntil =
    record.handover_choice === "destroy"
      ? new Date(now.getTime() + OFFBOARDING_DESTROY_DAYS * 24 * 3_600_000).toISOString()
      : null;
  const retentionDays = await clinicalRetentionDays();
  await patchRecord(provider.provider_id, {
    seal_started_at: now.toISOString(),
    seal_started_by: caller.userId,
    seal_retain_until: retainUntil,
  });
  await audit(req, caller, provider.provider_id, "office_offboarding_seal_started", {
    choice: record.handover_choice,
    retainUntil: retainUntil ?? `policy:${retentionDays}d`,
  });
  signalJob(OFFICE_OFFBOARDING_SEAL_JOB_NAME);
  await respondState(res, provider, 202);
}));

/** Step 5: mark the office offboarded. Requires a completed seal with nothing held, and no office hold. */
router.post("/provider-accounts/:id/offboarding/complete", requireHqPermission("provider_manage"), step(async ({ req, res, provider, record, caller }) => {
  const status = offboardingStatusOf(provider.offboarding_status);
  if (status === "offboarded" && record?.offboarded_at) {
    await respondState(res, provider);
    return;
  }
  if (!record || status === "active") {
    res.status(409).json({ error: "Disable staff sign-in (step 1) before completing the offboarding." });
    return;
  }
  if (!record.seal_started_at || !record.seal_completed_at) {
    res.status(409).json({ error: "Seal every chart (step 4) before completing the offboarding." });
    return;
  }
  if (await officeHoldActive(provider.provider_id)) {
    res.status(409).json({ error: "This office is under a legal hold. Lift the hold before completing the offboarding.", code: "legal_hold" });
    return;
  }
  const progress = await loadSealProgress(provider.provider_id);
  if (progress.pending > 0 || progress.failed > 0 || progress.held > 0) {
    res.status(409).json({
      error: progress.held > 0
        ? `${progress.held} chart${progress.held === 1 ? " is" : "s are"} parked behind a patient legal hold. Lift those holds and let the seal finish first.`
        : "Some charts are still being sealed. Wait for the seal to finish.",
      code: progress.held > 0 ? "legal_hold" : "seal_incomplete",
    });
    return;
  }
  const now = new Date().toISOString();
  await patchProvider(provider.provider_id, { offboarding_status: "offboarded", offboarded_at: now, access_disabled: true });
  await patchRecord(provider.provider_id, { offboarded_at: now, offboarded_by: caller.userId });
  await audit(req, caller, provider.provider_id, "office_offboarding_completed", {
    status: "offboarded",
    choice: record.handover_choice,
    patients: progress.total,
    sealed: progress.sealed,
    destroyed: progress.destroyed,
  });
  const refreshed = await loadProvider(provider.provider_id);
  await respondState(res, refreshed ?? { ...provider, offboarding_status: "offboarded", offboarded_at: now, access_disabled: true });
}));

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Destruction certificate: every tombstone left by the office's purges plus a summary block. */
router.get("/provider-accounts/:id/offboarding/certificate.csv", requireHqPermission("provider_manage"), step(async ({ req, res, provider, record, caller }) => {
  if (offboardingStatusOf(provider.offboarding_status) !== "offboarded" || !record) {
    res.status(409).json({ error: "The destruction certificate is available once the office is offboarded." });
    return;
  }
  const [tombstones, progress] = await Promise.all([
    supabaseAdmin(
      "GET",
      `/rest/v1/patient_tombstones?provider_id=eq.${enc(provider.provider_id)}&select=id,requested_at,purged_at,was_activated,program_id,enrolled_on&order=purged_at.asc&limit=20000`,
    ),
    loadSealProgress(provider.provider_id),
  ]);
  if (tombstones.status >= 300 || !Array.isArray(tombstones.json)) throw new Error(`tombstone list failed (${tombstones.status})`);
  const rows = tombstones.json as Array<Record<string, unknown>>;
  const generatedAt = new Date().toISOString();
  const lines: string[] = [];
  lines.push("section,key,value");
  const summary: Array<[string, unknown]> = [
    ["office_id", provider.provider_id],
    ["office_name", officeName(provider)],
    ["offboarding_started_at", record.started_at],
    ["staff_access_disabled_at", record.access_disabled_at],
    ["handover_received_by", record.handover_received_by],
    ["handover_received_on", record.handover_received_on],
    ["handover_choice", record.handover_choice],
    ["handover_letter_reference", record.handover_letter_reference],
    ["seal_started_at", record.seal_started_at],
    ["seal_completed_at", record.seal_completed_at],
    ["seal_retain_until", record.seal_retain_until ?? "clinical retention policy"],
    ["offboarded_at", record.offboarded_at],
    ["charts_total", progress.total],
    ["charts_sealed", progress.sealed],
    ["charts_destroyed", progress.destroyed],
    ["charts_awaiting_destruction", Math.max(0, progress.sealed - progress.destroyed)],
    ["generated_at", generatedAt],
  ];
  for (const [key, value] of summary) lines.push(["summary", key, csvCell(value)].join(","));
  lines.push("");
  lines.push("tombstone_id,requested_at,purged_at,was_activated,program_id,enrolled_on");
  for (const row of rows) {
    lines.push([row.id, row.requested_at, row.purged_at, row.was_activated, row.program_id, row.enrolled_on].map(csvCell).join(","));
  }
  await audit(req, caller, provider.provider_id, "office_destruction_certificate_downloaded", { rows: rows.length, destroyed: progress.destroyed });
  const slug = officeName(provider).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || provider.provider_id;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="thinnr-destruction-certificate-${slug}-${generatedAt.slice(0, 10)}.csv"`);
  res.send(`${lines.join("\n")}\n`);
}, { mutation: false }));

export default router;
