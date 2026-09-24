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
let pendingInvitations: Row[] = [];
let lookupState: Row | null = null;
let resendResult: { status: number; body: unknown } = { status: 200, body: null };

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
  process.env.OPERATIONS_APP_URL = "https://operations.test";
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
  pendingInvitations = [];
  lookupState = null;
  resendResult = { status: 200, body: null };
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "api.resend.com") return response({}, resendFails ? 500 : 200);
    if (url.pathname === "/auth/v1/user") return response({ id: "owner-user" });
    if (url.pathname === "/rest/v1/profiles" && url.searchParams.get("select") === "role") {
      return response(profiles);
    }
    if (url.pathname === "/rest/v1/hq_memberships") {
      // The invite duplicate check asks by email; the permission check asks by actor.
      if (url.searchParams.has("email")) return response(duplicates.hq_memberships ?? []);
      return response(members
        .filter((row) => row.auth_user_id === "owner-user")
        .map((row) => ({ department_role: row.role, status: row.status })));
    }
    if (url.pathname === "/rest/v1/hq_invitations") {
      return response(pendingInvitations);
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
    // Verified sign-in phones (covered end to end in security.test.ts).
    if (table === "staff_second_factors") return response([]);
    if (url.pathname === "/auth/v1/admin/users" && (!init?.method || init.method === "GET")) {
      // GoTrue's targeted filter: only the asked-for address may come back.
      const filter = (url.searchParams.get("filter") ?? "").toLowerCase();
      const users = (duplicates.auth ?? []).filter((row) =>
        !filter || String(row.email ?? "").toLowerCase().includes(filter));
      return response({ users });
    }
    if (url.pathname.endsWith("/rpc/hq_invite_team_member_v2")) {
      rpcCalls.push(url.pathname);
      const body = JSON.parse(String(init?.body)) as Row;
      const row = {
        id: "new-member", name: body.p_name, email: body.p_email, title: body.p_title,
        role: body.p_role, status: "invited", auth_user_id: null, invited_at: "2026-02-01",
      };
      setupInvites.set(String(body.p_token_hash), row);
      members.push(row);
      return response(row, 201);
    }
    if (url.pathname.endsWith("/rpc/hq_resend_team_invitation")) {
      rpcCalls.push(url.pathname);
      if (resendResult.status >= 300) return response(resendResult.body, resendResult.status);
      const body = JSON.parse(String(init?.body)) as Row;
      const target = members.find((row) => row.id === body.p_member_id);
      if (!target) return response({ message: "HQ teammate not found." }, 400);
      target.status = "invited";
      setupInvites.set(String(body.p_token_hash), target);
      return response(target);
    }
    if (url.pathname.endsWith("/rpc/hq_lookup_team_invitation")) {
      rpcCalls.push(url.pathname);
      return response(lookupState ?? { state: "unknown" });
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
    invitationExpiresAt: null, secondFactorPhone: null,
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

  it("rejects duplicates before durable work, naming the record that holds the email", async () => {
    duplicates.auth = [{ id: "existing", email: "taken@example.com" }];
    const result = await api("/hq-team", {
      method: "POST",
      body: JSON.stringify({ name: "Taken", email: "TAKEN@example.com", title: "", role: "Support" }),
    });
    expect(result.status).toBe(409);
    expect((await result.json() as Row).error).toMatch(/login record/i);
    expect(rpcCalls).toEqual([]);

    duplicates.auth = [];
    duplicates.patients = [{ id: "p1" }];
    const patient = await api("/hq-team", {
      method: "POST",
      body: JSON.stringify({ name: "Taken", email: "taken@example.com", title: "", role: "Support" }),
    });
    expect((await patient.json() as Row).error).toMatch(/patient record/i);
  });

  it("asks GoTrue for the one invited address instead of walking the directory", async () => {
    duplicates.auth = [{ id: "other", email: "someone-else@example.com" }];
    const result = await api("/hq-team", {
      method: "POST",
      body: JSON.stringify({ name: "New Person", email: "new@example.com", title: "", role: "Support" }),
    });
    expect(result.status).toBe(201);
    const authCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([input]) => String(input).includes("/auth/v1/admin/users"));
    expect(authCalls).toHaveLength(1);
    expect(String(authCalls[0][0])).toContain("filter=new%40example.com");
  });

  it("offers a re-send when only a stalled HQ invitation holds the email", async () => {
    duplicates.hq_memberships = [{
      id: "stalled-member", display_name: "Stalled Person", status: "invited",
      auth_user_id: null, activated_at: null,
    }];
    const pending = await api("/hq-team", {
      method: "POST",
      body: JSON.stringify({ name: "Stalled Person", email: "stalled@example.com", title: "", role: "Support" }),
    });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({
      resendable: { memberId: "stalled-member", state: "pending" },
    });
    expect(rpcCalls).toEqual([]);

    duplicates.hq_memberships[0].status = "revoked";
    const cancelled = await api("/hq-team", {
      method: "POST",
      body: JSON.stringify({ name: "Stalled Person", email: "stalled@example.com", title: "", role: "Support" }),
    });
    expect(await cancelled.json()).toMatchObject({ resendable: { state: "cancelled" } });

    // A membership that once signed in is not recoverable by re-sending.
    duplicates.hq_memberships[0].auth_user_id = "old-user";
    const former = await api("/hq-team", {
      method: "POST",
      body: JSON.stringify({ name: "Stalled Person", email: "stalled@example.com", title: "", role: "Support" }),
    });
    const body = await former.json() as Row;
    expect(body.resendable).toBeUndefined();
    expect(body.error).toMatch(/former HQ team/i);
  });

  it("passes a database refusal through instead of a house message", async () => {
    duplicates.hq_memberships = [];
    resendResult = { status: 400, body: { message: "Choose an inviteable HQ role." } };
    const result = await api("/hq-team/admin-member/invitations/resend", { method: "POST" });
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: "Choose an inviteable HQ role.", source: "database" });
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
    expect(inviteBody.p_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(inviteBody).not.toHaveProperty("p_setup_token");
    expect(Date.parse(String(inviteBody.p_expires_at))).toBeGreaterThan(Date.now());
  });

  it("emails a working setup link carrying the plaintext token and the stored expiry", async () => {
    const result = await api("/hq-team", {
      method: "POST",
      body: JSON.stringify({ name: "New Person", email: "new@example.com", title: "Support", role: "Support" }),
    });
    expect(await result.json()).toMatchObject({ invitation: "sent" });
    const emailCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .find(([input]) => String(input).includes("api.resend.com"));
    const email = JSON.parse(String(emailCall?.[1]?.body)) as { html: string; text: string; subject: string };
    const link = email.text.match(/https:\/\/operations\.test\/hq-setup\?token=([A-Za-z0-9_-]+)/);
    expect(link).not.toBeNull();
    // The stored digest is what the database holds; the emailed token is its preimage.
    const hash = crypto.createHash("sha256").update(decodeURIComponent(link![1])).digest("hex");
    expect(setupInvites.has(hash)).toBe(true);
    expect(email.html).toContain("Set up your THINNR account");
    expect(email.html).toContain("This link expires on");
  });

  it("re-sends a stalled invitation with a new token and a fresh email", async () => {
    members.push({
      id: "stalled-member", auth_user_id: null, name: "Stalled Person",
      email: "stalled@example.com", role: "support", status: "invited", title: "",
    });
    const result = await api("/hq-team/stalled-member/invitations/resend", { method: "POST" });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ invitation: "sent", member: { id: "stalled-member" } });
    expect(rpcCalls).toEqual(["/rest/v1/rpc/hq_resend_team_invitation"]);
    expect(setupInvites.size).toBe(1);
  });

  it("cancels a pending invitation but refuses to cancel a joined teammate", async () => {
    members.push({
      id: "stalled-member", auth_user_id: null, name: "Stalled Person",
      email: "stalled@example.com", role: "support", status: "invited", title: "",
    });
    const joined = await api("/hq-team/admin-member/invitations/cancel", { method: "POST" });
    expect(joined.status).toBe(409);
    expect((await joined.json() as Row).error).toMatch(/already joined/i);
    expect(rpcCalls).toEqual([]);

    const cancelled = await api("/hq-team/stalled-member/invitations/cancel", { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(rpcCalls).toEqual(["/rest/v1/rpc/hq_revoke_team_member"]);
  });

  it("dates pending invitations on the roster", async () => {
    members.push({
      id: "stalled-member", auth_user_id: null, name: "Stalled Person",
      email: "stalled@example.com", role: "support", status: "invited", title: "",
    });
    pendingInvitations = [{ membership_id: "stalled-member", expires_at: "2026-10-01T12:00:00Z" }];
    const result = await api("/hq-team");
    const roster = (await result.json() as { members: Row[] }).members;
    expect(roster.find((row) => row.id === "stalled-member")?.invitationExpiresAt).toBe("2026-10-01T12:00:00Z");
    expect(roster.find((row) => row.id === "admin-member")?.invitationExpiresAt).toBeNull();
  });

  async function lookup(token: string) {
    return originalFetch(`${baseUrl}/hq-team/invitation/lookup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  }

  it("returns the invitee's identity for a live token", async () => {
    lookupState = {
      state: "pending", name: "Stalled Person", email: "stalled@example.com",
      role: "support", title: "Support", expiresAt: "2026-10-01T12:00:00Z",
    };
    const result = await lookup("a-token");
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      state: "pending", name: "Stalled Person", email: "stalled@example.com",
      role: "Support", title: "Support", expiresAt: "2026-10-01T12:00:00Z",
    });
  });

  it("gives every dead token its own state and no identity", async () => {
    for (const state of ["used", "cancelled", "expired", "unknown"]) {
      lookupState = { state, name: "Leaked", email: "leaked@example.com" };
      const result = await lookup("a-token");
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ state });
    }
  });

  it("needs no session and never reveals whether an unknown token exists", async () => {
    lookupState = { state: "unknown" };
    const blank = await originalFetch(`${baseUrl}/hq-team/invitation/lookup`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    expect(blank.status).toBe(200);
    expect(await blank.json()).toEqual({ state: "unknown" });
  });

  it("rate-limits repeated token guesses", async () => {
    lookupState = { state: "unknown" };
    let limited = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await lookup(`guess-${attempt}`);
      if (result.status === 429) limited += 1;
      await result.json();
    }
    expect(limited).toBeGreaterThan(0);
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