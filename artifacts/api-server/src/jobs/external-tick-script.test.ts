/**
 * The scheduled-trigger script (scripts/external-tick.mjs) is what production
 * runs every minute. This suite runs it against a local server that records
 * what it receives.
 *   - both internal tick routes get one POST each with the bearer;
 *   - a 429 "already running" is not a failure; a 5xx or a refused
 *     connection is; the exit code follows;
 *   - missing configuration exits 1 without touching the network.
 */
import express from "express";
import { execFile } from "node:child_process";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "../../scripts/external-tick.mjs");

let server: http.Server;
let base = "";
let received: Array<{ path: string; auth: string | undefined; body: unknown }> = [];
let answers: Record<string, { status: number; body: unknown }> = {};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post("/api/internal/:kind/tick", (req, res) => {
    received.push({ path: req.path, auth: req.headers.authorization, body: req.body });
    const answer = answers[req.params.kind] ?? { status: 200, body: {} };
    res.status(answer.status).json(answer.body);
  });
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => server.close());
afterEach(() => {
  received = [];
  answers = {};
});

// Async on purpose: the server the script talks to lives in this same worker,
// so a synchronous spawn would deadlock the event loop.
function runScript(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? -1) : 0;
      resolve({ code: typeof code === "number" ? code : -1, out: `${stdout}${stderr}` });
    });
  });
}

describe("scripts/external-tick.mjs", () => {
  it("POSTs the jobs tick then the notifications tick with the bearer and exits 0", async () => {
    answers = {
      jobs: { status: 200, body: { results: [{ name: "x", outcome: { kind: "ran" } }], drains: { officeExports: 1, patientExports: 0, purges: 0, failed: [] } } },
      notifications: { status: 200, body: { outbox: { claimed: 2, sent: 2 } } },
    };
    const { code, out } = await runScript({ INTERNAL_TICK_API_URL: `${base}/`, NOTIFICATIONS_INTERNAL_TOKEN: "sched-secret" });
    expect(code).toBe(0);
    expect(received.map((r) => r.path)).toEqual(["/api/internal/jobs/tick", "/api/internal/notifications/tick"]);
    expect(received.every((r) => r.auth === "Bearer sched-secret")).toBe(true);
    expect(out).toContain("/internal/jobs/tick ok (200)");
    expect(out).toContain("1/1 due job(s) ran");
    expect(out).toContain("outbox claimed=2 sent=2");
  });

  it("treats 429 (a tick already running) as fine but any other failure as exit 1", async () => {
    answers = { jobs: { status: 429, body: { error: "A job tick is already running." } } };
    expect((await runScript({ INTERNAL_TICK_API_URL: base, NOTIFICATIONS_INTERNAL_TOKEN: "sched-secret" })).code).toBe(0);
    answers = { notifications: { status: 500, body: { error: "Tick failed." } } };
    const failed = await runScript({ INTERNAL_TICK_API_URL: base, NOTIFICATIONS_INTERNAL_TOKEN: "sched-secret" });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("/internal/notifications/tick FAILED (500)");
    // Both routes are still attempted even when the first one fails.
    answers = { jobs: { status: 401, body: { error: "Unauthorized" } } };
    await runScript({ INTERNAL_TICK_API_URL: base, NOTIFICATIONS_INTERNAL_TOKEN: "wrong" });
    expect(received.slice(-2).map((r) => r.path)).toEqual(["/api/internal/jobs/tick", "/api/internal/notifications/tick"]);
  });

  it("exits 1 without a request when the URL or token is missing, and on a refused connection", async () => {
    expect((await runScript({ NOTIFICATIONS_INTERNAL_TOKEN: "sched-secret" })).code).toBe(1);
    expect((await runScript({ INTERNAL_TICK_API_URL: base })).code).toBe(1);
    expect(received).toEqual([]);
    const refused = await runScript({ INTERNAL_TICK_API_URL: "http://127.0.0.1:9/api", NOTIFICATIONS_INTERNAL_TOKEN: "sched-secret", INTERNAL_TICK_TIMEOUT_MS: "2000" });
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("FAILED");
  });
});
