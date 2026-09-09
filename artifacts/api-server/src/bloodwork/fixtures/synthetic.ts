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