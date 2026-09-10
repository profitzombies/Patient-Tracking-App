import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../jobs/types";

const mocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(),
  readObjectBounded: vi.fn(),
  renderBloodworkPage: vi.fn(),
  transcribeBloodworkPage: vi.fn(),
}));

vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.supabaseAdmin }));
vi.mock("../lib/objectStorage", () => ({
  objectStorage: { readObjectBounded: mocks.readObjectBounded },
}));
vi.mock("../bloodwork/documents", () => ({
  BLOODWORK_MAX_FILE_BYTES: 20_000_000,
  renderBloodworkPage: mocks.renderBloodworkPage,
}));
vi.mock("../bloodwork/extraction", () => ({
  BloodworkTranscriptionError: class BloodworkTranscriptionError extends Error {},
  transcribeBloodworkPage: mocks.transcribeBloodworkPage,
}));

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
    mocks.renderBloodworkPage.mockReset();
    mocks.transcribeBloodworkPage.mockReset();
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
    mocks.renderBloodworkPage.mockImplementation(async (_bytes: Buffer, _mime: string, page: number) => ({
      bytes: Buffer.from(`page-${page}`), mimeType: "image/png",
    }));
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
});