/**
 * Office self-service staff administration.
 *
 * The fake PostgREST/GoTrue below emulates the office-scope lookups, the
 * team_members table, the two SQL role/status RPCs (with their last-owner
 * guards), the provisioning writes behind an invitation, and the server-side
 * global sign-out — so authority, lifecycle, fail-closed access, session
 * invalidation, and audit contracts are asserted through the real router.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});

vi.mock("../claim/delivery", () => ({ sendStaffLoginInvitation: vi.fn(async () => undefined) }));

/**
 * The fresh-code gate reads the session id claim of a real JWT and the
 * sign-in ledger; this suite's bearers are opaque fixtures, so the gate is
 * replaced by a switch (security.test.ts proves the real gate end to end).
 * `gate.fresh = false` makes every gated route answer 401 reauth_required.
 */
const gate = vi.hoisted(() => ({ fresh: true, calls: 0 }));
vi.mock("../auth/fresh-code", async () => {
  const actual = await vi.importActual<typeof import("../auth/fresh-code")>("../auth/fresh-code");
  return {
    ...actual,
    requireFreshCode: async (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
      gate.calls += 1;
      if (gate.fresh) return true;
      res.status(401).json({ error: actual.REAUTH_REQUIRED_MESSAGE, code: actual.REAUTH_REQUIRED_CODE, windowMinutes: actual.FRESH_CODE_WINDOW_MINUTES });
      return false;
    },
  };
});


import teamRouter, { OWNERS_ONLY_MESSAGE, SELF_EDIT_MESSAGE, TEAM_MANAGERS_ONLY_MESSAGE } from "./office-team";
import rosterRouter from "./office-roster";
import { STAFF_DEACTIVATED_MESSAGE } from "../auth/office-scope";

type Row = Record<string, unknown>;
const originalFetch = global.fetch;
let server: http.Server;
let baseUrl = "";

let authUsers: Record<string, string> = {};
let providers: Row[] = [];
let teamMembers: Row[] = [];
let assignments: Row[] = [];
let locks: string[] = [];
let audits: Row[] = [];
let logouts: string[] = [];
let logoutStatus = 204;
let requests: string[] = [];

const OWNER_TM = "11111111-1111-4111-8111-111111111111";
const ADMIN_TM = "22222222-2222-4222-8222-222222222222";
const STAFF_TM = "33333333-3333-4333-8333-333333333333";
const OTHER_TM = "44444444-4444-4444-8444-444444444444";
const DISABLED_TM = "55555555-5555-4555-8555-555555555555";

