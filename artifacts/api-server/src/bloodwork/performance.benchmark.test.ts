/**
 * Manual synthetic end-to-end worker benchmark.
 *
 * This is skipped in normal test runs. It intentionally uses the real
 * runBloodworkExtraction implementation, the real document subprocess, the
 * existing scheduler and memory JobStore, and the existing OpenAI connection.
 * Only the repository/object-storage/RPC boundary is fixture-local.
 *
 * Run manually:
 *   BLOODWORK_PERFORMANCE=1 pnpm --filter @workspace/api-server exec vitest run \
 *     src/bloodwork/performance.benchmark.test.ts --reporter=dot
 *
 * Evidence contains no model replies, report IDs, patient IDs, or document
 * text. It reports fixture transport labels so local timings are not mistaken
 * for live HTTP/storage/DB timings.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  syntheticBenchmarkReports,
  syntheticBenchmarkReport,
  type SyntheticBenchmarkPage,
  type SyntheticBenchmarkReport,
  type SyntheticExpectedBloodworkRow,
} from "./fixtures/synthetic";

type ExtractedRow = SyntheticExpectedBloodworkRow & {
  sourceFileId?: string;
  sourcePage?: number;
};
type Usage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};
type PerfMetrics = {
  renderMs: number;
  inspectMs: number;
};
type AdapterState = {
  report: SyntheticBenchmarkReport;
  reportId: string;
  fileId: string;
  objectPath: string;
  contentSha256: string;
  committedAt: number;
  firstLeaseAt: number | null;
  completed: boolean;
  failed: string | null;
  leased: boolean;
  saved: Map<number, ExtractedRow[]>;
  dbMs: number;
  pageCheckpointDbMs: number;
  aggregationDbMs: number;
  otherDbMs: number;
  dbCalls: number;
  storageReadMs: number;
  storageReads: number;
  metrics: PerfMetrics;
  aiMs: number;
  aiCalls: number;
  modelRequestAttempts: number;
  usage: Usage;
  caseStartedAt?: string;
};
type WorkerRun = {
  startedAt: string;
  finishedAt: string | null;
  counts: Record<string, number>;
};
type MemoryStore = {
  runs: WorkerRun[];
  states: Map<string, unknown>;
};
type SchedulerModule = {
  registerJob(definition: Record<string, unknown>): void;
  resetJobRegistry(): void;
  runDueJobs(options: {
    trigger: "schedule" | "internal";
    store: unknown;
    now?: Date;
  }): Promise<unknown[]>;
  startJobScheduler(options: { tickMs?: number; store?: unknown }): void;
  stopJobScheduler(): void;
};
type StoreModule = {
  createMemoryJobStore(): MemoryStore;
};
type WorkerModule = {
  bloodworkExtractionJob: Record<string, unknown> & { run: (ctx: unknown) => Promise<void> };
};
type PerformanceCheckpoint = {
  schemaVersion: 1;
  baselineCommit: string;
  sourceHashes: Record<string, string>;
  reports: Record<string, Record<string, unknown>>;
  original60s?: Record<string, unknown>;
};
type DocumentsModule = {
  inspectBloodworkFile(
    bytes: Uint8Array,
    mime: string,
    signal?: AbortSignal,
  ): Promise<{ pageCount: number }>;
};

const mocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(),
  readObjectBounded: vi.fn(),
  aiEvents: [] as Array<{ phase: string; usage?: Usage }>,
  replayAi: false,
  recordedRowsByPage: new Map<number, SyntheticExpectedBloodworkRow[]>(),
  recordedUsageByPage: new Map<number, Usage>(),
}));

vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.supabaseAdmin }));
vi.mock("../lib/objectStorage", () => ({
  objectStorage: { readObjectBounded: mocks.readObjectBounded },
}));
vi.mock("./extraction", async () => {
  const actual = await vi.importActual<typeof import("./extraction")>("./extraction");
  return {
    ...actual,
    transcribeBloodworkPage: vi.fn(async (
      input: Parameters<typeof actual.transcribeBloodworkPage>[0],
      signal?: AbortSignal,
      observer?: Parameters<typeof actual.transcribeBloodworkPage>[2],
    ) => {
      if (mocks.replayAi) {
        const rows = mocks.recordedRowsByPage.get(input.sourcePage);
        if (rows) {
          const usage = mocks.recordedUsageByPage.get(input.sourcePage);
          observer?.({
            phase: "response",
            model: actual.BLOODWORK_TRANSCRIPTION_MODEL,
            attempt: 1,
            elapsedMs: 0,
            usage: usage ? { ...usage, costUsd: null } : undefined,
          });
          return rows.map((row) => ({
            ...row,
            sourceFileId: input.sourceFileId,
            sourcePage: input.sourcePage,
          }));
        }
      }
      const started = performance.now();
      const responseEvents: Array<{ usage?: Usage }> = [];
      try {
        const results = await actual.transcribeBloodworkPage(input, signal, (event) => {
        if (event.phase === "response") {
          responseEvents.push({ usage: event.usage ? {
            promptTokens: event.usage.promptTokens,
            completionTokens: event.usage.completionTokens,
            totalTokens: event.usage.totalTokens,
          } : undefined });
        }
        mocks.aiEvents.push(event);
        observer?.(event);
        });
        // Page-number replay is only used for the explicit old 60s poll. It is
        // never used in the live-AI before/after results.
        mocks.recordedRowsByPage.set(
          input.sourcePage,
          results.map(({ sourceFileId: _file, sourcePage: _page, ...row }) => row),
        );
        const usage = responseEvents.find((event) => event.usage)?.usage;
        if (usage) mocks.recordedUsageByPage.set(input.sourcePage, usage);
        return results;
      } finally {
        const metrics = (globalThis as Record<string, unknown>).__bloodworkPerfCurrentState as AdapterState | undefined;
        if (metrics) metrics.aiMs += performance.now() - started;
      }
    }),
  };
});

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const HEAD = "c2a1caa3b16191d1aba39430f26660566d598a98";
const tempPaths: string[] = [];

function sourceAtHead(path: string): string {
  return execFileSync("git", ["show", `${HEAD}:${path}`], { encoding: "utf8" });
}

async function benchmarkSourceHashes(): Promise<Record<string, string>> {
  const files = [
    "src/jobs/definitions/bloodwork-extraction.ts",
    "src/bloodwork/documents.ts",
    "src/bloodwork/document-worker-core.ts",
    "src/bloodwork/document-worker.ts",
    "src/jobs/scheduler.ts",
    "src/bloodwork/extraction.ts",
    "src/bloodwork/fixtures/synthetic.ts",
    "src/bloodwork/performance.benchmark.test.ts",
  ];
  const hashes: Record<string, string> = {};
  for (const relative of files) {
    const bytes = await readFile(join(ROOT, relative));
    hashes[relative] = digest(bytes);
  }
  return hashes;
}

function now(): number {
  return performance.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readCheckpoint(path: string, sourceHashes: Record<string, string>): Promise<PerformanceCheckpoint> {
  const empty = (): PerformanceCheckpoint => ({
    schemaVersion: 1,
    baselineCommit: HEAD,
    sourceHashes,
    reports: {},
  });
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PerformanceCheckpoint>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.baselineCommit !== HEAD ||
      JSON.stringify(parsed.sourceHashes) !== JSON.stringify(sourceHashes) ||
      !parsed.reports
    ) {
      return empty();
    }
    return {
      schemaVersion: 1,
      baselineCommit: HEAD,
      sourceHashes,
      reports: parsed.reports,
      ...(parsed.original60s ? { original60s: parsed.original60s } : {}),
    };
  } catch {
    return empty();
  }
}

async function writeCheckpoint(path: string, checkpoint: PerformanceCheckpoint): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  // A rename makes an interrupted test leave either the previous complete
  // checkpoint or this complete case, never a half-written JSON document.
  await rename(temporary, path);
}

function rowKey(row: SyntheticExpectedBloodworkRow): string {
  return [
    row.testName,
    row.valueText,
    row.units,
    row.referenceRange,
    row.labFlag,
    row.uncertain,
  ].join("\u001f");
}

function sameRows(expected: SyntheticExpectedBloodworkRow[], actual: ExtractedRow[]): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((row, index) => rowKey(row) === rowKey(actual[index]!));
}

async function materializeOldModules(): Promise<{
  job: WorkerModule;
  scheduler: SchedulerModule;
  store: StoreModule;
  documents: DocumentsModule;
  cleanup: () => Promise<void>;
}> {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const oldDocumentImpl = `.bloodwork-perf-old-documents-${suffix}.impl.ts`;
  const oldDocumentShim = `.bloodwork-perf-old-documents-${suffix}.ts`;
  const oldDocumentWorker = `.bloodwork-perf-old-document-worker-${suffix}.ts`;
  const oldDocumentCore = `.bloodwork-perf-old-document-worker-core-${suffix}.ts`;
  const oldJob = `.bloodwork-perf-old-extraction-${suffix}.ts`;
  const oldScheduler = `.bloodwork-perf-old-scheduler-${suffix}.ts`;
  const oldStore = `.bloodwork-perf-old-store-${suffix}.ts`;
  const oldTypes = `.bloodwork-perf-old-types-${suffix}.ts`;
  const documentDir = join(ROOT, "src/bloodwork");
  const definitionsDir = join(ROOT, "src/jobs/definitions");
  const jobsDir = join(ROOT, "src/jobs");
  const paths = [
    join(documentDir, oldDocumentImpl),
    join(documentDir, oldDocumentShim),
    join(documentDir, oldDocumentWorker),
    join(documentDir, oldDocumentCore),
    join(definitionsDir, oldJob),
    join(jobsDir, oldScheduler),
    join(jobsDir, oldStore),
    join(jobsDir, oldTypes),
  ];
  tempPaths.push(...paths);
  const docs = sourceAtHead("artifacts/api-server/src/bloodwork/documents.ts")
    .replaceAll("./document-worker.ts", `./${oldDocumentWorker}`);
  const worker = sourceAtHead("artifacts/api-server/src/bloodwork/document-worker.ts")
    .replaceAll("./document-worker-core.ts", `./${oldDocumentCore}`);
  const core = sourceAtHead("artifacts/api-server/src/bloodwork/document-worker-core.ts");
  const shim = `
import * as implementation from "./${oldDocumentImpl}";
export const BLOODWORK_MAX_FILE_BYTES = implementation.BLOODWORK_MAX_FILE_BYTES;
export const inspectBloodworkFile = async (...args: any[]) => {
  const started = performance.now();
  try { return await (implementation.inspectBloodworkFile as any)(...args); }
  finally {
    const metrics = (globalThis as any).__bloodworkPerfMetrics;
    if (metrics) metrics.inspectMs += performance.now() - started;
  }
};
export const renderBloodworkPage = async (...args: any[]) => {
  const started = performance.now();
  try { return await (implementation.renderBloodworkPage as any)(...args); }
  finally {
    const metrics = (globalThis as any).__bloodworkPerfMetrics;
    if (metrics) metrics.renderMs += performance.now() - started;
  }
};
`;
  const job = sourceAtHead("artifacts/api-server/src/jobs/definitions/bloodwork-extraction.ts")
    .replaceAll("../../bloodwork/documents", `../../bloodwork/${oldDocumentShim.replace(/\.ts$/, "")}`);
  const scheduler = sourceAtHead("artifacts/api-server/src/jobs/scheduler.ts")
    .replaceAll("./store", `./${oldStore.replace(/\.ts$/, "")}`)
    .replaceAll("./types", `./${oldTypes.replace(/\.ts$/, "")}`);
  const store = sourceAtHead("artifacts/api-server/src/jobs/store.ts")
    .replaceAll("./types", `./${oldTypes.replace(/\.ts$/, "")}`);
  const types = sourceAtHead("artifacts/api-server/src/jobs/types.ts");
  await Promise.all([
    writeFile(paths[0]!, docs),
    writeFile(paths[1]!, shim),
    writeFile(paths[2]!, worker),
    writeFile(paths[3]!, core),
    writeFile(paths[4]!, job),
    writeFile(paths[5]!, scheduler),
    writeFile(paths[6]!, store),
    writeFile(paths[7]!, types),
  ]);
  const importedJob = (await import(pathToFileURL(paths[4]!).href)) as WorkerModule;
  const importedScheduler = (await import(pathToFileURL(paths[5]!).href)) as SchedulerModule;
  const importedStore = (await import(pathToFileURL(paths[6]!).href)) as StoreModule;
  const importedDocuments = (await import(pathToFileURL(paths[1]!).href)) as DocumentsModule;
  return {
    job: importedJob,
    scheduler: importedScheduler,
    store: importedStore,
    documents: importedDocuments,
    cleanup: async () => {
      await Promise.all(paths.map((path) => rm(path, { force: true })));
    },
  };
}

async function currentModules(): Promise<{
  job: WorkerModule;
  scheduler: SchedulerModule;
  store: StoreModule;
  documents: DocumentsModule;
}> {
  return {
    job: (await import("../jobs/definitions/bloodwork-extraction")) as unknown as WorkerModule,
    scheduler: (await import("../jobs/scheduler")) as unknown as SchedulerModule,
    store: (await import("../jobs/store")) as unknown as StoreModule,
    documents: (await import("./documents")) as unknown as DocumentsModule,
  };
}

async function fixtureState(
  report: SyntheticBenchmarkReport,
  directory: string,
  phase: "before" | "after" | "original-60s",
): Promise<AdapterState> {
  const page = report.pages[0]!;
  const bytes = page.bytes;
  const objectPath = join(directory, `${phase}-${report.id}.pdf`);
  const state: AdapterState = {
    report,
    reportId: `synthetic-${phase}-${report.id}`,
    fileId: `synthetic-file-${phase}-${report.id}`,
    objectPath,
    contentSha256: digest(bytes),
    committedAt: 0,
    firstLeaseAt: null,
    completed: false,
    failed: null,
    leased: false,
    saved: new Map(),
    dbMs: 0,
    pageCheckpointDbMs: 0,
    aggregationDbMs: 0,
    otherDbMs: 0,
    dbCalls: 0,
    storageReadMs: 0,
    storageReads: 0,
    metrics: { renderMs: 0, inspectMs: 0 },
    aiMs: 0,
    aiCalls: 0,
    modelRequestAttempts: 0,
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
  };
  await writeFile(objectPath, bytes, { mode: 0o600 });
  return state;
}

function installAdapters(state: AdapterState): void {
  mocks.supabaseAdmin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
    const started = now();
    state.dbCalls += 1;
    const isPageCheckpoint = path.endsWith("bloodwork_save_extraction_page");
    const isAggregationWrite = path.endsWith("bloodwork_prepare_extraction") ||
      path.endsWith("bloodwork_complete_extraction_from_pages");
    try {
      if (method === "GET" && path.includes("patient_bloodwork_files")) {
        return {
          status: 200,
          json: [{
            id: state.fileId,
            object_path: state.objectPath,
            mime_type: "application/pdf",
            page_count: state.report.pageCount,
            position: 0,
            content_sha256: state.contentSha256,
          }],
        };
      }
      if (method === "GET" && path.includes("patient_bloodwork_extraction_pages")) {
        return {
          status: 200,
          json: [...state.saved.keys()].sort((a, b) => a - b).map((sourcePage) => ({
            source_file_id: state.fileId,
            source_page: sourcePage,
          })),
        };
      }
      if (method === "POST" && path.endsWith("bloodwork_lease_extraction")) {
        if (state.completed || state.failed || state.leased || state.saved.size >= state.report.pageCount) {
          return { status: 200, json: [] };
        }
        state.leased = true;
        state.firstLeaseAt ??= Date.now();
        return {
          status: 200,
          json: [{
            id: state.reportId,
            patient_id: "synthetic-patient",
            extraction_lease_token: `token-${state.reportId}`,
            committed_at: new Date(state.committedAt).toISOString(),
            extraction_started_at: new Date().toISOString(),
          }],
        };
      }
      if (method === "POST" && path.endsWith("bloodwork_renew_extraction")) return { status: 200, json: true };
      if (method === "POST" && path.endsWith("bloodwork_save_extraction_page")) {
        const page = Number(body?.p_source_page);
        const rows = Array.isArray(body?.p_results) ? body.p_results as ExtractedRow[] : [];
        state.saved.set(page, rows);
        return { status: 200, json: true };
      }
      if (method === "POST" && path.endsWith("bloodwork_prepare_extraction")) return { status: 200, json: true };
      if (method === "POST" && path.endsWith("bloodwork_complete_extraction_from_pages")) {
        state.completed = true;
        state.leased = false;
        return { status: 200, json: true };
      }
      if (method === "POST" && path.endsWith("bloodwork_release_extraction")) {
        state.leased = false;
        return { status: 200, json: true };
      }
      if (method === "POST" && path.endsWith("bloodwork_fail_extraction")) {
        state.failed = String(body?.p_error ?? "EXTRACTION_FAILED");
        state.leased = false;
        return { status: 200, json: true };
      }
      throw new Error(`unexpected synthetic RPC ${method} ${path}`);
    } finally {
      const elapsed = now() - started;
      state.dbMs += elapsed;
      if (isPageCheckpoint) state.pageCheckpointDbMs += elapsed;
      else if (isAggregationWrite) state.aggregationDbMs += elapsed;
      else state.otherDbMs += elapsed;
    }
  });
  mocks.readObjectBounded.mockImplementation(async () => {
    const started = now();
    state.storageReads += 1;
    try {
      return { bytes: await readFile(state.objectPath) };
    } finally {
      state.storageReadMs += now() - started;
    }
  });
}

async function inspectAndCommit(
  state: AdapterState,
  documents: DocumentsModule,
): Promise<{ uploadMs: number; inspectMs: number; commitMs: number }> {
  const bytes = await readFile(state.objectPath);
  const uploadStarted = now();
  // The file was written by fixtureState before this timed boundary; retain a
  // second immutable copy to represent the upload adapter write.
  await writeFile(state.objectPath, bytes, { mode: 0o600 });
  const uploadMs = now() - uploadStarted;
  const inspectStarted = now();
  const inspected = await documents.inspectBloodworkFile(bytes, "application/pdf");
  const inspectMs = now() - inspectStarted;
  if (inspected.pageCount !== state.report.pageCount) throw new Error("synthetic inspection page count mismatch");
  const commitStarted = now();
  state.committedAt = Date.now();
  const commitMs = now() - commitStarted;
  return { uploadMs, inspectMs, commitMs };
}

async function runSchedulerUntilDone(
  state: AdapterState,
  worker: WorkerModule,
  scheduler: SchedulerModule,
  storeModule: StoreModule,
  intervalMs: number,
): Promise<{ store: MemoryStore; queueWaitMs: number; wallMs: number; failure?: string }> {
  const store = storeModule.createMemoryJobStore();
  scheduler.resetJobRegistry();
  scheduler.registerJob({ ...worker.bloodworkExtractionJob, intervalMs });
  const started = now();
  const deadline = started + 7 * 60_000;
  while (!state.completed && !state.failed && now() < deadline) {
    await sleep(intervalMs);
    await scheduler.runDueJobs({ trigger: "schedule", store, now: new Date() });
  }
  scheduler.stopJobScheduler();
  if (!state.completed && !state.failed) {
    return {
      store,
      queueWaitMs: state.firstLeaseAt === null ? 0 : state.firstLeaseAt - state.committedAt,
      wallMs: now() - started,
      failure: "WORKER_BENCHMARK_TIMEOUT",
    };
  }
  return {
    store,
    queueWaitMs: state.firstLeaseAt === null ? 0 : state.firstLeaseAt - state.committedAt,
    wallMs: now() - started,
    ...(state.failed ? { failure: state.failed } : {}),
  };
}

function counts(store: MemoryStore): Record<string, number> {
  return store.runs.reduce<Record<string, number>>((out, run) => {
    for (const [key, value] of Object.entries(run.counts)) out[key] = (out[key] ?? 0) + value;
    return out;
  }, {});
}

function evidenceFor(
  phase: "before" | "after" | "original-60s",
  report: SyntheticBenchmarkReport,
  timings: { uploadMs: number; inspectMs: number; commitMs: number },
  state: AdapterState,
  schedulerRun: { store: MemoryStore; queueWaitMs: number; wallMs: number },
  replayAi: boolean,
): Record<string, unknown> {
  const tally = counts(schedulerRun.store);
  return {
    phase,
    fixture: report.kind,
    pages: report.pageCount,
    transport: "fixture-local",
    aiTransport: replayAi ? "recorded-from-openai-existing-connection" : "openai-existing-connection",
    productionSchedulerIntervalMs: 60_000,
    benchmarkPollIntervalMs: phase === "original-60s" ? 60_000 : 100,
    timingsMs: {
      uploadLocalWrite: Number(timings.uploadMs.toFixed(3)),
      immutableInspect: Number(timings.inspectMs.toFixed(3)),
      commitAdapter: Number(timings.commitMs.toFixed(3)),
      queueWait: Number(schedulerRun.queueWaitMs.toFixed(3)),
      storageRead: Number(state.storageReadMs.toFixed(3)),
      render: Number((state.metrics.renderMs || tally.renderMs || 0).toFixed(3)),
      transcriptionWall: Number((tally.transcriptionWallMs || state.aiMs || 0).toFixed(3)),
      transcriptionAggregate: Number((tally.transcriptionAggregateMs || 0).toFixed(3)),
      saveDbAdapter: Number(state.pageCheckpointDbMs.toFixed(3)),
      aggregationDbAdapter: Number(state.aggregationDbMs.toFixed(3)),
      otherDbAdapter: Number(state.otherDbMs.toFixed(3)),
      totalWall: Number((timings.uploadMs + timings.inspectMs + timings.commitMs + schedulerRun.wallMs).toFixed(3)),
    },
    worker: {
      actualRunBloodworkExtraction: true,
      schedulerRuns: schedulerRun.store.runs.length,
      pagesSaved: state.saved.size,
      finalAggregationCompleted: state.completed,
      storageReads: state.storageReads,
      dbCalls: state.dbCalls,
      successfulModelResponses: state.aiCalls,
      modelRequestAttempts: state.modelRequestAttempts,
      aiPromptTokens: state.usage.promptTokens,
      aiCompletionTokens: state.usage.completionTokens,
      aiTotalTokens: state.usage.totalTokens,
      tokenAvailability: state.usage.totalTokens === null ? "unavailable" : "available",
      costAvailability: "unavailable",
      replayAi: replayAi,
    },
    strictRows: state.completed &&
      state.saved.size === report.pageCount &&
      [...state.saved.entries()].sort(([a], [b]) => a - b).every(([page, actual]) =>
      sameRows(report.pages[page - 1]!.expected, actual),
    ),
    failure: state.failed,
    orchestration: {
      workerImplementation: phase === "after" ? "working-tree worker" : "git-head worker",
      transcriberImplementation: "working-tree extraction.ts for both phases",
      comparisonValidity: "controlled old/new orchestration comparison; not a complete old-production baseline",
    },
    caseStartedAt: state.caseStartedAt,
    caseEndedAt: new Date().toISOString(),
    resumed: false,
    noRawModelReplies: true,
  };
}

async function assertRows(report: SyntheticBenchmarkReport, state: AdapterState): Promise<void> {
  expect(state.completed).toBe(true);
  expect(state.saved.size).toBe(report.pageCount);
  for (let page = 1; page <= report.pageCount; page += 1) {
    expect(state.saved.has(page)).toBe(true);
    expect(sameRows(report.pages[page - 1]!.expected, state.saved.get(page)!)).toBe(true);
  }
}

async function runPhase(
  phase: "before" | "after",
  reports: SyntheticBenchmarkReport[],
  root: string,
  checkpointPath: string,
  checkpoint: PerformanceCheckpoint,
): Promise<Record<string, unknown>[]> {
  const caseKey = (report: SyntheticBenchmarkReport) => `${phase}:${report.kind}:${report.pageCount}`;
  const existing = reports
    .map((report) => checkpoint.reports[caseKey(report)])
    .filter((result): result is Record<string, unknown> => !!result)
    .map((result) => ({ ...result, resumed: true }));
  const pending = reports.filter((report) => !checkpoint.reports[caseKey(report)]);
  if (pending.length === 0) return existing;
  const bundles = phase === "before" ? await materializeOldModules() : { ...(await currentModules()), cleanup: async () => undefined };
  const results: Record<string, unknown>[] = [...existing];
  try {
    for (const report of pending) {
      mocks.aiEvents.length = 0;
      const state = await fixtureState(report, root, phase);
      state.caseStartedAt = new Date().toISOString();
      (globalThis as Record<string, unknown>).__bloodworkPerfMetrics = state.metrics;
      (globalThis as Record<string, unknown>).__bloodworkPerfCurrentState = state;
      installAdapters(state);
      const timings = await inspectAndCommit(state, bundles.documents);
      const run = await runSchedulerUntilDone(state, bundles.job, bundles.scheduler, bundles.store, 100);
      const tally = counts(run.store);
      state.aiCalls = mocks.aiEvents.filter((event) => event.phase === "response").length;
      state.modelRequestAttempts = mocks.aiEvents.filter((event) => event.phase === "request").length;
      state.usage = mocks.aiEvents.reduce((usage, event) => {
        if (event.phase !== "response" || !event.usage) return usage;
        for (const key of ["promptTokens", "completionTokens", "totalTokens"] as const) {
          if (typeof event.usage[key] === "number") usage[key] = (usage[key] ?? 0) + event.usage[key]!;
        }
        return usage;
      }, { promptTokens: null, completionTokens: null, totalTokens: null } as Usage);
      if (state.completed) await assertRows(report, state);
      const result = evidenceFor(phase, report, timings, state, run, false);
      results.push(result);
      checkpoint.reports[caseKey(report)] = result;
      await writeCheckpoint(checkpointPath, checkpoint);
      // Keep one exact page set for the separate real 60s old-scheduler poll.
      if (phase === "before") {
        for (const [page, rows] of state.saved) {
          mocks.recordedRowsByPage.set(page, rows.map(({ sourceFileId: _file, sourcePage: _page, ...row }) => row));
        }
      }
      mocks.aiEvents.length = 0;
      delete (globalThis as Record<string, unknown>).__bloodworkPerfCurrentState;
    }
  } finally {
    bundles.scheduler.stopJobScheduler();
    await bundles.cleanup();
  }
  return results;
}

async function runOriginalSixtySecondPoll(root: string): Promise<Record<string, unknown>> {
  const bundles = await materializeOldModules();
  const report = syntheticBenchmarkReport("born-digital", 6);
  if ([1, 2, 3, 4, 5, 6].some((page) => !mocks.recordedRowsByPage.has(page))) {
    await bundles.cleanup();
    return {
      phase: "original-60s",
      status: "not-run",
      reason: "recorded AI pages were unavailable after an interrupted/resumed benchmark; no synthetic rows were substituted.",
      actualSchedulerTickMs: 60_000,
      predictedWaitUsed: false,
      noRawModelReplies: true,
    };
  }
  const state = await fixtureState(report, root, "original-60s");
  mocks.replayAi = true;
  installAdapters(state);
  const timings = await inspectAndCommit(state, bundles.documents);
  const store = bundles.store.createMemoryJobStore();
  bundles.scheduler.resetJobRegistry();
  bundles.scheduler.registerJob(bundles.job.bloodworkExtractionJob);
  const started = now();
  const deadline = started + 75_000;
  bundles.scheduler.startJobScheduler({ tickMs: 60_000, store });
  // Start with an eligible scheduled tick, then observe the next real 60s
  // interval. Otherwise startup itself consumes the first entire interval.
  await bundles.scheduler.runDueJobs({ trigger: "schedule", store, now: new Date() });
  while (!state.completed && now() < deadline) await sleep(100);
  bundles.scheduler.stopJobScheduler();
  mocks.replayAi = false;
  if (!state.completed) throw new Error("original 60-second scheduler poll did not complete");
  await assertRows(report, state);
  const runs = store.runs;
  const continuationWaitMs = runs.length > 1
    ? Date.parse(runs[1]!.startedAt) - Date.parse(runs[0]!.finishedAt ?? runs[0]!.startedAt)
    : null;
  const result = evidenceFor("original-60s", report, timings, state, {
    store,
    queueWaitMs: state.firstLeaseAt === null ? 0 : state.firstLeaseAt - state.committedAt,
    wallMs: now() - started,
  }, true);
  result.originalPoll = {
    actualSchedulerTickMs: 60_000,
    measuredTotalWallMs: Number((now() - started).toFixed(3)),
    measuredContinuationWaitMs: continuationWaitMs,
    runsObserved: runs.length,
    firstQuantumPages: runs[0]?.counts.pages ?? 0,
    secondQuantumPages: runs[1]?.counts.pages ?? 0,
    predictedWaitUsed: false,
  };
  await bundles.cleanup();
  return result;
}

afterEach(async () => {
  mocks.replayAi = false;
  mocks.aiEvents.length = 0;
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { force: true })));
});

const enabled = process.env.BLOODWORK_PERFORMANCE === "1";
const pollOnly = process.env.BLOODWORK_PERFORMANCE_POLL_ONLY === "1";

describe.skipIf(!pollOnly)("synthetic bloodwork polling observation", () => {
  it("observes a real sixty-second continuation without model requests", async () => {
    const report = syntheticBenchmarkReport("born-digital", 6);
    for (const page of report.pages) {
      mocks.recordedRowsByPage.set(page.sourcePage, page.expected.map((row) => ({ ...row })));
    }
    const root = await mkdtemp(join("/tmp", "bloodwork-poll-observation-"));
    try {
      const observation = await runOriginalSixtySecondPoll(root);
      const path = resolve(ROOT, "scripts/bloodwork-benchmark/evidence/original-poll-observation.json");
      await writeFile(path, JSON.stringify({
        ...observation,
        generatedAt: new Date().toISOString(),
        sourceHashes: await benchmarkSourceHashes(),
        transcriptionSource: "Deterministic expected synthetic fixture rows; no model requests or model accuracy claims.",
      }, null, 2) + "\n", { mode: 0o600 });
      console.log(`sanitizedEvidence=${path}`);
      expect(observation.strictRows).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});

describe.skipIf(!enabled)("synthetic bloodwork worker performance", () => {
  it("measures actual old/new workers, fixture adapters, real AI, and the original 60s poll", async () => {
    if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || !process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
      throw new Error("BLOODWORK_PERFORMANCE=1 requires the existing OpenAI integration.");
    }
    const root = await mkdtemp(join("/tmp", `bloodwork-worker-performance-${process.pid}-`));
    const evidencePath = resolve(ROOT, "scripts/bloodwork-benchmark/evidence/e2e-worker-performance-latest.json");
    const checkpointPath = `${evidencePath}.checkpoint.json`;
    const sourceHashes = await benchmarkSourceHashes();
    const checkpoint = await readCheckpoint(checkpointPath, sourceHashes);
    const checkpointResumed = Object.keys(checkpoint.reports).length > 0;
    try {
      const reports = syntheticBenchmarkReports();
      const before = await runPhase("before", reports, root, checkpointPath, checkpoint);
      const after = await runPhase("after", reports, root, checkpointPath, checkpoint);
      const original60s = checkpoint.original60s ?? await runOriginalSixtySecondPoll(root);
      checkpoint.original60s = original60s;
      await writeCheckpoint(checkpointPath, checkpoint);
      const evidence = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        baselineCommit: HEAD,
        sourceHashes,
        checkpointResumed,
        reports: [...before, ...after],
        original60s,
        transport: {
          upload: "filesystem-fixture",
          storage: "mocked objectStorage backed by fixture files",
          repository: "mocked supabaseAdmin RPC adapter",
          scheduler: "real scheduler + createMemoryJobStore",
          httpRequests: 0,
          databaseRequests: 0,
          warning: "Fixture-local adapter timings are not live HTTP/storage/database timings. Document worker and AI calls are real.",
        },
        cadenceNote: "before/after runDueJobs poll cadence is explicitly 100ms, not production 60s. original60s is the real 60,000ms scheduler observation with recorded AI only.",
        comparisonScope: "Old/new orchestration only: both phases deliberately use the current working-tree extraction.ts/transcriber. This is not a complete old-production baseline.",
        noRawModelReplies: true,
      };
      await mkdir(dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
      console.log(`sanitizedEvidence=${evidencePath}`);
      expect([...before, ...after].every((item) => item.strictRows === true)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 1_200_000);
});

describe("performance benchmark instrumentation guards", () => {
  it("reports nonzero AI and page-save timing independently", () => {
    const report = syntheticBenchmarkReport("born-digital", 1);
    const state = {
      report,
      reportId: "unit",
      fileId: "unit",
      objectPath: "unit",
      contentSha256: "unit",
      committedAt: Date.now(),
      firstLeaseAt: Date.now(),
      completed: true,
      failed: null,
      leased: false,
      saved: new Map(),
      dbMs: 19,
      dbCalls: 3,
      pageCheckpointDbMs: 3,
      aggregationDbMs: 5,
      otherDbMs: 11,
      storageReadMs: 1,
      storageReads: 1,
      metrics: { renderMs: 2, inspectMs: 1 },
      aiMs: 17,
      aiCalls: 1,
      modelRequestAttempts: 1,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    } satisfies AdapterState;
    const result = evidenceFor("after", report, { uploadMs: 1, inspectMs: 1, commitMs: 1 }, state, {
      store: { runs: [], states: new Map() },
      queueWaitMs: 1,
      wallMs: 1,
    }, false) as {
      timingsMs: { transcriptionWall: number; saveDbAdapter: number; aggregationDbAdapter: number };
      worker: { successfulModelResponses: number; modelRequestAttempts: number };
    };
    expect(result.timingsMs.transcriptionWall).toBe(17);
    expect(result.timingsMs.saveDbAdapter).toBe(3);
    expect(result.timingsMs.aggregationDbAdapter).toBe(5);
    expect(result.worker.successfulModelResponses).toBe(1);
    expect(result.worker.modelRequestAttempts).toBe(1);
  });

  it("invalidates a checkpoint when any source hash changes", async () => {
    const path = `/tmp/bloodwork-performance-checkpoint-${process.pid}.json`;
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      baselineCommit: HEAD,
      sourceHashes: { "src/bloodwork/extraction.ts": "old" },
      reports: { "before:born-digital:1": { strictRows: true } },
    }));
    const checkpoint = await readCheckpoint(path, { "src/bloodwork/extraction.ts": "new" });
    expect(checkpoint.reports).toEqual({});
    await rm(path, { force: true });
  });
});