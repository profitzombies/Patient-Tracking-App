/**
 * Medication records on the live data rail: row ↔ DTO mapping and the
 * Supabase reads/writes shared by the patient routes, the office routes,
 * the state hydration, exports, and the missed-dose evaluation.
 *
 * Every function takes the patient id explicitly and scopes the query to
 * it; callers have already resolved the patient (bearer session or office
 * scope). The tables are service-role only, so nothing here is reachable
 * from a client without one of those routes in front of it.
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import {
  adherenceSummary,
  localDateKey,
  shiftDateKey,
  type AdherenceSummary,
  type DoseLogRecord,
  type DoseLogSource,
  type DoseLogStatus,
  type MedicationForm,
  type MedicationInput,
  type MedicationRecord,
  type MedicationScheduleKind,
  type MedicationSource,
} from "./schedule";

const enc = encodeURIComponent;
type Row = Record<string, unknown>;

export const MEDICATION_SELECT =
  "id,patient_id,name,form,dose,schedule_kind,times,weekday,notes,start_date,stop_date,source,created_by_name,created_at,updated_at";
export const DOSE_LOG_SELECT = "id,patient_id,medication_id,due_date,due_time,status,source,logged_at,updated_at";

/** Dose logs older than this never ride hydration or adherence reads. */
export const DOSE_LOG_LOOKBACK_DAYS = 45;
export const ADHERENCE_WINDOW_DAYS = 30;

export function medicationFromRow(row: Row): MedicationRecord {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    form: String(row.form ?? "other") as MedicationForm,
    dose: typeof row.dose === "string" && row.dose ? row.dose : null,
    scheduleKind: (row.schedule_kind === "weekly" ? "weekly" : "daily") as MedicationScheduleKind,
    times: Array.isArray(row.times) ? row.times.map(String) : [],
    weekday: typeof row.weekday === "number" ? row.weekday : row.weekday === null || row.weekday === undefined ? null : Number(row.weekday),
    notes: typeof row.notes === "string" && row.notes ? row.notes : null,
    startDate: String(row.start_date ?? "").slice(0, 10),
    stopDate: row.stop_date ? String(row.stop_date).slice(0, 10) : null,
    source: (row.source === "office" || row.source === "onboarding" ? row.source : "patient") as MedicationSource,
    version: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

export function doseLogFromRow(row: Row): DoseLogRecord {
  return {
    id: String(row.id),
    medicationId: String(row.medication_id),
    dueDate: String(row.due_date ?? "").slice(0, 10),
    dueTime: String(row.due_time ?? ""),
    status: (row.status === "skipped" ? "skipped" : "taken") as DoseLogStatus,
    source: (["reminder", "check_in", "account", "office"].includes(String(row.source)) ? row.source : "account") as DoseLogSource,
    loggedAt: String(row.logged_at ?? ""),
  };
}

function rows(res: { status: number; json: unknown }, what: string): Row[] {
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`${what} failed (${res.status})`);
  return res.json as Row[];
}

export async function listMedications(patientId: string): Promise<MedicationRecord[]> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/patient_medications?patient_id=eq.${enc(patientId)}&select=${MEDICATION_SELECT}&order=created_at.asc,id.asc&limit=200`,
  );
  return rows(res, "medication list").map(medicationFromRow);
}

export async function listDoseLogs(patientId: string, fromDate: string): Promise<DoseLogRecord[]> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/patient_medication_dose_logs?patient_id=eq.${enc(patientId)}&due_date=gte.${enc(fromDate)}&select=${DOSE_LOG_SELECT}&order=due_date.asc,due_time.asc&limit=2000`,
  );
  return rows(res, "dose log list").map(doseLogFromRow);
}

/** Both slices for one patient, sized for hydration (45-day log window). */
export async function loadMedicationState(patientId: string, today: string): Promise<{ medications: MedicationRecord[]; doseLogs: DoseLogRecord[] }> {
  const [medications, doseLogs] = await Promise.all([listMedications(patientId), listDoseLogs(patientId, shiftDateKey(today, -DOSE_LOG_LOOKBACK_DAYS))]);
  return { medications, doseLogs };
}

export interface MedicationWriteMeta {
  source: MedicationSource;
  createdBy?: string | null;
  createdByName?: string | null;
}

function medicationRow(patientId: string, input: MedicationInput, meta: MedicationWriteMeta, now: string): Row {
  return {
    id: input.id,
    patient_id: patientId,
    name: input.name,
    form: input.form,
    dose: input.dose,
    schedule_kind: input.scheduleKind,
    times: input.times,
    weekday: input.scheduleKind === "weekly" ? input.weekday : null,
    notes: input.notes,
    start_date: input.startDate,
    stop_date: input.stopDate,
    source: meta.source,
    created_by: meta.createdBy ?? null,
    created_by_name: meta.createdByName ?? null,
    updated_at: now,
  };
}

