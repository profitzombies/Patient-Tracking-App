/**
 * Staff download of one patient's full record.
 *
 * Builds the SAME sections the patient self-export builds (privacy/exports.ts
 * owns the reads and the JSON section list) and packs them, every stored
 * photo, and every committed bloodwork source file into numbered ZIP parts:
 *
 *   * Nothing is ever dropped for size. A part is closed as soon as the next
 *     file would push it past the part budget, and a new one starts; a file
 *     larger than the whole budget gets a part to itself. The only files
 *     missing from the archive are ones whose bytes do not exist any more
 *     (or were never committed), and those are listed by name and reason in
 *     the manifest, media.json, and bloodwork.json.
 *   * Part 1 opens with `record-summary.pdf` (a printable summary rendered
 *     from the same section data), `manifest.json`, `README.txt`, and every
 *     JSON section; stored files follow in archive order across the parts.
 *     Every part carries the same manifest so a single part still explains
 *     the whole set.
 *   * Memory stays flat regardless of record size: stored files are added to
 *     the ZIP as lazy streams that fetch their bytes only when the writer
 *     reaches them, and each finished part streams straight to storage.
 *
 * Sizes are known before anything is written (one metadata read per stored
 * object), so the manifest — including which part each file lives in — is
 * final before part 1 is generated.
 */
import JSZip from "jszip";
import { PassThrough, Readable } from "node:stream";
import { logger } from "../lib/logger";
import { objectStorage } from "../lib/objectStorage";
import { supabaseAdmin } from "../lib/supabase-admin";
import {
  ARCHIVE_FILE_GUIDE,
  archiveJsonSections,
  archiveMediaPlan,
  loadPatientArchiveSections,
  type PatientArchiveSections,
} from "../privacy/exports";
import { renderRecordSummaryPdf } from "./record-pdf";

/** Default per-part budget: keep every part comfortably under 1 GB. */
export const DEFAULT_RECORD_PART_BUDGET_BYTES = 900 * 1024 * 1024;
/** Rough ZIP bookkeeping per entry (local header + central directory). */
const ENTRY_OVERHEAD_BYTES = 256;

/** Env override for smaller-memory deployments (blank/invalid = default). */
export function recordPartBudgetBytes(): number {
  const raw = process.env.RECORD_EXPORT_PART_BUDGET_BYTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RECORD_PART_BUDGET_BYTES;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1024 * 1024 ? Math.floor(value) : DEFAULT_RECORD_PART_BUDGET_BYTES;
}

/** Chart-level facts the staff summary needs that the patient sections omit. */
export interface PatientChartContext {
  patientId: string;
  officeName: string | null;
  providerId: string | null;
  activationStatus: string | null;
  activationReason: string | null;
  activationUpdatedAt: string | null;
  programId: string | null;
  deletionRequestedAt: string | null;
}

