import { describe, expect, it } from "vitest";
import { isValidUploadId, patientMediaObjectId } from "./patient-media-ids";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const MINTED_ID = /^(food|recipe|chat|progress)-[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("patientMediaObjectId", () => {
  it("is stable for the same (patient, kind, uploadId) — a re-minted upload names the same object", () => {
    const a = patientMediaObjectId(P1, "progress", "photo_abc_1_xyz");
    const b = patientMediaObjectId(P1, "progress", "photo_abc_1_xyz");
    expect(a).toBe(b);
    expect(a).toMatch(MINTED_ID);
  });

  it("differs across patients, kinds, and upload ids", () => {
    const base = patientMediaObjectId(P1, "progress", "photo_abc_1_xyz");
    expect(patientMediaObjectId(P2, "progress", "photo_abc_1_xyz")).not.toBe(base);
    expect(patientMediaObjectId(P1, "chat", "photo_abc_1_xyz")).not.toBe(
      base.replace(/^progress-/, "chat-"),
    );
    expect(patientMediaObjectId(P1, "progress", "photo_abc_2_xyz")).not.toBe(base);
  });

  it("stays random without an upload id", () => {
    const a = patientMediaObjectId(P1, "food");
    const b = patientMediaObjectId(P1, "food");
    expect(a).not.toBe(b);
    expect(a).toMatch(MINTED_ID);
  });

  it("accepts idempotency-key-shaped upload ids only", () => {
    expect(isValidUploadId("q_01J8ZC0K9ABCDEF.photoUpload:3")).toBe(true);
    expect(isValidUploadId("gp_lx3k2m_ab12cd.front")).toBe(true);
    expect(isValidUploadId("")).toBe(false);
    expect(isValidUploadId("has space")).toBe(false);
    expect(isValidUploadId("a".repeat(129))).toBe(false);
    expect(isValidUploadId(42)).toBe(false);
  });
});