/**
 * Inserts or replaces one medication (keyed by the client id). The insert
 * keeps `created_at`/`source`/`created_by*` from the first write; on
 * conflict only the editable columns and updated_at move.
 */
export async function upsertMedication(patientId: string, input: MedicationInput, meta: MedicationWriteMeta): Promise<MedicationRecord> {
  const now = new Date().toISOString();
  const existing = await supabaseAdmin(
    "GET",
    `/rest/v1/patient_medications?id=eq.${enc(input.id)}&select=id,patient_id&limit=1`,
  );
  const found = rows(existing, "medication lookup")[0];
  if (found && String(found.patient_id) !== patientId) throw new MedicationIdConflict();
  if (found) {
    const updated = await supabaseAdmin(
      "PATCH",
      `/rest/v1/patient_medications?id=eq.${enc(input.id)}&patient_id=eq.${enc(patientId)}&select=${MEDICATION_SELECT}`,
      {
        name: input.name,
        form: input.form,
        dose: input.dose,
        schedule_kind: input.scheduleKind,
        times: input.times,
        weekday: input.scheduleKind === "weekly" ? input.weekday : null,
        notes: input.notes,
        start_date: input.startDate,
        stop_date: input.stopDate,
        updated_at: now,
      },
      "return=representation",
    );
    const row = rows(updated, "medication update")[0];
    if (!row) throw new Error("medication update returned no row");
    return medicationFromRow(row);
  }
  const inserted = await supabaseAdmin(
    "POST",
    `/rest/v1/patient_medications?select=${MEDICATION_SELECT}`,
    { ...medicationRow(patientId, input, meta, now), created_at: now },
    "return=representation",
  );
  const row = rows(inserted, "medication insert")[0];
  if (!row) throw new Error("medication insert returned no row");
  return medicationFromRow(row);
}

/** A client id that already belongs to another patient (never legitimately). */
export class MedicationIdConflict extends Error {
  constructor() {
    super("medication id belongs to another record");
    this.name = "MedicationIdConflict";
  }
}

/**
 * Optimistic office edit: the PATCH is filtered on the version the client
 * rendered. Returns null when nothing matched (stale version or unknown id).
 */
export async function updateMedicationVersioned(
  patientId: string,
  medicationId: string,
  expectedVersion: string | null,
  patch: Partial<Pick<MedicationInput, "name" | "form" | "dose" | "scheduleKind" | "times" | "weekday" | "notes" | "startDate" | "stopDate">>,
): Promise<MedicationRecord | null> {
  const now = new Date().toISOString();
  const versionFilter = expectedVersion === null ? "updated_at=is.null" : `updated_at=eq.${enc(expectedVersion)}`;
  const body: Row = { updated_at: now };
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.form !== undefined) body.form = patch.form;
  if (patch.dose !== undefined) body.dose = patch.dose;
  if (patch.scheduleKind !== undefined) body.schedule_kind = patch.scheduleKind;
  if (patch.times !== undefined) body.times = patch.times;
  if (patch.weekday !== undefined || patch.scheduleKind !== undefined) {
    body.weekday = patch.scheduleKind === "daily" ? null : patch.weekday ?? null;
  }
  if (patch.notes !== undefined) body.notes = patch.notes;
  if (patch.startDate !== undefined) body.start_date = patch.startDate;
  if (patch.stopDate !== undefined) body.stop_date = patch.stopDate;
  const updated = await supabaseAdmin(
    "PATCH",
    `/rest/v1/patient_medications?id=eq.${enc(medicationId)}&patient_id=eq.${enc(patientId)}&${versionFilter}&select=${MEDICATION_SELECT}`,
    body,
    "return=representation",
  );
  const row = rows(updated, "medication versioned update")[0];
  return row ? medicationFromRow(row) : null;
}

