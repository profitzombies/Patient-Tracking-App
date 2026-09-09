/**
 * Patient self-service data export.
 *
 * Lifecycle: queued -> running -> ready | failed -> expired.
 *   * `drainPatientExports` claims one job at a time through the
 *     `claim_next_patient_data_export` RPC (FOR UPDATE SKIP LOCKED), assembles
 *     everything the account owns into one ZIP (JSON sections + the stored
 *     photo bytes), writes it to private object storage UNDER THE PATIENT'S
 *     OWN MEDIA PREFIX (so ownership is in the path and the account purge
 *     sweeps it with everything else), marks the row ready, and enqueues an
 *     "export ready" notification through the outbox.
 *   * `sweepExpiredPatientExports` deletes the object for every job past its
 *     expiry and flips the row to `expired` with its path cleared (strict
 *     delete: a storage failure keeps the row so the next sweep retries).
 *
 * The archive is built from the same service-role reads the app's state
 * endpoint uses, scoped by patient_id on every table — nothing another
 * patient owns can leak in because no query lacks the scope.
 */
import JSZip from "jszip";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { objectStorage } from "../lib/objectStorage";
import { supabaseAdmin } from "../lib/supabase-admin";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { supabaseNotificationStore } from "../notifications/store";
import { CONSENT_SELECT } from "./consent";

const enc = encodeURIComponent;

export const PATIENT_EXPORT_SELECT =
  "id,patient_id,status,object_path,size_bytes,error,attempts,created_at,started_at,completed_at,expires_at,notified_at,download_count,last_downloaded_at";

export interface PatientExportRow {
  id: string;
  patient_id: string;
  status: "queued" | "running" | "ready" | "failed" | "expired";
  object_path: string | null;
  size_bytes: number | null;
  error: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string;
  notified_at: string | null;
  download_count: number;
  last_downloaded_at: string | null;
}

export interface PatientExportDto {
  id: string;
  status: PatientExportRow["status"];
  requestedAt: string;
  completedAt: string | null;
  expiresAt: string;
  sizeBytes: number | null;
  error: string | null;
  downloadCount: number;
}

/** Hours a ready archive stays downloadable. Blank env = default (never 0). */
export function patientExportTtlHours(): number {
  const raw = process.env.PATIENT_EXPORT_TTL_HOURS;
  if (raw === undefined || raw.trim() === "") return 24;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 24;
}

export const EXPORT_NOTIFICATION_KIND = "data_export_ready";

/** Total photo bytes packed into one archive before the rest are listed only. */
const MAX_MEDIA_BYTES = 150 * 1024 * 1024;

export function patientExportDto(row: PatientExportRow, now = Date.now()): PatientExportDto {
  const expiresMs = Date.parse(row.expires_at);
  const expired = row.status === "expired" || (Number.isFinite(expiresMs) && expiresMs <= now);
  const status = expired && (row.status === "ready" || row.status === "failed") ? "expired" : row.status;
  return {
    id: row.id,
    status,
    requestedAt: row.created_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    sizeBytes: status === "ready" ? row.size_bytes : null,
    error: status === "failed" ? row.error : null,
    downloadCount: row.download_count,
  };
}

export function patientExportObjectPath(patientId: string): string {
  return `/objects/patient-media/${patientId}/export-${randomUUID()}.zip`;
}

async function patchExport(id: string, patch: Record<string, unknown>, expectStatus?: string): Promise<boolean> {
  const filter = expectStatus ? `&status=eq.${enc(expectStatus)}` : "";
  const res = await supabaseAdmin(
    "PATCH",
    `/rest/v1/patient_data_exports?id=eq.${enc(id)}${filter}`,
    patch,
    "return=representation",
  );
  if (res.status >= 300) throw new Error(`patient export update failed (${res.status})`);
  return Array.isArray(res.json) && res.json.length === 1;
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300) || "Export failed.";
}

