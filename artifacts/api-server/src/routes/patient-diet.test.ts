import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), resolve: vi.fn(), history: vi.fn(), idem: vi.fn(),
  loadState: vi.fn(), recordActivity: vi.fn(), removePreference: vi.fn(), patientLibrary: vi.fn(), libraryRows: vi.fn(),
  chooseDiet: vi.fn(), clearDiet: vi.fn(), saveDietSettings: vi.fn(), recordAnswers: vi.fn(), addPreferenceItem: vi.fn(), changeAllergySeverity: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/patient-auth", () => ({ resolvePatient: mocks.resolve }));
vi.mock("../lib/idempotency", () => ({ openIdempotentWrite: mocks.idem }));
vi.mock("../lib/patient-edit-history", async () => {
  const actual = await vi.importActual<typeof import("../lib/patient-edit-history")>("../lib/patient-edit-history");
  return { ...actual, recordPatientEditHistory: mocks.history };
});
vi.mock("../diet/library", async () => {
  const actual = await vi.importActual<typeof import("../diet/library")>("../diet/library");
  return { ...actual, loadPatientLibrary: mocks.patientLibrary, loadLibraryRows: mocks.libraryRows, loadLibraryEntry: vi.fn() };
});
vi.mock("../diet/store", async () => {
  const actual = await vi.importActual<typeof import("../diet/store")>("../diet/store");
  return { ...actual, loadPatientDietState: mocks.loadState, recordActivityLevel: mocks.recordActivity };
});
vi.mock("../diet/targets", async () => {
  const actual = await vi.importActual<typeof import("../diet/targets")>("../diet/targets");
  return { ...actual, upsertTargetSnapshot: mocks.snapshot };
});
vi.mock("../diet/service", async () => {
  const actual = await vi.importActual<typeof import("../diet/service")>("../diet/service");
  return {
    ...actual, chooseDiet: mocks.chooseDiet, clearDiet: mocks.clearDiet, saveDietSettings: mocks.saveDietSettings, recordAnswers: mocks.recordAnswers,
    addPreferenceItem: mocks.addPreferenceItem, changeAllergySeverity: mocks.changeAllergySeverity, removePreferenceItem: mocks.removePreference,
    libraryRowsForState: mocks.libraryRows,
  };
});
import router from "./patient-diet";
import type { PatientDietState, SelectionRecord } from "../diet/store";

type Row = Record<string, unknown>;
let server: http.Server; let base = "";
beforeAll(async () => { const app = express(); app.use(express.json()); app.use(router); await new Promise<void>(r => { server = app.listen(0, () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());

const PAT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ITEM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let patientRow: Row;
let calls: Array<{ method: string; path: string; body?: unknown }> = [];

const selection = (over: Partial<SelectionRecord> = {}): SelectionRecord => ({
  id: "sel-1", dietSlug: "mediterranean", status: "active", selectedByRole: "patient", settings: {}, screeningSnapshot: {}, startedAt: "2026-10-09T00:00:00Z", endedAt: null, ...over,
});
const emptyState = (over: Partial<PatientDietState> = {}): PatientDietState => ({
  episode: { id: "ep-1", episodeNumber: 1, startedOn: "2026-10-01", endedOn: null, reason: "enrollment", startedByRole: "system", note: null, createdAt: "" },
  activeSelection: null, pendingSelection: null, pendingBlock: null, answers: {}, answerHistory: [], preferences: [], activity: null,
  overrides: { calories: null, protein: null, carbs: null, fat: null, waterOz: null }, ...over,
});

const json = async (res: Response): Promise<any> => res.json();
async function call(path: string, method = "GET", body?: unknown, ip = "10.0.0.1") {
  return fetch(base + path, { method, headers: { "content-type": "application/json", authorization: "Bearer patient", "x-forwarded-for": ip }, body: body ? JSON.stringify(body) : undefined });
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  calls = [];
  patientRow = { id: PAT, provider_id: "p1", timezone: "America/Chicago", gender: "female", date_of_birth: "1986-05-01", height_inches: 65, current_weight: 180, goal_weight: 150, program_id: "glp1", program_start_date: "2026-10-01", created_at: "2026-10-01T00:00:00Z" };
  mocks.resolve.mockResolvedValue({ ok: true, patientId: PAT, authUserId: USER, consent: { satisfied: true } });
  mocks.idem.mockResolvedValue({ handled: false, finish: async (res: express.Response, status: number, body: unknown) => { res.status(status).json(body); } });
  mocks.history.mockResolvedValue(undefined);
  mocks.snapshot.mockResolvedValue(undefined);
  mocks.loadState.mockResolvedValue(emptyState());
  mocks.libraryRows.mockResolvedValue([]);
  mocks.admin.mockImplementation(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/rest/v1/patients?")) return { status: 200, json: [patientRow] };
    if (method === "POST" && path.startsWith("/rest/v1/patient_target_overrides")) return { status: 201, json: null };
    throw new Error(`unexpected ${method} ${path}`);
  });
});

describe("patient diet routes — session gate", () => {
  it("passes the session resolver's status and details through", async () => {
    mocks.resolve.mockResolvedValueOnce({ ok: false, status: 401, error: "Sign in required." });
    expect((await call("/patient-data/diet")).status).toBe(401);
    mocks.resolve.mockResolvedValueOnce({ ok: false, status: 403, error: "Consent required", details: { code: "CONSENT_REQUIRED" } });
    const consent = await call("/patient-data/diet");
    expect(consent.status).toBe(403);
    expect((await json(consent)).code).toBe("CONSENT_REQUIRED");
    expect(mocks.loadState).not.toHaveBeenCalled();
  });

  it("answers 502 with a route-specific message when the patient row cannot be read", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 500, json: null });
    const res = await call("/patient-data/diet");
    expect(res.status).toBe(502);
    expect((await json(res)).error).toContain("load your eating plan");
  });
});

