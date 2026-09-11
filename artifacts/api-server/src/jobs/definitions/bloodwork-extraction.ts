import { objectStorage } from "../../lib/objectStorage";
import { supabaseAdmin } from "../../lib/supabase-admin";
import {
  BLOODWORK_MAX_FILE_BYTES,
  BloodworkDocumentError,
  inspectBloodworkFile,
  isReportLocalBloodworkDocumentError,
  prepareBloodworkPages,
} from "../../bloodwork/documents";
import {
  BloodworkTranscriptionError,
  BLOODWORK_TRANSCRIPTION_TIMEOUT_MS,
  transcribeBloodworkPage,
  type BloodworkTranscription,
} from "../../bloodwork/extraction";
import { signalJob } from "../scheduler";
import type { JobContext, JobDefinition } from "../types";

interface LeasedReport {
  id: string;
  extraction_lease_token: string;
  committed_at?: string | null;
  extraction_started_at?: string | null;
}

interface WorkFile {
  id: string;
  object_path: string;
  mime_type: string;
  page_count: number;
  position: number;
  content_sha256: string | null;
}

const REPORT_LEASE_SECONDS = 600;
const REPORT_HEARTBEAT_MS = 10_000;
const MAX_UNCONFIRMED_LEASE_MS = 30_000;
const RENEW_RPC_TIMEOUT_MS = 10_000;
const RUN_DEADLINE_MS = 7 * 60_000;
const PAGES_PER_RUN = 4;
const PREPARE_BATCH_SIZE = 2;

async function callRpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await supabaseAdmin("POST", `/rest/v1/rpc/${name}`, body);
  if (response.status >= 300) throw new Error(`${name} failed (${response.status})`);
  return response.json;
}

function safeFailure(error: unknown): string {
  if (error instanceof BloodworkTranscriptionError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (/^[A-Z_]{2,40}$/.test(code)) return code;
  }
  return "EXTRACTION_FAILED";
}

/**
 * The report lease is separate from the scheduler's global job lease. Poll
 * both while external AI requests are in flight, and abort those requests as
 * soon as either ownership proof disappears. stop() waits for a concurrent
 * renewal before a caller releases or fails the report.
 */
