/**
 * HQ's view of account deletions: permission gating, the list + status
 * summary, and the retry action that re-arms only a failed purge and
 * audits who did it.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, fakeUuid } from "../privacy/fake-supabase";

const mocks = vi.hoisted(() => ({
  supabase: null as unknown as ReturnType<typeof import("../privacy/fake-supabase").createFakeSupabase>,
  drain: vi.fn(),
}));
vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: (method: string, path: string, body?: unknown, prefer?: string) => mocks.supabase.handler(method, path, body, prefer),
}));
vi.mock("../lib/staff-auth", () => ({
  requireHqPermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = req.headers.authorization;
    if (token === "Bearer viewer" && permission !== "audit_read") return res.status(403).json({ error: "denied" });
    if (token !== "Bearer admin" && token !== "Bearer viewer") return res.status(401).json({ error: "sign in" });
    res.locals.staff = { userId: token === "Bearer admin" ? "hq-admin" : "hq-viewer", departmentRole: "admin", permissions: [] };
    return next();
  },
}));
vi.mock("../privacy/purge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../privacy/purge")>()),
  drainDuePurges: mocks.drain,
}));
mocks.supabase = createFakeSupabase();

import router from "./hq-patient-deletions";

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const row = (n: number, overrides: Record<string, unknown>) => ({
  id: fakeUuid(n), patient_id: fakeUuid(100 + n), provider_id: "office-1", status: "pending",
  requested_at: `2026-09-0${n}T00:00:00.000Z`, purge_after: `2026-09-1${n}T00:00:00.000Z`, cancelled_at: null, started_at: null,
  purged_at: null, attempts: 0, next_attempt_at: null, lease_owner: null, lease_until: null, last_error: null, steps: {}, ...overrides,
});

beforeEach(() => {
  mocks.supabase.reset();
  mocks.drain.mockReset().mockResolvedValue(0);
  mocks.supabase.tables.patient_deletion_requests.push(
    row(1, {}),
    row(2, { status: "purged", purged_at: "2026-09-12T00:00:00.000Z", attempts: 1, steps: { storage: { ok: true, objects: 4 } } }),
    row(3, { status: "failed", attempts: 3, last_error: "auth: auth user delete failed (503)", next_attempt_at: "2026-09-14T00:00:00.000Z", steps: { storage: { ok: true }, rows: { ok: true }, auth: { ok: false, error: "503" } } }),
  );
});

const call = (path: string, token = "admin", method = "GET") => fetch(base + path, { method, headers: { authorization: `Bearer ${token}` } });

describe("HQ patient deletions", () => {
  it("gates on permissions", async () => {
    expect((await call("/hq/patient-deletions", "nobody")).status).toBe(401);
    expect((await call("/hq/patient-deletions", "viewer")).status).toBe(200);
    expect((await call(`/hq/patient-deletions/${fakeUuid(3)}/retry`, "viewer", "POST")).status).toBe(403);
    expect(mocks.supabase.tables.patient_deletion_requests[2].next_attempt_at).toBe("2026-09-14T00:00:00.000Z");
  });

  it("lists newest first with a status summary, filters by status, and rejects bad filters", async () => {
    let res = await call("/hq/patient-deletions");
    expect(res.status).toBe(200);
    let body = await res.json() as { deletions: Array<Record<string, unknown>>; summary: Record<string, number> };
    expect(body.deletions.map((d) => d.id)).toEqual([fakeUuid(3), fakeUuid(2), fakeUuid(1)]);
    expect(body.summary).toEqual({ pending: 1, cancelled: 0, purging: 0, purged: 1, failed: 1 });
    expect(body.deletions[0]).toMatchObject({ patientId: fakeUuid(103), providerId: "office-1", status: "failed", attempts: 3, lastError: "auth: auth user delete failed (503)", nextAttemptAt: "2026-09-14T00:00:00.000Z" });
    expect((body.deletions[0].steps as { auth: { ok: boolean } }).auth.ok).toBe(false);
    res = await call("/hq/patient-deletions?status=failed&limit=10");
    body = await res.json() as typeof body;
    expect(body.deletions.map((d) => d.id)).toEqual([fakeUuid(3)]);
    expect(body.summary.pending).toBe(1);
    expect((await call("/hq/patient-deletions?status=bogus")).status).toBe(400);
    expect((await call("/hq/patient-deletions?limit=0")).status).toBe(400);
  });

  it("retries only a failed purge, audits it, and kicks the worker", async () => {
    const res = await call(`/hq/patient-deletions/${fakeUuid(3)}/retry`, "admin", "POST");
    expect(res.status).toBe(200);
    const body = await res.json() as { deletion: Record<string, unknown> };
    expect(body.deletion).toMatchObject({ id: fakeUuid(3), status: "failed", lastError: null });
    expect(Date.parse(String(body.deletion.nextAttemptAt))).toBeLessThanOrEqual(Date.now());
    expect(mocks.drain).toHaveBeenCalledTimes(1);
    expect(mocks.supabase.tables.admin_audit_events).toEqual([
      expect.objectContaining({ p_action: "patient_deletion_retried", p_actor_kind: "hq", p_actor_user_id: "hq-admin", p_provider_id: "office-1", p_target_id: fakeUuid(103) }),
    ]);
    // Pending / purged rows and unknown ids are refused without touching anything.
    expect((await call(`/hq/patient-deletions/${fakeUuid(1)}/retry`, "admin", "POST")).status).toBe(409);
    expect((await call(`/hq/patient-deletions/${fakeUuid(2)}/retry`, "admin", "POST")).status).toBe(409);
    expect((await call(`/hq/patient-deletions/not-a-uuid/retry`, "admin", "POST")).status).toBe(404);
    expect(mocks.supabase.tables.patient_deletion_requests[0].next_attempt_at).toBeNull();
    expect(mocks.drain).toHaveBeenCalledTimes(1);
  });
});