async function rows(path: string, label: string): Promise<Array<Record<string, unknown>>> {
  const result = await supabaseAdmin("GET", path);
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`${label} read failed (${result.status})`);
  }
  return result.json as Array<Record<string, unknown>>;
}

async function allRows(path: string, label: string): Promise<Array<Record<string, unknown>>> {
  const output: Array<Record<string, unknown>> = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let offset = 0;; offset += 500) {
    const page = await rows(`${path}${separator}limit=500&offset=${offset}`, label);
    output.push(...page);
    if (page.length < 500) return output;
  }
}

const PROFILE_FIELDS =
  "id,first_name,last_name,name,email,phone,date_of_birth,gender,sex,height_unit,height_cm,height_inches,starting_weight,current_weight,goal_weight,timezone,program_id,program_start_date,email_verified_at,phone_verified_at,profile_completed_at,created_at,onboarded_at,claimed_at";

/** Media object paths referenced by the account's rows, deduplicated. */
function mediaPathsOf(input: {
  photos: Array<Record<string, unknown>>;
  media: Array<Record<string, unknown>>;
  foods: Array<Record<string, unknown>>;
  recipes: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
}): string[] {
  const paths = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.startsWith("/objects/patient-media/")) paths.add(value);
  };
  for (const row of input.photos) add(row.object_path);
  for (const row of input.media) add(row.object_path);
  for (const row of input.foods) add(row.photo_path);
  for (const row of input.recipes) add(row.photo_path);
  for (const row of input.messages) {
    const photo = row.photo;
    if (photo && typeof photo === "object") add((photo as Record<string, unknown>).objectPath ?? (photo as Record<string, unknown>).path);
    else add(photo);
  }
  return [...paths];
}

/** Every section the archive carries. Exported for tests. */
export interface PatientArchiveSections {
  profile: Record<string, unknown> | null;
  consents: Array<Record<string, unknown>>;
  flags: Record<string, unknown> | null;
  diary: Array<Record<string, unknown>>;
  water: Array<Record<string, unknown>>;
  targets: Record<string, unknown> | null;
  library: {
    customFoods: Array<Record<string, unknown>>;
    savedRecipes: Array<Record<string, unknown>>;
    favorites: unknown[];
    recents: unknown[];
  };
  checkIns: Array<Record<string, unknown>>;
  measurements: {
    healthImports: Array<Record<string, unknown>>;
    bodyMeasurements: Array<Record<string, unknown>>;
    clinicWeights: Array<Record<string, unknown>>;
  };
  medications: {
    list: Array<Record<string, unknown>>;
    doseLogs: Array<Record<string, unknown>>;
  };
  photos: Array<Record<string, unknown>>;
  media: Array<Record<string, unknown>>;
  chat: Array<{ conversation: Record<string, unknown>; messages: Array<Record<string, unknown>> }>;
  bloodwork: {
    reports: Array<Record<string, unknown>>;
    files: Array<Record<string, unknown>>;
    results: Array<Record<string, unknown>>;
    corrections: Array<Record<string, unknown>>;
    incompleteTranscriptionPages: Array<{
      reportId: string;
      sourceFileId: string;
      sourcePage: number;
      extractionStatus: "queued" | "processing" | "failed";
      status: "incomplete";
      results: unknown[];
    }>;
  };
}

const MAX_ROWS = 20_000;

