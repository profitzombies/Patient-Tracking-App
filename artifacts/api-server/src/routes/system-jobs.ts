/**
 * Background-job surfaces:
 *
 *   GET  /hq/system-health                 every job with its health state,
 *                                          last success/failure, counts,
 *                                          recent item failures + recent runs,
 *                                          the patient push outbox backlog
 *                                          (due rows, oldest due age, in flight),
 *                                          patient sign-in metrics, and the
 *                                          last external tick per kind
 *   POST /hq/system-health/jobs/:name/run  run one job now (`{ dryRun }`);
 *                                          waits briefly, then 202 with the
 *                                          run id if it is still going
 *   POST /internal/jobs/tick               authenticated scheduler trigger:
 *                                          drains queued exports + due purges,
 *                                          then runs every due job — or one
 *                                          named job (`{ job, dryRun }`)
 *
 * The HQ routes need `settings_manage`; manual runs are audited. Every
 * authenticated tick records a heartbeat (src/jobs/external-ticks.ts) that the
 * health route reports as "last external tick", stale after five minutes.
 */
import { warehouseHealth } from "../billing/warehouse-submissions";
import { Router, type IRouter, type Request, type Response } from "express";
import { createLimiter } from "../coach/limits";
import { recordAdminAuditEvent, requestIdOf } from "../lib/admin-audit";
import { authorizeInternalTrigger } from "../lib/internal-trigger";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { registerAllJobs } from "../jobs";
import {
  recordExternalTick,
  supabaseExternalTickStore,
  toExternalTriggerHealth,
  type ExternalTickStore,
} from "../jobs/external-ticks";
import { JOB_OWNER, getJob, listJobs, runDueJobs, runJob } from "../jobs/scheduler";
import { supabaseJobStore, type JobStore } from "../jobs/store";
import { defaultWorkerDrains, runWorkerDrains, type WorkerDrains } from "../jobs/worker-drains";
import { supabaseNotificationStore, type OutboxBacklog } from "../notifications/store";
import type { JobDefinition, JobItemFailureRecord, JobRunRecord, JobStateRecord } from "../jobs/types";
import { readPerformance } from "../system/performance";
import { readPatientSignInMetrics, type PatientSignInMonth } from "../security/sign-in-metrics";

export type JobHealthStatus = "ok" | "failing" | "stale" | "never_ran" | "running" | "on_demand";

export interface JobHealthDto {
  name: string;
  title: string;
  description: string;
  intervalMs: number | null;
  schedule: string;
  status: JobHealthStatus;
  running: boolean;
  consecutiveFailures: number;
  nextEligibleAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: "succeeded" | "failed" | null;
  lastSuccessAt: string | null;
  lastSuccessCounts: Record<string, number> | null;
  lastFailureAt: string | null;
  lastError: string | null;
  recentFailures: Array<{ item: string; error: string; occurredAt: string }>;
}

/** A job is stale when its last success is older than three intervals. */
export const STALE_INTERVAL_MULTIPLIER = 3;

