import crypto from "node:crypto";
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import router, { createSetupToken, safeguardMutation } from "./hq-team";

type Row = Record<string, unknown>;
const originalFetch = global.fetch;
let server: http.Server;
let baseUrl = "";
let members: Row[] = [];
let profiles: Row[] = [];
let duplicates: Record<string, Row[]> = {};
let rpcCalls: string[] = [];
let logoutCalls: string[] = [];
let resendFails = false;
let logoutFails = false;
let setupInvites = new Map<string, Row>();

function response(json: unknown, status = 200): Response {
  return new Response(json == null ? "" : JSON.stringify(json), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeAll(async () => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.CLAIM_EMAIL_DELIVERY_MODE = "live";
  process.env.RESEND_API_KEY = "resend";
  process.env.CLAIM_EMAIL_FROM = "THINNR <test@thinnr.test>";
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  global.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  gate.fresh = true;
  gate.calls = 0;
  members = [
    {
      id: "owner-member", auth_user_id: "owner-user", name: "Owner", email: "owner@example.com",
      role: "super_admin", status: "active", title: "CEO", created_at: "2026-01-01",
    },
    {
      id: "admin-member", auth_user_id: "admin-user", name: "Admin", email: "admin@example.com",
      role: "admin", status: "active", title: "Ops", created_at: "2026-01-02",
    },
  ];
  profiles = [{ id: "owner-user", role: "hq_admin" }];
  duplicates = {};
  rpcCalls = [];
  logoutCalls = [];
  resendFails = false;
  logoutFails = false;
  setupInvites = new Map();
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "api.resend.com") return response({}, resendFails ? 500 : 200);
    if (url.pathname === "/auth/v1/user") return response({ id: "owner-user" });
    if (url.pathname === "/rest/v1/profiles" && url.searchParams.get("select") === "role") {
      return response(profiles);
    }
    if (url.pathname === "/rest/v1/hq_memberships") {
      return response(members
        .filter((row) => row.auth_user_id === "owner-user")
        .map((row) => ({ department_role: row.role, status: row.status })));
    }
    if (url.pathname === "/rest/v1/hq_team_members") {
      if (url.searchParams.has("auth_user_id")) {
        return response(members.filter((row) => row.auth_user_id === "owner-user" && row.status === "active"));
      }
      if (url.searchParams.has("email")) return response(duplicates.hq_team_members ?? []);
      return response(members.filter((row) => row.status !== "revoked"));
    }
    const table = url.pathname.match(/^\/rest\/v1\/([^/]+)$/)?.[1];
    if (table && ["providers", "patients", "team_members", "profiles", "staff_role_assignments"].includes(table)) {
      return response(duplicates[table] ?? []);
    }
    if (url.pathname === "/auth/v1/admin/users" && (!init?.method || init.method === "GET")) {
      return response({ users: duplicates.auth ?? [] });
    }
    if (url.pathname.endsWith("/rpc/hq_invite_team_member_v2")) {
      rpcCalls.push(url.pathname);
      const body = JSON.parse(String(init?.body)) as Row;
      const row = {
        id: "new-member", name: body.p_name, email: body.p_email, title: body.p_title,
        role: body.p_role, status: "invited", auth_user_id: null, invited_at: "2026-02-01",
      };
      setupInvites.set(String(body.p_setup_token_hash), row);
      members.push(row);
      return response(row, 201);
    }
    if (url.pathname.endsWith("/rpc/hq_revoke_team_member")) {
      rpcCalls.push(url.pathname);
      return response({ revoked: true });
    }
    if (url.pathname.endsWith("/rpc/hq_update_team_member")) {
      rpcCalls.push(url.pathname);
      const body = JSON.parse(String(init?.body)) as Row;
      const target = members.find((row) => row.id === body.p_member_id)!;
      if (body.p_title != null) target.title = body.p_title;
      if (body.p_role != null) target.role = body.p_role;
      return response(target);
    }
    // Atomic revoke-and-end RPC (revocation list + auth.sessions delete).
    if (url.pathname === "/rest/v1/rpc/security_revoke_auth_sessions") {
      const p = JSON.parse(String(init?.body)) as Row;
      logoutCalls.push(String(p.p_user_id));
      if (logoutFails) return response({}, 503);
      return response(1);
    }
    throw new Error(`Unexpected fake request: ${url}`);
  }) as typeof fetch;
});

async function api(path: string, init?: RequestInit) {
  return originalFetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: "Bearer valid", "Content-Type": "application/json", ...init?.headers },
  });
}

describe("HQ mutation safeguards", () => {
  const owner = {
    id: "owner", authUserId: "u1", name: "Owner", email: "o@x.test", title: "",
    role: "super_admin" as const, status: "active", invitedAt: null, joinedAt: null,
  };
  const admin = {
    ...owner, id: "admin", authUserId: "u2", email: "a@x.test", role: "admin" as const,
  };

  it("protects self-revocation and self-demotion", () => {
    expect(safeguardMutation({ id: "admin", role: "admin" }, admin, [owner, admin], "revoke"))
      .toMatch(/your own/i);
    expect(safeguardMutation({ id: "admin", role: "admin" }, admin, [owner, admin], "update", "support"))
      .toMatch(/own team-management/i);
  });

  it("protects the sole Super Admin and final administrator", () => {
    expect(safeguardMutation({ id: "owner", role: "super_admin" }, owner, [owner, admin], "update", "admin"))
      .toMatch(/sole Super Admin/i);
    expect(safeguardMutation(
      { id: "other-owner", role: "super_admin" }, owner, [owner], "revoke",
    )).toMatch(/sole Super Admin/i);
  });

  it("prevents an Admin changing a Super Admin", () => {
    expect(safeguardMutation({ id: "admin", role: "admin" }, owner, [owner, admin], "update", "admin"))
      .toMatch(/Only a Super Admin/i);
  });
});

