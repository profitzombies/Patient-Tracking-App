import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  deleteObjectStrict: vi.fn(),
}));
vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../../lib/objectStorage", () => ({ objectStorage: { deleteObjectStrict: mocks.deleteObjectStrict } }));

import { sweepAbandonedUploads, uploadGraceMs } from "./abandoned-uploads";
import type { JobContext } from "../types";

const NOW = new Date("2026-09-07T12:00:00Z");

function ctx(dryRun = false) {
  const counts: Record<string, number> = {};
  const failures: Array<{ item: string; error: string }> = [];
  const c: JobContext = {
    dryRun,
    now: NOW,
    tally: (k, by = 1) => { counts[k] = (counts[k] ?? 0) + by; },
    failItem: (item, error) => { failures.push({ item, error: error instanceof Error ? error.message : String(error) }); },
    leaseLost: false,
    checkpoint: () => undefined,
    log: () => undefined,
  };
  return { c, counts, failures };
}

interface Intent { object_path: string; surface: string; issued_at: string }

/** Fake PostgREST for storage_upload_intents + the reference RPC. */
function fakeAdmin(intents: Intent[], referenced: string[]) {
  const deletedIntents: string[] = [];
  mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
    if (path === "/rest/v1/rpc/storage_referenced_paths") {
      const asked = body?.p_paths as string[];
      return { status: 200, json: referenced.filter((p) => asked.includes(p)) };
    }
    if (method === "GET" && path.startsWith("/rest/v1/storage_upload_intents")) {
      const url = new URL(`http://x${path}`);
      const cutoff = url.searchParams.get("issued_at")!.replace("lt.", "");
      const after = url.searchParams.get("object_path")?.replace("gt.", "") ?? "";
      const limit = Number(url.searchParams.get("limit"));
      const rows = intents
        .filter((i) => !deletedIntents.includes(i.object_path) && i.issued_at < cutoff && i.object_path > after)
        .sort((a, b) => a.object_path.localeCompare(b.object_path))
        .slice(0, limit);
      return { status: 200, json: rows };
    }
    if (method === "DELETE" && path.startsWith("/rest/v1/storage_upload_intents")) {
      const raw = decodeURIComponent(path.split("object_path=in.(")[1].slice(0, -1));
      for (const m of raw.matchAll(/"([^"]+)"/g)) deletedIntents.push(m[1]);
      return { status: 204, json: null };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { deletedIntents };
}

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("abandoned-upload sweep", () => {
  beforeEach(() => {
    mocks.admin.mockReset();
    mocks.deleteObjectStrict.mockReset().mockResolvedValue(undefined);
    delete process.env.JOBS_UPLOAD_GRACE_MS;
  });

  it("defaults the grace window to six hours and ignores blank env", () => {
    process.env.JOBS_UPLOAD_GRACE_MS = "";
    expect(uploadGraceMs()).toBe(6 * 3_600_000);
    process.env.JOBS_UPLOAD_GRACE_MS = "1000";
    expect(uploadGraceMs()).toBe(1000);
  });

  it("deletes only unreferenced intents past the grace window and retires finalized ones", async () => {
    const { deletedIntents } = fakeAdmin(
      [
        { object_path: "/objects/patient-media/p1/food-old", surface: "patient_media", issued_at: hoursAgo(7) },
        { object_path: "/objects/patient-media/p1/food-fresh", surface: "patient_media", issued_at: hoursAgo(1) },
        { object_path: "/objects/hq-files/f1/file-done", surface: "hq_file", issued_at: hoursAgo(30) },
        { object_path: "/objects/knowledge-docs/k1/doc-old", surface: "knowledge_document", issued_at: hoursAgo(6.01) },
      ],
      ["/objects/hq-files/f1/file-done"],
    );
    const { c, counts, failures } = ctx();
    await sweepAbandonedUploads(c);
    expect(mocks.deleteObjectStrict.mock.calls.map((call) => call[0]).sort()).toEqual([
      "/objects/knowledge-docs/k1/doc-old",
      "/objects/patient-media/p1/food-old",
    ]);
    expect(deletedIntents.sort()).toEqual([
      "/objects/hq-files/f1/file-done",
      "/objects/knowledge-docs/k1/doc-old",
      "/objects/patient-media/p1/food-old",
    ]);
    expect(counts).toEqual({ scanned: 3, finalized: 1, deleted: 2, deleted_patient_media: 1, deleted_knowledge_document: 1 });
    expect(failures).toEqual([]);
  });

  it("keeps the intent when the byte delete fails so the next run retries it", async () => {
    const { deletedIntents } = fakeAdmin(
      [{ object_path: "/objects/training-videos/v1/video-x", surface: "training_video", issued_at: hoursAgo(10) }],
      [],
    );
    mocks.deleteObjectStrict.mockRejectedValueOnce(new Error("503 from storage"));
    const { c, counts, failures } = ctx();
    await sweepAbandonedUploads(c);
    expect(deletedIntents).toEqual([]);
    expect(counts).toEqual({ scanned: 1 });
    expect(failures).toEqual([{ item: "/objects/training-videos/v1/video-x", error: "503 from storage" }]);
  });

  it("dry run counts what would go and touches nothing", async () => {
    const { deletedIntents } = fakeAdmin(
      [
        { object_path: "/objects/patient-media/p1/a", surface: "patient_media", issued_at: hoursAgo(9) },
        { object_path: "/objects/patient-media/p1/b", surface: "patient_media", issued_at: hoursAgo(9) },
      ],
      ["/objects/patient-media/p1/b"],
    );
    const { c, counts } = ctx(true);
    await sweepAbandonedUploads(c);
    expect(mocks.deleteObjectStrict).not.toHaveBeenCalled();
    expect(deletedIntents).toEqual([]);
    expect(counts).toEqual({ scanned: 2, finalized: 1, wouldDelete: 1, wouldDelete_patient_media: 1 });
  });

  it("pages through more than one batch by object path", async () => {
    const intents: Intent[] = [];
    for (let i = 0; i < 250; i += 1) {
      intents.push({ object_path: `/objects/patient-media/p/${String(i).padStart(3, "0")}`, surface: "patient_media", issued_at: hoursAgo(8) });
    }
    fakeAdmin(intents, []);
    const { c, counts } = ctx();
    await sweepAbandonedUploads(c);
    expect(counts.scanned).toBe(250);
    expect(counts.deleted).toBe(250);
  });

  it("fails the run loudly when the intent scan is unavailable", async () => {
    mocks.admin.mockResolvedValue({ status: 500, json: null });
    await expect(sweepAbandonedUploads(ctx().c)).rejects.toThrow("upload intent scan failed (500)");
  });
});
