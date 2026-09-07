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

import { RECONCILE_PREFIXES, orphanGraceMs, reconcilePrefix, reconcileStorage } from "./reconcile-storage";
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

function fakeAdmin(ledger: LedgerRow[], intents: string[] = []) {
  const flagged: Array<{ paths: string[]; missing: boolean }> = [];
  mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
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
    if (method === "GET" && path.startsWith("/rest/v1/storage_upload_intents")) {
      const raw = decodeURIComponent(path.split("object_path=in.(")[1].slice(0, -1));
      const asked = [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      return { status: 200, json: intents.filter((p) => asked.includes(p)).map((p) => ({ object_path: p })) };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { flagged };
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
      "/objects/hq-files/",
      "/objects/training-videos/",
      "/objects/training-attachments/",
      "/objects/knowledge-docs/",
      "/objects/exports/",
    ]);
    expect(orphanGraceMs()).toBe(86_400_000);
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
