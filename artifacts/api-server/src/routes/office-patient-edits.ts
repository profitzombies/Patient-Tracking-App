/**
 * Provider-portal write actions on a live patient record.
 *
 * Office staff (and HQ with provider_manage on an explicitly named office)
 * can edit demographics/contact fields, leave staff-only provider notes,
 * record/correct/remove staff weigh-ins, log/remove body measurement visits,
 * and set the activation status with a reason. Every route:
 *   * resolves office scope with provider_manage + requireUnlocked, so locked
 *     and disabled offices and HQ roles without the permission are refused;
 *   * looks the patient up scoped to that office in the same query, so a
 *     cross-office id answers the identical neutral 404 as an unknown id;
 *   * preconditions patient-row edits on the record version (updated_at) the
 *     client rendered — a stale save is a 409 "reload", never an overwrite;
 *   * records an audit event with actor, patient, and a field summary only
 *     (no note bodies, weights, measurements, reasons, or other clinical text).
 *
 * Profile edits run through one SQL function so a claimed account's login
 * identifiers move in the same transaction as the patients row.
 */
import { Router, type IRouter, type Request } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";
import { resolveOfficeScope, type OfficeScope } from "../auth/office-scope";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { normalizeUsPhone } from "./provider-accounts";
import { dayKeyInTimeZone } from "../lib/local-day";
import {
  EMAIL_TAKEN,
  PATIENT_SELECT,
  PHONE_TAKEN,
  RECORD_NOT_FOUND,
  SERVER_ERROR,
  identityDto,
  patientDto,
  patientUniqueConflict,
  recordVersion,
  providerNoteDto,
  staffWeightDto,
  bodyMeasurementDto,
  type PatientRosterRow,
} from "./office-roster";
import { BODY_AREAS, MEASUREMENT_COLUMNS, inchesIssue, type BodyAreaKey } from "../lib/body-measurements";

const router: IRouter = Router();
const enc = encodeURIComponent;

export const RECORD_CHANGED = "This record changed since you opened it. Reload to see the latest version.";
const WEIGHT_DAY_TAKEN = "A staff weigh-in already exists for that date. Edit that entry instead.";
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Shared plumbing ──────────────────────────────────────────────────────────

type Scoped =
  | { kind: "ok"; scope: OfficeScope; patient: PatientRosterRow }
  | { kind: "denied"; status: number; message: string };

/**
 * Manage-scope + scoped patient lookup. Office staff get their own office;
 * HQ names one via `?office=` or body.office. The lookup filters on
 * provider_id so another office's patient is indistinguishable from none,
 * and archived rows are treated the same way (no live-record writes land on
 * an archived patient, matching the profile RPC's guard).
 */
async function scopedPatient(req: Request): Promise<Scoped> {
  const bodyOffice = req.body && typeof req.body === "object" && typeof (req.body as { office?: unknown }).office === "string"
    ? String((req.body as { office: string }).office) : null;
  const resolved = await resolveOfficeScope({
    authorization: req.headers.authorization,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : bodyOffice,
    hqPermission: "provider_manage",
    requireUnlocked: true,
  });
  if (resolved.kind !== "ok") return { kind: "denied", status: resolved.status, message: resolved.message };
  const patientId = String(req.params.id ?? "");
  const found = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(resolved.scope.providerId)}&archived_at=is.null&select=${PATIENT_SELECT}&limit=1`,
  );
  if (found.status >= 300) throw new Error(`patient record lookup failed (${found.status})`);
  const patient = Array.isArray(found.json) ? (found.json[0] as PatientRosterRow | undefined) : undefined;
  if (!patient) return { kind: "denied", status: 404, message: RECORD_NOT_FOUND };
  return { kind: "ok", scope: resolved.scope, patient };
}

async function reloadPatient(patientId: string, providerId: string): Promise<PatientRosterRow> {
  const found = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(providerId)}&archived_at=is.null&select=${PATIENT_SELECT}&limit=1`,
  );
  const row = found.status < 300 && Array.isArray(found.json) ? (found.json[0] as PatientRosterRow | undefined) : undefined;
  if (!row) throw new Error(`patient record reload failed (${found.status})`);
  return row;
}

