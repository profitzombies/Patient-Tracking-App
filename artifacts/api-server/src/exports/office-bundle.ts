/**
 * Whole-office record bundle (HQ only).
 *
 * One `office_bundle` export row per request; the `office-bundle-export`
 * system job turns it into numbered ZIP parts under the row's export prefix:
 *
 *   patients/<patient id>/...   the SAME per-patient archive the staff
 *                               record export builds (sections, PDF summary,
 *                               photos, bloodwork files, its own manifest)
 *   office/*.csv                the office's business records, all-time
 *   office/tombstones.csv       (optional) PII-free purged-patient markers
 *   README.txt, manifest.json   top-level guide + SHA-256 for every file and
 *                               every finished part
 *
 * Patients are packed in creation order. A part closes when the next record
 * would push it past the part budget (a record larger than the budget is
 * split greedily across parts of its own, like a standalone record export).
 * The office files always form the LAST part on their own, so every file
 * hash the manifest lists is known before the manifest is written.
 *
 * Resumable by construction: the row's `parts` column and `params.bundle`
 * (cursor of the last patient whose part landed, counters, sidecar paths)
 * are patched together after every finished part. A new run — after a
 * restart, or because the previous run spent its time budget — continues
 * from that cursor. Patients in a part that never landed are simply built
 * again. Each finished part also writes a small file-list sidecar (checksums
 * per file in that part) so the final manifest never has to re-read parts.
 */
import JSZip from "jszip";
import { createHash, randomUUID } from "node:crypto";
import { PassThrough, Transform } from "node:stream";
import { logger } from "../lib/logger";
import { objectStorage } from "../lib/objectStorage";
import { supabaseAdmin } from "../lib/supabase-admin";
import { csvBuffer } from "./csv";
import { MAX_EXPORT_ROWS, type ExportSheet } from "./generators";
import type { ExportScope } from "./kinds";
import { officeBusinessSheets } from "./office-sheets";
import {
  addRecordPartEntries,
  defaultRecordReader,
  entryCostBytes,
  planPatientRecord,
  recordPartBudgetBytes,
  zipNodeStream,
  type PatientRecordPlan,
  type PlanPatientRecordOptions,
} from "./patient-record";
import { exportPartObjectPath, type ExportJobRow, type ExportPartRow } from "./worker";
import { exportTtlHours } from "../routes/exports";

const enc = encodeURIComponent;

export const OFFICE_BUNDLE_KIND = "office_bundle";
export const BUNDLE_MANIFEST_FORMAT = "thinnr-office-bundle/1";

/** Days a requested bundle has to finish building before the sweep expires it. */
export const OFFICE_BUNDLE_BUILD_DAYS = 7;

/** Progress and resume state, stored at `params.bundle` on the export row. */
export interface BundleState {
  stage: "patients" | "office" | "ready";
  patientsTotal: number;
  patientsDone: number;
  bytesWritten: number;
  fileCount: number;
  omittedFiles: number;
  /** Last patient whose part landed (creation order); null = start. */
  cursor: { createdAt: string; id: string } | null;
  /** File-list sidecars of finished parts (deleted once the bundle is ready). */
  fileLists: string[];
  tombstoneCount: number | null;
}

export interface BundlePartRow extends ExportPartRow {
  sha256: string;
}

interface BundleFileEntry {
  file: string;
  part: number;
  sizeBytes: number;
  sha256: string;
}

interface BundlePatientSummary {
  patientId: string;
  /** Chart activation state at bundle time (sealed charts ship too). */
  chartStatus: string | null;
  parts: number[];
  fileCount: number;
  omittedFiles: number;
  omitted: PatientRecordPlan["manifest"]["omitted"];
}

/** One finished part's sidecar. */
interface BundlePartSidecar {
  part: number;
  fileName: string;
  objectPath: string;
  sizeBytes: number;
  sha256: string;
  fileCount: number;
  files: BundleFileEntry[];
  patients: BundlePatientSummary[];
}

export interface OfficeBundleManifest {
  format: typeof BUNDLE_MANIFEST_FORMAT;
  generatedAt: string;
  exportId: string;
  officeId: string;
  officeName: string | null;
  includeTombstones: boolean;
  patientsTotal: number;
  patientsIncluded: number;
  tombstoneCount: number | null;
  partBudgetBytes: number;
  partCount: number;
  fileCount: number;
  /** SHA-256 of every finished part; the part holding this manifest hashes to null here. */
  parts: Array<{ part: number; fileName: string; sizeBytes: number | null; sha256: string | null; fileCount: number }>;
  files: BundleFileEntry[];
  patients: BundlePatientSummary[];
}

