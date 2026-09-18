/**
 * Production posture: in-process timers off (JOBS_DISABLED=1), an external
 * scheduled trigger POSTs /internal/jobs/tick every minute.
 *
 * Proves, against the job ledger, that
 *   - with JOBS_DISABLED set, neither the job scheduler nor the export /
 *     privacy worker loops do anything, however long the process waits;
 *   - a due job still runs the moment an authenticated external tick lands,
 *     recorded with trigger "internal" and a fresh heartbeat;
 *   - the same tick drains the export and purge queues;
 *   - development (flag unset) keeps the in-process ticker running.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), registerAllJobs: vi.fn() }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: vi.fn(), requestIdOf: () => null }));
vi.mock("../lib/staff-auth", () => ({ requireHqPermission: () => (_req: express.Request, res: express.Response) => res.status(403).end() }));
vi.mock("../jobs", () => ({ registerAllJobs: mocks.registerAllJobs }));

import { startExportWorker, stopExportWorker } from "../exports/worker";
import { startPrivacyWorker, stopPrivacyWorker } from "../privacy/worker";
import { createSystemJobsRouter } from "../routes/system-jobs";
import { createMemoryExternalTickStore } from "./external-ticks";
import { registerJob, resetJobRegistry, startJobScheduler, stopJobScheduler } from "./scheduler";
import { createMemoryJobStore } from "./store";
import type { WorkerDrains } from "./worker-drains";

let clock = new Date("2026-09-07T12:00:00Z");
const store = createMemoryJobStore(() => clock);
const tickStore = createMemoryExternalTickStore();
const drained: string[] = [];
const drains: WorkerDrains = {
  officeExports: async () => { drained.push("officeExports"); return 1; },
  patientExports: async () => { drained.push("patientExports"); return 0; },
  purges: async () => { drained.push("purges"); return 2; },
};
let server: http.Server;
let base = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const priorEnv = { jobs: process.env.JOBS_DISABLED, token: process.env.NOTIFICATIONS_INTERNAL_TOKEN };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createSystemJobsRouter(store, { manualWaitMs: 100, tickStore, drains }));
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  if (priorEnv.jobs === undefined) delete process.env.JOBS_DISABLED; else process.env.JOBS_DISABLED = priorEnv.jobs;
  if (priorEnv.token === undefined) delete process.env.NOTIFICATIONS_INTERNAL_TOKEN; else process.env.NOTIFICATIONS_INTERNAL_TOKEN = priorEnv.token;
});
beforeEach(() => {
  clock = new Date("2026-09-07T12:00:00Z");
  // Real timers (the scheduler's setInterval must actually fire); only Date follows the ledger clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
  store.reset();
  tickStore.reset();
  drained.length = 0;
  resetJobRegistry();
  mocks.admin.mockReset();
  process.env.NOTIFICATIONS_INTERNAL_TOKEN = "scheduler-secret";
});
afterEach(() => {
  vi.useRealTimers();
  stopJobScheduler();
  stopExportWorker();
  stopPrivacyWorker();
  resetJobRegistry();
  delete process.env.JOBS_DISABLED;
});

const headers = { authorization: "Bearer scheduler-secret", "content-type": "application/json" };

describe("external trigger with in-process timers disabled", () => {
  it("runs a due job only when the external tick arrives, and drains every worker family on the way", async () => {
    process.env.JOBS_DISABLED = "1";
    const ran: string[] = [];
    registerJob({ name: "reminder-sweep", title: "Reminder sweep", description: "due now", intervalMs: 60_000, leaseSeconds: 30, run: async (ctx) => { ran.push("reminder-sweep"); ctx.tally("sent", 1); } });

    // Production boot: every in-process loop is a no-op.
    startJobScheduler({ store, tickMs: 10 });
    startExportWorker({ drainEveryMs: 10 });
    startPrivacyWorker({ drainEveryMs: 10 });
    await sleep(120);
    expect(ran).toEqual([]);
    expect(store.runs).toEqual([]);
    // The worker loops would have queried the database on their first pass.
    expect(mocks.admin).not.toHaveBeenCalled();

    // The scheduled trigger lands.
    const res = await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers, body: "{}" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ name: string; outcome: { kind: string } }>; drains: Record<string, unknown> };
    expect(body.results).toEqual([{ name: "reminder-sweep", outcome: expect.objectContaining({ kind: "ran" }) }]);
    expect(body.drains).toEqual({ officeExports: 1, patientExports: 0, purges: 2, failed: [] });
    expect(drained).toEqual(["officeExports", "patientExports", "purges"]);
    expect(ran).toEqual(["reminder-sweep"]);
    // The job ledger shows the run came from the external trigger.
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ jobName: "reminder-sweep", trigger: "internal", status: "succeeded", counts: { sent: 1 } });
    expect(tickStore.rows.get("jobs")).toMatchObject({ kind: "jobs", lastResult: "succeeded", summary: expect.objectContaining({ jobsDue: 1, jobsRan: 1, officeExports: 1, purges: 2 }) });

    // A second tick inside the interval finds nothing due and still heartbeats.
    const again = await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers, body: "{}" });
    expect(((await again.json()) as { results: unknown[] }).results).toEqual([]);
    expect(store.runs).toHaveLength(1);
    expect(tickStore.rows.get("jobs")?.summary).toMatchObject({ jobsDue: 0, jobsRan: 0 });

    // Once the interval has elapsed, the next tick runs it again.
    clock = new Date(clock.getTime() + 61_000);
    vi.setSystemTime(clock);
    await fetch(`${base}/internal/jobs/tick`, { method: "POST", headers, body: "{}" });
    expect(store.runs).toHaveLength(2);
    expect(store.runs.every((r) => r.trigger === "internal")).toBe(true);
  });

  it("keeps the in-process ticker in development (flag unset)", async () => {
    const ran: string[] = [];
    registerJob({ name: "dev-job", title: "Dev job", description: "due now", intervalMs: 60_000, leaseSeconds: 30, run: async () => { ran.push("dev-job"); } });
    startJobScheduler({ store, tickMs: 10 });
    await vi.waitFor(() => expect(ran).toEqual(["dev-job"]), { timeout: 2_000, interval: 10 });
    expect(store.runs[0]).toMatchObject({ jobName: "dev-job", trigger: "schedule" });
  });
});