function response(json: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(json == null ? "" : JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}
function bearerOf(init?: RequestInit): string {
  return String(((init?.headers ?? {}) as Record<string, string>).Authorization ?? "").replace("Bearer ", "");
}
function eq(params: URLSearchParams, key: string, row: Row): boolean {
  const raw = params.get(key);
  if (!raw) return true;
  if (raw === "is.null") return row[key] == null;
  if (raw.startsWith("ilike.")) return String(row[key] ?? "").toLowerCase() === decodeURIComponent(raw.slice(6)).toLowerCase();
  return String(row[key]) === decodeURIComponent(raw.replace(/^eq\./, ""));
}
function matching(rows: Row[], params: URLSearchParams, keys: string[]): Row[] {
  return rows.filter((row) => keys.every((key) => eq(params, key, row)));
}
function activeOwners(providerId: string): number {
  return teamMembers.filter((row) => row.provider_id === providerId && row.office_role === "owner" && row.activation_status !== "disabled").length;
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await originalFetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(teamRouter);
  app.use(rosterRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  global.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  gate.fresh = true;
  gate.calls = 0;
  authUsers = {
    "provider-token": "provider-user",
    "owner-token": "owner-user",
    "admin-token": "admin-user",
    "staff-token": "staff-user",
    "disabled-token": "disabled-user",
    "hq-token": "hq-user",
    "other-token": "other-user",
  };
  providers = [
    { provider_id: "office-1", provider_name: "Dr. Reyes", office_name: "Harbor Med Spa", email: "reyes@harbor.example", access_disabled: false, auth_user_id: "provider-user" },
    { provider_id: "office-2", provider_name: "Dr. Chen", office_name: "Lakeside Clinic", email: "chen@lakeside.example", access_disabled: false, auth_user_id: "other-provider-user" },
  ];
  teamMembers = [
    { id: OWNER_TM, provider_id: "office-1", auth_user_id: "owner-user", activation_status: "activated", office_role: "owner", name: "Olivia Owner", email: "olivia@harbor.example", created_at: "2026-01-02T00:00:00Z", claimed_at: "2026-01-03T00:00:00Z" },
    { id: ADMIN_TM, provider_id: "office-1", auth_user_id: "admin-user", activation_status: "activated", office_role: "admin", name: "Adam Admin", email: "adam@harbor.example", created_at: "2026-01-04T00:00:00Z", claimed_at: "2026-01-05T00:00:00Z" },
    { id: STAFF_TM, provider_id: "office-1", auth_user_id: "staff-user", activation_status: "activated", office_role: "staff", name: "Sam Front Desk", email: "sam@harbor.example", created_at: "2026-01-06T00:00:00Z", claimed_at: "2026-01-07T00:00:00Z" },
    { id: DISABLED_TM, provider_id: "office-1", auth_user_id: "disabled-user", activation_status: "disabled", office_role: "staff", name: "Dana Departed", email: "dana@harbor.example", created_at: "2026-01-08T00:00:00Z", claimed_at: "2026-01-09T00:00:00Z" },
    { id: OTHER_TM, provider_id: "office-2", auth_user_id: "other-user", activation_status: "activated", office_role: "owner", name: "Oscar Other", email: "oscar@lakeside.example", created_at: "2026-01-02T00:00:00Z", claimed_at: null },
  ];
  assignments = teamMembers.map((row) => ({ email: row.email, role: "provider_staff", provider_account_code: row.provider_id }));
  locks = [];
  audits = [];
  logouts = [];
  logoutStatus = 204;
  requests = [];

  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
    if (url.pathname === "/auth/v1/user") {
      const userId = authUsers[bearerOf(init)];
      return userId ? response({ id: userId }) : response({ message: "bad token" }, 401);
    }
    // Server-side global sign-out: one atomic RPC lists the sessions on the
    // revocation list and deletes them from auth.sessions.
    if (url.pathname === "/rest/v1/rpc/security_revoke_auth_sessions") {
      logouts.push(String(body.p_user_id));
      return response(logoutStatus === 204 ? 1 : null, logoutStatus === 204 ? 200 : logoutStatus);
    }
    if (url.pathname === "/auth/v1/admin/users") return response({ users: [] });
    if (url.pathname === "/rest/v1/practice_launch") return response([{required:false,version:0,completed_at:null}]);
    if (url.pathname === "/rest/v1/providers") return response(matching(providers, url.searchParams, ["auth_user_id", "provider_id", "email"]));
    if (url.pathname === "/rest/v1/team_members") {
      if (method === "GET") return response(matching(teamMembers, url.searchParams, ["auth_user_id", "provider_id", "id", "email"]));
      if (method === "POST") { teamMembers.push({ claimed_at: null, auth_user_id: null, ...body }); return response(null, 201); }
      if (method === "DELETE") { teamMembers = teamMembers.filter((row) => !eq(url.searchParams, "id", row) || !url.searchParams.get("id")); return response(null, 204); }
    }
    if (url.pathname === "/rest/v1/staff_role_assignments") {
      if (method === "GET") return response(matching(assignments, url.searchParams, ["email"]));
      if (method === "POST") { assignments = assignments.filter((row) => row.email !== body.email).concat([body]); return response(null, 201); }
      if (method === "DELETE") { assignments = assignments.filter((row) => !eq(url.searchParams, "email", row)); return response(null, 204); }
    }
    if (url.pathname === "/rest/v1/provider_account_locks") {
      const or = url.searchParams.get("or") ?? "";
      return response(locks.filter((id) => or.includes(`account_id.eq.${id}`)).map((id) => ({ account_id: id })));
    }
    if (url.pathname === "/rest/v1/hq_memberships") {
      if (url.searchParams.get("auth_user_id") === "eq.hq-user") return response([{ department_role: "admin", status: "active", display_name: "Avery HQ" }]);
      return response([]);
    }
    if (url.pathname === "/rest/v1/profiles") return response(url.searchParams.get("id") === "eq.hq-user" ? [{ role: "hq_admin" }] : []);
    if (url.pathname === "/rest/v1/rpc/record_admin_audit_event") { audits.push(body); return response(null, 204); }
    // Mirrors public.office_set_team_member_role / _status incl. the last-owner guards.
    if (url.pathname === "/rest/v1/rpc/office_set_team_member_role") {
      const row = teamMembers.find((candidate) => candidate.id === body.p_member_id);
      if (!row) return response({ message: "Team member not found." }, 400);
      if (row.office_role === "owner" && body.p_role !== "owner" && row.activation_status !== "disabled" && activeOwners(String(row.provider_id)) <= 1) {
        return response({ message: "The last remaining owner cannot be demoted." }, 400);
      }
      row.office_role = body.p_role;
      return response(row);
    }
    if (url.pathname === "/rest/v1/rpc/office_set_team_member_status") {
      const row = teamMembers.find((candidate) => candidate.id === body.p_member_id);
      if (!row) return response({ message: "Team member not found." }, 400);
      if (!body.p_active && row.office_role === "owner" && row.activation_status !== "disabled" && activeOwners(String(row.provider_id)) <= 1) {
        return response({ message: "The last remaining owner cannot be deactivated." }, 400);
      }
      row.activation_status = body.p_active ? "activated" : "disabled";
      if (body.p_active) assignments = assignments.filter((a) => a.email !== row.email).concat([{ email: row.email, role: "provider_staff", provider_account_code: row.provider_id }]);
      else assignments = assignments.filter((a) => a.email !== row.email);
      return response(row);
    }
    if (url.pathname === "/rest/v1/rpc/provider_patient_activity_summary") return response([]);
    if (url.pathname === "/rest/v1/rpc/provider_outreach_states") return response([]);
    if (url.pathname === "/rest/v1/patients") return response([]);
    if (url.pathname === "/rest/v1/patient_operational_follow_ups") return response([]);
    if (url.pathname === "/rest/v1/patient_deletion_requests") return response([]);
    if (url.pathname === "/rest/v1/patient_tombstones") return response([]);
    if (url.pathname === "/rest/v1/patient_medications") return response([]);
    if (url.pathname === "/rest/v1/patient_medication_dose_logs") return response([]);
    // Second-factor phones are covered end to end in security.test.ts; here
    // nobody has one on file.
    if (url.pathname === "/rest/v1/staff_second_factors") return response([]);
    throw new Error(`unexpected ${method} ${url.pathname}${url.search}`);
  }) as typeof fetch;
});