export interface OfficeBundleDeps {
  db: typeof supabaseAdmin;
  storage: {
    saveStream: (objectPath: string, source: NodeJS.ReadableStream, contentType: string) => Promise<{ sizeBytes: number }>;
    saveBuffer: (objectPath: string, content: Buffer, contentType: string) => Promise<void>;
    readObject: (objectPath: string) => Promise<Buffer>;
    deleteObjectStrict: (objectPath: string) => Promise<void>;
  };
  planRecord: (patientId: string, options: PlanPatientRecordOptions) => Promise<PatientRecordPlan>;
  readMedia: (objectPath: string) => Promise<Buffer>;
  officeSheets: (scope: ExportScope, today: string) => Promise<Array<{ file: string; sheet: ExportSheet }>>;
  /** How long a finished bundle stays downloadable (export-link policy). */
  ttlHours: () => Promise<number>;
  partBudgetBytes: number;
  /** In-memory ceiling for one part's fixed (non-streamed) bytes. */
  fixedBytesCap: number;
  patientsPerPart: number;
  /** Wall-clock budget per run; the job re-signals itself when work remains. */
  runBudgetMs: number;
  patientPageSize: number;
  now: () => Date;
}

export function defaultOfficeBundleDeps(overrides: Partial<OfficeBundleDeps> = {}): OfficeBundleDeps {
  const readMedia = overrides.readMedia ?? defaultRecordReader();
  return {
    db: supabaseAdmin,
    storage: {
      saveStream: (path, source, type) => objectStorage.saveStream(path, source, type),
      saveBuffer: (path, content, type) => objectStorage.saveBuffer(path, content, type),
      readObject: readMedia,
      deleteObjectStrict: (path) => objectStorage.deleteObjectStrict(path),
    },
    planRecord: planPatientRecord,
    readMedia,
    officeSheets: officeBusinessSheets,
    ttlHours: exportTtlHours,
    partBudgetBytes: recordPartBudgetBytes(),
    fixedBytesCap: 64 * 1024 * 1024,
    patientsPerPart: 50,
    runBudgetMs: envMs("OFFICE_BUNDLE_RUN_BUDGET_MS", 5 * 60_000),
    patientPageSize: 50,
    now: () => new Date(),
    ...overrides,
  };
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : fallback;
}

const JOB_SELECT =
  "id,kind,status,requested_by,requester_kind,requester_role,provider_id,params,file_name,object_path,size_bytes,row_count,error,attempts,created_at,started_at,completed_at,expires_at,download_count,last_downloaded_at,parts,cancel_requested_at";

/** Thrown when the row stopped being `running` under us (expired / pruned). */
export class BundleRowGoneError extends Error {
  constructor(jobId: string) {
    super(`office bundle ${jobId} is no longer running; stopped`);
    this.name = "BundleRowGoneError";
  }
}

/** Thrown when the requester cancelled the bundle; the row and its objects are already cleaned up. */
export class BundleCancelledError extends Error {
  constructor(jobId: string) {
    super(`office bundle ${jobId} cancelled by the requester`);
    this.name = "BundleCancelledError";
  }
}

/** How often (at most) a running bundle re-reads its row for a cancel request. */
const CANCEL_CHECK_EVERY_MS = 5_000;

export function bundleStateOf(params: Record<string, unknown> | null | undefined): BundleState | null {
  const raw = params?.bundle;
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  const cursor =
    b.cursor && typeof b.cursor === "object" && typeof (b.cursor as Record<string, unknown>).id === "string"
      ? { createdAt: String((b.cursor as Record<string, unknown>).createdAt), id: String((b.cursor as Record<string, unknown>).id) }
      : null;
  return {
    stage: b.stage === "office" || b.stage === "ready" ? b.stage : "patients",
    patientsTotal: num(b.patientsTotal),
    patientsDone: num(b.patientsDone),
    bytesWritten: num(b.bytesWritten),
    fileCount: num(b.fileCount),
    omittedFiles: num(b.omittedFiles),
    cursor,
    fileLists: Array.isArray(b.fileLists) ? b.fileLists.filter((entry): entry is string => typeof entry === "string") : [],
    tombstoneCount: typeof b.tombstoneCount === "number" ? b.tombstoneCount : null,
  };
}

export function bundlePartFileName(stem: string, part: number): string {
  return `${stem}_part-${String(part).padStart(3, "0")}.zip`;
}

