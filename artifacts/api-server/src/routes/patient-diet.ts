/**
 * Patient diet programs on the live data rail.
 *
 *   GET    /patient-data/diet/library                → published diets + disclaimer
 *   GET    /patient-data/diet                        → phase, current diet, lists, screening, activity
 *   PUT    /patient-data/diet                        { dietSlug, answers?, settings?, activityLevel? }
 *   DELETE /patient-data/diet                        → back to "no diet" (history kept)
 *   PATCH  /patient-data/diet/settings               { fastingWindow?, whole30StartDate? }
 *   POST   /patient-data/diet/screening              { answers }
 *   POST   /patient-data/diet/activity               { level, source? }
 *   GET    /patient-data/diet/preferences            → the four lists
 *   POST   /patient-data/diet/preferences            { list, key?, label?, severity? }
 *   PATCH  /patient-data/diet/preferences/:id        { severity }
 *   DELETE /patient-data/diet/preferences/:id
 *   GET    /patient-data/diet/targets                → calculated + effective targets
 *   PUT    /patient-data/diet/targets                { calories?, protein?, carbs?, fat?, waterOz? } (null clears)
 *
 * Same posture as the rest of patient-data: bearer session → patient row,
 * per-IP limiters, idempotency replay on writes. Diet picks answer with the
 * shared service verdicts: 409 DIET_LOCKED during the protocol, 422
 * SCREENING_REQUIRED when a question is unanswered, 202 when the pick is
 * parked for the provider, 200 when it is in force.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { supabaseAdmin } from "../lib/supabase-admin";
import { dayKeyInTimeZone } from "../lib/local-day";
import { resolvePatient } from "../lib/patient-auth";
import { createLimiter, envLimit } from "../coach/limits";
import { openIdempotentWrite } from "../lib/idempotency";
import { clientIp } from "../auth/ledger";
import { changedFields, recordPatientEditHistory, snapshotFields } from "../lib/patient-edit-history";
import { loadPatientLibrary, patientEntryDto } from "../diet/library";
import { loadPatientDietState, recordActivityLevel, type DietActor } from "../diet/store";
import { computePatientTargets, targetsDto, upsertTargetSnapshot } from "../diet/targets";
import {
  ACTIVITY_LEVEL_MESSAGE,
  addPreferenceItem,
  changeAllergySeverity,
  chooseDiet,
  clearDiet,
  dietStateDto,
  libraryRowsForState,
  parseActivityLevel,
  parseAnswers,
  parseDietSettings,
  parsePreferenceItem,
  preferenceDto,
  recordAnswers,
  removePreferenceItem,
  saveDietSettings,
  selectionDto,
  blockDto,
  type DietPatient,
} from "../diet/service";
import type { ActivitySource } from "@workspace/diet-programs";

const router: IRouter = Router();
const enc = encodeURIComponent;

const BUSY_MESSAGE = "The service is busy right now. Please try again in a moment.";
const WAIT_MESSAGE = "Please wait a moment before trying again.";
const DAILY_MESSAGE = "Daily limit reached. Please try again tomorrow.";
export const DIET_LOCKED_MESSAGE = "Your eating plan follows the THINNR protocol until day 42. The diet picker unlocks when you finish.";
export const DIET_NOT_FOUND_MESSAGE = "That eating plan isn't available.";
export const SCREENING_REQUIRED_MESSAGE = "Answer the quick safety questions to choose this plan.";
export const PENDING_REVIEW_MESSAGE = "Your care team will review this choice before it starts. Your current plan stays in place for now.";

const acquireReadSlot = createLimiter({
  burst: envLimit("PATIENT_DATA_READ_BURST", 60), refillPerMinute: 12, maxConcurrent: 8,
  dailyBudget: envLimit("PATIENT_DATA_READ_DAILY_BUDGET", 5000),
  dailyMessage: DAILY_MESSAGE, busyMessage: BUSY_MESSAGE, rapidMessage: WAIT_MESSAGE,
});
const acquireWriteSlot = createLimiter({
  burst: envLimit("PATIENT_DATA_WRITE_BURST", 40), refillPerMinute: 20, maxConcurrent: 8,
  dailyBudget: envLimit("PATIENT_DATA_WRITE_DAILY_BUDGET", 8000),
  dailyMessage: DAILY_MESSAGE, busyMessage: BUSY_MESSAGE, rapidMessage: WAIT_MESSAGE,
});

export const DIET_PATIENT_SELECT = "id,provider_id,timezone,gender,date_of_birth,height_inches,current_weight,goal_weight,program_id,program_start_date,created_at";
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFERENCE_HISTORY_KEYS = ["list", "key", "label", "severity"] as const;

async function loadDietPatient(patientId: string): Promise<DietPatient> {
  const res = await supabaseAdmin("GET", `/rest/v1/patients?id=eq.${enc(patientId)}&select=${DIET_PATIENT_SELECT}&limit=1`);
  if (res.status >= 300 || !Array.isArray(res.json) || !res.json[0]) throw new Error(`patient lookup failed (${res.status})`);
  return res.json[0] as DietPatient;
}

function todayFor(patient: DietPatient): string {
  return dayKeyInTimeZone(typeof patient.timezone === "string" ? patient.timezone : null);
}

type Handler = (ctx: { req: Request; res: Response; patient: DietPatient; actor: DietActor; authUserId: string; today: string; now: Date }) => Promise<void>;

/** Limiter → session → patient row → handler, with one 502 shape per route. */
function guarded(kind: "read" | "write", label: string, handler: Handler) {
  const acquire = kind === "read" ? acquireReadSlot : acquireWriteSlot;
  return async (req: Request, res: Response): Promise<void> => {
    const slot = acquire(clientIp(req));
    if (!slot.ok) { res.status(slot.status).json({ error: slot.message }); return; }
    try {
      const auth = await resolvePatient(req);
      if (!auth.ok) { res.status(auth.status).json({ error: auth.error, ...auth.details }); return; }
      const patient = await loadDietPatient(auth.patientId);
      const actor: DietActor = { role: "patient", userId: auth.authUserId, name: null };
      await handler({ req, res, patient, actor, authUserId: auth.authUserId, today: todayFor(patient), now: new Date() });
    } catch (error) {
      req.log?.error({ err: error }, `patient-data diet ${label} failed`);
      if (!res.headersSent) res.status(502).json({ error: `Couldn't ${label} right now. Please try again.` });
    } finally {
      slot.ok && slot.release();
    }
  };
}

