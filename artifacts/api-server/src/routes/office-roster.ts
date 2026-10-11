/**
 * Provider-portal live endpoints: an office's live patient roster and
 * patient invitations (create + resend).
 *
 * Scope is never client-chosen for office staff — the bearer token resolves
 * to their own office (auth/office-scope). HQ callers name an office
 * explicitly and need the matching provider permission. Duplicate email and
 * phone conflicts answer with the same neutral wording no matter which
 * office owns the existing row.
 *
 * The invitation email goes out only AFTER the patient row has landed. Its
 * delivery state is durable (patients.invite_email_status) so a failed send
 * surfaces a Resend action instead of silently losing the invite, and the
 * resend rides an atomic conditional UPDATE on invite_email_updated_at — the
 * rate limit and the double-send guard are the same database write.
 *
 * Claiming needs no code here: an invited row's phone is found by the
 * existing passwordless login rail, which links the auth user, preserves
 * provider_id, and flips activation_status to activated (auth/session.ts).
 */
import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";
import { resolveOfficeScope, respondOfficeScopeDenied, type OfficeScope } from "../auth/office-scope";
import { acquireInviteSlot } from "../auth/limits";
import { clientIp } from "../auth/ledger";
import { lookupPatients } from "../auth/directory";
import {
  DeliveryNotConfiguredError,
  sendPatientInvitation,
} from "../claim/delivery";
import { effectiveProviderCode, normalizeUsPhone } from "./provider-accounts";
import { objectStorage } from "../lib/objectStorage";
import { isOwnPatientMediaPath } from "./patient-media";
import { isPhotoSize, resolvePhotoObjectPath, type PhotoSize } from "../lib/photo-variants";
import { programDayFor } from "../coach/real-patient";
import { PROTOCOL_LENGTH_DAYS } from "@workspace/diet-programs";
import { dayKeyInTimeZone } from "../lib/local-day";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { auditRecordAccess } from "../lib/record-access-audit";
import { activityFromSummaryRow, computePatientActivity } from "../lib/patient-activity";
import { ADHERENCE_WINDOW_DAYS, listDoseLogs, listMedications, loadOfficeMedicationState, medicationAdherenceDto } from "../medications/store";
import { shiftDateKey } from "../medications/schedule";
import { activeSubscriptionPatientIds, officePatientSpend, ZERO_SPEND } from "../billing/patient-purchases";
import { outreachRosterDto, type OutreachStateRpcRow } from "../notifications/timeline";
import { BODY_AREAS, MEASUREMENT_COLUMNS } from "../lib/body-measurements";
import { evaluateAttention } from "../lib/attention";
import { loadOfficeDietFacts, NO_DIET_FACTS } from "../diet/roster-facts";
import { patientInvitationLinkVariables, resolvePatientAppLinks } from "../lib/patient-app-link";
import { loadOrgPolicy } from "../lib/org-policy";
import type { DoseLogRecord, MedicationRecord } from "../medications/schedule";

const router: IRouter = Router();

function enc(value: string): string {
  return encodeURIComponent(value);
}

export const SERVER_ERROR = "Something went wrong on our side. Please try again.";
export const EMAIL_TAKEN = "That email is already on a patient account. Use a different email.";
export const PHONE_TAKEN = "That phone number is already on a patient account. Use a different number.";

export function patientUniqueConflict(message: string): "email" | "phone" | null {
  if (/patients_email_(?:normalized_)?unique_idx/.test(message)) return "email";
  if (/patients_phone_(?:normalized_)?unique_idx/.test(message)) return "phone";
  return null;
}

/** Resend cooldown; env knob exists so tests can stage the limit deterministically. */
function resendCooldownSeconds(): number {
  // NB: Number("") is 0 — an unset/blank knob must fall through to the
  // 60s default, not disable the cooldown.
  const raw = process.env.PATIENT_INVITE_RESEND_SECONDS;
  if (raw == null || raw.trim() === "") return 60;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
}

export const PATIENT_SELECT =
  "id,provider_id,first_name,last_name,name,email,phone,activation_status,activation_reason,activation_updated_at,auth_user_id,claimed_at,created_at,updated_at,invited_at,invited_by,invite_email_status,invite_email_updated_at,program_id,program_start_date,date_of_birth,height,height_inches,starting_weight,current_weight,goal_weight,weight_gain_lost,timezone,profile_completed_at,last_login_at,last_log_date,deletion_requested_at,legal_hold,closed_at,record_retain_until,archived_at,archived_into_patient_id";

export const RECORD_SEALED = "This account is closed; the record is read-only.";

export type PatientRosterRow = Record<string, unknown>;
type OperationalRow = Record<string, unknown>;

export type InvitationEmailOutcome = "sent" | "failed" | "not_configured";

export function patientDto(row: PatientRosterRow, asOf?: string) {
  const invited = typeof row.invited_at === "string" && row.invited_at.length > 0;
  const verified = typeof row.auth_user_id === "string" && row.auth_user_id.length > 0;
  const programStartDate = row.program_start_date ? String(row.program_start_date) : null;
  const programDay = programStartDate
    ? programDayFor(
        {
          program_start_date: programStartDate,
          created_at: row.created_at ? String(row.created_at) : null,
        },
        asOf ?? dayKeyInTimeZone(typeof row.timezone === "string" ? row.timezone : null),
      )
    : null;
  return {
    id: String(row.id),
    name: canonicalName(row),
    firstName: canonicalFirstName(row),
    lastName: canonicalLastName(row),
    email: row.email ? String(row.email) : null,
    phone: row.phone ? String(row.phone) : null,
    phoneDisplay: normalizeUsPhone(typeof row.phone === "string" ? row.phone : ""),
    activationStatus: row.activation_status ? String(row.activation_status) : null,
    verified,
    createdAt: row.created_at ? String(row.created_at) : null,
    closure:
      typeof row.closed_at === "string" && row.closed_at.length > 0
        ? {
            closedAt: row.closed_at,
            recordRetainUntil: String(row.record_retain_until),
          }
        : null,
    // Account deletion the PATIENT asked for (staff-initiated deletion is not
    // a thing). `purgeAfter` is filled in by the roster from the request row.
    deletion: deletionStateDto(row),
    // HQ legal hold (direct or via the office): read-only for the office, it
    // only ever blocks deletion. Never shown to the patient.
    legalHold: row.legal_hold === true,
    program: {
      id: row.program_id ? String(row.program_id) : null,
      startDate: programStartDate,
      startingWeight: numericOrNull(row.starting_weight),
      currentWeight: numericOrNull(row.current_weight),
      goalWeight: numericOrNull(row.goal_weight),
      weightChange: numericOrNull(row.weight_gain_lost),
      lastLogDate: row.last_log_date ? String(row.last_log_date) : null,
      day: programDay,
      // Phase is derived from the current protocol episode (the clinical
      // row's start date mirrors the open episode, so a restart moves it).
      stage: programDay == null ? null : programDay <= PROTOCOL_LENGTH_DAYS ? "protocol" : "maintenance",
      week: programDay == null ? null : programDay <= PROTOCOL_LENGTH_DAYS ? Math.ceil(programDay / 7) : null,
    },
    invitation: invited
      ? {
          state: verified ? ("verified" as const) : ("pending" as const),
          invitedAt: String(row.invited_at),
          emailStatus: row.invite_email_status
            ? (String(row.invite_email_status) as "pending" | "sent" | "failed")
            : "pending",
          emailUpdatedAt: row.invite_email_updated_at ? String(row.invite_email_updated_at) : null,
        }
      : null,
  };
}

