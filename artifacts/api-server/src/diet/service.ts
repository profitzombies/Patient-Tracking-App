/**
 * Diet choice service — the one place a diet is set, parked, approved or
 * rejected, for the patient app and the office alike.
 *
 * Flow for a pick (patient or staff):
 *   1. the entry must be one patients may select today (published, or
 *      "just tracking");
 *   2. new screening answers are appended (PHI rows) and merged with the
 *      latest stored answers;
 *   3. the shared screening rules decide: locked (protocol), needs answers,
 *      blocked for pregnancy, parked behind a safety block, or allowed;
 *   4. allowed → the prior active selection is superseded and the new one
 *      starts; parked → a pending selection + a pending block for the
 *      provider, the current diet stays;
 *   5. the care team and (when staff made the change) the patient are told,
 *      PHI-free, deduped per day.
 *
 * The two-step provider override: step one stores a short-lived challenge
 * token on the block and returns it; step two must echo it from the same
 * actor inside the window — that is the "Are you sure you want to do this?"
 * confirmation, recorded with who and when.
 */
import crypto from "node:crypto";
import {
  ACTIVITY_LEVELS,
  ALLERGEN_KEYS,
  ALLERGEN_LABELS,
  FERTILITY_PREGNANCY_SLUG,
  PREFERENCE_LISTS,
  RESTRICTION_BY_KEY,
  resolvePreferenceKey,
  SENSITIVITY_BY_KEY,
  blockingYeses,
  evaluateDietChoice,
  isActivityLevel,
  isScreeningAnswer,
  isScreeningQuestion,
  pregnancyWarningFor,
  questionsForDiet,
  suggestedDefaultSlug,
  type ActivityLevel,
  type AllergySeverity,
  type PreferenceList,
  type ScreeningAnswer,
  type ScreeningAnswers,
  type ScreeningQuestion,
} from "@workspace/diet-programs";
import { loadLibraryEntry, loadLibraryRows, screeningFacts, selectableByPatients, type DietLibraryRow } from "./library";
import { notifyCareTeam, notifyPatient, type DietStaffKind } from "./notifications";
import { phaseFor, programIdOf, type TargetPatientRow } from "./targets";
import {
  activatePendingSelection,
  endOpenSelections,
  insertBlock,
  insertPreferenceItem,
  insertSelection,
  loadPatientDietState,
  patchBlock,
  recordActivityLevel,
  recordScreeningAnswers,
  rejectPendingSelection,
  removePreferenceItem,
  updatePreferenceSeverity,
  updateSelectionSettings,
  type BlockRecord,
  type DietActor,
  type PatientDietState,
  type PreferenceRecord,
  type SelectionRecord,
} from "./store";

export const OVERRIDE_CHALLENGE_WINDOW_MS = 10 * 60_000;
export const OVERRIDE_CONFIRM_TEXT = "Are you sure you want to do this?";

export interface DietPatient extends TargetPatientRow {
  id: string;
  provider_id?: string | null;
  timezone?: string | null;
}

export type Logger = { error: (obj: unknown, msg?: string) => void } | undefined;
function swallow(log: Logger, label: string) {
  return (error: unknown) => log?.error({ err: error }, label);
}

// ── Settings per diet (fasting window, Whole30 start) ───────────────────────

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DietSettings {
  fastingWindow?: { eatingStart: string; eatingEnd: string } | null;
  whole30StartDate?: string | null;
}

