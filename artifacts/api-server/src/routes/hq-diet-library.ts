/**
 * HQ diet library — the editable source of every diet patients can pick.
 *
 *   GET  /hq/diet-library                    → entries (all statuses) + settings
 *   GET  /hq/diet-library/:slug              → one entry + version history
 *   PUT  /hq/diet-library/:slug              { expectedVersion, ...fields, changeNote? } → 200 | 409 RECORD_CHANGED
 *   POST /hq/diet-library/:slug/review       { status: 'reviewed'|'published'|'retired'|'draft', expectedVersion }
 *   PUT  /hq/diet-library-settings           { disclaimer?, oversightNoteText? }
 *
 * Content permission throughout. Only published entries reach patients (plus
 * "just tracking", which is always selectable), so publishing is the launch
 * switch counsel and the owners sign off on. The database trigger bumps the
 * version and snapshots every change; the route only has to send the
 * expected version so two editors never overwrite each other silently.
 */
import { Router, type IRouter, type Request } from "express";
import {
  DIET_COMPLEXITIES,
  EVIDENCE_STRENGTHS,
  JUST_TRACKING_SLUG,
  REVIEW_STATUSES,
  SUPERVISION_LEVELS,
  isScreeningQuestion,
  parseFitRules,
  type ReviewStatus,
} from "@workspace/diet-programs";
import { supabaseAdmin } from "../lib/supabase-admin";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { recordAdminAuditEvent, requestIdOf } from "../lib/admin-audit";
import { LIBRARY_SELECT, loadLibraryEntry, loadLibraryRows, loadLibrarySettings, staffEntryDto, type DietLibraryRow } from "../diet/library";

const router: IRouter = Router();
const enc = encodeURIComponent;
router.use("/hq/diet-library", requireHqPermission("content_manage"));
router.use("/hq/diet-library-settings", requireHqPermission("content_manage"));

export const RECORD_CHANGED = "This entry changed since you opened it. Reload to see the latest version.";
export const ENTRY_NOT_FOUND = "No diet library entry with that slug.";
const SERVER_ERROR = "Something went wrong on our side. Please try again.";
const SLUG_RE = /^[a-z0-9_]{2,64}$/;

function actorOf(req: Request): StaffIdentity | undefined {
  return req.res?.locals.staff as StaffIdentity | undefined;
}

function audit(req: Request, action: "diet_library_updated" | "diet_library_reviewed", entry: DietLibraryRow, metadata: Record<string, string | number | boolean | null>): void {
  const actor = actorOf(req);
  void recordAdminAuditEvent({
    action, actorUserId: actor?.userId ?? null, actorKind: "hq", providerId: null,
    targetKind: "diet_library_entry", targetId: entry.id, requestId: requestIdOf(req),
    metadata: { dietSlug: entry.slug, ...metadata },
  }).catch((error) => req.log?.error({ err: error }, `${action} audit failed`));
}

type Parsed = { ok: true; patch: Record<string, unknown> } | { ok: false; error: string; field: string };

const strings = (value: unknown, max: number, each: number): string[] | null => {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const text = item.trim();
    if (!text || text.length > each) return null;
    out.push(text);
  }
  return out;
};