describe("patient diet routes — library and state", () => {
  it("returns only the patient-facing fields of the library", async () => {
    mocks.patientLibrary.mockResolvedValue({ settings: { disclaimer: "Not medical advice.", oversightNoteText: "Consider talking to your care team." }, rows: [
      { id: "l1", slug: "keto", name: "Keto", summary: "Low carb.", complexity: "involved", rule_sheet: ["Under 50 g carbs"], sample_day: ["Eggs"], oversight_note: true, pregnancy_blocked: true, screening_questions: ["medication"], fit_rules: { mode: "exclude", excludeTags: ["grain"] }, evidence_strength: "moderate", supervision_level: "recommended", sources: ["ADA"], review_status: "published", reviewed_by: "r1", reviewed_at: "", published_at: "", sort_order: 3, version: 2, updated_by: null, created_at: "", updated_at: "" },
    ] });
    const res = await call("/patient-data/diet/library");
    expect(res.status).toBe(200);
    const body = (await json(res));
    expect(body.disclaimer).toBe("Not medical advice.");
    expect(body.entries[0]).toMatchObject({ slug: "keto", complexity: "involved", oversightNote: "Consider talking to your care team.", pregnancyBlocked: true, screeningQuestions: ["medication"] });
    expect(body.entries[0]).not.toHaveProperty("evidenceStrength");
    expect(body.entries[0]).not.toHaveProperty("supervisionLevel");
    expect(body.entries[0]).not.toHaveProperty("reviewStatus");
  });

  it("reads the state with the GLP-1 default and an unlocked picker off the protocol program", async () => {
    mocks.loadState.mockResolvedValue(emptyState({ activeSelection: selection(), preferences: [{ id: ITEM, list: "allergy", itemKey: "peanut", label: "Peanut", isCustom: false, severity: "severe", enteredByRole: "patient", enteredByName: null, createdAt: "" }] }));
    const res = await call("/patient-data/diet");
    expect(res.status).toBe(200);
    const body = (await json(res));
    expect(body.programId).toBe("glp1");
    expect(body.suggestedDefaultSlug).toBe("glp1_companion");
    expect(body.phase).toMatchObject({ phase: "maintenance", dietPickerLocked: false, episodeNumber: 1 });
    expect(body.effectiveDietSlug).toBe("mediterranean");
    expect(body.preferences[0]).toMatchObject({ key: "peanut", severity: "severe" });
  });

  it("locks the picker for THINNR protocol patients and hides the effective diet", async () => {
    patientRow = { ...patientRow, program_id: "thinnr" };
    mocks.loadState.mockResolvedValue(emptyState({ activeSelection: selection() }));
    const body = (await json(await call("/patient-data/diet")));
    expect(body.phase).toMatchObject({ phase: "protocol", dietPickerLocked: true });
    expect(body.currentDiet.dietSlug).toBe("mediterranean");
    expect(body.effectiveDietSlug).toBeNull();
    expect(body.suggestedDefaultSlug).toBe("just_tracking");
  });
});

