/**
 * Patient record edit history: the prior-value complement to the PII-free
 * admin audit ledger.
 *
 * HIPAA amendments append, never overwrite. Every staff or patient edit to a
 * shared record family (profile fields, activation status, staff weights,
 * measurement visits, medication records, provider notes) records one row per
 * changed field with the old and new value, who changed it, when, and the
 * audit event it pairs with. Deletes record the removed value; creates record
 * the new one. The write is best-effort like the audit call — it follows the
 * data write in the same request — and failures are logged, never surfaced
 * as a failed edit.
 */
import { supabaseAdmin } from "./supabase-admin";
import type { AuditActorKind } from "./admin-audit";

export const EDIT_HISTORY_FAMILIES = ["profile", "status", "weight", "measurement", "medication", "note"] as const;
export type EditHistoryFamily = (typeof EDIT_HISTORY_FAMILIES)[number];
export type EditHistoryChangeKind = "create" | "update" | "delete";
export type EditHistoryActorKind = Extract<AuditActorKind, "provider" | "team_member" | "hq" | "patient" | "system">;

export type EditHistoryValue = string | number | boolean | null | string[] | Record<string, unknown>;
export interface EditHistoryField {
  field: string;
  old: EditHistoryValue;
  new: EditHistoryValue;
}

export interface EditHistoryChange {
  changeId: string;
  family: EditHistoryFamily;
  recordId: string;
  changeKind: EditHistoryChangeKind;
  actorKind: EditHistoryActorKind;
  actorUserId: string | null;
  actorName: string | null;
  auditEventId: number | null;
  createdAt: string;
  fields: EditHistoryField[];
}

export interface EditHistoryPage {
  changes: EditHistoryChange[];
  total: number;
  nextOffset: number | null;
}

export function isEditHistoryFamily(value: unknown): value is EditHistoryFamily {
  return typeof value === "string" && (EDIT_HISTORY_FAMILIES as readonly string[]).includes(value);
}

function normalize(value: unknown): EditHistoryValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "object") return value as Record<string, unknown>;
  return String(value);
}

const same = (a: EditHistoryValue, b: EditHistoryValue) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Field rows for an update: only keys whose value actually changed, compared
 * after normalization so `undefined` and `null` are one "empty" value.
 */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: readonly string[],
): EditHistoryField[] {
  const out: EditHistoryField[] = [];
  for (const key of keys) {
    const previous = normalize(before[key]);
    const next = normalize(after[key]);
    if (!same(previous, next)) out.push({ field: key, old: previous, new: next });
  }
  return out;
}

/** Field rows for a create (old = null) or delete (new = null); empty values are skipped. */
export function snapshotFields(
  record: Record<string, unknown>,
  keys: readonly string[],
  kind: Extract<EditHistoryChangeKind, "create" | "delete">,
): EditHistoryField[] {
  const out: EditHistoryField[] = [];
  for (const key of keys) {
    const value = normalize(record[key]);
    if (value === null) continue;
    out.push(kind === "create" ? { field: key, old: null, new: value } : { field: key, old: value, new: null });
  }
  return out;
}

export interface RecordEditHistoryInput {
  patientId: string;
  family: EditHistoryFamily;
  recordId: string;
  changeKind: EditHistoryChangeKind;
  actorKind: EditHistoryActorKind;
  actorUserId: string | null;
  /** Display name captured at write time so history survives staff churn. Null for patients. */
  actorName: string | null;
  auditEventId: number | null;
  fields: EditHistoryField[];
}

/**
 * Writes one history change (all fields under one change id). Returns the
 * change id, or null when there was nothing to record. Throws on a failed
 * write so callers decide whether it is fatal (routes log and continue).
 */
export async function recordPatientEditHistory(input: RecordEditHistoryInput): Promise<string | null> {
  if (input.fields.length === 0) return null;
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/record_patient_edit_history", {
    p_patient_id: input.patientId,
    p_family: input.family,
    p_record_id: input.recordId,
    p_change_kind: input.changeKind,
    p_actor_kind: input.actorKind,
    p_actor_user_id: input.actorUserId,
    p_actor_name: input.actorName,
    p_audit_event_id: input.auditEventId,
    p_fields: input.fields,
  });
  if (result.status >= 300) throw new Error(`patient edit history write failed (${result.status})`);
  return typeof result.json === "string" ? result.json : null;
}

export const EDIT_HISTORY_PAGE_MAX = 200;

type HistoryRow = {
  change_id: string;
  family: string;
  record_id: string;
  change_kind: string;
  actor_kind: string;
  actor_user_id: string | null;
  actor_name: string | null;
  audit_event_id: number | string | null;
  created_at: string;
  fields: unknown;
  total: number | string;
};

function fieldDto(value: unknown): EditHistoryField | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.field !== "string" || !row.field) return null;
  return { field: row.field, old: normalize(row.old), new: normalize(row.new) };
}

/** Office-scoped page of grouped changes, newest first. */
export async function listPatientEditHistory(input: {
  providerId: string;
  patientId: string;
  family: EditHistoryFamily | null;
  limit: number;
  offset: number;
}): Promise<EditHistoryPage> {
  const limit = Math.max(1, Math.min(EDIT_HISTORY_PAGE_MAX, Math.trunc(input.limit)));
  const offset = Math.max(0, Math.trunc(input.offset));
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/office_patient_edit_history", {
    p_provider_id: input.providerId,
    p_patient_id: input.patientId,
    p_family: input.family,
    p_limit: limit,
    p_offset: offset,
  });
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`patient edit history read failed (${result.status})`);
  const rows = result.json as HistoryRow[];
  const changes: EditHistoryChange[] = rows.map((row) => ({
    changeId: String(row.change_id),
    family: (isEditHistoryFamily(row.family) ? row.family : "profile"),
    recordId: String(row.record_id),
    changeKind: (row.change_kind === "create" || row.change_kind === "delete" ? row.change_kind : "update"),
    actorKind: (["provider", "team_member", "hq", "patient", "system"].includes(row.actor_kind) ? row.actor_kind : "system") as EditHistoryActorKind,
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    actorName: row.actor_name ? String(row.actor_name) : null,
    auditEventId: row.audit_event_id == null ? null : Number(row.audit_event_id),
    createdAt: String(row.created_at),
    fields: (Array.isArray(row.fields) ? row.fields : []).map(fieldDto).filter((field): field is EditHistoryField => field !== null),
  }));
  const total = rows.length ? Number(rows[0].total) : offset === 0 ? 0 : await countPatientEditHistory(input);
  const nextOffset = offset + changes.length < total ? offset + changes.length : null;
  return { changes, total, nextOffset };
}

/** A page past the end carries no total row; ask for the first page's count instead. */
async function countPatientEditHistory(input: { providerId: string; patientId: string; family: EditHistoryFamily | null }): Promise<number> {
  const first = await supabaseAdmin("POST", "/rest/v1/rpc/office_patient_edit_history", {
    p_provider_id: input.providerId,
    p_patient_id: input.patientId,
    p_family: input.family,
    p_limit: 1,
    p_offset: 0,
  });
  if (first.status >= 300 || !Array.isArray(first.json)) throw new Error(`patient edit history count failed (${first.status})`);
  return first.json.length ? Number((first.json[0] as HistoryRow).total) : 0;
}