function startReportHeartbeat(ctx: JobContext, report: LeasedReport): {
  signal: AbortSignal;
  assertOwned(): void;
  confirmOwned(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  const abort = new AbortController();
  let lost = false;
  let timer: NodeJS.Timeout | null = null;
  let renewing: Promise<void> | null = null;
  let lastConfirmedAt = 0;

  const lose = () => {
    if (lost) return;
    lost = true;
    abort.abort();
  };
  const renewWithDeadline = async (): Promise<unknown> => {
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        callRpc("bloodwork_renew_extraction", {
          p_report_id: report.id,
          p_lease_token: report.extraction_lease_token,
          p_lease_seconds: REPORT_LEASE_SECONDS,
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("bloodwork extraction lease renewal timed out")), RENEW_RPC_TIMEOUT_MS);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const renew = async () => {
    if (lost || renewing) return;
    if (ctx.leaseLost) {
      lose();
      return;
    }
    renewing = renewWithDeadline().then((kept) => {
      if (kept === true) {
        lastConfirmedAt = Date.now();
      } else {
        lose();
      }
    }).catch(() => {
      // A transport failure is not itself proof of takeover, but never run
      // indefinitely without a current ownership proof. The initial proof is
      // fail-closed, and later failures have a short bounded grace period.
      if (lastConfirmedAt === 0 || Date.now() - lastConfirmedAt >= MAX_UNCONFIRMED_LEASE_MS) lose();
    }).finally(() => {
      renewing = null;
    });
    await renewing;
  };
  const assertOwned = () => {
    ctx.checkpoint();
    if (ctx.leaseLost || lost) {
      lose();
      throw new Error("bloodwork extraction lease no longer owned");
    }
  };
  return {
    signal: abort.signal,
    assertOwned,
    async confirmOwned() {
      // Starting a new model request needs stronger proof than the periodic
      // heartbeat's bounded grace period. Wait for an in-flight beat, then
      // force a fresh RPC so a purge that happened during rendering cannot
      // launch another external AI request.
      if (renewing) await renewing;
      assertOwned();
      renewing = renewWithDeadline().then((kept) => {
        if (kept === true) {
          lastConfirmedAt = Date.now();
        } else {
          lose();
        }
      }).catch(() => {
        lose();
      }).finally(() => {
        renewing = null;
      });
      await renewing;
      assertOwned();
    },
    async start() {
      await renew();
      if (lost) throw new Error("bloodwork extraction lease no longer owned");
      timer = setInterval(() => { void renew(); }, REPORT_HEARTBEAT_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (renewing) await renewing;
    },
  };
}

async function transcribePreparedPages(
  pages: Array<{ page: number; bytes: Buffer; mimeType: "image/jpeg" | "image/png" }>,
  file: WorkFile,
  signal: AbortSignal,
  ctx: JobContext,
): Promise<{ successful: Array<{ page: number; results: BloodworkTranscription[] }>; error: unknown | null }> {
  // prepareBloodworkPages accepts at most two pages and independently bounds
  // renderer work. Starting this bounded wave together gives the AI a strict
  // concurrency of two without coupling it to renderer capacity.
  let aggregateMs = 0;
  const startedAt = Date.now();
  const settled = await Promise.allSettled(pages.map(async (prepared) => ({
    page: prepared.page,
    results: await transcribeBloodworkPage({
      bytes: prepared.bytes,
      mimeType: prepared.mimeType,
      sourceFileId: file.id,
      sourcePage: prepared.page,
    }, signal, (event) => {
      if (event.phase !== "response" && event.phase !== "failure") return;
      aggregateMs += event.elapsedMs;
      if (event.phase !== "response") return;
      if (event.usage?.promptTokens !== null && event.usage?.promptTokens !== undefined) {
        ctx.tally("aiPromptTokens", event.usage.promptTokens);
      }
      if (event.usage?.completionTokens !== null && event.usage?.completionTokens !== undefined) {
        ctx.tally("aiCompletionTokens", event.usage.completionTokens);
      }
      if (event.usage?.totalTokens !== null && event.usage?.totalTokens !== undefined) {
        ctx.tally("aiTotalTokens", event.usage.totalTokens);
      }
    }),
  })));
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  ctx.tally("transcriptionWallMs", Date.now() - startedAt);
  ctx.tally("transcriptionAggregateMs", aggregateMs);
  return {
    successful: settled
      .filter((result): result is PromiseFulfilledResult<{ page: number; results: BloodworkTranscription[] }> => result.status === "fulfilled")
      .map((result) => result.value),
    error: rejected?.reason ?? null,
  };
}

export async function runBloodworkExtraction(ctx: JobContext): Promise<void> {
  if (ctx.dryRun) {
    const queued = await supabaseAdmin("GET",
      "/rest/v1/patient_bloodwork_reports?lifecycle_status=eq.committed&extraction_status=eq.queued&select=id&limit=10");
    if (queued.status >= 300 || !Array.isArray(queued.json)) throw new Error(`bloodwork queue check failed (${queued.status})`);
    ctx.tally("wouldProcess", queued.json.length);
    return;
  }

  const leased = await callRpc("bloodwork_lease_extraction", { p_limit: 1, p_lease_seconds: REPORT_LEASE_SECONDS });
  if (!Array.isArray(leased) || leased.length === 0) return;
  const report = leased[0] as LeasedReport;
  const heartbeat = startReportHeartbeat(ctx, report);
  const deadline = AbortSignal.timeout(RUN_DEADLINE_MS);
  const deadlineAt = Date.now() + RUN_DEADLINE_MS;
  const signal = AbortSignal.any([heartbeat.signal, deadline]);

  ctx.tally("reportsLeased");
  const committedAt = Date.parse(report.committed_at ?? "");
  const firstStartedAt = Date.parse(report.extraction_started_at ?? "");
  if (Number.isFinite(committedAt) && Number.isFinite(firstStartedAt) && firstStartedAt >= committedAt) {
    ctx.tally("firstQueueWaitMs", firstStartedAt - committedAt);
  }
  ctx.log("bloodwork_extraction_phase", { phase: "reading_pages" });
  try {
    await heartbeat.start();
    const filesResponse = await supabaseAdmin("GET",
      `/rest/v1/patient_bloodwork_files?report_id=eq.${encodeURIComponent(report.id)}` +
      "&select=id,object_path,mime_type,page_count,position,content_sha256&order=position.asc");
    if (filesResponse.status >= 300 || !Array.isArray(filesResponse.json)) {
      throw new Error(`bloodwork worker files failed (${filesResponse.status})`);
    }
    const files = filesResponse.json as WorkFile[];
    const savedResponse = await supabaseAdmin("GET",
      `/rest/v1/patient_bloodwork_extraction_pages?report_id=eq.${encodeURIComponent(report.id)}` +
      "&select=source_file_id,source_page&limit=101");
    if (savedResponse.status >= 300 || !Array.isArray(savedResponse.json)) {
      throw new Error(`bloodwork worker progress failed (${savedResponse.status})`);
    }
    const saved = new Set((savedResponse.json as Array<{ source_file_id: string; source_page: number }>)
      .map((row) => `${row.source_file_id}:${row.source_page}`));
    const expectedPages = files.reduce((sum, file) => sum + file.page_count, 0);
    let processedThisRun = 0;
    let quantumExhausted = false;

    for (const file of files) {
      if (processedThisRun >= PAGES_PER_RUN) break;
      if (deadline.aborted) {
        quantumExhausted = true;
        break;
      }
      const missing: number[] = [];
      for (let page = 1; page <= file.page_count && processedThisRun + missing.length < PAGES_PER_RUN; page += 1) {
        if (!saved.has(`${file.id}:${page}`)) missing.push(page);
      }
      if (missing.length === 0) continue;
      heartbeat.assertOwned();
      const { bytes } = await objectStorage.readObjectBounded(file.object_path, BLOODWORK_MAX_FILE_BYTES);
      // Storage adapters return a bounded snapshot, but take one more copy so
      // the admission digest and every render in this lease refer to the same
      // immutable bytes. Legacy rows predate content_sha256; fully inspect
      // those PDFs once, then reuse the trusted in-memory admission for all
      // page batches in this run.
      const sourceBytes = Buffer.from(bytes);
      let admission = {
        sha256: file.content_sha256 ?? null,
        pageCount: file.page_count,
      };
      if (file.mime_type === "application/pdf" && admission.sha256 === null) {
        const inspected = await inspectBloodworkFile(sourceBytes, file.mime_type, signal);
        if (
          inspected.mimeType !== file.mime_type
          || inspected.pageCount !== file.page_count
          || !/^[a-f0-9]{64}$/.test(inspected.sha256)
        ) {
          throw new BloodworkDocumentError(
            "CORRUPT_FILE",
            "This document no longer matches its admitted contents.",
          );
        }
        admission = { sha256: inspected.sha256, pageCount: inspected.pageCount };
        ctx.tally("legacyPdfAdmissions");
        ctx.log("bloodwork_legacy_admission_upgraded", {
          reportId: report.id,
          fileId: file.id,
          pageCount: inspected.pageCount,
        });
      }

      for (let offset = 0; offset < missing.length; offset += PREPARE_BATCH_SIZE) {
        // A model request is bounded to 90 seconds. Do not begin another wave
        // when it cannot finish inside this seven-minute quantum; releasing
        // retains any saved siblings for the next durable continuation.
        if (Date.now() + BLOODWORK_TRANSCRIPTION_TIMEOUT_MS >= deadlineAt || deadline.aborted) {
          quantumExhausted = true;
          break;
        }
        heartbeat.assertOwned();
        const requestedPages = missing.slice(offset, offset + PREPARE_BATCH_SIZE);
        const renderStartedAt = Date.now();
        const prepared = await (async () => {
          try {
            return await prepareBloodworkPages(
              sourceBytes,
              file.mime_type,
              requestedPages,
              admission,
              signal,
            );
          } finally {
            ctx.tally("renderMs", Date.now() - renderStartedAt);
          }
        })();
        ctx.tally("pagesPrepared", prepared.length);
        await heartbeat.confirmOwned();
        const transcribed = await transcribePreparedPages(prepared, file, signal, ctx);
        // Save only after the entire concurrent AI wave settles, in source
        // order. Each RPC owns a complete page checkpoint atomically.
        for (const page of transcribed.successful) {
          heartbeat.assertOwned();
          const saveStartedAt = Date.now();
          const savedPage = await (async () => {
            try {
              return await callRpc("bloodwork_save_extraction_page", {
                p_report_id: report.id,
                p_lease_token: report.extraction_lease_token,
                p_source_file_id: file.id,
                p_source_page: page.page,
                p_results: page.results.map(({ sourceFileId: _file, sourcePage: _page, ...value }) => value),
              });
            } finally {
              ctx.tally("saveMs", Date.now() - saveStartedAt);
            }
          })();
          if (savedPage !== true) throw new Error("bloodwork extraction lease no longer owned");
          saved.add(`${file.id}:${page.page}`);
          processedThisRun += 1;
          ctx.tally("pages");
        }
        // Promise.allSettled above guarantees every concurrently started AI
        // request is settled before this failure marks the report failed.
        // Successful siblings were checkpointed first and will not retry.
        if (transcribed.error) throw transcribed.error;
      }
      if (quantumExhausted) break;
    }

    if (deadline.aborted) quantumExhausted = true;
    heartbeat.assertOwned();
    if (!quantumExhausted && saved.size === expectedPages) {
      ctx.log("bloodwork_extraction_phase", { phase: "preparing_results" });
      const prepared = await callRpc("bloodwork_prepare_extraction", {
        p_report_id: report.id, p_lease_token: report.extraction_lease_token,
      });
      if (prepared !== true) throw new Error("bloodwork extraction preparation refused");
      heartbeat.assertOwned();
      const completed = await callRpc("bloodwork_complete_extraction_from_pages", {
        p_report_id: report.id, p_lease_token: report.extraction_lease_token,
      });
      if (completed !== true) throw new Error("bloodwork extraction completion refused");
      ctx.tally("reportsCompleted");
      ctx.log("bloodwork_extraction_phase", { phase: "completed" });
      signalJob("bloodwork-extraction");
    } else {
      const released = await callRpc("bloodwork_release_extraction", {
        p_report_id: report.id, p_lease_token: report.extraction_lease_token,
      });
      if (released !== true) throw new Error("bloodwork extraction release refused");
      ctx.tally("reportsContinued");
      // signalJob defers this until runJob has released its *global* lease.
      // The queued report row is still durable should this process disappear.
      signalJob("bloodwork-extraction");
    }
  } catch (error) {
    await heartbeat.stop();
    // A quantum wall-clock expiry is expected control flow, not a parser/model
    // failure. Preserve any checkpointed pages and let the durable queue run
    // the next quantum. Ownership loss still takes the failure path below.
    if (deadline.aborted && !heartbeat.signal.aborted) {
      const released = await callRpc("bloodwork_release_extraction", {
        p_report_id: report.id,
        p_lease_token: report.extraction_lease_token,
      }).catch(() => false);
      if (released === true) {
        ctx.tally("reportsContinued");
        signalJob("bloodwork-extraction");
        return;
      }
    }
    const code = safeFailure(error);
    let persistError: unknown;
    const persisted = await callRpc("bloodwork_fail_extraction", {
      p_report_id: report.id,
      p_lease_token: report.extraction_lease_token,
      p_error: code,
    }).catch((failure) => {
      persistError = failure;
      return false;
    });
    if (persisted !== true) {
      // A failed terminal transition is an infrastructure failure: the report
      // may still be processing and must not be treated as safely settled.
      ctx.failItem(report.id, persistError ?? code);
      return;
    }
    if (
      isReportLocalBloodworkDocumentError(error)
      && !heartbeat.signal.aborted
      && !ctx.leaseLost
    ) {
      ctx.failItem(report.id, code, { reportLocal: true });
      ctx.log("bloodwork_report_failed", {
        reportId: report.id,
        error: code,
        scope: "report_local",
      });
      // Keep a healthy queued report moving immediately after this terminal
      // report-local outcome. signalJob remains best-effort and durable queue
      // state remains the source of truth.
      signalJob("bloodwork-extraction");
      return;
    }
    ctx.failItem(report.id, code);
  } finally {
    await heartbeat.stop();
  }
}

export const bloodworkExtractionJob: JobDefinition = {
  name: "bloodwork-extraction",
  title: "Bloodwork transcription",
  description: "Transcribes bounded report-page batches with durable atomic checkpoints.",
  intervalMs: 60_000,
  leaseSeconds: 4 * 60 * 60,
  renewEveryMs: REPORT_HEARTBEAT_MS,
  run: runBloodworkExtraction,
};