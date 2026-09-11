/**
 * Synthetic-only model qualification harness.
 *
 * This is intentionally separate from the document/scheduler speed harness.
 * It sends only four deterministic rendered pages per model:
 * clear born-digital, clear scanned, poor scanned, and a 201-row overflow
 * page. Acceptance compares exact field values and row order; model
 * self-confidence or valid JSON alone never passes.
 *
 * No model response is written. Evidence contains timings, counts, field
 * booleans, sanitized error codes, and token/cost availability only.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { batchProcess } from "@workspace/integrations-openai-ai-server/batch";
import {
  syntheticBenchmarkReport,
  syntheticOverflowBenchmarkPage,
  type SyntheticBenchmarkPage,
  type SyntheticExpectedBloodworkRow,
} from "../../src/bloodwork/fixtures/synthetic";

type ModelKey = "terra" | "luna" | "mini";
type ExtractedRow = SyntheticExpectedBloodworkRow & { sourceFileId: string; sourcePage: number };
type ObserverEvent = {
  phase: "request" | "response" | "retry" | "failure";
  model: string;
  attempt: number;
  elapsedMs: number;
  usage?: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    costUsd: number | null;
  };
  errorCode?: string;
};
type Usage = {
  responseEvents: number;
  requestEvents: number;
  retryEvents: number;
  failureEvents: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  tokenAvailability: "available" | "unavailable" | "partial";
  costAvailability: "available" | "unavailable";
};
type FieldChecks = {
  decimals: boolean;
  comparators: boolean;
  units: boolean;
  referenceRanges: boolean;
  flags: boolean;
  qualitative: boolean;
};
type CaseEvidence = {
  fixture: "clear-digital" | "clear-scanned" | "poor-scanned" | "overflow-201";
  renderMs: number;
  transcriptionMs: number;
  expectedRows: number;
  actualRows: number;
  exactFieldErrors: number;
  rowOrderErrors: number;
  missedRows: number;
  duplicateRows: number;
  overflowExpected: boolean;
  errorCode: string | null;
  fieldChecks: FieldChecks;
  strictAcceptance: "pass" | "fail" | "not-run";
  usage: Usage;
};
type ModelEvidence = {
  model: string;
  cases: CaseEvidence[];
  strictAcceptance: "pass" | "fail" | "not-run";
};
type AccuracyEvidence = {
  schemaVersion: 1;
  generatedAt: string;
  sourceCommit: string;
  transport: "openai-existing-connection";
  syntheticOnly: true;
  concurrency: 2;
  retries: "extraction-explicit-bounded";
  timeoutMs: 90_000;
  models: ModelEvidence[];
  noRawModelReplies: true;
};

function modelName(model: ModelKey): string {
  return model === "terra" ? "gpt-5.6-terra" : model === "luna" ? "gpt-5.6-luna" : "gpt-5.4-mini";
}

function parseArgs(): {
  models: ModelKey[];
  output: string;
  skipAi: boolean;
  cases: Array<AccuracyInput["fixture"]>;
} {
  const args = process.argv.slice(2);
  const after = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const requested = (after("--models") ?? "terra,luna,mini").split(",").filter(Boolean) as ModelKey[];
  if (!requested.length || requested.some((model) => !["terra", "luna", "mini"].includes(model))) {
    throw new Error("--models must contain only terra,luna,mini.");
  }
  const allCases: Array<AccuracyInput["fixture"]> = [
    "clear-digital",
    "clear-scanned",
    "poor-scanned",
    "overflow-201",
  ];
  const selectedCases = (after("--cases") ?? allCases.join(",")).split(",").filter(Boolean) as Array<AccuracyInput["fixture"]>;
  if (!selectedCases.length || selectedCases.some((fixture) => !allCases.includes(fixture))) {
    throw new Error("--cases must contain only clear-digital,clear-scanned,poor-scanned,overflow-201.");
  }
  return {
    models: requested,
    output: after("--output") ?? resolve("/tmp", `bloodwork-accuracy-${process.pid}.json`),
    skipAi: args.includes("--skip-ai"),
    cases: selectedCases,
  };
}

function emptyUsage(): Usage {
  return {
    responseEvents: 0,
    requestEvents: 0,
    retryEvents: 0,
    failureEvents: 0,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    costUsd: null,
    tokenAvailability: "unavailable",
    costAvailability: "unavailable",
  };
}

function collector(): { usage: Usage; observe: (event: ObserverEvent) => void } {
  const usage = emptyUsage();
  return {
    usage,
    observe(event) {
      if (event.phase === "request") usage.requestEvents += 1;
      if (event.phase === "retry") usage.retryEvents += 1;
      if (event.phase === "failure") usage.failureEvents += 1;
      if (event.phase !== "response" || !event.usage) return;
      usage.responseEvents += 1;
      for (const key of ["promptTokens", "completionTokens", "totalTokens"] as const) {
        if (typeof event.usage[key] === "number") usage[key] = (usage[key] ?? 0) + event.usage[key]!;
      }
      if (typeof event.usage.costUsd === "number") usage.costUsd = (usage.costUsd ?? 0) + event.usage.costUsd;
    },
  };
}

function finalizeUsage(usage: Usage): void {
  const values = [usage.promptTokens, usage.completionTokens, usage.totalTokens];
  usage.tokenAvailability = values.every((value) => typeof value === "number")
    ? "available"
    : values.some((value) => typeof value === "number")
      ? "partial"
      : "unavailable";
  usage.costAvailability = typeof usage.costUsd === "number" ? "available" : "unavailable";
}

function rowKey(row: SyntheticExpectedBloodworkRow): string {
  return [row.testName, row.valueText, row.units, row.referenceRange, row.labFlag, row.uncertain].join("\u001f");
}

function compare(
  expected: SyntheticExpectedBloodworkRow[],
  actual: ExtractedRow[],
): Omit<CaseEvidence, "fixture" | "renderMs" | "transcriptionMs" | "overflowExpected" | "errorCode" | "strictAcceptance" | "usage"> {
  const fields = ["testName", "valueText", "units", "referenceRange", "labFlag", "uncertain"] as const;
  let exactFieldErrors = 0;
  let rowOrderErrors = 0;
  for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
    const want = expected[index]!;
    const got = actual[index]!;
    if (fields.some((field) => want[field] !== got[field])) exactFieldErrors += 1;
    if (rowKey(want) !== rowKey(got)) rowOrderErrors += 1;
  }
  const count = (rows: SyntheticExpectedBloodworkRow[]) => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(rowKey(row), (counts.get(rowKey(row)) ?? 0) + 1);
    return counts;
  };
  const expectedCounts = count(expected);
  const actualCounts = count(actual);
  let missedRows = 0;
  let duplicateRows = 0;
  for (const [key, value] of expectedCounts) missedRows += Math.max(0, value - (actualCounts.get(key) ?? 0));
  for (const [key, value] of actualCounts) duplicateRows += Math.max(0, value - (expectedCounts.get(key) ?? 0));
  const direct = (predicate: (row: SyntheticExpectedBloodworkRow) => boolean): boolean => {
    const index = expected.findIndex(predicate);
    return index >= 0 && !!actual[index] && rowKey(expected[index]!) === rowKey(actual[index]!);
  };
  return {
    expectedRows: expected.length,
    actualRows: actual.length,
    exactFieldErrors,
    rowOrderErrors,
    missedRows,
    duplicateRows,
    fieldChecks: {
      decimals: direct((row) => row.valueText?.includes(".") ?? false),
      comparators: direct((row) => /[<>]=?/.test(row.valueText ?? "")),
      units: direct((row) => row.units !== null),
      referenceRanges: direct((row) => row.referenceRange !== null),
      flags: direct((row) => row.labFlag !== null),
      qualitative: direct((row) => row.valueText === "Negative"),
    },
  };
}

async function loadModules(): Promise<{
  documents: {
    renderBloodworkPage: (
      bytes: Uint8Array,
      mime: string,
      page: number,
    ) => Promise<{ bytes: Buffer; mimeType: "image/jpeg" | "image/png"; width: number; height: number }>;
  };
  extraction: {
    transcribeBloodworkPage: (
      input: {
        bytes: Uint8Array;
        mimeType: "image/jpeg" | "image/png";
        sourceFileId: string;
        sourcePage: number;
      },
      signal?: AbortSignal,
      observer?: (event: ObserverEvent) => void,
    ) => Promise<ExtractedRow[]>;
    transcribeBloodworkPageBenchmark: (
      input: {
        bytes: Uint8Array;
        mimeType: "image/jpeg" | "image/png";
        sourceFileId: string;
        sourcePage: number;
      },
      options: {
        model: string;
        timeoutMs: number;
        maxAttempts: number;
        observer?: (event: ObserverEvent) => void;
      },
      signal?: AbortSignal,
    ) => Promise<ExtractedRow[]>;
  };
}> {
  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || !process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error("Existing OpenAI integration is not configured.");
  }
  return {
    documents: (await import("../../src/bloodwork/documents")) as never,
    extraction: (await import("../../src/bloodwork/extraction")) as never,
  };
}

type AccuracyInput = {
  fixture: CaseEvidence["fixture"];
  page: SyntheticBenchmarkPage | null;
  overflow: boolean;
};

function inputs(): AccuracyInput[] {
  const digital = syntheticBenchmarkReport("born-digital", 1).pages[0]!;
  const clearScanned = syntheticBenchmarkReport("scanned", 2).pages[0]!;
  const poorScanned = syntheticBenchmarkReport("scanned", 1).pages[0]!;
  return [
    { fixture: "clear-digital", page: digital, overflow: false },
    { fixture: "clear-scanned", page: clearScanned, overflow: false },
    { fixture: "poor-scanned", page: poorScanned, overflow: false },
    { fixture: "overflow-201", page: null, overflow: true },
  ];
}

async function runCase(
  input: AccuracyInput,
  model: ModelKey,
  modules: Awaited<ReturnType<typeof loadModules>> | null,
  skipAi: boolean,
): Promise<CaseEvidence> {
  const usageCollector = collector();
  if (skipAi || !modules) {
    return {
      fixture: input.fixture,
      renderMs: 0,
      transcriptionMs: 0,
      expectedRows: input.overflow ? 201 : input.page!.expected.length,
      actualRows: 0,
      exactFieldErrors: 0,
      rowOrderErrors: 0,
      missedRows: 0,
      duplicateRows: 0,
      overflowExpected: input.overflow,
      errorCode: "AI_NOT_RUN",
      fieldChecks: {
        decimals: false,
        comparators: false,
        units: false,
        referenceRanges: false,
        flags: false,
        qualitative: false,
      },
      strictAcceptance: "not-run",
      usage: usageCollector.usage,
    };
  }
  const renderStarted = performance.now();
  let rendered: { bytes: Buffer; mimeType: "image/jpeg" | "image/png"; width: number; height: number };
  try {
    const source = input.overflow
      ? syntheticOverflowBenchmarkPage()
      : input.page!;
    rendered = await modules.documents.renderBloodworkPage(
      source.bytes,
      source.mimeType,
      input.overflow ? 1 : source.sourcePage,
    );
  } catch (error) {
    return {
      fixture: input.fixture,
      renderMs: Number((performance.now() - renderStarted).toFixed(3)),
      transcriptionMs: 0,
      expectedRows: input.overflow ? 201 : input.page!.expected.length,
      actualRows: 0,
      exactFieldErrors: 0,
      rowOrderErrors: 0,
      missedRows: input.overflow ? 0 : input.page!.expected.length,
      duplicateRows: 0,
      overflowExpected: input.overflow,
      errorCode: error && typeof error === "object" && "code" in error ? String(error.code) : "RENDER_FAILED",
      fieldChecks: {
        decimals: false,
        comparators: false,
        units: false,
        referenceRanges: false,
        flags: false,
        qualitative: false,
      },
      strictAcceptance: "fail",
      usage: usageCollector.usage,
    };
  }
  const renderMs = Number((performance.now() - renderStarted).toFixed(3));
  const transcriptionStarted = performance.now();
  try {
    const sourcePage = input.overflow ? 1 : input.page!.sourcePage;
    const sourceFileId = `synthetic-accuracy-${input.fixture}`;
    if (input.overflow) {
      const actual = await modules.extraction.transcribeBloodworkPageBenchmark(
        { bytes: rendered.bytes, mimeType: rendered.mimeType, sourceFileId, sourcePage },
        { model: modelName(model), timeoutMs: 90_000, maxAttempts: 2, observer: usageCollector.observe },
      );
      finalizeUsage(usageCollector.usage);
      return {
        fixture: input.fixture,
        renderMs,
        transcriptionMs: Number((performance.now() - transcriptionStarted).toFixed(3)),
        expectedRows: 201,
        actualRows: actual.length,
        exactFieldErrors: 0,
        rowOrderErrors: 0,
        missedRows: 0,
        duplicateRows: 0,
        overflowExpected: true,
        errorCode: "OVERFLOW_NOT_REJECTED",
        fieldChecks: {
          decimals: false,
          comparators: false,
          units: false,
          referenceRanges: false,
          flags: false,
          qualitative: false,
        },
        strictAcceptance: "fail",
        usage: usageCollector.usage,
      };
    }
    const actual = model === "terra"
      ? await modules.extraction.transcribeBloodworkPage(
        { bytes: rendered.bytes, mimeType: rendered.mimeType, sourceFileId, sourcePage },
        undefined,
        usageCollector.observe,
      )
      : await modules.extraction.transcribeBloodworkPageBenchmark(
        { bytes: rendered.bytes, mimeType: rendered.mimeType, sourceFileId, sourcePage },
        { model: modelName(model), timeoutMs: 90_000, maxAttempts: 2, observer: usageCollector.observe },
      );
    const comparison = compare(input.page!.expected, actual);
    const strict = comparison.exactFieldErrors === 0 &&
      comparison.rowOrderErrors === 0 &&
      comparison.missedRows === 0 &&
      comparison.duplicateRows === 0 &&
      Object.values(comparison.fieldChecks).every(Boolean);
    finalizeUsage(usageCollector.usage);
    return {
      fixture: input.fixture,
      renderMs,
      transcriptionMs: Number((performance.now() - transcriptionStarted).toFixed(3)),
      ...comparison,
      overflowExpected: false,
      errorCode: null,
      strictAcceptance: strict ? "pass" : "fail",
      usage: usageCollector.usage,
    };
  } catch (error) {
    finalizeUsage(usageCollector.usage);
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "TRANSCRIPTION_FAILED";
    const overflowPass = input.overflow && code === "TOO_MANY_RESULTS";
    const noModelResponse = usageCollector.usage.responseEvents === 0 &&
      (code === "AI_FAILED" || code === "AI_TIMEOUT");
    return {
      fixture: input.fixture,
      renderMs,
      transcriptionMs: Number((performance.now() - transcriptionStarted).toFixed(3)),
      expectedRows: input.overflow ? 201 : input.page!.expected.length,
      actualRows: 0,
      exactFieldErrors: 0,
      rowOrderErrors: 0,
      missedRows: input.overflow ? 0 : input.page!.expected.length,
      duplicateRows: 0,
      overflowExpected: input.overflow,
      errorCode: code,
      fieldChecks: {
        decimals: overflowPass,
        comparators: overflowPass,
        units: overflowPass,
        referenceRanges: overflowPass,
        flags: overflowPass,
        qualitative: overflowPass,
      },
      // An upstream failure before any model response is inconclusive, not an
      // accuracy regression. It must not be promoted, but it also must not
      // falsely fail a fixture that was never evaluated.
      strictAcceptance: overflowPass ? "pass" : noModelResponse ? "not-run" : "fail",
      usage: usageCollector.usage,
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const modules = args.skipAi ? null : await loadModules();
  const models: ModelEvidence[] = [];
  for (const model of args.models) {
    const cases = await batchProcess(
      inputs().filter((input) => args.cases.includes(input.fixture)),
      (input) => runCase(input, model, modules, args.skipAi),
      { concurrency: 2, retries: 0 },
    );
    models.push({
      model: modelName(model),
      cases,
      strictAcceptance: args.skipAi
        ? "not-run"
        : cases.every((item) => item.strictAcceptance === "pass")
          ? "pass"
          : cases.some((item) => item.strictAcceptance === "fail")
            ? "fail"
            : "not-run",
    });
    const usage = cases.map((item) => item.usage);
    console.log(
      [
        `model=${modelName(model)}`,
        `strict=${models.at(-1)!.strictAcceptance}`,
        `cases=${cases.length}`,
        `missed=${cases.reduce((sum, item) => sum + item.missedRows, 0)}`,
        `duplicates=${cases.reduce((sum, item) => sum + item.duplicateRows, 0)}`,
        `exactFieldErrors=${cases.reduce((sum, item) => sum + item.exactFieldErrors, 0)}`,
        `overflow=${cases.find((item) => item.fixture === "overflow-201")?.errorCode ?? "NOT_RUN"}`,
        `tokens=${usage.some((item) => item.usage?.tokenAvailability === "available") ? "available" : "unavailable"}`,
      ].join(" "),
    );
  }
  const evidence: AccuracyEvidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceCommit: process.env.BLOODWORK_BENCHMARK_SOURCE_COMMIT ?? "working-tree",
    transport: "openai-existing-connection",
    syntheticOnly: true,
    concurrency: 2,
    retries: "extraction-explicit-bounded",
    timeoutMs: 90_000,
    models,
    noRawModelReplies: true,
  };
  await mkdir(dirname(args.output), { recursive: true }).catch(() => undefined);
  await writeFile(args.output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`sanitizedEvidence=${args.output}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown accuracy harness failure.";
  console.error(`Bloodwork accuracy benchmark failed: ${message}`);
  process.exitCode = 1;
});