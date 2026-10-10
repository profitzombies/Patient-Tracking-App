/**
 * Office view and control of one patient's diet program.
 *
 *   GET  /office/patients/:id/diet                      → state + histories (read is audited)
 *   PUT  /office/patients/:id/diet                      { dietSlug, answers?, settings?, note? }
 *   DELETE /office/patients/:id/diet                    → back to "no diet"
 *   POST /office/patients/:id/diet/blocks/:blockId/override      → step one: challenge
 *   POST /office/patients/:id/diet/blocks/:blockId/override/confirm { challenge, note? } → step two
 *   POST /office/patients/:id/diet/blocks/:blockId/reject        { note? }
 *   POST /office/patients/:id/protocol/restart          { startedOn?, note? }
 *   POST /office/patients/:id/diet/preferences          { list, key?, label?, severity? }
 *   DELETE /office/patients/:id/diet/preferences/:itemId
 *
 * Same scope rules as the other office patient edits: provider_manage, the
 * office's own patients only (HQ names one via ?office=), sealed charts are
 * read-only (409), merged duplicates are unknown (404). Every write lands in
 * the audit ledger and the diet edit-history family; the two-step override is
 * the owner's "Are you sure you want to do this?" confirmation and records
 * who did it and when.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { supabaseAdmin } from "../lib/supabase-admin";
import { resolveOfficeScope, respondOfficeScopeDenied, type OfficeScope, type OfficeScopeDenied } from "../auth/office-scope";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { auditRecordAccess } from "../lib/record-access-audit";
import { changedFields, recordPatientEditHistory, snapshotFields, type EditHistoryChangeKind } from "../lib/patient-edit-history";
import { dayKeyInTimeZone } from "../lib/local-day";
import { RECORD_NOT_FOUND, RECORD_SEALED, SERVER_ERROR } from "./office-roster";
import { loadLibrarySettings, loadLibraryRows, staffEntryDto } from "../diet/library";
import {
  listActivityHistory,
  listBlockHistory,
  listEpisodes,
  listSelectionHistory,
  loadPatientDietState,
  restartProtocolEpisode,
  type DietActor,
} from "../diet/store";
import { computePatientTargets, loadTargetSnapshots, targetsDto } from "../diet/targets";
import {
  addPreferenceItem,
  blockDto,
  chooseDiet,
  clearDiet,
  confirmOverride,
  dietStateDto,
  parseAnswers,
  parseDietSettings,
  parsePreferenceItem,
  preferenceDto,
  rejectBlock,
  removePreferenceItem,
  selectionDto,
  startOverride,
  type DietPatient,
} from "../diet/service";
import { DIET_PATIENT_SELECT, DIET_LOCKED_MESSAGE, DIET_NOT_FOUND_MESSAGE, SCREENING_REQUIRED_MESSAGE } from "./patient-diet";

const router: IRouter = Router();
const enc = encodeURIComponent;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFERENCE_HISTORY_KEYS = ["list", "key", "label", "severity"] as const;

export const NOT_OVERRIDABLE_MESSAGE = "This plan is blocked during pregnancy or breastfeeding and cannot be overridden. Decline it and suggest the fertility / pregnancy plan instead.";
export const DIET_UNAVAILABLE_MESSAGE = "This plan is no longer available to patients, so the block cannot be overridden. Decline it instead.";
const NOT_OVERRIDABLE_MESSAGES = { pregnancy: NOT_OVERRIDABLE_MESSAGE, diet_unavailable: DIET_UNAVAILABLE_MESSAGE } as const;
export const OVERRIDE_CHALLENGE_MESSAGE = "Start the override again — that confirmation didn't match or has expired.";
export const BLOCK_NOT_FOUND_MESSAGE = "There is no pending safety review for this patient.";

type OfficeDietPatient = DietPatient & { closed_at?: string | null; archived_at?: string | null };
type Scoped =
  | { kind: "ok"; scope: OfficeScope; patient: OfficeDietPatient }
  | { kind: "denied"; status: number; message: string; denial?: OfficeScopeDenied };

function respondScoped(req: Request, res: Response, scoped: Extract<Scoped, { kind: "denied" }>): void {
  if (scoped.denial) { respondOfficeScopeDenied(req, res, scoped.denial); return; }
  res.status(scoped.status).json({ error: scoped.message });
}

async function scopedPatient(req: Request): Promise<Scoped> {
  const bodyOffice = req.body && typeof req.body === "object" && typeof (req.body as { office?: unknown }).office === "string"
    ? String((req.body as { office: string }).office) : null;
  const resolved = await resolveOfficeScope({
    authorization: req.headers.authorization,
    request: req,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : bodyOffice,
    hqPermission: "provider_manage",
    requireUnlocked: true,
  });
  if (resolved.kind !== "ok") return { kind: "denied", status: resolved.status, message: resolved.message, denial: resolved };
  const patientId = String(req.params.id ?? "");
  const found = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(resolved.scope.providerId)}&select=${DIET_PATIENT_SELECT},closed_at,archived_at&limit=1`,
  );
  if (found.status >= 300) throw new Error(`patient record lookup failed (${found.status})`);
  const patient = Array.isArray(found.json) ? (found.json[0] as OfficeDietPatient | undefined) : undefined;
  if (!patient) return { kind: "denied", status: 404, message: RECORD_NOT_FOUND };
  if (patient.closed_at) return { kind: "denied", status: 409, message: RECORD_SEALED };
  if (patient.archived_at) return { kind: "denied", status: 404, message: RECORD_NOT_FOUND };
  return { kind: "ok", scope: resolved.scope, patient };
}

async function actorDisplayName(scope: OfficeScope): Promise<string> {
  if (scope.actorKind === "provider") return scope.providerName;
  const path = scope.actorKind === "team_member"
    ? `/rest/v1/team_members?auth_user_id=eq.${enc(scope.actorUserId)}&select=name&limit=1`
    : `/rest/v1/hq_memberships?auth_user_id=eq.${enc(scope.actorUserId)}&status=eq.active&select=display_name&limit=1`;
  const res = await supabaseAdmin("GET", path);
  const row = res.status < 300 && Array.isArray(res.json) ? (res.json[0] as Record<string, unknown> | undefined) : undefined;
  const name = String(row?.name ?? row?.display_name ?? "").trim();
  if (name) return name.slice(0, 160);
  return scope.actorKind === "team_member" ? `${scope.officeName} staff` : "THINNR HQ";
}

async function staffActor(scope: OfficeScope): Promise<DietActor> {
  return { role: "staff", userId: scope.actorUserId, name: await actorDisplayName(scope) };
}

type AuditMeta = Record<string, string | number | boolean | null>;
function audit(req: Request, scope: OfficeScope, action: string, patientId: string, metadata: AuditMeta): Promise<number | null> {
  return recordAdminAuditEvent({
    action, actorUserId: scope.actorUserId, actorKind: scope.actorKind, providerId: scope.providerId,
    targetKind: "patient", targetId: patientId, requestId: req.headers["x-request-id"]?.toString() ?? null, metadata,
  }).catch((error) => { req.log?.error({ err: error }, `${action} audit failed`); return null; });
}

/** Audit + diet edit history, in that order (history rows carry the audit id). Best-effort. */
async function auditWithHistory(req: Request, scope: OfficeScope, actor: DietActor, action: string, patientId: string, metadata: AuditMeta, change: { recordId: string; changeKind: EditHistoryChangeKind; values: Record<string, unknown> }): Promise<void> {
  const auditEventId = await audit(req, scope, action, patientId, metadata);
  try {
    await recordPatientEditHistory({
      patientId, family: "diet", recordId: change.recordId, changeKind: change.changeKind,
      actorKind: scope.actorKind, actorUserId: scope.actorUserId, actorName: actor.name, auditEventId,
      fields: change.changeKind === "update" ? changedFields({}, change.values, PREFERENCE_HISTORY_KEYS) : snapshotFields(change.values, PREFERENCE_HISTORY_KEYS, change.changeKind),
    });
  } catch (error) {
    req.log?.error({ err: error }, `${action} history failed`);
  }
}