export interface PatientDeletionStateDto {
  state: "requested";
  requestedAt: string;
  purgeAfter: string | null;
}

function deletionStateDto(row: PatientRosterRow): PatientDeletionStateDto | null {
  if (typeof row.closed_at === "string" && row.closed_at.length > 0) return null;
  return typeof row.deletion_requested_at === "string" && row.deletion_requested_at.length > 0
    ? { state: "requested", requestedAt: row.deletion_requested_at, purgeAfter: null }
    : null;
}

/** PII-free marker for an account that has been purged; counts stay honest. */
export interface DeletedAccountDto {
  id: string;
  requestedAt: string | null;
  purgedAt: string;
  wasActivated: boolean;
  programId: string | null;
  enrolledOn: string | null;
}

export function deletedAccountDto(row: Record<string, unknown>): DeletedAccountDto {
  return {
    id: String(row.id),
    requestedAt: typeof row.requested_at === "string" ? row.requested_at : null,
    purgedAt: String(row.purged_at),
    wasActivated: row.was_activated === true,
    programId: typeof row.program_id === "string" ? row.program_id : null,
    enrolledOn: typeof row.enrolled_on === "string" ? row.enrolled_on.slice(0, 10) : null,
  };
}

function recordDeletionDto(patient: PatientRosterRow, pending: OperationalRow | undefined): PatientDeletionStateDto | null {
  const base = deletionStateDto(patient);
  const purgeAfter = typeof pending?.purge_after === "string" ? pending.purge_after : null;
  if (base) return { ...base, purgeAfter };
  return pending ? { state: "requested", requestedAt: String(pending.requested_at), purgeAfter } : null;
}

