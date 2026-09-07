import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  audit: vi.fn(),
  registerAllJobs: vi.fn(),
}));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: mocks.audit, requestIdOf: () => null }));
vi.mock("../lib/staff-auth", () => ({
  requireHqPermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (permission !== "settings_manage") return res.status(500).json({ error: `unexpected permission ${permission}` });
    if (req.headers.authorization !== "Bearer admin") return res.status(403).json({ error: "denied" });
    res.locals.staff = { userId: "hq-1", role: "hq", departmentRole: "admin" };
    return next();
  },
}));
// The router registers the real job catalogue on construction; tests register their own.
vi.mock("../jobs", () => ({ registerAllJobs: mocks.registerAllJobs }));

import { registerJob, resetJobRegistry } from "../jobs/scheduler";
import { createMemoryJobStore } from "../jobs/store";
import type { JobDefinition } from "../jobs/types";
import { createSystemJobsRouter, describeInterval, jobHealthStatus, type JobHealthDto } from "./system-jobs";

let clock = new Date("2026-09-07T12:00:00Z");
const store = createMemoryJobStore(() => clock);
let server: http.Server;
let base = "";

function def(overrides: Partial<JobDefinition> & { name: string; run: JobDefinition["run"] }): JobDefinition {
  return { title: overrides.name, description: `${overrides.name} description`, intervalMs: 3_600_000, leaseSeconds: 60, ...overrides };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createSystemJobsRouter(store, { manualWaitMs: 150 }));
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  clock = new Date("2026-09-07T12:00:00Z");
  store.reset();
  resetJobRegistry();
  mocks.audit.mockReset().mockResolvedValue(undefined);
  delete process.env.NOTIFICATIONS_INTERNAL_TOKEN;
});
afterEach(() => resetJobRegistry());

const admin = { authorization: "Bearer admin", "content-type": "application/json" };

describe("job health classification", () => {
  const hourly = def({ name: "h", run: async () => undefined });
  it("maps state to the six panel states", () => {
    const now = clock;
    expect(jobHealthStatus(hourly, null, now)).toBe("never_ran");
    expect(jobHealthStatus({ ...hourly, intervalMs: null }, null, now)).toBe("on_demand");
    const base = { jobName: "h", leaseOwner: null, leaseUntil: null, lastStartedAt: null, lastFinishedAt: null, lastStatus: null, lastSuccessAt: null, lastSuccessCounts: null, lastFailureAt: null, lastError: null, consecutiveFailures: 0, nextEligibleAt: null };
    expect(jobHealthStatus(hourly, { ...base, lastStatus: "succeeded", lastSuccessAt: new Date(now.getTime() - 3 * 3_600_000).toISOString() }, now)).toBe("ok");
    expect(jobHealthStatus(hourly, { ...base, lastStatus: "succeeded", lastSuccessAt: new Date(now.getTime() - 3 * 3_600_000 - 1).toISOString() }, now)).toBe("stale");
    expect(jobHealthStatus(hourly, { ...base, lastStatus: "failed", consecutiveFailures: 2, lastSuccessAt: now.toISOString() }, now)).toBe("failing");
    expect(jobHealthStatus(hourly, { ...base, leaseOwner: "x", leaseUntil: new Date(now.getTime() + 10_000).toISOString(), consecutiveFailures: 3 }, now)).toBe("running");
    expect(jobHealthStatus({ ...hourly, intervalMs: null }, { ...base, lastStatus: "failed" }, now)).toBe("failing");
  });
  it("describes schedules in plain words", () => {
    expect(describeInterval(null)).toBe("On demand");
    expect(describeInterval(15 * 60_000)).toBe("Every 15 minutes");
    expect(describeInterval(3_600_000)).toBe("Every hour");
    expect(describeInterval(6 * 3_600_000)).toBe("Every 6 hours");
    expect(describeInterval(86_400_000)).toBe("Every day");
  });
});