export async function loadPatientArchiveSections(patientId: string): Promise<PatientArchiveSections> {
  const pid = enc(patientId);
  const scope = `patient_id=eq.${pid}`;
  const [profile, consents, flags, diary, water, targets, prefs, foods, recipes, checkIns, health, body, staffWeights, medications, doseLogs, photos, media, conversations] =
    await Promise.all([
      rows(`/rest/v1/patients?id=eq.${pid}&select=${PROFILE_FIELDS}&limit=1`, "profile"),
      rows(`/rest/v1/patient_consents?${scope}&select=${CONSENT_SELECT}&order=recorded_at.asc`, "consents"),
      rows(`/rest/v1/patient_flags?${scope}&select=nudge_opt_out,nudge_engaged,onboarding_complete,onboarding_answers,notification_prefs,created_at,updated_at&limit=1`, "flags"),
      rows(`/rest/v1/patient_diary_entries?${scope}&select=entry_id,date_key,meal,kind,ref_id,name,detail,quantity,calories,protein,carbs,fat,adjustments,created_at,updated_at&order=date_key.asc,created_at.asc&limit=${MAX_ROWS}`, "diary"),
      rows(`/rest/v1/patient_water_days?${scope}&select=date_key,oz&order=date_key.asc&limit=${MAX_ROWS}`, "water"),
      rows(`/rest/v1/patient_target_overrides?${scope}&select=calories,protein,carbs,fat,water_oz&limit=1`, "targets"),
      rows(`/rest/v1/patient_food_prefs?${scope}&select=favorites,recents&limit=1`, "prefs"),
      rows(`/rest/v1/patient_custom_foods?${scope}&select=food_id,name,brand,serving,calories,protein,carbs,fat,photo_path,created_at,updated_at&order=created_at.asc&limit=${MAX_ROWS}`, "custom foods"),
      rows(`/rest/v1/patient_saved_recipes?${scope}&select=recipe_id,name,meal,mode,tags,minutes,servings,calories,protein,carbs,fat,description,ingredients,steps,grocery_list,saved_at,photo_path,created_at,updated_at&order=created_at.asc&limit=${MAX_ROWS}`, "saved recipes"),
      rows(`/rest/v1/patient_check_ins?${scope}&select=check_in_id,date_key,weight,mood,side_effects,notes,created_at,updated_at&order=date_key.asc&limit=${MAX_ROWS}`, "check-ins"),
      rows(`/rest/v1/patient_health_measurements?${scope}&select=source,source_id,kind,value,measured_at,imported_at&order=measured_at.asc&limit=${MAX_ROWS}`, "health measurements"),
      rows(`/rest/v1/patient_body_measurements?${scope}&select=visit_id,date_key,note,neck,chest,left_arm,right_arm,waist,hips,left_thigh,right_thigh,left_calf,right_calf,recorded_by_name,created_at,updated_at&order=date_key.asc&limit=${MAX_ROWS}`, "body measurements"),
      rows(`/rest/v1/patient_staff_weights?${scope}&select=weight_id,date_key,weight,note,recorded_by_name,created_at,updated_at&order=date_key.asc&limit=${MAX_ROWS}`, "clinic weights"),
      rows(`/rest/v1/patient_medications?${scope}&select=id,name,form,dose,schedule_kind,times,weekday,notes,start_date,stop_date,source,created_by_name,created_at,updated_at&order=created_at.asc&limit=${MAX_ROWS}`, "medications"),
      rows(`/rest/v1/patient_medication_dose_logs?${scope}&select=id,medication_id,due_date,due_time,status,source,logged_at,created_at,updated_at&order=due_date.asc,due_time.asc&limit=${MAX_ROWS}`, "medication dose logs"),
      rows(`/rest/v1/patient_progress_photos?${scope}&select=photo_id,date_key,label,angle,object_path,created_at&order=created_at.asc&limit=${MAX_ROWS}`, "progress photos"),
      rows(`/rest/v1/patient_media?${scope}&select=object_path,kind,content_type,size_bytes,created_at&order=created_at.asc&limit=${MAX_ROWS}`, "media ledger"),
      rows(`/rest/v1/patient_chat_conversations?${scope}&select=id,thread,created_at,updated_at&order=created_at.asc&limit=200`, "chat conversations"),
    ]);
  const chat: PatientArchiveSections["chat"] = [];
  for (const conversation of conversations) {
    const messages = await rows(
      `/rest/v1/patient_chat_messages?conversation_id=eq.${enc(String(conversation.id))}` +
        `&select=client_id,seq,role,text,stopped,hidden,card,quick_replies,reply_to_client_id,photo,created_at&order=seq.asc&limit=${MAX_ROWS}`,
      "chat messages",
    );
    chat.push({ conversation, messages });
  }
  const [bloodworkReports, bloodworkFiles, bloodworkResults, bloodworkCorrections] = await Promise.all([
    allRows(
      `/rest/v1/patient_bloodwork_reports?${scope}&select=id,client_request_id,title,report_date,kind,lifecycle_status,extraction_status,extraction_error,version,uploaded_at,committed_at,deleted_at,extraction_attempt&order=uploaded_at.asc,id.asc`,
      "bloodwork reports",
    ),
    allRows(
      `/rest/v1/patient_bloodwork_files?${scope}&select=id,report_id,client_file_id,position,declared_mime_type,declared_size_bytes,object_path,mime_type,size_bytes,page_count,width,height,created_at&order=created_at.asc,id.asc`,
      "bloodwork files",
    ),
    allRows(
      `/rest/v1/patient_bloodwork_results?${scope}&select=id,report_id,source_file_id,source_page,position,original_test_name,original_value_text,original_units,original_reference_range,original_lab_flag,original_uncertain,test_name,value_text,units,reference_range,lab_flag,uncertain,version,corrected,updated_at&order=report_id.asc,source_file_id.asc,source_page.asc,position.asc,id.asc`,
      "bloodwork results",
    ),
    allRows(
      `/rest/v1/patient_bloodwork_corrections?${scope}&select=id,report_id,result_id,actor_role,actor_user_id,before_values,after_values,version,created_at&order=created_at.asc,id.asc`,
      "bloodwork corrections",
    ),
  ]);
  const incompleteReports = new Map<string, "queued" | "processing" | "failed">();
  for (const report of bloodworkReports) {
    const status = String(report.extraction_status);
    if (status === "queued" || status === "processing" || status === "failed") {
      incompleteReports.set(String(report.id), status);
    }
  }
  const incompleteTranscriptionPages: PatientArchiveSections["bloodwork"]["incompleteTranscriptionPages"] = [];
  const incompleteReportIds = [...incompleteReports.keys()];
  for (let index = 0; index < incompleteReportIds.length; index += 50) {
    const ids = incompleteReportIds.slice(index, index + 50);
    const pages = await allRows(
      `/rest/v1/patient_bloodwork_extraction_pages?report_id=in.(${ids.map(enc).join(",")})` +
        "&select=report_id,source_file_id,source_page,results&order=report_id.asc,source_file_id.asc,source_page.asc",
      "incomplete bloodwork transcription pages",
    );
    for (const page of pages) {
      const reportId = String(page.report_id);
      const extractionStatus = incompleteReports.get(reportId);
      // Defense in depth: only rows joined in application memory to one of
      // this patient's exported report IDs can enter the archive.
      if (!extractionStatus) continue;
      incompleteTranscriptionPages.push({
        reportId,
        sourceFileId: String(page.source_file_id),
        sourcePage: Number(page.source_page),
        extractionStatus,
        status: "incomplete",
        results: Array.isArray(page.results) ? page.results : [],
      });
    }
  }
  const prefRow = prefs[0];
  return {
    profile: profile[0] ?? null,
    consents,
    flags: flags[0] ? stripPassword(flags[0]) : null,
    diary,
    water,
    targets: targets[0] ?? null,
    library: {
      customFoods: foods,
      savedRecipes: recipes,
      favorites: Array.isArray(prefRow?.favorites) ? (prefRow.favorites as unknown[]) : [],
      recents: Array.isArray(prefRow?.recents) ? (prefRow.recents as unknown[]) : [],
    },
    checkIns,
    measurements: { healthImports: health, bodyMeasurements: body, clinicWeights: staffWeights },
    medications: { list: medications, doseLogs },
    photos,
    media,
    chat,
    bloodwork: {
      reports: bloodworkReports,
      files: bloodworkFiles,
      results: bloodworkResults,
      corrections: bloodworkCorrections,
      incompleteTranscriptionPages,
    },
  };
}