describe("GET /office/team", () => {
  it("lists the account holder plus every teammate with role and status, marking the caller", async () => {
    const res = await call("GET", "/office/team", "admin-token");
    expect(res.status).toBe(200);
    const body = res.json as { office: Row; me: Row; accountOwner: Row; members: Row[] };
    expect(body.office).toEqual({ id: "office-1", name: "Harbor Med Spa" });
    expect(body.me).toEqual({ role: "admin", kind: "team_member", teamMemberId: ADMIN_TM });
    expect(body.accountOwner).toEqual({ name: "Dr. Reyes", email: "reyes@harbor.example", status: "active", secondFactorPhone: null });
    expect(body.members.map((m) => [m.id, m.role, m.status, m.isSelf])).toEqual([
      [OWNER_TM, "owner", "active", false],
      [ADMIN_TM, "admin", "active", true],
      [STAFF_TM, "staff", "active", false],
      [DISABLED_TM, "staff", "disabled", false],
    ]);
    // Nothing from the other office leaks into the list.
    expect(body.members.some((m) => m.id === OTHER_TM)).toBe(false);
  });

  it("treats the account holder as an owner", async () => {
    const res = await call("GET", "/office/team", "provider-token");
    expect(res.status).toBe(200);
    expect((res.json as { me: Row }).me).toEqual({ role: "owner", kind: "provider", teamMemberId: null });
  });

  it("refuses staff-role teammates and records the denial", async () => {
    const res = await call("GET", "/office/team", "staff-token");
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe(TEAM_MANAGERS_ONLY_MESSAGE);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ p_action: "access_denied", p_actor_user_id: "staff-user", p_provider_id: "office-1", p_target_kind: "route" });
    expect(audits[0].p_metadata).toMatchObject({ reason: "permission", route: "/office/team", method: "GET", status: 403 });
  });

  it("fails closed for a deactivated teammate on every office route", async () => {
    const team = await call("GET", "/office/team", "disabled-token");
    expect(team.status).toBe(403);
    expect(team.json?.error).toBe(STAFF_DEACTIVATED_MESSAGE);
    const roster = await call("GET", "/office/roster", "disabled-token");
    expect(roster.status).toBe(403);
    expect(roster.json?.error).toBe(STAFF_DEACTIVATED_MESSAGE);
    // No data query ran for either request.
    expect(requests.filter((r) => r.includes("/rest/v1/rpc/provider_patient_activity_summary"))).toHaveLength(0);
    expect(audits.every((row) => row.p_action === "access_denied" && (row.p_metadata as Row).reason === "deactivated")).toBe(true);
    expect(audits).toHaveLength(2);
  });

  it("lets HQ provider managers drill into a named office", async () => {
    const res = await call("GET", "/office/team?office=office-2", "hq-token");
    expect(res.status).toBe(200);
    const body = res.json as { office: Row; me: Row; members: Row[] };
    expect(body.office.name).toBe("Lakeside Clinic");
    expect(body.me.role).toBe("owner");
    expect(body.members.map((m) => m.id)).toEqual([OTHER_TM]);
  });
});