function sidecarObjectPath(jobId: string, part: number): string {
  return `/objects/exports/${jobId}/bundle-files-${String(part).padStart(2, "0")}-${randomUUID()}.json`;
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Pipe a stream through a SHA-256 tap; `digest()` is valid once the source ended. */
function hashingTap(source: NodeJS.ReadableStream): { stream: PassThrough; digest: () => string } {
  const hash = createHash("sha256");
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk as Buffer);
      callback(null, chunk);
    },
  });
  const out = new PassThrough();
  source.on("error", (error: unknown) => out.destroy(error instanceof Error ? error : new Error(String(error))));
  tap.on("error", (error: unknown) => out.destroy(error instanceof Error ? error : new Error(String(error))));
  source.pipe(tap).pipe(out);
  return { stream: out, digest: () => hash.digest("hex") };
}

/** Count of an office's patients (PostgREST exact count). */
/** Exact row count from PostgREST's Content-Range; one row travels, not all. */
async function countRows(db: OfficeBundleDeps["db"], path: string): Promise<number> {
  const res = await db("GET", `${path}&limit=1`, undefined, "count=exact");
  if (res.status >= 300) throw new Error(`count failed (${res.status})`);
  const range = typeof res.contentRange === "string" ? res.contentRange : null;
  const total = range ? Number(range.split("/")[1]) : NaN;
  if (Number.isFinite(total)) return total;
  throw new Error("count failed (no Content-Range)");
}

/** Patients in one office (null: the whole network, for size estimates). */
export async function countOfficePatients(db: OfficeBundleDeps["db"], providerId: string | null): Promise<number> {
  return countRows(db, `/rest/v1/patients?${providerId ? `provider_id=eq.${enc(providerId)}&` : ""}select=id`);
}

export async function countOfficeTombstones(db: OfficeBundleDeps["db"], providerId: string): Promise<number> {
  return countRows(db, `/rest/v1/patient_tombstones?provider_id=eq.${enc(providerId)}&select=id`);
}

interface OpenPart {
  number: number;
  plans: Array<{ plan: PatientRecordPlan; patientId: string }>;
  /** Patients whose LAST part this is (committed to the cursor when it lands). */
  patients: Array<{ id: string; createdAt: string; summary: BundlePatientSummary }>;
  filled: number;
  fixedBytes: number;
}

function newPart(number: number): OpenPart {
  return { number, plans: [], patients: [], filled: 0, fixedBytes: 0 };
}

export interface BundleStepResult {
  /** True when the run stopped on its time budget with work left. */
  moreWork: boolean;
  jobId: string | null;
}

/**
 * Advance the oldest queued/running bundle: claim it if queued, build parts
 * until the time budget runs out or the office is exhausted, then finish
 * with the office part and flip the row to ready. Returns whether more work
 * remains (caller re-signals the job).
 */
