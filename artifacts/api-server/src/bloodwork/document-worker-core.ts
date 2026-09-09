import { loadImage } from "@napi-rs/canvas";
import { getDocumentProxy, renderPageAsImage } from "unpdf";

export const MAX_FILE_BYTES = 20_000_000;
export const MAX_PDF_PAGES = 100;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const RENDER_LONG_EDGE = 2_800;

export type DocumentMime = "application/pdf" | "image/jpeg" | "image/png";
export type WorkerErrorCode =
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "TYPE_MISMATCH"
  | "CORRUPT_FILE"
  | "ENCRYPTED_PDF"
  | "TOO_MANY_PAGES"
  | "IMAGE_TOO_LARGE"
  | "PAGE_OUT_OF_RANGE"
  | "RENDER_FAILED";

export class WorkerDocumentError extends Error {
  constructor(public readonly code: WorkerErrorCode, message: string) {
    super(message);
  }
}

function fail(code: WorkerErrorCode, message: string): never {
  throw new WorkerDocumentError(code, message);
}

function declaredMime(value: string): DocumentMime {
  const mime = value.split(";", 1)[0].trim().toLowerCase();
  if (mime === "application/pdf" || mime === "image/jpeg" || mime === "image/png") return mime;
  return fail("UNSUPPORTED_TYPE", "Choose a PDF, JPEG, or PNG bloodwork report.");
}

function detect(bytes: Uint8Array): DocumentMime | null {
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from("%PDF-"))) {
    return "application/pdf";
  }
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

function pngDimensions(bytes: Uint8Array) {
  if (bytes.length < 24 || Buffer.from(bytes.subarray(12, 16)).toString() !== "IHDR") {
    return fail("CORRUPT_FILE", "This PNG image cannot be read. Export it again and retry.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function completePng(bytes: Uint8Array): void {
  let offset = 8;
  let idat = false;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) {
      fail("CORRUPT_FILE", "This PNG image is incomplete. Export it again and retry.");
    }
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString();
    if (type === "IDAT") idat = true;
    if (type === "IEND") {
      if (length !== 0 || !idat) fail("CORRUPT_FILE", "This PNG image has invalid data. Export it again and retry.");
      return;
    }
    offset = end;
  }
  fail("CORRUPT_FILE", "This PNG image is incomplete. Export it again and retry.");
}

function jpegDimensions(bytes: Uint8Array) {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    let marker = bytes[offset + 1];
    while (marker === 0xff && offset + 2 < bytes.length) marker = bytes[++offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 7) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    offset += 2 + length;
  }
  return fail("CORRUPT_FILE", "This JPEG image cannot be read. Export it again and retry.");
}

function safeDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    fail("CORRUPT_FILE", "This image has invalid dimensions. Export it again and retry.");
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    fail("IMAGE_TOO_LARGE", "This image has too many pixels to process safely. Resize it and retry.");
  }
}

async function inspectImage(bytes: Uint8Array, mime: "image/jpeg" | "image/png") {
  const dimensions = mime === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  safeDimensions(dimensions.width, dimensions.height);
  if (mime === "image/png") completePng(bytes);
  if (mime === "image/jpeg" && (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)) {
    fail("CORRUPT_FILE", "This JPEG image is incomplete. Export it again and retry.");
  }
  try {
    const image = await loadImage(Buffer.from(bytes));
    if (image.width !== dimensions.width || image.height !== dimensions.height) {
      fail("CORRUPT_FILE", "This image has inconsistent dimensions. Export it again and retry.");
    }
  } catch (error) {
    if (error instanceof WorkerDocumentError) throw error;
    fail("CORRUPT_FILE", `This ${mime === "image/png" ? "PNG" : "JPEG"} image cannot be decoded. Export it again and retry.`);
  }
  return dimensions;
}

function encrypted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = "message" in error ? String(error.message) : "";
  return name === "PasswordException" || /password|encrypted/i.test(message);
}

async function openPdf(bytes: Uint8Array) {
  try {
    return await getDocumentProxy(Uint8Array.from(bytes));
  } catch (error) {
    if (encrypted(error)) fail("ENCRYPTED_PDF", "Password-protected PDFs are not supported. Remove the password and upload again.");
    fail("CORRUPT_FILE", "This PDF cannot be read. Re-export it as a valid PDF and retry.");
  }
}

