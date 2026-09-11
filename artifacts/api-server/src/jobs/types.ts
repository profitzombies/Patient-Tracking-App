/**
 * Shared types for the background job framework.
 *
 * A job is a named unit of clean-up work (an upload sweep, a retention
 * trim). The scheduler runs it under a lease, records one run row with
 * counts and per-item failures, and folds the outcome into the job's health
 * state. Jobs never talk to the run ledger themselves: they receive a
 * JobContext and report through it.
 */

export type JobTrigger = "schedule" | "manual" | "internal" | "user";
export type JobRunStatus = "running" | "succeeded" | "failed";

/** Plain numeric tallies a job reports (`{ scanned: 12, deleted: 3 }`). */
export type JobCounts = Record<string, number>;

export interface JobContext {
  /** Count only; never delete or mutate. Jobs MUST honour this. */
  dryRun: boolean;
  /** The instant the run started; jobs derive every cutoff from it. */
  now: Date;
  /** Add to a named tally (creates it at 0). */
  tally(key: string, by?: number): void;
  /** Record one item that failed without aborting the run. */
  failItem(item: string, error: unknown): void;
  /** Structured log line attributed to the run. */
  log(event: string, detail?: Record<string, unknown>): void;
  /**
   * Call between units of work (each batch, prefix, or object). Throws
   * JobLeaseLostError once the run's lease could not be renewed, so a job
   * that outlived its lease stops instead of racing a new holder.
   */
  checkpoint(): void;
  /** True once the lease was lost; loops may poll this instead of checkpoint(). */
  readonly leaseLost: boolean;
}

/** Thrown by ctx.checkpoint() after the run's lease lapsed or moved to another owner. */
export class JobLeaseLostError extends Error {
  constructor(jobName: string) {
    super(`lease for ${jobName} was lost during the run; stopped`);
    this.name = "JobLeaseLostError";
  }
}

export interface JobDefinition {
  /** Stable machine name (`abandoned-uploads`); also the lease key. */
  name: string;
  /** Short human title for the health panel. */
  title: string;
  /** One-sentence description of what a run does. */
  description: string;
  /**
   * How often the in-process scheduler runs it. Null means on-demand only
   * (user-triggered clean-ups that still log runs, or manual "run now").
   */
  intervalMs: number | null;
  /** Lease length; must exceed the longest plausible run. */
  leaseSeconds: number;
  /**
   * Optional bounded global-lease heartbeat for work that can wait on an
   * external system. Defaults to a third of leaseSeconds when omitted.
   */
  renewEveryMs?: number;
  run(ctx: JobContext): Promise<void>;
}

export interface JobRunRecord {
  id: string;
  jobName: string;
  trigger: JobTrigger;
  dryRun: boolean;
  status: JobRunStatus;
  owner: string | null;
  startedAt: string;
  finishedAt: string | null;
  counts: JobCounts;
  failureCount: number;
  error: string | null;
}

export interface JobItemFailureRecord {
  runId: string;
  jobName: string;
  item: string;
  error: string;
  occurredAt: string;
}

/** The rolled-up state row per job (mirrors system_job_leases). */
export interface JobStateRecord {
  jobName: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  consecutiveFailures: number;
  nextEligibleAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: "succeeded" | "failed" | null;
  lastSuccessAt: string | null;
  lastSuccessCounts: JobCounts | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

export type JobOutcome =
  | { kind: "ran"; run: JobRunRecord }
  | { kind: "lease_held" }
  | { kind: "backing_off"; nextEligibleAt: string }
  | { kind: "unknown_job" };
