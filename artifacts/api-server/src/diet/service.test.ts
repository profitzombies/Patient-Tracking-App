/**
 * Diet choice service — the provider override rules, end to end through the
 * service with the store, library and outbox faked.
 *
 * The shared screening module says a pregnancy / breastfeeding block has no
 * provider override; this suite proves the service honours that on both
 * steps (and still lets medication / eating-disorder blocks through), and
 * that a pregnancy-blocked pick is parked for the provider with the fertility
 * suggestion rather than activated.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadState: vi.fn(), patchBlock: vi.fn(), activate: vi.fn(), insertSelection: vi.fn(), insertBlock: vi.fn(), endOpen: vi.fn(), recordAnswers: vi.fn(),
  loadEntry: vi.fn(), notifyCareTeam: vi.fn(), notifyPatient: vi.fn(),
}));
vi.mock("./store", async () => {
  const actual = await vi.importActual<typeof import("./store")>("./store");
  return {
    ...actual, loadPatientDietState: mocks.loadState, patchBlock: mocks.patchBlock, activatePendingSelection: mocks.activate,
    insertSelection: mocks.insertSelection, insertBlock: mocks.insertBlock, endOpenSelections: mocks.endOpen, recordScreeningAnswers: mocks.recordAnswers,
    recordActivityLevel: vi.fn(), rejectPendingSelection: vi.fn(),
  };
});
vi.mock("./library", async () => {
  const actual = await vi.importActual<typeof import("./library")>("./library");
  return { ...actual, loadLibraryEntry: mocks.loadEntry, loadLibraryRows: vi.fn(async () => []) };
});
vi.mock("./notifications", () => ({ notifyCareTeam: mocks.notifyCareTeam, notifyPatient: mocks.notifyPatient }));

import { DIET_BY_SLUG } from "@workspace/diet-programs";
import { blockIsOverridable, chooseDiet, confirmOverride, startOverride } from "./service";
import type { BlockRecord, PatientDietState, SelectionRecord } from "./store";

const NOW = new Date("2026-10-10T15:00:00Z");
const actor = { role: "staff" as const, userId: "staff-1", name: "Dr. One" };
const patient = { id: "pat-1", provider_id: "prov-1", gender: "female", program_id: "glp1", program_start_date: "2026-01-01" } as Parameters<typeof chooseDiet>[0]["patient"];

function selection(over: Partial<SelectionRecord> = {}): SelectionRecord {
  return { id: "sel-1", dietSlug: "keto", status: "pending_review", selectedByRole: "patient", settings: {}, screeningSnapshot: {}, startedAt: "", endedAt: null, ...over } as SelectionRecord;
}
function block(over: Partial<BlockRecord> = {}): BlockRecord {
  return {
    id: "blk-1", selectionId: "sel-1", dietSlug: "keto", questions: ["medication"], status: "pending",
    overrideChallenge: null, overrideChallengedAt: null, overrideChallengedBy: null, reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: null, createdAt: "",
    ...over,
  } as BlockRecord;
}
function state(over: Partial<PatientDietState> = {}): PatientDietState {
  return { episode: null, activeSelection: null, pendingSelection: null, pendingBlock: null, answers: {}, answerHistory: [], preferences: [], activity: null, overrides: { calories: null, protein: null, carbs: null, fat: null, waterOz: null }, ...over } as PatientDietState;
}

/** A published library row shaped like the catalog entry for a slug. */
function publishedRow(slug: string) {
  const entry = DIET_BY_SLUG.get(slug)!;
  return {
    id: `lib-${slug}`, slug, name: entry.name, summary: entry.summary, complexity: entry.complexity, rule_sheet: entry.ruleSheet, sample_day: entry.sampleDay,
    oversight_note: entry.oversightNote, pregnancy_blocked: entry.pregnancyBlocked, screening_questions: entry.screeningQuestions, fit_rules: entry.fitRules,
    evidence_strength: entry.evidenceStrength, supervision_level: entry.supervisionLevel, sources: entry.sources, review_status: "published", reviewed_by: "r", reviewed_at: "", published_at: "",
    sort_order: 1, version: 1, updated_by: null, created_at: "", updated_at: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.patchBlock.mockImplementation(async (_id: string, patch: Record<string, unknown>) => block({
    overrideChallenge: (patch.override_challenge as string) ?? "abc", overrideChallengedAt: (patch.override_challenged_at as string) ?? null, overrideChallengedBy: (patch.override_challenged_by as string) ?? null, status: (patch.status as string) ?? "pending",
  }));
  mocks.activate.mockResolvedValue(selection({ status: "active" }));
  mocks.notifyCareTeam.mockResolvedValue(undefined);
  mocks.notifyPatient.mockResolvedValue(undefined);
  mocks.endOpen.mockResolvedValue(undefined);
  mocks.recordAnswers.mockResolvedValue(undefined);
  mocks.loadEntry.mockImplementation(async (slug: string) => (DIET_BY_SLUG.has(slug) ? publishedRow(slug) : null));
});