async function destroyPdf(pdf: Awaited<ReturnType<typeof getDocumentProxy>>): Promise<void> {
  try {
    await (pdf as typeof pdf & { destroy?: () => Promise<void> }).destroy?.();
  } catch {
    // Destruction errors do not replace the already-sanitized operation result.
  }
}

function validViewport(viewport: { width: number; height: number }): void {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    viewport.width > 100_000 ||
    viewport.height > 100_000
  ) {
    fail("CORRUPT_FILE", "This PDF contains an unreadable page. Re-export it and retry.");
  }
}

export type Inspection = {
  mimeType: DocumentMime;
  pageCount: number;
  width: number | null;
  height: number | null;
};

export async function inspectInWorker(bytes: Uint8Array, mimeValue: string): Promise<Inspection> {
  if (bytes.byteLength === 0) fail("EMPTY_FILE", "The selected report is empty. Choose it again.");
  if (bytes.byteLength > MAX_FILE_BYTES) fail("FILE_TOO_LARGE", "Bloodwork files must be 20 MB or smaller.");
  const declared = declaredMime(mimeValue);
  const detected = detect(bytes);
  if (!detected) fail("CORRUPT_FILE", "This file is not a readable PDF, JPEG, or PNG.");
  if (detected !== declared) fail("TYPE_MISMATCH", "The selected file type does not match its contents. Export it again.");
  if (detected !== "application/pdf") {
    const dimensions = await inspectImage(bytes, detected);
    return { mimeType: detected, pageCount: 1, ...dimensions };
  }

  const pdf = await openPdf(bytes);
  try {
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) {
      fail("CORRUPT_FILE", "This PDF contains no readable pages. Re-export it and retry.");
    }
    if (pdf.numPages > MAX_PDF_PAGES) {
      fail("TOO_MANY_PAGES", `This PDF has more than ${MAX_PDF_PAGES} pages. Split it into smaller reports.`);
    }
    // getOperatorList resolves page dictionaries, content streams, fonts and
    // image resources. Merely trusting numPages leaves dangling Kids entries
    // undiscovered until a later render.
    for (let page = 1; page <= pdf.numPages; page++) {
      try {
        const proxy = await pdf.getPage(page);
        validViewport(proxy.getViewport({ scale: 1 }));
        await (proxy as typeof proxy & { getOperatorList: () => Promise<unknown> }).getOperatorList();
      } catch (error) {
        if (error instanceof WorkerDocumentError) throw error;
        fail("CORRUPT_FILE", "This PDF contains an unreadable page. Re-export it and retry.");
      }
    }
    return { mimeType: detected, pageCount: pdf.numPages, width: null, height: null };
  } finally {
    await destroyPdf(pdf);
  }
}

export async function renderInWorker(bytes: Uint8Array, mime: string, page: number) {
  const inspection = await inspectInWorker(bytes, mime);
  if (!Number.isSafeInteger(page) || page < 1 || page > inspection.pageCount) {
    fail("PAGE_OUT_OF_RANGE", `Choose a page between 1 and ${inspection.pageCount}.`);
  }
  if (inspection.mimeType !== "application/pdf") return { ...inspection, output: undefined };
  const pdf = await openPdf(bytes);
  try {
    const proxy = await pdf.getPage(page);
    const viewport = proxy.getViewport({ scale: 1 });
    validViewport(viewport);
    const scale = Math.min(RENDER_LONG_EDGE / Math.max(viewport.width, viewport.height), 4);
    const width = Math.max(1, Math.ceil(viewport.width * scale));
    let rendered: ArrayBuffer;
    try {
      rendered = await renderPageAsImage(pdf, page, {
        canvasImport: () => import("@napi-rs/canvas"),
        width,
      });
    } catch {
      fail("RENDER_FAILED", "This PDF page could not be rendered. Re-export the PDF and retry.");
    }
    const output = Buffer.from(rendered);
    const dimensions = await inspectImage(output, "image/png");
    return { mimeType: "image/png" as const, pageCount: inspection.pageCount, ...dimensions, output };
  } finally {
    await destroyPdf(pdf);
  }
}