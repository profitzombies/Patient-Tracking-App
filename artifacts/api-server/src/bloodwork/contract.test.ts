import { describe, expect, it } from "vitest";
import {
  CorrectBloodworkResultBody,
  CreateBloodworkReportBody,
} from "@workspace/api-zod";
import { fileDto, reportDto } from "./repository";
import { readFileSync } from "node:fs";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("bloodwork generated API contract", () => {
  it("accepts the exact PDF boundary and rejects one byte over", () => {
    const base = {
      clientRequestId: id(1), title: "Synthetic CBC", reportDate: null,
      transcriptionConsent: true as const,
    };
    expect(CreateBloodworkReportBody.safeParse({
      ...base, files: [{ clientFileId: id(2), mimeType: "application/pdf", size: 20_000_000 }],
    }).success).toBe(true);
    expect(CreateBloodworkReportBody.safeParse({
      ...base, files: [{ clientFileId: id(2), mimeType: "application/pdf", size: 20_000_001 }],
    }).success).toBe(false);
  });

  it("rejects an eleventh file and absent transcription consent", () => {
    const files = Array.from({ length: 11 }, (_, i) => ({
      clientFileId: id(i + 10), mimeType: "image/jpeg", size: 100,
    }));
    expect(CreateBloodworkReportBody.safeParse({
      clientRequestId: id(1), title: "Ten pages", reportDate: null,
      transcriptionConsent: true, files,
    }).success).toBe(false);
    expect(CreateBloodworkReportBody.safeParse({
      clientRequestId: id(1), title: "No consent", reportDate: null,
      transcriptionConsent: false, files: files.slice(0, 1),
    }).success).toBe(false);
  });

  it("preserves comparator, qualitative, range, and uncertainty correction text", () => {
    const parsed = CorrectBloodworkResultBody.parse({
      expectedVersion: 4, testName: "HCG", valueText: "<5", units: "mIU/mL",
      referenceRange: "Negative: <5", labFlag: null, uncertain: true,
    });
    expect(parsed).toMatchObject({ valueText: "<5", referenceRange: "Negative: <5", uncertain: true });
  });

  it("metadata DTOs never expose canonical storage paths", () => {
    const file = {
      id: id(2), patient_id: id(1), report_id: id(3), client_file_id: id(4),
      position: 0, declared_mime_type: "image/png", declared_size_bytes: 10,
      staging_object_path: "/objects/private/staging", object_path: "/objects/private/report",
      mime_type: "image/png", size_bytes: 10, page_count: 1, width: 10, height: 10,
    };
    const report = reportDto({
      id: id(3), patient_id: id(1), title: "CBC", report_date: null,
      uploaded_at: "2026-10-06T00:00:00Z", version: 1, kind: "images",
      extraction_status: "queued", extraction_error: null, lifecycle_status: "committed",
    }, [file]);
    expect(JSON.stringify({ report, file: fileDto(file) })).not.toContain("/objects/");
    expect(report.processing).toMatchObject({
      phase: "waiting",
      completedPages: 0,
      totalPages: 1,
      completedAt: null,
      elapsedSeconds: null,
      leaseUntil: null,
    });
    expect(report.processing).not.toHaveProperty("leaseToken");
  });

  it("reports bounded persisted progress and freezes terminal elapsed time", () => {
    const report = reportDto({
      id: id(3), patient_id: id(1), title: "CBC", report_date: null,
      uploaded_at: "2026-10-06T00:00:00Z", version: 1, kind: "images",
      extraction_status: "completed", extraction_error: null, lifecycle_status: "committed",
      extraction_phase: "completed", extraction_completed_pages: 12, extraction_total_pages: 10,
      extraction_started_at: "2026-10-06T00:00:00Z",
      extraction_progress_updated_at: "2026-10-06T00:02:00Z",
      extraction_completed_at: "2026-10-06T00:01:10Z",
      extraction_finished_at: "2026-10-06T00:01:10Z",
      extraction_lease_until: "2026-10-07T00:00:00Z",
    }, [{
      id: id(2), patient_id: id(1), report_id: id(3), client_file_id: id(4),
      position: 0, declared_mime_type: "image/png", declared_size_bytes: 10,
      staging_object_path: "/objects/private/staging", object_path: "/objects/private/report",
      mime_type: "image/png", size_bytes: 10, page_count: 10, width: 10, height: 10,
    }], "2026-10-06T01:00:00Z");
    expect(report.processing).toMatchObject({
      phase: "completed", completedPages: 10, totalPages: 10,
      completedAt: "2026-10-06T00:01:10.000Z", elapsedSeconds: 70,
      activity: "waiting", leaseUntil: null,
    });
  });

  it("does not invent extraction timing for legacy terminal rows", () => {
    const report = reportDto({
      id: id(3), patient_id: id(1), title: "Legacy", report_date: null,
      uploaded_at: "2026-10-06T00:00:00Z", version: 1, kind: "images",
      extraction_status: "completed", extraction_error: null, lifecycle_status: "committed",
      extraction_phase: "completed", extraction_completed_pages: 1, extraction_total_pages: 1,
    }, [{
      id: id(2), patient_id: id(1), report_id: id(3), client_file_id: id(4),
      position: 0, declared_mime_type: "image/png", declared_size_bytes: 10,
      staging_object_path: "/objects/private/staging", object_path: "/objects/private/report",
      mime_type: "image/png", size_bytes: 10, page_count: 1, width: 10, height: 10,
    }], "2026-10-07T00:00:00Z");
    expect(report.processing).toMatchObject({
      phase: "completed", completedPages: 1, totalPages: 1,
      startedAt: null, completedAt: null, elapsedSeconds: null,
    });
  });

  it("distinguishes active, delayed, and unknown worker observations", () => {
    const base = {
      id: id(3), patient_id: id(1), title: "CBC", report_date: null,
      uploaded_at: "2026-10-06T00:00:00Z", version: 1, kind: "images" as const,
      extraction_error: null, lifecycle_status: "committed" as const,
      extraction_phase: "reading_pages" as const, extraction_completed_pages: 1, extraction_total_pages: 2,
      extraction_started_at: "2026-10-06T00:00:00Z",
      extraction_progress_updated_at: "2026-10-06T00:01:00Z",
    };
    const files = [{
      id: id(2), patient_id: id(1), report_id: id(3), client_file_id: id(4),
      position: 0, declared_mime_type: "image/png", declared_size_bytes: 10,
      staging_object_path: "/objects/private/staging", object_path: "/objects/private/report",
      mime_type: "image/png", size_bytes: 10, page_count: 2, width: 10, height: 10,
    }];
    expect(reportDto({
      ...base, extraction_status: "processing", extraction_lease_until: "2026-10-06T00:05:00Z",
    }, files, "2026-10-06T00:02:00Z").processing.activity).toBe("active");
    const missingHeartbeat = reportDto({
      ...base, extraction_status: "processing", extraction_progress_updated_at: undefined,
      extraction_lease_until: "2026-10-06T00:05:00Z",
    }, files, "2026-10-06T00:02:00Z").processing;
    expect(missingHeartbeat.updatedAt).toBeNull();
    expect(missingHeartbeat.activity).toBe("unknown");
    expect(reportDto({
      ...base, extraction_status: "processing",
      extraction_progress_updated_at: "2026-10-05T23:00:00Z",
      extraction_lease_until: "2026-10-06T00:05:00Z",
    }, files, "2026-10-06T00:02:00Z").processing.activity).toBe("delayed");
    expect(reportDto({
      ...base, extraction_status: "processing", extraction_lease_until: "2026-10-06T00:01:30Z",
    }, files, "2026-10-06T00:02:00Z").processing.activity).toBe("delayed");
    expect(reportDto({
      ...base, extraction_status: "processing", extraction_lease_until: null,
    }, files, "2026-10-06T00:02:00Z").processing.activity).toBe("unknown");
  });

  it("pins bounded object reads and checkpoints resumable extraction", () => {
    const storage = readFileSync(new URL("../lib/objectStorage.ts", import.meta.url), "utf8");
    const route = readFileSync(new URL("../routes/bloodwork.ts", import.meta.url), "utf8");
    const worker = readFileSync(new URL("../jobs/definitions/bloodwork-extraction.ts", import.meta.url), "utf8");
    expect(storage).toContain("readObjectBounded");
    expect(storage).toContain("file(objectName, { generation })");
    expect(storage).toContain("received > maxBytes");
    expect(route).toContain("readObjectBounded(file.staging_object_path");
    expect(worker).toContain("bloodwork_save_extraction_page");
    expect(worker).toContain("bloodwork_renew_extraction");
    expect(worker).toContain("bloodwork_prepare_extraction");
    expect(worker).toContain("AbortSignal.timeout(RUN_DEADLINE_MS)");
    expect(worker).toContain("AbortSignal.any([heartbeat.signal, deadline])");
    expect(worker).toContain("ctx.checkpoint();");
  });
});