/** Validates an edit body into a PATCH row; unknown keys are ignored, bad values rejected. */
export function parseEntryPatch(body: Record<string, unknown>): Parsed {
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (name.length < 1 || name.length > 80) return { ok: false, error: "Name must be 1–80 characters.", field: "name" };
    patch.name = name;
  }
  if (body.summary !== undefined) {
    const summary = typeof body.summary === "string" ? body.summary.trim() : "";
    if (summary.length < 1 || summary.length > 600) return { ok: false, error: "Summary must be 1–600 characters.", field: "summary" };
    patch.summary = summary;
  }
  if (body.complexity !== undefined) {
    if (!(DIET_COMPLEXITIES as readonly unknown[]).includes(body.complexity)) return { ok: false, error: `Complexity must be ${DIET_COMPLEXITIES.join(", ")}.`, field: "complexity" };
    patch.complexity = body.complexity;
  }
  for (const [key, column, max] of [["ruleSheet", "rule_sheet", 40], ["sampleDay", "sample_day", 20], ["sources", "sources", 20]] as const) {
    if (body[key] === undefined) continue;
    const list = strings(body[key], max, 400);
    if (!list) return { ok: false, error: `${key} must be a list of up to ${max} short lines.`, field: key };
    patch[column] = list;
  }
  for (const [key, column] of [["oversightRecommended", "oversight_note"], ["pregnancyBlocked", "pregnancy_blocked"]] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return { ok: false, error: `${key} must be true or false.`, field: key };
    patch[column] = body[key];
  }
  if (body.screeningQuestions !== undefined) {
    const list = strings(body.screeningQuestions, 3, 40);
    if (!list || !list.every(isScreeningQuestion)) return { ok: false, error: "screeningQuestions must list medication, eating_disorder and/or pregnancy.", field: "screeningQuestions" };
    patch.screening_questions = [...new Set(list)];
  }
  if (body.fitRules !== undefined) {
    const rules = parseFitRules(body.fitRules);
    if (!rules) return { ok: false, error: "fitRules must be a valid rule object.", field: "fitRules" };
    patch.fit_rules = rules;
  }
  if (body.evidenceStrength !== undefined) {
    if (!(EVIDENCE_STRENGTHS as readonly unknown[]).includes(body.evidenceStrength)) return { ok: false, error: `evidenceStrength must be ${EVIDENCE_STRENGTHS.join(", ")}.`, field: "evidenceStrength" };
    patch.evidence_strength = body.evidenceStrength;
  }
  if (body.supervisionLevel !== undefined) {
    if (!(SUPERVISION_LEVELS as readonly unknown[]).includes(body.supervisionLevel)) return { ok: false, error: `supervisionLevel must be ${SUPERVISION_LEVELS.join(", ")}.`, field: "supervisionLevel" };
    patch.supervision_level = body.supervisionLevel;
  }
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== "number" || !Number.isInteger(body.sortOrder) || body.sortOrder < 0 || body.sortOrder > 10000) return { ok: false, error: "sortOrder must be a whole number.", field: "sortOrder" };
    patch.sort_order = body.sortOrder;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "Nothing to save.", field: "body" };
  return { ok: true, patch };
}