/** Onboarding answers once carried a password field; never export it even from legacy rows. */
function stripPassword(flagRow: Record<string, unknown>): Record<string, unknown> {
  const answers = flagRow.onboarding_answers;
  if (answers && typeof answers === "object" && !Array.isArray(answers)) {
    const { password: _password, ...rest } = answers as Record<string, unknown>;
    return { ...flagRow, onboarding_answers: rest };
  }
  return flagRow;
}

function mediaFileName(objectPath: string): string {
  return objectPath.slice(objectPath.lastIndexOf("/") + 1);
}

/**
 * Build the ZIP bytes for one patient. `readMedia` is injectable so tests can
 * pack synthetic photo bytes without object storage.
 */
export async function buildPatientArchive(
  patientId: string,
  options: {
    sections?: PatientArchiveSections;
    readMedia?: (objectPath: string) => Promise<Buffer>;
    generatedAt?: Date;
  } = {},
): Promise<{ buffer: Buffer; sections: PatientArchiveSections; mediaIncluded: number; mediaSkipped: number }> {
  const sections = options.sections ?? (await loadPatientArchiveSections(patientId));
  const readMedia =
    options.readMedia ??
    (async (objectPath: string) => {
      const file = await objectStorage.entityFile(objectPath);
      const [content] = await file.download();
      return content;
    });
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const zip = new JSZip();
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  zip.file("profile.json", json(sections.profile));
  zip.file("consents.json", json(sections.consents));
  zip.file("preferences.json", json(sections.flags));
  zip.file("diary.json", json(sections.diary));
  zip.file("water.json", json(sections.water));
  zip.file("targets.json", json(sections.targets));
  zip.file("library.json", json(sections.library));
  zip.file("check-ins.json", json(sections.checkIns));
  zip.file("measurements.json", json(sections.measurements));
  zip.file("medications.json", json(sections.medications));
  zip.file("photos.json", json(sections.photos));
  zip.file("chat.json", json(sections.chat));

  const mediaPaths = mediaPathsOf({
    photos: sections.photos,
    media: sections.media,
    foods: sections.library.customFoods,
    recipes: sections.library.savedRecipes,
    messages: sections.chat.flatMap((c) => c.messages),
  }).filter((path) => !/\/export-[0-9a-f-]{36}\.zip$/.test(path));
  let packed = 0;
  let included = 0;
  const skipped: string[] = [];
  const manifest: Array<{ objectPath: string; file: string | null }> = [];
  for (const objectPath of mediaPaths) {
    if (packed >= MAX_MEDIA_BYTES) {
      skipped.push(objectPath);
      manifest.push({ objectPath, file: null });
      continue;
    }
    try {
      const content = await readMedia(objectPath);
      if (packed + content.byteLength > MAX_MEDIA_BYTES) {
        skipped.push(objectPath);
        manifest.push({ objectPath, file: null });
        continue;
      }
      const name = `media/${mediaFileName(objectPath)}`;
      zip.file(name, content);
      packed += content.byteLength;
      included += 1;
      manifest.push({ objectPath, file: name });
    } catch (error) {
      // A missing object is not a reason to fail the whole export.
      logger.warn({ err: error, objectPath }, "patient export media read failed");
      skipped.push(objectPath);
      manifest.push({ objectPath, file: null });
    }
  }
  zip.file("media.json", json({ ledger: sections.media, files: manifest, skipped }));

  const bloodworkFiles: Array<Record<string, unknown>> = [];
  let bloodworkSkipped = 0;
  for (const row of sections.bloodwork.files) {
    const { object_path: objectPath, ...metadata } = row;
    const reportId = String(row.report_id);
    const fileId = String(row.id);
    const mimeType = typeof row.mime_type === "string" ? row.mime_type : row.declared_mime_type;
    const extension = mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg";
    const archiveFile = `bloodwork/files/${reportId}/${String(row.position).padStart(2, "0")}-${fileId}.${extension}`;
    let omittedReason: "not_committed" | "archive_size_limit" | "source_unavailable" | null = null;
    if (typeof objectPath !== "string" || objectPath === "") {
      omittedReason = "not_committed";
    } else {
      try {
        const content = await readMedia(objectPath);
        if (packed + content.byteLength > MAX_MEDIA_BYTES) {
          omittedReason = "archive_size_limit";
        } else {
          zip.file(archiveFile, content);
          packed += content.byteLength;
          included += 1;
        }
      } catch (error) {
        logger.warn({ err: error, reportId, fileId }, "patient export bloodwork source read failed");
        omittedReason = "source_unavailable";
      }
    }
    if (omittedReason) bloodworkSkipped += 1;
    bloodworkFiles.push({
      ...metadata,
      archiveFile: omittedReason === null ? archiveFile : null,
      omittedFileName: omittedReason === null ? null : archiveFile,
      omittedReason,
    });
  }
  zip.file("bloodwork.json", json({
    reports: sections.bloodwork.reports,
    files: bloodworkFiles,
    results: sections.bloodwork.results,
    corrections: sections.bloodwork.corrections,
    incompleteTranscriptionPages: sections.bloodwork.incompleteTranscriptionPages,
  }));
  zip.file(
    "README.txt",
    [
      "THINNR patient data export",
      `Generated: ${generatedAt}`,
      `Patient id: ${patientId}`,
      "",
      "profile.json        Account profile and program details",
      "consents.json       Consent records by policy version",
      "preferences.json    Onboarding answers and notification preferences",
      "diary.json          Food diary entries",
      "water.json          Daily water totals",
      "targets.json        Daily target overrides",
      "library.json        Custom foods, saved recipes, favorites, recents",
      "check-ins.json      Check-ins (weight, mood, side effects, notes)",
      "measurements.json   Imported health data, body measurements, clinic-recorded weights",
      "medications.json    Medication list and dose logs (taken / skipped)",
      "photos.json         Progress photo records (bytes under media/)",
      "chat.json           Coach chat transcripts",
      "media.json          Stored photo files included in media/ and any skipped",
      "bloodwork.json      Reports, source omissions, published results, corrections, and distinctly labeled incomplete transcription checkpoints",
      "bloodwork/files/    Original committed bloodwork source files included within the archive size limit",
    ].join("\n"),
  );
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer, sections, mediaIncluded: included, mediaSkipped: skipped.length + bloodworkSkipped };
}

