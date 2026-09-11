import { createCanvas } from "@napi-rs/canvas";

export type SyntheticExpectedBloodworkRow = {
  testName: string | null;
  valueText: string | null;
  units: string | null;
  referenceRange: string | null;
  labFlag: string | null;
  uncertain: boolean;
};

export type SyntheticBenchmarkKind = "born-digital" | "scanned" | "mixed";

export type SyntheticBenchmarkPage = {
  page: number;
  sourcePage: number;
  fileId: string;
  mimeType: "application/pdf" | "image/png" | "image/jpeg";
  bytes: Buffer;
  expected: SyntheticExpectedBloodworkRow[];
  quality: "clear" | "poor";
};

export type SyntheticBenchmarkReport = {
  id: `${SyntheticBenchmarkKind}-${1 | 2 | 6}`;
  kind: SyntheticBenchmarkKind;
  pageCount: 1 | 2 | 6;
  routeCompatible: boolean;
  pages: SyntheticBenchmarkPage[];
};

function escapePdfText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function makePdf(streams: string[], width = 612, height = 792): Buffer {
  const pageCount = streams.length;
  const fontId = pageCount + 3;
  const contentStart = fontId + 1;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    ...streams.map(
      (_, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentStart + index} 0 R >>`,
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...streams.map(
      (stream) => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ),
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

type PdfPage =
  | { kind: "text"; stream: string }
  | { kind: "image"; bytes: Buffer; width: number; height: number };

/** Builds an ordinary PDF with JPEG/DCTDecode image pages, not an image MIME manifest. */
function makePdfDocument(pages: PdfPage[], width = 612, height = 792): Buffer {
  const fontId = pages.length + 3;
  let nextObjectId = fontId + 1;
  const imageIds = pages.map((page) => page.kind === "image" ? nextObjectId++ : null);
  const contentIds = pages.map(() => nextObjectId++);
  const pageObjects = pages.map((page, index) => {
    const resources = page.kind === "image"
      ? `<< /XObject << /Im1 ${imageIds[index]} 0 R >> >>`
      : `<< /Font << /F1 ${fontId} 0 R >> >>`;
    return `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources ${resources} /Contents ${contentIds[index]} 0 R >>`;
  });
  const imageObjects = pages.flatMap((page, index) => {
    if (page.kind !== "image") return [];
    return [
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\n` +
      `stream\n${page.bytes.toString("binary")}\nendstream`,
    ];
  });
  const contentObjects = pages.map((page) => {
    if (page.kind === "image") return "q 612 0 0 792 0 0 cm /Im1 Do Q";
    return page.stream;
  });
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    ...pageObjects,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...imageObjects,
    ...contentObjects.map(
      (stream) => `<< /Length ${Buffer.byteLength(stream, "binary")} >>\nstream\n${stream}\nendstream`,
    ),
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "binary"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "binary");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

function expectedRows(page: number): SyntheticExpectedBloodworkRow[] {
  return [
    {
      testName: "Glucose",
      valueText: page % 2 === 0 ? "92.00" : "91.50",
      units: "mg/dL",
      referenceRange: "70-99",
      labFlag: "N",
      uncertain: false,
    },
    {
      testName: "Marker A",
      valueText: "<5",
      units: "IU/L",
      referenceRange: "Negative: <5; Equivocal: 5-10",
      labFlag: "Negative",
      uncertain: false,
    },
    {
      testName: "TSH",
      valueText: page % 3 === 0 ? "2.35" : "0.40",
      units: "mIU/L",
      referenceRange: "0.40-4.50",
      labFlag: page % 3 === 0 ? "N" : "L",
      uncertain: false,
    },
    {
      testName: "Duplicate Marker",
      valueText: "1.0",
      units: "mg/L",
      referenceRange: "0.0-2.0",
      labFlag: "N",
      uncertain: false,
    },
    {
      // Two equal labels/values are intentional: they are two printed rows,
      // not a license for a model to add a third duplicate.
      testName: "Duplicate Marker",
      valueText: "1.0",
      units: "mg/L",
      referenceRange: "0.0-2.0",
      labFlag: "N",
      uncertain: false,
    },
    {
      testName: "Screen",
      valueText: "Negative",
      units: null,
      referenceRange: null,
      labFlag: null,
      uncertain: false,
    },
  ];
}

