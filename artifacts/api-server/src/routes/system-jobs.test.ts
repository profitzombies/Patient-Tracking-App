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

import { createMemoryExternalTickStore, type ExternalTriggerHealth } from "../jobs/external-ticks";
import { registerJob, resetJobRegistry } from "../jobs/scheduler";
import { createMemoryJobStore } from "../jobs/store";
import type { JobDefinition } from "../jobs/types";
import type { WorkerDrains } from "../jobs/worker-drains";
import { createSystemJobsRouter, describeInterval, jobHealthStatus, type JobHealthDto } from "./system-jobs";
import type { PerformanceDto } from "../system/performance";
import type { ColdArchiveHealth } from "../lib/cold-archive";
import type { EmailWebhookHealth } from "../email/vendor-webhook";
import { thresholdConfig } from "../system/thresholds";

let clock = new Date("2026-09-07T12:00:00Z");
const store = createMemoryJobStore(() => clock);
const tickStore = createMemoryExternalTickStore();
const drainCalls: string[] = [];
const drainReturns: Record<keyof WorkerDrains, () => Promise<number>> = {
  officeExports: async () => 0,
  patientExports: async () => 0,
  purges: async () => 0,
};
const drains: WorkerDrains = {
  officeExports: () => { drainCalls.push("officeExports"); return drainReturns.officeExports(); },
  patientExports: () => { drainCalls.push("patientExports"); return drainReturns.patientExports(); },
  purges: () => { drainCalls.push("purges"); return drainReturns.purges(); },
};
let outbox: (now: Date) => Promise<{ due: number; oldestDueAt: string | null; inFlight: number }> = async () => ({
  due: 0,
  oldestDueAt: null,
  inFlight: 0,
});
let server: http.Server;
let base = "";
const coldArchiveIdle: ColdArchiveHealth = { enabled: false, storageConfigured: false, earliestDay: null, lastArchivedDay: null, lastArchivedAt: null, daysArchived: 0, daysPending: 0, rowsArchived: 0, bytesWritten: 0 };
let coldArchive: (now: Date) => Promise<ColdArchiveHealth> = async () => coldArchiveIdle;
const emailWebhookIdle: EmailWebhookHealth = { vendor: "resend", configured: false, last_event_at: null, last_event_type: null, events_24h: 0, unmatched_count: 0, oldest_unmatched_at: null, last_rejected_at: null, rejected_today: 0, rejected_total: 0, last_email_sent_at: null };
let emailWebhook: (now: Date) => Promise<EmailWebhookHealth> = async () => emailWebhookIdle;
let performance: (now: Date) => Promise<PerformanceDto> = async (now) => ({
  asOf: now.toISOString(), latency: null, slowStatements: null, growth: null,
  thresholds: { level: "ok", config: thresholdConfig(), findings: [] },
});