/** Validates the per-diet settings a patient may store on their selection. */
export function parseDietSettings(input: unknown): { ok: true; value: DietSettings } | { ok: false; error: string; field: string } {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Settings must be an object.", field: "settings" };
  const body = input as Record<string, unknown>;
  const value: DietSettings = {};
  if (body.fastingWindow !== undefined) {
    if (body.fastingWindow === null) value.fastingWindow = null;
    else {
      const fw = body.fastingWindow as Record<string, unknown>;
      if (!fw || typeof fw !== "object" || !TIME_RE.test(String(fw.eatingStart ?? "")) || !TIME_RE.test(String(fw.eatingEnd ?? ""))) {
        return { ok: false, error: "Eating window times must be HH:MM.", field: "fastingWindow" };
      }
      value.fastingWindow = { eatingStart: String(fw.eatingStart), eatingEnd: String(fw.eatingEnd) };
    }
  }
  if (body.whole30StartDate !== undefined) {
    if (body.whole30StartDate === null) value.whole30StartDate = null;
    else if (typeof body.whole30StartDate !== "string" || !DATE_RE.test(body.whole30StartDate)) {
      return { ok: false, error: "Start date must be YYYY-MM-DD.", field: "whole30StartDate" };
    } else value.whole30StartDate = body.whole30StartDate;
  }
  return { ok: true, value };
}

export function parseAnswers(input: unknown): { ok: true; value: Partial<Record<ScreeningQuestion, ScreeningAnswer>> } | { ok: false; error: string; field: string } {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Answers must be an object.", field: "answers" };
  const value: Partial<Record<ScreeningQuestion, ScreeningAnswer>> = {};
  for (const [question, answer] of Object.entries(input as Record<string, unknown>)) {
    if (!isScreeningQuestion(question)) return { ok: false, error: `Unknown screening question "${question}".`, field: "answers" };
    if (!isScreeningAnswer(answer)) return { ok: false, error: `Answer for "${question}" must be yes, no or skipped.`, field: "answers" };
    if (answer === "skipped" && question !== "pregnancy") return { ok: false, error: `"${question}" needs a yes or no.`, field: "answers" };
    value[question] = answer;
  }
  return { ok: true, value };
}

// ── Choosing a diet ─────────────────────────────────────────────────────────

export interface ChooseDietInput {
  patient: DietPatient;
  actor: DietActor;
  dietSlug: string;
  answers: Partial<Record<ScreeningQuestion, ScreeningAnswer>>;
  settings: DietSettings;
  activityLevel: ActivityLevel | null;
  /** Patient-local day. */
  dateKey: string;
  now: Date;
  log?: Logger;
}

export type ChooseDietResult =
  | { kind: "not_found" }
  | { kind: "not_selectable" }
  | { kind: "locked"; programDay: number }
  | { kind: "needs_answers"; questions: ScreeningQuestion[] }
  | { kind: "pending_review"; reason: "pregnancy" | "screening"; questions: ScreeningQuestion[]; suggestedSlug: string | null; selection: SelectionRecord; block: BlockRecord }
  | { kind: "active"; selection: SelectionRecord; previousSlug: string | null; oversightRecommended: boolean };

