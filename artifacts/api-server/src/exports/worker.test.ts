import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), save: vi.fn(), saveStream: vi.fn(), del: vi.fn(), rollups: vi.fn(), buildRecord: vi.fn() }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/objectStorage", () => ({ objectStorage: { saveBuffer: mocks.save, saveStream: mocks.saveStream, deleteObjectStrict: mocks.del } }));
vi.mock("../routes/operational-rollups", () => ({ loadOfficeRollups: mocks.rollups }));
vi.mock("./patient-record", () => ({ buildPatientRecordArchive: mocks.buildRecord }));
import { csvBuffer, csvCell } from "./csv";
import { AUDIT_EXPORT_ACTIONS, GENERATORS } from "./generators";
import { drainQueuedExports, runExportJob, scopeFromJob, sweepExpiredExports, type ExportJobRow } from "./worker";

function response(json: unknown, status = 200) { return { status, json, contentRange: null }; }
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const job = (overrides: Partial<ExportJobRow> = {}): ExportJobRow => ({
  id: JOB_ID, kind: "office_comparison", status: "running", requested_by: "u", requester_kind: "hq", requester_role: "admin",
  provider_id: null, params: { start: "2026-08-01", end: "2026-09-06" }, file_name: "x.csv", object_path: null, size_bytes: null, row_count: null,
  error: null, attempts: 1, created_at: "2026-09-06T00:00:00Z", started_at: "2026-09-06T00:00:01Z", completed_at: null,
  expires_at: "2026-09-07T00:00:00Z", download_count: 0, last_downloaded_at: null, parts: null, cancel_requested_at: null, ...overrides,
});
const office = (overrides: Record<string, unknown> = {}) => ({
  providerId: "p1", officeName: "=One, Inc", providerName: "Dr One", firstPatientDate: "2026-09-01", available: true,
  metrics: { totalPatients: 3, activePatients: 2, enrollments: 3, engaged: 1, needsAttention: 1, inactive: 0, invited: 1, loggingLapsed: 1, checkInsOverdue: 0, loggingPatients: 1, checkInPatients: 2, loggingAdherencePct: 50, checkInAdherencePct: 100, avgPoundsLost: null },
  ...overrides,
});

beforeEach(() => { mocks.admin.mockReset(); mocks.save.mockReset().mockResolvedValue(undefined); mocks.saveStream.mockReset(); mocks.del.mockReset().mockResolvedValue(undefined); mocks.rollups.mockReset(); mocks.buildRecord.mockReset(); });

describe("csv", () => {
  it("quotes delimiters and neutralises formula-leading cells", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-5 lbs")).toBe("'-5 lbs");
    expect(csvCell(-5)).toBe("'-5");
    expect(csvCell(null)).toBe("");
    expect(csvBuffer(["a"], [["x"]]).toString("utf8")).toBe("\ufeffa\r\nx\r\n");
  });
});

