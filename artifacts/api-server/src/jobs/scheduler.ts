/**
 * The job scheduler: a registry of named jobs plus the one code path that
 * runs them.
 *
 *   runJob(name)      lease → run row → job → finish (counts, failures,
 *                     backoff state). Never runs a job twice at once across
 *                     processes: the lease RPC is the arbiter.
 *   runDueJobs()      every scheduled job whose interval elapsed (or whose
 *                     failure backoff expired). Driven by the in-process
 *                     ticker AND by the authenticated internal trigger so a
 *                     scheduled deployment can run clean-up even when the
 *                     API is otherwise idle.
 *   runUserJob()      inline, request-scoped work (a patient discarding an
 *                     upload) that should still appear in the run ledger.
 *
 * Dry runs record a run row but never move the health state, and jobs are
 * told through ctx.dryRun so nothing is deleted.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";
import { supabaseJobStore, type JobStore } from "./store";
import { JobLeaseLostError, type JobContext, type JobCounts, type JobDefinition, type JobOutcome, type JobRunRecord, type JobTrigger } from "./types";

export const JOB_OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Base backoff after a failed run (doubles per consecutive failure, capped at 6h in SQL). */
export const JOB_BACKOFF_BASE_SECONDS = 300;

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function jobsDisabled(): boolean {
  const raw = process.env.JOBS_DISABLED;
  return raw === "1" || raw === "true";
}

const registry = new Map<string, JobDefinition>();
// A local prompt is deliberately only an acceleration mechanism. The report
// queue remains durable in Postgres, so a dropped process or a busy peer can
// never lose work. Keeping this state here does, however, close the common
// race where a commit asks for another run while this process still owns the
// job's global lease.
const prompted = new Set<string>();
const promptDispatching = new Set<string>();
const activeRuns = new Map<string, number>();
const activeRunStores = new Map<string, JobStore>();

export function registerJob(definition: JobDefinition): void {
  if (!/^[a-z0-9_-]{1,64}$/.test(definition.name)) {
    throw new Error(`invalid job name: ${definition.name}`);
  }
  registry.set(definition.name, definition);
}

export function getJob(name: string): JobDefinition | undefined {
  return registry.get(name);
}