export async function chooseDiet(input: ChooseDietInput): Promise<ChooseDietResult> {
  const entry = await loadLibraryEntry(input.dietSlug);
  if (!entry) return { kind: "not_found" };
  if (!selectableByPatients(entry)) return { kind: "not_selectable" };
  const facts = screeningFacts(entry);

  const state = await loadPatientDietState(input.patient.id);
  const phase = phaseFor(input.patient, state.episode, input.dateKey);
  const gender = input.patient.gender === "male" || input.patient.gender === "female" ? input.patient.gender : null;
  const asked = new Set(questionsForDiet(facts, gender));
  // Only answers the diet asks for are stored against this pick; a pregnancy
  // answer is accepted from any pick because it is asked once.
  const relevant = Object.fromEntries(Object.entries(input.answers).filter(([q]) => asked.has(q as ScreeningQuestion) || q === "pregnancy")) as Partial<Record<ScreeningQuestion, ScreeningAnswer>>;
  if (Object.keys(relevant).length > 0) await recordScreeningAnswers(input.patient.id, relevant, entry.slug, input.actor, input.now);
  const answers: ScreeningAnswers = { ...state.answers, ...relevant };

  const verdict = evaluateDietChoice(facts, { phase: phase.phase, programId: programIdOf(input.patient), gender, answers, actor: input.actor.role === "staff" ? "staff" : "patient" });
  if (verdict.kind === "locked") return { kind: "locked", programDay: phase.programDay };
  if (verdict.kind === "needs_answers") return { kind: "needs_answers", questions: verdict.questions };

  if (input.activityLevel) {
    await recordActivityLevel(input.patient.id, input.activityLevel, input.actor.role === "staff" ? "staff" : "diet_selection", input.actor, input.dateKey, input.now);
  }
  const snapshot = Object.fromEntries([...asked].map((q) => [q, answers[q] ?? null]));
  const settings = { ...input.settings } as Record<string, unknown>;

  if (verdict.kind === "blocked_pregnancy" || verdict.kind === "pending_block") {
    // Park the pick: the current diet stays; the provider decides.
    await endOpenSelections(input.patient.id, input.now, { withdrawPending: true, supersedeActive: false });
    const selection = await insertSelection({ patientId: input.patient.id, dietSlug: entry.slug, status: "pending_review", actor: input.actor, settings, screeningSnapshot: snapshot, at: input.now });
    const questions = verdict.kind === "blocked_pregnancy" ? ["pregnancy" as const, ...blockingYeses(facts, answers)] : verdict.questions;
    const block = await insertBlock({ patientId: input.patient.id, selectionId: selection.id, dietSlug: entry.slug, questions, at: input.now });
    await notifyCareTeam({ patientId: input.patient.id, providerId: input.patient.provider_id, kind: "diet_safety", refs: { selectionId: selection.id, blockId: block.id }, now: input.now })
      .catch(swallow(input.log, "diet safety care-team notice failed"));
    return {
      kind: "pending_review",
      reason: verdict.kind === "blocked_pregnancy" ? "pregnancy" : "screening",
      questions,
      suggestedSlug: verdict.kind === "blocked_pregnancy" ? verdict.suggestedSlug : null,
      selection, block,
    };
  }

  const previousSlug = state.activeSelection?.dietSlug ?? null;
  await endOpenSelections(input.patient.id, input.now, { withdrawPending: true, supersedeActive: true });
  const selection = await insertSelection({ patientId: input.patient.id, dietSlug: entry.slug, status: "active", actor: input.actor, settings, screeningSnapshot: snapshot, at: input.now });
  const kinds: DietStaffKind[] = ["diet_change"];
  if (verdict.notifyCareTeam.includes("medication_yes")) kinds.push("diet_safety");
  await Promise.all([
    ...kinds.map((kind) => notifyCareTeam({ patientId: input.patient.id, providerId: input.patient.provider_id, kind, refs: { selectionId: selection.id }, now: input.now }).catch(swallow(input.log, `${kind} care-team notice failed`))),
    input.actor.role === "staff"
      ? notifyPatient({ patientId: input.patient.id, kind: "diet_changed_by_provider", dayKey: input.dateKey, now: input.now }).catch(swallow(input.log, "diet changed patient notice failed"))
      : Promise.resolve(),
  ]);
  return { kind: "active", selection, previousSlug, oversightRecommended: verdict.notifyCareTeam.includes("oversight_recommended") };
}

/** Patient withdraws their own diet: back to "no diet" (history kept). */
export async function clearDiet(input: { patient: DietPatient; actor: DietActor; dateKey: string; now: Date; log?: Logger }): Promise<{ previousSlug: string | null }> {
  const state = await loadPatientDietState(input.patient.id);
  const previousSlug = state.activeSelection?.dietSlug ?? null;
  await endOpenSelections(input.patient.id, input.now, { withdrawPending: true, supersedeActive: true });
  if (previousSlug) {
    await notifyCareTeam({ patientId: input.patient.id, providerId: input.patient.provider_id, kind: "diet_change", now: input.now }).catch(swallow(input.log, "diet cleared care-team notice failed"));
    if (input.actor.role === "staff") {
      await notifyPatient({ patientId: input.patient.id, kind: "diet_changed_by_provider", dayKey: input.dateKey, now: input.now }).catch(swallow(input.log, "diet cleared patient notice failed"));
    }
  }
  return { previousSlug };
}

