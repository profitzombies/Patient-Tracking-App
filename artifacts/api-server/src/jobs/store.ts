/**
 * Persistence for the job framework: leases, run rows, item failures, and
 * the rolled-up health state. The Supabase store rides the migration's RPCs
 * (lease acquisition and run finishing are single statements there so two
 * processes can never both believe they hold a job); the memory store gives
 * unit tests the same contract without a database.
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import type {
  JobCounts,
  JobItemFailureRecord,
  JobRunRecord,
  JobRunStatus,
  JobStateRecord,
  JobTrigger,
} from "./types";

const enc = encodeURIComponent;

export interface JobStore {
  acquireLease(jobName: string, owner: string, leaseSeconds: number): Promise<boolean>;
  /** Extend a lease the owner still holds; false means it lapsed or moved. */
  renewLease(jobName: string, owner: string, leaseSeconds: number): Promise<boolean>;
  releaseLease(jobName: string, owner: string): Promise<void>;
  startRun(input: { jobName: string; trigger: JobTrigger; dryRun: boolean; owner: string }): Promise<JobRunRecord>;
  finishRun(input: {
    runId: string;
    status: Exclude<JobRunStatus, "running">;
    counts: JobCounts;
    failureCount: number;
    error: string | null;
    backoffSeconds: number;
  }): Promise<void>;
  recordItemFailure(input: { runId: string; jobName: string; item: string; error: string }): Promise<void>;
  getState(jobName: string): Promise<JobStateRecord | null>;
  listStates(): Promise<JobStateRecord[]>;
  listRecentRuns(limit: number): Promise<JobRunRecord[]>;
  getRun(runId: string): Promise<JobRunRecord | null>;
  listRecentItemFailures(jobName: string, limit: number): Promise<JobItemFailureRecord[]>;
}

const RUN_SELECT = "id,job_name,trigger,dry_run,status,owner,started_at,finished_at,counts,failure_count,error";
const STATE_SELECT =
  "job_name,lease_owner,lease_until,consecutive_failures,next_eligible_at,last_started_at,last_finished_at," +
  "last_status,last_success_at,last_success_counts,last_failure_at,last_error";

function countsOf(value: unknown): JobCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: JobCounts = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

export function runFromRow(row: Record<string, unknown>): JobRunRecord {
  return {
    id: String(row.id),
    jobName: String(row.job_name),
    trigger: row.trigger as JobTrigger,
    dryRun: row.dry_run === true,
    status: row.status as JobRunStatus,
    owner: typeof row.owner === "string" ? row.owner : null,
    startedAt: String(row.started_at),
    finishedAt: typeof row.finished_at === "string" ? row.finished_at : null,
    counts: countsOf(row.counts),
    failureCount: typeof row.failure_count === "number" ? row.failure_count : Number(row.failure_count ?? 0) || 0,
    error: typeof row.error === "string" ? row.error : null,
  };
}

export function stateFromRow(row: Record<string, unknown>): JobStateRecord {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    jobName: String(row.job_name),
    leaseOwner: str(row.lease_owner),
    leaseUntil: str(row.lease_until),
    consecutiveFailures: Number(row.consecutive_failures ?? 0) || 0,
    nextEligibleAt: str(row.next_eligible_at),
    lastStartedAt: str(row.last_started_at),
    lastFinishedAt: str(row.last_finished_at),
    lastStatus: row.last_status === "succeeded" || row.last_status === "failed" ? row.last_status : null,
    lastSuccessAt: str(row.last_success_at),
    lastSuccessCounts: row.last_success_counts == null ? null : countsOf(row.last_success_counts),
    lastFailureAt: str(row.last_failure_at),
    lastError: str(row.last_error),
  };
}

function fail(what: string, status: number): never {
  throw new Error(`${what} failed (${status})`);
}