function historyPatient(req: Request, patientId: string, authUserId: string, recordId: string, changeKind: "create" | "update" | "delete", values: Record<string, unknown>): void {
  recordPatientEditHistory({
    patientId, family: "diet", recordId, changeKind, actorKind: "patient", actorUserId: authUserId, actorName: null, auditEventId: null,
    fields: changeKind === "update" ? changedFields({}, values, PREFERENCE_HISTORY_KEYS) : snapshotFields(values, PREFERENCE_HISTORY_KEYS, changeKind),
  }).catch((error) => req.log?.error({ err: error }, "patient diet history failed"));
}

// ── Library ─────────────────────────────────────────────────────────────────

router.get("/patient-data/diet/library", guarded("read", "load the eating plans", async ({ res }) => {
  const { settings, rows } = await loadPatientLibrary();
  res.json({ disclaimer: settings.disclaimer, entries: rows.map((row) => patientEntryDto(row, settings.oversightNoteText)) });
}));

// ── State ───────────────────────────────────────────────────────────────────

router.get("/patient-data/diet", guarded("read", "load your eating plan", async ({ res, patient, today }) => {
  const [state, rows] = await Promise.all([loadPatientDietState(patient.id), libraryRowsForState()]);
  res.json(dietStateDto(patient, state, rows, today));
}));