function todayFor(patient: DietPatient): string {
  return dayKeyInTimeZone(typeof patient.timezone === "string" ? patient.timezone : null);
}

function fail(req: Request, res: Response, label: string, error: unknown): void {
  req.log?.error({ err: error }, `office diet ${label} failed`);
  if (!res.headersSent) res.status(502).json({ error: SERVER_ERROR });
}

function noteOf(body: Record<string, unknown>): string | null {
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  return note || null;
}

// ── Read ────────────────────────────────────────────────────────────────────

router.get("/office/patients/:id/diet", async (req, res) => {
  try {
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { respondScoped(req, res, scoped); return; }
    const { patient, scope } = scoped;
    const today = todayFor(patient);
    const [state, rows, settings, selections, blocks, episodes, activity, snapshots] = await Promise.all([
      loadPatientDietState(patient.id), loadLibraryRows(), loadLibrarySettings(),
      listSelectionHistory(patient.id), listBlockHistory(patient.id), listEpisodes(patient.id), listActivityHistory(patient.id), loadTargetSnapshots(patient.id, 14),
    ]);
    auditRecordAccess(req, {
      action: "patient_diet_viewed", actorUserId: scope.actorUserId, actorKind: scope.actorKind,
      providerId: scope.providerId, targetKind: "patient", targetId: String(patient.id),
    });
    const targets = computePatientTargets(patient, state.episode, state.activity?.level ?? null, state.overrides, today);
    res.json({
      ...dietStateDto(patient, state, rows, today),
      targets: targetsDto(targets, state.overrides),
      history: {
        selections: selections.map((s) => selectionDto(s)),
        blocks: blocks.map((b) => blockDto(b)),
        episodes,
        activity,
        targetSnapshots: snapshots,
      },
      library: rows.map((row) => staffEntryDto(row, settings.oversightNoteText)),
    });
  } catch (error) {
    fail(req, res, "read", error);
  }
});