export function describeInterval(intervalMs: number | null): string {
  if (intervalMs === null) return "On demand";
  const minutes = Math.round(intervalMs / 60_000);
  if (minutes < 60) return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return "Every hour";
  if (hours < 24) return `Every ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Every day" : `Every ${days} days`;
}

export function jobHealthStatus(definition: JobDefinition, state: JobStateRecord | null, now: Date): JobHealthStatus {
  if (state?.leaseUntil && new Date(state.leaseUntil).getTime() > now.getTime()) return "running";
  if (state && state.consecutiveFailures > 0) return "failing";
  if (definition.intervalMs === null) {
    return state?.lastStatus === "failed" ? "failing" : "on_demand";
  }
  if (!state || !state.lastSuccessAt) return "never_ran";
  const age = now.getTime() - new Date(state.lastSuccessAt).getTime();
  if (age > definition.intervalMs * STALE_INTERVAL_MULTIPLIER) return "stale";
  return "ok";
}

export function toJobHealthDto(
  definition: JobDefinition,
  state: JobStateRecord | null,
  failures: JobItemFailureRecord[],
  now: Date,
): JobHealthDto {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    intervalMs: definition.intervalMs,
    schedule: describeInterval(definition.intervalMs),
    status: jobHealthStatus(definition, state, now),
    running: Boolean(state?.leaseUntil && new Date(state.leaseUntil).getTime() > now.getTime()),
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    nextEligibleAt: state?.nextEligibleAt ?? null,
    lastStartedAt: state?.lastStartedAt ?? null,
    lastFinishedAt: state?.lastFinishedAt ?? null,
    lastStatus: state?.lastStatus ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastSuccessCounts: state?.lastSuccessCounts ?? null,
    lastFailureAt: state?.lastFailureAt ?? null,
    lastError: state?.lastError ?? null,
    recentFailures: failures.map((f) => ({ item: f.item, error: f.error, occurredAt: f.occurredAt })),
  };
}

const acquireInternalSlot = createLimiter({
  burst: 30,
  refillPerMinute: 30,
  maxConcurrent: 1,
  dailyBudget: 20_000,
  dailyMessage: "Too many tick requests today.",
  busyMessage: "A job tick is already running.",
  rapidMessage: "Tick requests are arriving too quickly.",
});

/** How long a manual run waits before answering 202 and letting the panel poll. */
export const MANUAL_RUN_WAIT_MS = 20_000;

function runDto(run: JobRunRecord) {
  return run;
}

export interface SystemJobsRouterOptions {
  manualWaitMs?: number;
  /** Heartbeat ledger for external ticks (memory store in tests). */
  tickStore?: ExternalTickStore;
  /** Export / purge drains the tick runs (stubbed in tests). */
  drains?: WorkerDrains;
  /** Push outbox backlog reader (fake in tests). */
  outboxBacklog?: (now: Date) => Promise<OutboxBacklog>;
  /** Performance reader (fake in tests). */
  readPerformance?: typeof readPerformance;
}

export interface OutboxBacklogDto extends OutboxBacklog {
  /** How long the oldest due row has waited, or null when nothing is due. */
  oldestDueAgeMs: number | null;
}

export function outboxBacklogDto(backlog: OutboxBacklog, now: Date): OutboxBacklogDto {
  const oldest = backlog.oldestDueAt ? new Date(backlog.oldestDueAt).getTime() : NaN;
  return {
    ...backlog,
    oldestDueAgeMs: Number.isFinite(oldest) ? Math.max(0, now.getTime() - oldest) : null,
  };
}

export function createSystemJobsRouter(store: JobStore = supabaseJobStore, options: SystemJobsRouterOptions = {}): IRouter {
  registerAllJobs();
  const r: IRouter = Router();
  const manualWaitMs = options.manualWaitMs ?? MANUAL_RUN_WAIT_MS;
  const tickStore = options.tickStore ?? supabaseExternalTickStore;
  const drains = options.drains ?? defaultWorkerDrains;
  const readOutbox = options.outboxBacklog ?? ((now: Date) => supabaseNotificationStore.outboxBacklog(now));

  r.get("/hq/system-health", requireHqPermission("settings_manage"), async (req: Request, res: Response) => {
    try {
      const now = new Date();
      // The outbox read is separate from the job ledger: when it fails the
      // page still shows the jobs, and the outbox tiles read as unavailable
      // rather than an empty, healthy-looking queue.
      const [states, recentRuns, ticks, outbox, warehouse] = await Promise.all([
        store.listStates(),
        store.listRecentRuns(25),
        tickStore.list(),
        readOutbox(now).then(
          (backlog) => outboxBacklogDto(backlog, now),
          (error: unknown) => {
            req.log?.error({ err: error }, "push outbox backlog read failed");
            return null;
          },
        ),
        // Same posture as the outbox: a failed read shows as unavailable, never as a quiet queue.
        warehouseHealth(now).catch((error: unknown) => {
          req.log?.error({ err: error }, "warehouse submission health read failed");
          return null;
        }),
      ]);
      const stateByName = new Map(states.map((s) => [s.jobName, s]));
      const jobs: JobHealthDto[] = [];
      for (const definition of listJobs()) {
        const state = stateByName.get(definition.name) ?? null;
        // Report-local bloodwork failures intentionally leave the shared job
        // healthy so other reports keep running. Their successful run carries
        // a durable count, which is also the signal to include item failures.
        const reportLocalFailures = state?.lastSuccessCounts?.reportLocalFailures ?? 0;
        const failures = state?.lastFailureAt || reportLocalFailures > 0
          ? await store.listRecentItemFailures(definition.name, 5)
          : [];
        jobs.push(toJobHealthDto(definition, state, failures, now));
      }
      // Verification cost: a ledger read failure must not hide the job
      // health, so it degrades to null and the UI says "unavailable".
      let patientSignIns: PatientSignInMonth[] | null = null;
      try {
        patientSignIns = await readPatientSignInMetrics();
      } catch (error) {
        req.log?.error({ err: error }, "patient sign-in metrics read failed");
      }
      res.json({
        asOf: now.toISOString(),
        jobs,
        recentRuns: recentRuns.map(runDto),
        outbox,
        warehouse,
        patientSignIns,
        externalTrigger: toExternalTriggerHealth(ticks, now),
      });
    } catch (error) {
      req.log?.error({ err: error }, "system health read failed");
      res.status(502).json({ error: "Could not load system health right now." });
    }
  });

  // Request speed, slow statements, and data growth. Separate from the job
  // board so a slow statistics read never delays the jobs, and each section
  // degrades to null on its own (the page says "unavailable", never zero).
  r.get("/hq/system-health/performance", requireHqPermission("settings_manage"), async (req: Request, res: Response) => {
    try {
      const performance = await (options.readPerformance ?? readPerformance)(new Date(), {
        onError: (section, error) => req.log?.error({ err: error, section }, "system performance section read failed"),
      });
      res.json(performance);
    } catch (error) {
      req.log?.error({ err: error }, "system performance read failed");
      res.status(502).json({ error: "Could not load performance right now." });
    }
  });

  r.get("/hq/system-health/runs/:runId", requireHqPermission("settings_manage"), async (req: Request, res: Response) => {
    try {
      const run = await store.getRun(String(req.params.runId));
      if (!run) {
        res.status(404).json({ error: "That run does not exist." });
        return;
      }
      res.json({ run: runDto(run) });
    } catch (error) {
      req.log?.error({ err: error }, "system health run read failed");
      res.status(502).json({ error: "Could not load that run right now." });
    }
  });

  r.post("/hq/system-health/jobs/:name/run", requireHqPermission("settings_manage"), async (req: Request, res: Response) => {
    const name = String(req.params.name);
    const definition = getJob(name);
    if (!definition) {
      res.status(404).json({ error: "That job does not exist." });
      return;
    }
    if (name === "patient-media-cleanup") {
      res.status(409).json({ error: "That job only runs from the patient app." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dryRun = body.dryRun === true;
    const staff = res.locals.staff as StaffIdentity;
    try {
      const outcome = await new Promise<Awaited<ReturnType<typeof runJob>> | { kind: "still_running" }>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve({ kind: "still_running" });
          }
        }, manualWaitMs);
        runJob(name, { trigger: "manual", dryRun, store, force: true }).then(
          (value) => {
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              resolve(value);
            }
          },
          (error) => {
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              reject(error);
            }
          },
        );
      });
      recordAdminAuditEvent({
        action: dryRun ? "system_job.dry_run" : "system_job.run",
        actorUserId: staff.userId,
        actorKind: "hq",
        providerId: null,
        targetKind: "system_job",
        targetId: name,
        requestId: requestIdOf(req),
        metadata: { outcome: outcome.kind },
      }).catch((error) => req.log?.warn({ err: error }, "system job audit not recorded"));
      if (outcome.kind === "lease_held") {
        res.status(409).json({ error: "That job is already running." });
        return;
      }
      if (outcome.kind === "still_running") {
        const state = await store.getState(name).catch(() => null);
        res.status(202).json({ status: "running", startedAt: state?.lastStartedAt ?? null });
        return;
      }
      if (outcome.kind !== "ran") {
        res.status(500).json({ error: "The job could not start." });
        return;
      }
      res.json({ run: runDto(outcome.run) });
    } catch (error) {
      req.log?.error({ err: error, job: name }, "manual job run failed");
      res.status(502).json({ error: "The job could not be started right now." });
    }
  });

  r.post("/internal/jobs/tick", async (req: Request, res: Response) => {
    if (!authorizeInternalTrigger(req, res)) return;
    const slot = acquireInternalSlot("internal-jobs-tick");
    if (!slot.ok) {
      res.status(429).json({ error: slot.message });
      return;
    }
    // The heartbeat is written before the response goes out: on autoscale the
    // process may be paused as soon as the request ends.
    const heartbeat = (result: "succeeded" | "failed", summary: Record<string, number>, error: string | null) =>
      recordExternalTick(tickStore, { kind: "jobs", at: new Date(), owner: JOB_OWNER, result, summary, error });
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const dryRun = body.dryRun === true;
      if (typeof body.job === "string" && body.job) {
        const outcome = await runJob(body.job, { trigger: "internal", dryRun, store, force: true });
        if (outcome.kind === "unknown_job") {
          res.status(404).json({ error: "Unknown job." });
          return;
        }
        await heartbeat("succeeded", { jobsDue: 1, jobsRan: outcome.kind === "ran" ? 1 : 0 }, null);
        res.json({ results: [{ name: body.job, outcome }], drains: null });
        return;
      }
      // Queued exports and due purges first (user-visible latency), then the
      // scheduled jobs. `drains: false` keeps a tick to the job ledger only.
      const drained = body.drains === false || dryRun ? null : await runWorkerDrains(drains);
      const results = await runDueJobs({ trigger: "internal", store, dryRun });
      const summary: Record<string, number> = {
        jobsDue: results.length,
        jobsRan: results.filter((r) => r.outcome.kind === "ran").length,
        ...(drained ? { ...drained.counts, drainFailures: drained.failed.length } : {}),
      };
      await heartbeat(
        "succeeded",
        summary,
        drained && drained.failed.length > 0 ? drained.failed.map((f) => `${f.drain}: ${f.error}`).join("; ") : null,
      );
      res.json({ results, drains: drained ? { ...drained.counts, failed: drained.failed } : null });
    } catch (error) {
      req.log?.error({ err: error }, "internal jobs tick failed");
      await heartbeat("failed", {}, error instanceof Error ? error.message || error.name : String(error));
      res.status(500).json({ error: "Tick failed." });
    } finally {
      slot.release();
    }
  });

  return r;
}

const router: IRouter = createSystemJobsRouter();
export default router;