function def(overrides: Partial<JobDefinition> & { name: string; run: JobDefinition["run"] }): JobDefinition {
  return { title: overrides.name, description: `${overrides.name} description`, intervalMs: 3_600_000, leaseSeconds: 60, ...overrides };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createSystemJobsRouter(store, { manualWaitMs: 150, tickStore, drains, outboxBacklog: (now) => outbox(now), readPerformance: (now) => performance(now), coldArchiveHealth: (now) => coldArchive(now), emailWebhookHealth: (now) => emailWebhook(now) }));
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  clock = new Date("2026-09-07T12:00:00Z");
  // Keep HTTP timers real, but align the router's date with the test ledger.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
  store.reset();
  tickStore.reset();
  drainCalls.length = 0;
  drainReturns.officeExports = async () => 0;
  drainReturns.patientExports = async () => 0;
  drainReturns.purges = async () => 0;
  resetJobRegistry();
  outbox = async () => ({ due: 0, oldestDueAt: null, inFlight: 0 });
  coldArchive = async () => coldArchiveIdle;
  emailWebhook = async () => emailWebhookIdle;
  mocks.audit.mockReset().mockResolvedValue(undefined);
  // No ledger by default: the sign-in metric degrades to null.
  mocks.admin.mockReset().mockResolvedValue({ status: 503, json: null });
  delete process.env.NOTIFICATIONS_INTERNAL_TOKEN;
  delete process.env.JOBS_DISABLED;
  delete process.env.NOTIFICATIONS_DISABLED;
});
afterEach(() => {
  resetJobRegistry();
  vi.useRealTimers();
});

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

  it("reports the push outbox backlog with the oldest due age, and null (not zeros) when the outbox is unreadable", async () => {
    outbox = async (now) => ({ due: 4_200, oldestDueAt: new Date(now.getTime() - 90_000).toISOString(), inFlight: 200 });
    const res = await fetch(`${base}/hq/system-health`, { headers: admin });
    expect(res.status).toBe(200);
    const body = await res.json() as { outbox: { due: number; oldestDueAt: string; oldestDueAgeMs: number; inFlight: number } | null };
    expect(body.outbox).toMatchObject({ due: 4_200, inFlight: 200, oldestDueAgeMs: 90_000 });
    expect(body.outbox?.oldestDueAt).toBe(new Date(clock.getTime() - 90_000).toISOString());

    outbox = async () => ({ due: 0, oldestDueAt: null, inFlight: 0 });
    const idle = await (await fetch(`${base}/hq/system-health`, { headers: admin })).json() as { outbox: { oldestDueAgeMs: number | null } };
    expect(idle.outbox).toEqual({ due: 0, oldestDueAt: null, oldestDueAgeMs: null, inFlight: 0 });

    outbox = async () => { throw new Error("pg down"); };
    const broken = await fetch(`${base}/hq/system-health`, { headers: admin });
    expect(broken.status).toBe(200);
    expect((await broken.json() as { outbox: unknown }).outbox).toBeNull();
  });

  it("reports the cold archive backlog, last archived day, and bytes written, and null (not a caught-up archive) when the ledger is unreadable", async () => {
    coldArchive = async () => ({ enabled: true, storageConfigured: true, earliestDay: "2026-08-01", lastArchivedDay: "2026-09-05", lastArchivedAt: "2026-09-06T02:00:00.000Z", daysArchived: 36, daysPending: 1, rowsArchived: 90_210, bytesWritten: 7_340_032 });
    const res = await fetch(`${base}/hq/system-health`, { headers: admin });
    expect(res.status).toBe(200);
    const body = await res.json() as { coldArchive: ColdArchiveHealth | null };
    expect(body.coldArchive).toEqual({ enabled: true, storageConfigured: true, earliestDay: "2026-08-01", lastArchivedDay: "2026-09-05", lastArchivedAt: "2026-09-06T02:00:00.000Z", daysArchived: 36, daysPending: 1, rowsArchived: 90_210, bytesWritten: 7_340_032 });

    coldArchive = async () => { throw new Error("pg down"); };
    const broken = await fetch(`${base}/hq/system-health`, { headers: admin });
    expect(broken.status).toBe(200);
    const degraded = await broken.json() as { coldArchive: unknown; jobs: unknown[] };
    expect(degraded.coldArchive).toBeNull();
    expect(Array.isArray(degraded.jobs)).toBe(true);
  });

  it("reports email delivery tracking health (last event, unmatched backlog, refused deliveries) and null when unreadable", async () => {
    const live: EmailWebhookHealth = { vendor: "resend", configured: true, last_event_at: "2026-09-23T14:30:00.000Z", last_event_type: "opened", events_24h: 42, unmatched_count: 2, oldest_unmatched_at: "2026-09-23T10:00:00.000Z", last_rejected_at: null, rejected_today: 0, rejected_total: 3, last_email_sent_at: "2026-09-23T14:20:00.000Z" };
    emailWebhook = async () => live;
    const res = await fetch(`${base}/hq/system-health`, { headers: admin });
    expect(res.status).toBe(200);
    expect((await res.json() as { emailWebhook: EmailWebhookHealth | null }).emailWebhook).toEqual(live);
    emailWebhook = async () => { throw new Error("pg down"); };
    const broken = await fetch(`${base}/hq/system-health`, { headers: admin });
    expect(broken.status).toBe(200);
    expect((await broken.json() as { emailWebhook: unknown }).emailWebhook).toBeNull();
  });

  it("carries text-message login codes per active patient per month, newest first", async () => {
    mocks.admin.mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/rest/v1/rpc/hq_patient_sign_in_metrics") {
        expect(body).toEqual({ p_months: 6 });
        return { status: 200, json: [
          { month: "2026-09-01", sms_sign_ins: 30, patients_with_sms_sign_in: 12, new_device_sms_sign_ins: 9, signups: 4, active_patients: 120 },
          { month: "2026-08-01", sms_sign_ins: 3, patients_with_sms_sign_in: 3, new_device_sms_sign_ins: 0, signups: 0, active_patients: 0 },
        ] };
      }
      return { status: 500, json: null };
    });
    const res = await fetch(`${base}/hq/system-health`, { headers: admin });
    expect(res.status).toBe(200);
    const body = await res.json() as { patientSignIns: unknown };
    expect(body.patientSignIns).toEqual([
      { month: "2026-09-01", smsSignIns: 30, patientsWithSmsSignIn: 12, newDeviceSmsSignIns: 9, signups: 4, activePatients: 120, smsPerActivePatient: 0.25 },
      { month: "2026-08-01", smsSignIns: 3, patientsWithSmsSignIn: 3, newDeviceSmsSignIns: 0, signups: 0, activePatients: 0, smsPerActivePatient: null },
    ]);
  });

  it("reports the sign-in metric as unavailable (null) when the ledger read fails, without hiding job health", async () => {
    mocks.admin.mockResolvedValue({ status: 500, json: null });
    registerJob(def({ name: "ok-job", run: async () => undefined }));
    const res = await fetch(`${base}/hq/system-health`, { headers: admin });
    expect(res.status).toBe(200);
    const body = await res.json() as { patientSignIns: unknown; jobs: JobHealthDto[] };
    expect(body.patientSignIns).toBeNull();
    expect(body.jobs.map((j) => j.name)).toContain("ok-job");
  });

  it("exposes report-local errors without putting healthy queued work into backoff", async () => {
    registerJob(def({
      name: "report-job",
      run: async (ctx) => ctx.failItem("synthetic-report", "PROCESSING_TIMEOUT", { reportLocal: true }),
    }));
    const { runJob } = await import("../jobs/scheduler");
    await runJob("report-job", { trigger: "schedule", store, now: clock });
    const response = await fetch(`${base}/hq/system-health`, { headers: admin });
    expect(response.status).toBe(200);
    const body = await response.json() as { jobs: JobHealthDto[] };
    expect(body.jobs.find((job) => job.name === "report-job")).toMatchObject({
      status: "ok",
      lastSuccessCounts: { reportLocalFailures: 1 },
      consecutiveFailures: 0,
      nextEligibleAt: null,
      recentFailures: [{ item: "synthetic-report", error: "PROCESSING_TIMEOUT", occurredAt: expect.any(String) }],
    });
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

describe("GET /hq/system-health/performance", () => {
  it("needs settings_manage", async () => {
    expect((await fetch(`${base}/hq/system-health/performance`)).status).toBe(403);
  });

  it("returns latency, slow statements, growth, and the evaluated thresholds", async () => {
    performance = async (now) => ({
      asOf: now.toISOString(),
      latency: { lastHour: { since: "h", families: [{ family: "office/roster", streaming: false, requests: 63, errors: 0, dbShare: 1, aiShare: 0, meanMs: 900, p50Ms: 700, p95Ms: 1840, maxMs: 3000, level: "amber" }] }, lastDay: { since: "d", families: [] } },
      slowStatements: { statsResetAt: null, byTotal: [], byMean: [] },
      growth: null,
      thresholds: { level: "amber", config: thresholdConfig(), findings: [{ metric: "p95_latency", level: "amber", family: "office/roster", value: 1840, limit: 1500, message: "slow" }] },
    });
    const res = await fetch(`${base}/hq/system-health/performance`, { headers: admin });
    expect(res.status).toBe(200);
    const body = await res.json() as PerformanceDto;
    expect(body.latency?.lastHour.families[0]).toMatchObject({ family: "office/roster", p95Ms: 1840, level: "amber" });
    expect(body.thresholds).toMatchObject({ level: "amber", findings: [{ metric: "p95_latency", family: "office/roster" }] });
    expect(body.growth).toBeNull();
  });

  it("answers 502 when the whole read fails", async () => {
    performance = async () => { throw new Error("pg down"); };
    const res = await fetch(`${base}/hq/system-health/performance`, { headers: admin });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not load performance right now." });
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
    // Rejected calls neither drain nor leave a heartbeat.
    expect(drainCalls).toEqual([]);
    expect(tickStore.rows.size).toBe(0);
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

  it("drains every worker family (office exports, patient exports, purges) before the due jobs on a bare tick", async () => {
    process.env.NOTIFICATIONS_INTERNAL_TOKEN = "secret-token";
    const headers = { authorization: "Bearer secret-token", "content-type": "application/json" };
    const order: string[] = [];
    registerJob(def({ name: "due", run: async () => { order.push("job:due"); } }));
    drainReturns.officeExports = async () => { order.push("drain:office"); return 2; };
    drainReturns.patientExports = async () => { order.push("drain:patient"); return 1; };
    drainReturns.purges = async () => { order.push("drain:purges"); return 0; };
    const res = await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers, body: "{}" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ name: string }>; drains: { officeExports: number; patientExports: number; purges: number; failed: unknown[] } };
    expect(body.drains).toEqual({ officeExports: 2, patientExports: 1, purges: 0, failed: [] });
    expect(order).toEqual(["drain:office", "drain:patient", "drain:purges", "job:due"]);
    // A named-job tick and a dry run touch only the job ledger.
    drainCalls.length = 0;
    await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers, body: JSON.stringify({ job: "due" }) });
    await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers, body: JSON.stringify({ dryRun: true }) });
    await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers, body: JSON.stringify({ drains: false }) });
    expect(drainCalls).toEqual([]);
  });

  it("isolates a failing drain: the others and the jobs still run, and the heartbeat carries the error", async () => {
    process.env.NOTIFICATIONS_INTERNAL_TOKEN = "secret-token";
    const headers = { authorization: "Bearer secret-token", "content-type": "application/json" };
    const ran: string[] = [];
    registerJob(def({ name: "due", run: async () => { ran.push("due"); } }));
    drainReturns.patientExports = async () => { throw new Error("storage 503"); };
    drainReturns.purges = async () => 3;
    const res = await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers, body: "{}" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drains: { purges: number; failed: Array<{ drain: string; error: string }> } };
    expect(body.drains.purges).toBe(3);
    expect(body.drains.failed).toEqual([{ drain: "patientExports", error: "storage 503" }]);
    expect(ran).toEqual(["due"]);
    expect(tickStore.rows.get("jobs")).toMatchObject({
      lastResult: "succeeded",
      summary: { jobsDue: 1, jobsRan: 1, officeExports: 0, patientExports: 0, purges: 3, drainFailures: 1 },
      error: "patientExports: storage 503",
    });
  });

  it("records the jobs heartbeat with the tick's owner and counts, and never fails the tick when the heartbeat write fails", async () => {
    process.env.NOTIFICATIONS_INTERNAL_TOKEN = "secret-token";
    const headers = { authorization: "Bearer secret-token", "content-type": "application/json" };
    registerJob(def({ name: "due", run: async () => undefined }));
    const res = await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers, body: "{}" });
    expect(res.status).toBe(200);
    const row = tickStore.rows.get("jobs");
    expect(row).toMatchObject({ kind: "jobs", lastResult: "succeeded", error: null, summary: { jobsDue: 1, jobsRan: 1, officeExports: 0, patientExports: 0, purges: 0, drainFailures: 0 } });
    expect(row!.lastAt).toBe(clock.toISOString());
    expect(row!.owner).toMatch(/:\d+:[0-9a-f]{8}$/);

    const failing = express();
    failing.use(express.json());
    failing.use(createSystemJobsRouter(store, { manualWaitMs: 150, drains, tickStore: { record: async () => { throw new Error("ledger down"); }, list: async () => [] } }));
    const srv = await new Promise<http.Server>((resolve) => { const s = failing.listen(0, () => resolve(s)); });
    try {
      const port = (srv.address() as AddressInfo).port;
      const again = await fetch(`http://127.0.0.1:${port}/internal/jobs/tick`, { method: "POST", headers, body: "{}" });
      expect(again.status).toBe(200);
    } finally {
      srv.close();
    }
  });

  it("records a failed heartbeat and answers 500 when the tick itself throws", async () => {
    process.env.NOTIFICATIONS_INTERNAL_TOKEN = "secret-token";
    const headers = { authorization: "Bearer secret-token", "content-type": "application/json" };
    registerJob(def({ name: "on-demand", intervalMs: null, run: async () => undefined }));
    const acquireLease = store.acquireLease;
    store.acquireLease = async () => { throw new Error("ledger write failed"); };
    try {
      const res = await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers, body: JSON.stringify({ job: "on-demand" }) });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Tick failed." });
    } finally {
      store.acquireLease = acquireLease;
    }
    expect(tickStore.rows.get("jobs")).toMatchObject({ lastResult: "failed", error: "ledger write failed", summary: {} });
  });
});