describe("patient diet routes — choosing a diet", () => {
  it("validates the body and never calls the service on bad input", async () => {
    expect((await call("/patient-data/diet", "PUT", {})).status).toBe(400);
    expect((await json(await call("/patient-data/diet", "PUT", { dietSlug: "keto", answers: { medication: "skipped" } }))).field).toBe("answers");
    expect((await json(await call("/patient-data/diet", "PUT", { dietSlug: "keto", settings: { fastingWindow: { eatingStart: "noon", eatingEnd: "20:00" } } }))).field).toBe("fastingWindow");
    expect((await json(await call("/patient-data/diet", "PUT", { dietSlug: "keto", activityLevel: "couch" }))).field).toBe("activityLevel");
    expect(mocks.chooseDiet).not.toHaveBeenCalled();
  });

  it("short-circuits on idempotent replay", async () => {
    mocks.idem.mockImplementationOnce(async (_req: express.Request, res: express.Response) => { res.status(200).json({ replayed: true }); return { handled: true, finish: async () => {} }; });
    expect(await json(await call("/patient-data/diet", "PUT", { dietSlug: "keto" }))).toEqual({ replayed: true });
    expect(mocks.idem).toHaveBeenCalledWith(expect.anything(), expect.anything(), PAT, "diet");
    expect(mocks.chooseDiet).not.toHaveBeenCalled();
  });

  it("maps service verdicts to 404 / 409 / 422 without writing history", async () => {
    const cases: Array<[Row, number, string]> = [
      [{ kind: "not_found" }, 404, "NOT_FOUND"], [{ kind: "not_selectable" }, 409, "NOT_SELECTABLE"],
      [{ kind: "locked", programDay: 5 }, 409, "DIET_LOCKED"], [{ kind: "needs_answers", questions: ["medication", "eating_disorder"] }, 422, "SCREENING_REQUIRED"],
    ];
    for (const [result, status, code] of cases) {
      mocks.chooseDiet.mockResolvedValueOnce(result);
      const res = await call("/patient-data/diet", "PUT", { dietSlug: "keto" });
      expect(res.status).toBe(status);
      expect((await json(res)).code).toBe(code);
    }
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it("activates a diet with the patient actor, the local day and the activity level", async () => {
    mocks.chooseDiet.mockResolvedValue({ kind: "active", selection: selection({ dietSlug: "keto" }), previousSlug: null, oversightRecommended: true });
    const res = await call("/patient-data/diet", "PUT", { dietSlug: "keto", answers: { medication: "no" }, activityLevel: "moderate", settings: { fastingWindow: { eatingStart: "12:00", eatingEnd: "20:00" } } });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: "active", previousDietSlug: null, oversightRecommended: true, selection: { dietSlug: "keto" } });
    const input = mocks.chooseDiet.mock.calls[0]![0];
    expect(input).toMatchObject({ dietSlug: "keto", answers: { medication: "no" }, activityLevel: "moderate", settings: { fastingWindow: { eatingStart: "12:00", eatingEnd: "20:00" } }, actor: { role: "patient", userId: USER, name: null } });
    expect(input.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ patientId: PAT, family: "diet", recordId: "sel-1", changeKind: "create", actorKind: "patient", actorUserId: USER }));
  });

  it("returns 202 with the pending block and the fertility suggestion on a pregnancy block", async () => {
    mocks.chooseDiet.mockResolvedValue({ kind: "pending_review", reason: "pregnancy", questions: ["pregnancy"], suggestedSlug: "fertility_pregnancy", selection: selection({ id: "sel-2", dietSlug: "keto", status: "pending_review" }), block: { id: "blk", selectionId: "sel-2", dietSlug: "keto", questions: ["pregnancy"], status: "pending", overrideChallenge: null, overrideChallengedAt: null, overrideChallengedBy: null, reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: null, createdAt: "" } });
    const res = await call("/patient-data/diet", "PUT", { dietSlug: "keto", answers: { pregnancy: "yes" } });
    expect(res.status).toBe(202);
    const body = (await json(res));
    expect(body).toMatchObject({ status: "pending_review", reason: "pregnancy", suggestedSlug: "fertility_pregnancy", block: { id: "blk", status: "pending" } });
    expect(body.block).not.toHaveProperty("overrideChallenge");
    expect(body.message).toContain("care team");
  });

  it("clears the diet and records history only when a diet was in force", async () => {
    mocks.clearDiet.mockResolvedValueOnce({ previousSlug: null });
    expect(await json(await call("/patient-data/diet", "DELETE"))).toEqual({ ok: true, previousDietSlug: null });
    expect(mocks.history).not.toHaveBeenCalled();
    mocks.clearDiet.mockResolvedValueOnce({ previousSlug: "keto" });
    expect(await json(await call("/patient-data/diet", "DELETE"))).toEqual({ ok: true, previousDietSlug: "keto" });
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ changeKind: "delete" }));
  });

  it("saves plan settings only when a diet is active", async () => {
    expect((await call("/patient-data/diet/settings", "PATCH", { whole30StartDate: "soon" })).status).toBe(400);
    const none = await call("/patient-data/diet/settings", "PATCH", { whole30StartDate: "2026-10-12" });
    expect(none.status).toBe(409);
    expect((await json(none)).code).toBe("NO_DIET");
    mocks.loadState.mockResolvedValue(emptyState({ activeSelection: selection({ dietSlug: "whole30" }) }));
    mocks.saveDietSettings.mockResolvedValue(selection({ dietSlug: "whole30", settings: { whole30StartDate: "2026-10-12" } }));
    const res = await call("/patient-data/diet/settings", "PATCH", { whole30StartDate: "2026-10-12" });
    expect(res.status).toBe(200);
    expect((await json(res)).selection.settings).toEqual({ whole30StartDate: "2026-10-12" });
    expect(mocks.saveDietSettings).toHaveBeenCalledWith(PAT, expect.anything(), { whole30StartDate: "2026-10-12" });
  });
});

