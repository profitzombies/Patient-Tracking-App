/**
 * Printable summary of one patient's record, rendered from the same section
 * data the archive carries (never a second set of reads). Plain Helvetica on
 * US Letter; tables break across pages by row.
 *
 * Standard PDF fonts cover WinAnsi only, so characters outside it (emoji,
 * non-Latin scripts) are dropped from the printed text and a footnote says
 * so; the JSON files in the archive keep the original text.
 */
import PDFDocument from "pdfkit";
import { ARCHIVE_FILE_GUIDE, type PatientArchiveSections } from "../privacy/exports";
import type { PatientChartContext, RecordManifestFile, RecordManifestOmission } from "./patient-record";

export interface RecordSummaryInput {
  sections: PatientArchiveSections;
  chart: PatientChartContext;
  generatedAt: string;
  exportId: string | null;
  parts: string[];
  photoFiles: RecordManifestFile[];
  omitted: RecordManifestOmission[];
}

const PAGE = { width: 612, height: 792, margin: 48 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;
const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";

/**
 * Set while a render drops unprintable characters. Rendering is synchronous
 * from reset to read (the only await is for the document's end event), so
 * one module-level flag cannot mix two renders.
 */
let droppedCharacters = false;

/** Keep text inside what the standard fonts can encode. */
function printable(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
  const cleaned = text.replace(/[^\u0009\u000a\u000d\u0020-\u007e\u00a0-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026]/g, () => {
    droppedCharacters = true;
    return "";
  });
  return cleaned.replace(/\s+\n/g, "\n").trim();
}

function fmtDate(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : value;
}

function fmtDateTime(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function money(cents: unknown): string {
  const value = typeof cents === "number" ? cents : Number(cents);
  if (!Number.isFinite(value)) return "";
  return `$${(value / 100).toFixed(2)}`;
}

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type Doc = InstanceType<typeof PDFDocument>;

function ensureRoom(doc: Doc, height: number): void {
  if (doc.y + height > PAGE.height - PAGE.margin) doc.addPage();
}

function heading(doc: Doc, text: string): void {
  ensureRoom(doc, 40);
  doc.moveDown(0.8);
  doc.font(FONT_BOLD).fontSize(14).fillColor("#0f2a5a").text(text, PAGE.margin, doc.y, { width: CONTENT_WIDTH });
  doc.moveTo(PAGE.margin, doc.y + 2).lineTo(PAGE.width - PAGE.margin, doc.y + 2).lineWidth(0.8).strokeColor("#0f2a5a").stroke();
  doc.moveDown(0.6);
  doc.font(FONT).fontSize(10).fillColor("#111111");
}

function paragraph(doc: Doc, text: string, options: { italic?: boolean } = {}): void {
  ensureRoom(doc, 24);
  doc.font(options.italic ? "Helvetica-Oblique" : FONT).fontSize(10).fillColor("#111111");
  doc.text(printable(text), PAGE.margin, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.3);
}

function keyValues(doc: Doc, rows: Array<[string, unknown]>): void {
  const labelWidth = 150;
  for (const [label, value] of rows) {
    const text = printable(value) || "—";
    const height = Math.max(
      doc.font(FONT_BOLD).fontSize(10).heightOfString(label, { width: labelWidth }),
      doc.font(FONT).fontSize(10).heightOfString(text, { width: CONTENT_WIDTH - labelWidth }),
    );
    ensureRoom(doc, height + 4);
    const y = doc.y;
    doc.font(FONT_BOLD).fontSize(10).fillColor("#333333").text(label, PAGE.margin, y, { width: labelWidth });
    doc.font(FONT).fontSize(10).fillColor("#111111").text(text, PAGE.margin + labelWidth, y, { width: CONTENT_WIDTH - labelWidth });
    doc.y = y + height + 3;
  }
  doc.moveDown(0.3);
}

interface Column {
  header: string;
  /** Fraction of the content width. */
  width: number;
}

function table(doc: Doc, columns: Column[], rows: string[][], emptyText = "None recorded."): void {
  if (rows.length === 0) {
    paragraph(doc, emptyText, { italic: true });
    return;
  }
  const widths = columns.map((column) => Math.floor(column.width * CONTENT_WIDTH));
  const drawHeader = () => {
    const y = doc.y;
    doc.font(FONT_BOLD).fontSize(8.5).fillColor("#333333");
    let x = PAGE.margin;
    columns.forEach((column, index) => {
      doc.text(column.header, x + 2, y, { width: widths[index] - 4 });
      x += widths[index];
    });
    doc.y = y + 13;
    doc.moveTo(PAGE.margin, doc.y).lineTo(PAGE.width - PAGE.margin, doc.y).lineWidth(0.5).strokeColor("#999999").stroke();
    doc.y += 3;
  };
  ensureRoom(doc, 40);
  drawHeader();
  doc.font(FONT).fontSize(8.5).fillColor("#111111");
  for (const row of rows) {
    const cells = row.map((cell) => printable(cell));
    const height = Math.max(
      12,
      ...cells.map((cell, index) => doc.heightOfString(cell || " ", { width: widths[index] - 4 })),
    );
    if (doc.y + height + 4 > PAGE.height - PAGE.margin) {
      doc.addPage();
      drawHeader();
      doc.font(FONT).fontSize(8.5).fillColor("#111111");
    }
    const y = doc.y;
    let x = PAGE.margin;
    cells.forEach((cell, index) => {
      doc.text(cell, x + 2, y, { width: widths[index] - 4 });
      x += widths[index];
    });
    doc.y = y + height + 3;
  }
  doc.moveDown(0.4);
}

function latestBy<T extends Record<string, unknown>>(rows: T[], key: string): T | null {
  let best: T | null = null;
  for (const row of rows) {
    const value = String(row[key] ?? "");
    if (!best || value > String(best[key] ?? "")) best = row;
  }
  return best;
}

function patientName(profile: Record<string, unknown> | null): string {
  if (!profile) return "Unknown patient";
  const full = [profile.first_name, profile.last_name].filter((part) => typeof part === "string" && part).join(" ");
  return full || (typeof profile.name === "string" && profile.name) || "Unknown patient";
}

export async function renderRecordSummaryPdf(input: RecordSummaryInput): Promise<Buffer> {
  droppedCharacters = false;
  const { sections, chart } = input;
  const profile = sections.profile;
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
    info: { Title: `Patient record summary — ${printable(patientName(profile))}`, Author: "THINNR" },
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // ── Title ──────────────────────────────────────────────────────────────
  doc.font(FONT_BOLD).fontSize(20).fillColor("#0f2a5a").text("Patient record summary", PAGE.margin, PAGE.margin, { width: CONTENT_WIDTH });
  doc.font(FONT).fontSize(10).fillColor("#555555");
  doc.text(printable(`${patientName(profile)} · ${chart.officeName ?? "Office"} · generated ${fmtDateTime(input.generatedAt)}`), { width: CONTENT_WIDTH });
  if (input.exportId) doc.text(`Export ${input.exportId}`, { width: CONTENT_WIDTH });
  doc.moveDown(0.5);
  paragraph(
    doc,
    "This summary is a printable overview of the record. The complete record, including every diary entry, message, photo, and lab file, is in the JSON files and folders of this archive. See the last section for what each file contains.",
  );

  // ── Identity & enrollment ──────────────────────────────────────────────
  heading(doc, "Identity");
  keyValues(doc, [
    ["Name", patientName(profile)],
    ["Patient id", chart.patientId],
    ["Email", profile?.email],
    ["Phone", profile?.phone],
    ["Date of birth", fmtDate(profile?.date_of_birth)],
    ["Sex", profile?.sex ?? profile?.gender],
    ["Height", profile?.height_cm ? `${profile.height_cm} cm` : profile?.height_inches ? `${profile.height_inches} in` : ""],
    ["Time zone", profile?.timezone],
    ["Account created", fmtDateTime(profile?.created_at)],
    ["Account claimed", fmtDateTime(profile?.claimed_at)],
  ]);

  heading(doc, "Enrollment and chart status");
  keyValues(doc, [
    ["Office", chart.officeName ?? chart.providerId],
    ["Chart status", chart.activationStatus ? titleCase(chart.activationStatus) : "Unknown"],
    ["Status reason", chart.activationReason],
    ["Status changed", fmtDateTime(chart.activationUpdatedAt)],
    ["Program", chart.programId ?? profile?.program_id],
    ["Program start", fmtDate(profile?.program_start_date)],
    ["Onboarding completed", fmtDateTime(profile?.onboarded_at ?? profile?.profile_completed_at)],
    ["Starting weight", profile?.starting_weight],
    ["Goal weight", profile?.goal_weight],
    ["Deletion requested", fmtDateTime(chart.deletionRequestedAt)],
  ]);

  // ── Latest measurements ────────────────────────────────────────────────
  heading(doc, "Latest measurements");
  const lastCheckIn = latestBy(sections.checkIns.filter((row) => row.weight != null), "date_key");
  const lastClinic = latestBy(sections.measurements.clinicWeights, "date_key");
  const lastBody = latestBy(sections.measurements.bodyMeasurements, "date_key");
  const healthByKind = new Map<string, Record<string, unknown>>();
  for (const row of sections.measurements.healthImports) {
    const kind = String(row.kind ?? "");
    const current = healthByKind.get(kind);
    if (!current || String(row.measured_at ?? "") > String(current.measured_at ?? "")) healthByKind.set(kind, row);
  }
  keyValues(doc, [
    ["Current weight (profile)", profile?.current_weight],
    ["Last self-reported weight", lastCheckIn ? `${lastCheckIn.weight} on ${fmtDate(lastCheckIn.date_key)}` : ""],
    ["Last clinic weight", lastClinic ? `${lastClinic.weight} on ${fmtDate(lastClinic.date_key)}${lastClinic.recorded_by_name ? ` (${lastClinic.recorded_by_name})` : ""}` : ""],
    ["Check-ins on file", sections.checkIns.length],
    ["Clinic weights on file", sections.measurements.clinicWeights.length],
  ]);
  if (lastBody) {
    paragraph(doc, `Latest body measurements (${fmtDate(lastBody.date_key)}${lastBody.recorded_by_name ? `, ${lastBody.recorded_by_name}` : ""}):`);
    const areas: Array<[string, string]> = [
      ["neck", "Neck"], ["chest", "Chest"], ["left_arm", "Left arm"], ["right_arm", "Right arm"], ["waist", "Waist"],
      ["hips", "Hips"], ["left_thigh", "Left thigh"], ["right_thigh", "Right thigh"], ["left_calf", "Left calf"], ["right_calf", "Right calf"],
    ];
    table(
      doc,
      [{ header: "Area", width: 0.5 }, { header: "Measurement", width: 0.5 }],
      areas.filter(([key]) => lastBody[key] != null).map(([key, label]) => [label, String(lastBody[key])]),
    );
  }
  if (healthByKind.size > 0) {
    table(
      doc,
      [{ header: "Imported health data", width: 0.4 }, { header: "Latest value", width: 0.3 }, { header: "Measured", width: 0.3 }],
      [...healthByKind.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, row]) => [titleCase(kind), String(row.value ?? ""), fmtDateTime(row.measured_at)]),
    );
  }

  // ── Medications ────────────────────────────────────────────────────────
  heading(doc, "Medications and dose history");
  const doseStats = new Map<string, { taken: number; skipped: number; other: number; lastTaken: string }>();
  for (const log of sections.medications.doseLogs) {
    const id = String(log.medication_id ?? "");
    const stat = doseStats.get(id) ?? { taken: 0, skipped: 0, other: 0, lastTaken: "" };
    const status = String(log.status ?? "");
    if (status === "taken") {
      stat.taken += 1;
      const when = fmtDate(log.due_date);
      if (when > stat.lastTaken) stat.lastTaken = when;
    } else if (status === "skipped") stat.skipped += 1;
    else stat.other += 1;
    doseStats.set(id, stat);
  }
  table(
    doc,
    [
      { header: "Medication", width: 0.2 },
      { header: "Dose / form", width: 0.16 },
      { header: "Schedule", width: 0.16 },
      { header: "Started", width: 0.1 },
      { header: "Stopped", width: 0.1 },
      { header: "Taken", width: 0.07 },
      { header: "Skipped", width: 0.08 },
      { header: "Last taken", width: 0.13 },
    ],
    sections.medications.list.map((med) => {
      const stat = doseStats.get(String(med.id ?? ""));
      const schedule = [med.schedule_kind, Array.isArray(med.times) ? med.times.join(", ") : med.times, med.weekday]
        .filter((part) => part !== null && part !== undefined && part !== "")
        .map(String)
        .join(" · ");
      return [
        String(med.name ?? ""),
        [med.dose, med.form].filter(Boolean).map(String).join(" "),
        schedule,
        fmtDate(med.start_date),
        fmtDate(med.stop_date),
        String(stat?.taken ?? 0),
        String(stat?.skipped ?? 0),
        stat?.lastTaken ?? "",
      ];
    }),
    "No medications recorded.",
  );

  // ── Bloodwork ──────────────────────────────────────────────────────────
  heading(doc, "Bloodwork results");
  if (sections.bloodwork.reports.length === 0) paragraph(doc, "No bloodwork reports on file.", { italic: true });
  for (const report of sections.bloodwork.reports) {
    const results = sections.bloodwork.results.filter((row) => String(row.report_id) === String(report.id));
    ensureRoom(doc, 40);
    doc.font(FONT_BOLD).fontSize(10.5).fillColor("#111111").text(
      printable(`${report.title || "Report"} · ${fmtDate(report.report_date) || "date unknown"} · ${titleCase(String(report.lifecycle_status ?? ""))}${report.reviewed_at ? " · reviewed" : " · not yet reviewed"}`),
      PAGE.margin,
      doc.y,
      { width: CONTENT_WIDTH },
    );
    doc.moveDown(0.2);
    table(
      doc,
      [
        { header: "Test", width: 0.34 },
        { header: "Value", width: 0.16 },
        { header: "Units", width: 0.14 },
        { header: "Reference range", width: 0.22 },
        { header: "Flag", width: 0.14 },
      ],
      results.map((row) => [
        String(row.test_name ?? row.original_test_name ?? ""),
        String(row.value_text ?? row.original_value_text ?? ""),
        String(row.units ?? row.original_units ?? ""),
        String(row.reference_range ?? row.original_reference_range ?? ""),
        [row.lab_flag ?? row.original_lab_flag, row.uncertain ? "uncertain" : null, row.corrected ? "corrected" : null].filter(Boolean).map(String).join(", "),
      ]),
      "No published results for this report (see bloodwork.json for transcription status).",
    );
  }
  const incomplete = sections.bloodwork.incompleteTranscriptionPages.length;
  if (incomplete > 0) {
    paragraph(doc, `${incomplete} page(s) are still being transcribed or failed transcription; their checkpoints are in bloodwork.json under incompleteTranscriptionPages.`, { italic: true });
  }

  // ── Photos ─────────────────────────────────────────────────────────────
  heading(doc, "Progress photos");
  const photoFileByPath = new Map(input.photoFiles.map((entry) => [entry.objectPath ?? "", entry]));
  table(
    doc,
    [
      { header: "Date", width: 0.14 },
      { header: "Label", width: 0.22 },
      { header: "Angle", width: 0.12 },
      { header: "File in archive", width: 0.4 },
      { header: "Part", width: 0.12 },
    ],
    sections.photos.map((photo) => {
      const placed = photoFileByPath.get(String(photo.object_path ?? ""));
      const omitted = input.omitted.find((entry) => entry.objectPath === photo.object_path);
      return [
        fmtDate(photo.date_key),
        String(photo.label ?? ""),
        String(photo.angle ?? ""),
        placed ? placed.file : omitted ? `not included (${titleCase(omitted.reason)})` : "not included",
        placed ? String(placed.part) : "",
      ];
    }),
    "No progress photos on file.",
  );
  const otherMedia = input.photoFiles.length - sections.photos.filter((photo) => photoFileByPath.has(String(photo.object_path ?? ""))).length;
  if (otherMedia > 0) paragraph(doc, `${otherMedia} further stored image(s) (custom foods, recipes, chat photos) are listed in media.json.`, { italic: true });

  // ── Care-team transcript ───────────────────────────────────────────────
  heading(doc, "Care-team conversation transcript");
  const careTeam = sections.chat.filter((entry) => entry.conversation.channel === "care_team");
  if (careTeam.length === 0) paragraph(doc, "No care-team messages on file.", { italic: true });
  for (const entry of careTeam) {
    ensureRoom(doc, 30);
    doc.font(FONT_BOLD).fontSize(10.5).fillColor("#111111").text(
      printable(`${entry.conversation.businessName ?? "Care Team"} · started ${fmtDateTime(entry.conversation.createdAt)}`),
      PAGE.margin,
      doc.y,
      { width: CONTENT_WIDTH },
    );
    doc.moveDown(0.2);
    if (entry.messages.length === 0) paragraph(doc, "No messages.", { italic: true });
    for (const message of entry.messages) {
      const speaker = String(message.attribution ?? message.sender ?? "");
      const line = `${fmtDateTime(message.createdAt)}  ${speaker}`;
      const text = printable(message.text) || "(no text)";
      const height = doc.font(FONT).fontSize(9.5).heightOfString(text, { width: CONTENT_WIDTH - 12 }) + 14;
      ensureRoom(doc, height);
      doc.font(FONT_BOLD).fontSize(8.5).fillColor("#555555").text(line, PAGE.margin, doc.y, { width: CONTENT_WIDTH });
      doc.font(FONT).fontSize(9.5).fillColor("#111111").text(text, PAGE.margin + 12, doc.y, { width: CONTENT_WIDTH - 12 });
      doc.moveDown(0.35);
    }
  }
  const aiCount = sections.chat.filter((entry) => entry.conversation.channel !== "care_team").length;
  if (aiCount > 0) paragraph(doc, `${aiCount} AI coach conversation(s) are in chat.json (not printed here).`, { italic: true });

  // ── Orders ─────────────────────────────────────────────────────────────
  heading(doc, "Orders and subscriptions");
  table(
    doc,
    [
      { header: "Order", width: 0.14 },
      { header: "Date", width: 0.14 },
      { header: "Items", width: 0.36 },
      { header: "Total", width: 0.12 },
      { header: "Status", width: 0.12 },
      { header: "Fulfillment", width: 0.12 },
    ],
    sections.billing.orders.map((order) => [
      String(order.order_number ?? ""),
      fmtDate(order.created_at),
      Array.isArray(order.items)
        ? (order.items as Array<Record<string, unknown>>).map((item) => `${item.quantity ?? 1} × ${item.product_name_snapshot ?? "item"}`).join("; ")
        : "",
      money(order.total_cents),
      titleCase(String(order.status ?? "")),
      titleCase(String(order.fulfillment_status ?? "")),
    ]),
    "No orders on file.",
  );
  if (sections.billing.subscriptions.length > 0) {
    table(
      doc,
      [
        { header: "Subscription", width: 0.4 },
        { header: "Status", width: 0.2 },
        { header: "Price", width: 0.2 },
        { header: "Current period ends", width: 0.2 },
      ],
      sections.billing.subscriptions.map((sub) => [
        String(sub.product ?? ""),
        titleCase(String(sub.status ?? "")),
        money(sub.unit_price_cents),
        fmtDate(sub.current_period_end),
      ]),
    );
  }

  // ── File guide ─────────────────────────────────────────────────────────
  heading(doc, "What is in this archive");
  paragraph(
    doc,
    input.parts.length === 1
      ? "This record is one ZIP file. manifest.json lists every file in it."
      : `This record is split into ${input.parts.length} numbered ZIP parts so each stays under the size limit. Every part carries the same manifest.json, which lists every part and which one holds each file. Nothing was left out for size.`,
  );
  table(
    doc,
    [{ header: "Part", width: 0.1 }, { header: "File name", width: 0.9 }],
    input.parts.map((name, index) => [String(index + 1), name]),
  );
  table(
    doc,
    [{ header: "File", width: 0.26 }, { header: "Contents", width: 0.74 }],
    [
      ["record-summary.pdf", "This printable summary"],
      ["manifest.json", "Every part in the set and which part holds each file, plus any file that could not be included and why"],
      ...ARCHIVE_FILE_GUIDE.map(([name, description]) => [name, description]),
      ["media/", "Stored photo files (progress photos, custom foods, recipes, chat photos)"],
    ],
  );
  if (input.omitted.length > 0) {
    paragraph(doc, `${input.omitted.length} stored file(s) could not be included because their bytes are no longer available or were never committed; each is named in manifest.json under "omitted".`, { italic: true });
  }
  if (droppedCharacters) {
    paragraph(doc, "Some characters (for example emoji) could not be printed and were left out of this summary; the JSON files keep the original text.", { italic: true });
  }

  // ── Page numbers ───────────────────────────────────────────────────────
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    doc.font(FONT).fontSize(8).fillColor("#777777").text(
      printable(`${patientName(profile)} · Patient record summary · page ${index + 1} of ${range.count}`),
      PAGE.margin,
      PAGE.height - PAGE.margin + 16,
      { width: CONTENT_WIDTH, align: "center", lineBreak: false },
    );
  }
  doc.end();
  return done;
}