function patientSummary(row: PatientRosterRow) {
  return { identity: identityDto(row), program: patientDto(row).program, version: recordVersion(row) };
}

/** Display name stored on notes/weights so "who wrote this" survives staff churn. */
async function actorDisplayName(scope: OfficeScope): Promise<string> {
  if (scope.actorKind === "provider") return scope.providerName;
  const path = scope.actorKind === "team_member"
    ? `/rest/v1/team_members?auth_user_id=eq.${enc(scope.actorUserId)}&select=name&limit=1`
    : `/rest/v1/hq_memberships?auth_user_id=eq.${enc(scope.actorUserId)}&status=eq.active&select=display_name&limit=1`;
  const res = await supabaseAdmin("GET", path);
  const row = res.status < 300 && Array.isArray(res.json) ? (res.json[0] as PatientRosterRow | undefined) : undefined;
  const name = String(row?.name ?? row?.display_name ?? "").trim();
  if (name) return name.slice(0, 160);
  return scope.actorKind === "team_member" ? `${scope.officeName} staff` : "THINNR HQ";
}

type AuditMeta = Record<string, string | number | boolean | null>;
function audit(req: Request, scope: OfficeScope, action: string, patientId: string, metadata: AuditMeta) {
  return recordAdminAuditEvent({
    action,
    actorUserId: scope.actorUserId,
    actorKind: scope.actorKind,
    providerId: scope.providerId,
    targetKind: "patient",
    targetId: patientId,
    requestId: req.headers["x-request-id"]?.toString() ?? null,
    metadata,
  }).catch((error) => req.log?.error({ err: error }, `${action} audit failed`));
}

function firstIssue(error: z.ZodError): { error: string; field?: string } {
  const issue = error.issues[0];
  return { error: issue?.message ?? "Check the form and try again.", field: typeof issue?.path?.[0] === "string" ? issue.path[0] : undefined };
}

function versionFilter(expected: string | null): string {
  return expected === null ? "updated_at=is.null" : `updated_at=eq.${enc(expected)}`;
}

/** Version echo: null for legacy rows, otherwise the exact timestamp string the read returned. */
const Version = z.union([z.string().trim().min(1).max(64), z.null()]);

