import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  generate: vi.fn(),
}));
vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../../lib/photo-variants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/photo-variants")>();
  return { ...actual, generatePhotoVariants: mocks.generate };
});

import { BACKFILL_BATCH, backfillPhotoVariants, photoVariantsBackfillJob, variantRetryMs } from "./photo-variants-backfill";
import type { JobContext } from "../types";

const NOW = new Date("2026-09-18T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const PM = "/objects/patient-media/p1/";

interface Row {
  object_path: string;
  kind: string;
  variants: string[];
  variants_attempted_at: string | null;
  object_missing_at?: string | null;
}

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

/** In-memory patient_media honouring the queue filter and keyset paging. */
function fakeAdmin(rows: Row[]) {
  const patches: Array<{ path: string; body: Record<string, unknown> }> = [];
  let reads = 0;
  mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
    if (method === "GET" && path.startsWith("/rest/v1/patient_media?select=object_path,variants,variants_attempted_at")) {
      reads += 1;
      expect(path).toContain("kind=in.(progress,chat)");
      expect(path).toContain("object_missing_at=is.null");
      expect(path).toContain("variants=not.cs.{thumb,medium}");
      const after = decodeURIComponent(path.split("object_path=gt.")[1].split("&")[0]);
      const limit = Number(path.split("limit=")[1]);
      const page = rows
        .filter((r) => (r.kind === "progress" || r.kind === "chat") && !r.object_missing_at)
        .filter((r) => !(r.variants.includes("thumb") && r.variants.includes("medium")))
        .filter((r) => r.object_path > after)
        .sort((a, b) => a.object_path.localeCompare(b.object_path))
        .slice(0, limit)
        .map(({ object_path, variants, variants_attempted_at }) => ({ object_path, variants, variants_attempted_at }));
      return { status: 200, json: page };
    }
    if (method === "PATCH" && path.startsWith("/rest/v1/patient_media?object_path=eq.")) {
      const target = decodeURIComponent(path.split("object_path=eq.")[1]);
      const row = rows.find((r) => r.object_path === target);
      if (!row) return { status: 404, json: null };
      row.variants = body?.variants as string[];
      row.variants_attempted_at = body?.variants_attempted_at as string;
      patches.push({ path: target, body: body ?? {} });
      return { status: 204, json: null };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { patches, reads: () => reads };
}

describe("photo variant backfill", () => {
  beforeEach(() => {
    mocks.admin.mockReset();
    mocks.generate.mockReset().mockResolvedValue(["thumb", "medium"]);
    delete process.env.JOBS_PHOTO_VARIANT_RETRY_MS;
  });

  it("is registered on the leased ledger with an hourly schedule", () => {
    expect(photoVariantsBackfillJob.name).toBe("photo-variants-backfill");
    expect(photoVariantsBackfillJob.intervalMs).toBe(3_600_000);
    expect(variantRetryMs()).toBe(7 * 86_400_000);
  });

  it("generates variants for eligible rows only and records each success on the row", async () => {
    const rows: Row[] = [
      { object_path: `${PM}progress-a`, kind: "progress", variants: [], variants_attempted_at: null },
      { object_path: `${PM}chat-b`, kind: "chat", variants: ["thumb"], variants_attempted_at: null },
      { object_path: `${PM}food-c`, kind: "food", variants: [], variants_attempted_at: null },
      { object_path: `${PM}progress-d`, kind: "progress", variants: ["thumb", "medium"], variants_attempted_at: daysAgo(1) },
      { object_path: `${PM}progress-e`, kind: "progress", variants: [], variants_attempted_at: null, object_missing_at: daysAgo(2) },
    ];
    const { patches } = fakeAdmin(rows);
    const { c, counts, failures } = ctx();
    await backfillPhotoVariants(c);
    expect(mocks.generate.mock.calls.map((call) => call[0])).toEqual([`${PM}chat-b`, `${PM}progress-a`]);
    expect(patches.map((p) => p.path)).toEqual([`${PM}chat-b`, `${PM}progress-a`]);
    expect(patches[0].body).toEqual({ variants: ["thumb", "medium"], variants_attempted_at: NOW.toISOString() });
    expect(rows[0].variants).toEqual(["thumb", "medium"]);
    expect(counts).toEqual({ scanned: 2, generated: 2 });
    expect(failures).toEqual([]);
  });

  it("is idempotent: a second run finds nothing left to do", async () => {
    const rows: Row[] = [
      { object_path: `${PM}progress-a`, kind: "progress", variants: [], variants_attempted_at: null },
    ];
    fakeAdmin(rows);
    await backfillPhotoVariants(ctx().c);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    const second = ctx();
    await backfillPhotoVariants(second.c);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(second.counts).toEqual({});
  });

  it("dry run counts due rows and touches nothing", async () => {
    const rows: Row[] = [
      { object_path: `${PM}progress-a`, kind: "progress", variants: [], variants_attempted_at: null },
      { object_path: `${PM}chat-b`, kind: "chat", variants: [], variants_attempted_at: daysAgo(1) },
    ];
    const { patches } = fakeAdmin(rows);
    const { c, counts } = ctx(true);
    await backfillPhotoVariants(c);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
    expect(counts).toEqual({ scanned: 2, due: 1, waitingRetry: 1 });
  });

  it("stamps a failed render so the row waits out the retry window, then retries it", async () => {
    const rows: Row[] = [
      { object_path: `${PM}progress-bad`, kind: "progress", variants: [], variants_attempted_at: null },
      { object_path: `${PM}progress-old-fail`, kind: "progress", variants: [], variants_attempted_at: daysAgo(8) },
      { object_path: `${PM}progress-recent-fail`, kind: "progress", variants: ["thumb"], variants_attempted_at: daysAgo(2) },
    ];
    const { patches } = fakeAdmin(rows);
    mocks.generate.mockImplementation(async (path: string) => {
      if (path.endsWith("progress-bad")) throw new Error("Input buffer contains unsupported image format");
      return ["thumb", "medium"];
    });
    const { c, counts, failures } = ctx();
    await backfillPhotoVariants(c);
    expect(mocks.generate.mock.calls.map((call) => call[0])).toEqual([`${PM}progress-bad`, `${PM}progress-old-fail`]);
    expect(failures).toEqual([{ item: `${PM}progress-bad`, error: "Input buffer contains unsupported image format" }]);
    expect(patches.find((p) => p.path.endsWith("progress-bad"))?.body).toEqual({ variants: [], variants_attempted_at: NOW.toISOString() });
    expect(rows[2].variants).toEqual(["thumb"]);
    expect(counts).toEqual({ scanned: 3, generated: 1, waitingRetry: 1 });
  });

  it("walks the queue page by page without re-reading handled rows", async () => {
    const rows: Row[] = Array.from({ length: BACKFILL_BATCH + 5 }, (_, i) => ({
      object_path: `${PM}progress-${String(i).padStart(3, "0")}`,
      kind: "progress",
      variants: [],
      variants_attempted_at: null,
    }));
    const { reads } = fakeAdmin(rows);
    const { c, counts } = ctx();
    await backfillPhotoVariants(c);
    expect(counts).toEqual({ scanned: BACKFILL_BATCH + 5, generated: BACKFILL_BATCH + 5 });
    expect(reads()).toBe(2);
    expect(new Set(mocks.generate.mock.calls.map((call) => call[0])).size).toBe(BACKFILL_BATCH + 5);
  });
});