describe("POST /office/team/invitations", () => {
  it("provisions a teammate with the chosen role and audits it", async () => {
    const res = await call("POST", "/office/team/invitations", "owner-token", { firstName: "Nina", lastName: "New", email: "Nina@Harbor.example", role: "admin" });
    expect(res.status).toBe(201);
    const member = (res.json as { member: Row }).member;
    expect(member).toMatchObject({ name: "Nina New", email: "nina@harbor.example", role: "admin", status: "invited", isSelf: false });
    const row = teamMembers.find((r) => r.id === member.id);
    expect(row).toMatchObject({ provider_id: "office-1", office_role: "admin", activation_status: "activated" });
    expect(assignments.find((a) => a.email === "nina@harbor.example")).toMatchObject({ role: "provider_staff", provider_account_code: "office-1" });
    expect(audits.filter((a) => a.p_action === "office_team_invited")).toHaveLength(1);
    expect(audits[0]).toMatchObject({ p_target_kind: "team_member", p_target_id: member.id, p_provider_id: "office-1" });
    expect(audits[0].p_metadata).toEqual({ role: "admin" });
  });

  it("only owners may invite another owner; admins get a plain refusal", async () => {
    const res = await call("POST", "/office/team/invitations", "admin-token", { firstName: "Nina", lastName: "New", email: "nina@harbor.example", role: "owner" });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe(OWNERS_ONLY_MESSAGE);
    expect(teamMembers.some((r) => r.email === "nina@harbor.example")).toBe(false);
  });

  it("rejects a duplicate email with the field named", async () => {
    const res = await call("POST", "/office/team/invitations", "owner-token", { firstName: "Sam", lastName: "Again", email: "sam@harbor.example", role: "staff" });
    expect(res.status).toBe(409);
    expect(res.json?.field).toBe("email");
  });

  it("validates the form and names the offending field", async () => {
    const res = await call("POST", "/office/team/invitations", "owner-token", { firstName: "", lastName: "New", email: "nope", role: "staff" });
    expect(res.status).toBe(400);
    expect(res.json?.field).toBe("firstName");
  });
});

