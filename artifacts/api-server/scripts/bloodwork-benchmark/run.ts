/**
 * Repeatable fixture-local speed benchmark for the isolated document worker.
 *
 * Deterministic/native before + after matrix (no model request):
 *   pnpm --filter @workspace/api-server exec tsx scripts/bloodwork-benchmark/run.ts --phase both --repeats 2 --skip-ai
 *
 * Current implementation only, with real configured transcription requests:
 *   pnpm --filter @workspace/api-server exec tsx scripts/bloodwork-benchmark/run.ts --phase after --repeats 1 --real-ai
 *
 * This is explicitly not live HTTP, object storage, or database evidence.
 * It uses fixture-local repository/checkpoint adapters, real isolated PDF
 * parsing/rasterization, and (when requested) the configured real AI API.
 * Output intentionally contains only sanitized counts, timings, and usage
 * availability; it never writes model replies or extracted values.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  syntheticBenchmarkReports,
  type SyntheticBenchmarkPage,
  type SyntheticBenchmarkReport,
} from "../../src/bloodwork/fixtures/synthetic";

const execFileAsync = promisify(execFile);
const BASELINE_COMMIT = "c2a1caa3b16191d1aba39430f26660566d598a98";
const BASELINE_FILES = [
  "artifacts/api-server/src/bloodwork/documents.ts",
  "artifacts/api-server/src/bloodwork/document-worker-core.ts",
  "artifacts/api-server/src/bloodwork/document-worker.ts",
] as const;
const REPORT_CONCURRENCY = 4;
const PAGE_QUANTUM = 4;
const PREPARE_BATCH_SIZE = 2;
const AI_CONCURRENCY = 2;

type Phase = "before" | "after";
type Documents = {
  inspectBloodworkFile: (bytes: Uint8Array, mime: string) => Promise<{
    pageCount: number;
    sha256?: string;
  }>;
  renderBloodworkPage: (
    bytes: Uint8Array,
    mime: string,
    page: number,
    signal?: AbortSignal,
    admission?: { sha256: string | null; pageCount: number },
  ) => Promise<{ bytes: Buffer; mimeType: "image/jpeg" | "image/png" }>;
  prepareBloodworkPages?: (
    bytes: Uint8Array,
    mime: string,
    pages: number[],
    admission: { sha256: string | null; pageCount: number },
  ) => Promise<Array<{ page: number; bytes: Buffer; mimeType: "image/jpeg" | "image/png" }>>;
};
type ObserverEvent = {
  phase: "request" | "response" | "retry" | "failure";
  usage?: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    costUsd: number | null;
  };
};
type Extraction = {
  transcribeBloodworkPage: (
    input: { bytes: Uint8Array; mimeType: "image/jpeg" | "image/png"; sourceFileId: string; sourcePage: number },
    signal?: AbortSignal,
    observer?: (event: ObserverEvent) => void,
  ) => Promise<unknown[]>;
};
type UsageSummary = {
  requestEvents: number;
  responseEvents: number;
  retryEvents: number;
  failureEvents: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  tokenAvailability: "not-requested" | "unavailable" | "observed";
  costAvailability: "not-requested" | "unavailable" | "observed";
};
type PageResult = {
  page: number;
  checkpointed: boolean;
  renderMs: number;
  transcriptionMs: number;
  renderedBytes: number;
  rows: number;
  errorCode: string | null;
};
type ReportResult = {
  kind: string;
  pageCount: number;
  repeat: number;
  inspectionMs: number;
  nativeElapsedMs: number;
  checkpointCount: number;
  pages: PageResult[];
};

function now(): number {
  return performance.now();
}

function elapsed(started: number): number {
  return Number((now() - started).toFixed(3));
}

function parseArgs(): { phase: Phase | "both"; repeats: number; realAi: boolean; output: string } {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const phase = get("--phase") ?? "both";
  const repeats = Number(get("--repeats") ?? "2");
  if (phase !== "before" && phase !== "after" && phase !== "both") throw new Error("--phase must be before, after, or both.");
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5) throw new Error("--repeats must be an integer from 1 through 5.");
  return {
    phase,
    repeats,
    realAi: args.includes("--real-ai"),
    output: get("--output") ?? resolve(process.cwd(), "bloodwork-speed-evidence.json"),
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

async function mapLimited<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}

async function materializeBaseline(): Promise<{ documents: Documents; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(resolve(dirname(new URL(import.meta.url).pathname), "../.."), ".bloodwork-baseline-"));
  for (const file of BASELINE_FILES) {
    const { stdout } = await execFileAsync("git", ["show", `${BASELINE_COMMIT}:${file}`]);
    await writeFile(join(directory, file.split("/").at(-1)!), stdout);
  }
  return {
    documents: (await import(pathToFileURL(join(directory, "documents.ts")).href)) as Documents,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function documentsFor(phase: Phase): Promise<{ documents: Documents; cleanup: () => Promise<void> }> {
  if (phase === "before") return materializeBaseline();
  return { documents: (await import("../../src/bloodwork/documents")) as Documents, cleanup: async () => undefined };
}

function code(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "PROCESSING_FAILED";
}

function usageSummary(realAi: boolean): UsageSummary {
  return {
    requestEvents: 0,
    responseEvents: 0,
    retryEvents: 0,
    failureEvents: 0,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    costUsd: null,
    tokenAvailability: realAi ? "unavailable" : "not-requested",
    costAvailability: realAi ? "unavailable" : "not-requested",
  };
}

function observeUsage(summary: UsageSummary, event: ObserverEvent): void {
  if (event.phase === "request") summary.requestEvents++;
  if (event.phase === "retry") summary.retryEvents++;
  if (event.phase === "failure") summary.failureEvents++;
  if (event.phase !== "response") return;
  summary.responseEvents++;
  if (!event.usage) return;
  for (const key of ["promptTokens", "completionTokens", "totalTokens"] as const) {
    if (typeof event.usage[key] === "number") {
      summary[key] = (summary[key] ?? 0) + event.usage[key]!;
      summary.tokenAvailability = "observed";
    }
  }
  if (typeof event.usage.costUsd === "number") {
    summary.costUsd = (summary.costUsd ?? 0) + event.usage.costUsd;
    summary.costAvailability = "observed";
  }
}

async function renderReport(
  report: SyntheticBenchmarkReport,
  repeat: number,
  phase: Phase,
  documents: Documents,
  realAi: Extraction | null,
  aiLimit: <T>(work: () => Promise<T>) => Promise<T>,
  usage: UsageSummary,
): Promise<ReportResult> {
  // Fixture-local repository adapter: original report bytes are persisted as
  // one PDF object, and a per-page save is the checkpoint boundary.
  const directory = await mkdtemp(join(resolve(process.cwd(), "scripts/bloodwork-benchmark"), ".fixture-"));
  try {
    const source = report.pages[0]!;
    await writeFile(join(directory, "source.pdf"), source.bytes, { mode: 0o600 });
    const inspectionStarted = now();
    const receipt = await documents.inspectBloodworkFile(source.bytes, source.mimeType);
    const inspectionMs = elapsed(inspectionStarted);
    const admission = phase === "after"
      ? { sha256: receipt.sha256 ?? null, pageCount: receipt.pageCount }
      : { sha256: null, pageCount: receipt.pageCount };
    if (phase === "after" && (!receipt.sha256 || !documents.prepareBloodworkPages)) {
      throw new Error("Current benchmark requires a persisted SHA-256 receipt and prepareBloodworkPages.");
    }

    const nativeStarted = now();
    const rendered = new Map<number, { bytes: Buffer; mimeType: "image/jpeg" | "image/png"; renderMs: number }>();
    // Four pages are a scheduler-style quantum. Within each quantum the
    // current path groups at most two pages in one admitted isolated worker.
    for (const quantum of chunks(report.pages, PAGE_QUANTUM)) {
      for (const batch of chunks(quantum, PREPARE_BATCH_SIZE)) {
        const renderStarted = now();
        if (phase === "after") {
          const pages = await documents.prepareBloodworkPages!(source.bytes, source.mimeType, batch.map((page) => page.sourcePage), admission);
          for (const page of pages) rendered.set(page.page, { bytes: page.bytes, mimeType: page.mimeType, renderMs: elapsed(renderStarted) });
        } else {
          for (const page of batch) {
            const itemStarted = now();
            const renderedPage = await documents.renderBloodworkPage(source.bytes, source.mimeType, page.sourcePage);
            rendered.set(page.sourcePage, { ...renderedPage, renderMs: elapsed(itemStarted) });
          }
        }
      }
    }
    const nativeElapsedMs = elapsed(nativeStarted);

    const checkpoints = new Map<number, PageResult>();
    await Promise.all(report.pages.map((page) => aiLimit(async () => {
      const image = rendered.get(page.sourcePage);
      if (!image) throw new Error(`Missing rendered fixture page ${page.sourcePage}.`);
      const transcriptionStarted = now();
      try {
        // The deterministic mode intentionally records the known synthetic
        // fixture rows rather than claiming that a model request occurred.
        const rows = realAi
          ? await realAi.transcribeBloodworkPage({
            bytes: image.bytes,
            mimeType: image.mimeType,
            sourceFileId: `fixture-${report.kind}-${report.pageCount}`,
            sourcePage: page.sourcePage,
          }, undefined, (event) => observeUsage(usage, event))
          : page.expected;
        checkpoints.set(page.sourcePage, {
          page: page.sourcePage,
          checkpointed: true,
          renderMs: image.renderMs,
          transcriptionMs: elapsed(transcriptionStarted),
          renderedBytes: image.bytes.byteLength,
          rows: rows.length,
          errorCode: null,
        });
      } catch (error) {
        checkpoints.set(page.sourcePage, {
          page: page.sourcePage,
          checkpointed: true,
          renderMs: image.renderMs,
          transcriptionMs: elapsed(transcriptionStarted),
          renderedBytes: image.bytes.byteLength,
          rows: 0,
          errorCode: code(error),
        });
      }
    })));
    const pages = [...checkpoints.values()].sort((a, b) => a.page - b.page);
    await writeFile(join(directory, "aggregate.json"), JSON.stringify(pages.map(({ page, rows, errorCode }) => ({ page, rows, errorCode }))), { mode: 0o600 });
    return { kind: report.kind, pageCount: report.pageCount, repeat, inspectionMs, nativeElapsedMs, checkpointCount: pages.length, pages };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function limiter(limit: number): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>) => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

async function runPhase(phase: Phase, repeats: number, realAi: Extraction | null): Promise<{ reports: ReportResult[]; usage: UsageSummary }> {
  const loaded = await documentsFor(phase);
  try {
    const work = syntheticBenchmarkReports().flatMap((report) =>
      Array.from({ length: repeats }, (_, repeat) => ({ report, repeat: repeat + 1 })),
    );
    const aiLimit = limiter(AI_CONCURRENCY);
    // The four concurrent report adapters intentionally exercise the real
    // one-worker/four-queue backpressure. Queue delay is measured only by
    // elapsed native calls; it is never inferred or fabricated.
    const usage = usageSummary(realAi !== null);
    const reports = await mapLimited(work, REPORT_CONCURRENCY, ({ report, repeat }) =>
      renderReport(report, repeat, phase, loaded.documents, realAi, aiLimit, usage),
    );
    return { reports, usage };
  } finally {
    await loaded.cleanup();
  }
}

async function loadRealAi(enabled: boolean): Promise<Extraction | null> {
  if (!enabled) return null;
  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || !process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error("--real-ai requires the configured OpenAI integration; deterministic fixture results are not model results.");
  }
  return (await import("../../src/bloodwork/extraction")) as Extraction;
}

const args = parseArgs();
const realAi = await loadRealAi(args.realAi);
if (args.realAi && args.phase !== "after") {
  throw new Error("--real-ai is current implementation only; baseline results remain deterministic/native.");
}
const phases: Phase[] = args.phase === "both" ? ["before", "after"] : [args.phase];
const phaseEvidence: Array<{ phase: Phase; reports: ReportResult[]; usage: UsageSummary }> = [];
for (const phase of phases) {
  phaseEvidence.push({ phase, ...(await runPhase(phase, args.repeats, realAi)) });
}
const evidence = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  baselineCommit: BASELINE_COMMIT,
  transport: {
    kind: "fixture-local",
    liveHttp: false,
    liveDatabase: false,
    liveObjectStorage: false,
    note: "Fixture-local repository/checkpoints; actual isolated native document worker. Do not treat as live HTTP/database evidence.",
  },
  scheduling: {
    reportConcurrency: REPORT_CONCURRENCY,
    pageQuantum: PAGE_QUANTUM,
    admittedPrepareBatchSize: PREPARE_BATCH_SIZE,
    aiConcurrency: AI_CONCURRENCY,
    queueTiming: "Measured wall-clock duration of real document calls, including actual worker queue wait; no derived queue time.",
  },
  transcription: {
    mode: args.realAi ? "real-ai-current-only" : "recorded-synthetic",
    usage: args.realAi ? "Provider observer totals are recorded only when supplied; null means unavailable." : "not-requested",
    noRawModelReplies: true,
  },
  phases: phaseEvidence,
};
await mkdir(dirname(args.output), { recursive: true, mode: 0o700 });
await writeFile(args.output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
for (const phase of evidence.phases) {
  const nativeMs = phase.reports.reduce((sum, report) => sum + report.nativeElapsedMs, 0);
  const inspectionMs = phase.reports.reduce((sum, report) => sum + report.inspectionMs, 0);
  const failures = phase.reports.flatMap((report) => report.pages).filter((page) => page.errorCode !== null).length;
  console.log(`phase=${phase.phase} reports=${phase.reports.length} nativeMs=${nativeMs.toFixed(3)} inspectionMs=${inspectionMs.toFixed(3)} checkpointFailures=${failures}`);
}
console.log(`evidence=${args.output} transport=fixture-local transcription=${evidence.transcription.mode}`);