describe("GET /hq/system-health external trigger", () => {
  it("reports never/stale/ok per tick kind, the 5 minute threshold, and whether this process runs its own timers", async () => {
    let res = await fetch(`${base}/hq/system-health`, { headers: admin });
    let body = (await res.json()) as { externalTrigger: ExternalTriggerHealth };
    expect(body.externalTrigger.staleAfterMs).toBe(300_000);
    expect(body.externalTrigger.inProcessTimers).toEqual({ jobs: true, notifications: true });
    expect(body.externalTrigger.ticks.map((t) => [t.kind, t.status, t.lastAt])).toEqual([["jobs", "never", null], ["notifications", "never", null]]);

    process.env.JOBS_DISABLED = "1";
    process.env.NOTIFICATIONS_DISABLED = "true";
    await tickStore.record({ kind: "jobs", at: new Date(clock.getTime() - 4 * 60_000), owner: "api-1", result: "succeeded", summary: { jobsRan: 1 }, error: null });
    await tickStore.record({ kind: "notifications", at: new Date(clock.getTime() - 5 * 60_000 - 1), owner: "api-2", result: "failed", summary: {}, error: "db down" });
    res = await fetch(`${base}/hq/system-health`, { headers: admin });
    body = (await res.json()) as { externalTrigger: ExternalTriggerHealth };
    expect(body.externalTrigger.inProcessTimers).toEqual({ jobs: false, notifications: false });
    const byKind = Object.fromEntries(body.externalTrigger.ticks.map((t) => [t.kind, t]));
    expect(byKind.jobs).toMatchObject({ status: "ok", owner: "api-1", lastResult: "succeeded", summary: { jobsRan: 1 }, error: null });
    expect(byKind.notifications).toMatchObject({ status: "stale", owner: "api-2", lastResult: "failed", error: "db down" });
  });

  it("answers 502 when the heartbeat ledger cannot be read", async () => {
    const broken = express();
    broken.use(express.json());
    broken.use(createSystemJobsRouter(store, { manualWaitMs: 150, drains, tickStore: { record: async () => undefined, list: async () => { throw new Error("ledger down"); } } }));
    const srv = await new Promise<http.Server>((resolve) => { const s = broken.listen(0, () => resolve(s)); });
    try {
      const port = (srv.address() as AddressInfo).port;
      expect((await fetch(`http://127.0.0.1:${port}/hq/system-health`, { headers: admin })).status).toBe(502);
    } finally {
      srv.close();
    }
  });
});