function validDateKey(value: string): boolean {
  if (!DATE_KEY_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function yearsAgoDateKey(years: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function heightText(inches: number): string {
  const feet = Math.floor(inches / 12);
  const rest = Math.round((inches - feet * 12) * 10) / 10;
  return `${feet}' ${rest}"`;
}

// ── Profile ──────────────────────────────────────────────────────────────────

const ProfileInput = z.object({
  expectedVersion: Version,
  office: z.string().trim().max(120).optional(),
  firstName: z.string().trim().min(1, "First name is required.").max(80, "First name is too long.").optional(),
  lastName: z.string().trim().min(1, "Last name is required.").max(80, "Last name is too long.").optional(),
  email: z.string().trim().min(1, "Email is required.").max(320, "Email is too long.").email("Enter a valid email address.").optional(),
  phone: z.string().trim().min(1, "Phone number is required.").max(40, "Enter a valid 10-digit US mobile number.").optional(),
  dateOfBirth: z.union([z.string().trim(), z.null()]).optional(),
  heightInches: z.union([z.number(), z.null()]).optional(),
  goalWeight: z.union([z.number(), z.null()]).optional(),
  programStartDate: z.union([z.string().trim(), z.null()]).optional(),
  timezone: z.union([z.string().trim().max(64), z.null()]).optional(),
});

router.patch("/office/patients/:id", async (req, res) => {
  try {
    const parsed = ProfileInput.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json(firstIssue(parsed.error)); return; }
    const input = parsed.data;
    const patch: Record<string, string | number | null> = {};
    const fields: string[] = [];
    if (input.firstName !== undefined) { patch.first_name = input.firstName.replace(/\s+/g, " "); fields.push("firstName"); }
    if (input.lastName !== undefined) { patch.last_name = input.lastName.replace(/\s+/g, " "); fields.push("lastName"); }
    if (input.email !== undefined) { patch.email = input.email.toLowerCase(); fields.push("email"); }
    if (input.phone !== undefined) {
      const display = normalizeUsPhone(input.phone);
      if (!display) { res.status(400).json({ error: "Enter a valid 10-digit US mobile number.", field: "phone" }); return; }
      patch.phone = `+1${display.replace(/\D/g, "")}`;
      fields.push("phone");
    }
    if (input.dateOfBirth !== undefined) {
      if (input.dateOfBirth !== null && (!validDateKey(input.dateOfBirth) || input.dateOfBirth < yearsAgoDateKey(120) || input.dateOfBirth > yearsAgoDateKey(18))) {
        res.status(400).json({ error: "Date of birth must make the patient 18 to 120 years old.", field: "dateOfBirth" }); return;
      }
      patch.date_of_birth = input.dateOfBirth; fields.push("dateOfBirth");
    }
    if (input.heightInches !== undefined) {
      if (input.heightInches !== null && !(Number.isFinite(input.heightInches) && input.heightInches >= 24 && input.heightInches <= 96)) {
        res.status(400).json({ error: "Height must be between 24 and 96 inches.", field: "heightInches" }); return;
      }
      patch.height_inches = input.heightInches;
      patch.height = input.heightInches === null ? null : heightText(input.heightInches);
      fields.push("heightInches");
    }
    if (input.goalWeight !== undefined) {
      if (input.goalWeight !== null && !(Number.isFinite(input.goalWeight) && input.goalWeight >= 40 && input.goalWeight <= 1500)) {
        res.status(400).json({ error: "Goal weight must be between 40 and 1500 lbs.", field: "goalWeight" }); return;
      }
      patch.goal_weight = input.goalWeight; fields.push("goalWeight");
    }
    if (input.programStartDate !== undefined) {
      if (input.programStartDate !== null && (!validDateKey(input.programStartDate) || input.programStartDate < "2000-01-01" || input.programStartDate > yearsAgoDateKey(-1))) {
        res.status(400).json({ error: "Enter a valid program start date.", field: "programStartDate" }); return;
      }
      patch.program_start_date = input.programStartDate; fields.push("programStartDate");
    }
    if (input.timezone !== undefined) {
      if (input.timezone !== null && !validTimeZone(input.timezone)) {
        res.status(400).json({ error: "Enter a valid IANA time zone, like America/Chicago.", field: "timezone" }); return;
      }
      patch.timezone = input.timezone; fields.push("timezone");
    }
    if (fields.length === 0) { res.status(400).json({ error: "Change at least one field." }); return; }

    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { res.status(scoped.status).json({ error: scoped.message }); return; }
    const { scope, patient } = scoped;
    const patientId = String(patient.id);

    const updated = await supabaseAdmin("POST", "/rest/v1/rpc/office_update_patient_profile", {
      p_provider_id: scope.providerId,
      p_patient_id: patientId,
      p_patch: patch,
      p_expected_updated_at: input.expectedVersion,
      p_actor_user_id: scope.actorUserId,
    });
    if (updated.status >= 300) {
      const message = String((updated.json as { message?: unknown } | null)?.message ?? "");
      if (message.includes("office_patient_record_conflict")) { res.status(409).json({ error: RECORD_CHANGED, code: "record_changed" }); return; }
      if (message.includes("office_patient_record_not_found")) { res.status(404).json({ error: RECORD_NOT_FOUND }); return; }
      const unique = patientUniqueConflict(message) ?? (/users_email_partial_key|users_phone_key|identities_pkey/.test(message) ? (/phone/.test(message) ? "phone" : "email") : null);
      if (unique) { res.status(409).json({ error: unique === "email" ? EMAIL_TAKEN : PHONE_TAKEN, field: unique }); return; }
      throw new Error(`patient profile update failed (${updated.status}) ${message}`);
    }
    const row = (Array.isArray(updated.json) ? updated.json[0] : updated.json) as PatientRosterRow | undefined;
    if (!row || !row.id) throw new Error("patient profile update returned no row");
    await audit(req, scope, "patient_profile_updated", patientId, { fields: fields.join(",") });
    res.json({ patient: patientSummary(row) });
  } catch (error) {
    req.log?.error({ err: error }, "office patient profile update failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

// ── Activation status ────────────────────────────────────────────────────────

const StatusInput = z.object({
  expectedVersion: Version,
  office: z.string().trim().max(120).optional(),
  status: z.enum(["activated", "paused", "discharged"], { errorMap: () => ({ message: "Choose active, paused, or discharged." }) }),
  reason: z.string().trim().max(500, "Keep the reason under 500 characters.").optional(),
});

const STATUS_EDITABLE = new Set(["activated", "active", "paused", "discharged"]);

router.patch("/office/patients/:id/status", async (req, res) => {
  try {
    const parsed = StatusInput.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json(firstIssue(parsed.error)); return; }
    const input = parsed.data;
    const reason = input.reason?.replace(/\s+/g, " ").trim() ?? "";
    if (input.status !== "activated" && !reason) {
      res.status(400).json({ error: "Give a reason for pausing or discharging this patient.", field: "reason" }); return;
    }
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { res.status(scoped.status).json({ error: scoped.message }); return; }
    const { scope, patient } = scoped;
    const patientId = String(patient.id);
    const current = String(patient.activation_status ?? "");
    if (!STATUS_EDITABLE.has(current)) {
      res.status(400).json({ error: "Program status can only change once the patient has connected their account." }); return;
    }
    if (current === input.status) { res.status(400).json({ error: `This patient is already ${input.status === "activated" ? "active" : input.status}.`, field: "status" }); return; }
    const now = new Date().toISOString();
    const updated = await supabaseAdmin(
      "PATCH",
      `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}&${versionFilter(input.expectedVersion)}&select=${PATIENT_SELECT}`,
      {
        activation_status: input.status,
        activation_reason: reason || null,
        activation_updated_at: now,
        activation_updated_by: scope.actorUserId,
        updated_at: now,
      },
      "return=representation",
    );
    if (updated.status >= 300) throw new Error(`patient status update failed (${updated.status})`);
    const row = Array.isArray(updated.json) ? (updated.json[0] as PatientRosterRow | undefined) : undefined;
    if (!row) { res.status(409).json({ error: RECORD_CHANGED, code: "record_changed" }); return; }
    await audit(req, scope, "patient_status_changed", patientId, { from: current, to: input.status });
    res.json({ patient: patientSummary(row) });
  } catch (error) {
    req.log?.error({ err: error }, "office patient status update failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

// ── Provider notes ───────────────────────────────────────────────────────────

const NoteInput = z.object({
  office: z.string().trim().max(120).optional(),
  body: z.string().trim().min(1, "Write the note first.").max(4000, "Keep the note under 4000 characters."),
});

const NOTE_SELECT = "note_id,body,author_name,author_kind,created_at";

router.post("/office/patients/:id/notes", async (req, res) => {
  try {
    const parsed = NoteInput.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json(firstIssue(parsed.error)); return; }
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { res.status(scoped.status).json({ error: scoped.message }); return; }
    const { scope, patient } = scoped;
    const patientId = String(patient.id);
    const noteId = crypto.randomUUID();
    const inserted = await supabaseAdmin(
      "POST",
      `/rest/v1/patient_provider_notes?select=${NOTE_SELECT}`,
      {
        note_id: noteId,
        provider_id: scope.providerId,
        patient_id: patientId,
        body: parsed.data.body,
        author_user_id: scope.actorUserId,
        author_kind: scope.actorKind,
        author_name: await actorDisplayName(scope),
        created_at: new Date().toISOString(),
      },
      "return=representation",
    );
    if (inserted.status >= 300) throw new Error(`provider note insert failed (${inserted.status})`);
    const row = (Array.isArray(inserted.json) ? inserted.json[0] : inserted.json) as PatientRosterRow | undefined;
    if (!row) throw new Error("provider note insert returned no row");
    await audit(req, scope, "patient_note_added", patientId, { noteId });
    res.status(201).json({ note: providerNoteDto(row) });
  } catch (error) {
    req.log?.error({ err: error }, "office provider note failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.delete("/office/patients/:id/notes/:noteId", async (req, res) => {
  try {
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { res.status(scoped.status).json({ error: scoped.message }); return; }
    const { scope, patient } = scoped;
    const patientId = String(patient.id);
    const noteId = String(req.params.noteId ?? "");
    const deleted = await supabaseAdmin(
      "DELETE",
      `/rest/v1/patient_provider_notes?note_id=eq.${enc(noteId)}&patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}&select=note_id`,
      undefined,
      "return=representation",
    );
    if (deleted.status >= 300) throw new Error(`provider note delete failed (${deleted.status})`);
    if (!Array.isArray(deleted.json) || deleted.json.length === 0) { res.status(404).json({ error: "That note is no longer on this record." }); return; }
    await audit(req, scope, "patient_note_deleted", patientId, { noteId });
    res.json({ deleted: true });
  } catch (error) {
    req.log?.error({ err: error }, "office provider note delete failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

// ── Staff weigh-ins ──────────────────────────────────────────────────────────

const WEIGHT_SELECT = "weight_id,date_key,weight,note,recorded_by_name,created_at,updated_at";

const WeightCreateInput = z.object({
  office: z.string().trim().max(120).optional(),
  dateKey: z.string().trim(),
  weight: z.number({ invalid_type_error: "Enter the weight in pounds." }),
  note: z.union([z.string().trim().max(500, "Keep the note under 500 characters."), z.null()]).optional(),
});

const WeightUpdateInput = z.object({
  expectedVersion: Version,
  office: z.string().trim().max(120).optional(),
  dateKey: z.string().trim().optional(),
  weight: z.number({ invalid_type_error: "Enter the weight in pounds." }).optional(),
  note: z.union([z.string().trim().max(500, "Keep the note under 500 characters."), z.null()]).optional(),
});

function weightIssue(weight: number | undefined, dateKey: string | undefined, patient: PatientRosterRow): { error: string; field: string } | null {
  if (weight !== undefined && !(Number.isFinite(weight) && weight >= 40 && weight <= 1500)) {
    return { error: "Weight must be between 40 and 1500 lbs.", field: "weight" };
  }
  if (dateKey !== undefined) {
    const today = dayKeyInTimeZone(typeof patient.timezone === "string" ? patient.timezone : null);
    if (!validDateKey(dateKey) || dateKey < "2000-01-01" || dateKey > today) {
      return { error: "Enter a date on or before today.", field: "dateKey" };
    }
  }
  return null;
}

function weightConflict(message: string): boolean {
  return /patient_staff_weights_one_per_day/.test(message);
}

router.post("/office/patients/:id/weights", async (req, res) => {
  try {
    const parsed = WeightCreateInput.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json(firstIssue(parsed.error)); return; }
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { res.status(scoped.status).json({ error: scoped.message }); return; }
    const { scope, patient } = scoped;
    const patientId = String(patient.id);
    const issue = weightIssue(parsed.data.weight, parsed.data.dateKey, patient);
    if (issue) { res.status(400).json(issue); return; }
    const weightId = crypto.randomUUID();
    const now = new Date().toISOString();
    const inserted = await supabaseAdmin(
      "POST",
      `/rest/v1/patient_staff_weights?select=${WEIGHT_SELECT}`,
      {
        weight_id: weightId,
        provider_id: scope.providerId,
        patient_id: patientId,
        date_key: parsed.data.dateKey,
        weight: Math.round(parsed.data.weight * 10) / 10,
        note: parsed.data.note?.trim() || null,
        recorded_by: scope.actorUserId,
        recorded_by_name: await actorDisplayName(scope),
        created_at: now,
        updated_at: now,
      },
      "return=representation",
    );
    if (inserted.status >= 300) {
      const message = String((inserted.json as { message?: unknown } | null)?.message ?? "");
      if (inserted.status === 409 || weightConflict(message)) { res.status(409).json({ error: WEIGHT_DAY_TAKEN, field: "dateKey" }); return; }
      throw new Error(`staff weight insert failed (${inserted.status})`);
    }
    const row = (Array.isArray(inserted.json) ? inserted.json[0] : inserted.json) as PatientRosterRow | undefined;
    if (!row) throw new Error("staff weight insert returned no row");
    await audit(req, scope, "patient_weight_recorded", patientId, { weightId, dateKey: parsed.data.dateKey });
    res.status(201).json({ weight: staffWeightDto(row), patient: patientSummary(await reloadPatient(patientId, scope.providerId)) });
  } catch (error) {
    req.log?.error({ err: error }, "office staff weight failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.patch("/office/patients/:id/weights/:weightId", async (req, res) => {
  try {
    const parsed = WeightUpdateInput.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json(firstIssue(parsed.error)); return; }
    const input = parsed.data;
    if (input.dateKey === undefined && input.weight === undefined && input.note === undefined) {
      res.status(400).json({ error: "Change at least one field." }); return;
    }
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { res.status(scoped.status).json({ error: scoped.message }); return; }
    const { scope, patient } = scoped;
    const patientId = String(patient.id);
    const issue = weightIssue(input.weight, input.dateKey, patient);
    if (issue) { res.status(400).json(issue); return; }
    const weightId = String(req.params.weightId ?? "");
    const existing = await supabaseAdmin(
      "GET",
      `/rest/v1/patient_staff_weights?weight_id=eq.${enc(weightId)}&patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}&select=${WEIGHT_SELECT}&limit=1`,
    );
    if (existing.status >= 300) throw new Error(`staff weight lookup failed (${existing.status})`);
    if (!Array.isArray(existing.json) || existing.json.length === 0) { res.status(404).json({ error: "That weigh-in is no longer on this record." }); return; }
    const fields: string[] = [];
    const patch: Record<string, string | number | null> = { updated_at: new Date().toISOString() };
    if (input.dateKey !== undefined) { patch.date_key = input.dateKey; fields.push("dateKey"); }
    if (input.weight !== undefined) { patch.weight = Math.round(input.weight * 10) / 10; fields.push("weight"); }
    if (input.note !== undefined) { patch.note = input.note?.trim() || null; fields.push("note"); }
    const updated = await supabaseAdmin(
      "PATCH",
      `/rest/v1/patient_staff_weights?weight_id=eq.${enc(weightId)}&patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}&${versionFilter(input.expectedVersion)}&select=${WEIGHT_SELECT}`,
      patch,
      "return=representation",
    );
    if (updated.status >= 300) {
      const message = String((updated.json as { message?: unknown } | null)?.message ?? "");
      if (updated.status === 409 || weightConflict(message)) { res.status(409).json({ error: WEIGHT_DAY_TAKEN, field: "dateKey" }); return; }
      throw new Error(`staff weight update failed (${updated.status})`);
    }
    const row = Array.isArray(updated.json) ? (updated.json[0] as PatientRosterRow | undefined) : undefined;
    if (!row) { res.status(409).json({ error: RECORD_CHANGED, code: "record_changed" }); return; }
    await audit(req, scope, "patient_weight_updated", patientId, { weightId, fields: fields.join(",") });
    res.json({ weight: staffWeightDto(row), patient: patientSummary(await reloadPatient(patientId, scope.providerId)) });
  } catch (error) {
    req.log?.error({ err: error }, "office staff weight update failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

const WeightDeleteInput = z.object({ expectedVersion: Version, office: z.string().trim().max(120).optional() });

// Removal is preconditioned on the weigh-in's own version exactly like a
// correction: a reading someone else just corrected must not vanish under a
// stale dialog, it must surface the reload conflict.
router.delete("/office/patients/:id/weights/:weightId", async (req, res) => {
  try {
    const parsed = WeightDeleteInput.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json(firstIssue(parsed.error)); return; }
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { res.status(scoped.status).json({ error: scoped.message }); return; }
    const { scope, patient } = scoped;
    const patientId = String(patient.id);
    const weightId = String(req.params.weightId ?? "");
    const existing = await supabaseAdmin(
      "GET",
      `/rest/v1/patient_staff_weights?weight_id=eq.${enc(weightId)}&patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}&select=weight_id&limit=1`,
    );
    if (existing.status >= 300) throw new Error(`staff weight lookup failed (${existing.status})`);
    if (!Array.isArray(existing.json) || existing.json.length === 0) { res.status(404).json({ error: "That weigh-in is no longer on this record." }); return; }
    const deleted = await supabaseAdmin(
      "DELETE",
      `/rest/v1/patient_staff_weights?weight_id=eq.${enc(weightId)}&patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}&${versionFilter(parsed.data.expectedVersion)}&select=weight_id`,
      undefined,
      "return=representation",
    );
    if (deleted.status >= 300) throw new Error(`staff weight delete failed (${deleted.status})`);
    if (!Array.isArray(deleted.json) || deleted.json.length === 0) { res.status(409).json({ error: RECORD_CHANGED, code: "record_changed" }); return; }
    await audit(req, scope, "patient_weight_removed", patientId, { weightId });
    res.json({ deleted: true, patient: patientSummary(await reloadPatient(patientId, scope.providerId)) });
  } catch (error) {
    req.log?.error({ err: error }, "office staff weight delete failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

// ── Body measurement visits ─────────────────────────────────────────────────
//
// A visit records the date plus whichever areas staff measured (inches). The
// per-area values are the only clinical payload: the audit trail carries the
// visit id, the date, and HOW MANY areas were measured — never the numbers.

const MEASUREMENT_SELECT = `visit_id,date_key,note,${MEASUREMENT_COLUMNS},recorded_by_name,created_at,updated_at`;
const NO_MEASUREMENTS = "Enter at least one measurement.";

const MeasurementValues = z.object(
  Object.fromEntries(BODY_AREAS.map((area) => [area.key, z.number({ invalid_type_error: "Enter the measurement in inches." }).optional()])) as Record<BodyAreaKey, z.ZodOptional<z.ZodNumber>>,
).strict();

const MeasurementCreateInput = z.object({
  office: z.string().trim().max(120).optional(),
  dateKey: z.string().trim(),
  note: z.union([z.string().trim().max(500, "Keep the note under 500 characters."), z.null()]).optional(),
  measurements: MeasurementValues,
});

const MeasurementDeleteInput = z.object({ expectedVersion: Version, office: z.string().trim().max(120).optional() });

function measurementIssue(input: z.infer<typeof MeasurementCreateInput>, patient: PatientRosterRow): { error: string; field: string } | null {
  const today = dayKeyInTimeZone(typeof patient.timezone === "string" ? patient.timezone : null);
  if (!validDateKey(input.dateKey) || input.dateKey < "2000-01-01" || input.dateKey > today) {
    return { error: "Enter a date on or before today.", field: "dateKey" };
  }
  let measured = 0;
  for (const area of BODY_AREAS) {
    const value = input.measurements[area.key];
    if (value === undefined) continue;
    const issue = inchesIssue(value);
    if (issue) return { error: issue, field: area.key };
    measured += 1;
  }
  if (measured === 0) return { error: NO_MEASUREMENTS, field: "measurements" };
  return null;
}

/** Field-keyed like firstIssue, but a bad value inside `measurements` names its area. */
function measurementParseIssue(error: z.ZodError): { error: string; field?: string } {
  const issue = error.issues[0];
  const path = issue?.path ?? [];
  if (path[0] === "measurements" && path.length > 1 && typeof path[1] === "string" && issue.code !== "unrecognized_keys") {
    return { error: issue.message, field: path[1] };
  }
  return firstIssue(error);
}

router.post("/office/patients/:id/measurements", async (req, res) => {
  try {
    const parsed = MeasurementCreateInput.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json(measurementParseIssue(parsed.error)); return; }
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { res.status(scoped.status).json({ error: scoped.message }); return; }
    const { scope, patient } = scoped;
    const patientId = String(patient.id);
    const issue = measurementIssue(parsed.data, patient);
    if (issue) { res.status(400).json(issue); return; }
    const visitId = crypto.randomUUID();
    const now = new Date().toISOString();
    const columns: Record<string, number | null> = {};
    let areaCount = 0;
    for (const area of BODY_AREAS) {
      const value = parsed.data.measurements[area.key];
      columns[area.column] = value === undefined ? null : Math.round(value * 10) / 10;
      if (value !== undefined) areaCount += 1;
    }
    const inserted = await supabaseAdmin(
      "POST",
      `/rest/v1/patient_body_measurements?select=${MEASUREMENT_SELECT}`,
      {
        visit_id: visitId,
        provider_id: scope.providerId,
        patient_id: patientId,
        date_key: parsed.data.dateKey,
        note: parsed.data.note?.trim() || null,
        ...columns,
        recorded_by: scope.actorUserId,
        recorded_by_name: await actorDisplayName(scope),
        created_at: now,
        updated_at: now,
      },
      "return=representation",
    );
    if (inserted.status >= 300) throw new Error(`body measurement insert failed (${inserted.status})`);
    const row = (Array.isArray(inserted.json) ? inserted.json[0] : inserted.json) as PatientRosterRow | undefined;
    if (!row) throw new Error("body measurement insert returned no row");
    await audit(req, scope, "patient_measurements_recorded", patientId, { visitId, dateKey: parsed.data.dateKey, areaCount });
    res.status(201).json({ visit: bodyMeasurementDto(row), patient: patientSummary(await reloadPatient(patientId, scope.providerId)) });
  } catch (error) {
    req.log?.error({ err: error }, "office body measurement failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

// Values on a visit are not editable — a mistaken visit is removed and
// re-logged. Removal is preconditioned on the visit's own version like a
// weigh-in, so a stale dialog surfaces the reload conflict instead of
// deleting something it never saw.
router.delete("/office/patients/:id/measurements/:visitId", async (req, res) => {
  try {
    const parsed = MeasurementDeleteInput.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json(firstIssue(parsed.error)); return; }
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { res.status(scoped.status).json({ error: scoped.message }); return; }
    const { scope, patient } = scoped;
    const patientId = String(patient.id);
    const visitId = String(req.params.visitId ?? "");
    const existing = await supabaseAdmin(
      "GET",
      `/rest/v1/patient_body_measurements?visit_id=eq.${enc(visitId)}&patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}&select=visit_id,date_key&limit=1`,
    );
    if (existing.status >= 300) throw new Error(`body measurement lookup failed (${existing.status})`);
    const found = Array.isArray(existing.json) ? (existing.json[0] as PatientRosterRow | undefined) : undefined;
    if (!found) { res.status(404).json({ error: "That measurement visit is no longer on this record." }); return; }
    const deleted = await supabaseAdmin(
      "DELETE",
      `/rest/v1/patient_body_measurements?visit_id=eq.${enc(visitId)}&patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}&${versionFilter(parsed.data.expectedVersion)}&select=visit_id`,
      undefined,
      "return=representation",
    );
    if (deleted.status >= 300) throw new Error(`body measurement delete failed (${deleted.status})`);
    if (!Array.isArray(deleted.json) || deleted.json.length === 0) { res.status(409).json({ error: RECORD_CHANGED, code: "record_changed" }); return; }
    await audit(req, scope, "patient_measurements_removed", patientId, { visitId, dateKey: String(found.date_key ?? "").slice(0, 10) });
    res.json({ deleted: true, patient: patientSummary(await reloadPatient(patientId, scope.providerId)) });
  } catch (error) {
    req.log?.error({ err: error }, "office body measurement delete failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

export default router;
