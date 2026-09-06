import { describe, expect, it } from "vitest";
import { cleanHqFileName, hqFileNameMatchesContentType, validateHqFileHead, validHqTimezone } from "./hq-settings-files";
import { operationalMetrics } from "./operational-rollups";

describe("non-financial live foundation boundaries", () => {
  it("keeps empty operational rollups zero-safe", () => {
    expect(operationalMetrics(undefined)).toEqual({
      providerCount: 0,
      totalPatients: 0,
      activePatients: 0,
      enrollments30d: 0,
      engaged7d: 0,
      needsAttention: 0,
      inactive: 0,
      invited: 0,
      watchlist: 0,
      loggingLapsed: 0,
      checkInsOverdue: 0,
      avgPoundsLost: null,
    });
  });

  it("normalizes safe file names and rejects path/control characters", () => {
    expect(cleanHqFileName("  policy.pdf  ")).toBe("policy.pdf");
    expect(cleanHqFileName("../policy.pdf")).toBeNull();
    expect(cleanHqFileName("folder/policy.pdf")).toBeNull();
    expect(cleanHqFileName("bad\u0000name.pdf")).toBeNull();
  });

  it("accepts real IANA timezones and rejects invented ones", () => {
    expect(validHqTimezone("America/New_York")).toBe(true);
    expect(validHqTimezone("Not/A_Zone")).toBe(false);
  });

  it("rejects spoofed MIME declarations by inspecting bytes", () => {
    expect(validateHqFileHead("application/pdf", Buffer.from("not a PDF"))).toBe(false);
    expect(validateHqFileHead("image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(validateHqFileHead("application/pdf", Buffer.from("%PDF-1.7"))).toBe(true);
    expect(validateHqFileHead("text/csv", Buffer.from("name,value\nA,1\n"))).toBe(true);
    expect(validateHqFileHead("text/plain", Buffer.from([0x68, 0x69, 0x00]))).toBe(false);
  });

  it("requires a safe attachment extension for every declared file type", () => {
    expect(hqFileNameMatchesContentType("handbook.pdf", "application/pdf")).toBe(true);
    expect(hqFileNameMatchesContentType("photo.JPEG", "image/jpeg")).toBe(true);
    expect(hqFileNameMatchesContentType("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true);
    expect(hqFileNameMatchesContentType("archive.zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
    expect(hqFileNameMatchesContentType("report.docx", "application/vnd.ms-excel")).toBe(false);
  });
});