describe("GET /hq/system-health", () => {
  it("needs settings_manage", async () => {
    expect((await fetch(`${base}/hq/system-health`)).status).toBe(403);
  });

  it("lists every registered job with last success, last failure, counts, and recent item failures", async () => {
    registerJob(def({ name: "ok-job", run: async (ctx) => { ctx.tally("deleted", 4); } }));
    registerJob(def({ name: "bad-job", run: async (ctx) => { ctx.failItem("/objects/x", new Error("nope")); } }));
    registerJob(def({ name: "idle-job", intervalMs: null, run: async () => undefined }));
    const { runJob } = await import("../jobs/scheduler");
    await runJob("ok-job", { trigger: "schedule", store, now: clock });
    await runJob("bad-job", { trigger: "schedule", store, now: clock });
    clock = new Date(clock.getTime() + 60_000);
    const res = await fetch(`${base}/hq/system-health`, { headers: admin });
    expect(res.status).toBe(200);
    const body = await res.json() as { asOf: string; jobs: JobHealthDto[]; recentRuns: Array<{ jobName: string; status: string }> };
    const byName = Object.fromEntries(body.jobs.map((j) => [j.name, j]));
    expect(byName["ok-job"]).toMatchObject({ status: "ok", lastStatus: "succeeded", lastSuccessCounts: { deleted: 4 }, consecutiveFailures: 0, recentFailures: [], schedule: "Every hour" });
    expect(byName["bad-job"]).toMatchObject({ status: "failing", lastStatus: "failed", lastError: "1 item failed", consecutiveFailures: 1 });
    expect(byName["bad-job"].recentFailures).toEqual([{ item: "/objects/x", error: "nope", occurredAt: expect.any(String) }]);
    expect(byName["bad-job"].nextEligibleAt).not.toBeNull();
    expect(byName["idle-job"]).toMatchObject({ status: "on_demand", schedule: "On demand", lastSuccessAt: null });
    expect(body.recentRuns.map((r) => [r.jobName, r.status])).toEqual([["bad-job", "failed"], ["ok-job", "succeeded"]]);
  });

  it("answers 502 (never a healthy-looking empty list) when the ledger is unreadable", async () => {
    const broken = createMemoryJobStore(() => clock);
    broken.listStates = async () => { throw new Error("pg down"); };
    const app = express();
    app.use(createSystemJobsRouter(broken));
    const s = await new Promise<http.Server>((r) => { const inst = app.listen(0, () => r(inst)); });
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/hq/system-health`, { headers: admin });
      expect(res.status).toBe(502);
    } finally {
      s.close();
    }
  });
});

describe("POST /hq/system-health/jobs/:name/run", () => {
  it("runs a job now, records a manual run, and audits it", async () => {
    registerJob(def({ name: "sweep", run: async (ctx) => { ctx.tally("deleted", 2); } }));
    const res = await fetch(`${base}/hq/system-health/jobs/sweep/run`, { method: "POST", headers: admin, body: "{}" });
    expect(res.status).toBe(200);
    const body = await res.json() as { run: { trigger: string; status: string; counts: Record<string, number>; dryRun: boolean } };
    expect(body.run).toMatchObject({ trigger: "manual", status: "succeeded", counts: { deleted: 2 }, dryRun: false });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "system_job.run", actorUserId: "hq-1", targetKind: "system_job", targetId: "sweep", metadata: { outcome: "ran" } }));
  });

  it("honours dryRun and bypasses a failure backoff", async () => {
    registerJob(def({ name: "flaky", run: async (ctx) => { if (!ctx.dryRun) throw new Error("boom"); ctx.tally("wouldDelete", 1); } }));
    const first = await fetch(`${base}/hq/system-health/jobs/flaky/run`, { method: "POST", headers: admin, body: "{}" });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { run: { status: string } }).run.status).toBe("failed");
    const dry = await fetch(`${base}/hq/system-health/jobs/flaky/run`, { method: "POST", headers: admin, body: JSON.stringify({ dryRun: true }) });
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as { run: { status: string; dryRun: boolean; counts: Record<string, number> } }).run).toMatchObject({ status: "succeeded", dryRun: true, counts: { wouldDelete: 1 } });
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "system_job.dry_run" }));
  });

  it("answers 409 while the lease is held elsewhere, 404 for unknown jobs, and 409 for the patient-only job", async () => {
    registerJob(def({ name: "held", run: async () => undefined }));
    registerJob(def({ name: "patient-media-cleanup", intervalMs: null, run: async () => undefined }));
    await store.acquireLease("held", "other-instance", 60);
    expect((await fetch(`${base}/hq/system-health/jobs/held/run`, { method: "POST", headers: admin, body: "{}" })).status).toBe(409);
    expect((await fetch(`${base}/hq/system-health/jobs/nope/run`, { method: "POST", headers: admin, body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/hq/system-health/jobs/patient-media-cleanup/run`, { method: "POST", headers: admin, body: "{}" })).status).toBe(409);
    expect((await fetch(`${base}/hq/system-health/jobs/held/run`, { method: "POST", body: "{}" })).status).toBe(403);
  });

  it("answers 202 when the run outlasts the wait and the run stays pollable", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    registerJob(def({ name: "slow", run: async () => { await gate; } }));
    const res = await fetch(`${base}/hq/system-health/jobs/slow/run`, { method: "POST", headers: admin, body: "{}" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "running" });
    const health = await (await fetch(`${base}/hq/system-health`, { headers: admin })).json() as { jobs: JobHealthDto[] };
    expect(health.jobs.find((j) => j.name === "slow")).toMatchObject({ status: "running", running: true });
    release();
    await vi.waitFor(async () => {
      const state = await store.getState("slow");
      expect(state?.lastStatus).toBe("succeeded");
    });
    const runId = store.runs[0].id;
    const runRes = await fetch(`${base}/hq/system-health/runs/${runId}`, { headers: admin });
    expect(runRes.status).toBe(200);
    expect(((await runRes.json()) as { run: { status: string } }).run.status).toBe("succeeded");
    expect((await fetch(`${base}/hq/system-health/runs/missing`, { headers: admin })).status).toBe(404);
  });
});

