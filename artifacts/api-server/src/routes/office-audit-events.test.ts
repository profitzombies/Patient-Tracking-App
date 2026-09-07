/**
 * Office-scoped audit trail.
 *
 * A fake PostgREST holds audit rows for two offices plus HQ-only rows, and
 * the lookup tables the name resolver reads. Assertions cover authority
 * (owner/admin only, HQ with audit_read), strict scoping (the other office
 * and HQ-only rows never appear, even when the store misbehaves), name
 * resolution without raw ids, filters, and pagination.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});

import auditRouter, { AUDIT_MANAGERS_ONLY_MESSAGE } from "./office-audit-events";
import { OFFICE_VISIBLE_ACTIONS } from "../lib/audit-events";

type Row = Record<string, unknown>;
const originalFetch = global.fetch;
let server: http.Server;
let baseUrl = "";

let authUsers: Record<string, string> = {};
let auditRows: Row[] = [];
let strayRows: Row[] = [];
let audits: Row[] = [];
let requests: string[] = [];

const ADMIN_TM = "22222222-2222-4222-8222-222222222222";
const STAFF_TM = "33333333-3333-4333-8333-333333333333";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PATIENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const providers: Row[] = [
  { provider_id: "office-1", provider_name: "Dr. Reyes", office_name: "Harbor Med Spa", access_disabled: false, auth_user_id: "provider-user" },
  { provider_id: "office-2", provider_name: "Dr. Chen", office_name: "Lakeside Clinic", access_disabled: false, auth_user_id: "other-provider-user" },
];
const teamMembers: Row[] = [
  { id: ADMIN_TM, provider_id: "office-1", auth_user_id: "admin-user", activation_status: "activated", office_role: "admin", name: "Adam Admin" },
  { id: STAFF_TM, provider_id: "office-1", auth_user_id: "staff-user", activation_status: "activated", office_role: "staff", name: "Sam Front Desk" },
];
const patients: Row[] = [
  { id: PATIENT, first_name: "Casey", last_name: "Ortiz", name: "Casey Ortiz" },
  { id: OTHER_PATIENT, first_name: "Riley", last_name: "Park", name: "Riley Park" },
];
const hqMemberships: Row[] = [{ id: "hq-1", auth_user_id: "hq-user", department_role: "admin", status: "active", display_name: "Avery HQ" }];

function response(json: unknown, status = 200, headers: Record<string, string> = {}): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json", ...headers } });
}
function bearerOf(init?: RequestInit): string {
  return String(((init?.headers ?? {}) as Record<string, string>).Authorization ?? "").replace("Bearer ", "");
}
/** A small PostgREST filter interpreter: eq / in / gte / lt / is.null. */
function applyFilters(rows: Row[], params: URLSearchParams): Row[] {
  const skip = new Set(["select", "order", "limit", "offset", "or"]);
  let out = rows;
  for (const [key, raw] of params.entries()) {
    if (skip.has(key)) continue;
    const value = raw;
    out = out.filter((row) => {
      const cell = row[key];
      if (value === "is.null") return cell == null;
      if (value.startsWith("eq.")) return String(cell) === value.slice(3);
      if (value.startsWith("in.(")) {
        const list = value.slice(4, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
        return list.includes(String(cell));
      }
      if (value.startsWith("gte.")) return String(cell) >= value.slice(4);
      if (value.startsWith("lt.")) return String(cell) < value.slice(3);
      throw new Error(`unsupported filter ${key}=${value}`);
    });
  }
  return out;
}

async function call(path: string, token: string) {
  const res = await originalFetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(auditRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  global.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  authUsers = { "provider-token": "provider-user", "admin-token": "admin-user", "staff-token": "staff-user", "hq-token": "hq-user" };
  auditRows = [
    { id: 1, occurred_at: "2026-03-01T10:00:00+00:00", action: "patient_note_added", actor_user_id: "admin-user", actor_kind: "team_member", provider_id: "office-1", target_kind: "patient", target_id: PATIENT, request_id: "req-1", metadata: { noteId: "n-1", body: "should never leak" } },
    { id: 2, occurred_at: "2026-03-02T10:00:00+00:00", action: "office_team_role_changed", actor_user_id: "provider-user", actor_kind: "provider", provider_id: "office-1", target_kind: "team_member", target_id: ADMIN_TM, request_id: null, metadata: { from: "staff", to: "admin" } },
    { id: 3, occurred_at: "2026-03-03T10:00:00+00:00", action: "access_denied", actor_user_id: "staff-user", actor_kind: "team_member", provider_id: "office-1", target_kind: "route", target_id: "GET /office/team", request_id: null, metadata: { reason: "permission", route: "/office/team", method: "GET", status: 403 } },
    { id: 4, occurred_at: "2026-03-04T10:00:00+00:00", action: "patient_status_changed", actor_user_id: "hq-user", actor_kind: "hq", provider_id: "office-1", target_kind: "patient", target_id: PATIENT, request_id: null, metadata: { from: "activated", to: "paused" } },
    // Other office + HQ-only rows must never surface for office-1.
    { id: 5, occurred_at: "2026-03-05T10:00:00+00:00", action: "patient_note_added", actor_user_id: "other-provider-user", actor_kind: "provider", provider_id: "office-2", target_kind: "patient", target_id: OTHER_PATIENT, request_id: null, metadata: { noteId: "n-9" } },
    { id: 6, occurred_at: "2026-03-06T10:00:00+00:00", action: "hq_member_revoked", actor_user_id: "hq-user", actor_kind: "hq", provider_id: null, target_kind: "hq_member", target_id: "hq-2", request_id: null, metadata: {} },
    { id: 7, occurred_at: "2026-03-07T10:00:00+00:00", action: "knowledge_document_deleted", actor_user_id: "hq-user", actor_kind: "hq", provider_id: "office-1", target_kind: "knowledge_document", target_id: "kd-1", request_id: null, metadata: {} },
  ];
  strayRows = [];
  audits = [];
  requests = [];

  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}${url.search}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
    if (url.pathname === "/auth/v1/user") {
      const userId = authUsers[bearerOf(init)];
      return userId ? response({ id: userId }) : response({ message: "bad token" }, 401);
    }
    if (url.pathname === "/rest/v1/providers") return response(applyFilters(providers, url.searchParams));
    if (url.pathname === "/rest/v1/team_members") return response(applyFilters(teamMembers, url.searchParams));
    if (url.pathname === "/rest/v1/patients") return response(applyFilters(patients, url.searchParams));
    if (url.pathname === "/rest/v1/hq_memberships") return response(applyFilters(hqMemberships, url.searchParams));
    if (url.pathname === "/rest/v1/profiles") return response(url.searchParams.get("id") === "eq.hq-user" ? [{ role: "hq_admin" }] : []);
    if (url.pathname === "/rest/v1/provider_account_locks") return response([]);
    if (url.pathname === "/rest/v1/knowledge_documents") return response([]);
    if (url.pathname === "/rest/v1/rpc/record_admin_audit_event") { audits.push(body); return response(null, 204); }
    if (url.pathname === "/rest/v1/admin_audit_events") {
      const filtered = applyFilters(auditRows, url.searchParams).sort((a, b) => Number(b.id) - Number(a.id));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const page = [...filtered.slice(offset, offset + limit), ...strayRows];
      return response(page, 200, { "Content-Range": `${offset}-${offset + page.length - 1}/${filtered.length}` });
    }
    throw new Error(`unexpected ${method} ${url.pathname}${url.search}`);
  }) as typeof fetch;
});

