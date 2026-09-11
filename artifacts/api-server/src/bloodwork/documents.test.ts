import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import {
  BLOODWORK_MAX_FILE_BYTES,
  BloodworkDocumentError,
  isReportLocalBloodworkDocumentError,
  inspectBloodworkFile,
  prepareBloodworkPages,
  renderBloodworkPage,
} from "./documents";
import {
  syntheticDanglingPageBloodworkPdf,
  syntheticEncryptedBloodworkPdf,
  syntheticInvalidPageBoundsBloodworkPdf,
  syntheticMaxPageBloodworkPdf,
  syntheticTwoPageBloodworkPdf,
} from "./fixtures/synthetic";

function expectCode(code: string) {
  return expect.objectContaining({ name: "BloodworkDocumentError", code });
}

function syntheticImage(format: "png" | "jpeg"): Buffer {
  const canvas = createCanvas(320, 180);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 320, 180);
  context.fillStyle = "black";
  context.font = "18px sans-serif";
  context.fillText("SYNTHETIC Glucose 92 mg/dL", 12, 50);
  return format === "png"
    ? canvas.toBuffer("image/png")
    : canvas.toBuffer("image/jpeg", 90);
}

describe("bloodwork document inspection", () => {
  it("fully decodes valid PNG and JPEG images", async () => {
    const png = await inspectBloodworkFile(syntheticImage("png"), "image/png");
    const jpeg = await inspectBloodworkFile(syntheticImage("jpeg"), "image/jpeg");
    expect(png).toMatchObject({ mimeType: "image/png", pageCount: 1, width: 320, height: 180 });
    expect(jpeg).toMatchObject({ mimeType: "image/jpeg", pageCount: 1, width: 320, height: 180 });
    expect(png.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(jpeg.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects mislabeled and truncated images with stable sanitized codes", async () => {
    await expect(inspectBloodworkFile(syntheticImage("png"), "image/jpeg")).rejects.toEqual(
      expectCode("TYPE_MISMATCH"),
    );
    await expect(
      inspectBloodworkFile(syntheticImage("png").subarray(0, 30), "image/png"),
    ).rejects.toEqual(expectCode("CORRUPT_FILE"));
  });

  it("rejects a pixel bomb from dimensions before native decode", async () => {
    const bomb = Buffer.from(syntheticImage("png"));
    bomb.writeUInt32BE(50_000, 16);
    bomb.writeUInt32BE(50_000, 20);
    await expect(inspectBloodworkFile(bomb, "image/png")).rejects.toEqual(
      expectCode("IMAGE_TOO_LARGE"),
    );
  });

  it("accepts exactly 20,000,000 bytes and rejects one byte over", async () => {
    const pdf = syntheticTwoPageBloodworkPdf();
    const exact = Buffer.alloc(BLOODWORK_MAX_FILE_BYTES, 0x20);
    pdf.copy(exact);
    expect((await inspectBloodworkFile(exact, "application/pdf")).pageCount).toBe(2);

    const over = Buffer.alloc(BLOODWORK_MAX_FILE_BYTES + 1);
    pdf.copy(over);
    await expect(inspectBloodworkFile(over, "application/pdf")).rejects.toEqual(
      expectCode("FILE_TOO_LARGE"),
    );
  });

  it("rejects fake-PDF magic and corrupt PDFs", async () => {
    await expect(
      inspectBloodworkFile(Buffer.from("not a pdf"), "application/pdf"),
    ).rejects.toEqual(expectCode("CORRUPT_FILE"));
    await expect(
      inspectBloodworkFile(Buffer.from("%PDF-1.7\nnot really a PDF"), "application/pdf"),
    ).rejects.toEqual(expectCode("CORRUPT_FILE"));
  });

  it("rejects password-protected PDFs with an actionable distinct code", async () => {
    await expect(
      inspectBloodworkFile(syntheticEncryptedBloodworkPdf(), "application/pdf"),
    ).rejects.toEqual(expectCode("ENCRYPTED_PDF"));
  });

  it("resolves every declared page and survives a dangling page worker failure", async () => {
    await expect(
      inspectBloodworkFile(syntheticDanglingPageBloodworkPdf(), "application/pdf"),
    ).rejects.toEqual(expectCode("CORRUPT_FILE"));

    expect(
      (await inspectBloodworkFile(syntheticTwoPageBloodworkPdf(), "application/pdf")).pageCount,
    ).toBe(2);
  });

  it("rejects malicious page bounds with a sanitized document error", async () => {
    await expect(
      inspectBloodworkFile(syntheticInvalidPageBoundsBloodworkPdf(), "application/pdf"),
    ).rejects.toEqual(expectCode("CORRUPT_FILE"));
  });

  it("accepts the explicit 100-page maximum when every text page resolves", async () => {
    expect(
      (await inspectBloodworkFile(syntheticMaxPageBloodworkPdf(), "application/pdf")).pageCount,
    ).toBe(100);
  });

  it("terminates cancelled work without poisoning the bounded worker queue", async () => {
    const controller = new AbortController();
    const pending = inspectBloodworkFile(
      syntheticMaxPageBloodworkPdf(),
      "application/pdf",
      controller.signal,
    );
    setTimeout(() => controller.abort(), 5);
    await expect(
      pending,
    ).rejects.toEqual(expectCode("PROCESSING_TIMEOUT"));
    expect(
      (await inspectBloodworkFile(syntheticTwoPageBloodworkPdf(), "application/pdf")).pageCount,
    ).toBe(2);
  });

  it("removes cancelled queued work before it starts a native worker", async () => {
    const active = new AbortController();
    const queued = new AbortController();
    const running = inspectBloodworkFile(
      syntheticMaxPageBloodworkPdf(),
      "application/pdf",
      active.signal,
    );
    const pending = inspectBloodworkFile(
      syntheticTwoPageBloodworkPdf(),
      "application/pdf",
      queued.signal,
    );
    queued.abort();
    await expect(pending).rejects.toEqual(expectCode("PROCESSING_TIMEOUT"));
    active.abort();
    await expect(running).rejects.toEqual(expectCode("PROCESSING_TIMEOUT"));
    expect(
      (await inspectBloodworkFile(syntheticTwoPageBloodworkPdf(), "application/pdf")).pageCount,
    ).toBe(2);
  });

  it("rejects excess queued decoder work with stable backpressure", async () => {
    const work = Array.from({ length: 6 }, () =>
      inspectBloodworkFile(syntheticTwoPageBloodworkPdf(), "application/pdf"),
    );
    const outcomes = await Promise.allSettled(work);
    expect(outcomes.some(
      (outcome) => outcome.status === "rejected" && outcome.reason?.code === "PROCESSING_BUSY",
    )).toBe(true);
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
  });
});

describe("bloodwork page rendering", () => {
  it("renders every page of a multipage PDF as a high-resolution PNG", async () => {
    const original = syntheticTwoPageBloodworkPdf();
    const before = Buffer.from(original);
    const inspection = await inspectBloodworkFile(original, "application/pdf");
    expect(inspection).toEqual({
      mimeType: "application/pdf",
      pageCount: 2,
      width: null,
      height: null,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const first = await renderBloodworkPage(original, "application/pdf", 1);
    const second = await renderBloodworkPage(original, "application/pdf", 2);
    expect(first.mimeType).toBe("image/png");
    expect(second.mimeType).toBe("image/png");
    expect(Math.max(first.width, first.height)).toBe(2800);
    expect(Math.max(second.width, second.height)).toBe(2800);
    expect(first.bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(second.bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(original).toEqual(before);
  });

  it("returns validated image page bytes unchanged and rejects invalid pages", async () => {
    const image = syntheticImage("jpeg");
    const rendered = await renderBloodworkPage(image, "image/jpeg", 1);
    expect(rendered.bytes).toEqual(image);
    await expect(renderBloodworkPage(image, "image/jpeg", 2)).rejects.toEqual(
      expectCode("PAGE_OUT_OF_RANGE"),
    );
  });

  it("prepares up to two admitted PDF pages in one isolated operation", async () => {
    const original = syntheticTwoPageBloodworkPdf();
    const admission = await inspectBloodworkFile(original, "application/pdf");
    const rendered = await prepareBloodworkPages(
      original,
      "application/pdf",
      [1, 2],
      { sha256: admission.sha256, pageCount: admission.pageCount },
    );
    expect(rendered.map((page) => page.page)).toEqual([1, 2]);
    expect(rendered.every((page) => page.mimeType === "image/png")).toBe(true);
    await expect(
      prepareBloodworkPages(original, "application/pdf", [1, 2, 1], {
        sha256: admission.sha256,
        pageCount: admission.pageCount,
      }),
    ).rejects.toEqual(expectCode("PAGE_OUT_OF_RANGE"));
    await expect(
      prepareBloodworkPages(original, "application/pdf", [1, 1], {
        sha256: admission.sha256,
        pageCount: admission.pageCount,
      }),
    ).rejects.toEqual(expectCode("PAGE_OUT_OF_RANGE"));
  });

  it("rejects changed bytes against an admitted receipt before rendering", async () => {
    const original = syntheticTwoPageBloodworkPdf();
    const admission = await inspectBloodworkFile(original, "application/pdf");
    const changed = Buffer.from(original);
    changed[changed.indexOf("Glucose")] ^= 1;
    await expect(
      prepareBloodworkPages(changed, "application/pdf", [1], {
        sha256: admission.sha256,
        pageCount: admission.pageCount,
      }),
    ).rejects.toEqual(expectCode("CORRUPT_FILE"));
  });

  it("does a full legacy inspection rather than trusting its legacy page count", async () => {
    await expect(
      prepareBloodworkPages(syntheticDanglingPageBloodworkPdf(), "application/pdf", [1], {
        sha256: null,
        pageCount: 1,
      }),
    ).rejects.toEqual(expectCode("CORRUPT_FILE"));
  });

  it("exposes only documented document errors", () => {
    const error = new BloodworkDocumentError("RENDER_FAILED", "safe");
    expect(error).toMatchObject({ code: "RENDER_FAILED", message: "safe" });
    expect(isReportLocalBloodworkDocumentError(error)).toBe(true);
    expect(isReportLocalBloodworkDocumentError(new BloodworkDocumentError("PROCESSING_BUSY", "busy"))).toBe(false);
  });
});