export async function loadPatientChartContext(patientId: string): Promise<PatientChartContext> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${encodeURIComponent(patientId)}&select=id,provider_id,activation_status,activation_reason,activation_updated_at,program_id,deletion_requested_at&limit=1`,
  );
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`patient chart read failed (${res.status})`);
  const row = (res.json[0] ?? null) as Record<string, unknown> | null;
  if (!row) throw new Error("That patient record no longer exists.");
  const providerId = typeof row.provider_id === "string" ? row.provider_id : null;
  let officeName: string | null = null;
  if (providerId) {
    const office = await supabaseAdmin(
      "GET",
      `/rest/v1/providers?provider_id=eq.${encodeURIComponent(providerId)}&select=office_name&limit=1`,
    );
    const name = Array.isArray(office.json) ? (office.json[0] as Record<string, unknown> | undefined)?.office_name : null;
    officeName = typeof name === "string" && name.trim() ? name.trim() : null;
  }
  const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  return {
    patientId,
    officeName,
    providerId,
    activationStatus: str(row.activation_status),
    activationReason: str(row.activation_reason),
    activationUpdatedAt: str(row.activation_updated_at),
    programId: str(row.program_id),
    deletionRequestedAt: str(row.deletion_requested_at),
  };
}

export type OmittedReason = "not_committed" | "source_unavailable";

export interface RecordManifestFile {
  file: string;
  part: number;
  sizeBytes: number;
  source: "summary" | "manifest" | "readme" | "section" | "media" | "bloodwork";
  objectPath: string | null;
}

export interface RecordManifestOmission {
  file: string;
  objectPath: string | null;
  source: "media" | "bloodwork";
  reason: OmittedReason;
}

export interface RecordManifestPart {
  part: number;
  fileName: string;
  files: string[];
  /** Planned input bytes (what the budget counts), not the compressed size. */
  plannedBytes: number;
  /** True when one stored file alone exceeds the part budget. */
  oversized: boolean;
}

export interface RecordManifest {
  format: "thinnr-patient-record/1";
  generatedAt: string;
  patientId: string;
  exportId: string | null;
  partBudgetBytes: number;
  partCount: number;
  fileCount: number;
  parts: RecordManifestPart[];
  files: RecordManifestFile[];
  omitted: RecordManifestOmission[];
}

export interface WrittenRecordPart {
  part: number;
  fileName: string;
  sizeBytes: number;
  fileCount: number;
}

export interface BuildPatientRecordOptions {
  sections?: PatientArchiveSections;
  chart?: PatientChartContext;
  /** Bytes of one stored object (tests: synthetic buffers). */
  readMedia?: (objectPath: string) => Promise<Buffer>;
  /** Size of one stored object without downloading it. */
  statMedia?: (objectPath: string) => Promise<number>;
  /** Persist one finished part; resolves with the bytes written. */
  writePart: (part: { part: number; fileName: string }, stream: NodeJS.ReadableStream) => Promise<{ sizeBytes: number }>;
  partBudgetBytes?: number;
  generatedAt?: Date;
  exportId?: string | null;
  /** File name stem shared by every part (without extension). */
  fileNameStem: string;
  /** Called after each part lands (progress reporting). */
  onPartWritten?: (done: number, total: number) => Promise<void> | void;
}

export interface BuildPatientRecordResult {
  manifest: RecordManifest;
  parts: WrittenRecordPart[];
  sections: PatientArchiveSections;
  chart: PatientChartContext;
}

interface PlannedEntry {
  file: string;
  sizeBytes: number;
  source: RecordManifestFile["source"];
  objectPath: string | null;
  body: Buffer | string | null;
}

/** A Readable that fetches its bytes only once the ZIP writer pulls on it. */
class LazyObjectStream extends Readable {
  private started = false;
  constructor(private readonly load: () => Promise<Buffer>) {
    super();
  }
  override _read(): void {
    if (this.started) return;
    this.started = true;
    this.load().then(
      (content) => {
        this.push(content);
        this.push(null);
      },
      (error: unknown) => this.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  }
}

export function recordPartFileName(stem: string, part: number, total: number): string {
  const width = Math.max(2, String(total).length);
  return `${stem}_part-${String(part).padStart(width, "0")}-of-${String(total).padStart(width, "0")}.zip`;
}

export async function buildPatientRecordArchive(
  patientId: string,
  options: BuildPatientRecordOptions,
): Promise<BuildPatientRecordResult> {
  const sections = options.sections ?? (await loadPatientArchiveSections(patientId));
  const chart = options.chart ?? (await loadPatientChartContext(patientId));
  const readMedia =
    options.readMedia ??
    (async (objectPath: string) => {
      const file = await objectStorage.entityFile(objectPath);
      const [content] = await file.download();
      return content;
    });
  const statMedia = options.statMedia ?? ((objectPath: string) => objectStorage.objectSize(objectPath));
  const budget = options.partBudgetBytes ?? recordPartBudgetBytes();
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const exportId = options.exportId ?? null;

  // ── Plan: know every file and its size before writing anything ──────────
  const omitted: RecordManifestOmission[] = [];
  const stored: Array<PlannedEntry & { objectPath: string }> = [];
  const mediaPlan = archiveMediaPlan(sections);
  for (const item of mediaPlan) {
    if (!item.objectPath) {
      omitted.push({ file: item.archiveFile, objectPath: null, source: item.source, reason: "not_committed" });
      continue;
    }
    try {
      const sizeBytes = await statMedia(item.objectPath);
      stored.push({ file: item.archiveFile, sizeBytes, source: item.source, objectPath: item.objectPath, body: null });
    } catch (error) {
      logger.warn({ err: error, objectPath: item.objectPath, patientId }, "patient record export source unavailable");
      omitted.push({ file: item.archiveFile, objectPath: item.objectPath, source: item.source, reason: "source_unavailable" });
    }
  }

  // Greedy fill in archive order; the fixed files always open part 1.
  const assign = (entries: Array<{ sizeBytes: number }>, used: number): { part: number; oversized: boolean }[] => {
    const out: { part: number; oversized: boolean }[] = [];
    let part = 1;
    let filled = used;
    for (const entry of entries) {
      const cost = entry.sizeBytes + ENTRY_OVERHEAD_BYTES;
      if (filled > 0 && filled + cost > budget) {
        part += 1;
        filled = 0;
      }
      out.push({ part, oversized: cost > budget });
      filled += cost;
    }
    return out;
  };

  const jsonSections = archiveJsonSections(sections);
  // media.json / bloodwork.json / the PDF describe the final placement, so
  // stored files are laid out against an estimate of part 1's fixed files
  // (JSON sections plus slack for the summary and manifest). The estimate
  // only ever shifts part 1 by a few megabytes either way — the budget sits
  // well below the 1 GB ceiling on purpose.
  const fixedEstimate = jsonSections.reduce((sum, section) => sum + Buffer.byteLength(section.body) + ENTRY_OVERHEAD_BYTES, 0);
  const placement = assign(stored, fixedEstimate + 512 * 1024);
  const storedFiles: RecordManifestFile[] = stored.map((entry, index) => ({
    file: entry.file,
    part: placement[index].part,
    sizeBytes: entry.sizeBytes,
    source: entry.source,
    objectPath: entry.objectPath,
  }));

  const mediaJson = JSON.stringify(
    {
      ledger: sections.media,
      files: mediaPlan
        .filter((item) => item.source === "media")
        .map((item) => {
          const placed = storedFiles.find((entry) => entry.file === item.archiveFile);
          return { objectPath: item.objectPath, file: placed ? item.archiveFile : null, part: placed?.part ?? null };
        }),
      skipped: omitted.filter((entry) => entry.source === "media").map((entry) => entry.objectPath ?? entry.file),
      omitted: omitted.filter((entry) => entry.source === "media"),
    },
    null,
    2,
  );
  const bloodworkJson = JSON.stringify(
    {
      reports: sections.bloodwork.reports,
      files: mediaPlan
        .filter((item) => item.source === "bloodwork")
        .map((item) => {
          const placed = storedFiles.find((entry) => entry.file === item.archiveFile);
          const omission = omitted.find((entry) => entry.file === item.archiveFile);
          return {
            ...(item.bloodwork?.metadata ?? {}),
            archiveFile: placed ? item.archiveFile : null,
            part: placed?.part ?? null,
            omittedFileName: placed ? null : item.archiveFile,
            omittedReason: omission?.reason ?? null,
          };
        }),
      results: sections.bloodwork.results,
      corrections: sections.bloodwork.corrections,
      incompleteTranscriptionPages: sections.bloodwork.incompleteTranscriptionPages,
    },
    null,
    2,
  );

  const totalParts = Math.max(1, ...storedFiles.map((entry) => entry.part));
  const fileNameFor = (part: number) => recordPartFileName(options.fileNameStem, part, totalParts);

  const pdf = await renderRecordSummaryPdf({
    sections,
    chart,
    generatedAt,
    exportId,
    parts: Array.from({ length: totalParts }, (_, index) => fileNameFor(index + 1)),
    photoFiles: storedFiles.filter((entry) => entry.source === "media"),
    omitted,
  });

  const fixedEntries: PlannedEntry[] = [
    { file: "record-summary.pdf", sizeBytes: pdf.byteLength, source: "summary", objectPath: null, body: pdf },
    ...jsonSections.map((section) => ({ file: section.name, sizeBytes: Buffer.byteLength(section.body), source: "section" as const, objectPath: null, body: section.body })),
    { file: "media.json", sizeBytes: Buffer.byteLength(mediaJson), source: "section", objectPath: null, body: mediaJson },
    { file: "bloodwork.json", sizeBytes: Buffer.byteLength(bloodworkJson), source: "section", objectPath: null, body: bloodworkJson },
  ];

  const readme = [
    "THINNR patient record (staff copy)",
    `Generated: ${generatedAt}`,
    `Patient id: ${patientId}`,
    exportId ? `Export id: ${exportId}` : null,
    `Parts: ${totalParts}`,
    "",
    "Start with record-summary.pdf (a printable summary). manifest.json lists every",
    "part and every file in the set; every part carries the same manifest.",
    "",
    "record-summary.pdf  Printable summary: identity, enrollment, latest measurements,",
    "                    medications with dose history, bloodwork results, photo list,",
    "                    care-team transcript, orders, and a guide to these files",
    "manifest.json       Every part in this set and which part holds each file",
    ...ARCHIVE_FILE_GUIDE.map(([name, description]) => `${name.padEnd(20)}${description}`),
    "media/              Stored photo files (progress, custom foods, recipes, chat)",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const fileEntries: RecordManifestFile[] = [
    ...fixedEntries.map((entry) => ({ file: entry.file, part: 1, sizeBytes: entry.sizeBytes, source: entry.source, objectPath: null })),
    { file: "README.txt", part: 1, sizeBytes: Buffer.byteLength(readme), source: "readme", objectPath: null },
    ...storedFiles,
  ];
  const manifestParts: RecordManifestPart[] = Array.from({ length: totalParts }, (_, index) => {
    const part = index + 1;
    const files = fileEntries.filter((entry) => entry.part === part).map((entry) => entry.file);
    files.unshift("manifest.json");
    return {
      part,
      fileName: fileNameFor(part),
      files,
      plannedBytes: fileEntries.filter((entry) => entry.part === part).reduce((sum, entry) => sum + entry.sizeBytes, 0),
      oversized: storedFiles.some((entry, storedIndex) => entry.part === part && placement[storedIndex].oversized),
    };
  });
  const manifest: RecordManifest = {
    format: "thinnr-patient-record/1",
    generatedAt,
    patientId,
    exportId,
    partBudgetBytes: budget,
    partCount: totalParts,
    fileCount: fileEntries.length,
    parts: manifestParts,
    files: fileEntries,
    omitted,
  };
  const manifestJson = JSON.stringify(manifest, null, 2);

  // ── Write: one part at a time, each streamed straight to its sink ───────
  const written: WrittenRecordPart[] = [];
  for (let part = 1; part <= totalParts; part += 1) {
    const zip = new JSZip();
    zip.file("manifest.json", manifestJson);
    if (part === 1) {
      for (const entry of fixedEntries) zip.file(entry.file, entry.body ?? "");
      zip.file("README.txt", readme);
    }
    let count = part === 1 ? fixedEntries.length + 2 : 1;
    for (const entry of storedFiles) {
      if (entry.part !== part) continue;
      const objectPath = entry.objectPath as string;
      // Stored files are already compressed formats; STORE keeps part size
      // predictable and avoids a second pass over every byte.
      zip.file(entry.file, new LazyObjectStream(() => readMedia(objectPath)), { compression: "STORE" });
      count += 1;
    }
    // JSZip's output stream is a legacy readable-stream; hand consumers a
    // real Node stream so pipeline()/async iteration work and a failed
    // object read surfaces as a stream error instead of an uncaught event.
    const stream = new PassThrough();
    const zipStream = zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE" });
    zipStream.on("error", (error: unknown) => stream.destroy(error instanceof Error ? error : new Error(String(error))));
    zipStream.pipe(stream);
    const fileName = fileNameFor(part);
    const { sizeBytes } = await options.writePart({ part, fileName }, stream);
    written.push({ part, fileName, sizeBytes, fileCount: count });
    await options.onPartWritten?.(part, totalParts);
  }
  return { manifest, parts: written, sections, chart };
}