export function listJobs(): JobDefinition[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Test hook: forget every registered job. */
export function resetJobRegistry(): void {
  registry.clear();
  prompted.clear();
  promptDispatching.clear();
  activeRuns.clear();
  activeRunStores.clear();
}

function activeRunCount(name: string): number {
  return activeRuns.get(name) ?? 0;
}

function dispatchPrompt(name: string, store?: JobStore): void {
  if (promptDispatching.has(name)) return;
  promptDispatching.add(name);
  queueMicrotask(() => {
    promptDispatching.delete(name);
    if (!prompted.has(name) || jobsDisabled() || !registry.has(name)) return;
    // A job body may signal its own continuation before runJob has released
    // the global lease. Leave the request set; its finally block dispatches it
    // immediately after finish_system_job_run releases that lease.
    if (activeRunCount(name) > 0) return;
    prompted.delete(name);
    void runJob(name, { trigger: "internal", store }).catch((error) => {
      logger.error({ err: error, job: name }, "prompted job run could not start");
    });
  });
}

/**
 * Ask this process to run a job promptly after the current holder finishes.
 * This never bypasses JOBS_DISABLED or failure backoff. It is intentionally
 * best-effort: the job's database queue is the durable fallback if this
 * process is unavailable or another process owns the lease.
 */
export function signalJob(name: string): boolean {
  if (jobsDisabled() || !registry.has(name)) return false;
  prompted.add(name);
  dispatchPrompt(name);
  return true;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

interface RunState {
  counts: JobCounts;
  failures: number;
  reportLocalFailures: number;
  /** Set by the heartbeat once the lease could not be renewed. */
  leaseLost: boolean;
}

/** Renew a leaseSeconds lease this often (a third of its length, at least once a second). */
export function leaseRenewIntervalMs(leaseSeconds: number): number {
  return Math.max(1000, Math.floor((leaseSeconds * 1000) / 3));
}

function buildContext(input: {
  run: JobRunRecord;
  store: JobStore;
  dryRun: boolean;
  now: Date;
  state: RunState;
}): JobContext {
  const { run, store, state } = input;
  return {
    dryRun: input.dryRun,
    now: input.now,
    get leaseLost() {
      return state.leaseLost;
    },
    checkpoint() {
      if (state.leaseLost) throw new JobLeaseLostError(run.jobName);
    },
    tally(key, by = 1) {
      state.counts[key] = (state.counts[key] ?? 0) + by;
    },
    failItem(item, error, options) {
      const reportLocal = options?.reportLocal === true;
      if (reportLocal) {
        state.reportLocalFailures += 1;
        state.counts.reportLocalFailures = state.reportLocalFailures;
      } else {
        state.failures += 1;
      }
      const message = errorText(error);
      logger.warn(
        { job: run.jobName, runId: run.id, item, err: message, reportLocal },
        reportLocal ? "job report-local item failed" : "job item failed",
      );
      // Best effort: a ledger hiccup must not turn one item failure into a run abort.
      store.recordItemFailure({ runId: run.id, jobName: run.jobName, item, error: message }).catch((err) => {
        logger.error({ err, job: run.jobName, runId: run.id }, "job item failure not recorded");
      });
    },
    log(event, detail = {}) {
      logger.info({ job: run.jobName, runId: run.id, dryRun: input.dryRun, ...detail }, event);
    },
  };
}

export interface RunJobOptions {
  trigger: JobTrigger;
  dryRun?: boolean;
  store?: JobStore;
  now?: Date;
  /** Ignore failure backoff (manual and named internal runs do). */
  force?: boolean;
  owner?: string;
  /** Test hook: how often the heartbeat renews the lease (default: a third of leaseSeconds). */
  renewIntervalMs?: number;
}

/**
 * Run one registered job under its lease. Resolves once the run row is
 * closed; the outcome says whether it ran, was skipped for a live lease,
 * or is still backing off after failures.
 */
async function runJobOwned(name: string, options: RunJobOptions): Promise<JobOutcome> {
  const definition = registry.get(name);
  if (!definition) return { kind: "unknown_job" };
  const store = options.store ?? supabaseJobStore;
  const now = options.now ?? new Date();
  const owner = options.owner ?? JOB_OWNER;
  const dryRun = options.dryRun === true;

  if (!options.force) {
    const state = await store.getState(name);
    if (state?.nextEligibleAt && new Date(state.nextEligibleAt).getTime() > now.getTime()) {
      return { kind: "backing_off", nextEligibleAt: state.nextEligibleAt };
    }
  }

  const held = await store.acquireLease(name, owner, definition.leaseSeconds);
  if (!held) return { kind: "lease_held" };

  let run: JobRunRecord;
  try {
    run = await store.startRun({ jobName: name, trigger: options.trigger, dryRun, owner });
  } catch (error) {
    await store.releaseLease(name, owner).catch(() => undefined);
    throw error;
  }

  const state: RunState = { counts: {}, failures: 0, reportLocalFailures: 0, leaseLost: false };
  const ctx = buildContext({ run, store, dryRun, now, state });
  let status: "succeeded" | "failed" = "succeeded";
  let error: string | null = null;
  ctx.log("job_started", { trigger: options.trigger });
  // Heartbeat: keep the lease alive for as long as the job actually runs. A
  // renewal that comes back false means the lease lapsed (or another owner
  // took it); the job is told through ctx.checkpoint() and the run is
  // recorded as failed even if the job body finishes on its own.
  const renewEvery = options.renewIntervalMs ?? definition.renewEveryMs ?? leaseRenewIntervalMs(definition.leaseSeconds);
  let renewing: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (renewing || state.leaseLost) return;
    renewing = store
      .renewLease(name, owner, definition.leaseSeconds)
      .then((kept) => {
        if (!kept && !state.leaseLost) {
          state.leaseLost = true;
          logger.error({ job: name, runId: run.id, owner }, "job lease lost during run");
        }
      })
      .catch((err) => {
        // A transient ledger error is not proof the lease moved; try again next beat.
        logger.warn({ err, job: name, runId: run.id }, "job lease renewal failed");
      })
      .finally(() => {
        renewing = null;
      });
  }, renewEvery);
  heartbeat.unref();
  try {
    await definition.run(ctx);
    if (state.failures > 0) {
      status = "failed";
      error = `${state.failures} item${state.failures === 1 ? "" : "s"} failed`;
    }
  } catch (thrown) {
    status = "failed";
    error = errorText(thrown);
    if (thrown instanceof JobLeaseLostError) {
      logger.error({ job: name, runId: run.id }, "job stopped after losing its lease");
    } else {
      logger.error({ err: thrown, job: name, runId: run.id }, "job run threw");
    }
  } finally {
    clearInterval(heartbeat);
    if (renewing) await renewing;
  }
  if (state.leaseLost && status === "succeeded") {
    status = "failed";
    error = new JobLeaseLostError(name).message;
  }
  try {
    await store.finishRun({
      runId: run.id,
      status,
      counts: state.counts,
      failureCount: state.failures,
      error,
      backoffSeconds: JOB_BACKOFF_BASE_SECONDS,
    });
  } catch (finishError) {
    // The run row stays "running" and the lease lapses on its own; do not
    // hide the original outcome behind a bookkeeping failure.
    logger.error({ err: finishError, job: name, runId: run.id }, "job run finish not recorded");
    await store.releaseLease(name, owner).catch(() => undefined);
  }
  ctx.log("job_finished", { status, counts: state.counts, failures: state.failures, error });
  const closed = (await store.getRun(run.id).catch(() => null)) ?? {
    ...run,
    status,
    finishedAt: new Date().toISOString(),
    counts: state.counts,
    failureCount: state.failures,
    error,
  };
  return { kind: "ran", run: closed };
}