export async function runOfficeBundleStep(input: {
  dryRun: boolean;
  tally: (key: string, by?: number) => void;
  log: (event: string, detail?: Record<string, unknown>) => void;
  checkpoint: () => void;
  deps?: Partial<OfficeBundleDeps>;
}): Promise<BundleStepResult> {
  const deps = defaultOfficeBundleDeps(input.deps);
  const { db } = deps;
  // Prefer a row already running (ours from an earlier run) over new requests.
  const picked = await db(
    "GET",
    `/rest/v1/data_exports?kind=eq.${OFFICE_BUNDLE_KIND}&status=in.(running,queued)&expires_at=gt.${enc(deps.now().toISOString())}&select=${JOB_SELECT}&order=status.desc,created_at.asc&limit=1`,
  );
  if (picked.status >= 300 || !Array.isArray(picked.json)) throw new Error(`office bundle scan failed (${picked.status})`);
  const row = picked.json[0] as ExportJobRow | undefined;
  if (!row) return { moreWork: false, jobId: null };
  if (!row.provider_id) throw new Error(`office bundle ${row.id} has no office`);
  input.tally("bundlesSeen");

  if (input.dryRun) {
    // Count only: how many patients the bundle still has to pack.
    const total = await countOfficePatients(db, row.provider_id);
    const state = bundleStateOf(row.params);
    input.tally("patientsRemaining", Math.max(0, total - (state?.patientsDone ?? 0)));
    return { moreWork: false, jobId: row.id };
  }

  if (row.status === "queued") {
    const claimed = await patchRow(db, row.id, { status: "running", started_at: deps.now().toISOString(), attempts: row.attempts + 1 }, "queued");
    if (!claimed) return { moreWork: true, jobId: row.id };
    row.status = "running";
    input.tally("bundlesClaimed");
  }

  const builder = new BundleBuilder(row, deps, input);
  if (row.cancel_requested_at) {
    // Staff cancelled while an earlier run held the bundle: honour it before
    // packing anything else, then look for the next request.
    await builder.cancel();
    input.tally("bundlesCancelled");
    input.log("office_bundle_cancelled", { jobId: row.id });
    return { moreWork: true, jobId: row.id };
  }
  try {
    const moreWork = await builder.run();
    // Where this bundle stands, so System health's last-run counts read as
    // progress ("bundle patients done 120 · bundle patients total 480 · …").
    const progress = builder.progress();
    input.tally("bundlePatientsDone", progress.patientsDone);
    input.tally("bundlePatientsTotal", progress.patientsTotal);
    input.tally("bundleBytesWritten", progress.bytesWritten);
    return { moreWork, jobId: row.id };
  } catch (error) {
    if (error instanceof BundleCancelledError) {
      input.tally("bundlesCancelled");
      input.log("office_bundle_cancelled", { jobId: row.id });
      return { moreWork: true, jobId: row.id };
    }
    if (error instanceof BundleRowGoneError) {
      input.log("office_bundle_row_gone", { jobId: row.id });
      return { moreWork: false, jobId: row.id };
    }
    // Objects already written stay referenced by the row (parts + sidecars)
    // until the sweep expires it, so nothing is orphaned by failing here.
    logger.error({ err: error, jobId: row.id }, "office bundle failed");
    await patchRow(db, row.id, { status: "failed", error: shortError(error), completed_at: deps.now().toISOString() }, "running").catch((patchError) =>
      logger.error({ err: patchError, jobId: row.id }, "office bundle failure not recorded"),
    );
    throw error;
  }
}

async function patchRow(db: OfficeBundleDeps["db"], jobId: string, patch: Record<string, unknown>, expectStatus: string, filter = ""): Promise<boolean> {
  const res = await db("PATCH", `/rest/v1/data_exports?id=eq.${enc(jobId)}&status=eq.${enc(expectStatus)}${filter}`, patch, "return=representation");
  if (res.status >= 300) {
    const reason = res.json && typeof res.json === "object" && typeof (res.json as { message?: unknown }).message === "string" ? `: ${(res.json as { message: string }).message}` : "";
    throw new Error(`office bundle row update failed (${res.status})${reason}`);
  }
  return Array.isArray(res.json) && res.json.length === 1;
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300) || "Bundle failed.";
}

class BundleBuilder {
  private readonly state: BundleState;
  private readonly parts: BundlePartRow[];
  private readonly stem: string;
  private readonly deadline: number;
  private readonly officeId: string;
  private readonly officeName: string | null;
  private readonly includeTombstones: boolean;
  private params: Record<string, unknown>;

  constructor(
    private readonly row: ExportJobRow,
    private readonly deps: OfficeBundleDeps,
    private readonly ctx: { tally: (key: string, by?: number) => void; log: (event: string, detail?: Record<string, unknown>) => void; checkpoint: () => void },
  ) {
    this.params = { ...(row.params ?? {}) };
    this.officeId = row.provider_id as string;
    this.officeName = typeof this.params.officeName === "string" ? this.params.officeName : null;
    this.includeTombstones = this.params.includeTombstones === true;
    this.stem = (row.file_name ?? `thinnr_office-bundle_${row.id}`).replace(/\.zip$/i, "");
    this.parts = (Array.isArray(row.parts) ? row.parts : []).map((part) => ({ ...part, sha256: typeof (part as BundlePartRow).sha256 === "string" ? (part as BundlePartRow).sha256 : "" }));
    this.state = bundleStateOf(row.params) ?? {
      stage: "patients",
      patientsTotal: 0,
      patientsDone: 0,
      bytesWritten: 0,
      fileCount: 0,
      omittedFiles: 0,
      cursor: null,
      fileLists: [],
      tombstoneCount: null,
    };
    this.deadline = deps.now().getTime() + deps.runBudgetMs;
  }

  private timeUp(): boolean {
    return this.deps.now().getTime() >= this.deadline;
  }

