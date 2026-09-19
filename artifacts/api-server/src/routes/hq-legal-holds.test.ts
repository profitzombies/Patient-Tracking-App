/**
 * HQ legal holds: permission gating, the list with names and office scope,
 * placing (with validation and a 404 for unknown targets), lifting (second
 * audited action, 409 when already lifted), and the audit rows each writes.
 * The SQL rules themselves are proven in privacy/legal-holds.sql.test.ts.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeUuid } from "../privacy/fake-supabase";

interface HoldRow {
  id: string; target_kind: string; target_id: string; reason: string; placed_by: string | null; placed_at: string;
  lifted_at: string | null; lifted_by: string | null; lift_reason: string | null;
}

const state = vi.hoisted(() => ({
  holds: [] as HoldRow[],
  audits: [] as Array<Record<string, unknown>>,
  patients: [] as Array<{ id: string; provider_id: string; first_name: string; last_name: string }>,
  providers: [] as Array<{ provider_id: string; office_name: string; provider_name: string }>,
  failNext: null as null | { status: number; json: unknown },
  seq: 0,
}));

function parseIn(raw: string): string[] {
  return [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: async (method: string, path: string, body?: Record<string, unknown>) => {
    const url = new URL(`http://x${path}`);
    if (state.failNext) {
      const out = state.failNext;
      state.failNext = null;
      return out;
    }
    if (url.pathname === "/rest/v1/rpc/record_admin_audit_event") {
      state.audits.push({ ...(body ?? {}) });
      return { status: 200, json: 1 };
    }
    if (url.pathname === "/rest/v1/rpc/legal_hold_place") {
      const kind = String(body?.p_target_kind);
      const id = String(body?.p_target_id);
      if (kind === "patient" && !state.patients.some((p) => p.id === id)) return { status: 400, json: { message: `unknown patient ${id}` } };
      if (kind === "provider" && !state.providers.some((p) => p.provider_id === id)) return { status: 400, json: { message: `unknown office ${id}` } };
      let row = state.holds.find((h) => h.target_kind === kind && h.target_id === id && h.lifted_at === null);
      if (!row) {
        state.seq += 1;
        row = { id: fakeUuid(50 + state.seq), target_kind: kind, target_id: id, reason: String(body?.p_reason), placed_by: String(body?.p_actor), placed_at: "2026-09-19T10:00:00.000Z", lifted_at: null, lifted_by: null, lift_reason: null };
        state.holds.push(row);
      }
      return { status: 200, json: [{ ...row }] };
    }
    if (url.pathname === "/rest/v1/rpc/legal_hold_lift") {
      const row = state.holds.find((h) => h.id === body?.p_hold_id);
      if (!row || row.lifted_at !== null) return { status: 400, json: { message: "hold not active" } };
      row.lifted_at = "2026-09-19T12:00:00.000Z";
      row.lifted_by = String(body?.p_actor);
      row.lift_reason = String(body?.p_reason);
      return { status: 200, json: [{ ...row }] };
    }
    if (method === "GET" && url.pathname === "/rest/v1/legal_holds") {
      let rows = state.holds.slice();
      const id = url.searchParams.get("id");
      if (id) rows = rows.filter((h) => h.id === id.slice(3));
      const lifted = url.searchParams.get("lifted_at");
      if (lifted === "is.null") rows = rows.filter((h) => h.lifted_at === null);
      if (lifted === "not.is.null") rows = rows.filter((h) => h.lifted_at !== null);
      rows.sort((a, b) => b.placed_at.localeCompare(a.placed_at));
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      return { status: 200, json: rows.slice(0, limit).map((h) => ({ ...h })) };
    }
    if (method === "GET" && url.pathname === "/rest/v1/patients") {
      const ids = parseIn(url.searchParams.get("id") ?? "");
      return { status: 200, json: state.patients.filter((p) => ids.includes(p.id)) };
    }
    if (method === "GET" && url.pathname === "/rest/v1/providers") {
      const ids = parseIn(url.searchParams.get("provider_id") ?? "");
      return { status: 200, json: state.providers.filter((p) => ids.includes(p.provider_id)) };
    }
    if (method === "GET" && url.pathname === "/rest/v1/hq_memberships") {
      const ids = parseIn(url.searchParams.get("auth_user_id") ?? "");
      return { status: 200, json: ids.filter((id) => id === "hq-admin").map((id) => ({ auth_user_id: id, display_name: "Dana HQ" })) };
    }
    if (method === "GET" && url.pathname === "/rest/v1/team_members") return { status: 200, json: [] };
    throw new Error(`unexpected ${method} ${path}`);
  },
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

import router from "./hq-legal-holds";

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

const PATIENT = fakeUuid(101);
const OTHER_PATIENT = fakeUuid(102);

beforeEach(() => {
  state.holds.length = 0;
  state.audits.length = 0;
  state.failNext = null;
  state.seq = 0;
  state.patients = [
    { id: PATIENT, provider_id: "office-1", first_name: "Pat", last_name: "Held" },
    { id: OTHER_PATIENT, provider_id: "office-2", first_name: "Sam", last_name: "Free" },
  ];
  state.providers = [
    { provider_id: "office-1", office_name: "Northside Med Spa", provider_name: "Dr. North" },
    { provider_id: "office-2", office_name: "Lakeview", provider_name: "Dr. Lake" },
  ];
});

const call = (path: string, token = "admin", method = "GET", body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

describe("HQ legal holds", () => {
  it("gates: anyone signed in with audit_read may list, only provider_manage may place or lift", async () => {
    expect((await call("/hq/legal-holds", "nobody")).status).toBe(401);
    expect((await call("/hq/legal-holds", "viewer")).status).toBe(200);
    expect((await call("/hq/legal-holds", "viewer", "POST", { targetKind: "patient", targetId: PATIENT, reason: "Subpoena" })).status).toBe(403);
    expect((await call(`/hq/legal-holds/${fakeUuid(51)}/lift`, "viewer", "POST", { reason: "Closed" })).status).toBe(403);
    expect(state.holds).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("places a hold on a patient and on an office, names them, resolves the office, and audits each", async () => {
    let res = await call("/hq/legal-holds", "admin", "POST", { targetKind: "patient", targetId: PATIENT, reason: "  Litigation hold: Doe v. Northside  " });
    expect(res.status).toBe(200);
    const patientHold = (await res.json() as { hold: Record<string, unknown> }).hold;
    expect(patientHold).toMatchObject({
      targetKind: "patient", targetId: PATIENT, targetLabel: "Pat Held", providerId: "office-1",
      reason: "Litigation hold: Doe v. Northside", placedBy: "hq-admin", placedByName: "Dana HQ", active: true, liftedAt: null, liftedByName: null,
    });

    res = await call("/hq/legal-holds", "admin", "POST", { targetKind: "provider", targetId: "office-2", reason: "Regulator inquiry" });
    expect(res.status).toBe(200);
    const officeHold = (await res.json() as { hold: Record<string, unknown> }).hold;
    expect(officeHold).toMatchObject({ targetKind: "provider", targetId: "office-2", targetLabel: "Lakeview", providerId: "office-2", active: true });

    // Placing again on an active target is idempotent (same hold back, no duplicate row).
    res = await call("/hq/legal-holds", "admin", "POST", { targetKind: "patient", targetId: PATIENT, reason: "Duplicate request" });
    expect((await res.json() as { hold: { id: string } }).hold.id).toBe(patientHold.id);
    expect(state.holds).toHaveLength(2);

    expect(state.audits).toEqual([
      expect.objectContaining({ p_action: "legal_hold_placed", p_actor_user_id: "hq-admin", p_actor_kind: "hq", p_provider_id: "office-1", p_target_kind: "patient", p_target_id: PATIENT, p_metadata: { holdId: patientHold.id, targetKind: "patient" } }),
      expect.objectContaining({ p_action: "legal_hold_placed", p_provider_id: "office-2", p_target_kind: "provider_account", p_target_id: "office-2", p_metadata: { holdId: officeHold.id, targetKind: "provider" } }),
      expect.objectContaining({ p_action: "legal_hold_placed", p_target_id: PATIENT }),
    ]);
    // The free-text reason never rides audit metadata.
    for (const audit of state.audits) expect(Object.keys(audit.p_metadata as object).sort()).toEqual(["holdId", "targetKind"]);
  });

  it("rejects a missing or too-short reason, a bad kind, and unknown targets", async () => {
    expect((await call("/hq/legal-holds", "admin", "POST", { targetKind: "patient", targetId: PATIENT })).status).toBe(400);
    expect((await call("/hq/legal-holds", "admin", "POST", { targetKind: "patient", targetId: PATIENT, reason: "no" })).status).toBe(400);
    expect((await call("/hq/legal-holds", "admin", "POST", { targetKind: "staff", targetId: PATIENT, reason: "Subpoena" })).status).toBe(400);
    expect((await call("/hq/legal-holds", "admin", "POST", { targetKind: "patient", targetId: "not-a-uuid", reason: "Subpoena" })).status).toBe(404);
    expect((await call("/hq/legal-holds", "admin", "POST", { targetKind: "patient", targetId: fakeUuid(999), reason: "Subpoena" })).status).toBe(404);
    expect((await call("/hq/legal-holds", "admin", "POST", { targetKind: "provider", targetId: "office-9", reason: "Subpoena" })).status).toBe(404);
    expect(state.holds).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("lists active holds by default (newest first), filters by office and lifted state, and counts active holds", async () => {
    await call("/hq/legal-holds", "admin", "POST", { targetKind: "patient", targetId: PATIENT, reason: "Subpoena" });
    await call("/hq/legal-holds", "admin", "POST", { targetKind: "patient", targetId: OTHER_PATIENT, reason: "Complaint" });
    await call("/hq/legal-holds", "admin", "POST", { targetKind: "provider", targetId: "office-1", reason: "Audit" });
    state.holds[1].placed_at = "2026-09-18T00:00:00.000Z";
    state.holds[1].lifted_at = "2026-09-19T00:00:00.000Z";
    state.holds[1].lifted_by = "hq-admin";
    state.holds[1].lift_reason = "Resolved";

    let body = await (await call("/hq/legal-holds", "viewer")).json() as { holds: Array<Record<string, unknown>>; activeCount: number };
    expect(body.activeCount).toBe(2);
    expect(body.holds.map((h) => [h.targetKind, h.targetId, h.providerId])).toEqual([["patient", PATIENT, "office-1"], ["provider", "office-1", "office-1"]]);

    body = await (await call("/hq/legal-holds?status=lifted", "viewer")).json() as typeof body;
    expect(body.holds).toHaveLength(1);
    expect(body.holds[0]).toMatchObject({ targetId: OTHER_PATIENT, active: false, liftedByName: "Dana HQ", liftReason: "Resolved" });

    body = await (await call("/hq/legal-holds?status=all&providerId=office-2", "viewer")).json() as typeof body;
    expect(body.holds.map((h) => h.targetId)).toEqual([OTHER_PATIENT]);
    body = await (await call("/hq/legal-holds?providerId=office-1", "viewer")).json() as typeof body;
    expect(body.holds).toHaveLength(2);

    expect((await call("/hq/legal-holds?status=bogus", "viewer")).status).toBe(400);
    state.failNext = { status: 503, json: null };
    expect((await call("/hq/legal-holds", "viewer")).status).toBe(502);
  });

  it("lifts a hold once with a reason, audits it separately, and refuses a second lift or an unknown id", async () => {
    const placed = (await (await call("/hq/legal-holds", "admin", "POST", { targetKind: "patient", targetId: PATIENT, reason: "Subpoena" })).json()) as { hold: { id: string } };
    expect((await call(`/hq/legal-holds/${placed.hold.id}/lift`, "admin", "POST", {})).status).toBe(400);
    let res = await call(`/hq/legal-holds/${placed.hold.id}/lift`, "admin", "POST", { reason: "Matter closed" });
    expect(res.status).toBe(200);
    const lifted = (await res.json() as { hold: Record<string, unknown> }).hold;
    expect(lifted).toMatchObject({ id: placed.hold.id, active: false, liftedBy: "hq-admin", liftedByName: "Dana HQ", liftReason: "Matter closed", providerId: "office-1" });
    expect(lifted.liftedAt).toBeTruthy();

    res = await call(`/hq/legal-holds/${placed.hold.id}/lift`, "admin", "POST", { reason: "Again" });
    expect(res.status).toBe(409);
    expect((await call(`/hq/legal-holds/${fakeUuid(77)}/lift`, "admin", "POST", { reason: "Nothing" })).status).toBe(404);
    expect((await call(`/hq/legal-holds/nope/lift`, "admin", "POST", { reason: "Nothing" })).status).toBe(404);

    expect(state.audits.map((a) => a.p_action)).toEqual(["legal_hold_placed", "legal_hold_lifted"]);
    expect(state.audits[1]).toMatchObject({ p_actor_user_id: "hq-admin", p_provider_id: "office-1", p_target_kind: "patient", p_target_id: PATIENT, p_metadata: { holdId: placed.hold.id, targetKind: "patient" } });
  });
});