router.put("/patient-data/diet", guarded("write", "save your eating plan", async ({ req, res, patient, actor, authUserId, today, now }) => {
  const idem = await openIdempotentWrite(req, res, patient.id, "diet");
  if (idem.handled) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const dietSlug = typeof body.dietSlug === "string" ? body.dietSlug.trim() : "";
  if (!dietSlug) { res.status(400).json({ error: "Choose an eating plan.", field: "dietSlug" }); return; }
  const answers = parseAnswers(body.answers);
  if (!answers.ok) { res.status(400).json({ error: answers.error, field: answers.field }); return; }
  const settings = parseDietSettings(body.settings);
  if (!settings.ok) { res.status(400).json({ error: settings.error, field: settings.field }); return; }
  if (body.activityLevel !== undefined && body.activityLevel !== null && !parseActivityLevel(body.activityLevel)) {
    res.status(400).json({ error: ACTIVITY_LEVEL_MESSAGE, field: "activityLevel" }); return;
  }
  const result = await chooseDiet({
    patient, actor, dietSlug, answers: answers.value, settings: settings.value,
    activityLevel: parseActivityLevel(body.activityLevel), dateKey: today, now, log: req.log,
  });
  switch (result.kind) {
    case "not_found":
    case "not_selectable":
      res.status(result.kind === "not_found" ? 404 : 409).json({ error: DIET_NOT_FOUND_MESSAGE, code: result.kind === "not_found" ? "NOT_FOUND" : "NOT_SELECTABLE" });
      return;
    case "locked":
      res.status(409).json({ error: DIET_LOCKED_MESSAGE, code: "DIET_LOCKED", programDay: result.programDay });
      return;
    case "needs_answers":
      res.status(422).json({ error: SCREENING_REQUIRED_MESSAGE, code: "SCREENING_REQUIRED", questions: result.questions });
      return;
    case "pending_review":
      historyPatient(req, patient.id, authUserId, result.selection.id, "create", { list: "diet", key: dietSlug, label: "pending review", severity: null });
      await idem.finish(res, 202, {
        status: "pending_review", reason: result.reason, questions: result.questions, suggestedSlug: result.suggestedSlug,
        message: PENDING_REVIEW_MESSAGE, selection: selectionDto(result.selection), block: blockDto(result.block),
      });
      return;
    case "active":
      historyPatient(req, patient.id, authUserId, result.selection.id, "create", { list: "diet", key: dietSlug, label: result.previousSlug ?? "none", severity: null });
      await idem.finish(res, 200, { status: "active", selection: selectionDto(result.selection), previousDietSlug: result.previousSlug, oversightRecommended: result.oversightRecommended });
      return;
  }
}));

router.delete("/patient-data/diet", guarded("write", "clear your eating plan", async ({ req, res, patient, actor, authUserId, today, now }) => {
  const result = await clearDiet({ patient, actor, dateKey: today, now, log: req.log });
  if (result.previousSlug) historyPatient(req, patient.id, authUserId, `diet:${patient.id}`, "delete", { list: "diet", key: result.previousSlug, label: "cleared", severity: null });
  res.json({ ok: true, previousDietSlug: result.previousSlug });
}));

router.patch("/patient-data/diet/settings", guarded("write", "save your plan settings", async ({ req, res, patient }) => {
  const parsed = parseDietSettings(req.body);
  if (!parsed.ok) { res.status(400).json({ error: parsed.error, field: parsed.field }); return; }
  const state = await loadPatientDietState(patient.id);
  if (!state.activeSelection) { res.status(409).json({ error: "Choose an eating plan first.", code: "NO_DIET" }); return; }
  const selection = await saveDietSettings(patient.id, state, parsed.value);
  res.json({ selection: selectionDto(selection) });
}));

// ── Screening and activity ──────────────────────────────────────────────────

router.post("/patient-data/diet/screening", guarded("write", "save your answers", async ({ req, res, patient, actor, today, now }) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const parsed = parseAnswers(body.answers);
  if (!parsed.ok) { res.status(400).json({ error: parsed.error, field: parsed.field }); return; }
  if (Object.keys(parsed.value).length === 0) { res.status(400).json({ error: "Nothing to save.", field: "answers" }); return; }
  if (parsed.value.pregnancy !== undefined && patient.gender === "male") {
    res.status(400).json({ error: "That question doesn't apply to this account.", field: "answers" }); return;
  }
  const result = await recordAnswers({ patient, actor, answers: parsed.value, dateKey: today, now, log: req.log });
  res.json({ answers: result.answers, pregnancyConflict: result.pregnancyConflict, suggestedSlug: result.suggestedSlug });
}));

router.post("/patient-data/diet/activity", guarded("write", "save your activity level", async ({ req, res, patient, actor, today, now }) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const level = parseActivityLevel(body.level);
  if (!level) { res.status(400).json({ error: ACTIVITY_LEVEL_MESSAGE, field: "level" }); return; }
  // Sources mirror the patient_activity_levels CHECK: an ordinary submission is a settings change.
  const source: ActivitySource = body.source === "check_in" ? "check_in" : "settings";
  await recordActivityLevel(patient.id, level, source, actor, today, now);
  res.json({ activityLevel: { level, source, recordedOn: today } });
}));

// ── Preference lists ────────────────────────────────────────────────────────

router.get("/patient-data/diet/preferences", guarded("read", "load your food lists", async ({ res, patient }) => {
  const state = await loadPatientDietState(patient.id);
  res.json({ items: state.preferences.map(preferenceDto) });
}));