describe("provider override — pregnancy blocks are not overridable", () => {
  it("names the rule: only pregnancy blocks are refused", () => {
    expect(blockIsOverridable(block({ questions: ["medication"] }))).toBe(true);
    expect(blockIsOverridable(block({ questions: ["eating_disorder"] }))).toBe(true);
    expect(blockIsOverridable(block({ questions: ["pregnancy"] }))).toBe(false);
    expect(blockIsOverridable(block({ questions: ["pregnancy", "medication"] }))).toBe(false);
  });

  it("step one issues a challenge for a medication block but refuses a pregnancy block without touching the row", async () => {
    const ok = await startOverride({ patientId: "pat-1", blockId: "blk-1", state: state({ pendingBlock: block() }), actor, now: NOW });
    expect(ok.kind).toBe("started");
    expect(mocks.patchBlock).toHaveBeenCalledWith("blk-1", expect.objectContaining({ override_challenged_by: "staff-1" }));

    mocks.patchBlock.mockClear();
    const refused = await startOverride({ patientId: "pat-1", blockId: "blk-1", state: state({ pendingBlock: block({ questions: ["pregnancy"] }) }), actor, now: NOW });
    expect(refused).toMatchObject({ kind: "not_overridable", block: { questions: ["pregnancy"] } });
    expect(mocks.patchBlock).not.toHaveBeenCalled();
  });

  it("step two refuses a pregnancy block even with a valid challenge and never activates the parked diet", async () => {
    const pending = selection();
    const challenged = block({ questions: ["pregnancy", "medication"], overrideChallenge: "abc123", overrideChallengedAt: NOW.toISOString(), overrideChallengedBy: "staff-1" });
    const result = await confirmOverride({ patient, blockId: "blk-1", challenge: "abc123", note: null, state: state({ pendingBlock: challenged, pendingSelection: pending }), actor, dateKey: "2026-10-10", now: NOW });
    expect(result.kind).toBe("not_overridable");
    expect(mocks.patchBlock).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.notifyPatient).not.toHaveBeenCalled();
  });

  it("step two still records a medication override with the actor and starts the diet", async () => {
    const pending = selection();
    const challenged = block({ overrideChallenge: "abc123", overrideChallengedAt: NOW.toISOString(), overrideChallengedBy: "staff-1" });
    const result = await confirmOverride({ patient, blockId: "blk-1", challenge: "abc123", note: "Discussed", state: state({ pendingBlock: challenged, pendingSelection: pending }), actor, dateKey: "2026-10-10", now: NOW });
    expect(result.kind).toBe("overridden");
    expect(mocks.patchBlock).toHaveBeenCalledWith("blk-1", expect.objectContaining({ status: "overridden", reviewed_by: "staff-1", reviewed_by_name: "Dr. One", reviewed_at: NOW.toISOString(), review_note: "Discussed" }));
    expect(mocks.activate).toHaveBeenCalledWith("pat-1", "sel-1", NOW);
    expect(mocks.notifyPatient).toHaveBeenCalledWith(expect.objectContaining({ kind: "diet_changed_by_provider" }));
  });
});

