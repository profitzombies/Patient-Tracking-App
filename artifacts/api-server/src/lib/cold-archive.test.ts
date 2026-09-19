import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), save: vi.fn(), policy: vi.fn() }));
vi.mock("./supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("./objectStorage", () => ({ objectStorage: { saveBufferAt: mocks.save } }));
vi.mock("./org-policy", () => ({ loadOrgPolicy: mocks.policy }));

import {
  COLD_ARCHIVE_ENV,
  COLD_ARCHIVE_NOT_CONFIGURED,
  coldArchiveConfigured,
  coldArchiveObjectDir,
  defaultColdArchiveStore,
  readColdArchiveHealth,
  readColdArchiveStatus,
  utcDay,
  validateColdArchiveStartup,
} from "./cold-archive";

const NOW = new Date("2026-09-18T03:15:00Z");

describe("cold archive storage prefix knob", () => {
  it("is unset when blank (never a zero-length prefix) and normalised when set", () => {
    expect(coldArchiveObjectDir({})).toBeNull();
    expect(coldArchiveObjectDir({ [COLD_ARCHIVE_ENV]: "" })).toBeNull();
    expect(coldArchiveObjectDir({ [COLD_ARCHIVE_ENV]: "   " })).toBeNull();
    expect(coldArchiveConfigured({ [COLD_ARCHIVE_ENV]: "" })).toBe(false);
    expect(coldArchiveObjectDir({ [COLD_ARCHIVE_ENV]: "/bucket-1/cold" })).toBe("/bucket-1/cold");
    expect(coldArchiveObjectDir({ [COLD_ARCHIVE_ENV]: " bucket-1/cold/archive// " })).toBe("/bucket-1/cold/archive");
    expect(coldArchiveConfigured({ [COLD_ARCHIVE_ENV]: "/bucket-1/cold" })).toBe(true);
  });

  it("rejects a bucket without a prefix, blanks inside, and empty segments", () => {
    for (const bad of ["/bucket-only", "bucket-only", "/bucket//cold", "/bucket/co ld", "/"]) {
      expect(() => coldArchiveObjectDir({ [COLD_ARCHIVE_ENV]: bad }), bad).toThrow(/COLD_ARCHIVE_OBJECT_DIR must look like/);
    }
  });

  it("at startup: malformed throws, enabled-without-prefix reports an error, otherwise ok", () => {
    expect(() => validateColdArchiveStartup({ enabled: false, env: { [COLD_ARCHIVE_ENV]: "/nope" } })).toThrow(/must look like/);
    expect(validateColdArchiveStartup({ enabled: true, env: {} })).toEqual({ ok: false, error: COLD_ARCHIVE_NOT_CONFIGURED });
    expect(validateColdArchiveStartup({ enabled: false, env: {} })).toEqual({ ok: true });
    expect(validateColdArchiveStartup({ enabled: true, env: { [COLD_ARCHIVE_ENV]: "/b/cold" } })).toEqual({ ok: true });
  });
});

describe("default cold archive store", () => {
  const saved = process.env[COLD_ARCHIVE_ENV];
  beforeEach(() => { mocks.save.mockReset().mockResolvedValue(undefined); });
  afterEach(() => {
    if (saved === undefined) delete process.env[COLD_ARCHIVE_ENV];
    else process.env[COLD_ARCHIVE_ENV] = saved;
  });

  it("writes under the configured prefix and refuses when the prefix is unset", async () => {
    process.env[COLD_ARCHIVE_ENV] = "/bucket-1/cold/";
    await defaultColdArchiveStore.put("archive/billing_orders/2026/09/17.ndjson.gz", Buffer.from("x"), "application/gzip");
    expect(mocks.save).toHaveBeenCalledWith("/bucket-1/cold/archive/billing_orders/2026/09/17.ndjson.gz", Buffer.from("x"), "application/gzip");
    delete process.env[COLD_ARCHIVE_ENV];
    await expect(defaultColdArchiveStore.put("archive/x", Buffer.from("x"), "application/gzip")).rejects.toThrow(COLD_ARCHIVE_NOT_CONFIGURED);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});

describe("cold archive status and health reads", () => {
  beforeEach(() => {
    mocks.admin.mockReset();
    mocks.policy.mockReset().mockResolvedValue({ coldArchiveEnabled: true });
  });

  it("asks the status function for today's UTC day and normalises bigint strings", async () => {
    mocks.admin.mockResolvedValue({
      status: 200,
      json: [{ earliest_day: "2026-08-01", last_archived_day: "2026-09-16", last_archived_at: "2026-09-17T02:00:00+00:00", days_archived: "47", days_pending: "1", rows_archived: "1284311", bytes_written: "3543348224" }],
    });
    expect(utcDay(NOW)).toBe("2026-09-18");
    await expect(readColdArchiveStatus(NOW)).resolves.toEqual({
      earliestDay: "2026-08-01", lastArchivedDay: "2026-09-16", lastArchivedAt: "2026-09-17T02:00:00+00:00",
      daysArchived: 47, daysPending: 1, rowsArchived: 1_284_311, bytesWritten: 3_543_348_224,
    });
    expect(mocks.admin).toHaveBeenCalledWith("POST", "/rest/v1/rpc/cold_archive_status", { p_today: "2026-09-18" });
  });

  it("reads an empty ledger as nulls and zeros, and fails loudly on a bad response", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [{ earliest_day: null, last_archived_day: null, last_archived_at: null, days_archived: 0, days_pending: 0, rows_archived: 0, bytes_written: 0 }] });
    await expect(readColdArchiveStatus(NOW)).resolves.toMatchObject({ earliestDay: null, lastArchivedDay: null, daysPending: 0, bytesWritten: 0 });
    mocks.admin.mockResolvedValueOnce({ status: 404, json: null });
    await expect(readColdArchiveStatus(NOW)).rejects.toThrow(/status read failed \(404\)/);
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [] });
    await expect(readColdArchiveStatus(NOW)).rejects.toThrow(/no row/);
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [{ days_pending: "lots" }] });
    await expect(readColdArchiveStatus(NOW)).rejects.toThrow(/non-numeric/);
  });

  it("health combines the toggle, the knob, and the ledger tallies", async () => {
    const status = async () => ({ earliestDay: "2026-08-01", lastArchivedDay: "2026-09-16", lastArchivedAt: null, daysArchived: 47, daysPending: 1, rowsArchived: 5, bytesWritten: 9 });
    await expect(readColdArchiveHealth(NOW, { status, env: { [COLD_ARCHIVE_ENV]: "/b/cold" } })).resolves.toEqual({
      enabled: true, storageConfigured: true, earliestDay: "2026-08-01", lastArchivedDay: "2026-09-16", lastArchivedAt: null, daysArchived: 47, daysPending: 1, rowsArchived: 5, bytesWritten: 9,
    });
    await expect(readColdArchiveHealth(NOW, { enabled: async () => false, status, env: {} })).resolves.toMatchObject({ enabled: false, storageConfigured: false });
    expect(mocks.policy).toHaveBeenCalledTimes(1);
  });
});