// ── Set / clear ─────────────────────────────────────────────────────────────

router.put("/office/patients/:id/diet", async (req, res) => {
  try {
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { respondScoped(req, res, scoped); return; }
    const { patient, scope } = scoped;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dietSlug = typeof body.dietSlug === "string" ? body.dietSlug.trim() : "";
    if (!dietSlug) { res.status(400).json({ error: "Choose an eating plan.", field: "dietSlug" }); return; }
    const answers = parseAnswers(body.answers);
    if (!answers.ok) { res.status(400).json({ error: answers.error, field: answers.field }); return; }
    const settings = parseDietSettings(body.settings);
    if (!settings.ok) { res.status(400).json({ error: settings.error, field: settings.field }); return; }
    const actor = await staffActor(scope);
    const today = todayFor(patient);
    const result = await chooseDiet({ patient, actor, dietSlug, answers: answers.value, settings: settings.value, activityLevel: null, dateKey: today, now: new Date(), log: req.log });
    switch (result.kind) {
      case "not_found":
        res.status(404).json({ error: DIET_NOT_FOUND_MESSAGE, code: "NOT_FOUND" }); return;
      case "not_selectable":
        res.status(409).json({ error: "That eating plan isn't published for patients yet.", code: "NOT_SELECTABLE" }); return;
      case "locked":
        res.status(409).json({ error: DIET_LOCKED_MESSAGE, code: "DIET_LOCKED", programDay: result.programDay }); return;
      case "needs_answers":
        res.status(422).json({ error: SCREENING_REQUIRED_MESSAGE, code: "SCREENING_REQUIRED", questions: result.questions }); return;
      case "pending_review":
        await auditWithHistory(req, scope, actor, "patient_diet_set", patient.id, { dietSlug, selectionId: result.selection.id, blockId: result.block.id, reviewStatus: "pending_review" },
          { recordId: result.selection.id, changeKind: "create", values: { list: "diet", key: dietSlug, label: "pending review", severity: null } });
        res.status(202).json({ status: "pending_review", reason: result.reason, questions: result.questions, suggestedSlug: result.suggestedSlug, selection: selectionDto(result.selection), block: blockDto(result.block) });
        return;
      case "active":
        await auditWithHistory(req, scope, actor, "patient_diet_set", patient.id, { dietSlug, previousDietSlug: result.previousSlug, selectionId: result.selection.id, reviewStatus: "active" },
          { recordId: result.selection.id, changeKind: "create", values: { list: "diet", key: dietSlug, label: result.previousSlug ?? "none", severity: null } });
        res.json({ status: "active", selection: selectionDto(result.selection), previousDietSlug: result.previousSlug, oversightRecommended: result.oversightRecommended });
        return;
    }
  } catch (error) {
    fail(req, res, "set", error);
  }
});