describe("patient diet routes — screening and activity", () => {
  it("records standalone answers and reports a pregnancy conflict", async () => {
    expect((await call("/patient-data/diet/screening", "POST", { answers: {} })).status).toBe(400);
    mocks.recordAnswers.mockResolvedValue({ answers: { pregnancy: "yes" }, pregnancyConflict: true, suggestedSlug: "fertility_pregnancy" });
    const res = await call("/patient-data/diet/screening", "POST", { answers: { pregnancy: "yes" } });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ answers: { pregnancy: "yes" }, pregnancyConflict: true, suggestedSlug: "fertility_pregnancy" });
    expect(mocks.recordAnswers).toHaveBeenCalledWith(expect.objectContaining({ answers: { pregnancy: "yes" }, actor: expect.objectContaining({ role: "patient" }) }));
  });

  it("refuses the pregnancy question on a male account", async () => {
    patientRow = { ...patientRow, gender: "male" };
    const res = await call("/patient-data/diet/screening", "POST", { answers: { pregnancy: "no" } });
    expect(res.status).toBe(400);
    expect(mocks.recordAnswers).not.toHaveBeenCalled();
  });

  it("stores the activity level with its source", async () => {
    expect((await call("/patient-data/diet/activity", "POST", { level: "athlete" })).status).toBe(400);
    mocks.recordActivity.mockResolvedValue(undefined);
    const res = await call("/patient-data/diet/activity", "POST", { level: "active", source: "check_in" });
    expect(res.status).toBe(200);
    expect((await json(res)).activityLevel).toMatchObject({ level: "active", source: "check_in" });
    expect(mocks.recordActivity).toHaveBeenCalledWith(PAT, "active", "check_in", expect.objectContaining({ role: "patient" }), expect.any(String), expect.any(Date));
    // Anything but check_in is an ordinary settings change — the only other
    // patient-side value the patient_activity_levels CHECK accepts.
    await call("/patient-data/diet/activity", "POST", { level: "light", source: "weird" });
    expect(mocks.recordActivity.mock.calls[1]![2]).toBe("settings");
    await call("/patient-data/diet/activity", "POST", { level: "light" });
    expect(mocks.recordActivity.mock.calls[2]![2]).toBe("settings");
  });
});