export function runJob(name: string, options: RunJobOptions): Promise<JobOutcome> {
  const active = activeRunCount(name);
  activeRuns.set(name, active + 1);
  if (active === 0) activeRunStores.set(name, options.store ?? supabaseJobStore);
  return runJobOwned(name, options).finally(() => {
    const remaining = activeRunCount(name) - 1;
    if (remaining <= 0) {
      const store = activeRunStores.get(name);
      activeRuns.delete(name);
      activeRunStores.delete(name);
      if (prompted.has(name)) dispatchPrompt(name, store);
    } else {
      activeRuns.set(name, remaining);
    }
  });
}

/** Whether a scheduled job's interval (or failure backoff) has elapsed. */
export function isJobDue(
  definition: JobDefinition,
  state: { lastStartedAt: string | null; lastStatus: "succeeded" | "failed" | null; nextEligibleAt: string | null } | null,
  now: Date,
): boolean {
  if (definition.intervalMs === null) return false;
  if (!state || !state.lastStartedAt) return true;
  if (state.lastStatus === "failed") {
    return !state.nextEligibleAt || new Date(state.nextEligibleAt).getTime() <= now.getTime();
  }
  return now.getTime() - new Date(state.lastStartedAt).getTime() >= definition.intervalMs;
}

export interface DueRunResult {
  name: string;
  outcome: JobOutcome;
}

/** Run every scheduled job that is due, one after another. */
export async function runDueJobs(options: { trigger: JobTrigger; store?: JobStore; now?: Date; dryRun?: boolean } = { trigger: "schedule" }): Promise<DueRunResult[]> {
  const store = options.store ?? supabaseJobStore;
  const now = options.now ?? new Date();
  const results: DueRunResult[] = [];
  for (const definition of listJobs()) {
    if (definition.intervalMs === null) continue;
    let state = null;
    try {
      state = await store.getState(definition.name);
    } catch (error) {
      logger.error({ err: error, job: definition.name }, "job state read failed; skipping this tick");
      continue;
    }
    if (!isJobDue(definition, state, now)) continue;
    try {
      const outcome = await runJob(definition.name, { trigger: options.trigger, store, now, dryRun: options.dryRun });
      results.push({ name: definition.name, outcome });
    } catch (error) {
      logger.error({ err: error, job: definition.name }, "job run could not start");
    }
  }
  return results;
}

