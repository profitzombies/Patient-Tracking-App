/**
 * The AI usage ledger: one row per model call, written in batches.
 *
 * The shared OpenAI client reports every call (lib/integrations-openai-ai-
 * server/src/usage.ts); this module is the sink it reports to. `record` is
 * synchronous — it prices the event and pushes a row onto a buffer — and a
 * timer flushes the buffer in batches to the `ai_usage_events` table. The
 * reply path never waits on the database: a slow or failing write costs
 * rows (counted in `stats().dropped`, logged), never latency.
 *
 * Modes (AI_USAGE_LEDGER=off|memory|database; unset picks `database` when
 * the service-role Supabase credentials exist, else `memory`):
 *   database  batches POST to PostgREST with the service role.
 *   memory    rows stay in a bounded in-process list (tests, local runs
 *             without Supabase). A startup log says so.
 *   off       events are dropped at the sink.
 *
 * Failed batches retry a few times, then drop, so an outage cannot grow the
 * buffer without bound. Rows are counts and ids only: no prompt text, no
 * reply text, no photo.
 */
import { setModelUsageSink, type ModelUsageEvent } from "@workspace/integrations-openai-ai-server/usage";
import { supabaseAdmin } from "../lib/supabase-admin";
import { logger } from "../lib/logger";
import { estimateCostMicros, loadPricingTable, type PricingTable } from "./pricing";

export type UsageScope = "patient" | "office" | "anonymous" | "system" | "unattributed";

export interface UsageRow {
  occurred_at: string;
  surface: string;
  api: string;
  model: string;
  response_model: string | null;
  scope: UsageScope;
  patient_id: string | null;
  provider_id: string | null;
  stream: boolean;
  status: "ok" | "error" | "aborted";
  usage_reported: boolean;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  latency_ms: number;
  first_token_ms: number | null;
  estimated_cost_micros: number | null;
  pricing_version: string | null;
  request_id: string | null;
}

export type UsageWriter = (rows: UsageRow[]) => Promise<void>;

export interface LedgerLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface LedgerOptions {
  writer: UsageWriter;
  pricing?: PricingTable;
  /** How long a recorded row may wait before its batch is written. */
  flushIntervalMs?: number;
  /** Rows per write; a fuller buffer flushes immediately. */
  batchSize?: number;
  /** Buffer ceiling; beyond it the oldest rows are dropped (and counted). */
  maxBuffered?: number;
  /** Write attempts per batch before its rows are dropped. */
  maxAttempts?: number;
  log?: LedgerLog;
  /** Injected clock for tests. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
}

export interface LedgerStats {
  recorded: number;
  written: number;
  dropped: number;
  failedWrites: number;
  buffered: number;
}

export interface ModelUsageLedger {
  record(event: ModelUsageEvent): void;
  /** Writes everything buffered now (retries included); resolves when done. */
  flush(): Promise<void>;
  stats(): LedgerStats;
  /** Stops the timer; buffered rows are flushed first. */
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Converts a metered call into the row the table stores. */
export function toUsageRow(event: ModelUsageEvent, pricing: PricingTable): UsageRow {
  const context = event.context;
  // A patient id that is not a uuid (a demo persona key, a test stub) can
  // never reference the patients table; attribute the row to the office or
  // anonymous traffic instead of failing the whole batch on insert.
  const patientId = context?.patientId && UUID.test(context.patientId) ? context.patientId.toLowerCase() : null;
  const providerId = context?.providerId?.trim() ? context.providerId.trim().slice(0, 120) : null;
  const scope: UsageScope = !context
    ? "unattributed"
    : context.scope ?? (patientId ? "patient" : providerId ? "office" : "anonymous");
  const cost = event.usageReported
    ? estimateCostMicros(event.model, {
        promptTokens: event.promptTokens,
        cachedTokens: event.cachedTokens,
        completionTokens: event.completionTokens,
      }, pricing)
    : null;
  return {
    occurred_at: event.startedAt.toISOString(),
    surface: (context?.surface ?? "unattributed").slice(0, 80),
    api: event.api,
    model: event.model.slice(0, 120),
    response_model: event.responseModel ? event.responseModel.slice(0, 120) : null,
    scope,
    patient_id: patientId,
    provider_id: providerId,
    stream: event.stream,
    status: event.status,
    usage_reported: event.usageReported,
    prompt_tokens: event.promptTokens,
    cached_tokens: Math.min(event.cachedTokens, event.promptTokens),
    completion_tokens: event.completionTokens,
    reasoning_tokens: Math.min(event.reasoningTokens, event.completionTokens),
    latency_ms: Math.max(0, Math.round(event.latencyMs)),
    first_token_ms: event.firstTokenMs === null ? null : Math.max(0, Math.round(event.firstTokenMs)),
    estimated_cost_micros: cost,
    pricing_version: cost === null ? null : pricing.version,
    request_id: context?.requestId ? context.requestId.slice(0, 120) : null,
  };
}

export function createModelUsageLedger(options: LedgerOptions): ModelUsageLedger {
  const pricing = options.pricing ?? loadPricingTable();
  const flushIntervalMs = options.flushIntervalMs ?? 2_000;
  const batchSize = options.batchSize ?? 200;
  const maxBuffered = options.maxBuffered ?? 5_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const log = options.log ?? logger;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));

  const buffer: { row: UsageRow; attempts: number }[] = [];
  const stats: LedgerStats = { recorded: 0, written: 0, dropped: 0, failedWrites: 0, buffered: 0 };
  let timer: { unref?: () => void } | null = null;
  let inFlight: Promise<void> | null = null;
  let closed = false;

  const arm = () => {
    if (timer !== null || closed) return;
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  };

  async function writeBatch(): Promise<boolean> {
    const batch = buffer.splice(0, batchSize);
    if (batch.length === 0) return false;
    try {
      await options.writer(batch.map((entry) => entry.row));
      stats.written += batch.length;
      return true;
    } catch (error) {
      stats.failedWrites += 1;
      const retry = batch.filter((entry) => ++entry.attempts < maxAttempts);
      const dropped = batch.length - retry.length;
      stats.dropped += dropped;
      // Put the survivors back at the front so their order holds; they get
      // another try on the next flush.
      buffer.unshift(...retry);
      log.error({ err: error, rows: batch.length, retried: retry.length, dropped }, "ai usage ledger write failed");
      return false;
    }
  }

  async function drain(): Promise<void> {
    // Stop on the first failure of a flush pass: hammering a failing store
    // with the rest of the buffer helps nothing, and the timer re-arms.
    while (buffer.length > 0) {
      const ok = await writeBatch();
      if (!ok) break;
    }
    if (buffer.length > 0) arm();
  }

  function flush(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = drain().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    record(event) {
      if (closed) return;
      stats.recorded += 1;
      let row: UsageRow;
      try {
        row = toUsageRow(event, pricing);
      } catch (error) {
        stats.dropped += 1;
        log.warn({ err: error }, "ai usage ledger could not shape a row");
        return;
      }
      buffer.push({ row, attempts: 0 });
      if (buffer.length > maxBuffered) {
        const excess = buffer.length - maxBuffered;
        buffer.splice(0, excess);
        stats.dropped += excess;
        log.warn({ dropped: excess }, "ai usage ledger buffer full; oldest rows dropped");
      }
      if (buffer.length >= batchSize) void flush();
      else arm();
    },
    flush,
    stats() {
      return { ...stats, buffered: buffer.length };
    },
    async close() {
      closed = true;
      await flush();
    },
  };
}