  /**
   * Persist parts + state. Commits land only while the row is running AND
   * nobody has asked to cancel, so a bundle never flips to ready after a
   * cancel; a row that is no longer ours ends the build.
   */
  private async commit(extra: Record<string, unknown> = {}): Promise<void> {
    this.params = { ...this.params, bundle: this.state };
    // The parts column's check (data_export_parts_valid) accepts null or a
    // non-empty list, never `[]`: before the first part lands the row keeps null.
    const parts = this.parts.length > 0 ? this.parts : null;
    const landed = await patchRow(
      this.deps.db,
      this.row.id,
      { parts, size_bytes: this.state.bytesWritten, row_count: this.state.fileCount, params: this.params, ...extra },
      "running",
      "&cancel_requested_at=is.null",
    );
    if (!landed) {
      if (await this.cancelIfRequested()) throw new BundleCancelledError(this.row.id);
      throw new BundleRowGoneError(this.row.id);
    }
  }

  private lastCancelCheck = 0;

  /** Throttled cancel poll between patients; a read failure is not a cancel. */
  private async checkCancel(): Promise<void> {
    const now = this.deps.now().getTime();
    if (now - this.lastCancelCheck < CANCEL_CHECK_EVERY_MS) return;
    this.lastCancelCheck = now;
    let cancelled = false;
    try {
      cancelled = await this.cancelIfRequested();
    } catch (error) {
      logger.warn({ err: error, jobId: this.row.id }, "office bundle cancel check failed; continuing");
    }
    if (cancelled) throw new BundleCancelledError(this.row.id);
  }