router.delete("/office/patients/:id/diet", async (req, res) => {
  try {
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { respondScoped(req, res, scoped); return; }
    const { patient, scope } = scoped;
    const actor = await staffActor(scope);
    const result = await clearDiet({ patient, actor, dateKey: todayFor(patient), now: new Date(), log: req.log });
    if (result.previousSlug) {
      await auditWithHistory(req, scope, actor, "patient_diet_cleared", patient.id, { previousDietSlug: result.previousSlug },
        { recordId: `diet:${patient.id}`, changeKind: "delete", values: { list: "diet", key: result.previousSlug, label: "cleared", severity: null } });
    }
    res.json({ ok: true, previousDietSlug: result.previousSlug });
  } catch (error) {
    fail(req, res, "clear", error);
  }
});

// ── Safety block review ─────────────────────────────────────────────────────

router.post("/office/patients/:id/diet/blocks/:blockId/override", async (req, res) => {
  try {
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { respondScoped(req, res, scoped); return; }
    const { patient, scope } = scoped;
    const blockId = String(req.params.blockId ?? "");
    const actor = await staffActor(scope);
    const state = await loadPatientDietState(patient.id);
    const result = await startOverride({ patientId: patient.id, blockId, state, actor, now: new Date() });
    if (result.kind === "not_found") { res.status(404).json({ error: BLOCK_NOT_FOUND_MESSAGE }); return; }
    if (result.kind === "not_overridable") { res.status(409).json({ error: NOT_OVERRIDABLE_MESSAGES[result.reason], code: "NOT_OVERRIDABLE", reason: result.reason, block: blockDto(result.block) }); return; }
    await audit(req, scope, "patient_diet_block_override_started", patient.id, { blockId, dietSlug: result.block.dietSlug });
    res.json({ challenge: result.challenge, confirmText: result.confirmText, expiresAt: result.expiresAt, block: blockDto(result.block) });
  } catch (error) {
    fail(req, res, "override start", error);
  }
});

router.post("/office/patients/:id/diet/blocks/:blockId/override/confirm", async (req, res) => {
  try {
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { respondScoped(req, res, scoped); return; }
    const { patient, scope } = scoped;
    const blockId = String(req.params.blockId ?? "");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const challenge = typeof body.challenge === "string" ? body.challenge.trim() : "";
    if (!challenge) { res.status(400).json({ error: "Confirm the override first.", field: "challenge" }); return; }
    const actor = await staffActor(scope);
    const state = await loadPatientDietState(patient.id);
    const result = await confirmOverride({ patient, blockId, challenge, note: noteOf(body), state, actor, dateKey: todayFor(patient), now: new Date(), log: req.log });
    if (result.kind === "not_found") { res.status(404).json({ error: BLOCK_NOT_FOUND_MESSAGE }); return; }
    if (result.kind === "not_overridable") { res.status(409).json({ error: NOT_OVERRIDABLE_MESSAGES[result.reason], code: "NOT_OVERRIDABLE", reason: result.reason, block: blockDto(result.block) }); return; }
    if (result.kind === "challenge_mismatch" || result.kind === "challenge_expired") {
      res.status(409).json({ error: OVERRIDE_CHALLENGE_MESSAGE, code: result.kind === "challenge_expired" ? "CHALLENGE_EXPIRED" : "CHALLENGE_MISMATCH" });
      return;
    }
    await auditWithHistory(req, scope, actor, "patient_diet_block_overridden", patient.id, { blockId, selectionId: result.selection.id, dietSlug: result.selection.dietSlug, previousDietSlug: result.previousSlug },
      { recordId: result.selection.id, changeKind: "update", values: { list: "diet", key: result.selection.dietSlug, label: "override approved", severity: null } });
    res.json({ status: "active", block: blockDto(result.block), selection: selectionDto(result.selection), previousDietSlug: result.previousSlug });
  } catch (error) {
    fail(req, res, "override confirm", error);
  }
});

