import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), audit: vi.fn(), scope: vi.fn(), access: vi.fn(), history: vi.fn(),
  loadState: vi.fn(), restart: vi.fn(), removePreference: vi.fn(),
  chooseDiet: vi.fn(), clearDiet: vi.fn(), startOverride: vi.fn(), confirmOverride: vi.fn(), rejectBlock: vi.fn(), addPreferenceItem: vi.fn(),
  libraryRows: vi.fn(), librarySettings: vi.fn(),
}));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../auth/office-scope", async () => {
  const actual = await vi.importActual<typeof import("../auth/office-scope")>("../auth/office-scope");
  return { ...actual, resolveOfficeScope: mocks.scope };
});
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: mocks.audit, recordAccessDenied: vi.fn(), requestIdOf: () => null }));
vi.mock("../lib/record-access-audit", () => ({ auditRecordAccess: mocks.access }));
vi.mock("../lib/patient-edit-history", async () => {
  const actual = await vi.importActual<typeof import("../lib/patient-edit-history")>("../lib/patient-edit-history");
  return { ...actual, recordPatientEditHistory: mocks.history };
});
vi.mock("../diet/library", async () => {
  const actual = await vi.importActual<typeof import("../diet/library")>("../diet/library");
  return { ...actual, loadLibraryRows: mocks.libraryRows, loadLibrarySettings: mocks.librarySettings, loadLibraryEntry: vi.fn() };
});
vi.mock("../diet/store", async () => {
  const actual = await vi.importActual<typeof import("../diet/store")>("../diet/store");
  return {
    ...actual, loadPatientDietState: mocks.loadState, restartProtocolEpisode: mocks.restart,
    listSelectionHistory: vi.fn(async () => []), listBlockHistory: vi.fn(async () => []), listEpisodes: vi.fn(async () => []), listActivityHistory: vi.fn(async () => []),
  };
});
vi.mock("../diet/targets", async () => {
  const actual = await vi.importActual<typeof import("../diet/targets")>("../diet/targets");
  return { ...actual, loadTargetSnapshots: vi.fn(async () => []), upsertTargetSnapshot: vi.fn() };
});
vi.mock("../diet/service", async () => {
  const actual = await vi.importActual<typeof import("../diet/service")>("../diet/service");
  return {
    ...actual, chooseDiet: mocks.chooseDiet, clearDiet: mocks.clearDiet, startOverride: mocks.startOverride, confirmOverride: mocks.confirmOverride,
    rejectBlock: mocks.rejectBlock, addPreferenceItem: mocks.addPreferenceItem, removePreferenceItem: mocks.removePreference,
  };
});
import router from "./office-patient-diet";
import type { BlockRecord, PatientDietState, SelectionRecord } from "../diet/store";

