/**
 * "Who viewed my record" — the record-access audit events for one patient,
 * shaped for two readers:
 *
 *  - the patient's own data export: when, which office, and the viewer's
 *    role. No staff names or user ids; a patient copy is not a staff roster.
 *  - HQ (account deletions detail): the same rows with the viewer's name,
 *    since HQ already sees actors on the audit log.
 *
 * Every record-access event targets the patient id directly (transcript
 * opens carry their conversation id in metadata), so one query answers both.
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import { RECORD_ACCESS_ACTIONS, type RecordAccessAction } from "../lib/record-access-audit";
import { actorLabel, resolveAuditNames, type AuditRow } from "../lib/audit-events";

const enc = encodeURIComponent;
const PAGE = 1000;
/** Ceiling per patient — seven years of deduped reads sits far below this. */
export const MAX_RECORD_ACCESS_ROWS = 20_000;

export const RECORD_ACCESS_LABELS: Record<RecordAccessAction, string> = {
  patient_record_viewed: "Viewed patient record",
  patient_photos_viewed: "Viewed progress photos",
  patient_bloodwork_viewed: "Viewed bloodwork list",
  bloodwork_report_opened: "Opened lab report",
  patient_medications_viewed: "Viewed medication list",
  patient_diet_viewed: "Viewed diet and food preferences",
  conversation_transcript_opened: "Opened conversation transcript",
};

const ROLE_LABELS: Record<string, string> = {
  provider: "Office account holder",
  team_member: "Office teammate",
  hq: "HQ staff",
};

export interface PatientRecordAccessEntry {
  occurredAt: string;
  action: RecordAccessAction;
  label: string;
  /** Office name when it resolved, else null (never the raw provider id in the patient copy). */
  office: string | null;
  /** Viewer's role, never their name. */
  role: string;
  /** Which thread a transcript open concerned, when applicable. */
  thread: string | null;
}

export interface HqRecordAccessEntry extends PatientRecordAccessEntry {
  providerId: string | null;
  actorUserId: string | null;
  actorName: string;
  reportId: string | null;
  conversationId: string | null;
}

function isRecordAccessAction(value: unknown): value is RecordAccessAction {
  return typeof value === "string" && (RECORD_ACCESS_ACTIONS as readonly string[]).includes(value);
}

function meta(row: AuditRow): Record<string, unknown> {
  return row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Every record-access audit row for one patient, oldest first. */
export async function loadRecordAccessRows(patientId: string): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  const base =
    `/rest/v1/admin_audit_events?target_kind=eq.patient&target_id=eq.${enc(patientId)}` +
    `&action=in.(${RECORD_ACCESS_ACTIONS.join(",")})` +
    "&select=id,occurred_at,action,actor_user_id,actor_kind,provider_id,target_kind,target_id,request_id,metadata&order=occurred_at.asc,id.asc";
  for (let offset = 0; rows.length < MAX_RECORD_ACCESS_ROWS; offset += PAGE) {
    const result = await supabaseAdmin("GET", `${base}&limit=${PAGE}&offset=${offset}`);
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`record access query failed (${result.status})`);
    rows.push(...(result.json as AuditRow[]));
    if (result.json.length < PAGE) break;
  }
  return rows.slice(0, MAX_RECORD_ACCESS_ROWS);
}

/** HQ shape: names included. */
export async function loadHqRecordAccess(patientId: string): Promise<HqRecordAccessEntry[]> {
  const rows = await loadRecordAccessRows(patientId);
  const names = await resolveAuditNames(rows);
  return rows.filter((row) => isRecordAccessAction(row.action)).map((row) => {
    const action = row.action as RecordAccessAction;
    const m = meta(row);
    return {
      occurredAt: row.occurred_at,
      action,
      label: RECORD_ACCESS_LABELS[action],
      office: (row.provider_id && names.offices.get(row.provider_id)) || null,
      providerId: row.provider_id,
      role: ROLE_LABELS[row.actor_kind] ?? row.actor_kind,
      actorUserId: row.actor_user_id,
      actorName: actorLabel(row, names),
      thread: stringOrNull(m.thread),
      reportId: stringOrNull(m.reportId),
      conversationId: stringOrNull(m.conversationId),
    };
  });
}

/** Patient-copy shape: dates, office, role — no staff identity. */
export function patientRecordAccessEntries(entries: HqRecordAccessEntry[]): PatientRecordAccessEntry[] {
  return entries.map(({ occurredAt, action, label, office, role, thread }) => ({ occurredAt, action, label, office, role, thread }));
}

export async function loadPatientRecordAccess(patientId: string): Promise<PatientRecordAccessEntry[]> {
  return patientRecordAccessEntries(await loadHqRecordAccess(patientId));
}