export async function saveDietSettings(patientId: string, state: PatientDietState, settings: DietSettings): Promise<SelectionRecord | null> {
  const selection = state.activeSelection;
  if (!selection) return null;
  const merged: Record<string, unknown> = { ...selection.settings };
  for (const [key, value] of Object.entries(settings)) {
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }
  return updateSelectionSettings(patientId, selection.id, merged);
}

// ── Screening answers outside a pick ────────────────────────────────────────

export interface AnswerResult {
  answers: ScreeningAnswers;
  /** True when a yes to pregnancy conflicts with the current diet. */
  pregnancyConflict: boolean;
  suggestedSlug: string | null;
}

/**
 * Records answers given on their own (the one-time pregnancy question, a
 * weekly check-in). A new yes to pregnancy while on a pregnancy-blocked
 * diet warns the patient and the care team the same day.
 */
export async function recordAnswers(input: { patient: DietPatient; actor: DietActor; answers: Partial<Record<ScreeningQuestion, ScreeningAnswer>>; dateKey: string; now: Date; log?: Logger }): Promise<AnswerResult> {
  const state = await loadPatientDietState(input.patient.id);
  if (Object.keys(input.answers).length > 0) await recordScreeningAnswers(input.patient.id, input.answers, state.activeSelection?.dietSlug ?? null, input.actor, input.now);
  const answers: ScreeningAnswers = { ...state.answers, ...input.answers };
  const currentSlug = state.activeSelection?.dietSlug ?? null;
  let conflict = false;
  if (input.answers.pregnancy === "yes" && currentSlug) {
    const entry = await loadLibraryEntry(currentSlug);
    conflict = pregnancyWarningFor(currentSlug, entry ? screeningFacts(entry) : null);
  }
  if (conflict) {
    await Promise.all([
      notifyPatient({ patientId: input.patient.id, kind: "diet_pregnancy_warning", dayKey: input.dateKey, now: input.now }).catch(swallow(input.log, "pregnancy warning patient notice failed")),
      notifyCareTeam({ patientId: input.patient.id, providerId: input.patient.provider_id, kind: "diet_safety", refs: { selectionId: state.activeSelection?.id ?? null }, now: input.now }).catch(swallow(input.log, "pregnancy warning care-team notice failed")),
    ]);
  }
  return { answers, pregnancyConflict: conflict, suggestedSlug: conflict ? FERTILITY_PREGNANCY_SLUG : null };
}

/** The standing pregnancy conflict, for state reads (current answer vs current diet). */
export function standingPregnancyConflict(state: PatientDietState, rows: DietLibraryRow[]): boolean {
  const slug = state.activeSelection?.dietSlug ?? null;
  if (!slug || state.answers.pregnancy !== "yes") return false;
  const row = rows.find((r) => r.slug === slug);
  return pregnancyWarningFor(slug, row ? screeningFacts(row) : null);
}

// ── Provider override (two steps) and rejection ─────────────────────────────

export type OverrideRefusal = "pregnancy" | "diet_unavailable";
export type OverrideStartResult =
  | { kind: "not_found" }
  | { kind: "not_overridable"; block: BlockRecord; reason: OverrideRefusal }
  | { kind: "started"; block: BlockRecord; challenge: string; confirmText: string; expiresAt: string };

/**
 * A pregnancy / breastfeeding block has no provider override (shared
 * screening rule): the provider may only reject it, and the fertility plan is
 * the suggested path. Medication and eating-disorder blocks remain
 * overridable after the second confirmation.
 */
export function blockIsOverridable(block: Pick<BlockRecord, "questions">): boolean {
  return !block.questions.includes("pregnancy");
}

/**
 * Re-evaluates the block against what is true NOW, not what was true when it
 * was parked: the patient's latest screening answers and the current library
 * entry. A medication block parked after a pregnancy "no" becomes a pregnancy
 * refusal the moment the patient answers "yes", and a diet HQ has since
 * unpublished cannot be activated through an override. Both override steps
 * run this immediately before touching the row.
 */