// ── Process wiring ──────────────────────────────────────────────────────────

export type LedgerMode = "off" | "memory" | "database";

export function resolveLedgerMode(env: NodeJS.ProcessEnv = process.env): LedgerMode {
  const knob = (env.AI_USAGE_LEDGER ?? "").trim().toLowerCase();
  if (knob === "off" || knob === "memory" || knob === "database") return knob;
  if (knob.length > 0) {
    throw new Error(`AI_USAGE_LEDGER must be "off", "memory" or "database" (got "${env.AI_USAGE_LEDGER}")`);
  }
  const configured = (env.SUPABASE_URL ?? "").trim().length > 0 && (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim().length > 0;
  return configured ? "database" : "memory";
}

/** PostgREST bulk insert with the service role; throws on any non-2xx. */
export async function writeUsageRowsToDatabase(rows: UsageRow[]): Promise<void> {
  const result = await supabaseAdmin("POST", "/rest/v1/ai_usage_events", rows, "return=minimal");
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`ai_usage_events insert failed: HTTP ${result.status} ${JSON.stringify(result.json)?.slice(0, 300)}`);
  }
}

const MEMORY_KEEP = 2_000;
const memoryRows: UsageRow[] = [];

/** Rows kept by the memory mode (newest last), for tests and local checks. */
export function memoryUsageRows(): readonly UsageRow[] {
  return memoryRows;
}

let installed: { mode: LedgerMode; ledger: ModelUsageLedger | null } | null = null;

/**
 * Installs the process's ledger as the shared client's usage sink (once).
 * Returns the mode chosen so the startup log can state it.
 */
export function installModelUsageLedger(env: NodeJS.ProcessEnv = process.env): { mode: LedgerMode; ledger: ModelUsageLedger | null } {
  if (installed) return installed;
  const mode = resolveLedgerMode(env);
  if (mode === "off") {
    setModelUsageSink(null);
    installed = { mode, ledger: null };
    return installed;
  }
  const writer: UsageWriter =
    mode === "database"
      ? writeUsageRowsToDatabase
      : async (rows) => {
          memoryRows.push(...rows);
          if (memoryRows.length > MEMORY_KEEP) memoryRows.splice(0, memoryRows.length - MEMORY_KEEP);
        };
  const ledger = createModelUsageLedger({ writer });
  setModelUsageSink((event) => ledger.record(event));
  installed = { mode, ledger };
  return installed;
}

/** The installed ledger, if any (health/stats endpoints). */
export function installedModelUsageLedger(): ModelUsageLedger | null {
  return installed?.ledger ?? null;
}

/** Test seam: forgets the installed ledger so a suite can install its own. */
export function resetModelUsageLedgerForTests(): void {
  installed = null;
  memoryRows.length = 0;
  setModelUsageSink(null);
}