describe("POST /internal/jobs/tick", () => {
  it("is invisible without a configured token and refuses wrong tokens in constant time", async () => {
    expect((await fetch(`${base}/internal/jobs/tick`, { method: "POST" })).status).toBe(404);
    process.env.NOTIFICATIONS_INTERNAL_TOKEN = "secret-token";
    expect((await fetch(`${base}/internal/jobs/tick`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers: { authorization: "Bearer wrong-token1" } })).status).toBe(401);
  });

  it("runs every due job on a bare tick and one forced job when named", async () => {
    process.env.NOTIFICATIONS_INTERNAL_TOKEN = "secret-token";
    const headers = { authorization: "Bearer secret-token", "content-type": "application/json" };
    const ran: string[] = [];
    registerJob(def({ name: "due", run: async () => { ran.push("due"); } }));
    registerJob(def({ name: "on-demand", intervalMs: null, run: async () => { ran.push("on-demand"); } }));
    const tick = await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers, body: "{}" });
    expect(tick.status).toBe(200);
    expect(((await tick.json()) as { results: Array<{ name: string }> }).results.map((r) => r.name)).toEqual(["due"]);
    expect(ran).toEqual(["due"]);
    const named = await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers, body: JSON.stringify({ job: "on-demand", dryRun: true }) });
    expect(named.status).toBe(200);
    expect(ran).toEqual(["due", "on-demand"]);
    expect(store.runs.at(-1)).toMatchObject({ jobName: "on-demand", trigger: "internal", dryRun: true });
    expect((await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers, body: JSON.stringify({ job: "ghost" }) })).status).toBe(404);
  });
});