function expectedVersionOf(body: Record<string, unknown>): number | null {
  const value = body.expectedVersion;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

async function versionsOf(entryId: string) {
  const res = await supabaseAdmin("GET", `/rest/v1/diet_library_versions?entry_id=eq.${enc(entryId)}&select=version,changed_by,change_note,created_at&order=version.desc&limit=100`);
  if (res.status >= 300) throw new Error(`diet library versions read failed (${res.status})`);
  return (Array.isArray(res.json) ? res.json : []) as Array<Record<string, unknown>>;
}

/** PATCH guarded by the version the editor saw; 0 rows → changed or missing. */
async function patchVersioned(slug: string, expectedVersion: number, patch: Record<string, unknown>): Promise<DietLibraryRow | null> {
  const res = await supabaseAdmin("PATCH", `/rest/v1/diet_library_entries?slug=eq.${enc(slug)}&version=eq.${expectedVersion}&select=${LIBRARY_SELECT}`, patch, "return=representation");
  if (res.status >= 300) throw new Error(`diet library update failed (${res.status})`);
  return (Array.isArray(res.json) ? (res.json[0] as DietLibraryRow | undefined) : undefined) ?? null;
}

router.get("/hq/diet-library", async (req, res) => {
  try {
    const [rows, settings] = await Promise.all([loadLibraryRows(), loadLibrarySettings()]);
    res.json({ settings, entries: rows.map((row) => staffEntryDto(row, settings.oversightNoteText)) });
  } catch (error) {
    req.log?.error({ err: error }, "hq diet library list failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.get("/hq/diet-library/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug ?? "");
    const [entry, settings] = await Promise.all([SLUG_RE.test(slug) ? loadLibraryEntry(slug) : null, loadLibrarySettings()]);
    if (!entry) { res.status(404).json({ error: ENTRY_NOT_FOUND }); return; }
    res.json({ entry: staffEntryDto(entry, settings.oversightNoteText), versions: await versionsOf(entry.id) });
  } catch (error) {
    req.log?.error({ err: error }, "hq diet library read failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.put("/hq/diet-library/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug ?? "");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const expectedVersion = expectedVersionOf(body);
    if (!expectedVersion) { res.status(400).json({ error: "expectedVersion is required.", field: "expectedVersion" }); return; }
    const parsed = parseEntryPatch(body);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error, field: parsed.field }); return; }
    const current = SLUG_RE.test(slug) ? await loadLibraryEntry(slug) : null;
    if (!current) { res.status(404).json({ error: ENTRY_NOT_FOUND }); return; }
    if (current.version !== expectedVersion) { res.status(409).json({ error: RECORD_CHANGED, code: "RECORD_CHANGED", version: current.version }); return; }
    const actor = actorOf(req);
    // A content edit to a published entry sends it back for review.
    const patch = { ...parsed.patch, updated_by: actor?.userId ?? null };
    if (current.review_status !== "draft" && slug !== JUST_TRACKING_SLUG) Object.assign(patch, { review_status: "draft", reviewed_by: null, reviewed_at: null });
    const updated = await patchVersioned(slug, expectedVersion, patch);
    if (!updated) { res.status(409).json({ error: RECORD_CHANGED, code: "RECORD_CHANGED" }); return; }
    audit(req, "diet_library_updated", updated, { reviewStatus: updated.review_status });
    const settings = await loadLibrarySettings();
    res.json({ entry: staffEntryDto(updated, settings.oversightNoteText), unpublished: current.review_status === "published" && updated.review_status !== "published" });
  } catch (error) {
    req.log?.error({ err: error }, "hq diet library update failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.post("/hq/diet-library/:slug/review", async (req, res) => {
  try {
    const slug = String(req.params.slug ?? "");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const expectedVersion = expectedVersionOf(body);
    if (!expectedVersion) { res.status(400).json({ error: "expectedVersion is required.", field: "expectedVersion" }); return; }
    if (!(REVIEW_STATUSES as readonly unknown[]).includes(body.status)) { res.status(400).json({ error: `status must be ${REVIEW_STATUSES.join(", ")}.`, field: "status" }); return; }
    const status = body.status as ReviewStatus;
    const current = SLUG_RE.test(slug) ? await loadLibraryEntry(slug) : null;
    if (!current) { res.status(404).json({ error: ENTRY_NOT_FOUND }); return; }
    if (current.version !== expectedVersion) { res.status(409).json({ error: RECORD_CHANGED, code: "RECORD_CHANGED", version: current.version }); return; }
    if (status === "published" && current.review_status !== "reviewed") {
      res.status(409).json({ error: "Mark the entry reviewed before publishing it.", code: "NOT_REVIEWED" }); return;
    }
    if (status === current.review_status) { res.status(409).json({ error: `This entry is already ${status}.`, code: "NO_CHANGE" }); return; }
    const actor = actorOf(req);
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { review_status: status, updated_by: actor?.userId ?? null };
    if (status === "reviewed") Object.assign(patch, { reviewed_by: actor?.userId ?? null, reviewed_at: now });
    if (status === "draft") Object.assign(patch, { reviewed_by: null, reviewed_at: null });
    const updated = await patchVersioned(slug, expectedVersion, patch);
    if (!updated) { res.status(409).json({ error: RECORD_CHANGED, code: "RECORD_CHANGED" }); return; }
    audit(req, "diet_library_reviewed", updated, { reviewStatus: status, previousReviewStatus: current.review_status });
    const settings = await loadLibrarySettings();
    res.json({ entry: staffEntryDto(updated, settings.oversightNoteText) });
  } catch (error) {
    req.log?.error({ err: error }, "hq diet library review failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.put("/hq/diet-library-settings", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [key, column] of [["disclaimer", "disclaimer"], ["oversightNoteText", "oversight_note_text"]] as const) {
      if (body[key] === undefined) continue;
      const text = typeof body[key] === "string" ? (body[key] as string).trim() : "";
      if (text.length < 1 || text.length > 2000) { res.status(400).json({ error: `${key} must be 1–2000 characters.`, field: key }); return; }
      patch[column] = text;
    }
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: "Nothing to save.", field: "body" }); return; }
    patch.updated_by = actorOf(req)?.userId ?? null;
    patch.updated_at = new Date().toISOString();
    const result = await supabaseAdmin("PATCH", "/rest/v1/diet_library_settings?singleton=eq.true", patch, "return=minimal");
    if (result.status >= 300) throw new Error(`diet library settings update failed (${result.status})`);
    res.json({ settings: await loadLibrarySettings() });
  } catch (error) {
    req.log?.error({ err: error }, "hq diet library settings failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

export default router;