describe("GET /office/audit-events", () => {
  it("returns only this office's events, newest first, with names instead of ids", async () => {
    const res = await call("/office/audit-events", "admin-token");
    expect(res.status).toBe(200);
    const body = res.json as { office: Row; actions: string[]; events: Row[]; total: number };
    expect(body.office).toEqual({ name: "Harbor Med Spa" });
    expect(body.actions).toEqual(OFFICE_VISIBLE_ACTIONS);
    expect(body.total).toBe(4);
    expect(body.events.map((e) => e.id)).toEqual([4, 3, 2, 1]);

    expect(body.events[3]).toEqual({
      id: 1, occurredAt: "2026-03-01T10:00:00+00:00", action: "patient_note_added", actorName: "Adam Admin", actorKind: "team_member",
      targetName: "Patient: Casey Ortiz", targetKind: "patient", metadata: { noteId: "n-1" },
    });
    expect(body.events[2]).toMatchObject({ actorName: "Dr. Reyes", targetName: "Teammate: Adam Admin", metadata: { from: "staff", to: "admin" } });
    expect(body.events[1]).toMatchObject({ action: "access_denied", actorName: "Sam Front Desk", targetName: "Protected route: GET /office/team", metadata: { reason: "permission", status: 403 } });
    expect(body.events[0]).toMatchObject({ actorName: "Avery HQ", actorKind: "hq" });

    // No raw identifiers of any kind in the payload.
    const serialized = JSON.stringify(body);
    for (const raw of ["admin-user", "provider-user", "staff-user", "hq-user", "office-1", "office-2", PATIENT, ADMIN_TM, "req-1", "should never leak"]) {
      expect(serialized).not.toContain(raw);
    }
    // The store was asked for this office only, and only office-visible actions.
    const storeQuery = requests.find((r) => r.includes("/rest/v1/admin_audit_events"))!;
    expect(storeQuery).toContain("provider_id=eq.office-1");
    expect(storeQuery).toContain("action=in.(");
  });

  it("drops stray rows from another office or without an office even if the store returns them", async () => {
    strayRows = [
      { id: 99, occurred_at: "2026-03-09T10:00:00+00:00", action: "patient_note_added", actor_user_id: "other-provider-user", actor_kind: "provider", provider_id: "office-2", target_kind: "patient", target_id: OTHER_PATIENT, metadata: {} },
      { id: 98, occurred_at: "2026-03-09T10:00:00+00:00", action: "hq_member_revoked", actor_user_id: "hq-user", actor_kind: "hq", provider_id: null, target_kind: "hq_member", target_id: "hq-2", metadata: {} },
    ];
    const res = await call("/office/audit-events", "admin-token");
    const body = res.json as { events: Row[] };
    expect(body.events.map((e) => e.id)).toEqual([4, 3, 2, 1]);
    expect(JSON.stringify(body)).not.toContain("Riley");
  });

  it("filters by action and date window, and paginates", async () => {
    const byAction = await call("/office/audit-events?action=patient_note_added", "provider-token");
    expect((byAction.json as { events: Row[] }).events.map((e) => e.id)).toEqual([1]);

    const window = await call("/office/audit-events?from=2026-03-02&to=2026-03-03", "provider-token");
    expect((window.json as { events: Row[] }).events.map((e) => e.id)).toEqual([3, 2]);

    const page1 = await call("/office/audit-events?limit=3", "provider-token");
    expect(page1.json).toMatchObject({ total: 4 });
    expect((page1.json as { events: Row[] }).events.map((e) => e.id)).toEqual([4, 3, 2]);
    const page2 = await call("/office/audit-events?limit=3&offset=3", "provider-token");
    expect((page2.json as { events: Row[] }).events.map((e) => e.id)).toEqual([1]);
  });

  it("rejects an action outside the office allowlist and a backwards window", async () => {
    expect((await call("/office/audit-events?action=hq_member_revoked", "provider-token")).status).toBe(400);
    expect((await call("/office/audit-events?from=2026-03-05&to=2026-03-01", "provider-token")).status).toBe(400);
    expect(requests.some((r) => r.includes("/rest/v1/admin_audit_events"))).toBe(false);
  });

  it("refuses staff-role teammates and records the denial", async () => {
    const res = await call("/office/audit-events", "staff-token");
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe(AUDIT_MANAGERS_ONLY_MESSAGE);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ p_action: "access_denied", p_actor_user_id: "staff-user", p_provider_id: "office-1" });
    expect(audits[0].p_metadata).toMatchObject({ reason: "permission", route: "/office/audit-events", status: 403 });
  });

  it("requires a session", async () => {
    expect((await call("/office/audit-events", "nope")).status).toBe(401);
  });

  it("lets HQ auditors read one named office, never all offices at once", async () => {
    const res = await call("/office/audit-events?office=office-2", "hq-token");
    expect(res.status).toBe(200);
    const body = res.json as { office: Row; events: Row[] };
    expect(body.office).toEqual({ name: "Lakeside Clinic" });
    expect(body.events.map((e) => e.id)).toEqual([5]);
    expect(body.events[0]).toMatchObject({ actorName: "Dr. Chen", targetName: "Patient: Riley Park" });

    const unscoped = await call("/office/audit-events", "hq-token");
    expect(unscoped.status).toBe(400);
  });
});