describe("HQ setup token", () => {
  it("uses a 256-bit URL-safe secret and only produces a stable digest for storage", () => {
    const first = createSetupToken();
    const second = createSetupToken();
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.tokenHash).toBe(crypto.createHash("sha256").update(first.token).digest("hex"));
    expect(first.token).not.toBe(second.token);
  });
});

describe("HQ team API", () => {
  it("requires an active durable membership and returns the roster", async () => {
    const ok = await api("/hq-team");
    expect(ok.status).toBe(200);
    expect((await ok.json() as { members: Row[] }).members).toHaveLength(2);

    members[0].status = "revoked";
    const revoked = await api("/hq-team");
    expect(revoked.status).toBe(401);
  });

  it("rejects duplicates before durable work, including Auth", async () => {
    duplicates.auth = [{ id: "existing", email: "taken@example.com" }];
    const result = await api("/hq-team", {
      method: "POST",
      body: JSON.stringify({ name: "Taken", email: "TAKEN@example.com", title: "", role: "Support" }),
    });
    expect(result.status).toBe(409);
    expect(rpcCalls).toEqual([]);
  });

  it("commits first and reports invitation delivery failure honestly", async () => {
    resendFails = true;
    const result = await api("/hq-team", {
      method: "POST",
      body: JSON.stringify({ name: "New Person", email: "new@example.com", title: "Support", role: "Support" }),
    });
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ invitation: "failed", member: { id: "new-member" } });
    expect(rpcCalls).toEqual(["/rest/v1/rpc/hq_invite_team_member_v2"]);
    const inviteCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .find(([input]) => String(input).endsWith("/rpc/hq_invite_team_member_v2"));
    const inviteBody = JSON.parse(String(inviteCall?.[1]?.body)) as Row;
    expect(inviteBody.p_setup_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(inviteBody).not.toHaveProperty("p_setup_token");
  });

  it("no longer exposes the retired password-setup endpoints", async () => {
    const token = createSetupToken();
    const inspect = await originalFetch(`${baseUrl}/hq-team/setup?token=${token.token}`);
    expect(inspect.status).toBe(404);
    const complete = await originalFetch(`${baseUrl}/hq-team/setup/complete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.token, password: "Strong!Pass1", passwordConfirm: "Strong!Pass1" }),
    });
    expect(complete.status).toBe(404);
  });

  it("blocks self-revocation before calling the database", async () => {
    const result = await api("/hq-team/owner-member", { method: "DELETE" });
    expect(result.status).toBe(409);
    expect(rpcCalls).toEqual([]);
  });

  it("gates role changes, revocations and forced sign-outs behind a fresh code, but not a title-only edit", async () => {
    gate.fresh = false;
    const role = await api("/hq-team/admin-member", { method: "PATCH", body: JSON.stringify({ role: "Clinical" }) });
    expect(role.status).toBe(401);
    expect(await role.json()).toMatchObject({ code: "reauth_required" });
    const revoke = await api("/hq-team/admin-member", { method: "DELETE" });
    expect(revoke.status).toBe(401);
    const signOut = await api("/hq-team/admin-member/sign-out", { method: "POST", body: JSON.stringify({ reason: "other" }) });
    expect(signOut.status).toBe(401);
    expect(rpcCalls).toEqual([]);
    expect(logoutCalls).toEqual([]);

    const title = await api("/hq-team/admin-member", { method: "PATCH", body: JSON.stringify({ title: "Clinical lead" }) });
    expect(title.status).toBe(200);
    expect(rpcCalls).toEqual(["/rest/v1/rpc/hq_update_team_member"]);
  });

  it("updates an allowed member through the durable function", async () => {
    const result = await api("/hq-team/admin-member", {
      method: "PATCH",
      body: JSON.stringify({ role: "Clinical", title: "Clinical lead" }),
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      member: { id: "admin-member", role: "clinical", title: "Clinical lead" },
    });
    expect(rpcCalls).toEqual(["/rest/v1/rpc/hq_update_team_member"]);
  });

  it("revokes durably, invalidates sessions, and reports a logout outage", async () => {
    members.push({
      id: "support-member", auth_user_id: "support-user", name: "Support",
      email: "support@example.com", role: "support", status: "active", title: "Support",
    });
    logoutFails = true;
    const result = await api("/hq-team/support-member", { method: "DELETE" });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ revoked: true, sessionInvalidation: "failed" });
    expect(rpcCalls).toEqual(["/rest/v1/rpc/hq_revoke_team_member"]);
    expect(logoutCalls).toEqual(["support-user"]);
  });
});