describe("provider override re-checks the latest answers and library before activating", () => {
  const challenged = () => block({ overrideChallenge: "abc123", overrideChallengedAt: NOW.toISOString(), overrideChallengedBy: "staff-1" });

  it("a medication block parked after a pregnancy 'no' is refused once the patient later answers 'yes'", async () => {
    // The block row still lists only ["medication"]; the answer changed after it was parked.
    const stale = state({ pendingBlock: challenged(), pendingSelection: selection(), answers: { pregnancy: "yes", medication: "yes" } });
    const start = await startOverride({ patientId: "pat-1", blockId: "blk-1", state: stale, actor, now: NOW });
    expect(start).toMatchObject({ kind: "not_overridable", reason: "pregnancy" });
    const confirm = await confirmOverride({ patient, blockId: "blk-1", challenge: "abc123", note: null, state: stale, actor, dateKey: "2026-10-10", now: NOW });
    expect(confirm).toMatchObject({ kind: "not_overridable", reason: "pregnancy" });
    expect(mocks.patchBlock).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.notifyPatient).not.toHaveBeenCalled();
  });

  it("reads the pregnancy rule from the current library row, not the catalog snapshot", async () => {
    mocks.loadEntry.mockImplementation(async (slug: string) => ({ ...publishedRow(slug), pregnancy_blocked: false }));
    const answered = state({ pendingBlock: challenged(), pendingSelection: selection(), answers: { pregnancy: "yes", medication: "yes" } });
    const start = await startOverride({ patientId: "pat-1", blockId: "blk-1", state: answered, actor, now: NOW });
    expect(start.kind).toBe("started");
  });

  it("a diet HQ unpublished since the block was parked cannot be activated through an override", async () => {
    mocks.loadEntry.mockImplementation(async (slug: string) => ({ ...publishedRow(slug), review_status: "draft" }));
    const result = await confirmOverride({ patient, blockId: "blk-1", challenge: "abc123", note: null, state: state({ pendingBlock: challenged(), pendingSelection: selection() }), actor, dateKey: "2026-10-10", now: NOW });
    expect(result).toMatchObject({ kind: "not_overridable", reason: "diet_unavailable" });
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});

describe("choosing a pregnancy-blocked diet after a yes", () => {
  it("parks the pick for the provider with the fertility suggestion; the current diet stays", async () => {
    mocks.loadEntry.mockResolvedValue(publishedRow("keto"));
    mocks.loadState.mockResolvedValue(state({ activeSelection: selection({ id: "sel-0", dietSlug: "mediterranean", status: "active" }), answers: { pregnancy: "yes", medication: "no" } }));
    mocks.insertSelection.mockResolvedValue(selection({ id: "sel-2" }));
    mocks.insertBlock.mockResolvedValue(block({ id: "blk-2", selectionId: "sel-2", questions: ["pregnancy"] }));
    const result = await chooseDiet({ patient, actor: { role: "patient", userId: "u1", name: null }, dietSlug: "keto", answers: {}, settings: {}, activityLevel: null, dateKey: "2026-10-10", now: NOW });
    expect(result).toMatchObject({ kind: "pending_review", reason: "pregnancy", questions: ["pregnancy"], suggestedSlug: "fertility_pregnancy" });
    expect(mocks.endOpen).toHaveBeenCalledWith("pat-1", NOW, { withdrawPending: true, supersedeActive: false });
    expect(mocks.insertSelection).toHaveBeenCalledWith(expect.objectContaining({ dietSlug: "keto", status: "pending_review" }));
    expect(mocks.insertBlock).toHaveBeenCalledWith(expect.objectContaining({ dietSlug: "keto", questions: ["pregnancy"] }));
    expect(mocks.notifyCareTeam).toHaveBeenCalledWith(expect.objectContaining({ kind: "diet_safety" }));
    // ...and that parked block can only be rejected, never overridden.
    expect(blockIsOverridable(block({ questions: ["pregnancy"] }))).toBe(false);
  });
});
