import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: vi.fn() }));

import { isJobDue, registerJob, resetJobRegistry, runDueJobs, runJob, runUserJob, signalJob } from "./scheduler";
import { createMemoryJobStore } from "./store";
import type { JobContext, JobDefinition } from "./types";

function job(overrides: Partial<JobDefinition> & { run: JobDefinition["run"] }): JobDefinition {
  return {
    name: "demo",
    title: "Demo",
    description: "Demo job",
    intervalMs: 60_000,
    leaseSeconds: 60,
    ...overrides,
  };
}

describe("job scheduler", () => {
  let clock = new Date("2026-09-07T10:00:00Z");
  const now = () => clock;
  let store: ReturnType<typeof createMemoryJobStore>;

  beforeEach(() => {
    clock = new Date("2026-09-07T10:00:00Z");
    store = createMemoryJobStore(now);
    resetJobRegistry();
  });
  afterEach(() => resetJobRegistry());

  it("records a successful run with counts and resets failure state", async () => {
    registerJob(job({ run: async (ctx) => { ctx.tally("deleted", 3); ctx.tally("scanned"); } }));
    const outcome = await runJob("demo", { trigger: "schedule", store, now: clock, owner: "o1" });
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.run).toMatchObject({ status: "succeeded", counts: { deleted: 3, scanned: 1 }, failureCount: 0, error: null, trigger: "schedule", dryRun: false });
    const state = await store.getState("demo");
    expect(state).toMatchObject({ lastStatus: "succeeded", consecutiveFailures: 0, leaseOwner: null, lastSuccessCounts: { deleted: 3, scanned: 1 } });
  });

  it("refuses to run while another owner holds the lease, and runs once it lapses", async () => {
    registerJob(job({ run: async () => undefined, leaseSeconds: 120 }));
    expect(await store.acquireLease("demo", "rival", 120)).toBe(true);
    expect(await runJob("demo", { trigger: "schedule", store, now: clock, owner: "me" })).toEqual({ kind: "lease_held" });
    expect(store.runs).toHaveLength(0);
    clock = new Date(clock.getTime() + 121_000);
    const outcome = await runJob("demo", { trigger: "schedule", store, now: clock, owner: "me" });
    expect(outcome.kind).toBe("ran");
  });

  it("marks a thrown run failed, backs off exponentially, and lets force/manual runs bypass the backoff", async () => {
    registerJob(job({ run: async () => { throw new Error("storage down"); } }));
    const first = await runJob("demo", { trigger: "schedule", store, now: clock });
    expect(first.kind === "ran" && first.run.status).toBe("failed");
    expect(first.kind === "ran" && first.run.error).toBe("storage down");
    let state = await store.getState("demo");
    expect(state?.consecutiveFailures).toBe(1);
    expect(new Date(state!.nextEligibleAt!).getTime() - clock.getTime()).toBe(300_000);
    // Scheduled attempts inside the backoff window are skipped without touching the ledger.
    clock = new Date(clock.getTime() + 60_000);
    expect((await runJob("demo", { trigger: "schedule", store, now: clock })).kind).toBe("backing_off");
    expect(store.runs).toHaveLength(1);
    // Manual runs are forced and still count toward the failure streak.
    const manual = await runJob("demo", { trigger: "manual", store, now: clock, force: true });
    expect(manual.kind).toBe("ran");
    state = await store.getState("demo");
    expect(state?.consecutiveFailures).toBe(2);
    expect(new Date(state!.nextEligibleAt!).getTime() - clock.getTime()).toBe(600_000);
  });

  it("counts item failures, records them, and fails the run without aborting the remaining items", async () => {
    const handled: string[] = [];
    registerJob(job({
      run: async (ctx) => {
        for (const item of ["a", "b", "c"]) {
          if (item === "b") ctx.failItem(item, new Error("refused"));
          else { handled.push(item); ctx.tally("ok"); }
        }
      },
    }));
    const outcome = await runJob("demo", { trigger: "schedule", store, now: clock });
    expect(handled).toEqual(["a", "c"]);
    expect(outcome.kind === "ran" && outcome.run).toMatchObject({ status: "failed", failureCount: 1, error: "1 item failed", counts: { ok: 2 } });
    expect(store.failures).toEqual([expect.objectContaining({ jobName: "demo", item: "b", error: "refused" })]);
    expect((await store.getState("demo"))?.lastError).toBe("1 item failed");
  });

  it("records report-local failures without putting healthy queue work into global backoff", async () => {
    registerJob(job({
      run: async (ctx) => {
        ctx.failItem("report-a", "PROCESSING_TIMEOUT", { reportLocal: true });
        ctx.tally("healthyReports");
      },
    }));

    const outcome = await runJob("demo", { trigger: "schedule", store, now: clock });
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.run).toMatchObject({
      status: "succeeded",
      failureCount: 0,
      error: null,
      counts: { healthyReports: 1, reportLocalFailures: 1 },
    });
    expect(await store.getState("demo")).toMatchObject({
      lastStatus: "succeeded",
      consecutiveFailures: 0,
      nextEligibleAt: null,
      lastSuccessCounts: { healthyReports: 1, reportLocalFailures: 1 },
    });
    expect(store.failures).toEqual([
      expect.objectContaining({ item: "report-a", error: "PROCESSING_TIMEOUT" }),
    ]);
  });

  it("dry runs are recorded but never move the health state", async () => {
    let sawDry = false;
    registerJob(job({ run: async (ctx: JobContext) => { sawDry = ctx.dryRun; ctx.tally("wouldDelete", 5); } }));
    const outcome = await runJob("demo", { trigger: "manual", store, now: clock, dryRun: true, force: true });
    expect(sawDry).toBe(true);
    expect(outcome.kind === "ran" && outcome.run).toMatchObject({ dryRun: true, status: "succeeded", counts: { wouldDelete: 5 } });
    const state = await store.getState("demo");
    expect(state?.lastSuccessAt).toBeNull();
    expect(state?.lastStatus).toBeNull();
    expect(state?.leaseOwner).toBeNull();
  });

  it("answers unknown_job for unregistered names", async () => {
    expect(await runJob("nope", { trigger: "manual", store })).toEqual({ kind: "unknown_job" });
  });

  describe("isJobDue", () => {
    const def = job({ run: async () => undefined, intervalMs: 3_600_000 });
    it("never schedules on-demand jobs", () => {
      expect(isJobDue({ ...def, intervalMs: null }, null, clock)).toBe(false);
    });
    it("is due when it never ran, after one interval, or once a failure backoff expires", () => {
      expect(isJobDue(def, null, clock)).toBe(true);
      const started = new Date(clock.getTime() - 3_599_000).toISOString();
      expect(isJobDue(def, { lastStartedAt: started, lastStatus: "succeeded", nextEligibleAt: null }, clock)).toBe(false);
      const old = new Date(clock.getTime() - 3_600_000).toISOString();
      expect(isJobDue(def, { lastStartedAt: old, lastStatus: "succeeded", nextEligibleAt: null }, clock)).toBe(true);
      const soon = new Date(clock.getTime() + 1_000).toISOString();
      expect(isJobDue(def, { lastStartedAt: started, lastStatus: "failed", nextEligibleAt: soon }, clock)).toBe(false);
      const past = new Date(clock.getTime() - 1_000).toISOString();
      expect(isJobDue(def, { lastStartedAt: started, lastStatus: "failed", nextEligibleAt: past }, clock)).toBe(true);
    });
  });

  it("runDueJobs runs only scheduled jobs that are due, in name order", async () => {
    const ran: string[] = [];
    registerJob(job({ name: "b-hourly", intervalMs: 3_600_000, run: async () => { ran.push("b-hourly"); } }));
    registerJob(job({ name: "a-daily", intervalMs: 86_400_000, run: async () => { ran.push("a-daily"); } }));
    registerJob(job({ name: "c-on-demand", intervalMs: null, run: async () => { ran.push("c-on-demand"); } }));
    const first = await runDueJobs({ trigger: "schedule", store, now: clock });
    expect(first.map((r) => r.name)).toEqual(["a-daily", "b-hourly"]);
    expect(ran).toEqual(["a-daily", "b-hourly"]);
    clock = new Date(clock.getTime() + 3_600_000);
    const second = await runDueJobs({ trigger: "internal", store, now: clock });
    expect(second.map((r) => r.name)).toEqual(["b-hourly"]);
  });

  it("runUserJob logs request-scoped work as a user run and rethrows its error", async () => {
    const result = await runUserJob("patient-media-cleanup", async (ctx) => { ctx.tally("rowsRemoved", 2); return ["x", "y"]; }, { store, now: clock });
    expect(result).toEqual(["x", "y"]);
    expect(store.runs[0]).toMatchObject({ jobName: "patient-media-cleanup", trigger: "user", status: "succeeded", counts: { rowsRemoved: 2 } });
    await expect(runUserJob("patient-media-cleanup", async () => { throw new Error("rpc 500"); }, { store, now: clock })).rejects.toThrow("rpc 500");
    expect(store.runs[1]).toMatchObject({ status: "failed", error: "rpc 500" });
  });

  it("keeps renewing the lease while a job runs past its original lease length, so no rival can take it", async () => {
    // The memory store reads the test clock; the heartbeat runs on fake timers.
    vi.useFakeTimers();
    try {
      const rivalAttempts: boolean[] = [];
      let renewals = 0;
      const realRenew = store.renewLease.bind(store);
      store.renewLease = async (name, owner, secs) => {
        renewals += 1;
        return realRenew(name, owner, secs);
      };
      registerJob(
        job({
          leaseSeconds: 10,
          run: async (ctx) => {
            // 30 s of work against a 10 s lease: every step advances the clock 2 s,
            // fires any due heartbeat, then a rival tries to grab the lease.
            for (let step = 0; step < 15; step += 1) {
              ctx.checkpoint();
              clock = new Date(clock.getTime() + 2000);
              await vi.advanceTimersByTimeAsync(2000);
              rivalAttempts.push(await store.acquireLease("demo", "rival", 10));
            }
          },
        }),
      );
      const outcome = await runJob("demo", { trigger: "schedule", store, now: clock, owner: "me", renewIntervalMs: 3000 });
      expect(outcome.kind).toBe("ran");
      if (outcome.kind !== "ran") return;
      expect(outcome.run.status).toBe("succeeded");
      expect(renewals).toBeGreaterThanOrEqual(8);
      expect(rivalAttempts.every((held) => held === false)).toBe(true);
      // Once the run closed the lease is free again.
      expect(await store.acquireLease("demo", "rival", 10)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a job at its next checkpoint once the lease is lost and records the run as failed", async () => {
    vi.useFakeTimers();
    try {
      let steps = 0;
      registerJob(
        job({
          leaseSeconds: 10,
          run: async (ctx) => {
            for (let step = 0; step < 100; step += 1) {
              ctx.checkpoint();
              steps += 1;
              if (step === 2) {
                // Simulate the lease lapsing and moving to another process.
                clock = new Date(clock.getTime() + 60_000);
                expect(await store.acquireLease("demo", "rival", 10)).toBe(true);
              }
              await vi.advanceTimersByTimeAsync(1000);
            }
          },
        }),
      );
      const outcome = await runJob("demo", { trigger: "schedule", store, now: clock, owner: "me", renewIntervalMs: 1000 });
      expect(outcome.kind).toBe("ran");
      if (outcome.kind !== "ran") return;
      expect(outcome.run.status).toBe("failed");
      expect(outcome.run.error).toMatch(/lease for demo was lost/);
      expect(steps).toBeLessThan(6);
      // The rival still owns the lease: finishing a lost run never clears someone else's lease.
      expect((await store.getState("demo"))?.leaseOwner).toBe("rival");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a run that finished on its own after silently losing its lease", async () => {
    const lossy = { ...store, renewLease: async () => false };
    registerJob(job({ leaseSeconds: 10, run: async () => { await new Promise((r) => setTimeout(r, 30)); } }));
    const outcome = await runJob("demo", { trigger: "schedule", store: lossy, now: clock, owner: "me", renewIntervalMs: 5 });
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.error).toMatch(/lease for demo was lost/);
  });

  it("coalesces a prompt during a run and starts it only after the global lease releases", async () => {
    let releaseFirst: (() => void) | undefined;
    let starts = 0;
    registerJob(job({
      run: async () => {
        starts += 1;
        if (starts === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      },
    }));
    const first = runJob("demo", { trigger: "schedule", store, now: clock, owner: "first" });
    await vi.waitFor(() => expect(store.runs).toHaveLength(1));
    expect(signalJob("demo")).toBe(true);
    expect(store.runs).toHaveLength(1);
    releaseFirst!();
    await first;
    await vi.waitFor(() => expect(store.runs).toHaveLength(2));
    await vi.waitFor(() => expect(store.runs[1]).toMatchObject({ trigger: "internal", status: "succeeded" }));
  });

  it("leaves a prompted job durable but does not run it while disabled or backing off", async () => {
    registerJob(job({ run: async () => { throw new Error("temporarily unavailable"); } }));
    await runJob("demo", { trigger: "schedule", store, now: clock });
    expect(signalJob("demo")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.runs).toHaveLength(1);
    const prior = process.env.JOBS_DISABLED;
    process.env.JOBS_DISABLED = "true";
    try {
      expect(signalJob("demo")).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.JOBS_DISABLED;
      else process.env.JOBS_DISABLED = prior;
    }
  });
});