describe("PATCH /office/team/:memberId", () => {
  it("changes a role and audits from/to", async () => {
    const res = await call("PATCH", `/office/team/${STAFF_TM}`, "admin-token", { role: "admin" });
    expect(res.status).toBe(200);
    expect((res.json as { member: Row }).member).toMatchObject({ id: STAFF_TM, role: "admin", status: "active" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ p_action: "office_team_role_changed", p_target_id: STAFF_TM, p_actor_user_id: "admin-user" });
    expect(audits[0].p_metadata).toEqual({ from: "staff", to: "admin" });
  });

  it("refuses to demote the last remaining owner", async () => {
    const res = await call("PATCH", `/office/team/${OWNER_TM}`, "provider-token", { role: "staff" });
    expect(res.status).toBe(409);
    expect(res.json?.error).toMatch(/last remaining owner/i);
    expect(teamMembers.find((r) => r.id === OWNER_TM)?.office_role).toBe("owner");
    expect(audits).toHaveLength(0);
  });

  it("demotes an owner once another active owner exists", async () => {
    teamMembers.find((r) => r.id === ADMIN_TM)!.office_role = "owner";
    const res = await call("PATCH", `/office/team/${OWNER_TM}`, "provider-token", { role: "admin" });
    expect(res.status).toBe(200);
    expect(teamMembers.find((r) => r.id === OWNER_TM)?.office_role).toBe("admin");
  });

  it("admins cannot touch owners in either direction", async () => {
    const demote = await call("PATCH", `/office/team/${OWNER_TM}`, "admin-token", { role: "staff" });
    expect(demote.status).toBe(403);
    expect(demote.json?.error).toBe(OWNERS_ONLY_MESSAGE);
    const promote = await call("PATCH", `/office/team/${STAFF_TM}`, "admin-token", { role: "owner" });
    expect(promote.status).toBe(403);
    expect(promote.json?.error).toBe(OWNERS_ONLY_MESSAGE);
  });

  it("nobody edits their own row", async () => {
    const res = await call("PATCH", `/office/team/${ADMIN_TM}`, "admin-token", { role: "staff" });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe(SELF_EDIT_MESSAGE);
  });

  it("cannot reach a teammate from another office", async () => {
    const res = await call("PATCH", `/office/team/${OTHER_TM}`, "owner-token", { role: "staff" });
    expect(res.status).toBe(404);
    expect(teamMembers.find((r) => r.id === OTHER_TM)?.office_role).toBe("owner");
  });

  it("rejects unknown roles and a staff caller", async () => {
    expect((await call("PATCH", `/office/team/${STAFF_TM}`, "owner-token", { role: "superuser" })).status).toBe(400);
    expect((await call("PATCH", `/office/team/${ADMIN_TM}`, "staff-token", { role: "staff" })).status).toBe(403);
  });
});

describe("fresh-code gate", () => {
  it("refuses role changes, deactivation and forced sign-out without a fresh code; reactivation and same-role edits stay open", async () => {
    gate.fresh = false;
    const role = await call("PATCH", `/office/team/${STAFF_TM}`, "admin-token", { role: "admin" });
    expect(role.status).toBe(401);
    expect(role.json).toMatchObject({ code: "reauth_required", windowMinutes: 10 });
    const deactivate = await call("POST", `/office/team/${STAFF_TM}/deactivate`, "owner-token");
    expect(deactivate.status).toBe(401);
    const signOut = await call("POST", `/office/team/${STAFF_TM}/sign-out`, "admin-token");
    expect(signOut.status).toBe(401);
    expect(audits).toHaveLength(0);
    expect(logouts).toEqual([]);
    expect(teamMembers.find((r) => r.id === STAFF_TM)).toMatchObject({ office_role: "staff", activation_status: "activated" });

    const sameRole = await call("PATCH", `/office/team/${STAFF_TM}`, "admin-token", { role: "staff" });
    expect(sameRole.status).toBe(200);
    const reactivate = await call("POST", `/office/team/${DISABLED_TM}/reactivate`, "admin-token");
    expect(reactivate.status).toBe(200);
  });

  it("a staff-role caller is refused before the gate is consulted", async () => {
    gate.fresh = false;
    const res = await call("PATCH", `/office/team/${STAFF_TM}`, "staff-token", { role: "admin" });
    expect(res.status).toBe(403);
    expect(gate.calls).toBe(0);
  });
});