/**
 * Inline, request-scoped work that belongs in the run ledger (the patient
 * "discard upload" path). No lease: each request is its own run.
 */
export async function runUserJob<T>(
  name: string,
  work: (ctx: JobContext) => Promise<T>,
  options: { store?: JobStore; now?: Date } = {},
): Promise<T> {
  const store = options.store ?? supabaseJobStore;
  const now = options.now ?? new Date();
  let run: JobRunRecord | null = null;
  try {
    run = await store.startRun({ jobName: name, trigger: "user", dryRun: false, owner: JOB_OWNER });
  } catch (error) {
    logger.error({ err: error, job: name }, "user job run not recorded; proceeding");
  }
  const state: RunState = { counts: {}, failures: 0, reportLocalFailures: 0, leaseLost: false };
  const ctx: JobContext = run
    ? buildContext({ run, store, dryRun: false, now, state })
    : {
        dryRun: false,
        now,
        leaseLost: false,
        checkpoint() {},
        tally(key, by = 1) {
          state.counts[key] = (state.counts[key] ?? 0) + by;
        },
        failItem(item, error, options) {
          const reportLocal = options?.reportLocal === true;
          if (reportLocal) {
            state.reportLocalFailures += 1;
            state.counts.reportLocalFailures = state.reportLocalFailures;
          } else {
            state.failures += 1;
          }
          logger.warn(
            { job: name, item, err: errorText(error), reportLocal },
            reportLocal ? "job report-local item failed" : "job item failed",
          );
        },
        log(event, detail = {}) {
          logger.info({ job: name, ...detail }, event);
        },
      };
  let status: "succeeded" | "failed" = "succeeded";
  let error: string | null = null;
  try {
    const result = await work(ctx);
    if (state.failures > 0) {
      status = "failed";
      error = `${state.failures} item${state.failures === 1 ? "" : "s"} failed`;
    }
    return result;
  } catch (thrown) {
    status = "failed";
    error = errorText(thrown);
    throw thrown;
  } finally {
    if (run) {
      await store
        .finishRun({ runId: run.id, status, counts: state.counts, failureCount: state.failures, error, backoffSeconds: JOB_BACKOFF_BASE_SECONDS })
        .catch((err) => logger.error({ err, job: name }, "user job finish not recorded"));
    }
  }
}

let ticker: NodeJS.Timeout | null = null;
let inFlight: Promise<unknown> | null = null;

/** Start the in-process ticker (once per process). Honours JOBS_DISABLED and JOBS_TICK_MS. */
export function startJobScheduler(input: { tickMs?: number; store?: JobStore } = {}): void {
  if (ticker) return;
  if (jobsDisabled()) {
    logger.info("job scheduler disabled (JOBS_DISABLED)");
    return;
  }
  const tickMs = input.tickMs ?? envInt("JOBS_TICK_MS", 60_000);
  const tick = () => {
    if (inFlight) return;
    inFlight = runDueJobs({ trigger: "schedule", store: input.store })
      .catch((error) => logger.error({ err: error }, "job scheduler tick failed"))
      .finally(() => {
        inFlight = null;
      });
  };
  ticker = setInterval(tick, tickMs);
  ticker.unref();
  // First pass shortly after boot so a fresh deploy picks up overdue work
  // without waiting a full tick, but after listen() so health checks pass.
  const first = setTimeout(tick, Math.min(tickMs, 15_000));
  first.unref();
}

export function stopJobScheduler(): void {
  if (!ticker) return;
  clearInterval(ticker);
  ticker = null;
}
