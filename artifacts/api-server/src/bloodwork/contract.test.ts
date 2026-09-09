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
  });

  it("uses the live onboarding admission tables and active-profile gate", () => {
    const route = readFileSync(new URL("../routes/bloodwork.ts", import.meta.url), "utf8");
    expect(route).toContain("/rest/v1/patient_flags?");
    expect(route).toContain("onboarding_complete=eq.true");
    expect(route).toContain("activation_status=eq.activated");
    expect(route).toContain("profile_completed_at=not.is.null");
    expect(route).not.toContain("&onboarding_complete=eq.true\" +");
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
    expect(worker).toContain("deadline.signal");
    expect(worker).toContain("ctx.checkpoint();");
  });
});