function pageText(page: number, rows: SyntheticExpectedBloodworkRow[]): string {
  const lines = [
    `SYNTHETIC ${page === 1 ? "LABORATORY" : "FOLLOW-UP"} REPORT PAGE ${page}`,
    ...rows.map((row) =>
      [
        row.testName ?? "",
        row.valueText ?? "",
        row.units ?? "",
        row.referenceRange ?? "",
        row.labFlag ?? "",
      ].join("    "),
    ),
  ];
  return [
    "BT /F1 14 Tf 54 744 Td",
    `(${escapePdfText(lines[0]!)}) Tj`,
    ...lines.slice(1).map((line) => `0 -30 Td (${escapePdfText(line)}) Tj`),
    "ET",
  ].join(" ");
}

function scannedPage(
  page: number,
  rows: SyntheticExpectedBloodworkRow[],
  poor: boolean,
  mimeType: "image/png" | "image/jpeg",
): Buffer {
  const canvas = createCanvas(1_600, 2_000);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalAlpha = poor ? 0.58 : 1;
  context.fillStyle = "#141414";
  context.font = poor ? "bold 32px sans-serif" : "bold 44px sans-serif";
  context.fillText(`SYNTHETIC SCANNED REPORT PAGE ${page}`, 70, 110);
  context.font = poor ? "25px sans-serif" : "34px sans-serif";
  rows.forEach((row, index) => {
    const line = [
      row.testName ?? "",
      row.valueText ?? "",
      row.units ?? "",
      row.referenceRange ?? "",
      row.labFlag ?? "",
    ].join("     ");
    context.fillText(line, 70, 220 + index * (poor ? 44 : 54));
  });
  if (poor) {
    context.globalAlpha = 0.12;
    context.fillStyle = "#8b8b8b";
    for (let y = 160; y < canvas.height; y += 12) context.fillRect(0, y, canvas.width, 2);
  }
  return mimeType === "image/png"
    ? canvas.toBuffer("image/png")
    : canvas.toBuffer("image/jpeg", poor ? 38 : 92);
}

function digitalPage(page: number, rows: SyntheticExpectedBloodworkRow[]): SyntheticBenchmarkPage {
  return {
    page,
    sourcePage: page,
    fileId: `page-${page}`,
    mimeType: "application/pdf",
    bytes: makePdf([pageText(page, rows)]),
    expected: rows,
    quality: "clear",
  };
}

function imagePage(
  page: number,
  rows: SyntheticExpectedBloodworkRow[],
  poor: boolean,
): SyntheticBenchmarkPage {
  return {
    page,
    sourcePage: 1,
    fileId: `page-${page}`,
    mimeType: "image/png",
    bytes: scannedPage(page, rows, poor, "image/png"),
    expected: rows,
    quality: poor ? "poor" : "clear",
  };
}

function imagePdfPage(
  page: number,
  rows: SyntheticExpectedBloodworkRow[],
  poor: boolean,
): PdfPage {
  return {
    kind: "image",
    bytes: scannedPage(page, rows, poor, "image/jpeg"),
    width: 1_600,
    height: 2_000,
  };
}

/** Deterministic PDF reports used by the benchmark harness. */
export function syntheticBenchmarkReport(
  kind: SyntheticBenchmarkKind,
  pageCount: 1 | 2 | 6,
): SyntheticBenchmarkReport {
  const pageRows = Array.from({ length: pageCount }, (_, index) => expectedRows(index + 1));
  const pdfPages: PdfPage[] = pageRows.map((rows, index) => {
    const page = index + 1;
    if (kind === "born-digital") return { kind: "text", stream: pageText(page, rows) };
    if (kind === "scanned") return imagePdfPage(page, rows, page === pageCount);
    return page % 2 === 0
      ? { kind: "text", stream: pageText(page, rows) }
      : imagePdfPage(page, rows, page === pageCount);
  });
  const document = makePdfDocument(pdfPages);
  const pages = pageRows.map((rows, index) => ({
    page: index + 1,
    sourcePage: index + 1,
    fileId: "report",
    mimeType: "application/pdf" as const,
    bytes: document,
    expected: rows,
    quality: kind === "born-digital"
      ? "clear" as const
      : pdfPages[index]!.kind === "image" && index + 1 === pageCount
        ? "poor" as const
        : "clear" as const,
  }));
  return {
    id: `${kind}-${pageCount}`,
    kind,
    pageCount,
    routeCompatible: true,
    pages,
  };
}

