/**
 * Extraction against REAL file bytes — a hand-built one-page PDF, a real
 * .docx zip, and plain text — so the parsers themselves are exercised, not
 * mocks of them. The scanned-PDF case (a page with no text operators) must
 * fail loudly with the no-OCR explanation, never return "".
 */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  DOCX_MIME,
  EmptyTextError,
  PDF_MIME,
  extractDocumentText,
  normalizeExtractedText,
} from "./extract";

/** A minimal but valid one-page PDF whose page draws `contentStream`. */
function buildPdf(contentStream: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function buildDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  );
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("");
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("PDF extraction", () => {
  it("pulls the text layer out of a real PDF", async () => {
    const pdf = buildPdf(
      "BT /F1 12 Tf 72 712 Td (THINNR approved foods: lean proteins and greens.) Tj ET",
    );
    const text = await extractDocumentText(pdf, PDF_MIME);
    expect(text).toContain("THINNR approved foods");
    expect(text).toContain("lean proteins and greens.");
  });

  it("fails a text-free (scanned-style) PDF with the no-OCR explanation", async () => {
    const pdf = buildPdf("0 0 200 200 re f");
    await expect(extractDocumentText(pdf, PDF_MIME)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof EmptyTextError && /scanned or image-only/.test(error.message),
    );
  });

  it("reports an unreadable PDF in plain words", async () => {
    await expect(
      extractDocumentText(Buffer.from("%PDF-1.4 not really a pdf"), PDF_MIME),
    ).rejects.toThrow(/couldn't be read as a PDF/);
  });
});

describe("DOCX extraction", () => {
  it("pulls paragraphs out of a real .docx", async () => {
    const docx = await buildDocx([
      "Clinic staff quick answers.",
      "Shipments arrive within five business days.",
    ]);
    const text = await extractDocumentText(docx, DOCX_MIME);
    expect(text).toContain("Clinic staff quick answers.");
    expect(text).toContain("five business days");
  });

  it("fails an empty .docx loudly", async () => {
    const docx = await buildDocx([]);
    await expect(extractDocumentText(docx, DOCX_MIME)).rejects.toBeInstanceOf(EmptyTextError);
  });

  it("reports a corrupt .docx in plain words", async () => {
    await expect(
      extractDocumentText(Buffer.from("this is not a zip archive at all"), DOCX_MIME),
    ).rejects.toThrow(/couldn't be read as a Word document/);
  });
});

describe("plain text and Markdown", () => {
  it("decodes UTF-8 text as-is", async () => {
    const text = await extractDocumentText(
      Buffer.from("Protein first.\r\nThen vegetables — always.\r\n", "utf8"),
      "text/plain",
    );
    expect(text).toBe("Protein first.\nThen vegetables — always.");
  });

  it("keeps Markdown structure", async () => {
    const text = await extractDocumentText(
      Buffer.from("# Dosing\n\n- Week 1: 0.25 mg\n- Week 2: 0.5 mg\n", "utf8"),
      "text/markdown",
    );
    expect(text).toBe("# Dosing\n\n- Week 1: 0.25 mg\n- Week 2: 0.5 mg");
  });

  it("fails whitespace-only files loudly", async () => {
    await expect(extractDocumentText(Buffer.from("  \n\n\t "), "text/plain")).rejects.toBeInstanceOf(
      EmptyTextError,
    );
  });

  it("rejects types the allowlist should have stopped", async () => {
    await expect(extractDocumentText(Buffer.from("x"), "image/png")).rejects.toThrow(
      /Unsupported document type/,
    );
  });
});

describe("normalizeExtractedText", () => {
  it("strips control characters, BOM, and trailing space; collapses blank stacks", () => {
    const raw = "\uFEFFLine one  \r\nLine two\u0000\u0007\r\n\n\n\n\n\nLine three\t \n";
    expect(normalizeExtractedText(raw)).toBe("Line one\nLine two\n\n\nLine three");
  });

  it("leaves indentation alone", () => {
    expect(normalizeExtractedText("plan:\n    - step\n")).toBe("plan:\n    - step");
  });
});
