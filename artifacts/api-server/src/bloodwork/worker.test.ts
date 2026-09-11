import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../jobs/types";

const mocks = vi.hoisted(() => {
  class MockBloodworkDocumentError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = "BloodworkDocumentError";
    }
  }
  return {
    supabaseAdmin: vi.fn(),
    readObjectBounded: vi.fn(),
    inspectBloodworkFile: vi.fn(),
    prepareBloodworkPages: vi.fn(),
    transcribeBloodworkPage: vi.fn(),
    signalJob: vi.fn(),
    BloodworkDocumentError: MockBloodworkDocumentError,
  };
});

vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.supabaseAdmin }));
vi.mock("../lib/objectStorage", () => ({
  objectStorage: { readObjectBounded: mocks.readObjectBounded },
}));
vi.mock("../bloodwork/documents", () => ({
  BLOODWORK_MAX_FILE_BYTES: 20_000_000,
  BloodworkDocumentError: mocks.BloodworkDocumentError,
  inspectBloodworkFile: mocks.inspectBloodworkFile,
  isReportLocalBloodworkDocumentError: (error: unknown) =>
    error instanceof mocks.BloodworkDocumentError && error.code !== "PROCESSING_BUSY",
  prepareBloodworkPages: mocks.prepareBloodworkPages,
}));
vi.mock("../bloodwork/extraction", () => ({
  BloodworkTranscriptionError: class BloodworkTranscriptionError extends Error {},
  BLOODWORK_TRANSCRIPTION_TIMEOUT_MS: 90_000,
  transcribeBloodworkPage: mocks.transcribeBloodworkPage,
}));
vi.mock("../jobs/scheduler", () => ({ signalJob: mocks.signalJob }));

import { runBloodworkExtraction } from "../jobs/definitions/bloodwork-extraction";

const REPORT = "00000000-0000-4000-8000-000000000101";
const FILE = "00000000-0000-4000-8000-000000000102";
const TOKEN = "00000000-0000-4000-8000-000000000103";

function response(json: unknown, status = 200) {
  return { status, json };
}

function context(): JobContext {
  return {
    dryRun: false,
    now: new Date("2026-10-09T00:00:00Z"),
    tally: vi.fn(),
    failItem: vi.fn(),
    log: vi.fn(),
    checkpoint: vi.fn(),
    leaseLost: false,
  };
}