export function syntheticBenchmarkReports(): SyntheticBenchmarkReport[] {
  return (["born-digital", "scanned", "mixed"] as const).flatMap((kind) =>
    ([1, 2, 6] as const).map((pageCount) => syntheticBenchmarkReport(kind, pageCount)),
  );
}

/** A deterministic 201-row page for the fail-closed overflow benchmark. */
export function syntheticOverflowBenchmarkPage(): {
  bytes: Buffer;
  mimeType: "application/pdf";
  expectedRows: number;
  rowCoordinates: Array<{ label: string; x: number; y: number; width: number }>;
} {
  const expectedRows = 201;
  const columns = [20, 220, 420];
  const rowsPerColumn = Math.ceil(expectedRows / columns.length);
  const rowCoordinates: Array<{ label: string; x: number; y: number; width: number }> = [];
  const commands = ["BT /F1 8 Tf"];
  for (let column = 0; column < columns.length; column += 1) {
    const x = columns[column]!;
    for (let row = 0; row < rowsPerColumn; row += 1) {
      const index = column * rowsPerColumn + row;
      if (index >= expectedRows) break;
      const label = `R${String(index + 1).padStart(3, "0")}`;
      const y = 760 - row * 9;
      const line = `${label} ${String(index + 1).padStart(3, "0")}.00 U 0-999 N`;
      commands.push(`${x} ${y} Td (${escapePdfText(line)}) Tj`);
      // At 8pt this fixed estimate is below the 180pt column width, keeping
      // every label and field visibly inside the page.
      rowCoordinates.push({ label, x, y, width: 120 });
      commands.push(`${-x} ${-y} Td`);
    }
  }
  commands.push("ET");
  return {
    bytes: makePdf([commands.join(" ")], 612, 792),
    mimeType: "application/pdf",
    expectedRows,
    rowCoordinates,
  };
}

/** Deterministic two-page, text-based PDF containing synthetic lab values. */
export function syntheticTwoPageBloodworkPdf(): Buffer {
  const streams = [
    "BT /F1 14 Tf 60 740 Td (SYNTHETIC LAB REPORT - PAGE 1) Tj 0 -30 Td (Glucose 92 mg/dL 70-99) Tj 0 -24 Td (Marker A <5 IU/L Negative) Tj ET",
    "BT /F1 14 Tf 60 560 Td (SYNTHETIC LAB REPORT - PAGE 2) Tj 0 -30 Td (TSH 2.35 mIU/L 0.40-4.50) Tj 0 -24 Td (Screen Negative) Tj ET",
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(streams[0])} >>\nstream\n${streams[0]}\nendstream`,
    `<< /Length ${Buffer.byteLength(streams[1])} >>\nstream\n${streams[1]}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

/** Declares a second page whose indirect object does not exist. */
export function syntheticDanglingPageBloodworkPdf(): Buffer {
  const valid = syntheticTwoPageBloodworkPdf();
  // Equal-width replacement intentionally preserves all xref byte offsets.
  return Buffer.from(valid.toString().replace("/Kids [3 0 R 4 0 R]", "/Kids [3 0 R 9 0 R]"));
}

/** Has a syntactically present page with resource-hostile coordinate bounds. */
export function syntheticInvalidPageBoundsBloodworkPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000000000 1000000000] /Resources << >> >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 4\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

/** Explicit upper-bound page-count fixture with a resolvable text stream. */
export function syntheticMaxPageBloodworkPdf(): Buffer {
  const pageCount = 100;
  const fontId = pageCount + 3;
  const contentId = fontId + 1;
  const kids = Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ");
  const text = "BT /F1 10 Tf 10 20 Td (SYNTHETIC Glucose 92 mg/dL) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    ...Array.from(
      { length: pageCount },
      () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

/**
 * Structurally valid Standard-security PDF. Its synthetic owner/user keys are
 * intentionally unusable, so readers must identify it as password protected.
 */
export function syntheticEncryptedBloodworkPdf(): Buffer {
  const stream = "BT /F1 14 Tf 60 740 Td (SYNTHETIC ENCRYPTED REPORT) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Filter /Standard /V 1 /R 2 /Length 40 /O <00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff> /U <ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100> /P -4 >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R ` +
    "/ID [<0123456789abcdef0123456789abcdef><0123456789abcdef0123456789abcdef>] >>\n" +
    `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}