export async function overrideRefusal(block: Pick<BlockRecord, "questions" | "dietSlug">, state: Pick<PatientDietState, "answers">): Promise<OverrideRefusal | null> {
  if (!blockIsOverridable(block)) return "pregnancy";
  const entry = await loadLibraryEntry(block.dietSlug);
  if (!entry || !selectableByPatients(entry)) return "diet_unavailable";
  if (state.answers.pregnancy === "yes" && pregnancyWarningFor(entry.slug, screeningFacts(entry))) return "pregnancy";
  return null;
}

export async function startOverride(input: { patientId: string; blockId: string; state: PatientDietState; actor: DietActor; now: Date }): Promise<OverrideStartResult> {
  const block = input.state.pendingBlock;
  if (!block || block.id !== input.blockId) return { kind: "not_found" };
  const refusal = await overrideRefusal(block, input.state);
  if (refusal) return { kind: "not_overridable", block, reason: refusal };
  const challenge = crypto.randomBytes(9).toString("base64url");
  const updated = await patchBlock(block.id, { override_challenge: challenge, override_challenged_at: input.now.toISOString(), override_challenged_by: input.actor.userId });
  if (!updated) return { kind: "not_found" };
  return { kind: "started", block: updated, challenge, confirmText: OVERRIDE_CONFIRM_TEXT, expiresAt: new Date(input.now.getTime() + OVERRIDE_CHALLENGE_WINDOW_MS).toISOString() };
}

export type OverrideConfirmResult =
  | { kind: "not_found" }
  | { kind: "not_overridable"; block: BlockRecord; reason: OverrideRefusal }
  | { kind: "challenge_mismatch" }
  | { kind: "challenge_expired" }
  | { kind: "overridden"; block: BlockRecord; selection: SelectionRecord; previousSlug: string | null };

export async function confirmOverride(input: { patient: DietPatient; blockId: string; challenge: string; note: string | null; state: PatientDietState; actor: DietActor; dateKey: string; now: Date; log?: Logger }): Promise<OverrideConfirmResult> {
  const block = input.state.pendingBlock;
  if (!block || block.id !== input.blockId || !input.state.pendingSelection || block.selectionId !== input.state.pendingSelection.id) return { kind: "not_found" };
  const refusal = await overrideRefusal(block, input.state);
  if (refusal) return { kind: "not_overridable", block, reason: refusal };
  if (!block.overrideChallenge || !block.overrideChallengedAt || block.overrideChallengedBy !== input.actor.userId || block.overrideChallenge !== input.challenge) return { kind: "challenge_mismatch" };
  if (input.now.getTime() - Date.parse(block.overrideChallengedAt) > OVERRIDE_CHALLENGE_WINDOW_MS) return { kind: "challenge_expired" };
  const previousSlug = input.state.activeSelection?.dietSlug ?? null;
  const updated = await patchBlock(block.id, {
    status: "overridden", reviewed_by: input.actor.userId, reviewed_by_name: input.actor.name, reviewed_at: input.now.toISOString(), review_note: input.note,
  });
  const selection = await activatePendingSelection(input.patient.id, input.state.pendingSelection.id, input.now);
  if (!updated || !selection) return { kind: "not_found" };
  await Promise.all([
    notifyCareTeam({ patientId: input.patient.id, providerId: input.patient.provider_id, kind: "diet_change", refs: { selectionId: selection.id, blockId: block.id }, now: input.now }).catch(swallow(input.log, "override care-team notice failed")),
    notifyPatient({ patientId: input.patient.id, kind: "diet_changed_by_provider", dayKey: input.dateKey, now: input.now }).catch(swallow(input.log, "override patient notice failed")),
  ]);
  return { kind: "overridden", block: updated, selection, previousSlug };
}