/** Run one claimed export to completion. Exported for tests. */
export async function runPatientExportJob(job: PatientExportRow): Promise<void> {
  try {
    const { buffer, mediaIncluded } = await buildPatientArchive(job.patient_id);
    const objectPath = patientExportObjectPath(job.patient_id);
    await objectStorage.saveBuffer(objectPath, buffer, "application/zip");
    const landed = await patchExport(
      job.id,
      { status: "ready", object_path: objectPath, size_bytes: buffer.byteLength, completed_at: new Date().toISOString(), error: null },
      "running",
    );
    if (!landed) {
      await objectStorage.deleteObjectStrict(objectPath);
      return;
    }
    try {
      await supabaseNotificationStore.enqueue({
        patientId: job.patient_id,
        kind: EXPORT_NOTIFICATION_KIND,
        category: "account",
        title: "Your data export is ready",
        body: "Open Account > Privacy & data to download it. The link expires soon.",
        data: { route: "/account", exportId: job.id },
        dedupeKey: `${EXPORT_NOTIFICATION_KIND}:${job.id}`,
      });
      await patchExport(job.id, { notified_at: new Date().toISOString() });
    } catch (error) {
      logger.error({ err: error, jobId: job.id }, "patient export ready notification failed");
    }
    await recordAdminAuditEvent({
      action: "patient_export_ready",
      actorUserId: null,
      actorKind: "system",
      providerId: null,
      targetKind: "patient",
      targetId: job.patient_id,
      requestId: null,
      metadata: { exportId: job.id, size: buffer.byteLength, objects: mediaIncluded },
    }).catch((error) => logger.error({ err: error }, "patient export audit failed"));
  } catch (error) {
    logger.error({ err: error, jobId: job.id }, "patient export job failed");
    try {
      await patchExport(job.id, { status: "failed", error: shortError(error), completed_at: new Date().toISOString() }, "running");
      await recordAdminAuditEvent({
        action: "patient_export_failed",
        actorUserId: null,
        actorKind: "system",
        providerId: null,
        targetKind: "patient",
        targetId: job.patient_id,
        requestId: null,
        metadata: { exportId: job.id, attempt: job.attempts },
      }).catch(() => {});
    } catch (patchError) {
      logger.error({ err: patchError, jobId: job.id }, "patient export failure not recorded");
    }
  }
}

