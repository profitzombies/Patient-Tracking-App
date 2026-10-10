/**
 * Patient diet state — reads and row-level writes for the per-patient diet
 * tables (service-role only; every table is scoped by patient_id).
 *
 * Everything the choice service, the targets and the routes need comes from
 * one loader so the office record page, the patient app and the coach all
 * see the same picture: the open protocol episode, the active and pending
 * selections, the pending block, the latest screening answer per question,
 * the live preference items, the latest activity level and the override row.
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import {
  isActivityLevel,
  isScreeningAnswer,
  isScreeningQuestion,
  type ActivityLevel,
  type ActivitySource,
  type AllergySeverity,
  type PreferenceItemInput,
  type PreferenceList,
  type ScreeningAnswers,
  type ScreeningAnswer,
  type ScreeningQuestion,
  type TargetOverrides,
} from "@workspace/diet-programs";

const enc = encodeURIComponent;
type Row = Record<string, unknown>;

function ok(result: { status: number }, label: string): void {
  if (result.status >= 300) throw new Error(`${label} failed (${result.status})`);
}
function rowsOf(result: { status: number; json: unknown }, label: string): Row[] {
  ok(result, label);
  return Array.isArray(result.json) ? (result.json as Row[]) : [];
}
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null);

export type ActorRole = "patient" | "staff" | "system";
export interface DietActor {
  role: Exclude<ActorRole, "system">;
  userId: string;
  /** Display name stored on rows so "who entered this" survives staff churn. Patients store null. */
  name: string | null;
}

export interface EpisodeRecord {
  id: string;
  episodeNumber: number;
  startedOn: string;
  endedOn: string | null;
  reason: string;
  startedByRole: string;
  note: string | null;
  createdAt: string;
}
export interface SelectionRecord {
  id: string;
  dietSlug: string;
  status: string;
  selectedByRole: string;
  settings: Record<string, unknown>;
  screeningSnapshot: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
}
export interface BlockRecord {
  id: string;
  selectionId: string | null;
  dietSlug: string;
  questions: ScreeningQuestion[];
  status: string;
  overrideChallenge: string | null;
  overrideChallengedAt: string | null;
  overrideChallengedBy: string | null;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
}
export interface PreferenceRecord {
  id: string;
  list: PreferenceList;
  itemKey: string;
  label: string;
  isCustom: boolean;
  severity: AllergySeverity | null;
  enteredByRole: string;
  enteredByName: string | null;
  createdAt: string;
}
export interface ScreeningAnswerRecord {
  question: ScreeningQuestion;
  answer: ScreeningAnswer;
  contextDietSlug: string | null;
  answeredByRole: string;
  createdAt: string;
}
export interface ActivityRecord {
  level: ActivityLevel;
  source: string;
  recordedOn: string;
  createdAt: string;
}

export interface PatientDietState {
  episode: EpisodeRecord | null;
  activeSelection: SelectionRecord | null;
  pendingSelection: SelectionRecord | null;
  pendingBlock: BlockRecord | null;
  /** Latest answer per question. */
  answers: ScreeningAnswers;
  answerHistory: ScreeningAnswerRecord[];
  preferences: PreferenceRecord[];
  activity: ActivityRecord | null;
  overrides: TargetOverrides;
}

export const SELECTION_SELECT = "id,diet_slug,status,selected_by,selected_by_role,settings,screening_snapshot,started_at,ended_at";
export const BLOCK_SELECT = "id,selection_id,diet_slug,questions,status,override_challenge,override_challenged_at,override_challenged_by,reviewed_by,reviewed_by_name,reviewed_at,review_note,created_at";
export const PREFERENCE_SELECT = "id,list,item_key,label,is_custom,severity,entered_by,entered_by_role,entered_by_name,created_at";
export const EPISODE_SELECT = "id,episode_number,started_on,ended_on,reason,started_by,started_by_role,note,created_at";

