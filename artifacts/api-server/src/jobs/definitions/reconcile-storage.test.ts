import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  deleteObjectStrict: vi.fn(),
  listObjects: vi.fn(),
}));
vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../../lib/objectStorage", () => ({
  objectStorage: { deleteObjectStrict: mocks.deleteObjectStrict, listObjects: mocks.listObjects },
}));

import { RECONCILE_PREFIXES, isHeldPath, orphanGraceMs, reconcilePrefix, reconcileStorage } from "./reconcile-storage";
import type { JobContext } from "../types";

const NOW = new Date("2026-09-07T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function ctx(dryRun = false) {
  const counts: Record<string, number> = {};
  const failures: Array<{ item: string; error: string }> = [];
  const logs: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const c: JobContext = {
    dryRun,
    now: NOW,
    tally: (k, by = 1) => { counts[k] = (counts[k] ?? 0) + by; },
    failItem: (item, error) => { failures.push({ item, error: error instanceof Error ? error.message : String(error) }); },
    leaseLost: false,
    checkpoint: () => undefined,
    log: (event, detail) => { logs.push({ event, detail }); },
  };
  return { c, counts, failures, logs };
}

interface LedgerRow { object_path: string; source: string; missing: boolean }
interface VariantRow { object_path: string; variants: string[] }