  /**
   * Re-read the row; when the requester cancelled a still-running bundle,
   * remove everything it wrote and flip it to cancelled. Returns whether the
   * bundle was cancelled.
   */
  private async cancelIfRequested(): Promise<boolean> {
    const res = await this.deps.db("GET", `/rest/v1/data_exports?id=eq.${enc(this.row.id)}&select=status,cancel_requested_at&limit=1`);
    if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`office bundle cancel check failed (${res.status})`);
    const row = res.json[0] as { status: string; cancel_requested_at: string | null } | undefined;
    if (!row || row.status !== "running" || !row.cancel_requested_at) return false;
    await this.cancel();
    return true;
  }

  /**
   * Terminal state for a cancelled bundle: a cancelled export owns no files,
   * so every part and sidecar written so far goes before the row flips. A
   * part that fails to delete stays referenced on the row (and is retried by
   * the next run's pre-check) rather than being orphaned silently.
   */
  async cancel(): Promise<void> {
    const paths = [...this.parts.map((part) => part.objectPath), ...this.state.fileLists];
    for (const path of paths) await this.deps.storage.deleteObjectStrict(path);
    this.state.fileLists = [];
    this.parts.splice(0, this.parts.length);
    await patchRow(
      this.deps.db,
      this.row.id,
      { status: "cancelled", object_path: null, parts: null, size_bytes: null, row_count: null, error: null, completed_at: this.deps.now().toISOString(), params: { ...this.params, bundle: this.state } },
      "running",
    );
  }

  progress(): { patientsDone: number; patientsTotal: number; bytesWritten: number } {
    return { patientsDone: this.state.patientsDone, patientsTotal: this.state.patientsTotal, bytesWritten: this.state.bytesWritten };
  }

  async run(): Promise<boolean> {
    if (!bundleStateOf(this.row.params)) {
      this.state.patientsTotal = await countOfficePatients(this.deps.db, this.officeId);
      if (this.includeTombstones) this.state.tombstoneCount = await countOfficeTombstones(this.deps.db, this.officeId);
      await this.commit();
    }
    if (this.state.stage === "patients") {
      const finished = await this.packPatients();
      if (!finished) return true;
      this.state.stage = "office";
      await this.commit();
    }
    if (this.state.stage === "office") {
      await this.writeOfficePart();
    }
    return false;
  }

  private async nextPatients(cursor: BundleState["cursor"]): Promise<Array<{ id: string; created_at: string }>> {
    const after = cursor
      ? `&or=(created_at.gt.${enc(cursor.createdAt)},and(created_at.eq.${enc(cursor.createdAt)},id.gt.${enc(cursor.id)}))`
      : "";
    const res = await this.deps.db(
      "GET",
      `/rest/v1/patients?provider_id=eq.${enc(this.officeId)}${after}&select=id,created_at&order=created_at.asc,id.asc&limit=${this.deps.patientPageSize}`,
    );
    if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`office bundle patient page failed (${res.status})`);
    return res.json as Array<{ id: string; created_at: string }>;
  }

  /** Pack patients in creation order; false when the time budget ran out first. */
  private async packPatients(): Promise<boolean> {
    let open = newPart(this.parts.length + 1);
    const budget = this.deps.partBudgetBytes;
    // Paging runs ahead of the committed cursor (which only moves when a
    // patient's last part lands), so an open part never re-reads its patients.
    let pageCursor = this.state.cursor;
    for (;;) {
      this.ctx.checkpoint();
      if (this.timeUp()) {
        await this.flush(open);
        return false;
      }
      const page = await this.nextPatients(pageCursor);
      if (page.length === 0) {
        await this.flush(open);
        return true;
      }
      const lastOnPage = page[page.length - 1];
      pageCursor = { createdAt: lastOnPage.created_at, id: lastOnPage.id };
      for (const patient of page) {
        this.ctx.checkpoint();
        await this.checkCancel();
        const openRef = open;
        const plan = await this.deps.planRecord(patient.id, {
          exportId: this.row.id,
          fileNameStem: this.stem,
          partBudgetBytes: budget,
          readmeTitle: `THINNR patient record (office bundle${this.officeName ? `: ${this.officeName}` : ""})`,
          placement: {
            fileNameFor: (part) => bundlePartFileName(this.stem, part),
            place: ({ fixedBytes, stored }) => {
              const total = fixedBytes + stored.reduce((sum, entry) => sum + entryCostBytes(entry.sizeBytes), 0);
              const openHasRoom = openRef.plans.length > 0 && openRef.filled + total <= budget;
              const first = openRef.plans.length === 0 ? openRef.number : openHasRoom ? openRef.number : openRef.number + 1;
              if (total <= budget) return { fixedPart: first, storedParts: stored.map(() => first) };
              // Larger than a whole part: greedy split across parts of its own.
              let part = first;
              let filled = fixedBytes;
              const storedParts = stored.map((entry) => {
                const cost = entryCostBytes(entry.sizeBytes);
                if (filled > 0 && filled + cost > budget) {
                  part += 1;
                  filled = 0;
                }
                filled += cost;
                return part;
              });
              return { fixedPart: first, storedParts };
            },
          },
        });
        const partNumbers = [...new Set<number>([plan.fixedPart, ...plan.storedFiles.map((entry) => entry.part)])].sort((a, b) => a - b);
        if (plan.fixedPart !== open.number) {
          await this.flush(open);
          open = newPart(plan.fixedPart);
        }
        const summary: BundlePatientSummary = {
          patientId: patient.id,
          chartStatus: plan.chart.activationStatus,
          parts: partNumbers,
          fileCount: plan.manifest.fileCount + partNumbers.length,
          omittedFiles: plan.manifest.omitted.length,
          omitted: plan.manifest.omitted,
        };
        for (const [index, number] of partNumbers.entries()) {
          if (number !== open.number) {
            await this.flush(open);
            open = newPart(number);
          }
          open.plans.push({ plan, patientId: patient.id });
          open.filled += plan.manifest.files.filter((entry) => entry.part === number).reduce((sum, entry) => sum + entryCostBytes(entry.sizeBytes), 0);
          if (number === plan.fixedPart) open.fixedBytes += plan.fixedEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
          if (index === partNumbers.length - 1) open.patients.push({ id: patient.id, createdAt: patient.created_at, summary });
          else {
            await this.flush(open);
            open = newPart(number + 1);
          }
        }
        if (open.plans.length >= this.deps.patientsPerPart || open.fixedBytes >= this.deps.fixedBytesCap) {
          await this.flush(open);
          open = newPart(open.number + 1);
        }
        if (this.timeUp()) break;
      }
    }
  }

  /** Stream one part to storage, write its sidecar, then commit the row. */
  private async flush(open: OpenPart): Promise<void> {
    if (open.plans.length === 0) return;
    const files: BundleFileEntry[] = [];
    const zip = new JSZip();
    let count = 0;
    for (const { plan, patientId } of open.plans) {
      count += addRecordPartEntries(zip, plan, open.number, {
        prefix: `patients/${patientId}/`,
        readMedia: this.deps.readMedia,
        onEntry: (file, bytes) => files.push({ file, part: open.number, sizeBytes: bytes.byteLength, sha256: sha256Of(bytes) }),
      });
    }
    const written = await this.writePart(open.number, zip, count);
    const sidecar: BundlePartSidecar = { ...written, files, patients: open.patients.map((entry) => entry.summary) };
    const sidecarPath = sidecarObjectPath(this.row.id, open.number);
    await this.deps.storage.saveBuffer(sidecarPath, Buffer.from(JSON.stringify(sidecar)), "application/json");

    this.parts.push({ part: written.part, fileName: written.fileName, objectPath: written.objectPath, sizeBytes: written.sizeBytes, fileCount: written.fileCount, sha256: written.sha256 });
    this.state.fileLists.push(sidecarPath);
    this.state.bytesWritten += written.sizeBytes;
    this.state.fileCount += written.fileCount;
    this.state.patientsDone += open.patients.length;
    this.state.omittedFiles += open.patients.reduce((sum, entry) => sum + entry.summary.omittedFiles, 0);
    const last = open.patients[open.patients.length - 1];
    if (last) this.state.cursor = { createdAt: last.createdAt, id: last.id };
    this.ctx.tally("partsWritten");
    this.ctx.tally("patientsPacked", open.patients.length);
    try {
      await this.commit();
    } catch (error) {
      if (error instanceof BundleRowGoneError) {
        // The row moved on (expired) before this part was recorded: don't orphan it.
        for (const path of [written.objectPath, sidecarPath]) await this.deps.storage.deleteObjectStrict(path).catch(() => undefined);
      }
      throw error;
    }
  }

  private async writePart(number: number, zip: JSZip, fileCount: number): Promise<Omit<BundlePartSidecar, "files" | "patients">> {
    const objectPath = exportPartObjectPath(this.row.id, number);
    const fileName = bundlePartFileName(this.stem, number);
    const tap = hashingTap(zipNodeStream(zip));
    const { sizeBytes } = await this.deps.storage.saveStream(objectPath, tap.stream, "application/zip");
    return { part: number, fileName, objectPath, sizeBytes, sha256: tap.digest(), fileCount };
  }

  /** Final part: office CSVs, optional tombstones, README, manifest. */
  private async writeOfficePart(): Promise<void> {
    const generatedAt = this.deps.now().toISOString();
    const today = generatedAt.slice(0, 10);
    const scope: ExportScope = {
      providerId: this.officeId,
      officeName: this.officeName,
      requesterKind: "hq",
      requesterRole: (this.row.requester_role as ExportScope["requesterRole"]) ?? null,
      range: { start: "2000-01-01", end: today },
      patient: null,
    };
    const sheets = await this.deps.officeSheets(scope, today);
    if (this.includeTombstones) sheets.push({ file: "office/tombstones.csv", sheet: await tombstoneSheet(this.deps.db, this.officeId) });

    // Fold every finished part's sidecar into the manifest.
    const sidecars: BundlePartSidecar[] = [];
    for (const path of this.state.fileLists) {
      sidecars.push(JSON.parse((await this.deps.storage.readObject(path)).toString("utf8")) as BundlePartSidecar);
    }
    sidecars.sort((a, b) => a.part - b.part);
    const number = this.parts.length + 1;
    const fixed: Array<{ file: string; body: Buffer }> = sheets.map(({ file, sheet }) => ({ file, body: csvBuffer(sheet.header, sheet.rows.slice(0, MAX_EXPORT_ROWS)) }));
    const readme = bundleReadme({ generatedAt, exportId: this.row.id, officeId: this.officeId, officeName: this.officeName, parts: number, patients: this.state.patientsDone, includeTombstones: this.includeTombstones, officeFiles: fixed.map((entry) => entry.file) });
    fixed.push({ file: "README.txt", body: Buffer.from(readme) });
    const ownFiles: BundleFileEntry[] = fixed.map((entry) => ({ file: entry.file, part: number, sizeBytes: entry.body.byteLength, sha256: sha256Of(entry.body) }));
    const manifest: OfficeBundleManifest = {
      format: BUNDLE_MANIFEST_FORMAT,
      generatedAt,
      exportId: this.row.id,
      officeId: this.officeId,
      officeName: this.officeName,
      includeTombstones: this.includeTombstones,
      patientsTotal: this.state.patientsTotal,
      patientsIncluded: this.state.patientsDone,
      tombstoneCount: this.state.tombstoneCount,
      partBudgetBytes: this.deps.partBudgetBytes,
      partCount: number,
      fileCount: sidecars.reduce((sum, sidecar) => sum + sidecar.files.length, 0) + ownFiles.length + 1,
      parts: [
        ...this.parts.map((part) => ({ part: part.part, fileName: part.fileName, sizeBytes: part.sizeBytes, sha256: part.sha256 || null, fileCount: part.fileCount })),
        { part: number, fileName: bundlePartFileName(this.stem, number), sizeBytes: null, sha256: null, fileCount: ownFiles.length + 1 },
      ],
      files: [...sidecars.flatMap((sidecar) => sidecar.files), ...ownFiles],
      patients: sidecars.flatMap((sidecar) => sidecar.patients),
    };
    const zip = new JSZip();
    for (const entry of fixed) zip.file(entry.file, entry.body);
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    const written = await this.writePart(number, zip, ownFiles.length + 1);
    this.parts.push({ part: written.part, fileName: written.fileName, objectPath: written.objectPath, sizeBytes: written.sizeBytes, fileCount: written.fileCount, sha256: written.sha256 });
    this.state.bytesWritten += written.sizeBytes;
    this.state.fileCount += written.fileCount;
    this.state.stage = "ready";
    const sidecarPaths = this.state.fileLists;
    this.state.fileLists = [];
    this.ctx.tally("partsWritten");
    const expiresAt = new Date(this.deps.now().getTime() + (await this.deps.ttlHours()) * 3_600_000).toISOString();
    try {
      await this.commit({
        status: "ready",
        object_path: this.parts[0].objectPath,
        completed_at: generatedAt,
        expires_at: expiresAt,
        error: null,
      });
    } catch (error) {
      if (error instanceof BundleRowGoneError) await this.deps.storage.deleteObjectStrict(written.objectPath).catch(() => undefined);
      throw error;
    }
    this.ctx.tally("bundlesReady");
    // Sidecars are folded into the manifest now; a failed delete is only an
    // orphan the storage reconciler removes after its grace window.
    for (const path of sidecarPaths) {
      await this.deps.storage.deleteObjectStrict(path).catch((error: unknown) => logger.warn({ err: error, objectPath: path }, "bundle sidecar not removed"));
    }
  }
}