router.post("/office/patients/:id/diet/blocks/:blockId/reject", async (req, res) => {
  try {
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { respondScoped(req, res, scoped); return; }
    const { patient, scope } = scoped;
    const blockId = String(req.params.blockId ?? "");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actor = await staffActor(scope);
    const state = await loadPatientDietState(patient.id);
    const result = await rejectBlock({ patientId: patient.id, blockId, note: noteOf(body), state, actor, now: new Date() });
    if (result.kind === "not_found") { res.status(404).json({ error: BLOCK_NOT_FOUND_MESSAGE }); return; }
    await audit(req, scope, "patient_diet_block_rejected", patient.id, { blockId, dietSlug: result.block.dietSlug });
    res.json({ status: "rejected", block: blockDto(result.block) });
  } catch (error) {
    fail(req, res, "block reject", error);
  }
});

// ── Protocol restart ────────────────────────────────────────────────────────

router.post("/office/patients/:id/protocol/restart", async (req, res) => {
  try {
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { respondScoped(req, res, scoped); return; }
    const { patient, scope } = scoped;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const today = todayFor(patient);
    const startedOn = body.startedOn === undefined || body.startedOn === null ? today : String(body.startedOn);
    if (!DATE_KEY_RE.test(startedOn) || Number.isNaN(Date.parse(`${startedOn}T00:00:00Z`))) {
      res.status(400).json({ error: "Start date must be YYYY-MM-DD.", field: "startedOn" }); return;
    }
    if (startedOn > today) { res.status(400).json({ error: "The restart date can't be in the future.", field: "startedOn" }); return; }
    const actor = await staffActor(scope);
    const before = await loadPatientDietState(patient.id);
    const episode = await restartProtocolEpisode(patient.id, startedOn, actor, noteOf(body));
    await auditWithHistory(req, scope, actor, "patient_protocol_restarted", patient.id, { episodeId: episode.id, episodeNumber: episode.episodeNumber, startedOn, previousDietSlug: before.activeSelection?.dietSlug ?? null },
      { recordId: episode.id, changeKind: "create", values: { list: "protocol", key: `episode:${episode.episodeNumber}`, label: startedOn, severity: null } });
    const state = await loadPatientDietState(patient.id);
    const rows = await loadLibraryRows();
    res.json({ episode, state: dietStateDto({ ...patient, program_start_date: startedOn }, state, rows, today) });
  } catch (error) {
    fail(req, res, "protocol restart", error);
  }
});

// ── Preference lists on behalf of the patient ───────────────────────────────

router.post("/office/patients/:id/diet/preferences", async (req, res) => {
  try {
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { respondScoped(req, res, scoped); return; }
    const { patient, scope } = scoped;
    const parsed = parsePreferenceItem(req.body);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error, field: parsed.field }); return; }
    const actor = await staffActor(scope);
    const result = await addPreferenceItem({ patient, actor, item: parsed.value, now: new Date(), log: req.log });
    if (result.kind === "duplicate") { res.status(409).json({ error: "That item is already on the list.", code: "DUPLICATE" }); return; }
    await auditWithHistory(req, scope, actor, "patient_preference_item_added", patient.id, { list: result.item.list, itemKey: result.item.itemKey, severity: result.item.severity },
      { recordId: result.item.id, changeKind: "create", values: { list: result.item.list, key: result.item.itemKey, label: result.item.label, severity: result.item.severity } });
    res.status(201).json({ item: preferenceDto(result.item) });
  } catch (error) {
    fail(req, res, "preference add", error);
  }
});

router.delete("/office/patients/:id/diet/preferences/:itemId", async (req, res) => {
  try {
    const scoped = await scopedPatient(req);
    if (scoped.kind !== "ok") { respondScoped(req, res, scoped); return; }
    const { patient, scope } = scoped;
    const itemId = String(req.params.itemId ?? "");
    if (!ID_RE.test(itemId)) { res.status(404).json({ error: "That item isn't on the list." }); return; }
    const actor = await staffActor(scope);
    const item = await removePreferenceItem(patient.id, itemId, actor, new Date());
    if (!item) { res.status(404).json({ error: "That item isn't on the list." }); return; }
    await auditWithHistory(req, scope, actor, "patient_preference_item_removed", patient.id, { list: item.list, itemKey: item.itemKey, severity: item.severity },
      { recordId: item.id, changeKind: "delete", values: { list: item.list, key: item.itemKey, label: item.label, severity: item.severity } });
    res.json({ ok: true });
  } catch (error) {
    fail(req, res, "preference remove", error);
  }
});

export default router;