describe("patient diet routes — preference lists", () => {
  const item = { id: ITEM, list: "restriction" as const, itemKey: "kosher", label: "Kosher", isCustom: false, severity: null, enteredByRole: "patient" as const, enteredByName: null, createdAt: "" };

  it("lists the four lists", async () => {
    mocks.loadState.mockResolvedValue(emptyState({ preferences: [item] }));
    expect((await json(await call("/patient-data/diet/preferences"))).items[0]).toMatchObject({ key: "kosher", label: "Kosher" });
  });

  it("validates items: unknown catalog keys 400, custom dislikes allowed, duplicates 409", async () => {
    const unknown = await call("/patient-data/diet/preferences", "POST", { list: "restriction", key: "pescatarian_ish" });
    expect(unknown.status).toBe(400);
    expect((await json(unknown)).field).toBe("key");
    const sev = await call("/patient-data/diet/preferences", "POST", { list: "dislike", label: "Cilantro", severity: "mild" });
    expect(sev.status).toBe(400);
    mocks.addPreferenceItem.mockResolvedValueOnce({ kind: "created", item: { ...item, list: "dislike", itemKey: "custom:cilantro", label: "Cilantro", isCustom: true } });
    const ok = await call("/patient-data/diet/preferences", "POST", { list: "dislike", label: "  Cilantro  " });
    expect(ok.status).toBe(201);
    expect((await json(ok)).item).toMatchObject({ key: "custom:cilantro", isCustom: true });
    expect(mocks.addPreferenceItem.mock.calls[0]![0].item).toEqual({ list: "dislike", itemKey: "custom:cilantro", label: "Cilantro", isCustom: true, severity: null });
    mocks.addPreferenceItem.mockResolvedValueOnce({ kind: "duplicate" });
    const dup = await call("/patient-data/diet/preferences", "POST", { list: "restriction", key: "kosher" });
    expect(dup.status).toBe(409);
    expect((await json(dup)).code).toBe("DUPLICATE");
  });

  it("changes allergy severity and removes items with 404s for unknown ids", async () => {
    expect((await call(`/patient-data/diet/preferences/${ITEM}`, "PATCH", { severity: "deadly" })).status).toBe(400);
    expect((await call(`/patient-data/diet/preferences/nope`, "PATCH", { severity: "severe" })).status).toBe(404);
    mocks.changeAllergySeverity.mockResolvedValueOnce(null);
    expect((await call(`/patient-data/diet/preferences/${ITEM}`, "PATCH", { severity: "severe" })).status).toBe(404);
    mocks.changeAllergySeverity.mockResolvedValueOnce({ ...item, list: "allergy", itemKey: "peanut", label: "Peanut", severity: "severe" });
    const res = await call(`/patient-data/diet/preferences/${ITEM}`, "PATCH", { severity: "severe" });
    expect(res.status).toBe(200);
    expect((await json(res)).item.severity).toBe("severe");
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ recordId: ITEM, changeKind: "update" }));

    mocks.removePreference.mockResolvedValueOnce(null);
    expect((await call(`/patient-data/diet/preferences/${ITEM}`, "DELETE")).status).toBe(404);
    mocks.removePreference.mockResolvedValueOnce(item);
    expect((await call(`/patient-data/diet/preferences/${ITEM}`, "DELETE")).status).toBe(200);
    expect(mocks.removePreference).toHaveBeenCalledWith(PAT, ITEM, expect.objectContaining({ role: "patient" }), expect.any(Date));
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ recordId: ITEM, changeKind: "delete" }));
  });
});

describe("patient diet routes — targets", () => {
  it("computes calculated and effective targets from the patient row and writes a snapshot", async () => {
    mocks.loadState.mockResolvedValue(emptyState({ activity: { level: "sedentary", source: "account", recordedOn: "2026-10-09", createdAt: "" }, overrides: { calories: 1400, protein: null, carbs: null, fat: null, waterOz: null } }));
    patientRow = { ...patientRow, program_id: "thinnr" };
    const res = await call("/patient-data/diet/targets");
    expect(res.status).toBe(200);
    const body = (await json(res));
    expect(body.phase).toBe("protocol");
    expect(body.calculated.calories).toBeGreaterThan(0);
    expect(body.effective.calories).toBe(1400);
    expect(body.overrides).toEqual({ calories: 1400, protein: null, carbs: null, fat: null, waterOz: null });
    expect(mocks.snapshot).toHaveBeenCalledWith(PAT, expect.anything(), expect.any(Date));
  });

  it("validates overrides and upserts them by patient", async () => {
    expect((await call("/patient-data/diet/targets", "PUT", {})).status).toBe(400);
    const neg = await call("/patient-data/diet/targets", "PUT", { calories: -5 });
    expect(neg.status).toBe(400);
    expect(((await json(neg))).field).toBe("calories");
    expect((await call("/patient-data/diet/targets", "PUT", { waterOz: 999 })).status).toBe(400);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    mocks.loadState.mockResolvedValue(emptyState({ overrides: { calories: 1500, protein: null, carbs: null, fat: null, waterOz: null } }));
    const res = await call("/patient-data/diet/targets", "PUT", { calories: 1500, protein: null });
    expect(res.status).toBe(200);
    expect(((await json(res))).effective.calories).toBe(1500);
    const upsert = calls.find((c) => c.method === "POST")!;
    expect(upsert.path).toBe("/rest/v1/patient_target_overrides?on_conflict=patient_id");
    expect(upsert.body).toEqual([expect.objectContaining({ patient_id: PAT, calories: 1500, protein: null })]);
    expect(mocks.idem).toHaveBeenCalledWith(expect.anything(), expect.anything(), PAT, "diet-targets");
  });
});