export function episodeRecord(row: Row): EpisodeRecord {
  return {
    id: String(row.id), episodeNumber: Number(row.episode_number ?? 1), startedOn: String(row.started_on).slice(0, 10),
    endedOn: str(row.ended_on), reason: String(row.reason ?? ""), startedByRole: String(row.started_by_role ?? "system"),
    note: str(row.note), createdAt: String(row.created_at ?? ""),
  };
}
export function selectionRecord(row: Row): SelectionRecord {
  return {
    id: String(row.id), dietSlug: String(row.diet_slug), status: String(row.status), selectedByRole: String(row.selected_by_role ?? ""),
    settings: row.settings && typeof row.settings === "object" ? (row.settings as Record<string, unknown>) : {},
    screeningSnapshot: row.screening_snapshot && typeof row.screening_snapshot === "object" ? (row.screening_snapshot as Record<string, unknown>) : {},
    startedAt: String(row.started_at ?? ""), endedAt: str(row.ended_at),
  };
}
export function blockRecord(row: Row): BlockRecord {
  return {
    id: String(row.id), selectionId: str(row.selection_id), dietSlug: String(row.diet_slug),
    questions: Array.isArray(row.questions) ? row.questions.filter(isScreeningQuestion) : [],
    status: String(row.status), overrideChallenge: str(row.override_challenge), overrideChallengedAt: str(row.override_challenged_at),
    overrideChallengedBy: str(row.override_challenged_by), reviewedBy: str(row.reviewed_by), reviewedByName: str(row.reviewed_by_name),
    reviewedAt: str(row.reviewed_at), reviewNote: str(row.review_note), createdAt: String(row.created_at ?? ""),
  };
}
export function preferenceRecord(row: Row): PreferenceRecord {
  return {
    id: String(row.id), list: String(row.list) as PreferenceList, itemKey: String(row.item_key), label: String(row.label),
    isCustom: Boolean(row.is_custom), severity: row.severity === "mild" || row.severity === "severe" ? row.severity : null,
    enteredByRole: String(row.entered_by_role ?? ""), enteredByName: str(row.entered_by_name), createdAt: String(row.created_at ?? ""),
  };
}
export function preferenceInput(item: PreferenceRecord): PreferenceItemInput {
  return { list: item.list, key: item.itemKey, label: item.label, custom: item.isCustom, severity: item.severity };
}