describe("bloodwork extraction worker progress protocol", () => {
  beforeEach(() => {
    mocks.supabaseAdmin.mockReset();
    mocks.readObjectBounded.mockReset();
    mocks.inspectBloodworkFile.mockReset();
    mocks.prepareBloodworkPages.mockReset();
    mocks.transcribeBloodworkPage.mockReset();
    mocks.signalJob.mockReset();
    mocks.inspectBloodworkFile.mockResolvedValue({
      mimeType: "application/pdf",
      pageCount: 2,
      sha256: "a".repeat(64),
    });
  });

  it("retains a four-page batch, resumes page five, prepares, then commits", async () => {
    let run = 0;
    mocks.supabaseAdmin.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path.includes("patient_bloodwork_files")) {
        return response([{ id: FILE, object_path: "/private/report", mime_type: "image/png", page_count: 5, position: 0 }]);
      }
      if (method === "GET" && path.includes("patient_bloodwork_extraction_pages")) {
        return response(run === 1
          ? []
          : [1, 2, 3, 4].map((source_page) => ({ source_file_id: FILE, source_page })));
      }
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_lease_extraction") {
        run += 1;
        return response([{ id: REPORT, patient_id: "patient", extraction_lease_token: TOKEN }]);
      }
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_renew_extraction") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_save_extraction_page") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_release_extraction") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_prepare_extraction") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_complete_extraction_from_pages") return response(true);
      throw new Error(`unexpected worker request ${method} ${path}`);
    });
    mocks.readObjectBounded.mockResolvedValue({ bytes: Buffer.from("source") });
    mocks.prepareBloodworkPages.mockImplementation(async (_bytes: Buffer, _mime: string, pages: number[]) =>
      pages.map((page) => ({ page, bytes: Buffer.from(`page-${page}`), mimeType: "image/png", width: 1, height: 1 })));
    mocks.transcribeBloodworkPage.mockResolvedValue([]);

    const firstContext = context();
    await runBloodworkExtraction(firstContext);
    expect(mocks.supabaseAdmin.mock.calls.filter(([, path]) =>
      path === "/rest/v1/rpc/bloodwork_save_extraction_page",
    )).toHaveLength(4);
    expect(mocks.supabaseAdmin).toHaveBeenCalledWith(
      "POST", "/rest/v1/rpc/bloodwork_release_extraction",
      { p_report_id: REPORT, p_lease_token: TOKEN },
    );
    expect(firstContext.failItem).not.toHaveBeenCalled();
    expect(mocks.signalJob).toHaveBeenCalledWith("bloodwork-extraction");

    const secondContext = context();
    await runBloodworkExtraction(secondContext);
    expect(mocks.supabaseAdmin.mock.calls.filter(([, path]) =>
      path === "/rest/v1/rpc/bloodwork_save_extraction_page",
    )).toHaveLength(5);
    expect(mocks.supabaseAdmin).toHaveBeenCalledWith(
      "POST", "/rest/v1/rpc/bloodwork_prepare_extraction",
      { p_report_id: REPORT, p_lease_token: TOKEN },
    );
    expect(mocks.supabaseAdmin).toHaveBeenCalledWith(
      "POST", "/rest/v1/rpc/bloodwork_complete_extraction_from_pages",
      { p_report_id: REPORT, p_lease_token: TOKEN },
    );
    expect(secondContext.failItem).not.toHaveBeenCalled();
    expect(mocks.signalJob).toHaveBeenCalledWith("bloodwork-extraction");
    // Run two receives only the missing fifth page; successful checkpoints
    // are never sent to the model again.
    expect(mocks.transcribeBloodworkPage.mock.calls.map(([, signal]) => signal)).toHaveLength(5);
  });

  it("does not complete when the lease renewal expires", async () => {
    mocks.supabaseAdmin.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_lease_extraction") {
        return response([{ id: REPORT, patient_id: "patient", extraction_lease_token: TOKEN }]);
      }
      if (method === "GET" && path.includes("patient_bloodwork_files")) {
        return response([{ id: FILE, object_path: "/private/report", mime_type: "image/png", page_count: 1, position: 0 }]);
      }
      if (method === "GET" && path.includes("patient_bloodwork_extraction_pages")) return response([]);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_renew_extraction") return response(false);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_fail_extraction") return response(false);
      throw new Error(`unexpected expired-lease request ${method} ${path}`);
    });
    const failed = context();
    await runBloodworkExtraction(failed);
    expect(failed.failItem).toHaveBeenCalledWith(REPORT, "EXTRACTION_FAILED");
    expect(mocks.supabaseAdmin.mock.calls.some(([, path]) =>
      path === "/rest/v1/rpc/bloodwork_prepare_extraction"
        || path === "/rest/v1/rpc/bloodwork_complete_extraction_from_pages",
    )).toBe(false);
  });

  it("prepares and transcribes at most two pages concurrently", async () => {
    let active = 0;
    let peak = 0;
    mocks.supabaseAdmin.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_lease_extraction") {
        return response([{ id: REPORT, extraction_lease_token: TOKEN }]);
      }
      if (method === "GET" && path.includes("patient_bloodwork_files")) {
        return response([{ id: FILE, object_path: "/private/report", mime_type: "application/pdf", page_count: 2, position: 0, content_sha256: null }]);
      }
      if (method === "GET" && path.includes("patient_bloodwork_extraction_pages")) return response([]);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_renew_extraction") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_save_extraction_page") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_prepare_extraction") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_complete_extraction_from_pages") return response(true);
      throw new Error(`unexpected request ${method} ${path}`);
    });
    mocks.readObjectBounded.mockResolvedValue({ bytes: Buffer.from("source") });
    mocks.prepareBloodworkPages.mockImplementation(async (_bytes: Buffer, _mime: string, pages: number[]) =>
      pages.map((page) => ({ page, bytes: Buffer.from(String(page)), mimeType: "image/png", width: 1, height: 1 })));
    mocks.transcribeBloodworkPage.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return [];
    });

    await runBloodworkExtraction(context());
    expect(peak).toBe(2);
    expect(mocks.prepareBloodworkPages).toHaveBeenCalledWith(
      Buffer.from("source"), "application/pdf", [1, 2], { sha256: "a".repeat(64), pageCount: 2 }, expect.any(AbortSignal),
    );
  });

  it("aborts all in-flight AI work when the report lease is cleared by deletion", async () => {
    vi.useFakeTimers();
    try {
      let renewals = 0;
      mocks.supabaseAdmin.mockImplementation(async (method: string, path: string) => {
        if (method === "POST" && path === "/rest/v1/rpc/bloodwork_lease_extraction") {
          return response([{ id: REPORT, extraction_lease_token: TOKEN }]);
        }
        if (method === "GET" && path.includes("patient_bloodwork_files")) {
          return response([{ id: FILE, object_path: "/private/report", mime_type: "application/pdf", page_count: 2, position: 0, content_sha256: null }]);
        }
        if (method === "GET" && path.includes("patient_bloodwork_extraction_pages")) return response([]);
        if (method === "POST" && path === "/rest/v1/rpc/bloodwork_renew_extraction") {
          renewals += 1;
          return response(renewals <= 2);
        }
        if (method === "POST" && path === "/rest/v1/rpc/bloodwork_fail_extraction") return response(false);
        throw new Error(`unexpected request ${method} ${path}`);
      });
      mocks.readObjectBounded.mockResolvedValue({ bytes: Buffer.from("source") });
      mocks.prepareBloodworkPages.mockResolvedValue([
        { page: 1, bytes: Buffer.from("1"), mimeType: "image/png", width: 1, height: 1 },
        { page: 2, bytes: Buffer.from("2"), mimeType: "image/png", width: 1, height: 1 },
      ]);
      let settled = 0;
      mocks.transcribeBloodworkPage.mockImplementation(async (_input: unknown, signal: AbortSignal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            settled += 1;
            reject(new Error("cancelled"));
          }, { once: true });
        }));

      const ctx = context();
      const running = runBloodworkExtraction(ctx);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_000);
      await running;
      expect(settled).toBe(2);
      expect(ctx.failItem).toHaveBeenCalledWith(REPORT, "EXTRACTION_FAILED");
      expect(mocks.supabaseAdmin.mock.calls.some(([, path]) =>
        path === "/rest/v1/rpc/bloodwork_save_extraction_page")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires a fresh lease proof after rendering before starting AI work", async () => {
    let releasePreparation: ((pages: Array<{ page: number; bytes: Buffer; mimeType: "image/png"; width: number; height: number }>) => void) | undefined;
    let renewals = 0;
    mocks.supabaseAdmin.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_lease_extraction") {
        return response([{ id: REPORT, extraction_lease_token: TOKEN }]);
      }
      if (method === "GET" && path.includes("patient_bloodwork_files")) {
        return response([{ id: FILE, object_path: "/private/report", mime_type: "image/png", page_count: 1, position: 0, content_sha256: null }]);
      }
      if (method === "GET" && path.includes("patient_bloodwork_extraction_pages")) return response([]);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_renew_extraction") {
        renewals += 1;
        return response(renewals === 1);
      }
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_fail_extraction") return response(false);
      throw new Error(`unexpected fresh-proof request ${method} ${path}`);
    });
    mocks.readObjectBounded.mockResolvedValue({ bytes: Buffer.from("source") });
    mocks.prepareBloodworkPages.mockImplementation(() => new Promise((resolve) => {
      releasePreparation = resolve;
    }));

    const running = runBloodworkExtraction(context());
    await vi.waitFor(() => expect(mocks.prepareBloodworkPages).toHaveBeenCalledOnce());
    // Simulate purge token revocation while CPU-bound rendering is still held.
    releasePreparation!([{ page: 1, bytes: Buffer.from("1"), mimeType: "image/png", width: 1, height: 1 }]);
    await running;

    expect(mocks.transcribeBloodworkPage).not.toHaveBeenCalled();
  });

  it("checkpoints a fulfilled AI sibling after its concurrent sibling fails", async () => {
    mocks.supabaseAdmin.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_lease_extraction") {
        return response([{ id: REPORT, extraction_lease_token: TOKEN }]);
      }
      if (method === "GET" && path.includes("patient_bloodwork_files")) {
        return response([{ id: FILE, object_path: "/private/report", mime_type: "application/pdf", page_count: 2, position: 0, content_sha256: null }]);
      }
      if (method === "GET" && path.includes("patient_bloodwork_extraction_pages")) return response([]);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_renew_extraction") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_save_extraction_page") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_fail_extraction") return response(true);
      throw new Error(`unexpected request ${method} ${path}`);
    });
    mocks.readObjectBounded.mockResolvedValue({ bytes: Buffer.from("source") });
    mocks.prepareBloodworkPages.mockResolvedValue([
      { page: 1, bytes: Buffer.from("1"), mimeType: "image/png", width: 1, height: 1 },
      { page: 2, bytes: Buffer.from("2"), mimeType: "image/png", width: 1, height: 1 },
    ]);
    mocks.transcribeBloodworkPage.mockImplementation(async (input: { sourcePage: number }) => {
      if (input.sourcePage === 1) return [];
      throw new Error("model refused page");
    });

    const ctx = context();
    await runBloodworkExtraction(ctx);
    const saved = mocks.supabaseAdmin.mock.calls.filter(([, path]) =>
      path === "/rest/v1/rpc/bloodwork_save_extraction_page");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.[2]).toMatchObject({ p_source_page: 1 });
    expect(ctx.failItem).toHaveBeenCalledWith(REPORT, "EXTRACTION_FAILED");
  });

  it("fails a legacy twelve-page report locally at page four, reuses one admission, and preserves checkpoints", async () => {
    const healthyReport = "00000000-0000-4000-8000-000000000104";
    const healthyFile = "00000000-0000-4000-8000-000000000105";
    let leases = 0;
    const savedPages = new Map<string, number[]>();
    mocks.supabaseAdmin.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_lease_extraction") {
        leases += 1;
        return response([{
          id: leases === 1 ? REPORT : healthyReport,
          extraction_lease_token: TOKEN,
        }]);
      }
      if (method === "GET" && path.includes("patient_bloodwork_files")) {
        const healthy = path.includes(healthyReport);
        return response([{
          id: healthy ? healthyFile : FILE,
          object_path: healthy ? "/private/healthy-report" : "/private/legacy-report",
          mime_type: "application/pdf",
          page_count: healthy ? 1 : 12,
          position: 0,
          content_sha256: healthy ? "b".repeat(64) : null,
        }]);
      }
      if (method === "GET" && path.includes("patient_bloodwork_extraction_pages")) {
        const reportId = path.includes(healthyReport) ? healthyReport : REPORT;
        return response((savedPages.get(reportId) ?? []).map((source_page) => ({
          source_file_id: reportId === healthyReport ? healthyFile : FILE,
          source_page,
        })));
      }
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_renew_extraction") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_save_extraction_page") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_fail_extraction") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_prepare_extraction") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_complete_extraction_from_pages") return response(true);
      throw new Error(`unexpected local-failure request ${method} ${path}`);
    });
    mocks.readObjectBounded.mockImplementation(async (path: string) => ({
      bytes: Buffer.from(path.includes("healthy") ? "healthy-source" : "legacy-source"),
    }));
    mocks.inspectBloodworkFile.mockResolvedValue({
      mimeType: "application/pdf",
      pageCount: 12,
      sha256: "c".repeat(64),
    });
    mocks.prepareBloodworkPages.mockImplementation(async (_bytes: Buffer, _mime: string, pages: number[]) =>
      pages.map((page) => ({ page, bytes: Buffer.from(`page-${page}`), mimeType: "image/png", width: 1, height: 1 })));
    mocks.transcribeBloodworkPage.mockImplementation(async (input: { sourcePage: number }) => {
      if (input.sourcePage === 4) {
        throw new mocks.BloodworkDocumentError("PROCESSING_TIMEOUT", "document timed out");
      }
      return [];
    });

    const failed = context();
    await runBloodworkExtraction(failed);

    expect(mocks.inspectBloodworkFile).toHaveBeenCalledOnce();
    expect(mocks.prepareBloodworkPages.mock.calls.slice(0, 2).map((call) => call[3])).toEqual([
      { sha256: "c".repeat(64), pageCount: 12 },
      { sha256: "c".repeat(64), pageCount: 12 },
    ]);
    expect(mocks.inspectBloodworkFile.mock.calls[0]?.[0]).toBe(mocks.prepareBloodworkPages.mock.calls[0]?.[0]);
    expect(mocks.prepareBloodworkPages.mock.calls[0]?.[0]).toBe(mocks.prepareBloodworkPages.mock.calls[1]?.[0]);
    expect(mocks.supabaseAdmin.mock.calls
      .filter(([, path]) => path === "/rest/v1/rpc/bloodwork_save_extraction_page")
      .map(([, , body]) => (body as { p_source_page: number }).p_source_page))
      .toEqual([1, 2, 3]);
    expect(mocks.supabaseAdmin).toHaveBeenCalledWith(
      "POST",
      "/rest/v1/rpc/bloodwork_fail_extraction",
      { p_report_id: REPORT, p_lease_token: TOKEN, p_error: "PROCESSING_TIMEOUT" },
    );
    expect(failed.failItem).toHaveBeenCalledWith(REPORT, "PROCESSING_TIMEOUT", { reportLocal: true });
    expect(mocks.signalJob).toHaveBeenCalledWith("bloodwork-extraction");

    const healthy = context();
    await runBloodworkExtraction(healthy);
    expect(healthy.failItem).not.toHaveBeenCalled();
    expect(mocks.supabaseAdmin).toHaveBeenCalledWith(
      "POST",
      "/rest/v1/rpc/bloodwork_complete_extraction_from_pages",
      { p_report_id: healthyReport, p_lease_token: TOKEN },
    );
  });

  it.each([
    ["page count", { mimeType: "application/pdf", pageCount: 11 }],
    ["mime type", { mimeType: "image/png", pageCount: 12 }],
  ])("fails closed when a legacy PDF admission has a stored %s mismatch", async (_label, inspected) => {
    mocks.supabaseAdmin.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_lease_extraction") {
        return response([{ id: REPORT, extraction_lease_token: TOKEN }]);
      }
      if (method === "GET" && path.includes("patient_bloodwork_files")) {
        return response([{
          id: FILE,
          object_path: "/private/legacy-report",
          mime_type: "application/pdf",
          page_count: 12,
          position: 0,
          content_sha256: null,
        }]);
      }
      if (method === "GET" && path.includes("patient_bloodwork_extraction_pages")) return response([]);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_renew_extraction") return response(true);
      if (method === "POST" && path === "/rest/v1/rpc/bloodwork_fail_extraction") return response(true);
      throw new Error(`unexpected legacy-admission request ${method} ${path}`);
    });
    mocks.readObjectBounded.mockResolvedValue({ bytes: Buffer.from("legacy-source") });
    mocks.inspectBloodworkFile.mockResolvedValue({ ...inspected, sha256: "c".repeat(64) });

    const failed = context();
    await runBloodworkExtraction(failed);

    expect(mocks.inspectBloodworkFile).toHaveBeenCalledOnce();
    expect(mocks.prepareBloodworkPages).not.toHaveBeenCalled();
    expect(failed.failItem).toHaveBeenCalledWith(REPORT, "CORRUPT_FILE", { reportLocal: true });
  });

  it("releases and signals a continuation when the seven-minute quantum expires", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      mocks.supabaseAdmin.mockImplementation(async (method: string, path: string) => {
        if (method === "POST" && path === "/rest/v1/rpc/bloodwork_lease_extraction") {
          return response([{ id: REPORT, extraction_lease_token: TOKEN }]);
        }
        if (method === "GET" && path.includes("patient_bloodwork_files")) {
          return response([{ id: FILE, object_path: "/private/report", mime_type: "image/png", page_count: 1, position: 0, content_sha256: null }]);
        }
        if (method === "GET" && path.includes("patient_bloodwork_extraction_pages")) return response([]);
        if (method === "POST" && path === "/rest/v1/rpc/bloodwork_renew_extraction") return response(true);
        if (method === "POST" && path === "/rest/v1/rpc/bloodwork_release_extraction") return response(true);
        throw new Error(`unexpected quantum request ${method} ${path}`);
      });
      mocks.readObjectBounded.mockResolvedValue({ bytes: Buffer.from("source") });
      mocks.prepareBloodworkPages.mockResolvedValue([
        { page: 1, bytes: Buffer.from("1"), mimeType: "image/png", width: 1, height: 1 },
      ]);
      mocks.transcribeBloodworkPage.mockImplementation(async (_input: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
        }));

      const ctx = context();
      const running = runBloodworkExtraction(ctx);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(7 * 60_000);
      await running;

      expect(mocks.supabaseAdmin).toHaveBeenCalledWith(
        "POST", "/rest/v1/rpc/bloodwork_release_extraction",
        { p_report_id: REPORT, p_lease_token: TOKEN },
      );
      expect(ctx.failItem).not.toHaveBeenCalled();
      expect(mocks.signalJob).toHaveBeenCalledWith("bloodwork-extraction");
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});