describe("deactivate / reactivate / sign-out", () => {
  it("deactivates, drops the role assignment, signs the user out everywhere, and audits", async () => {
    const res = await call("POST", `/office/team/${STAFF_TM}/deactivate`, "owner-token");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ member: { id: STAFF_TM, status: "disabled" }, sessionInvalidation: "complete" });
    expect(teamMembers.find((r) => r.id === STAFF_TM)?.activation_status).toBe("disabled");
    expect(assignments.some((a) => a.email === "sam@harbor.example")).toBe(false);
    expect(logouts).toEqual(["staff-user"]);
    expect(audits[0]).toMatchObject({ p_action: "office_team_deactivated", p_target_id: STAFF_TM });
    expect(audits[0].p_metadata).toEqual({ role: "staff", status: "disabled" });

    // Their next request fails closed.
    const next = await call("GET", "/office/roster", "staff-token");
    expect(next.status).toBe(403);
    expect(next.json?.error).toBe(STAFF_DEACTIVATED_MESSAGE);
  });

  it("reports a session sign-out outage without undoing the deactivation", async () => {
    logoutStatus = 500;
    const res = await call("POST", `/office/team/${STAFF_TM}/deactivate`, "owner-token");
    expect(res.status).toBe(200);
    expect(res.json?.sessionInvalidation).toBe("failed");
    expect(teamMembers.find((r) => r.id === STAFF_TM)?.activation_status).toBe("disabled");
  });

  it("refuses to deactivate the last remaining owner", async () => {
    const res = await call("POST", `/office/team/${OWNER_TM}/deactivate`, "provider-token");
    expect(res.status).toBe(409);
    expect(res.json?.error).toMatch(/last remaining owner/i);
    expect(logouts).toEqual([]);
  });

  it("reactivates without re-provisioning and restores the assignment", async () => {
    const res = await call("POST", `/office/team/${DISABLED_TM}/reactivate`, "admin-token");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ member: { id: DISABLED_TM, status: "active" }, sessionInvalidation: "not_applicable" });
    expect(assignments.find((a) => a.email === "dana@harbor.example")).toMatchObject({ provider_account_code: "office-1" });
    expect(requests.filter((r) => r === "POST /rest/v1/team_members")).toHaveLength(0);
    expect(audits[0]).toMatchObject({ p_action: "office_team_reactivated", p_target_id: DISABLED_TM });

    const next = await call("GET", "/office/roster", "disabled-token");
    expect(next.status).toBe(200);
  });

  it("is idempotent when the status already matches", async () => {
    const res = await call("POST", `/office/team/${DISABLED_TM}/deactivate`, "owner-token");
    expect(res.status).toBe(200);
    expect(res.json?.sessionInvalidation).toBe("not_applicable");
    expect(audits).toHaveLength(0);
    expect(logouts).toEqual([]);
  });

  it("forces a sign-out while keeping access on", async () => {
    const res = await call("POST", `/office/team/${STAFF_TM}/sign-out`, "admin-token");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ member: { id: STAFF_TM, status: "active" }, sessionInvalidation: "complete" });
    expect(logouts).toEqual(["staff-user"]);
    expect(audits[0]).toMatchObject({ p_action: "office_team_signed_out", p_target_id: STAFF_TM });
    expect(teamMembers.find((r) => r.id === STAFF_TM)?.activation_status).toBe("activated");
  });

  it("sign-out surfaces a session-end failure instead of claiming success", async () => {
    logoutStatus = 500;
    const res = await call("POST", `/office/team/${STAFF_TM}/sign-out`, "admin-token");
    expect(res.status).toBe(502);
    expect(audits).toHaveLength(0);
  });

  it("guards self, owner, cross-office, and staff callers on status routes", async () => {
    expect((await call("POST", `/office/team/${ADMIN_TM}/deactivate`, "admin-token")).json?.error).toBe(SELF_EDIT_MESSAGE);
    expect((await call("POST", `/office/team/${OWNER_TM}/sign-out`, "admin-token")).json?.error).toBe(OWNERS_ONLY_MESSAGE);
    expect((await call("POST", `/office/team/${OTHER_TM}/deactivate`, "owner-token")).status).toBe(404);
    expect((await call("POST", `/office/team/${STAFF_TM}/sign-out`, "staff-token")).status).toBe(403);
    expect(logouts).toEqual([]);
  });

  it("locked offices cannot manage their team", async () => {
    locks = ["office-1"];
    const res = await call("POST", `/office/team/${STAFF_TM}/deactivate`, "owner-token");
    expect(res.status).toBe(403);
    expect(logouts).toEqual([]);
  });
});