function dateOrNull(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function daysOld(date: string | null, asOf: string): number | null {
  if (!date) return null;
  return Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
}

export type RosterStatus = "invited" | "paused" | "discharged" | "inactive" | "needs_attention" | "on_track" | "unknown";

/**
 * Operational facts for one roster row.
 *
 * `fact` is the patient's row from the office-wide activity aggregate. When
 * it is missing the row's activity is UNKNOWN — status "unknown", no
 * outreach reasons and `activity: null` — never a set of zeros that would
 * flag the patient for outreach on data we did not load. The recency
 * thresholds themselves are unchanged; they are simply measured against the
 * patient's own local day (`as_of_date`) instead of the server's UTC date.
 */
function rosterOperationalDto(
  patient: ReturnType<typeof patientDto>,
  fact: OperationalRow | undefined,
  officeAsOf: string,
  followUps: OperationalRow[] = [],
  medication: { medications: MedicationRecord[]; doseLogs: DoseLogRecord[] } | undefined,
  stallState: OperationalRow | undefined,
) {
  const activity = activityFromSummaryRow(fact, officeAsOf);
  const asOf = activity?.asOfDate ?? officeAsOf;
  const latestActivityDate = dateOrNull(fact?.latest_activity_date);
  const latestDiaryDate = dateOrNull(fact?.latest_diary_date);
  const latestWaterDate = dateOrNull(fact?.latest_water_date);
  const latestCheckInDate = dateOrNull(fact?.latest_check_in_date);
  const latestWeightDate = dateOrNull(fact?.latest_weight_date);
  const latestPhotoDate = dateOrNull(fact?.latest_photo_date);
  // Window counts straight from the aggregate: null when the aggregate row is
  // missing or reports "no data of that kind yet".
  const loggedDays7 = activity ? numericOrNull(fact?.logged_days_7) : null;
  const checkIns7 = activity ? numericOrNull(fact?.check_ins_7) : null;
  const activation = patient.activationStatus;
  const known = activity !== null;
  const attention = evaluateAttention({
    asOfDate: asOf,
    activationStatus: activation,
    pendingDeletion: patient.deletion != null,
    activityKnown: known,
    accountCreatedDate: dateOrNull(patient.createdAt),
    programStartDate: patient.program.startDate,
    latestWeightDate,
    latestDiaryDate,
    latestWaterDate,
    latestCheckInDate,
    latestActivityDate,
    activeMedicationStartDates: (medication?.medications ?? [])
      .filter((item) => item.startDate <= asOf && (item.stopDate === null || item.stopDate >= asOf))
      .map((item) => item.startDate),
    latestMedicationDoseDate: (medication?.doseLogs ?? [])
      .map((item) => item.dueDate)
      .sort()
      .pop() ?? null,
    stall: stallState?.stall && typeof stallState.stall === "object"
      ? stallState.stall as { stalled?: boolean }
      : null,
    stallCrossedOnDate: dateOrNull(stallState?.crossed_on_key),
    stallAsOfDate: dateOrNull(stallState?.as_of_date),
  });
  const mealSilent = attention.reasons.some((reason) => reason.code === "no_meals");
  const checkInOverdue = attention.reasons.some((reason) => reason.code === "check_in_overdue");
  const inactive = attention.reasons.some((reason) => reason.code === "no_activity_14d");
  // Paused and discharged patients are badged as such and never raise
  // outreach signals (every reason above already requires an activated row);
  // that badge wins even when the activity aggregate is unknown.
  const status: RosterStatus = patient.invitation?.state === "pending" ? "invited" : activation === "paused" ? "paused" : activation === "discharged" ? "discharged" : !known ? "unknown" : inactive ? "inactive" : mealSilent || checkInOverdue ? "needs_attention" : "on_track";
  return { ...patient, attention, operational: { asOfDate: asOf, latestActivityDate, latestDiaryDate, latestWaterDate, latestCheckInDate, latestWeightDate, latestPhotoDate, loggedDays7, checkIns7, activity, status, reasons: [inactive ? "no_activity_14d" : null, mealSilent ? "logging_lapsed" : null, checkInOverdue ? "check_in_overdue" : null].filter(Boolean), followUps: followUps.map((row) => ({ reason: String(row.reason), status: String(row.status), createdAt: String(row.created_at), resolvedAt: row.resolved_at ? String(row.resolved_at) : null })) } };
}

function numericOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function canonicalFirstName(row: PatientRosterRow): string {
  const stored = typeof row.first_name === "string" ? row.first_name.trim() : "";
  return stored || String(row.name ?? "").trim().split(/\s+/)[0] || "";
}

function canonicalLastName(row: PatientRosterRow): string {
  const stored = typeof row.last_name === "string" ? row.last_name.trim() : "";
  return stored || String(row.name ?? "").trim().split(/\s+/).slice(1).join(" ");
}

function canonicalName(row: PatientRosterRow): string {
  return [canonicalFirstName(row), canonicalLastName(row)].filter(Boolean).join(" ");
}

export function identityDto(row: PatientRosterRow) {
  return {
    id: String(row.id),
    name: canonicalName(row),
    firstName: canonicalFirstName(row),
    lastName: canonicalLastName(row),
    email: row.email ? String(row.email) : null,
    phone: row.phone ? String(row.phone) : null,
    phoneDisplay: normalizeUsPhone(typeof row.phone === "string" ? row.phone : ""),
    activationStatus: row.activation_status ? String(row.activation_status) : null,
    activationReason: row.activation_reason ? String(row.activation_reason) : null,
    activationUpdatedAt: row.activation_updated_at ? String(row.activation_updated_at) : null,
    verified: typeof row.auth_user_id === "string" && row.auth_user_id.length > 0,
    dateOfBirth: row.date_of_birth ? String(row.date_of_birth) : null,
    height: row.height ? String(row.height) : null,
    heightInches: numericOrNull(row.height_inches),
    profileSetupComplete: typeof row.profile_completed_at === "string",
    timezone: row.timezone ? String(row.timezone) : null,
    createdAt: row.created_at ? String(row.created_at) : null,
    claimedAt: row.claimed_at ? String(row.claimed_at) : null,
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
  };
}

export const RECORD_NOT_FOUND = "No patient record found for this office.";
export const RECORD_DELETED = "This patient deleted their account. Their record has been permanently removed.";

/**
 * Record version for optimistic concurrency: the patients row's updated_at
 * (null for legacy rows that were never touched). Clients echo it back as
 * expectedVersion; a mismatch is a 409 "reload", never a silent overwrite.
 */
export function recordVersion(row: PatientRosterRow): string | null {
  return typeof row.updated_at === "string" && row.updated_at ? row.updated_at : null;
}

export function providerNoteDto(row: PatientRosterRow) {
  return {
    id: String(row.note_id),
    body: String(row.body ?? ""),
    authorName: String(row.author_name ?? ""),
    authorKind: String(row.author_kind ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

export function staffWeightDto(row: PatientRosterRow) {
  return {
    id: String(row.weight_id),
    dateKey: String(row.date_key ?? "").slice(0, 10),
    weight: numericOrNull(row.weight),
    note: typeof row.note === "string" && row.note ? row.note : null,
    recordedByName: String(row.recorded_by_name ?? ""),
    createdAt: String(row.created_at ?? ""),
    version: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

/** One measurement visit: only the areas actually measured appear in `measurements`. */
export function bodyMeasurementDto(row: PatientRosterRow) {
  const measurements: Record<string, number> = {};
  for (const area of BODY_AREAS) {
    const value = numericOrNull(row[area.column]);
    if (value !== null) measurements[area.key] = value;
  }
  return {
    id: String(row.visit_id),
    dateKey: String(row.date_key ?? "").slice(0, 10),
    note: typeof row.note === "string" && row.note ? row.note : null,
    measurements,
    recordedByName: String(row.recorded_by_name ?? ""),
    createdAt: String(row.created_at ?? ""),
    version: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

/** Patient + staff weight series, oldest first; staff entries carry their id so the UI can correct them. */
export function mergedWeights(
  checkIns: Array<{ dateKey: string; weight: number | null }>,
  staff: Array<ReturnType<typeof staffWeightDto>>,
) {
  const patient = checkIns
    .filter((item) => item.weight !== null)
    .map((item) => ({ dateKey: item.dateKey, weight: item.weight as number, source: "patient" as const }));
  const office = staff
    .filter((item) => item.weight !== null)
    .map((item) => ({ dateKey: item.dateKey, weight: item.weight as number, source: "staff" as const, id: item.id }));
  return [...patient, ...office].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}
const STAFF_PHOTO_TTL_SEC = 15 * 60;

async function authorizedPhotoUrl(patientId: string, path: unknown): Promise<string | null> {
  if (typeof path !== "string" || !isOwnPatientMediaPath(path, patientId)) return null;
  return objectStorage.signedDownloadURL(path, STAFF_PHOTO_TTL_SEC);
}

export type OfficePatientDto = ReturnType<typeof patientDto>;

/**
 * The app links for the invitation email: HQ's App Store / Google Play links
 * first (TestFlight and Play testing links included), else the Expo Go page
 * (see resolvePatientAppLinks; the published site never uses the workspace
 * preview). No usable link means email delivery is not configured — better
 * an honest retry state than a dead button in a patient's inbox.
 */
async function patientAppLinkVariables(
  log?: { error: (obj: unknown, msg: string) => void },
): Promise<ReturnType<typeof patientInvitationLinkVariables>> {
  let storeLinks: { appStoreUrl: string | null; googlePlayUrl: string | null } | null = null;
  try {
    const policy = await loadOrgPolicy();
    storeLinks = { appStoreUrl: policy.appStoreUrl, googlePlayUrl: policy.googlePlayUrl };
  } catch (error) {
    // Settings unreadable: fall back to the Expo Go page rather than hold the
    // invitation; the next invite re-reads the store links.
    log?.error({ err: error }, "patient invitation could not read the HQ store links");
  }
  const resolved = resolvePatientAppLinks(storeLinks);
  if (resolved.ok) return patientInvitationLinkVariables(resolved);
  // No app link = the invitation email cannot be composed; surface the same
  // durable "not configured" retry state as missing email credentials.
  throw new DeliveryNotConfiguredError("email");
}

/**
 * Send the branded email for an already-committed invitation row and record
 * the durable delivery state. Never throws — the row is the source of truth
 * and the caller reports the outcome.
 */
async function deliverInvitationEmail(input: {
  patientId: string;
  firstName: string;
  email: string;
  phoneDisplay: string;
  scope: OfficeScope;
  log?: { error: (obj: unknown, msg: string) => void };
}): Promise<InvitationEmailOutcome> {
  let outcome: InvitationEmailOutcome = "sent";
  try {
    await sendPatientInvitation(input.email, {
      name: input.firstName,
      providerName: input.scope.providerName,
      officeName: input.scope.officeName,
      providerCode:
        effectiveProviderCode(input.scope.onboardingCode, input.scope.providerId) ??
        input.scope.providerId,
      phone: input.phoneDisplay,
      ...(await patientAppLinkVariables(input.log)),
    });
  } catch (error) {
    outcome = error instanceof DeliveryNotConfiguredError ? "not_configured" : "failed";
    input.log?.error({ err: error }, "patient invitation email failed");
  }
  const patched = await supabaseAdmin(
    "PATCH",
    `/rest/v1/patients?id=eq.${enc(input.patientId)}&archived_at=is.null`,
    {
      invite_email_status: outcome === "sent" ? "sent" : "failed",
      invite_email_updated_at: new Date().toISOString(),
    },
  );
  if (patched.status >= 300) {
    input.log?.error(
      { status: patched.status },
      "patient invitation email status update failed",
    );
  }
  return outcome;
}

router.get("/office/roster", async (req, res) => {
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      request: req,
      explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
      hqPermission: "provider_read",
      requireUnlocked: false,
    });
    if (resolved.kind !== "ok") {
      respondOfficeScopeDenied(req, res, resolved);
      return;
    }
    const scope = resolved.scope;
    // One request moment for the whole office. The aggregate turns it into
    // each patient's own local day; the office-level asOf stays the server's
    // UTC date for the summary counters.
    const now = new Date();
    const asOf = now.toISOString().slice(0, 10);
    const includeArchived = req.query.include === "archived";
    const patientVisibility = includeArchived
      ? "archived_into_patient_id=is.null"
      : "archived_at=is.null";
    const [rows, archivedRows, operational, followUps, outreachStates, pendingDeletions, tombstones, medicationState, subscribedPatients, spendByPatient, groupMembers, dietFacts] = await Promise.all([
      supabaseAdmin(
      "GET",
      `/rest/v1/patients?provider_id=eq.${enc(scope.providerId)}&${patientVisibility}&select=${PATIENT_SELECT}&order=created_at.desc&limit=500`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patients?provider_id=eq.${enc(scope.providerId)}&closed_at=not.is.null&select=id&limit=5000`,
      ),
      supabaseAdmin("POST", "/rest/v1/rpc/provider_patient_activity_summary", {
        p_provider_id: scope.providerId,
        p_at: now.toISOString(),
      }),
      supabaseAdmin("GET", `/rest/v1/patient_operational_follow_ups?provider_id=eq.${enc(scope.providerId)}&select=patient_id,reason,status,created_at,resolved_at&order=created_at.desc&limit=2000`),
      supabaseAdmin("POST", "/rest/v1/rpc/provider_outreach_states", { p_provider_id: scope.providerId }),
      supabaseAdmin("GET", `/rest/v1/patient_deletion_requests?provider_id=eq.${enc(scope.providerId)}&status=in.(pending,held)&select=patient_id,requested_at,purge_after&limit=500`),
      supabaseAdmin("GET", `/rest/v1/patient_tombstones?provider_id=eq.${enc(scope.providerId)}&select=id,requested_at,purged_at,was_activated,program_id,enrolled_on&order=purged_at.desc&limit=200`),
      // Medication adherence is an additional roster input (own field,
      // own null semantics); the engagement definitions above are untouched.
      loadOfficeMedicationState(scope.providerId, shiftDateKey(asOf, -(ADHERENCE_WINDOW_DAYS + 1))),
      // Shop subscriptions are a roster signal, not a roster dependency: if
      // the billing tables cannot be read the flag goes null (unknown) for
      // every row and the rest of the roster still loads.
      activeSubscriptionPatientIds(scope.providerId).catch((error: unknown) => {
        req.log?.warn({ err: error }, "roster subscription signal unavailable");
        return null;
      }),
      // Lifetime spend from the office's orders (one grouped query); null for
      // every row when the aggregate could not run, never a silent zero.
      officePatientSpend(scope.providerId).catch((error: unknown) => {
        req.log?.warn({ err: error }, "roster spend aggregate unavailable");
        return null;
      }),
      // Office-defined group memberships ride the roster row so the client
      // can render tags and filter by group without a per-row fetch.
      supabaseAdmin("GET", `/rest/v1/patient_group_members?provider_id=eq.${enc(scope.providerId)}&select=group_id,patient_id,added_at&order=added_at.asc&limit=10000`),
      // Diet, pending safety block, severe allergy and the "% fits diet"
      // sample ride the row; null on every row when the facts RPC failed
      // (unknown family), never a silent "no diet".
      loadOfficeDietFacts(scope.providerId, now).catch((error: unknown) => {
        req.log?.warn({ err: error }, "roster diet facts unavailable");
        return null;
      }),
    ]);
    if (rows.status >= 300) throw new Error(`roster load failed (${rows.status})`);
    if (groupMembers.status >= 300 || !Array.isArray(groupMembers.json)) throw new Error(`group membership roster load failed (${groupMembers.status})`);
    const groupIdsByPatient = new Map<string, string[]>();
    for (const member of groupMembers.json as OperationalRow[]) {
      const id = String(member.patient_id);
      groupIdsByPatient.set(id, [...(groupIdsByPatient.get(id) ?? []), String(member.group_id)]);
    }
    if (archivedRows.status >= 300 || !Array.isArray(archivedRows.json)) {
      throw new Error(`archived roster count failed (${archivedRows.status})`);
    }
    if (pendingDeletions.status >= 300) throw new Error(`deletion roster load failed (${pendingDeletions.status})`);
    if (tombstones.status >= 300) throw new Error(`tombstone roster load failed (${tombstones.status})`);
    const purgeAfterByPatient = new Map(
      (Array.isArray(pendingDeletions.json) ? (pendingDeletions.json as OperationalRow[]) : []).map((row) => [String(row.patient_id), row]),
    );
    if (operational.status >= 300) throw new Error(`operational roster load failed (${operational.status})`);
    if (followUps.status >= 300) throw new Error(`follow-up roster load failed (${followUps.status})`);
    if (outreachStates.status >= 300) throw new Error(`outreach roster load failed (${outreachStates.status})`);
    const outreachByPatient = new Map(
      (Array.isArray(outreachStates.json) ? (outreachStates.json as OutreachStateRpcRow[]) : []).map((row) => [String(row.patient_id), row]),
    );
    const facts = new Map((Array.isArray(operational.json) ? operational.json as OperationalRow[] : []).map((fact) => [String(fact.patient_id), fact]));
    const followUpByPatient = new Map<string, OperationalRow[]>();
    for (const item of (Array.isArray(followUps.json) ? followUps.json as OperationalRow[] : [])) {
      const id = String(item.patient_id);
      const prior = followUpByPatient.get(id) ?? [];
      // The database response is newest-first; retain just the newest
      // staff-review state for each operational reason.
      if (!prior.some((existing) => String(existing.reason) === String(item.reason))) {
        followUpByPatient.set(id, [...prior, item]);
      }
    }
    const patients = (Array.isArray(rows.json) ? (rows.json as PatientRosterRow[]) : []).map((row) => {
      const base = patientDto(row, asOf);
      const live = base.closure === null;
      const pending = purgeAfterByPatient.get(String(row.id));
      const deletion: PatientDeletionStateDto | null = base.deletion
        ? { ...base.deletion, purgeAfter: typeof pending?.purge_after === "string" ? pending.purge_after : null }
        : pending
          ? { state: "requested", requestedAt: String(pending.requested_at), purgeAfter: typeof pending.purge_after === "string" ? pending.purge_after : null }
          : null;
      const meds = live ? medicationState.get(String(row.id)) : undefined;
      return {
        ...rosterOperationalDto(
          { ...base, deletion },
          live ? facts.get(String(row.id)) : undefined,
          asOf,
          live ? followUpByPatient.get(String(row.id)) : undefined,
          meds,
          live ? outreachByPatient.get(String(row.id)) as OperationalRow | undefined : undefined,
        ),
        outreach: outreachRosterDto(live ? outreachByPatient.get(String(row.id)) : undefined),
        medicationAdherence: meds
          ? medicationAdherenceDto(meds.medications, meds.doseLogs, typeof row.timezone === "string" ? row.timezone : null, now)
          : null,
        // true/false from the billing tables; null when they could not be read.
        activeSubscription: subscribedPatients ? subscribedPatients.has(String(row.id)) : null,
        // Lifetime paid / refunded / net cents and the last paid moment at
        // this office; a patient with no paid order is a real zero.
        spend: spendByPatient ? spendByPatient.get(String(row.id)) ?? ZERO_SPEND : null,
        groupIds: groupIdsByPatient.get(String(row.id)) ?? [],
        // Diet facts: a listed row, NO_DIET_FACTS for an unlisted live
        // patient, null when the family could not be read (or the chart is sealed).
        diet: dietFacts && live ? dietFacts.get(String(row.id)) ?? NO_DIET_FACTS : null,
      };
    });
    // Purged accounts are tombstones only: listed separately, never counted
    // in the roster totals or the activity buckets below.
    const deletedAccounts = (Array.isArray(tombstones.json) ? (tombstones.json as OperationalRow[]) : []).map(deletedAccountDto);
    const livePatients = patients.filter((patient) => patient.closure === null);
    const activePatients = livePatients.filter((patient) => patient.activationStatus === "activated").length;
    const summary = {
      totalPatients: livePatients.length, activePatients,
      archived: archivedRows.json.length,
      newEnrollments30d: livePatients.filter((patient) => patient.activationStatus === "activated" && (daysOld(dateOrNull(patient.createdAt), asOf) ?? 31) <= 29).length,
      needsAttention: livePatients.filter((patient) => patient.operational.status === "needs_attention").length,
      attention: livePatients.filter((patient) => patient.attention.flagged).length,
      inactive: livePatients.filter((patient) => patient.operational.status === "inactive").length,
      invited: livePatients.filter((patient) => patient.operational.status === "invited").length,
      checkInsOverdue: livePatients.filter((patient) => patient.operational.reasons.includes("check_in_overdue")).length,
      loggingLapsed: livePatients.filter((patient) => patient.operational.reasons.includes("logging_lapsed")).length,
      deletionRequested: livePatients.filter((patient) => patient.deletion != null).length,
      deletedAccounts: deletedAccounts.length,
      // Safety blocks awaiting provider review; null when the diet facts could not be read.
      pendingDietBlocks: dietFacts ? livePatients.filter((patient) => patient.diet?.pendingBlock != null).length : null,
      asOf,
    };
    res.json({
      office: {
        providerId: scope.providerId,
        officeName: scope.officeName,
        providerCode:
          effectiveProviderCode(scope.onboardingCode, scope.providerId) ?? scope.providerId,
      },
      patients,
      deletedAccounts,
      summary,
    });
  } catch (error) {
    req.log?.error({ err: error }, "office roster failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

/**
 * Complete, read-only patient record for provider/HQ drill-in screens.
 * The patient lookup is deliberately scoped in the same query: an unknown id
 * and another office's id produce the identical answer and no history queries.
 */
router.get("/office/patients/:id", async (req, res) => {
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      request: req,
      explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
      hqPermission: "provider_read",
      requireUnlocked: false,
    });
    if (resolved.kind !== "ok") {
      respondOfficeScopeDenied(req, res, resolved);
      return;
    }
    const scope = resolved.scope;
    const patientId = String(req.params.id ?? "");
    const found = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}` +
        `&select=${PATIENT_SELECT}&limit=1`,
    );
    if (found.status >= 300) throw new Error(`patient record lookup failed (${found.status})`);
    const patient = Array.isArray(found.json)
      ? (found.json[0] as PatientRosterRow | undefined)
      : undefined;
    if (!patient) {
      // A purged account leaves only its tombstone: tell staff it was
      // deleted (and when) instead of pretending it never existed.
      if (/^[0-9a-f-]{36}$/i.test(patientId)) {
        const tombstone = await supabaseAdmin(
          "GET",
          `/rest/v1/patient_tombstones?id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}` +
            "&select=id,requested_at,purged_at,was_activated,program_id,enrolled_on&limit=1",
        );
        if (tombstone.status >= 300) throw new Error(`tombstone lookup failed (${tombstone.status})`);
        const row = Array.isArray(tombstone.json) ? (tombstone.json[0] as Record<string, unknown> | undefined) : undefined;
        if (row) {
          res.status(410).json({ error: RECORD_DELETED, deleted: deletedAccountDto(row) });
          return;
        }
      }
      res.status(404).json({ error: RECORD_NOT_FOUND });
      return;
    }

    const pid = enc(patientId);
    const [entries, water, targets, prefs, foods, recipes, photos, checkIns, flags, notes, staffWeights, measurementVisits, pendingDeletion, groupMemberships] =
      await Promise.all([
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_diary_entries?patient_id=eq.${pid}` +
            "&select=entry_id,date_key,meal,kind,ref_id,name,detail,quantity,calories,protein,carbs,fat,adjustments" +
            "&order=date_key.asc,created_at.asc,entry_id.asc&limit=5000",
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_water_days?patient_id=eq.${pid}&select=date_key,oz&order=date_key.asc&limit=2000`,
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_target_overrides?patient_id=eq.${pid}&select=calories,protein,carbs,fat,water_oz&limit=1`,
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_food_prefs?patient_id=eq.${pid}&select=favorites,recents&limit=1`,
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_custom_foods?patient_id=eq.${pid}` +
            "&select=food_id,name,brand,serving,calories,protein,carbs,fat,photo_path&order=created_at.asc,food_id.asc&limit=1000",
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_saved_recipes?patient_id=eq.${pid}` +
            "&select=recipe_id,name,meal,mode,tags,minutes,servings,calories,protein,carbs,fat,description,ingredients,steps,grocery_list,saved_at,photo_path" +
            "&order=created_at.asc,recipe_id.asc&limit=1000",
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_progress_photos?patient_id=eq.${pid}` +
            "&select=photo_id,date_key,label,angle,object_path&order=created_at.asc,photo_id.asc&limit=1000",
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_check_ins?patient_id=eq.${pid}` +
            "&select=check_in_id,date_key,weight,mood,side_effects,notes&order=date_key.asc&limit=2000",
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_flags?patient_id=eq.${pid}` +
            "&select=nudge_opt_out,nudge_engaged,nudge_last_sent_key,nudge_last_crossing_key,onboarding_complete,onboarding_answers,notification_prefs&limit=1",
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_provider_notes?patient_id=eq.${pid}&provider_id=eq.${enc(scope.providerId)}` +
            "&select=note_id,body,author_name,author_kind,created_at&order=created_at.desc&limit=500",
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_staff_weights?patient_id=eq.${pid}&provider_id=eq.${enc(scope.providerId)}` +
            "&select=weight_id,date_key,weight,note,recorded_by_name,created_at,updated_at&order=date_key.asc&limit=2000",
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_body_measurements?patient_id=eq.${pid}&provider_id=eq.${enc(scope.providerId)}` +
            `&select=visit_id,date_key,note,${MEASUREMENT_COLUMNS},recorded_by_name,created_at,updated_at&order=date_key.desc,created_at.desc&limit=1000`,
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_deletion_requests?patient_id=eq.${pid}&status=in.(pending,held)&select=patient_id,requested_at,purge_after&limit=1`,
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_group_members?patient_id=eq.${pid}&provider_id=eq.${enc(scope.providerId)}&select=group_id,added_at&order=added_at.asc&limit=500`,
        ),
      ]);
    const results = [entries, water, targets, prefs, foods, recipes, photos, checkIns, flags, notes, staffWeights, measurementVisits, pendingDeletion, groupMemberships];
    if (results.some((result) => result.status >= 300 || !Array.isArray(result.json))) {
      throw new Error("patient record history load failed");
    }
    const patientTz = typeof patient.timezone === "string" ? patient.timezone : null;
    const patientToday = dayKeyInTimeZone(patientTz);
    const [medications, doseLogs, dietFacts] = await Promise.all([
      listMedications(patientId),
      listDoseLogs(patientId, shiftDateKey(patientToday, -(ADHERENCE_WINDOW_DAYS + 1))),
      // Roster diet facts for this one patient; null = unknown (RPC failed), never "no diet".
      patient.closed_at
        ? Promise.resolve(null)
        : loadOfficeDietFacts(scope.providerId, new Date()).then((facts) => facts.get(patientId) ?? NO_DIET_FACTS).catch(() => null),
    ]);

    const entryList = (entries.json as PatientRosterRow[]).map((row) => ({
      id: String(row.entry_id),
      dateKey: String(row.date_key),
      meal: row.meal,
      kind: row.kind,
      ...(row.ref_id ? { refId: String(row.ref_id) } : {}),
      name: row.name,
      detail: typeof row.detail === "string" ? row.detail : "",
      quantity: Number(row.quantity),
      calories: Number(row.calories),
      protein: Number(row.protein),
      carbs: Number(row.carbs),
      fat: Number(row.fat),
      ...(Array.isArray(row.adjustments) && row.adjustments.length
        ? { adjustments: row.adjustments }
        : {}),
    }));
    type Nutrition = { calories: number; protein: number; carbs: number; fat: number };
    const overall: Nutrition = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    const byDate: Record<string, Nutrition> = {};
    for (const entry of entryList) {
      const day = (byDate[entry.dateKey] ??= { calories: 0, protein: 0, carbs: 0, fat: 0 });
      for (const nutrient of ["calories", "protein", "carbs", "fat"] as const) {
        day[nutrient] += entry[nutrient];
        overall[nutrient] += entry[nutrient];
      }
    }

    const waterDays = (water.json as PatientRosterRow[]).map((row) => ({
      dateKey: String(row.date_key),
      oz: Number(row.oz),
    }));
    const checkInList = (checkIns.json as PatientRosterRow[]).map((row) => ({
      id: String(row.check_in_id),
      dateKey: String(row.date_key),
      weight: numericOrNull(row.weight),
      mood: numericOrNull(row.mood),
      sideEffects: Array.isArray(row.side_effects) ? row.side_effects : [],
      notes: typeof row.notes === "string" ? row.notes : null,
    }));
    const target = (targets.json as PatientRosterRow[])[0];
    const pref = (prefs.json as PatientRosterRow[])[0];
    const flag = (flags.json as PatientRosterRow[])[0];
    const providerNotes = (notes.json as PatientRosterRow[]).map(providerNoteDto);
    const staffWeightList = (staffWeights.json as PatientRosterRow[]).map(staffWeightDto);
    const bodyMeasurements = (measurementVisits.json as PatientRosterRow[]).map(bodyMeasurementDto);

    // Record access: opening the chart is one event; the signed photo grid
    // that ships with it is a second, so "who saw the photos" stays askable
    // on its own. Both collapse per actor for 15 minutes.
    const access = { actorUserId: scope.actorUserId, actorKind: scope.actorKind, providerId: scope.providerId, targetKind: "patient" as const, targetId: patientId };
    auditRecordAccess(req, { ...access, action: "patient_record_viewed" });
    if ((photos.json as PatientRosterRow[]).length > 0) {
      auditRecordAccess(req, { ...access, action: "patient_photos_viewed", metadata: { photos: (photos.json as PatientRosterRow[]).length } });
    }

    const photoList = await Promise.all(
      (photos.json as PatientRosterRow[]).map(async (row) => ({
        id: String(row.photo_id),
        dateKey: String(row.date_key),
        label: row.label ? String(row.label) : "",
        angle: row.angle ? String(row.angle) : null,
        url: await authorizedPhotoUrl(patientId, row.object_path),
      })),
    );
    const customFoods = await Promise.all(
      (foods.json as PatientRosterRow[]).map(async (row) => ({
        id: String(row.food_id),
        name: String(row.name ?? ""),
        brand: row.brand ? String(row.brand) : null,
        serving: String(row.serving ?? ""),
        calories: Number(row.calories),
        protein: Number(row.protein),
        carbs: Number(row.carbs),
        fat: Number(row.fat),
        photoUrl: await authorizedPhotoUrl(patientId, row.photo_path),
      })),
    );
    const savedRecipes = await Promise.all(
      (recipes.json as PatientRosterRow[]).map(async (row) => ({
        id: String(row.recipe_id),
        name: String(row.name ?? ""),
        meal: row.meal,
        mode: row.mode,
        tags: Array.isArray(row.tags) ? row.tags : [],
        minutes: Number(row.minutes),
        servings: Number(row.servings),
        calories: Number(row.calories),
        protein: Number(row.protein),
        carbs: Number(row.carbs),
        fat: Number(row.fat),
        description: typeof row.description === "string" ? row.description : "",
        ingredients: Array.isArray(row.ingredients) ? row.ingredients : [],
        steps: Array.isArray(row.steps) ? row.steps : [],
        groceryList: Array.isArray(row.grocery_list) ? row.grocery_list : [],
        savedAt: row.saved_at ? String(row.saved_at) : null,
        photoUrl: await authorizedPhotoUrl(patientId, row.photo_path),
      })),
    );
    const customFoodById = new Map(customFoods.map((food) => [food.id, food]));
    const diaryFoodById = new Map<string, { id: string; name: string; detail: string }>();
    for (const entry of entryList) {
      if (!entry.refId || diaryFoodById.has(entry.refId)) continue;
      diaryFoodById.set(entry.refId, {
        id: entry.refId,
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name : "Saved food",
        detail: entry.detail,
      });
    }
    const preferenceFoods = (value: unknown) =>
      (Array.isArray(value) ? value : [])
        .filter((id): id is string => typeof id === "string")
        .map((id) => customFoodById.get(id) ?? diaryFoodById.get(id) ?? {
          id,
          name: "Food details unavailable",
        });

    res.json({
      office: {
        providerId: scope.providerId,
        officeName: scope.officeName,
        providerCode:
          effectiveProviderCode(scope.onboardingCode, scope.providerId) ?? scope.providerId,
      },
      patient: {
        identity: identityDto(patient),
        program: patientDto(patient).program,
        closure: patientDto(patient).closure,
        version: recordVersion(patient),
        deletion: recordDeletionDto(patient, (pendingDeletion.json as OperationalRow[])[0]),
        groupIds: (groupMemberships.json as OperationalRow[]).map((row) => String(row.group_id)),
        diet: dietFacts,
      },
      providerNotes,
      staffWeights: staffWeightList,
      bodyMeasurements,
      diary: {
        entries: entryList,
        nutritionTotals: {
          overall,
          byDate: Object.entries(byDate).map(([dateKey, totals]) => ({ dateKey, ...totals })),
        },
      },
      water: waterDays,
      checkIns: checkInList,
      // Same definitions as the roster aggregate, computed over the rows
      // above for the patient's own local day (see lib/patient-activity).
      engagement: computePatientActivity(
        { diary: entryList, water: waterDays, checkIns: checkInList },
        patientToday,
      ),
      // Additional adherence input, separate from the engagement signals:
      // null until a dose has come due in the trailing 30 days.
      medicationAdherence: medicationAdherenceDto(medications, doseLogs, patientTz, new Date()),
      medications,
      weights: mergedWeights(checkInList, staffWeightList),
      progressPhotos: photoList,
      account: {
        targets: {
          calories: numericOrNull(target?.calories),
          protein: numericOrNull(target?.protein),
          carbs: numericOrNull(target?.carbs),
          fat: numericOrNull(target?.fat),
          waterOz: numericOrNull(target?.water_oz),
        },
        favorites: preferenceFoods(pref?.favorites),
        recents: preferenceFoods(pref?.recents),
        customFoods,
        savedRecipes,
        flags: {
          nudgeOptOut: flag?.nudge_opt_out === true,
          nudgeEngaged: flag?.nudge_engaged === true,
          nudgeLastSentKey: flag?.nudge_last_sent_key
            ? String(flag.nudge_last_sent_key)
            : null,
          nudgeLastCrossingKey: flag?.nudge_last_crossing_key
            ? String(flag.nudge_last_crossing_key)
            : null,
          onboardingComplete: flag?.onboarding_complete === true,
          onboardingAnswers:
            flag?.onboarding_answers && typeof flag.onboarding_answers === "object"
              ? flag.onboarding_answers
              : null,
          notificationPrefs:
            flag?.notification_prefs && typeof flag.notification_prefs === "object"
              ? flag.notification_prefs
              : null,
        },
      },
    });
  } catch (error) {
    req.log?.error({ err: error }, "office patient record failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

const InviteInput = z.object({
  firstName: z.string().trim().min(1, "First name is required.").max(80, "First name is too long."),
  lastName: z.string().trim().min(1, "Last name is required.").max(80, "Last name is too long."),
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .max(320, "Email is too long.")
    .email("Enter a valid email address."),
  phone: z.string().trim().min(1, "Phone number is required.").max(40, "Enter a valid 10-digit US mobile number."),
  office: z.string().trim().max(120).optional(),
});

/** Most progress photos one staff page-signing call covers. */
export const OFFICE_PHOTO_PAGE_MAX = 100;

/**
 * POST /office/patients/:id/photos/urls  { ids: string[], variant?: size }
 *
 * One call signs a page of a patient's progress photos at the asked size —
 * thumbnails for the grid, medium for the viewer. Same scope as the record
 * read (office membership or HQ provider_read with ?office=); only photos
 * on THIS patient's grid within THIS office are signed, and each entry says
 * which size was actually signed (original until the variant is backfilled).
 * The record DTO's own `url` stays the original for downloads.
 */
router.post("/office/patients/:id/photos/urls", async (req, res) => {
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      request: req,
      explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
      hqPermission: "provider_read",
      requireUnlocked: false,
    });
    if (resolved.kind !== "ok") {
      respondOfficeScopeDenied(req, res, resolved);
      return;
    }
    const scope = resolved.scope;
    const patientId = String(req.params.id ?? "");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 80) : [];
    if (ids.length === 0 || ids.length > OFFICE_PHOTO_PAGE_MAX || ids.length !== (body.ids as unknown[]).length) {
      res.status(400).json({ error: `Send between 1 and ${OFFICE_PHOTO_PAGE_MAX} photo ids.` });
      return;
    }
    const size: PhotoSize | null = body.variant === undefined || body.variant === "" ? "original" : isPhotoSize(body.variant) ? body.variant : null;
    if (size === null) {
      res.status(400).json({ error: "Unknown photo size." });
      return;
    }
    const found = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}&select=id&limit=1`,
    );
    if (found.status >= 300) throw new Error(`patient record lookup failed (${found.status})`);
    if (!Array.isArray(found.json) || found.json.length === 0) {
      res.status(404).json({ error: RECORD_NOT_FOUND });
      return;
    }
    const wanted = new Set(ids);
    const idList = [...wanted].map((id) => `"${id.replace(/"/g, '\\"')}"`).join(",");
    const photos = await supabaseAdmin(
      "GET",
      `/rest/v1/patient_progress_photos?patient_id=eq.${enc(patientId)}&photo_id=in.(${enc(idList)})` +
        `&select=photo_id,object_path&limit=${OFFICE_PHOTO_PAGE_MAX}`,
    );
    if (photos.status >= 300 || !Array.isArray(photos.json)) throw new Error(`progress photo lookup failed (${photos.status})`);
    const rows = (photos.json as Array<{ photo_id: string; object_path: unknown }>)
      .filter((row) => wanted.has(row.photo_id) && typeof row.object_path === "string" && isOwnPatientMediaPath(row.object_path, patientId)) as Array<{ photo_id: string; object_path: string }>;
    const variantsByPath = new Map<string, unknown>();
    if (rows.length > 0 && size !== "original") {
      const pathList = rows.map((row) => `"${row.object_path.replace(/"/g, '\\"')}"`).join(",");
      const ledger = await supabaseAdmin(
        "GET",
        `/rest/v1/patient_media?patient_id=eq.${enc(patientId)}&object_path=in.(${enc(pathList)})` +
          `&select=object_path,variants&limit=${OFFICE_PHOTO_PAGE_MAX}`,
      );
      if (ledger.status >= 300 || !Array.isArray(ledger.json)) throw new Error(`patient media lookup failed (${ledger.status})`);
      for (const row of ledger.json as Array<{ object_path: string; variants: unknown }>) variantsByPath.set(row.object_path, row.variants);
    }
    if (rows.length > 0) {
      auditRecordAccess(req, {
        action: "patient_photos_viewed", actorUserId: scope.actorUserId, actorKind: scope.actorKind, providerId: scope.providerId,
        targetKind: "patient", targetId: patientId, metadata: { photos: rows.length },
      });
    }
    const expiresAt = new Date(Date.now() + STAFF_PHOTO_TTL_SEC * 1000).toISOString();
    const urls: Array<{ id: string; url: string; size: PhotoSize }> = [];
    for (const row of rows) {
      const target = resolvePhotoObjectPath(row.object_path, size, variantsByPath.get(row.object_path));
      urls.push({ id: row.photo_id, url: await objectStorage.signedDownloadURL(target.objectPath, STAFF_PHOTO_TTL_SEC), size: target.size });
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ urls, expiresAt });
  } catch (error) {
    req.log?.error({ err: error }, "office photo page signing failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.post("/office/invitations", async (req, res) => {
  const slot = acquireInviteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const parsed = InviteInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({
        error: issue?.message ?? "Check the invitation form and try again.",
        field: typeof issue?.path?.[0] === "string" ? issue.path[0] : undefined,
      });
      return;
    }
    const phoneDisplay = normalizeUsPhone(parsed.data.phone);
    if (!phoneDisplay) {
      res.status(400).json({
        error: "Enter a valid 10-digit US mobile number.",
        field: "phone",
      });
      return;
    }
    const phoneDigits = phoneDisplay.replace(/\D/g, "");
    const phoneE164 = `+1${phoneDigits}`;
    const email = parsed.data.email.toLowerCase();

    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      request: req,
      explicitOfficeId: parsed.data.office ?? null,
      hqPermission: "provider_manage",
      requireUnlocked: true,
    });
    if (resolved.kind !== "ok") {
      respondOfficeScopeDenied(req, res, resolved);
      return;
    }
    const scope = resolved.scope;

    // Pre-checks give clear field-level errors; the partial unique indexes
    // on the insert below are the airtight backstop. Both answers stay
    // neutral about who owns the existing row.
    const emailTaken = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?email=ilike.${enc(email)}&archived_at=is.null&select=id&limit=1`,
    );
    if (emailTaken.status >= 300) throw new Error(`email check failed (${emailTaken.status})`);
    if (Array.isArray(emailTaken.json) && emailTaken.json.length > 0) {
      res.status(409).json({ error: EMAIL_TAKEN, field: "email" });
      return;
    }
    const phoneMatches = await lookupPatients({
      kind: "phone",
      e164: phoneE164,
      last10: phoneDigits,
    });
    if (phoneMatches.length > 0) {
      res.status(409).json({ error: PHONE_TAKEN, field: "phone" });
      return;
    }

    const now = new Date().toISOString();
    const patientId = crypto.randomUUID();
    const firstName = parsed.data.firstName.replace(/\s+/g, " ");
    const lastName = parsed.data.lastName.replace(/\s+/g, " ");
    const inserted = await supabaseAdmin(
      "POST",
      "/rest/v1/patients",
      {
        id: patientId,
        provider_id: scope.providerId,
        name: `${firstName} ${lastName}`,
        email,
        phone: phoneE164,
        activation_status: "invited",
        created_at: now,
        invited_at: now,
        invited_by: scope.actorUserId,
        invite_email_status: "pending",
        invite_email_updated_at: now,
      },
      "return=representation",
    );
    if (inserted.status >= 300) {
      const message = String((inserted.json as { message?: unknown })?.message ?? "");
      const conflict = patientUniqueConflict(message);
      if (conflict === "email") {
        res.status(409).json({ error: EMAIL_TAKEN, field: "email" });
        return;
      }
      if (conflict === "phone") {
        res.status(409).json({ error: PHONE_TAKEN, field: "phone" });
        return;
      }
      throw new Error(`patient invite insert failed (${inserted.status})`);
    }
    const row = (Array.isArray(inserted.json) ? inserted.json[0] : inserted.json) as
      | PatientRosterRow
      | undefined;
    if (!row) throw new Error("patient invite insert returned no row");

    // Email only after the row has landed — its outcome is durable state.
    const invitation = await deliverInvitationEmail({
      patientId,
      firstName,
      email,
      phoneDisplay,
      scope,
      log: req.log,
    });
    await recordAdminAuditEvent({ action: "patient_invitation_created", actorUserId: scope.actorUserId, actorKind: scope.actorKind, providerId: scope.providerId, targetKind: "patient", targetId: patientId, requestId: req.headers["x-request-id"]?.toString() ?? null }).catch((error) => req.log?.error({ err: error }, "patient invitation audit failed"));
    res.status(201).json({
      patient: patientDto({
        ...row,
        invite_email_status: invitation === "sent" ? "sent" : "failed",
      }),
      invitation,
    });
  } catch (error) {
    req.log?.error({ err: error }, "patient invitation failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

router.post("/office/invitations/:id/resend", async (req, res) => {
  const slot = acquireInviteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      request: req,
      explicitOfficeId:
        typeof (req.body ?? {}).office === "string"
          ? String((req.body as { office?: string }).office)
          : typeof req.query.office === "string"
            ? req.query.office
            : null,
      hqPermission: "provider_manage",
      requireUnlocked: true,
    });
    if (resolved.kind !== "ok") {
      respondOfficeScopeDenied(req, res, resolved);
      return;
    }
    const scope = resolved.scope;
    const id = String(req.params.id ?? "");

    const found = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?id=eq.${enc(id)}&select=${PATIENT_SELECT}&limit=1`,
    );
    if (found.status >= 300) throw new Error(`invitation lookup failed (${found.status})`);
    const row = Array.isArray(found.json) ? (found.json[0] as PatientRosterRow | undefined) : undefined;
    // One neutral answer for "doesn't exist", "not this office's patient",
    // and "not an invited row" — cross-office probing learns nothing.
    if (!row || String(row.provider_id ?? "") !== scope.providerId || !row.invited_at) {
      res.status(404).json({ error: "No invitation found for this office." });
      return;
    }
    if (row.closed_at) {
      res.status(409).json({ error: RECORD_SEALED });
      return;
    }
    if (row.auth_user_id) {
      res.status(409).json({
        error: "This patient has already verified their account — no invitation needed.",
      });
      return;
    }

    // Atomic rate limit + double-send guard: the conditional UPDATE only
    // lands while the row is unclaimed and outside the cooldown window.
    const cooldown = resendCooldownSeconds();
    const cutoff = new Date(Date.now() - cooldown * 1000).toISOString();
    const guarded = await supabaseAdmin(
      "PATCH",
      `/rest/v1/patients?id=eq.${enc(id)}&provider_id=eq.${enc(scope.providerId)}&archived_at=is.null&auth_user_id=is.null&or=(invite_email_updated_at.is.null,invite_email_updated_at.lt.${enc(cutoff)})`,
      { invite_email_status: "pending", invite_email_updated_at: new Date().toISOString() },
      "return=representation",
    );
    if (guarded.status >= 300) throw new Error(`invitation resend guard failed (${guarded.status})`);
    if (!Array.isArray(guarded.json) || guarded.json.length !== 1) {
      res.status(429).json({
        error: "This invitation was just sent. Please wait a minute before resending.",
        retryable: true,
      });
      return;
    }

    const name = String(row.name ?? "");
    const firstName = name.split(/\s+/)[0] || name || "there";
    const email = String(row.email ?? "");
    const phoneDisplay =
      normalizeUsPhone(typeof row.phone === "string" ? row.phone : "") ??
      String(row.phone ?? "");
    const invitation = await deliverInvitationEmail({
      patientId: id,
      firstName,
      email,
      phoneDisplay,
      scope,
      log: req.log,
    });
    await recordAdminAuditEvent({ action: "patient_invitation_resent", actorUserId: scope.actorUserId, actorKind: scope.actorKind, providerId: scope.providerId, targetKind: "patient", targetId: id, requestId: req.headers["x-request-id"]?.toString() ?? null }).catch((error) => req.log?.error({ err: error }, "patient invitation resend audit failed"));
    res.json({
      ok: true,
      invitation,
      patient: patientDto({
        ...row,
        invite_email_status: invitation === "sent" ? "sent" : "failed",
        invite_email_updated_at: new Date().toISOString(),
      }),
    });
  } catch (error) {
    req.log?.error({ err: error }, "patient invitation resend failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

export default router;