let draining: Promise<number> | null = null;

/** Claim and run queued exports until the queue is empty (single-flight). */
export function drainPatientExports(maxJobs = 10): Promise<number> {
  if (draining) return draining;
  draining = (async () => {
    let ran = 0;
    try {
      while (ran < maxJobs) {
        const claimed = await supabaseAdmin("POST", "/rest/v1/rpc/claim_next_patient_data_export", {});
        if (claimed.status >= 300) throw new Error(`patient export claim failed (${claimed.status})`);
        const job = Array.isArray(claimed.json) ? (claimed.json[0] as PatientExportRow | undefined) : undefined;
        if (!job) break;
        await runPatientExportJob(job);
        ran += 1;
      }
    } catch (error) {
      logger.error({ err: error }, "patient export drain stopped");
    } finally {
      draining = null;
    }
    return ran;
  })();
  return draining;
}

const PRUNE_AFTER_DAYS = 14;

/** Expire past-due exports (deleting their archives) and prune long-expired rows. */
export async function sweepExpiredPatientExports(now = new Date()): Promise<{ expired: number; pruned: number }> {
  const nowIso = now.toISOString();
  const due = await supabaseAdmin(
    "GET",
    `/rest/v1/patient_data_exports?select=id,object_path,status&status=in.(queued,running,ready,failed)&expires_at=lt.${enc(nowIso)}&order=expires_at.asc&limit=200`,
  );
  if (due.status >= 300 || !Array.isArray(due.json)) throw new Error(`patient export expiry scan failed (${due.status})`);
  let expired = 0;
  for (const row of due.json as Array<{ id: string; object_path: string | null; status: string }>) {
    try {
      if (row.object_path) await objectStorage.deleteObjectStrict(row.object_path);
      const patch: Record<string, unknown> = { status: "expired", object_path: null };
      if (row.status === "queued" || row.status === "running") patch.error = "Expired before it could finish.";
      await patchExport(row.id, patch);
      expired += 1;
    } catch (error) {
      logger.error({ err: error, jobId: row.id }, "patient export expiry failed; will retry");
    }
  }
  const pruneBefore = new Date(now.getTime() - PRUNE_AFTER_DAYS * 86_400_000).toISOString();
  const pruned = await supabaseAdmin(
    "DELETE",
    `/rest/v1/patient_data_exports?status=eq.expired&expires_at=lt.${enc(pruneBefore)}`,
    undefined,
    "return=representation",
  );
  if (pruned.status >= 300) throw new Error(`patient export prune failed (${pruned.status})`);
  return { expired, pruned: Array.isArray(pruned.json) ? pruned.json.length : 0 };
}