export const supabaseJobStore: JobStore = {
  async acquireLease(jobName, owner, leaseSeconds) {
    const r = await supabaseAdmin("POST", "/rest/v1/rpc/acquire_system_job_lease", {
      p_job_name: jobName,
      p_owner: owner,
      p_lease_seconds: leaseSeconds,
    });
    if (r.status >= 300) fail("job lease acquire", r.status);
    return r.json === true;
  },
  async renewLease(jobName, owner, leaseSeconds) {
    const r = await supabaseAdmin("POST", "/rest/v1/rpc/renew_system_job_lease", {
      p_job_name: jobName,
      p_owner: owner,
      p_lease_seconds: leaseSeconds,
    });
    if (r.status >= 300) fail("job lease renew", r.status);
    return r.json === true;
  },
  async releaseLease(jobName, owner) {
    const r = await supabaseAdmin("POST", "/rest/v1/rpc/release_system_job_lease", { p_job_name: jobName, p_owner: owner });
    if (r.status >= 300) fail("job lease release", r.status);
  },
  async startRun(input) {
    const r = await supabaseAdmin(
      "POST",
      `/rest/v1/system_job_runs?select=${RUN_SELECT}`,
      { job_name: input.jobName, trigger: input.trigger, dry_run: input.dryRun, owner: input.owner },
      "return=representation",
    );
    if (r.status >= 300 || !Array.isArray(r.json) || !r.json[0]) fail("job run insert", r.status);
    return runFromRow(r.json[0] as Record<string, unknown>);
  },
  async finishRun(input) {
    const r = await supabaseAdmin("POST", "/rest/v1/rpc/finish_system_job_run", {
      p_run_id: input.runId,
      p_status: input.status,
      p_counts: input.counts,
      p_failure_count: input.failureCount,
      p_error: input.error,
      p_backoff_seconds: input.backoffSeconds,
    });
    if (r.status >= 300) fail("job run finish", r.status);
  },
  async recordItemFailure(input) {
    const r = await supabaseAdmin("POST", "/rest/v1/system_job_item_failures", {
      run_id: input.runId,
      job_name: input.jobName,
      item: input.item.slice(0, 400),
      error: input.error.slice(0, 500) || "unknown error",
    });
    if (r.status >= 300) fail("job item failure insert", r.status);
  },
  async getState(jobName) {
    const r = await supabaseAdmin("GET", `/rest/v1/system_job_leases?job_name=eq.${enc(jobName)}&select=${STATE_SELECT}&limit=1`);
    if (r.status >= 300 || !Array.isArray(r.json)) fail("job state read", r.status);
    return r.json[0] ? stateFromRow(r.json[0] as Record<string, unknown>) : null;
  },
  async listStates() {
    const r = await supabaseAdmin("GET", `/rest/v1/system_job_leases?select=${STATE_SELECT}&order=job_name.asc&limit=200`);
    if (r.status >= 300 || !Array.isArray(r.json)) fail("job states read", r.status);
    return (r.json as Record<string, unknown>[]).map(stateFromRow);
  },
  async listRecentRuns(limit) {
    const r = await supabaseAdmin("GET", `/rest/v1/system_job_runs?select=${RUN_SELECT}&order=started_at.desc&limit=${limit}`);
    if (r.status >= 300 || !Array.isArray(r.json)) fail("job runs read", r.status);
    return (r.json as Record<string, unknown>[]).map(runFromRow);
  },
  async getRun(runId) {
    const r = await supabaseAdmin("GET", `/rest/v1/system_job_runs?id=eq.${enc(runId)}&select=${RUN_SELECT}&limit=1`);
    if (r.status >= 300 || !Array.isArray(r.json)) fail("job run read", r.status);
    return r.json[0] ? runFromRow(r.json[0] as Record<string, unknown>) : null;
  },
  async listRecentItemFailures(jobName, limit) {
    const r = await supabaseAdmin(
      "GET",
      `/rest/v1/system_job_item_failures?job_name=eq.${enc(jobName)}&select=run_id,job_name,item,error,occurred_at&order=occurred_at.desc&limit=${limit}`,
    );
    if (r.status >= 300 || !Array.isArray(r.json)) fail("job item failures read", r.status);
    return (r.json as Record<string, unknown>[]).map((row) => ({
      runId: String(row.run_id),
      jobName: String(row.job_name),
      item: String(row.item),
      error: String(row.error),
      occurredAt: String(row.occurred_at),
    }));
  },
};