export async function rejectBlock(input: { patientId: string; blockId: string; note: string | null; state: PatientDietState; actor: DietActor; now: Date }): Promise<{ kind: "not_found" } | { kind: "rejected"; block: BlockRecord }> {
  const block = input.state.pendingBlock;
  if (!block || block.id !== input.blockId) return { kind: "not_found" };
  const updated = await patchBlock(block.id, { status: "rejected", reviewed_by: input.actor.userId, reviewed_by_name: input.actor.name, reviewed_at: input.now.toISOString(), review_note: input.note });
  if (!updated) return { kind: "not_found" };
  if (block.selectionId) await rejectPendingSelection(input.patientId, block.selectionId, input.now);
  return { kind: "rejected", block: updated };
}

// ── Preference lists ────────────────────────────────────────────────────────

export interface PreferenceItemBody {
  list: PreferenceList;
  itemKey: string;
  label: string;
  isCustom: boolean;
  severity: AllergySeverity | null;
}

function slugify(label: string): string {
  return label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

/**
 * Validates a list item. Catalog keys resolve to their canonical label;
 * anything else is a custom item (`custom:` prefix, free-text label kept).
 * Dislikes are always custom — there is no dislike catalog.
 */
export function parsePreferenceItem(input: unknown): { ok: true; value: PreferenceItemBody } | { ok: false; error: string; field: string } {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const list = body.list;
  if (typeof list !== "string" || !(PREFERENCE_LISTS as readonly string[]).includes(list)) return { ok: false, error: "List must be allergy, sensitivity, restriction or dislike.", field: "list" };
  const typedList = list as PreferenceList;
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const rawLabel = typeof body.label === "string" ? body.label.trim().replace(/\s+/g, " ") : "";
  let severity: AllergySeverity | null = null;
  if (typedList === "allergy") {
    if (body.severity !== "mild" && body.severity !== "severe") return { ok: false, error: "Allergies need a mild or severe flag.", field: "severity" };
    severity = body.severity;
  } else if (body.severity !== undefined && body.severity !== null) {
    return { ok: false, error: "Only allergies carry a severity.", field: "severity" };
  }
  let catalogLabel: string | null = null;
  // A free-text allergy or sensitivity that names a catalog entry (or one of
  // its common forms: "tree nuts", "peanuts", "shrimp", "dairy") is stored
  // under the catalog key, so the classifier's tag and ingredient rules apply
  // to it. Only a label the catalog does not recognise stays custom.
  const resolvedKey = key ? key : rawLabel ? resolvePreferenceKey(typedList, rawLabel) : null;
  if (resolvedKey && !resolvedKey.startsWith("custom:")) {
    if (typedList === "allergy" && (ALLERGEN_KEYS as readonly string[]).includes(resolvedKey)) catalogLabel = ALLERGEN_LABELS[resolvedKey as keyof typeof ALLERGEN_LABELS];
    else if (typedList === "restriction" && RESTRICTION_BY_KEY.has(resolvedKey)) catalogLabel = RESTRICTION_BY_KEY.get(resolvedKey)!.label;
    else if (typedList === "sensitivity" && SENSITIVITY_BY_KEY.has(resolvedKey)) catalogLabel = SENSITIVITY_BY_KEY.get(resolvedKey)!.label;
    else return { ok: false, error: `"${resolvedKey}" is not a known ${typedList} option.`, field: "key" };
  }
  if (catalogLabel && resolvedKey) return { ok: true, value: { list: typedList, itemKey: resolvedKey, label: catalogLabel, isCustom: false, severity } };
  if (rawLabel.length < 1 || rawLabel.length > 80) return { ok: false, error: "Give the item a name (1–80 characters).", field: "label" };
  const slug = slugify(rawLabel);
  if (!slug) return { ok: false, error: "Give the item a name with letters or numbers.", field: "label" };
  return { ok: true, value: { list: typedList, itemKey: `custom:${slug}`, label: rawLabel, isCustom: true, severity } };
}

export async function addPreferenceItem(input: { patient: DietPatient; actor: DietActor; item: PreferenceItemBody; now: Date; log?: Logger }): Promise<{ kind: "created"; item: PreferenceRecord } | { kind: "duplicate" }> {
  const result = await insertPreferenceItem({ patientId: input.patient.id, ...input.item, actor: input.actor, at: input.now });
  if (result.kind === "created" && input.item.list === "allergy" && input.item.severity === "severe") {
    await notifyCareTeam({ patientId: input.patient.id, providerId: input.patient.provider_id, kind: "diet_allergy_severe", refs: { itemId: result.item.id }, now: input.now })
      .catch(swallow(input.log, "severe allergy care-team notice failed"));
  }
  return result;
}

export async function changeAllergySeverity(input: { patient: DietPatient; itemId: string; severity: AllergySeverity; now: Date; log?: Logger }): Promise<PreferenceRecord | null> {
  const item = await updatePreferenceSeverity(input.patient.id, input.itemId, input.severity);
  if (item && input.severity === "severe") {
    await notifyCareTeam({ patientId: input.patient.id, providerId: input.patient.provider_id, kind: "diet_allergy_severe", refs: { itemId: item.id }, now: input.now })
      .catch(swallow(input.log, "severe allergy care-team notice failed"));
  }
  return item;
}

export { removePreferenceItem };

export function parseActivityLevel(value: unknown): ActivityLevel | null {
  return isActivityLevel(value) ? value : null;
}
export const ACTIVITY_LEVEL_MESSAGE = `Activity level must be one of ${ACTIVITY_LEVELS.join(", ")}.`;

// ── State DTO shared by the patient and office reads ────────────────────────

export function selectionDto(s: SelectionRecord | null) {
  return s ? { id: s.id, dietSlug: s.dietSlug, status: s.status, selectedByRole: s.selectedByRole, settings: s.settings, screeningSnapshot: s.screeningSnapshot, startedAt: s.startedAt, endedAt: s.endedAt } : null;
}
export function blockDto(b: BlockRecord | null) {
  return b ? {
    id: b.id, selectionId: b.selectionId, dietSlug: b.dietSlug, questions: b.questions, status: b.status,
    overrideStartedAt: b.overrideChallengedAt, reviewedBy: b.reviewedBy, reviewedByName: b.reviewedByName, reviewedAt: b.reviewedAt, reviewNote: b.reviewNote, createdAt: b.createdAt,
  } : null;
}
export function preferenceDto(p: PreferenceRecord) {
  return { id: p.id, list: p.list, key: p.itemKey, label: p.label, isCustom: p.isCustom, severity: p.severity, enteredByRole: p.enteredByRole, enteredByName: p.enteredByName, createdAt: p.createdAt };
}

export async function libraryRowsForState(): Promise<DietLibraryRow[]> {
  return loadLibraryRows();
}

export function dietStateDto(patient: DietPatient, state: PatientDietState, rows: DietLibraryRow[], dateKey: string) {
  const phase = phaseFor(patient, state.episode, dateKey);
  const programId = programIdOf(patient);
  return {
    dateKey,
    programId,
    phase: { ...phase, episodeId: state.episode?.id ?? null, episodeNumber: state.episode?.episodeNumber ?? null, episodeStartedOn: state.episode?.startedOn ?? null },
    currentDiet: selectionDto(state.activeSelection),
    /** The diet the app should treat as in force: null while the protocol locks the picker. */
    effectiveDietSlug: phase.dietPickerLocked ? null : state.activeSelection?.dietSlug ?? null,
    pendingSelection: selectionDto(state.pendingSelection),
    pendingBlock: blockDto(state.pendingBlock),
    suggestedDefaultSlug: suggestedDefaultSlug(programId),
    screening: { answers: state.answers, pregnancyConflict: standingPregnancyConflict(state, rows) },
    preferences: state.preferences.map(preferenceDto),
    activityLevel: state.activity ? { level: state.activity.level, source: state.activity.source, recordedOn: state.activity.recordedOn } : null,
  };
}
