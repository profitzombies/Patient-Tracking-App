/**
 * Text extraction for AI Support knowledge documents.
 *
 * PDF text comes out via unpdf (pdf.js under the hood), Word documents via
 * mammoth, and plain text / Markdown is just decoded as UTF-8. There is no
 * OCR on purpose: a PDF with no selectable text layer (scanned pages,
 * exported images) throws EmptyTextError with a plain explanation, and the
 * caller marks the document failed — never silently empty.
 */
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Types the upload endpoints accept (.pdf, .docx, .txt, .md). */
export const DOCUMENT_CONTENT_TYPES = new Set([PDF_MIME, DOCX_MIME, "text/plain", "text/markdown"]);

/** The file parsed fine but contains no usable text — a FAILED document. */
export class EmptyTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyTextError";
    Object.setPrototypeOf(this, EmptyTextError.prototype);
  }
}

/**
 * Tidy extracted text without rewriting it: normalize newlines, drop control
 * characters and the BOM, trim trailing whitespace per line, and collapse
 * runaway blank-line stacks. Indentation is left alone so Markdown and
 * code-ish content survive.
 */
export function normalizeExtractedText(raw: string): string {
  return raw
    .replace(/\uFEFF/g, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function hasVisibleText(text: string): boolean {
  return text.replace(/\s/g, "").length > 0;
}

async function extractPdfText(content: Buffer): Promise<string> {
  let merged: string;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(content));
    const { text } = await extractText(pdf, { mergePages: true });
    merged = text;
  } catch (cause) {
    throw new Error("That file couldn't be read as a PDF — re-export it and upload again.", { cause });
  }
  const text = normalizeExtractedText(merged);
  if (!hasVisibleText(text)) {
    throw new EmptyTextError(
      "No selectable text found — this PDF looks scanned or image-only, and OCR isn't supported. Replace it with a text-based export.",
    );
  }
  return text;
}

async function extractDocxText(content: Buffer): Promise<string> {
  let raw: string;
  try {
    const result = await mammoth.extractRawText({ buffer: content });
    raw = result.value;
  } catch (cause) {
    throw new Error(
      "That file couldn't be read as a Word document (.docx) — re-save it and upload again.",
      { cause },
    );
  }
  const text = normalizeExtractedText(raw);
  if (!hasVisibleText(text)) {
    throw new EmptyTextError("The Word document contains no text.");
  }
  return text;
}

function extractPlainText(content: Buffer): string {
  const text = normalizeExtractedText(content.toString("utf8"));
  if (!hasVisibleText(text)) {
    throw new EmptyTextError("The file is empty.");
  }
  return text;
}

/**
 * Full text of an uploaded document, normalized. Throws EmptyTextError when
 * the file parses but holds no text, and a plain-words Error when it cannot
 * be parsed at all — both become the document's failed-status message.
 */
export async function extractDocumentText(content: Buffer, contentType: string): Promise<string> {
  switch (contentType) {
    case PDF_MIME:
      return extractPdfText(content);
    case DOCX_MIME:
      return extractDocxText(content);
    case "text/plain":
    case "text/markdown":
      return extractPlainText(content);
    default:
      throw new Error(`Unsupported document type: ${contentType}`);
  }
}