/** In-memory store with the same semantics as the SQL (for unit tests). */
export function createMemoryJobStore(clock: () => Date = () => new Date()): JobStore & {
  runs: JobRunRecord[];
  failures: JobItemFailureRecord[];
  states: Map<string, JobStateRecord>;
  /** Clears every run, failure, and state (test isolation). */
  reset(): void;
} {
  const runs: JobRunRecord[] = [];
  const failures: JobItemFailureRecord[] = [];
  const states = new Map<string, JobStateRecord>();
  let seq = 0;
  const blank = (jobName: string): JobStateRecord => ({
    jobName,
    leaseOwner: null,
    leaseUntil: null,
    consecutiveFailures: 0,
    nextEligibleAt: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastStatus: null,
    lastSuccessAt: null,
    lastSuccessCounts: null,
    lastFailureAt: null,
    lastError: null,
  });
  const stateOf = (jobName: string) => {
    const existing = states.get(jobName);
    if (existing) return existing;
    const fresh = blank(jobName);
    states.set(jobName, fresh);
    return fresh;
  };
  return {
    runs,
    failures,
    states,
    reset() {
      runs.length = 0;
      failures.length = 0;
      states.clear();
    },
    async acquireLease(jobName, owner, leaseSeconds) {
      const now = clock();
      const state = stateOf(jobName);
      const live = state.leaseUntil !== null && new Date(state.leaseUntil).getTime() >= now.getTime();
      if (live && state.leaseOwner !== owner) return false;
      state.leaseOwner = owner;
      state.leaseUntil = new Date(now.getTime() + Math.max(leaseSeconds, 5) * 1000).toISOString();
      state.lastStartedAt = now.toISOString();
      return true;
    },
    async renewLease(jobName, owner, leaseSeconds) {
      const now = clock();
      const state = stateOf(jobName);
      const live = state.leaseUntil !== null && new Date(state.leaseUntil).getTime() >= now.getTime();
      if (!live || state.leaseOwner !== owner) return false;
      state.leaseUntil = new Date(now.getTime() + Math.max(leaseSeconds, 5) * 1000).toISOString();
      return true;
    },
    async releaseLease(jobName, owner) {
      const state = stateOf(jobName);
      if (state.leaseOwner === owner) {
        state.leaseOwner = null;
        state.leaseUntil = null;
      }
    },
    async startRun(input) {
      seq += 1;
      const run: JobRunRecord = {
        id: `run-${seq}`,
        jobName: input.jobName,
        trigger: input.trigger,
        dryRun: input.dryRun,
        status: "running",
        owner: input.owner,
        startedAt: clock().toISOString(),
        finishedAt: null,
        counts: {},
        failureCount: 0,
        error: null,
      };
      runs.push(run);
      return { ...run };
    },
    async finishRun(input) {
      const run = runs.find((r) => r.id === input.runId);
      if (!run) throw new Error(`unknown job run ${input.runId}`);
      const now = clock();
      run.status = input.status;
      run.finishedAt = now.toISOString();
      run.counts = { ...input.counts };
      run.failureCount = input.failureCount;
      run.error = input.error;
      const state = stateOf(run.jobName);
      if (run.dryRun) {
        if (state.leaseOwner === run.owner) {
          state.leaseOwner = null;
          state.leaseUntil = null;
        }
        return;
      }
      state.lastFinishedAt = now.toISOString();
      state.lastStatus = input.status;
      if (input.status === "succeeded") {
        state.consecutiveFailures = 0;
        state.nextEligibleAt = null;
        state.lastSuccessAt = now.toISOString();
        state.lastSuccessCounts = { ...input.counts };
      } else {
        const backoff = Math.min(Math.max(input.backoffSeconds, 1) * 2 ** Math.min(state.consecutiveFailures, 12), 21_600);
        state.consecutiveFailures += 1;
        state.nextEligibleAt = new Date(now.getTime() + backoff * 1000).toISOString();
        state.lastFailureAt = now.toISOString();
        state.lastError = input.error;
      }
      if (state.leaseOwner === run.owner) {
        state.leaseOwner = null;
        state.leaseUntil = null;
      }
    },
    async recordItemFailure(input) {
      failures.push({ ...input, occurredAt: clock().toISOString() });
    },
    async getState(jobName) {
      const s = states.get(jobName);
      return s ? { ...s } : null;
    },
    async listStates() {
      return [...states.values()].map((s) => ({ ...s })).sort((a, b) => a.jobName.localeCompare(b.jobName));
    },
    async listRecentRuns(limit) {
      return [...runs].reverse().slice(0, limit).map((r) => ({ ...r }));
    },
    async getRun(runId) {
      const r = runs.find((x) => x.id === runId);
      return r ? { ...r } : null;
    },
    async listRecentItemFailures(jobName, limit) {
      return failures.filter((f) => f.jobName === jobName).reverse().slice(0, limit);
    },
  };
}