async function tombstoneSheet(db: OfficeBundleDeps["db"], providerId: string): Promise<ExportSheet> {
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; rows.length < MAX_EXPORT_ROWS; offset += 1000) {
    const res = await db(
      "GET",
      `/rest/v1/patient_tombstones?provider_id=eq.${enc(providerId)}&select=id,requested_at,purged_at,was_activated,program_id,enrolled_on&order=purged_at.asc,id.asc&limit=1000&offset=${offset}`,
    );
    if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`tombstone query failed (${res.status})`);
    rows.push(...(res.json as Array<Record<string, unknown>>));
    if (res.json.length < 1000) break;
  }
  return {
    header: ["Former patient ID", "Deletion requested at", "Purged at", "Was activated", "Program", "Enrolled on"],
    rows: rows.map((row) => [
      String(row.id ?? ""), String(row.requested_at ?? ""), String(row.purged_at ?? ""),
      row.was_activated === true ? "yes" : "no", String(row.program_id ?? ""), String(row.enrolled_on ?? ""),
    ]),
  };
}

function bundleReadme(input: {
  generatedAt: string;
  exportId: string;
  officeId: string;
  officeName: string | null;
  parts: number;
  patients: number;
  includeTombstones: boolean;
  officeFiles: string[];
}): string {
  return [
    `THINNR office record bundle${input.officeName ? `: ${input.officeName}` : ""}`,
    `Generated: ${input.generatedAt}`,
    `Office id: ${input.officeId}`,
    `Export id: ${input.exportId}`,
    `Parts: ${input.parts}`,
    `Patient records: ${input.patients}`,
    "",
    "manifest.json (this part) lists every part and every file in the whole set with",
    "its SHA-256 checksum, plus the SHA-256 of every earlier part file. Verify a",
    "downloaded part against that checksum before relying on it.",
    "",
    "patients/<patient id>/   One folder per patient: the same record a staff",
    "                         member downloads for that patient (record-summary.pdf,",
    "                         JSON sections, photos, bloodwork files) with its own",
    "                         manifest.json naming which parts hold its files.",
    ...input.officeFiles.map((file) => `${file.padEnd(25)}${OFFICE_FILE_GUIDE[file] ?? ""}`),
    ...(input.includeTombstones ? [] : ["(Purged-patient tombstones were not requested for this bundle.)"]),
  ].join("\n");
}

const OFFICE_FILE_GUIDE: Record<string, string> = {
  "office/orders.csv": "Every order with totals, fees, and Stripe references",
  "office/payments.csv": "Money ledger: sales, refunds, disputes, fee adjustments, payouts",
  "office/refunds.csv": "Refunds issued against orders",
  "office/shipments.csv": "Shipment status, carrier, and tracking per order",
  "office/subscriptions.csv": "Recurring plans and their state",
  "office/staff-team.csv": "Office owner and team members with roles and status",
  "office/audit-events.csv": "Audited staff actions in this office",
  "office/patient-activity.csv": "Per-patient activity summary as of the bundle date",
  "office/tombstones.csv": "PII-free markers of purged patients (counts reconcile)",
};