router.post("/patient-data/diet/preferences", guarded("write", "save that item", async ({ req, res, patient, actor, authUserId, now }) => {
  const parsed = parsePreferenceItem(req.body);
  if (!parsed.ok) { res.status(400).json({ error: parsed.error, field: parsed.field }); return; }
  const result = await addPreferenceItem({ patient, actor, item: parsed.value, now, log: req.log });
  if (result.kind === "duplicate") { res.status(409).json({ error: "That item is already on the list.", code: "DUPLICATE" }); return; }
  historyPatient(req, patient.id, authUserId, result.item.id, "create", { list: result.item.list, key: result.item.itemKey, label: result.item.label, severity: result.item.severity });
  res.status(201).json({ item: preferenceDto(result.item) });
}));

router.patch("/patient-data/diet/preferences/:id", guarded("write", "update that item", async ({ req, res, patient, authUserId, now }) => {
  const id = String(req.params.id ?? "");
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!ID_RE.test(id)) { res.status(404).json({ error: "That item isn't on your list." }); return; }
  if (body.severity !== "mild" && body.severity !== "severe") { res.status(400).json({ error: "Severity must be mild or severe.", field: "severity" }); return; }
  const item = await changeAllergySeverity({ patient, itemId: id, severity: body.severity, now, log: req.log });
  if (!item) { res.status(404).json({ error: "That item isn't on your list." }); return; }
  historyPatient(req, patient.id, authUserId, item.id, "update", { list: item.list, key: item.itemKey, label: item.label, severity: item.severity });
  res.json({ item: preferenceDto(item) });
}));

router.delete("/patient-data/diet/preferences/:id", guarded("write", "remove that item", async ({ req, res, patient, actor, authUserId, now }) => {
  const id = String(req.params.id ?? "");
  if (!ID_RE.test(id)) { res.status(404).json({ error: "That item isn't on your list." }); return; }
  const item = await removePreferenceItem(patient.id, id, actor, now);
  if (!item) { res.status(404).json({ error: "That item isn't on your list." }); return; }
  historyPatient(req, patient.id, authUserId, item.id, "delete", { list: item.list, key: item.itemKey, label: item.label, severity: item.severity });
  res.json({ ok: true });
}));

// ── Targets ─────────────────────────────────────────────────────────────────

router.get("/patient-data/diet/targets", guarded("read", "load your targets", async ({ req, res, patient, today, now }) => {
  const state = await loadPatientDietState(patient.id);
  const result = computePatientTargets(patient, state.episode, state.activity?.level ?? null, state.overrides, today);
  void upsertTargetSnapshot(patient.id, result, now).catch((error) => req.log?.error({ err: error }, "target snapshot write deferred"));
  res.json(targetsDto(result, state.overrides));
}));

const OVERRIDE_FIELDS: Array<{ key: "calories" | "protein" | "carbs" | "fat" | "waterOz"; column: string; max: number; label: string }> = [
  { key: "calories", column: "calories", max: 20000, label: "Calorie" },
  { key: "protein", column: "protein", max: 2000, label: "Protein" },
  { key: "carbs", column: "carbs", max: 2000, label: "Carb" },
  { key: "fat", column: "fat", max: 2000, label: "Fat" },
  { key: "waterOz", column: "water_oz", max: 200, label: "Water" },
];

router.put("/patient-data/diet/targets", guarded("write", "save your targets", async ({ req, res, patient, today, now }) => {
  const idem = await openIdempotentWrite(req, res, patient.id, "diet-targets");
  if (idem.handled) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const row: Record<string, unknown> = { patient_id: patient.id };
  for (const field of OVERRIDE_FIELDS) {
    const value = body[field.key];
    if (value === undefined) continue;
    if (value === null) { row[field.column] = null; continue; }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > field.max) {
      res.status(400).json({ error: `${field.label} target is invalid.`, field: field.key }); return;
    }
    row[field.column] = value;
  }
  if (Object.keys(row).length === 1) { res.status(400).json({ error: "Nothing to save." }); return; }
  row.updated_at = now.toISOString();
  const upsert = await supabaseAdmin("POST", "/rest/v1/patient_target_overrides?on_conflict=patient_id", [row], "resolution=merge-duplicates,return=minimal");
  if (upsert.status >= 300) throw new Error(`target override upsert failed (${upsert.status})`);
  const state = await loadPatientDietState(patient.id);
  const result = computePatientTargets(patient, state.episode, state.activity?.level ?? null, state.overrides, today);
  void upsertTargetSnapshot(patient.id, result, now).catch((error) => req.log?.error({ err: error }, "target snapshot write deferred"));
  await idem.finish(res, 200, targetsDto(result, state.overrides));
}));

export default router;