export async function getMedication(patientId: string, medicationId: string): Promise<MedicationRecord | null> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/patient_medications?id=eq.${enc(medicationId)}&patient_id=eq.${enc(patientId)}&select=${MEDICATION_SELECT}&limit=1`,
  );
  const row = rows(res, "medication lookup")[0];
  return row ? medicationFromRow(row) : null;
}

export interface DoseLogWrite {
  id: string;
  medicationId: string;
  dueDate: string;
  dueTime: string;
  status: DoseLogStatus;
  source: DoseLogSource;
  loggedAt?: string;
}

/** One decision per occurrence: a repeat lands as a correction (merge). */
export async function upsertDoseLog(patientId: string, write: DoseLogWrite): Promise<DoseLogRecord> {
  const now = new Date().toISOString();
  const res = await supabaseAdmin(
    "POST",
    `/rest/v1/patient_medication_dose_logs?on_conflict=medication_id,due_date,due_time&select=${DOSE_LOG_SELECT}`,
    [{
      id: write.id,
      patient_id: patientId,
      medication_id: write.medicationId,
      due_date: write.dueDate,
      due_time: write.dueTime,
      status: write.status,
      source: write.source,
      logged_at: write.loggedAt ?? now,
      updated_at: now,
    }],
    "resolution=merge-duplicates,return=representation",
  );
  const row = rows(res, "dose log upsert")[0];
  if (!row) throw new Error("dose log upsert returned no row");
  return doseLogFromRow(row);
}

/** Removes a decision so the occurrence reads unlogged again. */
export async function deleteDoseLog(patientId: string, medicationId: string, dueDate: string, dueTime: string): Promise<void> {
  const res = await supabaseAdmin(
    "DELETE",
    `/rest/v1/patient_medication_dose_logs?patient_id=eq.${enc(patientId)}&medication_id=eq.${enc(medicationId)}&due_date=eq.${enc(dueDate)}&due_time=eq.${enc(dueTime)}`,
    undefined,
    "return=minimal",
  );
  if (res.status >= 300) throw new Error(`dose log delete failed (${res.status})`);
}

/** The 30-day adherence view the office and roster read (ending today, patient-local). */
export function adherenceLast30(
  medications: readonly MedicationRecord[],
  doseLogs: readonly DoseLogRecord[],
  timeZone: string | null,
  now: Date = new Date(),
): AdherenceSummary {
  const today = localDateKey(now, timeZone);
  return adherenceSummary(medications, doseLogs, shiftDateKey(today, -(ADHERENCE_WINDOW_DAYS - 1)), today, timeZone, now);
}

/**
 * Roster/detail adherence input: the 30-day headline only, null when the
 * patient has no medication with a dose that has come due in the window.
 * Separate from the engagement signals (which keep their own definitions).
 */
export interface MedicationAdherenceDto {
  fromDate: string;
  toDate: string;
  due: number;
  taken: number;
  skipped: number;
  missed: number;
  rate: number | null;
}

export function medicationAdherenceDto(
  medications: readonly MedicationRecord[],
  doseLogs: readonly DoseLogRecord[],
  timeZone: string | null,
  now: Date = new Date(),
): MedicationAdherenceDto | null {
  if (medications.length === 0) return null;
  const summary = adherenceLast30(medications, doseLogs, timeZone, now);
  if (summary.due === 0) return null;
  const { fromDate, toDate, due, taken, skipped, missed, rate } = summary;
  return { fromDate, toDate, due, taken, skipped, missed, rate };
}

/**
 * Every medication and recent dose log across one office, grouped by
 * patient, for the roster's adherence column. One embedded-filter read per
 * table instead of a per-patient fan-out.
 */
export async function loadOfficeMedicationState(
  providerId: string,
  fromDate: string,
): Promise<Map<string, { medications: MedicationRecord[]; doseLogs: DoseLogRecord[] }>> {
  const [meds, logs] = await Promise.all([
    supabaseAdmin(
      "GET",
      `/rest/v1/patient_medications?select=${MEDICATION_SELECT},patients!inner(provider_id)&patients.provider_id=eq.${enc(providerId)}` +
        "&order=created_at.asc&limit=5000",
    ),
    supabaseAdmin(
      "GET",
      `/rest/v1/patient_medication_dose_logs?select=${DOSE_LOG_SELECT},patients!inner(provider_id)&patients.provider_id=eq.${enc(providerId)}` +
        `&due_date=gte.${enc(fromDate)}&limit=20000`,
    ),
  ]);
  const out = new Map<string, { medications: MedicationRecord[]; doseLogs: DoseLogRecord[] }>();
  const bucket = (patientId: string) => {
    let entry = out.get(patientId);
    if (!entry) {
      entry = { medications: [], doseLogs: [] };
      out.set(patientId, entry);
    }
    return entry;
  };
  for (const row of rows(meds, "office medications")) bucket(String(row.patient_id)).medications.push(medicationFromRow(row));
  for (const row of rows(logs, "office dose logs")) bucket(String(row.patient_id)).doseLogs.push(doseLogFromRow(row));
  return out;
}