export async function loadPatientDietState(patientId: string): Promise<PatientDietState> {
  const scope = `patient_id=eq.${enc(patientId)}`;
  const [episodes, selections, blocks, answers, prefs, activity, overrides] = await Promise.all([
    supabaseAdmin("GET", `/rest/v1/patient_protocol_episodes?${scope}&ended_on=is.null&select=${EPISODE_SELECT}&order=episode_number.desc&limit=1`),
    supabaseAdmin("GET", `/rest/v1/patient_diet_selections?${scope}&status=in.(active,pending_review)&select=${SELECTION_SELECT}&order=started_at.desc&limit=2`),
    supabaseAdmin("GET", `/rest/v1/patient_diet_blocks?${scope}&status=eq.pending&select=${BLOCK_SELECT}&order=created_at.desc&limit=1`),
    supabaseAdmin("GET", `/rest/v1/patient_screening_answers?${scope}&select=question,answer,context_diet_slug,answered_by_role,created_at&order=created_at.desc&limit=200`),
    supabaseAdmin("GET", `/rest/v1/patient_preference_items?${scope}&removed_at=is.null&select=${PREFERENCE_SELECT}&order=created_at.asc&limit=500`),
    supabaseAdmin("GET", `/rest/v1/patient_activity_levels?${scope}&select=level,source,recorded_on,created_at&order=recorded_on.desc,created_at.desc&limit=1`),
    supabaseAdmin("GET", `/rest/v1/patient_target_overrides?${scope}&select=calories,protein,carbs,fat,water_oz&limit=1`),
  ]);
  const episodeRows = rowsOf(episodes, "protocol episode read");
  const selectionRows = rowsOf(selections, "diet selection read").map(selectionRecord);
  const blockRows = rowsOf(blocks, "diet block read");
  const answerRows = rowsOf(answers, "screening answer read");
  const prefRows = rowsOf(prefs, "preference item read");
  const activityRows = rowsOf(activity, "activity level read");
  const overrideRow = rowsOf(overrides, "target override read")[0] ?? {};

  const latest: ScreeningAnswers = {};
  const history: ScreeningAnswerRecord[] = [];
  for (const row of answerRows) {
    if (!isScreeningQuestion(row.question) || !isScreeningAnswer(row.answer)) continue;
    history.push({ question: row.question, answer: row.answer, contextDietSlug: str(row.context_diet_slug), answeredByRole: String(row.answered_by_role ?? ""), createdAt: String(row.created_at ?? "") });
    if (latest[row.question] === undefined) latest[row.question] = row.answer;
  }
  const activityRow = activityRows[0];
  return {
    episode: episodeRows[0] ? episodeRecord(episodeRows[0]) : null,
    activeSelection: selectionRows.find((s) => s.status === "active") ?? null,
    pendingSelection: selectionRows.find((s) => s.status === "pending_review") ?? null,
    pendingBlock: blockRows[0] ? blockRecord(blockRows[0]) : null,
    answers: latest,
    answerHistory: history,
    preferences: prefRows.map(preferenceRecord),
    activity: activityRow && isActivityLevel(activityRow.level)
      ? { level: activityRow.level, source: String(activityRow.source ?? ""), recordedOn: String(activityRow.recorded_on).slice(0, 10), createdAt: String(activityRow.created_at ?? "") }
      : null,
    overrides: { calories: num(overrideRow.calories), protein: num(overrideRow.protein), carbs: num(overrideRow.carbs), fat: num(overrideRow.fat), waterOz: num(overrideRow.water_oz) },
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────

export async function recordScreeningAnswers(patientId: string, answers: Partial<Record<ScreeningQuestion, ScreeningAnswer>>, contextSlug: string | null, actor: DietActor, at: Date): Promise<void> {
  const rows = (Object.entries(answers) as Array<[ScreeningQuestion, ScreeningAnswer]>).map(([question, answer]) => ({
    patient_id: patientId, question, answer, context_diet_slug: contextSlug,
    answered_by: actor.userId, answered_by_role: actor.role, created_at: at.toISOString(),
  }));
  if (!rows.length) return;
  ok(await supabaseAdmin("POST", "/rest/v1/patient_screening_answers", rows, "return=minimal"), "screening answer write");
}

export async function recordActivityLevel(patientId: string, level: ActivityLevel, source: ActivitySource, actor: DietActor, recordedOn: string, at: Date): Promise<void> {
  ok(await supabaseAdmin("POST", "/rest/v1/patient_activity_levels", [{
    patient_id: patientId, level, source, recorded_on: recordedOn, recorded_by: actor.userId, recorded_by_role: actor.role, created_at: at.toISOString(),
  }], "return=minimal"), "activity level write");
}

/** Close the active selection (and withdraw any pending one) before a new pick lands. */
export async function endOpenSelections(patientId: string, at: Date, opts: { withdrawPending: boolean; supersedeActive: boolean }): Promise<void> {
  const iso = at.toISOString();
  if (opts.supersedeActive) {
    ok(await supabaseAdmin("PATCH", `/rest/v1/patient_diet_selections?patient_id=eq.${enc(patientId)}&status=eq.active`, { status: "superseded", ended_at: iso }, "return=minimal"), "diet selection supersede");
  }
  if (opts.withdrawPending) {
    ok(await supabaseAdmin("PATCH", `/rest/v1/patient_diet_selections?patient_id=eq.${enc(patientId)}&status=eq.pending_review`, { status: "withdrawn", ended_at: iso }, "return=minimal"), "pending selection withdraw");
    ok(await supabaseAdmin("PATCH", `/rest/v1/patient_diet_blocks?patient_id=eq.${enc(patientId)}&status=eq.pending`, { status: "withdrawn", reviewed_at: iso }, "return=minimal"), "pending block withdraw");
  }
}

export async function insertSelection(input: {
  patientId: string; dietSlug: string; status: "active" | "pending_review"; actor: DietActor;
  settings: Record<string, unknown>; screeningSnapshot: Record<string, unknown>; at: Date;
}): Promise<SelectionRecord> {
  const inserted = await supabaseAdmin("POST", "/rest/v1/patient_diet_selections", [{
    patient_id: input.patientId, diet_slug: input.dietSlug, status: input.status,
    selected_by: input.actor.userId, selected_by_role: input.actor.role,
    settings: input.settings, screening_snapshot: input.screeningSnapshot, started_at: input.at.toISOString(),
  }], "return=representation");
  const row = rowsOf(inserted, "diet selection insert")[0];
  if (!row) throw new Error("diet selection insert returned no row");
  return selectionRecord(row);
}

export async function insertBlock(input: { patientId: string; selectionId: string; dietSlug: string; questions: ScreeningQuestion[]; at: Date }): Promise<BlockRecord> {
  const inserted = await supabaseAdmin("POST", "/rest/v1/patient_diet_blocks", [{
    patient_id: input.patientId, selection_id: input.selectionId, diet_slug: input.dietSlug, questions: input.questions,
    status: "pending", created_at: input.at.toISOString(),
  }], "return=representation");
  const row = rowsOf(inserted, "diet block insert")[0];
  if (!row) throw new Error("diet block insert returned no row");
  return blockRecord(row);
}

export async function patchBlock(blockId: string, patch: Row): Promise<BlockRecord | null> {
  const updated = await supabaseAdmin("PATCH", `/rest/v1/patient_diet_blocks?id=eq.${enc(blockId)}&select=${BLOCK_SELECT}`, patch, "return=representation");
  const row = rowsOf(updated, "diet block update")[0];
  return row ? blockRecord(row) : null;
}

export async function activatePendingSelection(patientId: string, selectionId: string, at: Date): Promise<SelectionRecord | null> {
  const iso = at.toISOString();
  ok(await supabaseAdmin("PATCH", `/rest/v1/patient_diet_selections?patient_id=eq.${enc(patientId)}&status=eq.active`, { status: "superseded", ended_at: iso }, "return=minimal"), "diet selection supersede");
  const updated = await supabaseAdmin("PATCH", `/rest/v1/patient_diet_selections?id=eq.${enc(selectionId)}&patient_id=eq.${enc(patientId)}&status=eq.pending_review&select=${SELECTION_SELECT}`, { status: "active", started_at: iso }, "return=representation");
  const row = rowsOf(updated, "pending selection activate")[0];
  return row ? selectionRecord(row) : null;
}

export async function rejectPendingSelection(patientId: string, selectionId: string, at: Date): Promise<void> {
  ok(await supabaseAdmin("PATCH", `/rest/v1/patient_diet_selections?id=eq.${enc(selectionId)}&patient_id=eq.${enc(patientId)}&status=eq.pending_review`, { status: "rejected", ended_at: at.toISOString() }, "return=minimal"), "pending selection reject");
}

export async function updateSelectionSettings(patientId: string, selectionId: string, settings: Record<string, unknown>): Promise<SelectionRecord | null> {
  const updated = await supabaseAdmin("PATCH", `/rest/v1/patient_diet_selections?id=eq.${enc(selectionId)}&patient_id=eq.${enc(patientId)}&select=${SELECTION_SELECT}`, { settings }, "return=representation");
  const row = rowsOf(updated, "diet selection settings update")[0];
  return row ? selectionRecord(row) : null;
}

export async function insertPreferenceItem(input: {
  patientId: string; list: PreferenceList; itemKey: string; label: string; isCustom: boolean; severity: AllergySeverity | null; actor: DietActor | { role: "migration"; userId: null; name: null }; at: Date;
}): Promise<{ kind: "created"; item: PreferenceRecord } | { kind: "duplicate" }> {
  const inserted = await supabaseAdmin("POST", "/rest/v1/patient_preference_items", [{
    patient_id: input.patientId, list: input.list, item_key: input.itemKey, label: input.label, is_custom: input.isCustom,
    severity: input.severity, entered_by: input.actor.userId, entered_by_role: input.actor.role, entered_by_name: input.actor.name,
    created_at: input.at.toISOString(),
  }], "return=representation");
  if (inserted.status === 409) return { kind: "duplicate" };
  const row = rowsOf(inserted, "preference item insert")[0];
  if (!row) throw new Error("preference item insert returned no row");
  return { kind: "created", item: preferenceRecord(row) };
}

export async function updatePreferenceSeverity(patientId: string, itemId: string, severity: AllergySeverity): Promise<PreferenceRecord | null> {
  const updated = await supabaseAdmin("PATCH", `/rest/v1/patient_preference_items?id=eq.${enc(itemId)}&patient_id=eq.${enc(patientId)}&list=eq.allergy&removed_at=is.null&select=${PREFERENCE_SELECT}`, { severity }, "return=representation");
  const row = rowsOf(updated, "preference severity update")[0];
  return row ? preferenceRecord(row) : null;
}

export async function removePreferenceItem(patientId: string, itemId: string, actor: DietActor, at: Date): Promise<PreferenceRecord | null> {
  const updated = await supabaseAdmin("PATCH", `/rest/v1/patient_preference_items?id=eq.${enc(itemId)}&patient_id=eq.${enc(patientId)}&removed_at=is.null&select=${PREFERENCE_SELECT}`, {
    removed_at: at.toISOString(), removed_by: actor.userId, removed_by_role: actor.role,
  }, "return=representation");
  const row = rowsOf(updated, "preference item remove")[0];
  return row ? preferenceRecord(row) : null;
}

export async function listEpisodes(patientId: string): Promise<EpisodeRecord[]> {
  return rowsOf(await supabaseAdmin("GET", `/rest/v1/patient_protocol_episodes?patient_id=eq.${enc(patientId)}&select=${EPISODE_SELECT}&order=episode_number.desc&limit=100`), "protocol episode list").map(episodeRecord);
}

export async function listSelectionHistory(patientId: string, limit = 50): Promise<SelectionRecord[]> {
  return rowsOf(await supabaseAdmin("GET", `/rest/v1/patient_diet_selections?patient_id=eq.${enc(patientId)}&select=${SELECTION_SELECT}&order=started_at.desc&limit=${limit}`), "diet selection history").map(selectionRecord);
}

export async function listBlockHistory(patientId: string, limit = 50): Promise<BlockRecord[]> {
  return rowsOf(await supabaseAdmin("GET", `/rest/v1/patient_diet_blocks?patient_id=eq.${enc(patientId)}&select=${BLOCK_SELECT}&order=created_at.desc&limit=${limit}`), "diet block history").map(blockRecord);
}

export async function listActivityHistory(patientId: string, limit = 60): Promise<ActivityRecord[]> {
  return rowsOf(await supabaseAdmin("GET", `/rest/v1/patient_activity_levels?patient_id=eq.${enc(patientId)}&select=level,source,recorded_on,created_at&order=recorded_on.desc,created_at.desc&limit=${limit}`), "activity history")
    .filter((row) => isActivityLevel(row.level))
    .map((row) => ({ level: row.level as ActivityLevel, source: String(row.source ?? ""), recordedOn: String(row.recorded_on).slice(0, 10), createdAt: String(row.created_at ?? "") }));
}

/** Provider restart: a new episode from day one, nothing deleted. Returns the new episode. */
export async function restartProtocolEpisode(patientId: string, startedOn: string, actor: DietActor, note: string | null): Promise<EpisodeRecord> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_protocol_restart", {
    p_patient_id: patientId, p_started_on: startedOn, p_actor: actor.userId, p_note: note,
  });
  ok(result, "protocol restart");
  const row = (Array.isArray(result.json) ? result.json[0] : result.json) as Row | null;
  if (!row || !row.id) throw new Error("protocol restart returned no episode");
  return episodeRecord(row);
}