type Row = Record<string, unknown>;
let server: http.Server; let base = "";
beforeAll(async () => { const app = express(); app.use(express.json()); app.use(router); await new Promise<void>(r => { server = app.listen(0, () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());

const PAT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BLOCK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ownerScope = { kind: "ok", scope: { providerId: "p1", providerName: "Dr. One", officeName: "One", actorUserId: "a1", actorKind: "provider", officeRole: "owner" } };
const staffScope = { kind: "ok", scope: { providerId: "p1", providerName: "Dr. One", officeName: "One", actorUserId: "t1", actorKind: "team_member", officeRole: "staff" } };
const lockedDenied = { kind: "denied", status: 403, message: "This office is locked.", reason: "office_locked", actorUserId: "t1", providerId: "p1" };

const patientRow: Row = {
  id: PAT, provider_id: "p1", timezone: "America/Chicago", gender: "female", date_of_birth: "1986-05-01", height_inches: 65, current_weight: 180, goal_weight: 150,
  program_id: "thinnr", program_start_date: "2026-08-01", created_at: "2026-08-01T00:00:00Z", closed_at: null, archived_at: null,
};
let patients: Row[] = [];

const selection = (over: Partial<SelectionRecord> = {}): SelectionRecord => ({
  id: "sel-1", dietSlug: "mediterranean", status: "active", selectedByRole: "staff", settings: {}, screeningSnapshot: {}, startedAt: "2026-10-09T00:00:00Z", endedAt: null, coachAcknowledgedAt: null, ...over,
});
const block = (over: Partial<BlockRecord> = {}): BlockRecord => ({
  id: BLOCK, selectionId: "sel-2", dietSlug: "keto", questions: ["medication"], status: "pending", overrideChallenge: null, overrideChallengedAt: null, overrideChallengedBy: null,
  reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: null, createdAt: "2026-10-09T00:00:00Z", ...over,
});
const emptyState = (over: Partial<PatientDietState> = {}): PatientDietState => ({
  episode: { id: "ep-1", episodeNumber: 1, startedOn: "2026-08-01", endedOn: null, reason: "enrollment", startedByRole: "system", note: null, createdAt: "2026-08-01T00:00:00Z" },
  activeSelection: null, pendingSelection: null, pendingBlock: null, answers: {}, answerHistory: [], preferences: [], activity: null,
  overrides: { calories: null, protein: null, carbs: null, fat: null, waterOz: null }, ...over,
});

function response(json: unknown, status = 200) { return { status, json, contentRange: null }; }
const json = async (res: Response): Promise<any> => res.json();
async function call(path: string, method = "GET", body?: unknown) {
  return fetch(base + path, { method, headers: { "content-type": "application/json", authorization: "Bearer staff", "x-request-id": "req-1" }, body: body ? JSON.stringify(body) : undefined });
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.audit.mockResolvedValue(77);
  mocks.history.mockResolvedValue(undefined);
  mocks.scope.mockResolvedValue(ownerScope);
  mocks.loadState.mockResolvedValue(emptyState());
  mocks.libraryRows.mockResolvedValue([
    { id: "l1", slug: "just_tracking", name: "Just tracking", summary: "s", complexity: "simple", rule_sheet: [], sample_day: [], oversight_note: false, pregnancy_blocked: false, screening_questions: [], fit_rules: { mode: "exclude", excludeTags: [] }, evidence_strength: "n_a", supervision_level: "none", sources: [], review_status: "published", reviewed_by: null, reviewed_at: null, published_at: null, sort_order: 0, version: 1, updated_by: null, created_at: "", updated_at: "" },
  ]);
  mocks.librarySettings.mockResolvedValue({ disclaimer: "D", oversightNoteText: "O" });
  patients = [{ ...patientRow }];
  mocks.admin.mockImplementation(async (method: string, path: string) => {
    const url = new URL(`http://x${path}`);
    const table = url.pathname.replace("/rest/v1/", "");
    if (method === "GET" && table === "patients") {
      const id = url.searchParams.get("id")!.slice(3); const provider = url.searchParams.get("provider_id")!.slice(3);
      return response(patients.filter((p) => p.id === id && p.provider_id === provider));
    }
    if (method === "GET" && table === "team_members") return response([{ name: "Tess Staff" }]);
    throw new Error(`unexpected ${method} ${path}`);
  });
});

describe("office patient diet routes — scope and record gates", () => {
  it("passes the office-scope denial through (locked office → 403)", async () => {
    mocks.scope.mockResolvedValue(lockedDenied);
    const res = await call(`/office/patients/${PAT}/diet`);
    expect(res.status).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("resolves scope with provider_manage for HQ and the unlocked requirement", async () => {
    await call(`/office/patients/${PAT}/diet?office=p1`);
    expect(mocks.scope).toHaveBeenCalledWith(expect.objectContaining({ explicitOfficeId: "p1", hqPermission: "provider_manage", requireUnlocked: true }));
  });

  it("404s a patient of another office or an archived record, 409s a sealed one", async () => {
    patients = [{ ...patientRow, provider_id: "p2" }];
    expect((await call(`/office/patients/${PAT}/diet`)).status).toBe(404);
    patients = [{ ...patientRow, archived_at: "2026-09-01T00:00:00Z" }];
    expect((await call(`/office/patients/${PAT}/diet`)).status).toBe(404);
    patients = [{ ...patientRow, closed_at: "2026-09-01T00:00:00Z" }];
    const sealed = await call(`/office/patients/${PAT}/diet`, "PUT", { dietSlug: "keto" });
    expect(sealed.status).toBe(409);
    expect(mocks.chooseDiet).not.toHaveBeenCalled();
  });

  it("returns 502 when the patient lookup fails upstream", async () => {
    mocks.admin.mockResolvedValue(response({ message: "down" }, 500));
    expect((await call(`/office/patients/${PAT}/diet`)).status).toBe(502);
  });
});

describe("office patient diet routes — read", () => {
  it("returns state, targets, history and the staff library, and records the access", async () => {
    mocks.loadState.mockResolvedValue(emptyState({ activeSelection: selection(), activity: { level: "light", source: "check_in", recordedOn: "2026-10-08", createdAt: "" } }));
    const res = await call(`/office/patients/${PAT}/diet`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.currentDiet.dietSlug).toBe("mediterranean");
    expect(body.phase).toMatchObject({ phase: "maintenance", episodeNumber: 1, episodeStartedOn: "2026-08-01", dietPickerLocked: false });
    expect(body.effectiveDietSlug).toBe("mediterranean");
    expect(body.targets).toMatchObject({ phase: "maintenance", activityLevel: "light" });
    expect(body.targets.effective.calories).toBeGreaterThan(0);
    expect(body.history).toEqual({ selections: [], blocks: [], episodes: [], activity: [], targetSnapshots: [] });
    expect(body.library[0]).toMatchObject({ slug: "just_tracking", reviewStatus: "published" });
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "patient_diet_viewed", actorUserId: "a1", providerId: "p1", targetId: PAT }));
  });
});

describe("office patient diet routes — set and clear", () => {
  it("validates the body before touching the service", async () => {
    expect((await call(`/office/patients/${PAT}/diet`, "PUT", {})).status).toBe(400);
    const badAnswer = await call(`/office/patients/${PAT}/diet`, "PUT", { dietSlug: "keto", answers: { medication: "maybe" } });
    expect(badAnswer.status).toBe(400);
    expect(mocks.chooseDiet).not.toHaveBeenCalled();
  });

  it("maps every service outcome to its status and code", async () => {
    const cases: Array<[Row, number, Row]> = [
      [{ kind: "not_found" }, 404, { code: "NOT_FOUND" }],
      [{ kind: "not_selectable" }, 409, { code: "NOT_SELECTABLE" }],
      [{ kind: "locked", programDay: 12 }, 409, { code: "DIET_LOCKED", programDay: 12 }],
      [{ kind: "needs_answers", questions: ["medication"] }, 422, { code: "SCREENING_REQUIRED", questions: ["medication"] }],
    ];
    for (const [result, status, expected] of cases) {
      mocks.chooseDiet.mockResolvedValueOnce(result);
      const res = await call(`/office/patients/${PAT}/diet`, "PUT", { dietSlug: "keto" });
      expect(res.status).toBe(status);
      expect(await json(res)).toMatchObject(expected);
    }
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("activates a diet as staff, auditing and writing edit history with the actor's name", async () => {
    mocks.scope.mockResolvedValue(staffScope);
    mocks.chooseDiet.mockResolvedValue({ kind: "active", selection: selection({ dietSlug: "keto" }), previousSlug: "mediterranean", oversightRecommended: false });
    const res = await call(`/office/patients/${PAT}/diet`, "PUT", { dietSlug: "keto", answers: { medication: "no" }, settings: { fastingWindow: null } });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: "active", previousDietSlug: "mediterranean", selection: { dietSlug: "keto" } });
    expect(mocks.chooseDiet).toHaveBeenCalledWith(expect.objectContaining({ dietSlug: "keto", answers: { medication: "no" }, actor: { role: "staff", userId: "t1", name: "Tess Staff" } }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_diet_set", actorUserId: "t1", actorKind: "team_member", providerId: "p1", targetId: PAT, requestId: "req-1", metadata: expect.objectContaining({ dietSlug: "keto", previousDietSlug: "mediterranean", reviewStatus: "active" }) }));
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ patientId: PAT, family: "diet", recordId: "sel-1", changeKind: "create", actorName: "Tess Staff", auditEventId: 77 }));
  });

  it("returns 202 with the block when screening parks the pick for review", async () => {
    mocks.chooseDiet.mockResolvedValue({ kind: "pending_review", reason: "screening", questions: ["medication"], suggestedSlug: null, selection: selection({ id: "sel-2", dietSlug: "keto", status: "pending_review" }), block: block() });
    const res = await call(`/office/patients/${PAT}/diet`, "PUT", { dietSlug: "keto", answers: { medication: "yes" } });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body).toMatchObject({ status: "pending_review", reason: "screening", block: { id: BLOCK, status: "pending" } });
    expect(mocks.audit.mock.calls[0]![0].metadata).toMatchObject({ reviewStatus: "pending_review", blockId: BLOCK });
  });

  it("clears the diet and only audits when something was cleared", async () => {
    mocks.clearDiet.mockResolvedValueOnce({ previousSlug: null });
    expect(await json(await call(`/office/patients/${PAT}/diet`, "DELETE"))).toEqual({ ok: true, previousDietSlug: null });
    expect(mocks.audit).not.toHaveBeenCalled();
    mocks.clearDiet.mockResolvedValueOnce({ previousSlug: "keto" });
    expect(await json(await call(`/office/patients/${PAT}/diet`, "DELETE"))).toEqual({ ok: true, previousDietSlug: "keto" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_diet_cleared", metadata: { previousDietSlug: "keto" } }));
  });
});

describe("office patient diet routes — safety block override", () => {
  it("starts the two-step override and returns the challenge", async () => {
    mocks.loadState.mockResolvedValue(emptyState({ pendingBlock: block() }));
    mocks.startOverride.mockResolvedValue({ kind: "started", block: block({ overrideChallengedAt: "2026-10-10T00:00:00Z" }), challenge: "abc123", confirmText: "Are you sure you want to do this?", expiresAt: "2026-10-10T00:10:00Z" });
    const res = await call(`/office/patients/${PAT}/diet/blocks/${BLOCK}/override`, "POST", {});
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ challenge: "abc123", confirmText: "Are you sure you want to do this?", block: { id: BLOCK, overrideStartedAt: "2026-10-10T00:00:00Z" } });
    expect(mocks.startOverride).toHaveBeenCalledWith(expect.objectContaining({ patientId: PAT, blockId: BLOCK, actor: expect.objectContaining({ role: "staff", userId: "a1", name: "Dr. One" }) }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_diet_block_override_started", metadata: { blockId: BLOCK, dietSlug: "keto" } }));
  });

  it("404s when there is no matching pending block", async () => {
    mocks.startOverride.mockResolvedValue({ kind: "not_found" });
    expect((await call(`/office/patients/${PAT}/diet/blocks/${BLOCK}/override`, "POST", {})).status).toBe(404);
    mocks.rejectBlock.mockResolvedValue({ kind: "not_found" });
    expect((await call(`/office/patients/${PAT}/diet/blocks/${BLOCK}/reject`, "POST", {})).status).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("refuses to start or confirm an override of a pregnancy block (409 NOT_OVERRIDABLE, nothing audited)", async () => {
    const pregnancyBlock = block({ questions: ["pregnancy"] });
    mocks.loadState.mockResolvedValue(emptyState({ pendingBlock: pregnancyBlock }));
    mocks.startOverride.mockResolvedValue({ kind: "not_overridable", block: pregnancyBlock, reason: "pregnancy" });
    const start = await call(`/office/patients/${PAT}/diet/blocks/${BLOCK}/override`, "POST", {});
    expect(start.status).toBe(409);
    expect(await json(start)).toMatchObject({ code: "NOT_OVERRIDABLE", block: { id: BLOCK, questions: ["pregnancy"] } });
    mocks.confirmOverride.mockResolvedValue({ kind: "not_overridable", block: pregnancyBlock, reason: "pregnancy" });
    const confirm = await call(`/office/patients/${PAT}/diet/blocks/${BLOCK}/override/confirm`, "POST", { challenge: "abc123" });
    expect(confirm.status).toBe(409);
    expect((await json(confirm)).code).toBe("NOT_OVERRIDABLE");
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it("confirm requires the challenge and reports mismatch / expiry as 409", async () => {
    expect((await call(`/office/patients/${PAT}/diet/blocks/${BLOCK}/override/confirm`, "POST", {})).status).toBe(400);
    mocks.confirmOverride.mockResolvedValueOnce({ kind: "challenge_mismatch" });
    const mismatch = await call(`/office/patients/${PAT}/diet/blocks/${BLOCK}/override/confirm`, "POST", { challenge: "wrong" });
    expect(mismatch.status).toBe(409);
    expect((await json(mismatch)).code).toBe("CHALLENGE_MISMATCH");
    mocks.confirmOverride.mockResolvedValueOnce({ kind: "challenge_expired" });
    const expired = await call(`/office/patients/${PAT}/diet/blocks/${BLOCK}/override/confirm`, "POST", { challenge: "late" });
    expect(expired.status).toBe(409);
    expect((await json(expired)).code).toBe("CHALLENGE_EXPIRED");
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("confirm activates the diet, audits the override with the actor and writes history", async () => {
    mocks.confirmOverride.mockResolvedValue({ kind: "overridden", block: block({ status: "overridden", reviewedBy: "a1", reviewedByName: "Dr. One", reviewNote: "Discussed in clinic" }), selection: selection({ id: "sel-2", dietSlug: "keto" }), previousSlug: "mediterranean" });
    const res = await call(`/office/patients/${PAT}/diet/blocks/${BLOCK}/override/confirm`, "POST", { challenge: "abc123", note: "  Discussed in clinic  " });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: "active", block: { status: "overridden", reviewedByName: "Dr. One", reviewNote: "Discussed in clinic" }, selection: { dietSlug: "keto" }, previousDietSlug: "mediterranean" });
    expect(mocks.confirmOverride).toHaveBeenCalledWith(expect.objectContaining({ blockId: BLOCK, challenge: "abc123", note: "Discussed in clinic" }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_diet_block_overridden", actorUserId: "a1", metadata: expect.objectContaining({ blockId: BLOCK, dietSlug: "keto", previousDietSlug: "mediterranean" }) }));
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ family: "diet", recordId: "sel-2", changeKind: "update" }));
  });

  it("rejects a pending block and audits it", async () => {
    mocks.rejectBlock.mockResolvedValue({ kind: "rejected", block: block({ status: "rejected" }) });
    const res = await call(`/office/patients/${PAT}/diet/blocks/${BLOCK}/reject`, "POST", { note: "Not safe right now" });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: "rejected", block: { status: "rejected" } });
    expect(mocks.rejectBlock).toHaveBeenCalledWith(expect.objectContaining({ blockId: BLOCK, note: "Not safe right now" }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_diet_block_rejected" }));
  });
});

describe("office patient diet routes — protocol restart", () => {
  it("rejects malformed or future start dates", async () => {
    expect((await call(`/office/patients/${PAT}/protocol/restart`, "POST", { startedOn: "10/10/2026" })).status).toBe(400);
    expect((await call(`/office/patients/${PAT}/protocol/restart`, "POST", { startedOn: "2999-01-01" })).status).toBe(400);
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it("opens a new episode from day one, keeps history and audits the restart", async () => {
    mocks.loadState.mockResolvedValueOnce(emptyState({ activeSelection: selection() }));
    mocks.restart.mockResolvedValue({ id: "ep-2", episodeNumber: 2, startedOn: "2026-10-09", endedOn: null, reason: "provider_restart", startedByRole: "staff", note: "Fresh start", createdAt: "2026-10-10T00:00:00Z" });
    mocks.loadState.mockResolvedValueOnce(emptyState({ episode: { id: "ep-2", episodeNumber: 2, startedOn: "2026-10-09", endedOn: null, reason: "provider_restart", startedByRole: "staff", note: "Fresh start", createdAt: "" }, activeSelection: selection() }));
    const res = await call(`/office/patients/${PAT}/protocol/restart`, "POST", { startedOn: "2026-10-09", note: "Fresh start" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.episode).toMatchObject({ id: "ep-2", episodeNumber: 2, startedOn: "2026-10-09" });
    expect(body.state.phase).toMatchObject({ phase: "protocol", episodeNumber: 2, dietPickerLocked: true });
    expect(body.state.phase.programDay).toBeLessThanOrEqual(3);
    expect(body.state.currentDiet.dietSlug).toBe("mediterranean");
    expect(body.state.effectiveDietSlug).toBeNull();
    expect(mocks.restart).toHaveBeenCalledWith(PAT, "2026-10-09", expect.objectContaining({ role: "staff", userId: "a1" }), "Fresh start");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_protocol_restarted", metadata: { episodeId: "ep-2", episodeNumber: 2, startedOn: "2026-10-09", previousDietSlug: "mediterranean" } }));
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ family: "diet", recordId: "ep-2", changeKind: "create" }));
  });
});

describe("office patient diet routes — preference lists", () => {
  it("adds a catalog item, a severe allergy and a custom item on the patient's behalf", async () => {
    const bad = await call(`/office/patients/${PAT}/diet/preferences`, "POST", { list: "allergy", label: "Peanut" });
    expect(bad.status).toBe(400);
    expect((await json(bad)).field).toBe("severity");
    mocks.addPreferenceItem.mockResolvedValue({ kind: "created", item: { id: ITEM, list: "allergy", itemKey: "peanut", label: "Peanut", isCustom: false, severity: "severe", enteredByRole: "staff", enteredByName: "Dr. One", createdAt: "2026-10-10T00:00:00Z" } });
    const res = await call(`/office/patients/${PAT}/diet/preferences`, "POST", { list: "allergy", key: "peanut", severity: "severe" });
    expect(res.status).toBe(201);
    expect((await json(res)).item).toMatchObject({ id: ITEM, list: "allergy", key: "peanut", severity: "severe", enteredByName: "Dr. One" });
    expect(mocks.addPreferenceItem).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ list: "allergy", itemKey: "peanut", severity: "severe", isCustom: false }) }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_preference_item_added", metadata: { list: "allergy", itemKey: "peanut", severity: "severe" } }));
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ family: "diet", recordId: ITEM, changeKind: "create" }));
  });

  it("returns 409 DUPLICATE when the item already exists", async () => {
    mocks.addPreferenceItem.mockResolvedValue({ kind: "duplicate" });
    const res = await call(`/office/patients/${PAT}/diet/preferences`, "POST", { list: "dislike", label: "Cilantro" });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("DUPLICATE");
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("removes an item (404 for unknown ids) and audits the removal", async () => {
    expect((await call(`/office/patients/${PAT}/diet/preferences/not-an-id`, "DELETE")).status).toBe(404);
    mocks.removePreference.mockResolvedValueOnce(null);
    expect((await call(`/office/patients/${PAT}/diet/preferences/${ITEM}`, "DELETE")).status).toBe(404);
    mocks.removePreference.mockResolvedValueOnce({ id: ITEM, list: "restriction", itemKey: "gluten_free", label: "Gluten-free", isCustom: false, severity: null, enteredByRole: "patient", enteredByName: null, createdAt: "" });
    const res = await call(`/office/patients/${PAT}/diet/preferences/${ITEM}`, "DELETE");
    expect(res.status).toBe(200);
    expect(mocks.removePreference).toHaveBeenCalledWith(PAT, ITEM, expect.objectContaining({ role: "staff" }), expect.any(Date));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_preference_item_removed", metadata: { list: "restriction", itemKey: "gluten_free", severity: null } }));
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ recordId: ITEM, changeKind: "delete" }));
  });
});