describe("generators", () => {
  it("writes the office comparison with unavailable ranges spelled out, not zeroed", async () => {
    mocks.rollups.mockResolvedValue([office(), office({ providerId: "p2", officeName: "Two", firstPatientDate: null, available: false, metrics: null })]);
    const sheet = await GENERATORS.office_comparison(scopeFromJob(job()));
    expect(mocks.rollups).toHaveBeenCalledWith(null, { start: "2026-08-01", end: "2026-09-06" });
    expect(sheet.header[0]).toBe("Office");
    // Column labels spell out the metric contract staff see in the app.
    expect(sheet.header).toContain("Engaged (7 days to range end)");
    expect(sheet.header).toContain("Avg pounds lost (active patients)");
    expect(sheet.rows[0].slice(0, 7)).toEqual(["=One, Inc", "Dr One", "2026-08-01", "2026-09-06", "2026-09-01", "yes", 3]);
    expect(sheet.rows[1][5]).toBe("no");
    expect(sheet.rows[1][6]).toBe("unavailable");
    const csv = csvBuffer(sheet.header, sheet.rows).toString("utf8");
    expect(csv).toContain("\"'=One, Inc\"");
  });
  it("builds patient activity rows without notes or message text, scoped to one office as of the range end", async () => {
    mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (path.startsWith("/rest/v1/patients?")) {
        expect(path).toContain("provider_id=eq.p1");
        expect(path).not.toMatch(/notes|last_message|email|phone/);
        return response([{ id: "pt1", first_name: "Ann", last_name: "Lee", activation_status: "activated", created_at: "2026-08-01T00:00:00Z", program_start_date: "2026-08-02", starting_weight: 200, current_weight: 190.4, last_log_date: null, last_login_at: null }]);
      }
      if (path.endsWith("provider_patient_operational_summary")) {
        expect(body).toEqual({ p_provider_id: "p1", p_as_of: "2026-09-06" });
        return response([{ patient_id: "pt1", latest_activity_date: "2026-09-05", latest_diary_date: "2026-09-05", latest_check_in_date: "2026-08-20", latest_weight_date: "2026-09-01", logged_days_7: 4, check_ins_7: 0 }]);
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const sheet = await GENERATORS.patient_activity(scopeFromJob(job({ kind: "patient_activity", provider_id: "p1", requester_kind: "provider" })));
    expect(sheet.header).not.toContain("Notes");
    expect(sheet.rows).toHaveLength(1);
    const row = sheet.rows[0];
    expect(row[1]).toBe("Ann Lee");
    expect(row[2]).toBe("active");
    expect(row[9]).toBe(4);
    expect(row[12]).toBe("check_in_overdue");
    expect(row[13]).toBe(9.6);
  });
  it("filters audit events to the office and drops actor ids for office staff", async () => {
    mocks.admin.mockImplementation(async (_m: string, path: string) => {
      expect(path).toContain("provider_id=eq.p1");
      expect(path).toContain(`action=in.(${AUDIT_EXPORT_ACTIONS.join(",")})`);
      return response([{ id: 1, occurred_at: "2026-09-01T00:00:00Z", action: "patient_follow_up_open", actor_user_id: "secret", actor_kind: "provider", provider_id: "p1", target_kind: "patient_follow_up", target_id: "pt", request_id: null, metadata: { reason: "logging_lapsed", note: "never exported" } }]);
    });
    const sheet = await GENERATORS.audit_events(scopeFromJob(job({ kind: "audit_events", provider_id: "p1", requester_kind: "team_member" })));
    expect(sheet.header).not.toContain("Actor user ID");
    expect(sheet.rows[0]).not.toContain("secret");
    expect(sheet.rows[0][sheet.rows[0].length - 1]).toBe("reason=logging_lapsed");
    const hqSheet = await (async () => {
      mocks.admin.mockImplementation(async () => response([{ id: 1, occurred_at: "x", action: "a", actor_user_id: "hq-visible", actor_kind: "hq", provider_id: null, metadata: {} }]));
      return GENERATORS.audit_events(scopeFromJob(job({ kind: "audit_events" })));
    })();
    expect(hqSheet.header).toContain("Actor user ID");
    expect(hqSheet.rows[0]).toContain("hq-visible");
  });
  it("scopes training completion to the office's viewers and excludes demo learners", async () => {
    mocks.admin.mockImplementation(async (_m: string, path: string) => {
      expect(path).toContain("training_viewers.is_demo=eq.false");
      expect(path).toContain("training_viewers.account_id=eq.p1");
      return response([{ viewer_id: "v", video_id: "vid", watch_seconds: 30, first_watched_at: "2026-09-01T00:00:00Z", completed_at: null, training_viewers: { name: "Sam", email: "s@x", account_id: "p1", is_demo: false }, training_videos: { title: "Intro", duration_seconds: 60, training_modules: { title: "M1", training_courses: { title: "C1" } } } }]);
    });
    const sheet = await GENERATORS.training_completion(scopeFromJob(job({ kind: "training_completion", provider_id: "p1" })));
    expect(sheet.rows[0]).toEqual(["Sam", "s@x", "p1", "C1", "M1", "Intro", 60, 30, "2026-09-01T00:00:00Z", "", "no"]);
  });
  it("never puts onboarding codes in the provider directory", async () => {
    mocks.admin.mockImplementation(async (_m: string, path: string) => {
      if (path.startsWith("/rest/v1/providers?")) { expect(path).not.toContain("onboarding_code"); return response([{ provider_id: "p1", office_name: "One", provider_name: "Dr", access_disabled: false, email: "e", phone: "p", city: "c", state: "s", postal_code: "z", plan: "core", provider_role: "owner", claimed_at: null, created_at: "2026-01-01T00:00:00Z" }, { provider_id: "p2", office_name: "Two", access_disabled: false }]); }
      if (path.startsWith("/rest/v1/provider_account_locks?")) return response([{ account_id: "acct-p2", locked_at: "2026-02-02T00:00:00Z" }]);
      if (path.startsWith("/rest/v1/patients?")) return response([{ provider_id: "p1" }, { provider_id: "p1" }]);
      throw new Error(path);
    });
    const sheet = await GENERATORS.provider_directory(scopeFromJob(job({ kind: "provider_directory", params: {} })));
    expect(sheet.rows[0][5]).toBe("active");
    expect(sheet.rows[0][12]).toBe(2);
    expect(sheet.rows[1][5]).toBe("locked");
    expect(sheet.rows[1][6]).toBe("2026-02-02T00:00:00Z");
  });
});

describe("job lifecycle", () => {
  it("writes the file under a path bound to the job id and marks the row ready with size and row count", async () => {
    mocks.rollups.mockResolvedValue([office()]);
    const patches: Array<[string, Record<string, unknown>]> = [];
    mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "PATCH") { patches.push([path, body!]); return response([{ id: JOB_ID }]); }
      throw new Error(path);
    });
    await runExportJob(job());
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const [objectPath, buffer, contentType] = mocks.save.mock.calls[0];
    expect(objectPath).toMatch(new RegExp(`^/objects/exports/${JOB_ID}/export-[0-9a-f-]{36}\\.csv$`));
    expect(contentType).toContain("text/csv");
    expect(patches).toHaveLength(1);
    expect(patches[0][0]).toContain("status=eq.running");
    expect(patches[0][1]).toMatchObject({ status: "ready", object_path: objectPath, size_bytes: (buffer as Buffer).byteLength, row_count: 1 });
  });
  it("records a failed job with a short error and no file", async () => {
    mocks.rollups.mockRejectedValue(new Error("rpc blew up at https://internal.host/x"));
    const patches: Record<string, unknown>[] = [];
    mocks.admin.mockImplementation(async (method: string, _path: string, body?: Record<string, unknown>) => { if (method === "PATCH") { patches.push(body!); return response([{ id: JOB_ID }]); } throw new Error("unexpected"); });
    await runExportJob(job());
    expect(mocks.save).not.toHaveBeenCalled();
    expect(patches[0]).toMatchObject({ status: "failed" });
    expect(patches[0].error).toBe("rpc blew up at [url]");
  });
  it("removes the file again if the row moved on while generating", async () => {
    mocks.rollups.mockResolvedValue([office()]);
    // The cancel check still sees a running row; the row is gone only by the time the ready flip runs.
    mocks.admin.mockImplementation(async (method: string) => (method === "PATCH" ? response([]) : response([{ status: "running", cancel_requested_at: null }])));
    await runExportJob(job());
    expect(mocks.del).toHaveBeenCalledWith(mocks.save.mock.calls[0][0]);
  });
  it("drains the queue through the claim RPC until it returns nothing", async () => {
    mocks.rollups.mockResolvedValue([]);
    let claims = 0;
    mocks.admin.mockImplementation(async (method: string, path: string) => {
      if (path.endsWith("claim_next_data_export")) { claims += 1; return response(claims <= 2 ? [job({ id: `4444444${claims}-4444-4444-8444-444444444444` })] : []); }
      if (method === "PATCH") return response([{ id: 1 }]);
      throw new Error(path);
    });
    expect(await drainQueuedExports()).toBe(2);
    expect(claims).toBe(3);
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });
  it("streams every patient record part to storage and records the set in one ready flip", async () => {
    const patches: Array<[string, Record<string, unknown>]> = [];
    mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "PATCH") { patches.push([path, body!]); return response([{ id: JOB_ID }]); }
      throw new Error(path);
    });
    mocks.saveStream.mockImplementation(async (path: string) => ({ sizeBytes: path.includes("part-01") ? 10 : 20 }));
    mocks.buildRecord.mockImplementation(async (patientId: string, options: { fileNameStem: string; writePart: (p: { part: number; fileName: string }, s: unknown) => Promise<{ sizeBytes: number }>; onPartWritten?: (d: number, t: number) => Promise<void> }) => {
      expect(patientId).toBe("pt1");
      expect(options.fileNameStem).toBe("thinnr_patient-record_ann-lee_2026-09-06");
      const parts = [];
      for (const part of [1, 2]) {
        const fileName = `${options.fileNameStem}_part-0${part}-of-02.zip`;
        const { sizeBytes } = await options.writePart({ part, fileName }, "stream");
        parts.push({ part, fileName, sizeBytes, fileCount: part === 1 ? 20 : 3 });
        await options.onPartWritten?.(part, 2);
      }
      return { parts, manifest: { fileCount: 23, omitted: [{ file: "media/x.jpg" }] } };
    });
    await runExportJob(job({ kind: "patient_record", provider_id: "p1", requester_kind: "provider", params: { officeName: "One", patientId: "pt1", patientName: "Ann Lee" }, file_name: "thinnr_patient-record_ann-lee_2026-09-06.zip" }));
    expect(mocks.saveStream).toHaveBeenCalledTimes(2);
    const [path1, , type1] = mocks.saveStream.mock.calls[0];
    expect(path1).toMatch(new RegExp(`^/objects/exports/${JOB_ID}/record-part-01-[0-9a-f-]{36}\\.zip$`));
    expect(type1).toBe("application/zip");
    // Every patch is guarded on status=running; progress is visible along the way.
    expect(patches.every(([path]) => path.includes("status=eq.running"))).toBe(true);
    expect(patches.map(([, body]) => (body.params as { progress: { stage: string; partsDone?: number } }).progress)).toEqual([
      { stage: "collecting" }, { stage: "writing", partsDone: 0 }, { stage: "writing", partsDone: 1, partsTotal: 2 }, { stage: "writing", partsDone: 2, partsTotal: 2 }, { stage: "ready", partsDone: 2, partsTotal: 2 },
    ]);
    const ready = patches[patches.length - 1][1];
    expect(ready).toMatchObject({ status: "ready", object_path: path1, size_bytes: 30, row_count: 23, params: { patientId: "pt1", omitted: 1 } });
    expect(ready.parts).toEqual([
      { part: 1, fileName: "thinnr_patient-record_ann-lee_2026-09-06_part-01-of-02.zip", objectPath: path1, sizeBytes: 10, fileCount: 20 },
      { part: 2, fileName: "thinnr_patient-record_ann-lee_2026-09-06_part-02-of-02.zip", objectPath: mocks.saveStream.mock.calls[1][0], sizeBytes: 20, fileCount: 3 },
    ]);
    expect(mocks.del).not.toHaveBeenCalled();
  });
  it("removes every written part when the record build fails, then marks the job failed", async () => {
    const patches: Array<[string, Record<string, unknown>]> = [];
    mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "PATCH") { patches.push([path, body!]); return response([{ id: JOB_ID }]); }
      throw new Error(path);
    });
    mocks.saveStream.mockResolvedValue({ sizeBytes: 5 });
    mocks.buildRecord.mockImplementation(async (_id: string, options: { writePart: (p: { part: number; fileName: string }, s: unknown) => Promise<unknown> }) => {
      await options.writePart({ part: 1, fileName: "a.zip" }, "s");
      throw new Error("object read failed https://storage.example/secret");
    });
    await runExportJob(job({ kind: "patient_record", provider_id: "p1", params: { patientId: "pt1", patientName: "Ann" }, file_name: "x.zip" }));
    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.del.mock.calls[0][0]).toBe(mocks.saveStream.mock.calls[0][0]);
    const failed = patches[patches.length - 1][1];
    expect(failed).toMatchObject({ status: "failed", error: "object read failed [url]" });
  });
  it("stops a record build at the next checkpoint once cancelled, removes the written parts, and marks the job cancelled", async () => {
    const patches: Array<[string, Record<string, unknown>]> = [];
    let cancelRequested: string | null = null;
    mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "PATCH") { patches.push([path, body!]); return response([{ id: JOB_ID }]); }
      if (method === "GET" && path.startsWith(`/rest/v1/data_exports?id=eq.${JOB_ID}`)) {
        expect(path).toContain("select=status,cancel_requested_at");
        return response([{ status: "running", cancel_requested_at: cancelRequested }]);
      }
      throw new Error(path);
    });
    mocks.saveStream.mockResolvedValue({ sizeBytes: 5 });
    mocks.buildRecord.mockImplementation(async (_id: string, options: { writePart: (p: { part: number; fileName: string }, s: unknown) => Promise<unknown>; checkpoint: () => Promise<void> }) => {
      await options.checkpoint();
      await options.writePart({ part: 1, fileName: "a.zip" }, "s");
      cancelRequested = "2026-09-06T00:00:05Z"; // staff hit Cancel while part 1 streamed
      await options.checkpoint(); // throttled: same instant, still cached as "not cancelled"
      await options.writePart({ part: 2, fileName: "b.zip" }, "s");
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
      await options.checkpoint(); // re-reads the row, sees the cancel, throws
      throw new Error("must not reach part 3");
    });
    await runExportJob(job({ kind: "patient_record", provider_id: "p1", params: { patientId: "pt1", patientName: "Ann" }, file_name: "x.zip" }));
    vi.restoreAllMocks();
    expect(mocks.saveStream).toHaveBeenCalledTimes(2);
    expect(mocks.del.mock.calls.map(([path]) => path).sort()).toEqual(mocks.saveStream.mock.calls.map(([path]) => path).sort());
    const last = patches[patches.length - 1];
    expect(last[0]).toContain("status=eq.running");
    expect(last[1]).toMatchObject({ status: "cancelled", object_path: null, parts: null, error: null });
    expect(patches.some(([, body]) => body.status === "failed" || body.status === "ready")).toBe(false);
  });
  it("never lands a record as ready once cancelled: a lost ready flip deletes the parts and cancels instead", async () => {
    const patches: Array<[string, Record<string, unknown>]> = [];
    mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "PATCH") {
        patches.push([path, body!]);
        // The ready flip carries the not-cancelled guard and finds nothing (cancel_requested_at was set).
        if (body?.status === "ready") { expect(path).toContain("status=eq.running&cancel_requested_at=is.null"); return response([]); }
        return response([{ id: JOB_ID }]);
      }
      if (method === "GET") return response([{ status: "running", cancel_requested_at: null }]);
      throw new Error(path);
    });
    mocks.saveStream.mockResolvedValue({ sizeBytes: 5 });
    mocks.buildRecord.mockImplementation(async (_id: string, options: { writePart: (p: { part: number; fileName: string }, s: unknown) => Promise<unknown> }) => {
      await options.writePart({ part: 1, fileName: "a.zip" }, "s");
      return { parts: [{ part: 1, fileName: "a.zip", sizeBytes: 5, fileCount: 3 }], manifest: { fileCount: 3, omitted: [] } };
    });
    await runExportJob(job({ kind: "patient_record", provider_id: "p1", params: { patientId: "pt1", patientName: "Ann" }, file_name: "x.zip" }));
    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.del.mock.calls[0][0]).toBe(mocks.saveStream.mock.calls[0][0]);
    expect(patches[patches.length - 1][1]).toMatchObject({ status: "cancelled" });
  });
  it("cancels a CSV export before any file is written when the cancel landed while rows were gathered", async () => {
    const patches: Array<[string, Record<string, unknown>]> = [];
    mocks.rollups.mockResolvedValue([office()]);
    mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "PATCH") { patches.push([path, body!]); return response([{ id: JOB_ID }]); }
      if (method === "GET") return response([{ status: "running", cancel_requested_at: "2026-09-06T00:00:02Z" }]);
      throw new Error(path);
    });
    await runExportJob(job());
    expect(mocks.save).not.toHaveBeenCalled();
    expect(patches).toHaveLength(1);
    expect(patches[0][0]).toContain("status=eq.running");
    expect(patches[0][1]).toMatchObject({ status: "cancelled", object_path: null });
  });
  it("expires past-due jobs by deleting the object first, keeps rows whose delete failed, and prunes old expired rows", async () => {
    const patches: Array<[string, Record<string, unknown>]> = [];
    mocks.del.mockImplementation(async (path: string) => { if (path.includes("boom")) throw new Error("storage down"); });
    mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "GET") { expect(path).toContain("status=in.(queued,running,ready,failed,cancelled)"); expect(path).toContain("select=id,object_path,parts,status"); return response([{ id: "a", object_path: "/objects/exports/a/export-1.csv", status: "ready" }, { id: "b", object_path: "/objects/exports/b/boom.csv", status: "ready" }, { id: "c", object_path: null, status: "queued" }, { id: "d", object_path: "/objects/exports/d/record-part-01-x.zip", parts: [{ part: 1, objectPath: "/objects/exports/d/record-part-01-x.zip" }, { part: 2, objectPath: "/objects/exports/d/record-part-02-y.zip" }], status: "ready" }]); }
      if (method === "PATCH") { patches.push([path, body!]); return response([{ id: 1 }]); }
      if (method === "DELETE") { expect(path).toContain("status=eq.expired"); return response([{ id: "old" }]); }
      throw new Error(path);
    });
    const result = await sweepExpiredExports(new Date("2026-09-06T00:00:00Z"));
    expect(result).toEqual({ expired: 3, pruned: 1 });
    expect(patches.map(([path]) => path)).toEqual([expect.stringContaining("id=eq.a"), expect.stringContaining("id=eq.c"), expect.stringContaining("id=eq.d")]);
    // Both parts of the multi-part record go, not just the object_path.
    expect(mocks.del.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(["/objects/exports/d/record-part-01-x.zip", "/objects/exports/d/record-part-02-y.zip"]));
    expect(mocks.del).toHaveBeenCalledTimes(4);
    expect(patches[0][1]).toEqual({ status: "expired", object_path: null, parts: null });
    expect(patches[1][1]).toMatchObject({ status: "expired", error: "Expired before it could finish." });
  });
});