function fakeAdmin(ledger: LedgerRow[], intents: string[] = [], variantRows: VariantRow[] = [], heldPatients: string[] = []) {
  const flagged: Array<{ paths: string[]; missing: boolean }> = [];
  const variantPatches: Array<{ path: string; variants: string[] }> = [];
  mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
    if (method === "GET" && path.startsWith("/rest/v1/patient_media?select=object_path,variants")) {
      const after = decodeURIComponent(path.split("object_path=gt.")[1].split("&")[0]);
      const limit = Number(path.split("limit=")[1]);
      const rows = variantRows
        .filter((r) => r.variants.length > 0 && r.object_path > after)
        .sort((a, b) => a.object_path.localeCompare(b.object_path))
        .slice(0, limit);
      return { status: 200, json: rows };
    }
    if (method === "PATCH" && path.startsWith("/rest/v1/patient_media?object_path=eq.")) {
      const target = decodeURIComponent(path.split("object_path=eq.")[1]);
      variantPatches.push({ path: target, variants: body?.variants as string[] });
      return { status: 204, json: null };
    }
    if (path === "/rest/v1/rpc/storage_ledger_paths") {
      const prefix = body?.p_prefix as string;
      const after = (body?.p_after as string | null) ?? "";
      const limit = body?.p_limit as number;
      const rows = ledger
        .filter((r) => r.object_path.startsWith(prefix) && r.object_path > after)
        .sort((a, b) => a.object_path.localeCompare(b.object_path))
        .slice(0, limit);
      return { status: 200, json: rows };
    }
    if (path === "/rest/v1/rpc/storage_mark_object_missing") {
      flagged.push({ paths: body?.p_paths as string[], missing: body?.p_missing as boolean });
      return { status: 200, json: (body?.p_paths as string[]).length };
    }
    if (path === "/rest/v1/rpc/legal_hold_patient_ids") {
      return { status: 200, json: heldPatients.slice() };
    }
    if (method === "GET" && path.startsWith("/rest/v1/storage_upload_intents")) {
      const raw = decodeURIComponent(path.split("object_path=in.(")[1].slice(0, -1));
      const asked = [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      return { status: 200, json: intents.filter((p) => asked.includes(p)).map((p) => ({ object_path: p })) };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { flagged, variantPatches };
}

const PM = "/objects/patient-media/";

describe("storage reconciliation", () => {
  beforeEach(() => {
    mocks.admin.mockReset();
    mocks.deleteObjectStrict.mockReset().mockResolvedValue(undefined);
    mocks.listObjects.mockReset();
    delete process.env.JOBS_ORPHAN_GRACE_MS;
  });

  it("covers every upload prefix and defaults the orphan grace to a day", () => {
    expect([...RECONCILE_PREFIXES]).toEqual([
      "/objects/patient-media/",
      "/objects/patients/",
      "/objects/hq-files/",
      "/objects/training-videos/",
      "/objects/training-attachments/",
      "/objects/knowledge-docs/",
      "/objects/exports/",
    ]);
    expect(orphanGraceMs()).toBe(86_400_000);
  });

  it("keeps referenced bloodwork staging and committed sources and quarantines old unknown bytes", async () => {
    const prefix = "/objects/patients/";
    const staging = `${prefix}p1/bloodwork/staging/r1/f1`;
    const committed = `${prefix}p1/bloodwork/reports/r1/f1`;
    fakeAdmin([
      { object_path: staging, source: "patient_bloodwork_staging", missing: false },
      { object_path: committed, source: "patient_bloodwork_file", missing: false },
    ]);
    mocks.listObjects.mockResolvedValue([
      { path: staging, createdAt: daysAgo(4), sizeBytes: 1 },
      { path: committed, createdAt: daysAgo(4), sizeBytes: 1 },
      { path: `${prefix}p1/bloodwork/staging/abandoned/f2`, createdAt: daysAgo(2), sizeBytes: 1 },
    ]);
    const { c, counts } = ctx();
    await reconcilePrefix(c, prefix);
    expect(mocks.deleteObjectStrict).toHaveBeenCalledTimes(1);
    expect(mocks.deleteObjectStrict).toHaveBeenCalledWith(`${prefix}p1/bloodwork/staging/abandoned/f2`);
    expect(counts).toMatchObject({ ledgerRows: 2, orphansDeleted: 1 });
  });

  it("deletes orphans past the grace window, leaves young or intent-covered ones, and never touches referenced objects", async () => {
    const { flagged } = fakeAdmin(
      [{ object_path: `${PM}p1/kept`, source: "patient_media", missing: false }],
      [`${PM}p1/uploading`],
    );
    mocks.listObjects.mockResolvedValue([
      { path: `${PM}p1/kept`, createdAt: daysAgo(10), sizeBytes: 1 },
      { path: `${PM}p1/orphan-old`, createdAt: daysAgo(2), sizeBytes: 1 },
      { path: `${PM}p1/orphan-young`, createdAt: new Date(NOW.getTime() - 3_600_000), sizeBytes: 1 },
      { path: `${PM}p1/orphan-unknown-age`, createdAt: null, sizeBytes: 1 },
      { path: `${PM}p1/uploading`, createdAt: daysAgo(3), sizeBytes: 1 },
    ]);
    const { c, counts, failures } = ctx();
    await reconcilePrefix(c, PM);
    expect(mocks.deleteObjectStrict.mock.calls.map((call) => call[0])).toEqual([`${PM}p1/orphan-old`]);
    expect(counts).toMatchObject({ objects: 5, ledgerRows: 1, orphansDeleted: 1, orphanYoung: 2, orphanPendingUpload: 1 });
    expect(flagged).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("never deletes an orphan under a patient on legal hold, and stops the prefix when the hold list cannot be read", async () => {
    fakeAdmin([], [], [], ["p-held"]);
    mocks.listObjects.mockResolvedValue([
      { path: `${PM}p-held/orphan-old`, createdAt: daysAgo(2), sizeBytes: 1 },
      { path: `${PM}p-held/orphan-old.thumb`, createdAt: daysAgo(2), sizeBytes: 1 },
      { path: `${PM}p1/orphan-old`, createdAt: daysAgo(2), sizeBytes: 1 },
    ]);
    const { c, counts, failures } = ctx();
    await reconcilePrefix(c, PM);
    expect(mocks.deleteObjectStrict.mock.calls.map((call) => call[0])).toEqual([`${PM}p1/orphan-old`]);
    expect(counts).toMatchObject({ orphansDeleted: 1, orphanHeld: 2 });
    expect(failures).toEqual([]);
    // A prefix that merely contains the id as a substring of another id is not held.
    expect(isHeldPath(`${PM}p-held2/x`, ["p-held"])).toBe(false);

    mocks.admin.mockReset();
    mocks.deleteObjectStrict.mockReset().mockResolvedValue(undefined);
    mocks.admin.mockImplementation(async (_m: string, path: string) => {
      if (path === "/rest/v1/rpc/legal_hold_patient_ids") return { status: 503, json: null };
      return { status: 200, json: [] };
    });
    await expect(reconcilePrefix(ctx().c, PM)).rejects.toThrow(/legal hold lookup failed/);
    expect(mocks.deleteObjectStrict).not.toHaveBeenCalled();
  });

  it("treats photo variants as owned by their original: kept while the original is on a ledger, orphans otherwise", async () => {
    fakeAdmin([{ object_path: `${PM}p1/progress-kept`, source: "patient_media", missing: false }]);
    mocks.listObjects.mockResolvedValue([
      { path: `${PM}p1/progress-kept`, createdAt: daysAgo(10), sizeBytes: 1 },
      { path: `${PM}p1/progress-kept.thumb`, createdAt: daysAgo(10), sizeBytes: 1 },
      { path: `${PM}p1/progress-kept.medium`, createdAt: daysAgo(10), sizeBytes: 1 },
      { path: `${PM}p1/progress-gone.thumb`, createdAt: daysAgo(10), sizeBytes: 1 },
      { path: `${PM}p1/progress-gone.medium`, createdAt: daysAgo(10), sizeBytes: 1 },
    ]);
    const { c, counts, failures } = ctx();
    await reconcilePrefix(c, PM);
    expect(mocks.deleteObjectStrict.mock.calls.map((call) => call[0]).sort()).toEqual([
      `${PM}p1/progress-gone.medium`,
      `${PM}p1/progress-gone.thumb`,
    ]);
    expect(counts).toMatchObject({ objects: 5, orphansDeleted: 2, orphanYoung: 0 });
    expect(failures).toEqual([]);
  });

  it("clears recorded variants whose object is gone and leaves complete rows alone", async () => {
    const { variantPatches } = fakeAdmin(
      [
        { object_path: `${PM}p1/progress-a`, source: "patient_media", missing: false },
        { object_path: `${PM}p1/progress-b`, source: "patient_media", missing: false },
        { object_path: `${PM}p1/progress-c`, source: "patient_media", missing: false },
      ],
      [],
      [
        { object_path: `${PM}p1/progress-a`, variants: ["thumb", "medium"] },
        { object_path: `${PM}p1/progress-b`, variants: ["thumb", "medium"] },
        { object_path: `${PM}p1/progress-c`, variants: [] },
      ],
    );
    mocks.listObjects.mockResolvedValue([
      { path: `${PM}p1/progress-a`, createdAt: daysAgo(10), sizeBytes: 1 },
      { path: `${PM}p1/progress-a.thumb`, createdAt: daysAgo(10), sizeBytes: 1 },
      { path: `${PM}p1/progress-a.medium`, createdAt: daysAgo(10), sizeBytes: 1 },
      { path: `${PM}p1/progress-b`, createdAt: daysAgo(10), sizeBytes: 1 },
      { path: `${PM}p1/progress-b.thumb`, createdAt: daysAgo(10), sizeBytes: 1 },
      { path: `${PM}p1/progress-c`, createdAt: daysAgo(10), sizeBytes: 1 },
    ]);
    const { c, counts, failures } = ctx();
    await reconcilePrefix(c, PM);
    expect(variantPatches).toEqual([{ path: `${PM}p1/progress-b`, variants: ["thumb"] }]);
    expect(counts).toMatchObject({ variantsMissingCleared: 1 });
    expect(mocks.deleteObjectStrict).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
  });

  it("dry run counts stale variant entries without patching rows", async () => {
    const { variantPatches } = fakeAdmin(
      [{ object_path: `${PM}p1/progress-b`, source: "patient_media", missing: false }],
      [],
      [{ object_path: `${PM}p1/progress-b`, variants: ["thumb", "medium"] }],
    );
    mocks.listObjects.mockResolvedValue([{ path: `${PM}p1/progress-b`, createdAt: daysAgo(10), sizeBytes: 1 }]);
    const { c, counts } = ctx(true);
    await reconcilePrefix(c, PM);
    expect(variantPatches).toEqual([]);
    expect(counts).toMatchObject({ variantsMissingFound: 2 });
  });

  it("flags ledger rows whose object is gone, skips already-flagged ones, and unflags recovered ones", async () => {
    const { flagged } = fakeAdmin([
      { object_path: `${PM}p1/present`, source: "patient_media", missing: false },
      { object_path: `${PM}p1/gone`, source: "patient_media", missing: false },
      { object_path: `${PM}p1/gone-known`, source: "patient_media", missing: true },
      { object_path: `${PM}p1/came-back`, source: "patient_media", missing: true },
      { object_path: `${PM}p1/export-gone`, source: "patient_data_exports", missing: false },
    ]);
    mocks.listObjects.mockResolvedValue([
      { path: `${PM}p1/present`, createdAt: daysAgo(5), sizeBytes: 1 },
      { path: `${PM}p1/came-back`, createdAt: daysAgo(5), sizeBytes: 1 },
    ]);
    const { c, counts } = ctx();
    await reconcilePrefix(c, PM);
    expect(flagged).toEqual([
      { paths: [`${PM}p1/export-gone`, `${PM}p1/gone`], missing: true },
      { paths: [`${PM}p1/came-back`], missing: false },
    ]);
    expect(counts).toMatchObject({ missingFlagged: 2, missingKnown: 1, recovered: 1 });
    expect(mocks.deleteObjectStrict).not.toHaveBeenCalled();
  });

  it("counts and logs missing objects whose ledger has no flag column instead of ignoring them", async () => {
    const { flagged } = fakeAdmin([
      { object_path: `${PM}p1/progress-gone`, source: "patient_progress_photos", missing: false },
      { object_path: `${PM}p1/chat-gone`, source: "patient_chat_messages", missing: false },
      { object_path: `${PM}p1/both`, source: "patient_media", missing: false },
      { object_path: `${PM}p1/both`, source: "patient_saved_recipes", missing: false },
    ]);
    mocks.listObjects.mockResolvedValue([]);
    const { c, counts, logs } = ctx();
    await reconcilePrefix(c, PM);
    expect(counts).toMatchObject({ missingUnflaggable: 2, missingFlagged: 1 });
    // A path referenced by a flaggable AND an unflaggable ledger is still flagged.
    expect(flagged).toEqual([{ paths: [`${PM}p1/both`], missing: true }]);
    const logged = logs.find((l) => l.event === "missing_objects_without_flag");
    expect(logged?.detail?.sample).toEqual([`${PM}p1/chat-gone`, `${PM}p1/progress-gone`]);
  });

  it("treats the training clean-up queue as a reference (not an orphan) but never a row to flag", async () => {
    const TV = "/objects/training-videos/";
    const { flagged } = fakeAdmin([
      { object_path: `${TV}v1/queued-delete`, source: "training_media_cleanup", missing: false },
      { object_path: `${TV}v1/queued-and-gone`, source: "training_media_cleanup", missing: false },
    ]);
    mocks.listObjects.mockResolvedValue([{ path: `${TV}v1/queued-delete`, createdAt: daysAgo(9), sizeBytes: 1 }]);
    const { c, counts } = ctx();
    await reconcilePrefix(c, TV);
    expect(mocks.deleteObjectStrict).not.toHaveBeenCalled();
    expect(flagged).toEqual([]);
    expect(counts.missingUnflaggable ?? 0).toBe(0);
  });

  it("dry run reports orphans, missing, and recoverable rows without deleting or flagging", async () => {
    const { flagged } = fakeAdmin([
      { object_path: `${PM}p1/gone`, source: "hq_private_files", missing: false },
      { object_path: `${PM}p1/back`, source: "hq_private_files", missing: true },
    ]);
    mocks.listObjects.mockResolvedValue([
      { path: `${PM}p1/orphan`, createdAt: daysAgo(4), sizeBytes: 1 },
      { path: `${PM}p1/back`, createdAt: daysAgo(4), sizeBytes: 1 },
    ]);
    const { c, counts } = ctx(true);
    await reconcilePrefix(c, PM);
    expect(mocks.deleteObjectStrict).not.toHaveBeenCalled();
    expect(flagged).toEqual([]);
    expect(counts).toMatchObject({ orphansFound: 1, missingFound: 1, recoveredFound: 1 });
  });

  it("records a failed listing as an item failure and carries on with the other prefixes", async () => {
    fakeAdmin([]);
    mocks.listObjects.mockImplementation(async (prefix: string) => {
      if (prefix === "/objects/hq-files/") throw new Error("bucket listing timed out");
      return [];
    });
    const { c, failures, counts } = ctx();
    await reconcileStorage(c);
    expect(failures).toEqual([{ item: "list:/objects/hq-files/", error: "bucket listing timed out" }]);
    expect(mocks.listObjects).toHaveBeenCalledTimes(RECONCILE_PREFIXES.length);
    expect(counts.objects).toBe(0);
  });

  it("pages the ledger when it exceeds one page", async () => {
    const ledger: LedgerRow[] = [];
    for (let i = 0; i < 1500; i += 1) {
      ledger.push({ object_path: `${PM}p/${String(i).padStart(4, "0")}`, source: "patient_media", missing: false });
    }
    fakeAdmin(ledger);
    mocks.listObjects.mockResolvedValue(ledger.map((r) => ({ path: r.object_path, createdAt: daysAgo(3), sizeBytes: 1 })));
    const { c, counts } = ctx();
    await reconcilePrefix(c, PM);
    expect(counts).toMatchObject({ objects: 1500, ledgerRows: 1500 });
    expect(counts.missingFlagged ?? 0).toBe(0);
    expect(mocks.deleteObjectStrict).not.toHaveBeenCalled();
  });
});
