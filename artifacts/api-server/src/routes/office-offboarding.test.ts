/**
 * Office offboarding stepper: permission + fresh-code gating, each step in
 * order with its idempotent repeat, the legal-hold blocks on steps 4 and 5,
 * the seal job driving the account-closure primitive per chart, the
 * destruction certificate, the audit row every step writes, and the patient
 * identity gate. The SQL helpers are proven separately on real PostgreSQL.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  audits: [] as Row[],
  revoked: [] as string[],
  signals: [] as string[],
  closed: [] as string[],
  closureOutcome: "closed" as "closed" | "failed",
  fresh: true,
  holdsProvider: false,
  holdPatients: new Set<string>(),
}));

function filterRows(rows: Row[], params: URLSearchParams): Row[] {
  return rows.filter((row) => {
    for (const [key, raw] of params.entries()) {
      if (["select", "order", "limit"].includes(key)) continue;
      const value = row[key];
      if (raw.startsWith("eq.")) { if (String(value ?? "") !== raw.slice(3)) return false; }
      else if (raw.startsWith("in.(")) { if (!raw.slice(4, -1).split(",").map((s) => s.replace(/^"|"$/g, "")).includes(String(value ?? ""))) return false; }
      else if (raw === "is.null") { if (value != null) return false; }
      else if (raw === "not.is.null") { if (value == null) return false; }
      else throw new Error(`unsupported filter ${key}=${raw}`);
    }
    return true;
  });
}

vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: async (method: string, path: string, body?: Row) => {
    const url = new URL(`http://x${path}`);
    const table = url.pathname.replace("/rest/v1/", "");
    if (url.pathname === "/rest/v1/rpc/record_admin_audit_event") { state.audits.push({ ...body }); return { status: 200, json: 1 }; }
    if (url.pathname === "/rest/v1/rpc/office_offboarding_progress") {
      const patients = state.tables.patients.filter((p) => p.provider_id === body?.p_provider_id);
      const reqs = state.tables.patient_deletion_requests.filter((r) => patients.some((p) => p.id === r.patient_id));
      const count = (s: string[]) => reqs.filter((r) => s.includes(r.status)).length;
      return { status: 200, json: [{ total: patients.length, sealed: count(["closed", "purging", "purged"]), held: count(["held"]), pending: count(["queued", "closing"]), failed: count(["failed"]), destroyed: count(["purged"]) }] };
    }
    if (url.pathname === "/rest/v1/rpc/office_offboarding_seal_batch") {
      if (state.holdsProvider) return { status: 400, json: { message: "office is under legal hold" } };
      let n = 0;
      for (const p of state.tables.patients.filter((p) => p.provider_id === body?.p_provider_id)) {
        if (state.tables.patient_deletion_requests.some((r) => r.patient_id === p.id)) continue;
        state.tables.patient_deletion_requests.push({ id: `req-${p.id}`, patient_id: p.id, provider_id: p.provider_id, status: state.holdPatients.has(p.id) ? "held" : "queued", record_retain_until: body?.p_retain_until ?? null });
        n += 1;
      }
      return { status: 200, json: n };
    }
    if (url.pathname === "/rest/v1/rpc/claim_office_patient_deletions") {
      const claimed = state.tables.patient_deletion_requests.filter((r) => r.provider_id === body?.p_provider_id && r.status === "queued").slice(0, Number(body?.p_limit));
      for (const r of claimed) r.status = "closing";
      return { status: 200, json: claimed.map((r) => ({ ...r })) };
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) throw new Error(`unexpected rpc ${url.pathname}`);
    const rows = state.tables[table] ?? (state.tables[table] = []);
    if (method === "GET") {
      const out = filterRows(rows, url.searchParams).map((r) => ({ ...r }));
      const limit = url.searchParams.get("limit");
      return { status: 200, json: limit ? out.slice(0, Number(limit)) : out };
    }
    if (method === "POST") {
      const row = { id: `${table}-${rows.length + 1}`, created_at: "2026-09-19T09:00:00.000Z", download_count: 0, parts: null, object_path: null, params: {}, ...body };
      rows.push(row);
      return { status: 201, json: [{ ...row }] };
    }
    if (method === "PATCH") {
      const hits = filterRows(rows, url.searchParams);
      for (const row of hits) Object.assign(row, body);
      return { status: 200, json: hits.map((r) => ({ ...r })) };
    }
    throw new Error(`unexpected ${method} ${path}`);
  },
}));
vi.mock("../lib/staff-auth", () => ({
  requireHqPermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = req.headers.authorization;
    if (token !== "Bearer admin" && token !== "Bearer viewer") return res.status(401).json({ error: "sign in" });
    if (token === "Bearer viewer" && permission !== "provider_read") return res.status(403).json({ error: "denied" });
    res.locals.staff = { userId: "hq-admin", departmentRole: "admin", permissions: [] };
    return next();
  },
}));
vi.mock("../auth/fresh-code", () => ({
  requireFreshCode: async (_req: unknown, res: express.Response) => {
    if (state.fresh) return true;
    res.status(401).json({ error: "fresh code required", code: "REAUTH_REQUIRED" });
    return false;
  },
}));
vi.mock("../auth/session-revocations", () => ({
  revokeUserSessions: async ({ userId }: { userId: string }) => { state.revoked.push(userId); return 2; },
}));
vi.mock("../jobs/scheduler", () => ({ signalJob: (name: string) => { state.signals.push(name); return true; } }));
vi.mock("../lib/org-policy", () => ({ loadOrgPolicy: async () => ({ retention: { clinicalRecordDays: 2555 } }) }));
vi.mock("../lib/objectStorage", () => ({ objectStorage: { signedDownloadURL: async (p: string) => `https://signed/${p}` } }));
vi.mock("../privacy/purge", () => ({
  runClosure: async (request: Row) => {
    const row = state.tables.patient_deletion_requests.find((r) => r.id === request.id)!;
    row.status = state.closureOutcome;
    if (state.closureOutcome === "closed") state.closed.push(String(request.patient_id));
    return state.closureOutcome;
  },
}));

import router, { OFFBOARDING_DESTROY_DAYS } from "./office-offboarding";
import { runOfficeOffboardingSeal, OFFICE_OFFBOARDING_SEAL_JOB_NAME } from "../jobs/definitions/office-offboarding-seal";
import { officeHasEnded } from "../lib/patient-auth";
import { officeIsActive } from "../lib/office-status";

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const OFFICE = "live-office-1";
beforeEach(() => {
  state.tables = {
    providers: [{ provider_id: OFFICE, provider_name: "Dr. North", office_name: "Northside Med Spa", auth_user_id: "owner-1", access_disabled: false, offboarding_status: "active", offboarding_started_at: null, offboarded_at: null }],
    team_members: [{ provider_id: OFFICE, auth_user_id: "staff-1" }, { provider_id: OFFICE, auth_user_id: null }],
    provider_offboardings: [],
    data_exports: [],
    legal_holds: [],
    patients: [{ id: "pat-1", provider_id: OFFICE }, { id: "pat-2", provider_id: OFFICE }, { id: "pat-other", provider_id: "live-office-2" }],
    patient_deletion_requests: [],
    patient_tombstones: [{ id: "tomb-1", provider_id: OFFICE, requested_at: "2026-09-01T00:00:00Z", purged_at: "2026-09-02T00:00:00Z", was_activated: true, program_id: "p1", enrolled_on: "2026-01-01" }],
  };
  state.audits.length = 0; state.revoked.length = 0; state.signals.length = 0; state.closed.length = 0;
  state.closureOutcome = "closed"; state.fresh = true; state.holdsProvider = false; state.holdPatients = new Set();
});

const call = async (path: string, method = "GET", body?: unknown, token = "admin") => {
  const res = await fetch(`${base}/provider-accounts/${OFFICE}/offboarding${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, json, text };
};
const provider = () => state.tables.providers[0];
const record = () => state.tables.provider_offboardings[0];
const bundleReady = () => { const job = state.tables.data_exports[0]; Object.assign(job, { status: "ready", object_path: "exports/bundle.zip", file_name: "bundle.zip", completed_at: "2026-09-19T10:00:00Z", expires_at: "2027-01-01T00:00:00Z", parts: [{ part: 1, objectPath: "exports/b-1.zip", fileName: "b-1.zip", sizeBytes: 10 }, { part: 2, objectPath: "exports/b-2.zip", fileName: "b-2.zip", sizeBytes: 10 }] }); };
const HANDOVER = { receivedBy: "Dr. North", receivedOn: "2026-09-18", choice: "retain", letterReference: "Letter 2026-09-18" };
const ctx = () => ({ now: new Date("2026-09-19T12:00:00Z"), dryRun: false, leaseLost: false, checkpoint: () => {}, tally: () => {}, log: () => {}, failItem: () => {} }) as any;

async function throughHandover(choice: "retain" | "destroy" = "retain") {
  await call("/start", "POST");
  await call("/bundle", "POST", {});
  bundleReady();
  return call("/handover", "POST", { ...HANDOVER, choice });
}

describe("office offboarding stepper", () => {
  it("gates: provider_read may view, mutations need provider_manage and a fresh code", async () => {
    expect((await call("", "GET", undefined, "nobody")).status).toBe(401);
    expect((await call("", "GET", undefined, "viewer")).status).toBe(200);
    expect((await call("/start", "POST", undefined, "viewer")).status).toBe(403);
    state.fresh = false;
    expect((await call("/start", "POST")).status).toBe(401);
    expect(provider().offboarding_status).toBe("active");
    expect(state.audits).toEqual([]);
  });

  it("step 1 flips the status, revokes owner + team sessions, audits, and repeats idempotently", async () => {
    const first = await call("/start", "POST");
    expect(first.status).toBe(201);
    expect(first.json.offboarding).toMatchObject({ status: "offboarding", nextStep: "bundle", started: { sessionsRevoked: 4 } });
    expect(provider()).toMatchObject({ offboarding_status: "offboarding", access_disabled: false });
    expect(state.revoked.sort()).toEqual(["owner-1", "staff-1"]);
    expect(state.audits.map((a) => a.p_action)).toEqual(["office_offboarding_started"]);
    const again = await call("/start", "POST");
    expect(again.status).toBe(200);
    expect(state.revoked).toHaveLength(2);
    expect(state.tables.provider_offboardings).toHaveLength(1);
  });

  it("steps run in order: bundle before handover, handover before seal, and each refuses out of order", async () => {
    expect((await call("/bundle", "POST", {})).status).toBe(409);
    expect((await call("/handover", "POST", HANDOVER)).status).toBe(409);
    expect((await call("/seal", "POST")).status).toBe(409);
    expect((await call("/complete", "POST")).status).toBe(409);
    await call("/start", "POST");
    const bundle = await call("/bundle", "POST", {});
    expect(bundle.status).toBe(202);
    expect(state.tables.data_exports[0]).toMatchObject({ kind: "office_bundle", requester_kind: "hq", provider_id: OFFICE, params: { offboarding: true } });
    expect(state.signals).toContain("office-bundle-export");
    expect((await call("/bundle", "POST", {})).status).toBe(200);
    expect(state.tables.data_exports).toHaveLength(1);
    expect((await call("/handover", "POST", HANDOVER)).status).toBe(409);
    bundleReady();
    expect((await call("/bundle/download-url?part=2")).json).toMatchObject({ url: "https://signed/exports/b-2.zip", fileName: "b-2.zip", part: 2 });
    expect((await call("/bundle/download-url?part=3")).status).toBe(404);
    expect((await call("/handover", "POST", { ...HANDOVER, receivedOn: "tomorrow" })).status).toBe(400);
    const handover = await call("/handover", "POST", { ...HANDOVER, note: "Stripe cancelled 9/18" });
    expect(handover.status).toBe(200);
    expect(handover.json.offboarding.handover).toMatchObject({ receivedBy: "Dr. North", choice: "retain", note: "Stripe cancelled 9/18" });
    expect(handover.json.offboarding.nextStep).toBe("seal");
    expect(state.audits.map((a) => a.p_action)).toEqual(["office_offboarding_started", "office_offboarding_bundle_requested", "office_bundle_export_downloaded", "office_offboarding_handover_recorded"]);
  });

  it("step 4 is blocked by an office legal hold, otherwise starts the seal job; destroy sets a short retain-until", async () => {
    await throughHandover("destroy");
    state.tables.legal_holds.push({ id: "h1", target_kind: "provider", target_id: OFFICE, lifted_at: null });
    const held = await call("/seal", "POST");
    expect(held.status).toBe(409);
    expect(held.json.code).toBe("legal_hold");
    expect(record().seal_started_at).toBeUndefined();
    state.tables.legal_holds[0].lifted_at = "2026-09-19T11:00:00Z";
    const seal = await call("/seal", "POST");
    expect(seal.status).toBe(202);
    const retainUntil = new Date(record().seal_retain_until).getTime() - Date.now();
    expect(Math.abs(retainUntil - OFFBOARDING_DESTROY_DAYS * 86_400_000)).toBeLessThan(60_000);
    expect(state.signals).toContain(OFFICE_OFFBOARDING_SEAL_JOB_NAME);
    expect((await call("/handover", "POST", HANDOVER)).status).toBe(409);
    expect((await call("/seal", "POST")).status).toBe(200);
    expect((await call("/complete", "POST")).status).toBe(409);
  });

  it("the seal job closes every chart with the shared primitive, respects holds, and step 5 completes with the certificate", async () => {
    await throughHandover("retain");
    await call("/seal", "POST");
    expect(record().seal_retain_until).toBeNull();
    state.holdPatients.add("pat-2");
    await runOfficeOffboardingSeal(ctx());
    expect(state.closed).toEqual(["pat-1"]);
    expect(record().seal_completed_at).toBe("2026-09-19T12:00:00.000Z");
    expect(record()).toMatchObject({ seal_patients_total: 2, seal_patients_done: 1, seal_patients_held: 1 });
    const blocked = await call("/complete", "POST");
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe("legal_hold");
    expect((await call("/certificate.csv")).status).toBe(409);
    // Hold lifted: the parked chart is released and sealed on the next run.
    state.tables.patient_deletion_requests.find((r) => r.patient_id === "pat-2")!.status = "queued";
    record().seal_completed_at = null;
    await runOfficeOffboardingSeal(ctx());
    expect(state.closed).toEqual(["pat-1", "pat-2"]);
    const done = await call("/complete", "POST");
    expect(done.status).toBe(200);
    expect(done.json.offboarding).toMatchObject({ status: "offboarded", nextStep: null, certificateAvailable: true });
    expect(provider()).toMatchObject({ offboarding_status: "offboarded", access_disabled: true });
    expect(officeIsActive(provider())).toBe(false);
    expect((await call("/complete", "POST")).status).toBe(200);
    const cert = await call("/certificate.csv");
    expect(cert.status).toBe(200);
    expect(cert.text).toContain("summary,handover_choice,retain");
    expect(cert.text).toContain("summary,charts_sealed,2");
    expect(cert.text).toContain("tomb-1,2026-09-01T00:00:00Z,2026-09-02T00:00:00Z,true,p1,2026-01-01");
    expect(state.audits.map((a) => a.p_action).slice(-2)).toEqual(["office_offboarding_completed", "office_destruction_certificate_downloaded"]);
  });

  it("the seal job skips an office under hold and never stamps completion while charts fail", async () => {
    await throughHandover();
    await call("/seal", "POST");
    state.holdsProvider = true;
    state.tables.legal_holds.push({ id: "h1", target_kind: "provider", target_id: OFFICE, lifted_at: null });
    await runOfficeOffboardingSeal(ctx());
    expect(state.tables.patient_deletion_requests).toEqual([]);
    state.holdsProvider = false; state.tables.legal_holds.length = 0;
    state.closureOutcome = "failed";
    await runOfficeOffboardingSeal(ctx());
    expect(record().seal_completed_at).toBeUndefined();
    expect(state.signals.filter((s) => s === OFFICE_OFFBOARDING_SEAL_JOB_NAME).length).toBeGreaterThan(1);
  });

  it("patients of an offboarding office are refused at identity resolution", () => {
    expect(officeHasEnded({ offboarding_status: "offboarding" })).toBe(true);
    expect(officeHasEnded([{ offboarding_status: "offboarded" }])).toBe(true);
    expect(officeHasEnded({ offboarding_status: "active" })).toBe(false);
    expect(officeHasEnded(null)).toBe(false);
  });
});
