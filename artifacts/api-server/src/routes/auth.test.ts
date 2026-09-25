/**
 * Passwordless login + patient signup suite — runs against an in-memory fake
 * of the Supabase REST + GoTrue admin + Twilio/Resend surfaces so the
 * privacy rules (neutral responses, silent caps, fresh lock checks) and the
 * account-creation seams can be exercised deterministically.
 *
 * The claim-flow suite (claim.test.ts) covers the shared ledger mechanics in
 * its own right; this file focuses on what login/signup add on top.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

const FAKE_SUPABASE = "http://fake.supabase.local";

type Row = Record<string, unknown>;

class FakeBackend {
  tables: Record<string, Row[]> = {};
  authUsers = new Map<string, Row>();
  sentEmails: Array<{ to: string; code: string | null }> = [];
  twilioStarts: string[] = [];
  twilioApprovedCode: string | null = null;
  twilioStartFailure: { status: number; code?: number } | null = null;
  deletedUsers: string[] = [];
  adminLogouts: string[] = [];
  audits: Row[] = [];
  failHqAccept = false;
  failProvision = false;
  failRejectedSendSpend = false;
  resendFailure = false;
  onPasswordGrant: (() => void) | null = null;
  /** One-shot hook fired right after the signup email pre-check answers —
   *  simulates a rival signup landing between pre-check and insert. */
  onEmailPrecheck: (() => void) | null = null;
  pauseOnce: { pathPrefix: string; gate: Promise<void> } | null = null;
  /** Passwords GoTrue refuses as breached (422 weak_password, reason pwned). */
  weakPasswords = new Set<string>();
  /** Simulated write failures: PATCH matching the predicate / POST to a table. */
  failPatch: ((table: string, body: Row | null) => boolean) | null = null;
  failPostTables = new Set<string>();

  reset() {
    this.tables = {
      claim_verifications: [],
      patients: [],
      providers: [],
      team_members: [],
      hq_memberships: [],
      hq_invitations: [],
      staff_role_assignments: [],
      provider_account_locks: [],
      profiles: [],
      auth_sign_ins: [],
      account_security_state: [],
      auth_session_revocations: [],
      staff_second_factors: [],
      // Policy singleton: tests start with every second-factor rule OFF and
      // switch the relevant rule on explicitly, so the pre-existing sign-in
      // expectations stay a faithful picture of an uncovered staff member.
      hq_organization_settings: [
        { singleton: true, second_factor_hq_users: false, second_factor_office_managers: false, second_factor_all_staff: false },
      ],
    };
    this.authUsers.clear();
    this.audits = [];
    this.sentEmails = [];
    this.twilioStarts = [];
    this.twilioApprovedCode = null;
    this.twilioStartFailure = null;
    this.deletedUsers = [];
    this.adminLogouts = [];
    this.failHqAccept = false;
    this.failProvision = false;
    this.failRejectedSendSpend = false;
    this.resendFailure = false;
    this.onPasswordGrant = null;
    this.onEmailPrecheck = null;
    this.pauseOnce = null;
    this.weakPasswords = new Set();
    this.failPatch = null;
    this.failPostTables = new Set();
  }

  seedAuthUser(overrides: Row = {}): Row {
    const id = (overrides.id as string | undefined) ?? crypto.randomUUID();
    const user = { id, email: null, phone: null, app_metadata: {}, user_metadata: {}, ...overrides };
    this.authUsers.set(id, user);
    return user;
  }

  private rowMatches(row: Row, [col, op, value]: [string, string, string]): boolean {
    const cell = row[col];
    if (op === "eq") return String(cell ?? "") === value;
    if (op === "ilike") return String(cell ?? "").toLowerCase() === value.toLowerCase();
    if (op === "gt") return typeof cell === "string" && cell > value;
    if (op === "lt") return typeof cell === "string" && cell < value;
    if (op === "is") {
      if (value === "null") return cell === null || cell === undefined;
      if (value === "false") return cell === false;
      if (value === "true") return cell === true;
    }
    throw new Error(`fake: unsupported op ${op}`);
  }

  private matchRows(
    table: string,
    conditions: Array<[string, string, string]>,
    orGroups: Array<Array<[string, string, string]>>,
  ): Row[] {
    return (this.tables[table] ?? []).filter(
      (row) =>
        conditions.every((c) => this.rowMatches(row, c)) &&
        orGroups.every((group) => group.some((c) => this.rowMatches(row, c))),
    );
  }

  private parseQuery(url: URL): {
    conditions: Array<[string, string, string]>;
    orGroups: Array<Array<[string, string, string]>>;
  } {
    const conditions: Array<[string, string, string]> = [];
    const orGroups: Array<Array<[string, string, string]>> = [];
    url.searchParams.forEach((raw, key) => {
      if (key === "select" || key === "order" || key === "limit") return;
      if (key === "or") {
        const inner = raw.replace(/^\(|\)$/g, "");
        orGroups.push(
          inner.split(",").map((clause) => {
            const [col, op, ...rest] = clause.split(".");
            return [col, op, rest.join(".")] as [string, string, string];
          }),
        );
        return;
      }
      const dot = raw.indexOf(".");
      conditions.push([key, raw.slice(0, dot), raw.slice(dot + 1)]);
    });
    return { conditions, orGroups };
  }

  /** Patients-only candidate RPC — staff never resolve through it anymore. */
  private findCandidates(body: { p_kind: string; p_value: string }): Row[] {
    const out: Row[] = [];
    if (body.p_kind === "email") {
      const value = body.p_value.toLowerCase();
      for (const p of this.tables.patients) {
        if (
          String(p.email ?? "").toLowerCase() === value &&
          p.activation_status !== "disabled"
        ) {
          out.push({
            type: "patient",
            ref: String(p.id),
            name: p.name ?? null,
            dob: p.date_of_birth ?? null,
            claimed: Boolean(p.auth_user_id),
            auth_user_id: p.auth_user_id ?? null,
          });
        }
      }
    } else {
      const last10 = body.p_value.replace(/\D/g, "").slice(-10);
      for (const p of this.tables.patients) {
        const digits = String(p.phone ?? "").replace(/\D/g, "");
        if (
          digits.slice(-10) === last10 &&
          digits.length >= 10 &&
          p.activation_status !== "disabled"
        ) {
          out.push({
            type: "patient",
            ref: String(p.id),
            name: p.name ?? null,
            dob: p.date_of_birth ?? null,
            claimed: Boolean(p.auth_user_id),
            auth_user_id: p.auth_user_id ?? null,
          });
        }
      }
    }
    return out;
  }

  private authAdmin(method: string, url: URL, body: Row | null): Response {
    if (method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      const email = String(body?.email ?? "").toLowerCase();
      const user = [...this.authUsers.values()].find((u) => String(u.email ?? "").toLowerCase() === email);
      if (user && user.password === body?.password) {
        const response = json(200, { access_token: "fake-access-token", user });
        const hook = this.onPasswordGrant;
        this.onPasswordGrant = null;
        hook?.();
        return response;
      }
      return json(400, { error: "invalid_grant" });
    }
    if (method === "POST" && url.pathname === "/auth/v1/admin/generate_link") {
      const email = String(body?.email ?? "").toLowerCase();
      const user = [...this.authUsers.values()].find(
        (u) => String(u.email ?? "").toLowerCase() === email,
      );
      if (!user) return json(404, { msg: "User not found" });
      return json(200, {
        hashed_token: `hashed-${email}`,
        properties: { hashed_token: `hashed-${email}` },
      });
    }
    if (method === "POST" && url.pathname === "/auth/v1/admin/users") {
      if (body?.password && this.weakPasswords.has(String(body.password))) {
        return json(422, {
          code: 422,
          error_code: "weak_password",
          msg: "Password is known to be weak and easy to guess, please choose a different one.",
          weak_password: { reasons: ["pwned"] },
        });
      }
      const email = body?.email ? String(body.email).toLowerCase() : null;
      const phone = body?.phone ? String(body.phone) : null;
      for (const user of this.authUsers.values()) {
        if (email && String(user.email ?? "").toLowerCase() === email) {
          return json(422, {
            error_code: "email_exists",
            msg: "A user with this email address has already been registered",
          });
        }
        if (phone && user.phone === phone) {
          return json(422, {
            error_code: "phone_exists",
            msg: "Phone number already registered by another user",
          });
        }
      }
      const id = crypto.randomUUID();
      const user = {
        id,
        email,
        phone,
        app_metadata: body?.app_metadata ?? {},
        user_metadata: body?.user_metadata ?? {},
        password: body?.password ?? null,
      };
      this.authUsers.set(id, user);
      return json(200, user);
    }
    const idMatch = url.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
    if (idMatch && method === "GET") {
      const user = this.authUsers.get(idMatch[1]);
      if (!user) return json(404, { msg: "User not found" });
      return json(200, user);
    }
    if (idMatch && method === "PUT") {
      const user = this.authUsers.get(idMatch[1]);
      if (!user) return json(404, { msg: "User not found" });
      if (body?.password && this.weakPasswords.has(String(body.password))) {
        return json(422, {
          code: 422,
          error_code: "weak_password",
          msg: "Password is known to be weak and easy to guess, please choose a different one.",
          weak_password: { reasons: ["pwned"] },
        });
      }
      Object.assign(user, body);
      return json(200, user);
    }
    if (idMatch && method === "DELETE") {
      this.authUsers.delete(idMatch[1]);
      this.deletedUsers.push(idMatch[1]);
      return json(200, {});
    }
    return json(404, { msg: `fake: no auth route ${method} ${url.pathname}` });
  }

  handle(input: string, init?: RequestInit): Response | Promise<Response> {
    const url = new URL(input);
    // One-shot test gate: park the FIRST request that touches this path
    // until the test releases it — lets a test hold a verify mid-flight to
    // prove concurrent redemptions of the same code cannot both win.
    if (this.pauseOnce && url.pathname.startsWith(this.pauseOnce.pathPrefix)) {
      const gate = this.pauseOnce.gate;
      this.pauseOnce = null;
      return gate.then(() => this.handle(input, init) as Response);
    }
    const method = (init?.method ?? "GET").toUpperCase();
    let body: Row | null = null;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body)) as Row;
      } catch {
        body = null; // form-encoded (Twilio) bodies are read directly below
      }
    }

    if (url.hostname === "verify.twilio.com") {
      if (url.pathname.endsWith("/Verifications")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        this.twilioStarts.push(params.get("To") ?? "");
        if (this.twilioStartFailure) {
          return json(this.twilioStartFailure.status, {
            status: "failed",
            code: this.twilioStartFailure.code,
            message: "sanitized test rejection",
          });
        }
        return json(201, { status: "pending" });
      }
      if (url.pathname.endsWith("/VerificationCheck")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const approved =
          this.twilioApprovedCode !== null && params.get("Code") === this.twilioApprovedCode;
        return json(200, { status: approved ? "approved" : "pending" });
      }
      return json(404, {});
    }
    if (url.hostname === "api.resend.com") {
      const to = Array.isArray(body?.to) ? String(body?.to[0]) : "";
      const code = /code is (\d{6})/.exec(String(body?.text ?? ""))?.[1] ?? null;
      this.sentEmails.push({ to, code });
      return this.resendFailure
        ? json(500, { message: "sanitized test rejection" })
        : json(200, { id: crypto.randomUUID() });
    }

    if (url.pathname.startsWith("/auth/v1/admin/") || url.pathname === "/auth/v1/token") {
      return this.authAdmin(method, url, body);
    }

    if (url.pathname === "/rest/v1/rpc/claim_find_candidates") {
      return json(200, this.findCandidates(body as { p_kind: string; p_value: string }));
    }
    // No live GoTrue sessions are modelled here; the atomic revoke-and-end
    // RPC therefore touches nothing, and the sweep proceeds as before.
    if (url.pathname === "/rest/v1/rpc/record_admin_audit_event") {
      this.audits.push(body as Row);
      return json(200, null);
    }
    if (url.pathname === "/rest/v1/rpc/security_revoke_auth_sessions") {
      this.adminLogouts.push(String((body as Row).p_user_id));
      return json(200, 0);
    }

    if (url.pathname === "/rest/v1/rpc/hq_accept_team_invitation") {
      if (this.failHqAccept) return json(500, { message: "simulated acceptance failure" });
      const p = body as Row;
      const invitation = this.tables.hq_invitations.find(
        (row) => row.token_hash === p.p_token_hash && row.status === "pending",
      );
      if (!invitation) return json(400, { message: "invitation not found" });
      const membership = this.tables.hq_memberships.find(
        (row) => row.id === invitation.membership_id,
      );
      if (!membership) return json(400, { message: "membership not found" });
      invitation.status = "accepted";
      membership.status = "active";
      membership.auth_user_id = p.p_auth_user_id;
      return json(200, { accepted: true });
    }

    if (url.pathname === "/rest/v1/rpc/provision_staff_login") {
      // Mirrors the real atomic provisioning rail: thinnr_provisioned
      // marker, assignment upsert, provider_staff profile upsert (training
      // viewer bookkeeping is not modeled here).
      if (this.failProvision) {
        return json(500, { message: "simulated provisioning failure" });
      }
      const p = body as Row;
      const email = String(p.p_email ?? "").toLowerCase();
      const account = String(p.p_account_code ?? "");
      const user = this.authUsers.get(String(p.p_user_id ?? ""));
      if (!user || !email || !account) return json(400, { message: "bad provision call" });
      const assignment = this.tables.staff_role_assignments.find(
        (row) => String(row.email ?? "").toLowerCase() === email,
      );
      if (assignment && assignment.role !== "provider_staff") {
        return json(400, { message: "conflicting staff assignment" });
      }
      user.app_metadata = { ...(user.app_metadata as Row), thinnr_provisioned: true };
      if (assignment) {
        assignment.provider_account_code = account;
      } else {
        this.tables.staff_role_assignments.push({
          email,
          role: "provider_staff",
          provider_account_code: account,
        });
      }
      const profile = this.tables.profiles.find((row) => row.id === p.p_user_id);
      if (profile) {
        profile.role = "provider_staff";
        profile.provider_account_code = account;
      } else {
        this.tables.profiles.push({
          id: p.p_user_id,
          role: "provider_staff",
          display_name: p.p_display_name ?? null,
          email,
          provider_account_code: account,
        });
      }
      return json(200, []);
    }

    if (url.pathname === "/rest/v1/rpc/claim_register_send") {
      // Mirrors the real atomic function: destination-scoped hourly counts
      // across ALL purposes (one shared 3/hr pot per target, so login/signup/
      // claim rails cannot stack), plus the optional scope key, then
      // insert-or-empty.
      const p = body as Row;
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const ledger = this.tables.claim_verifications;
      const inHour = ledger.filter((r) => String(r.created_at) > hourAgo);
      const byIdentifier = inHour.filter((r) => r.identifier === p.p_identifier).length;
      if (byIdentifier >= Number(p.p_max_per_hour)) return json(200, []);
      if (p.p_scope_key != null && p.p_scope_max_per_hour != null) {
        const byScope = inHour.filter((r) => r.scope_key === p.p_scope_key).length;
        if (byScope >= Number(p.p_scope_max_per_hour)) return json(200, []);
      }
      const row: Row = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        code_attempts: 0,
        birthday_checked: false,
        resolved_ref: null,
        verified_at: null,
        claim_token_hash: null,
        consumed_at: null,
        purpose: p.p_purpose,
        identifier_kind: p.p_identifier_kind,
        identifier: p.p_identifier,
        account_type: p.p_account_type,
        candidates: p.p_candidates,
        delivery: p.p_delivery,
        code_salt: p.p_code_salt,
        code_hash: p.p_code_hash,
        code_expires_at: p.p_code_expires_at,
        auth_user_id: p.p_auth_user_id,
        scope_key: p.p_scope_key,
      };
      ledger.push(row);
      return json(200, [row]);
    }

    const tableMatch = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (tableMatch) {
      const table = tableMatch[1];
      if (!(table in this.tables)) return json(404, { message: `fake: no table ${table}` });
      const { conditions, orGroups } = this.parseQuery(url);
      if (method === "GET") {
        const rows = this.matchRows(table, conditions, orGroups);
        if (
          table === "patients" &&
          this.onEmailPrecheck &&
          conditions.some(([col, op]) => col === "email" && op === "ilike")
        ) {
          const hook = this.onEmailPrecheck;
          this.onEmailPrecheck = null;
          const response = json(200, rows);
          hook();
          return response;
        }
        return json(200, rows);
      }
      if (method === "DELETE") {
        const doomed = new Set(this.matchRows(table, conditions, orGroups));
        this.tables[table] = this.tables[table].filter((row) => !doomed.has(row));
        return json(200, [...doomed]);
      }
      if (method === "PATCH") {
        if (
          table === "claim_verifications" &&
          this.failRejectedSendSpend &&
          body?.consumed_at
        ) {
          return json(500, { message: "simulated rejected-send spend failure" });
        }
        if (this.failPatch?.(table, body)) return json(500, { message: `simulated ${table} update failure` });
        const rows = this.matchRows(table, conditions, orGroups);
        for (const row of rows) Object.assign(row, body);
        return json(200, rows);
      }
      if (method === "POST") {
        if (this.failPostTables.has(table)) return json(500, { message: `simulated ${table} insert failure` });
        if (table === "patients") {
          // The partial unique indexes the migration created, faked exactly:
          // non-null emails and phones must be unique among patients.
          const email = String(body?.email ?? "").toLowerCase();
          if (
            email &&
            this.tables.patients.some((p) => String(p.email ?? "").toLowerCase() === email)
          ) {
            return json(409, {
              message: 'duplicate key value violates unique constraint "patients_email_unique_idx"',
            });
          }
          const phone = String(body?.phone ?? "");
          if (phone && this.tables.patients.some((p) => String(p.phone ?? "") === phone)) {
            return json(409, {
              message: 'duplicate key value violates unique constraint "patients_phone_unique_idx"',
            });
          }
        }
        if (table === "account_security_state") {
          // Upsert on user_id (Prefer: resolution=merge-duplicates).
          const existing = this.tables[table].find((row) => row.user_id === body?.user_id);
          if (existing) {
            Object.assign(existing, body);
            return json(200, [existing]);
          }
        }
        if (table === "staff_second_factors") {
          // Upsert on (staff_kind, staff_ref).
          const existing = this.tables[table].find(
            (row) => row.staff_kind === body?.staff_kind && row.staff_ref === body?.staff_ref,
          );
          if (existing) {
            Object.assign(existing, body);
            return json(200, [existing]);
          }
        }
        const row: Row = {
          ...(table === "auth_sign_ins"
            ? { id: crypto.randomUUID(), created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), session_id: null, revoked_at: null, revoked_reason: null, reported_at: null }
            : {}),
          ...body,
        };
        this.tables[table].push(row);
        return json(201, [row]);
      }
    }
    return json(404, { message: `fake: unhandled ${method} ${url.pathname}` });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const backend = new FakeBackend();
const realFetch = globalThis.fetch.bind(globalThis);
const routeErrors: string[] = [];
let server: http.Server;
let base: string;

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await realFetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

/** POSTs login/start and asserts the one universal response shape. */
async function startLogin(realm: "staff" | "patient", identifier: string) {
  if (realm === "patient") {
    const normalized = identifier.includes("@")
      ? identifier.trim().toLowerCase()
      : `+1${identifier.replace(/\D/g, "").slice(-10)}`;
    const matches = backend.tables.patients.filter((p) =>
      identifier.includes("@")
        ? String(p.email ?? "").toLowerCase() === normalized
        : String(p.phone ?? "").replace(/\D/g, "").slice(-10) === normalized.slice(-10),
    ).filter((p) => p.activation_status !== "disabled");
    if (matches.length === 1 && !matches[0].auth_user_id) {
      const user = backend.seedAuthUser({
        email: `pt-${String(matches[0].id).toLowerCase()}@patients.thinnr.invalid`,
        phone: matches[0].phone ?? null,
        password: "OldStrong!Pass",
      });
      matches[0].auth_user_id = user.id;
    }
    const res = await api("POST", "/api/auth/patient/password/login", {
      identifier, password: "OldStrong!Pass",
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.devCode).toMatch(/^\d{6}$/);
    return res;
  }
  const res = await api("POST", "/api/auth/login/start", { realm, identifier });
  expect(res.status).toBe(200);
  expect(res.json.ok).toBe(true);
  expect(res.json.devCode).toMatch(/^\d{6}$/);
  return res;
}

/** Explicit password rail for live-delivery tests (never hidden in api()). */
async function livePatientLogin(identifier: string): Promise<{ status: number; json: any }> {
  const digits = identifier.replace(/\D/g, "").slice(-10);
  const patient = backend.tables.patients.find(
    p => String(p.phone ?? "").replace(/\D/g, "").slice(-10) === digits ||
      String(p.email ?? "").toLowerCase() === identifier.trim().toLowerCase(),
  );
  if (patient && !patient.auth_user_id) {
    const user = backend.seedAuthUser({
      email: `pt-${String(patient.id).toLowerCase()}@patients.thinnr.invalid`,
      phone: patient.phone ?? null,
      password: "OldStrong!Pass",
    });
    patient.auth_user_id = user.id;
  }
  return api("POST", "/api/auth/patient/password/login", {
    identifier, password: "OldStrong!Pass",
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

beforeAll(async () => {
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  process.env.CLAIM_DELIVERY_MODE = "dev";
  process.env.CLAIM_IDENTIFY_FLOOR_MS = "0";
  for (const knob of ["SEND", "CHECK", "OFFICE", "FINISH"]) {
    process.env[`AUTH_${knob}_BURST`] = "100000";
    process.env[`AUTH_${knob}_DAILY_BUDGET`] = "100000";
  }

  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(href).hostname;
    if (
      host === "fake.supabase.local" ||
      host === "verify.twilio.com" ||
      host === "api.resend.com"
    ) {
      return Promise.resolve(backend.handle(href, init));
    }
    return realFetch(input as string, init);
  });

  const { default: authRouter } = await import("./auth");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: (obj: { err?: Error }, msg: string) =>
        routeErrors.push(`${msg}: ${obj?.err?.message ?? String(obj)}`),
    };
    next();
  });
  app.use("/api", authRouter);
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

describe("patient password and enrollment rails", () => {
  function seedPasswordPatient(overrides: Row = {}) {
    const patient = seedPatient({ activation_status: "activated", ...overrides });
    const user = backend.seedAuthUser({
      email: `pt-${String(patient.id).toLowerCase()}@patients.thinnr.invalid`,
      password: "OldStrong!Pass",
    });
    patient.auth_user_id = user.id;
    return { patient, user };
  }

  it("uses a valid password only to issue the existing login MFA code", async () => {
    seedPasswordPatient();
    const bypass = await api("POST", "/api/auth/login/start", {
      realm: "patient", identifier: "5552013344",
    });
    expect(bypass.status).toBe(400);
    expect(backend.tables.claim_verifications).toHaveLength(0);
    const start = await api("POST", "/api/auth/patient/password/login", {
      identifier: "5552013344", password: "OldStrong!Pass",
    });
    expect(start.status).toBe(200);
    expect(start.json.devCode).toMatch(/^\d{6}$/);
    expect(backend.tables.claim_verifications[0].purpose).toBe("login");
    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId, code: start.json.devCode,
    });
    expect(verify.status).toBe(200);
    expect(verify.json.realm).toBe("patient");
  });

  it("keeps wrong-password and unknown-account responses neutral", async () => {
    seedPasswordPatient();
    const wrong = await api("POST", "/api/auth/patient/password/login", {
      identifier: "5552013344", password: "WrongStrong!Pass",
    });
    const miss = await api("POST", "/api/auth/patient/password/login", {
      identifier: "5559998888", password: "WrongStrong!Pass",
    });
    expect(wrong.status).toBe(401);
    expect(miss.status).toBe(401);
    expect(Object.keys(wrong.json).sort()).toEqual(Object.keys(miss.json).sort());
    expect(wrong.json).toEqual(miss.json);
    expect(wrong.json.error).toContain("password");
    expect(backend.tables.claim_verifications).toHaveLength(0);
  });

  it("never transfers password proof across a patient binding change", async () => {
    const cases = [
      () => {
        const { patient } = seedPasswordPatient();
        backend.onPasswordGrant = () => { patient.activation_status = "disabled"; };
      },
      () => {
        const { patient } = seedPasswordPatient();
        const replacement = backend.seedAuthUser({ email: "replacement@patients.thinnr.invalid", password: "OtherStrong!Pass" });
        backend.onPasswordGrant = () => { patient.auth_user_id = replacement.id; };
      },
      () => {
        const { patient } = seedPasswordPatient();
        const other = seedPatient({ phone: "5558887777", email: "other@example.com", activation_status: "activated" });
        const otherUser = backend.seedAuthUser({ email: "other@patients.thinnr.invalid", password: "OtherStrong!Pass" });
        other.auth_user_id = otherUser.id;
        backend.onPasswordGrant = () => {
          patient.phone = "5551112222";
          other.phone = "5552013344";
        };
      },
    ];
    for (const arrange of cases) {
      backend.reset();
      arrange();
      const result = await api("POST", "/api/auth/patient/password/login", {
        identifier: "5552013344",
        password: "OldStrong!Pass",
      });
      expect(result.status).toBe(409);
      expect(result.json.requestId).toBeUndefined();
      expect(backend.tables.claim_verifications).toHaveLength(0);
    }
  });

  it("silently applies the shared per-identifier send cap after password proof", async () => {
    seedPasswordPatient();
    for (let i = 0; i < 4; i += 1) {
      const result = await api("POST", "/api/auth/patient/password/login", {
        identifier: "5552013344", password: "OldStrong!Pass",
      });
      expect(result.status).toBe(i < 3 ? 200 : 429);
      if (i < 3) expect(result.json.devCode).toMatch(/^\d{6}$/);
      else expect(result.json.requestId).toBeUndefined();
    }
    expect(backend.tables.claim_verifications).toHaveLength(3);
  });

  it("resets a password once after recovery proof and rejects replay", async () => {
    const { user } = seedPasswordPatient({ email: "casey@example.com" });
    const start = await api("POST", "/api/auth/patient/recovery/start", { identifier: "casey@example.com" });
    const proof = await api("POST", "/api/auth/patient/recovery/verify", {
      requestId: start.json.requestId, code: start.json.devCode,
    });
    expect(proof.json.resetToken).toMatch(/^[0-9a-f]{64}$/);
    const complete = await api("POST", "/api/auth/patient/recovery/complete", {
      resetToken: proof.json.resetToken, password: "NewStrong!Pass",
    });
    expect(complete.status).toBe(200);
    expect(user.password).toBe("NewStrong!Pass");
    const replay = await api("POST", "/api/auth/patient/recovery/complete", {
      resetToken: proof.json.resetToken, password: "OtherStrong!Pass",
    });
    expect(replay.status).toBe(400);
    expect(user.password).toBe("NewStrong!Pass");
  });

  it("enrolls an invited email while preserving its row and office", async () => {
    const patient = seedPatient({
      email: "invitee@example.com", phone: "+15550001111",
      activation_status: "invited", auth_user_id: null,
    });
    const start = await api("POST", "/api/auth/signup/start", {
      flow: "invited", identifier: "invitee@example.com",
    });
    const verify = await api("POST", "/api/auth/signup/verify", {
      requestId: start.json.requestId, code: start.json.devCode,
    });
    expect(verify.json.mode).toBe("enroll");
    const complete = await api("POST", "/api/auth/signup/complete", {
      signupToken: verify.json.signupToken, password: "InviteStrong!Pass",
    });
    expect(complete.status).toBe(200);
    expect(backend.tables.patients).toHaveLength(1);
    expect(patient.provider_id).toBe(SIGNUP_OFFICE_ID);
    expect(patient.activation_status).toBe("activated");
    expect(backend.authUsers.get(String(patient.auth_user_id))?.password).toBe("InviteStrong!Pass");
    // The emailed code proved the email; the office-entered phone is still unproven.
    expect(patient.email_verified_at).toEqual(expect.any(String));
    expect(patient.phone_verified_at ?? null).toBeNull();
  });

  it("enrolls an invited phone while preserving its row and office", async () => {
    const patient = seedPatient({
      email: "phone-invite@example.com", phone: "+15550002222",
      activation_status: "invited", auth_user_id: null,
    });
    const start = await api("POST", "/api/auth/signup/start", {
      flow: "invited", identifier: "5550002222",
    });
    const verify = await api("POST", "/api/auth/signup/verify", {
      requestId: start.json.requestId, code: start.json.devCode,
    });
    const complete = await api("POST", "/api/auth/signup/complete", {
      signupToken: verify.json.signupToken, password: "InviteStrong!Pass",
    });
    expect(complete.status).toBe(200);
    expect(patient.provider_id).toBe(SIGNUP_OFFICE_ID);
    expect(patient.activation_status).toBe("activated");
    // The texted code proved the phone; the email waits for its own code.
    expect(patient.phone_verified_at).toEqual(expect.any(String));
    expect(patient.email_verified_at ?? null).toBeNull();
  });

  it("carries a signup email onto a phone invite without marking it verified", async () => {
    const patient = seedPatient({
      email: null, phone: "+15550004444",
      activation_status: "invited", auth_user_id: null,
    });
    const { token } = await invitedToken("(555) 000-4444");
    const complete = await api("POST", "/api/auth/signup/complete", {
      signupToken: token, password: "InviteStrong!Pass", email: "Typed@Example.com",
    });
    expect(complete.status).toBe(200);
    expect(patient.email).toBe("typed@example.com");
    expect(patient.phone_verified_at).toEqual(expect.any(String));
    expect(patient.email_verified_at ?? null).toBeNull();
  });

  it("keeps an earlier verified stamp instead of overwriting it", async () => {
    const patient = seedPatient({
      email: "kept@example.com", phone: "+15550005555",
      activation_status: "invited", auth_user_id: null,
      email_verified_at: "2026-01-02T03:04:05.000Z",
    });
    const { token } = await invitedToken("kept@example.com");
    const complete = await api("POST", "/api/auth/signup/complete", {
      signupToken: token, password: "InviteStrong!Pass",
    });
    expect(complete.status).toBe(200);
    expect(patient.email_verified_at).toBe("2026-01-02T03:04:05.000Z");
  });

  it("allows only one same-token existing-row completion and preserves its winning password", async () => {
    const { patient } = seedPasswordPatient({ auth_user_id: null, activation_status: "invited" });
    const start = await api("POST", "/api/auth/signup/start", {
      flow: "invited", identifier: "5552013344",
    });
    const verify = await api("POST", "/api/auth/signup/verify", {
      requestId: start.json.requestId, code: start.json.devCode,
    });
    const token = verify.json.signupToken;
    const results = await Promise.all([
      api("POST", "/api/auth/signup/complete", { signupToken: token, password: "WinnerOne!Pass" }),
      api("POST", "/api/auth/signup/complete", { signupToken: token, password: "WinnerTwo!Pass" }),
    ]);
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    const user = backend.authUsers.get(String(patient.auth_user_id))!;
    const winning = results[0].status === 200 ? "WinnerOne!Pass" : "WinnerTwo!Pass";
    expect(user.password).toBe(winning);
  });

  const BREACHED = "This password has appeared in a data breach — please choose a different one.";

  async function invitedToken(identifier: string): Promise<{ token: string; verify: { json: Row } }> {
    const start = await api("POST", "/api/auth/signup/start", { flow: "invited", identifier });
    const verify = await api("POST", "/api/auth/signup/verify", {
      requestId: start.json.requestId, code: start.json.devCode,
    });
    expect(verify.status).toBe(200);
    return { token: verify.json.signupToken, verify };
  }

  it("refuses a breached password on the field and leaves the invite retryable with the same code", async () => {
    const patient = seedPatient({
      email: "breach@example.com", phone: "+15550003333",
      activation_status: "invited", auth_user_id: null,
    });
    backend.weakPasswords.add("Password1!");
    const { token } = await invitedToken("breach@example.com");
    const refused = await api("POST", "/api/auth/signup/complete", {
      signupToken: token, password: "Password1!", firstName: "Casey", lastName: "Edited",
    });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: BREACHED, field: "password", code: "WEAK_PASSWORD" });
    // Nothing half-done: still invited, no login linked or left behind, name untouched.
    expect(patient.activation_status).toBe("invited");
    expect(patient.auth_user_id).toBeNull();
    expect(patient.claimed_at ?? null).toBeNull();
    expect(patient.name).toBe("Casey Patient");
    expect(backend.authUsers.size).toBe(0);
    expect(backend.tables.claim_verifications[0].consumed_at).toBeNull();

    const retry = await api("POST", "/api/auth/signup/complete", {
      signupToken: token, password: "Stronger!Pass9", firstName: "Casey", lastName: "Edited",
    });
    expect(retry.status).toBe(200);
    expect(patient.activation_status).toBe("activated");
    expect(backend.authUsers.get(String(patient.auth_user_id))?.password).toBe("Stronger!Pass9");
    expect(patient).toMatchObject({ first_name: "Casey", last_name: "Edited", name: "Casey Edited" });
  });

  it("keeps a pre-existing link on a refused password and sets the password on retry", async () => {
    const patient = seedPatient({ email: "linked@example.com", activation_status: "invited" });
    const user = backend.seedAuthUser({
      email: `pt-${String(patient.id).toLowerCase()}@patients.thinnr.invalid`,
    });
    patient.auth_user_id = user.id;
    backend.weakPasswords.add("Password1!");
    const { token } = await invitedToken("linked@example.com");
    const refused = await api("POST", "/api/auth/signup/complete", { signupToken: token, password: "Password1!" });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe(BREACHED);
    expect(patient.activation_status).toBe("invited");
    expect(backend.authUsers.has(String(user.id))).toBe(true);
    const retry = await api("POST", "/api/auth/signup/complete", { signupToken: token, password: "Stronger!Pass9" });
    expect(retry.status).toBe(200);
    expect(patient.auth_user_id).toBe(user.id);
    expect(user.password).toBe("Stronger!Pass9");
  });

  it("unwinds an invited completion that fails after the login landed", async () => {
    const patient = seedPatient({
      email: "unwind@example.com", activation_status: "invited", auth_user_id: null,
    });
    const { token } = await invitedToken("unwind@example.com");
    backend.failPostTables.add("auth_sign_ins");
    const failed = await api("POST", "/api/auth/signup/complete", {
      signupToken: token, password: "Stronger!Pass9", firstName: "Renamed", lastName: "Person",
    });
    expect(failed.status).toBe(502);
    expect(patient).toMatchObject({ activation_status: "invited", auth_user_id: null, claimed_at: null, name: "Casey Patient" });
    expect(patient.first_name ?? null).toBeNull();
    // The unwound attempt leaves no verified stamp behind.
    expect(patient.email_verified_at ?? null).toBeNull();
    expect(backend.authUsers.size).toBe(0);
    expect(backend.deletedUsers).toHaveLength(1);

    backend.failPostTables.clear();
    const retry = await api("POST", "/api/auth/signup/complete", {
      signupToken: token, password: "Stronger!Pass9", firstName: "Renamed", lastName: "Person",
    });
    expect(retry.status).toBe(200);
    expect(patient.activation_status).toBe("activated");
  });

  it("returns the office's name after verification for the patient to confirm", async () => {
    seedPatient({
      email: "named@example.com", name: "Shannon Marie Strotheide",
      activation_status: "invited", auth_user_id: null,
    });
    const { verify } = await invitedToken("named@example.com");
    expect(verify.json.invitedName).toEqual({ firstName: "Shannon", lastName: "Marie Strotheide" });

    seedSignupOffice();
    const start = await api("POST", "/api/auth/signup/start", {
      flow: "new", code: "654321", phone: "8135550199", email: "fresh-name@example.com",
    });
    const fresh = await api("POST", "/api/auth/signup/verify", {
      requestId: start.json.requestId, code: start.json.devCode,
    });
    expect(fresh.json.invitedName).toBeUndefined();
    const missing = await api("POST", "/api/auth/signup/complete", {
      signupToken: fresh.json.signupToken, password: "Stronger!Pass9", firstName: "Fresh", lastName: " ",
    });
    expect(missing.status).toBe(400);
    expect(missing.json.field).toBe("lastName");
  });

  it("refuses a breached password on a new signup without leaving a patient or login", async () => {
    seedSignupOffice();
    backend.weakPasswords.add("Password1!");
    const start = await api("POST", "/api/auth/signup/start", {
      flow: "new", code: "654321", phone: "8135550102", email: "breach-new@example.com",
    });
    const verify = await api("POST", "/api/auth/signup/verify", {
      requestId: start.json.requestId, code: start.json.devCode,
    });
    const token = verify.json.signupToken;
    const refused = await api("POST", "/api/auth/signup/complete", {
      signupToken: token, password: "Password1!", firstName: "New", lastName: "Patient",
    });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: BREACHED, field: "password" });
    expect(backend.tables.patients).toHaveLength(0);
    expect(backend.authUsers.size).toBe(0);

    backend.failPostTables.add("auth_sign_ins");
    const failed = await api("POST", "/api/auth/signup/complete", {
      signupToken: token, password: "Stronger!Pass9", firstName: "New", lastName: "Patient",
    });
    expect(failed.status).toBe(502);
    expect(backend.tables.patients).toHaveLength(0);
    expect(backend.authUsers.size).toBe(0);
    expect(backend.tables.claim_verifications[0].consumed_at).toBeNull();

    backend.failPostTables.clear();
    const retry = await api("POST", "/api/auth/signup/complete", {
      signupToken: token, password: "Stronger!Pass9", firstName: "New", lastName: "Patient",
    });
    expect(retry.status).toBe(200);
    expect(backend.tables.patients[0]).toMatchObject({ first_name: "New", last_name: "Patient", name: "New Patient" });
  });

  it("shows the breach message on password reset and keeps the reset proof usable", async () => {
    const { user } = seedPasswordPatient({ email: "reset-breach@example.com" });
    backend.weakPasswords.add("Password1!");
    const start = await api("POST", "/api/auth/patient/recovery/start", { identifier: "reset-breach@example.com" });
    const proof = await api("POST", "/api/auth/patient/recovery/verify", {
      requestId: start.json.requestId, code: start.json.devCode,
    });
    const refused = await api("POST", "/api/auth/patient/recovery/complete", {
      resetToken: proof.json.resetToken, password: "Password1!",
    });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: BREACHED, field: "password" });
    expect(user.password).toBe("OldStrong!Pass");
    const retry = await api("POST", "/api/auth/patient/recovery/complete", {
      resetToken: proof.json.resetToken, password: "Stronger!Pass9",
    });
    expect(retry.status).toBe(200);
    expect(user.password).toBe("Stronger!Pass9");
  });

  it("creates a new signup with both contacts and refuses split contacts", async () => {
    seedSignupOffice();
    const start = await api("POST", "/api/auth/signup/start", {
      flow: "new", code: "654321", phone: "8135550101", email: "new@example.com",
    });
    const verify = await api("POST", "/api/auth/signup/verify", {
      requestId: start.json.requestId, code: start.json.devCode,
    });
    const complete = await api("POST", "/api/auth/signup/complete", {
      signupToken: verify.json.signupToken, password: "FreshStrong!Pass", name: "Fresh Patient",
    });
    expect(complete.status).toBe(200);
    expect(backend.tables.patients[0].email).toBe("new@example.com");
    expect(backend.tables.patients[0].password).toBeUndefined();

    seedPatient({ phone: "+15551112222", email: "first@example.com" });
    seedPatient({ phone: "+15553334444", email: "second@example.com" });
    const before = backend.tables.claim_verifications.length;
    const split = await api("POST", "/api/auth/signup/start", {
      flow: "new", code: "654321", phone: "5551112222", email: "second@example.com",
    });
    expect(split.status).toBe(200);
    expect(backend.tables.claim_verifications).toHaveLength(before);
  });

  it("rejects an expired recovery code without issuing a capability", async () => {
    seedPasswordPatient();
    const start = await api("POST", "/api/auth/patient/recovery/start", { identifier: "5552013344" });
    backend.tables.claim_verifications[0].code_expires_at = new Date(Date.now() - 1000).toISOString();
    const proof = await api("POST", "/api/auth/patient/recovery/verify", {
      requestId: start.json.requestId, code: start.json.devCode,
    });
    expect(proof.status).toBe(400);
    expect(proof.json.resetToken).toBeUndefined();
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  backend.reset();
  process.env.CLAIM_DELIVERY_MODE = "dev";
  process.env.CLAIM_SMS_DELIVERY_MODE = "dev";
  process.env.CLAIM_EMAIL_DELIVERY_MODE = "dev";
  process.env.AUTH_SMS_DELIVERY_FLOOR_MS = "0";
  routeErrors.length = 0;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_VERIFY_SERVICE_SID;
  delete process.env.RESEND_API_KEY;
  delete process.env.CLAIM_EMAIL_FROM;
});

function seedProvider(overrides: Row = {}): Row {
  const row: Row = {
    provider_id: "20002",
    provider_name: "Dr. Rivera",
    office_name: "Rivera Wellness",
    email: "rivera@clinic.example",
    onboarding_code: null,
    access_disabled: false,
    auth_user_id: null,
    claimed_at: null,
    ...overrides,
  };
  backend.tables.providers.push(row);
  return row;
}

// New-generation offices carry non-numeric ids (live-<hex>). Signup must
// resolve them by the stored id at completion — never by re-parsing the id
// as if it were a 5/6-digit code.
const SIGNUP_OFFICE_ID = "live-4b9d2f6c1a8e4703b5d6902c3e1f7a84";

function seedPatient(overrides: Row = {}): Row {
  const row: Row = {
    id: crypto.randomUUID(),
    provider_id: SIGNUP_OFFICE_ID,
    name: "Casey Patient",
    email: null,
    phone: "+15552013344",
    activation_status: "active",
    auth_user_id: null,
    claimed_at: null,
    ...overrides,
  };
  backend.tables.patients.push(row);
  return row;
}

function seedSignupOffice(): Row {
  return seedProvider({
    provider_id: SIGNUP_OFFICE_ID,
    provider_name: "Dr. Bayshore",
    office_name: "Bayshore Slim Clinic",
    email: "bayshore@clinic.example",
    onboarding_code: "654321",
  });
}

/** Runs signup start → verify for a brand-new phone, returns the signup token. */
async function signupToDetails(phone: string): Promise<string> {
  const start = await api("POST", "/api/auth/signup/start", { code: "654321", phone });
  expect(start.status).toBe(200);
  expect(start.json.devCode).toMatch(/^\d{6}$/);
  const verify = await api("POST", "/api/auth/signup/verify", {
    requestId: start.json.requestId,
    code: start.json.devCode,
  });
  expect(verify.status).toBe(200);
  expect(verify.json.mode).toBe("enroll");
  expect(verify.json.signupToken).toMatch(/^[0-9a-f]{64}$/);
  return verify.json.signupToken as string;
}

describe("staff login start", () => {
  it("answers unknown and known emails with one identical shape, storing only the hit", async () => {
    seedProvider();
    const miss = await startLogin("staff", "nobody@example.com");
    const hit = await startLogin("staff", "Rivera@Clinic.example");
    expect(Object.keys(hit.json).sort()).toEqual(Object.keys(miss.json).sort());
    expect(hit.json.message).toBe(miss.json.message);
    expect(backend.tables.claim_verifications).toHaveLength(1);
    const row = backend.tables.claim_verifications[0];
    expect(row.account_type).toBe("provider");
    expect(row.identifier).toBe("rivera@clinic.example");
    expect(row.purpose).toBe("login");
  });

  it("rejects a phone number in the staff realm", async () => {
    const res = await api("POST", "/api/auth/login/start", {
      realm: "staff",
      identifier: "5552013344",
    });
    expect(res.status).toBe(400);
    expect(res.json.field).toBe("identifier");
  });

  it("ranks HQ membership above provider and team rows sharing the email", async () => {
    const email = "boss@thinnr.example";
    backend.seedAuthUser({ id: "hq-user-1", email });
    backend.tables.hq_memberships.push({
      id: "mem-1",
      email,
      display_name: "The Boss",
      status: "active",
      auth_user_id: "hq-user-1",
    });
    seedProvider({ email });
    backend.tables.team_members.push({
      id: crypto.randomUUID(),
      provider_id: "20002",
      name: "Boss As Staff",
      email,
      activation_status: "activated",
      auth_user_id: null,
    });
    await startLogin("staff", email);
    expect(backend.tables.claim_verifications).toHaveLength(1);
    expect(backend.tables.claim_verifications[0].account_type).toBe("hq_admin");
  });

  it("collapses disabled, locked, ambiguous, and revoked staff to neutral no-sends", async () => {
    seedProvider({ provider_id: "21001", email: "disabled@clinic.example", access_disabled: true });
    seedProvider({ provider_id: "21002", email: "locked@clinic.example" });
    backend.tables.provider_account_locks.push({ account_id: "acct-21002" });
    seedProvider({ provider_id: "21003", email: "twice@clinic.example" });
    seedProvider({ provider_id: "21004", email: "twice@clinic.example" });
    backend.tables.hq_memberships.push({
      id: "mem-revoked",
      email: "revoked@thinnr.example",
      display_name: "Gone",
      status: "revoked",
      auth_user_id: "old-user",
    });
    backend.tables.hq_memberships.push({
      id: "mem-uninvited",
      email: "noinvite@thinnr.example",
      display_name: "No Invite",
      status: "invited",
      auth_user_id: null,
    });
    seedProvider({ provider_id: "21005", email: "office-down@clinic.example", access_disabled: true });
    backend.tables.team_members.push({
      id: crypto.randomUUID(),
      provider_id: "21005",
      name: "Staff Of Disabled Office",
      email: "staffer@clinic.example",
      activation_status: "activated",
      auth_user_id: null,
    });

    for (const email of [
      "disabled@clinic.example",
      "locked@clinic.example",
      "twice@clinic.example",
      "revoked@thinnr.example",
      "noinvite@thinnr.example",
      "staffer@clinic.example",
    ]) {
      await startLogin("staff", email);
    }
    expect(backend.tables.claim_verifications).toHaveLength(0);
    expect(backend.authUsers.size).toBe(0);
  });

  it("caps sends per email per hour, silently", async () => {
    seedProvider();
    for (let i = 0; i < 4; i += 1) {
      await startLogin("staff", "rivera@clinic.example");
    }
    expect(backend.tables.claim_verifications).toHaveLength(3);
  });
});

describe("staff login verify", () => {
  it("signs a provider in end to end on first login, creating and linking the auth user", async () => {
    const provider = seedProvider();
    const start = await startLogin("staff", "rivera@clinic.example");
    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(verify.status).toBe(200);
    expect(verify.json).toEqual({
      ok: true,
      realm: "staff",
      tokenHash: "hashed-rivera@clinic.example",
      signInId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(backend.tables.auth_sign_ins).toHaveLength(1);
    expect(backend.tables.auth_sign_ins[0]).toMatchObject({
      realm: "staff",
      method: "email_code",
      new_device: false,
      user_id: provider.auth_user_id,
    });
    expect(provider.auth_user_id).toBeTruthy();
    const user = backend.authUsers.get(String(provider.auth_user_id))!;
    expect(user.email).toBe("rivera@clinic.example");
    expect((user.app_metadata as Row).thinnr_claim).toBe("provider");
    expect((user.app_metadata as Row).thinnr_claim_ref).toBe("20002");
    expect((user.user_metadata as Row).display_name).toBe("Dr. Rivera");
    const row = backend.tables.claim_verifications[0];
    expect(row.verified_at).toBeTruthy();
    expect(row.consumed_at).toBeTruthy();
    expect(row.auth_user_id).toBe(provider.auth_user_id);
    // The proven code must land in a usable office workspace: the
    // provisioning rail files the provider_staff profile scoped to the
    // office, plus the authoritative pre-approval row.
    const profile = backend.tables.profiles.find((p) => p.id === provider.auth_user_id);
    expect(profile?.role).toBe("provider_staff");
    expect(profile?.provider_account_code).toBe("20002");
    expect(
      backend.tables.staff_role_assignments.find((a) => a.email === "rivera@clinic.example")
        ?.provider_account_code,
    ).toBe("20002");
  });

  it("reuses the existing login for already-linked staff", async () => {
    const user = backend.seedAuthUser({ email: "rivera@clinic.example" });
    seedProvider({ auth_user_id: user.id });
    const start = await startLogin("staff", "rivera@clinic.example");
    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(verify.status).toBe(200);
    expect(verify.json.tokenHash).toBe("hashed-rivera@clinic.example");
    expect(backend.authUsers.size).toBe(1);
  });

  it("provisions pre-approved team members and marks everyone else for claim", async () => {
    seedProvider({ provider_id: "20002" });
    backend.tables.staff_role_assignments.push({
      email: "approved@clinic.example",
      role: "provider_staff",
    });
    const approved = {
      id: crypto.randomUUID(),
      provider_id: "20002",
      name: "Approved Staffer",
      email: "approved@clinic.example",
      activation_status: "activated",
      auth_user_id: null as string | null,
    };
    const walkIn = {
      id: crypto.randomUUID(),
      provider_id: "20002",
      name: "Walk-in Staffer",
      email: "walkin@clinic.example",
      activation_status: "activated",
      auth_user_id: null as string | null,
    };
    backend.tables.team_members.push(approved, walkIn);

    for (const member of [approved, walkIn]) {
      const start = await startLogin("staff", member.email);
      const verify = await api("POST", "/api/auth/login/verify", {
        requestId: start.json.requestId,
        code: start.json.devCode,
      });
      expect(verify.status).toBe(200);
      expect(member.auth_user_id).toBeTruthy();
    }
    const approvedUser = backend.authUsers.get(String(approved.auth_user_id))!;
    expect((approvedUser.app_metadata as Row).thinnr_provisioned).toBe(true);
    const walkInUser = backend.authUsers.get(String(walkIn.auth_user_id))!;
    expect((walkInUser.app_metadata as Row).thinnr_claim).toBe("team_member");
    expect((walkInUser.app_metadata as Row).thinnr_claim_ref).toBe(walkIn.id);
    // Pre-approved or walk-in, both end with an office-scoped profile — no
    // team member ever lands on the claimed-workspace placeholder.
    for (const member of [approved, walkIn]) {
      const profile = backend.tables.profiles.find((p) => p.id === member.auth_user_id);
      expect(profile?.role).toBe("provider_staff");
      expect(profile?.provider_account_code).toBe("20002");
    }
  });

  it("repairs a claim-marked login without a profile into the office workspace", async () => {
    // A team member who signed in before the provisioning rail existed:
    // linked auth user with claim markers, no assignment, no profiles row —
    // exactly the shape that used to park on the claimed-workspace screen.
    seedProvider({ provider_id: "20002" });
    const member = {
      id: crypto.randomUUID(),
      provider_id: "20002",
      name: "Legacy Staffer",
      email: "legacy@clinic.example",
      activation_status: "activated",
      auth_user_id: null as string | null,
    };
    backend.tables.team_members.push(member);
    const user = backend.seedAuthUser({
      email: "legacy@clinic.example",
      app_metadata: { thinnr_claim: "team_member", thinnr_claim_ref: member.id },
    });
    member.auth_user_id = String(user.id);

    const start = await startLogin("staff", "legacy@clinic.example");
    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(verify.status).toBe(200);
    expect(backend.authUsers.size).toBe(1); // repaired in place, not recreated
    const profile = backend.tables.profiles.find((p) => p.id === user.id);
    expect(profile?.role).toBe("provider_staff");
    expect(profile?.provider_account_code).toBe("20002");
    expect((user.app_metadata as Row).thinnr_provisioned).toBe(true);
    expect(
      backend.tables.staff_role_assignments.find((a) => a.email === "legacy@clinic.example")
        ?.provider_account_code,
    ).toBe("20002");
  });

  it("fails closed when workspace provisioning fails, then heals on the next code", async () => {
    seedProvider();
    backend.failProvision = true;
    const start = await startLogin("staff", "rivera@clinic.example");
    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    // No session is ever minted for a staff login that would land on the
    // placeholder — the verify fails outright and the code is spent.
    expect(verify.status).toBe(502);
    expect(verify.json.tokenHash).toBeUndefined();
    const replay = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(replay.status).toBe(400);

    // The next proven code repairs the half-provisioned login end to end.
    backend.failProvision = false;
    const retry = await startLogin("staff", "rivera@clinic.example");
    const second = await api("POST", "/api/auth/login/verify", {
      requestId: retry.json.requestId,
      code: retry.json.devCode,
    });
    expect(second.status).toBe(200);
    const provider = backend.tables.providers[0];
    const profile = backend.tables.profiles.find((p) => p.id === provider.auth_user_id);
    expect(profile?.role).toBe("provider_staff");
    expect(profile?.provider_account_code).toBe("20002");
  });

  it("lands an invited HQ member through invitation acceptance", async () => {
    const membership = {
      id: "mem-2",
      email: "newhq@thinnr.example",
      display_name: "New Analyst",
      status: "invited",
      auth_user_id: null as string | null,
    };
    backend.tables.hq_memberships.push(membership);
    backend.tables.hq_invitations.push({
      id: crypto.randomUUID(),
      membership_id: "mem-2",
      status: "pending",
      token_hash: "invite-hash-1",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    });
    const start = await startLogin("staff", "newhq@thinnr.example");
    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(verify.status).toBe(200);
    expect(verify.json.realm).toBe("staff");
    expect(membership.status).toBe("active");
    expect(membership.auth_user_id).toBeTruthy();
    expect(backend.tables.hq_invitations[0].status).toBe("accepted");
    expect(verify.json.tokenHash).toBe("hashed-newhq@thinnr.example");
  });

  it("rolls the created login back when HQ invitation acceptance fails", async () => {
    backend.tables.hq_memberships.push({
      id: "mem-3",
      email: "fragile@thinnr.example",
      display_name: "Fragile Invite",
      status: "invited",
      auth_user_id: null,
    });
    backend.tables.hq_invitations.push({
      id: crypto.randomUUID(),
      membership_id: "mem-3",
      status: "pending",
      token_hash: "invite-hash-2",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    });
    const start = await startLogin("staff", "fragile@thinnr.example");
    backend.failHqAccept = true;
    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(verify.status).toBe(502);
    expect(backend.deletedUsers).toHaveLength(1);
    expect(backend.authUsers.size).toBe(0);
  });

  it("blocks verification when a lock lands after the code was sent", async () => {
    seedProvider({ provider_id: "20005", email: "midlock@clinic.example" });
    const start = await startLogin("staff", "midlock@clinic.example");
    backend.tables.provider_account_locks.push({ account_id: "20005" });
    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(verify.status).toBe(409);
    expect(verify.json.error).toContain("contact your clinic");
    const row = backend.tables.claim_verifications[0];
    expect(row.consumed_at).toBeTruthy();
    // verified_at is the atomic redemption claim, taken the moment the code
    // proves out — the lock denial happens after and spends the row anyway.
    expect(row.verified_at).toBeTruthy();
    expect(backend.authUsers.size).toBe(0);
  });

  it("gives one generic error for wrong codes and locks after five attempts", async () => {
    seedProvider();
    const start = await startLogin("staff", "rivera@clinic.example");
    for (let i = 0; i < 5; i += 1) {
      const wrong = await api("POST", "/api/auth/login/verify", {
        requestId: start.json.requestId,
        code: "000000",
      });
      expect(wrong.status).toBe(400);
      expect(wrong.json.error).toContain("didn't match or has expired");
    }
    const exhausted = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(exhausted.status).toBe(400);
    expect(exhausted.json.error).toContain("didn't match or has expired");
  });

  it("treats expired codes exactly like wrong ones", async () => {
    seedProvider();
    const start = await startLogin("staff", "rivera@clinic.example");
    backend.tables.claim_verifications[0].code_expires_at = new Date(
      Date.now() - 1000,
    ).toISOString();
    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(verify.status).toBe(400);
    expect(verify.json.error).toContain("didn't match or has expired");
  });

  it("refuses to reuse a spent code", async () => {
    seedProvider();
    const start = await startLogin("staff", "rivera@clinic.example");
    const first = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(first.status).toBe(200);
    const second = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(second.status).toBe(400);
  });
});

describe("staff second factor (texted code after the emailed code)", () => {
  const policy = () => backend.tables.hq_organization_settings[0];
  const setPolicy = (flags: Partial<{ hq: boolean; managers: boolean; all: boolean }>) => {
    const row = policy();
    if (flags.hq !== undefined) row.second_factor_hq_users = flags.hq;
    if (flags.managers !== undefined) row.second_factor_office_managers = flags.managers;
    if (flags.all !== undefined) row.second_factor_all_staff = flags.all;
  };
  const OWNER_PHONE = "+15557001001";

  function seedTeamMember(overrides: Row = {}): Row {
    const row: Row = {
      id: crypto.randomUUID(),
      provider_id: "20002",
      name: "Sam Staffer",
      email: "sam@clinic.example",
      activation_status: "activated",
      office_role: "staff",
      auth_user_id: null,
      ...overrides,
    };
    backend.tables.team_members.push(row);
    return row;
  }

  function seedHqMember(overrides: Row = {}): Row {
    const row: Row = {
      id: "mem-hq-1",
      email: "boss@thinnr.example",
      display_name: "The Boss",
      status: "active",
      auth_user_id: "hq-user-1",
      ...overrides,
    };
    backend.tables.hq_memberships.push(row);
    backend.seedAuthUser({ id: String(row.auth_user_id), email: row.email });
    return row;
  }

  function seedFactor(kind: string, ref: string, phone = OWNER_PHONE, enabled = true): Row {
    const row: Row = { staff_kind: kind, staff_ref: ref, phone, verified_at: new Date().toISOString(), enabled };
    backend.tables.staff_second_factors.push(row);
    return row;
  }

  /** Emailed code proven; returns the verify response body. */
  async function proveEmail(email: string) {
    const start = await startLogin("staff", email);
    expect(start.status).toBe(200);
    return api("POST", "/api/auth/login/verify", { requestId: start.json.requestId, code: start.json.devCode });
  }

  async function completeSms(stepToken: string, phone?: string) {
    const start = await api("POST", "/api/auth/login/phone/start", { stepToken, ...(phone ? { phone } : {}) });
    expect(start.status).toBe(200);
    expect(start.json.devCode).toMatch(/^\d{6}$/);
    return { start, verify: await api("POST", "/api/auth/login/phone/verify", { stepToken, requestId: start.json.requestId, code: start.json.devCode }) };
  }

  it("does not open the second step for an office owner while the policy is off and nobody opted in", async () => {
    seedProvider();
    const verify = await proveEmail("rivera@clinic.example");
    expect(verify.status).toBe(200);
    expect(verify.json.tokenHash).toBe("hashed-rivera@clinic.example");
    expect(verify.json.secondFactor).toBeUndefined();
  });

  it("asks an office owner covered by the policy to enrol a phone, then signs in as email+sms", async () => {
    setPolicy({ managers: true });
    const provider = seedProvider();
    const verify = await proveEmail("rivera@clinic.example");
    expect(verify.status).toBe(200);
    // No session yet — only the step handle.
    expect(verify.json).toEqual({
      ok: true,
      realm: "staff",
      secondFactor: { stepToken: expect.stringMatching(/^[0-9a-f]{64}$/), mode: "enroll", destination: null },
    });
    expect(backend.tables.auth_sign_ins).toHaveLength(0);
    expect(provider.auth_user_id).toBeNull();

    // Enrolment needs a phone number.
    const noPhone = await api("POST", "/api/auth/login/phone/start", { stepToken: verify.json.secondFactor.stepToken });
    expect(noPhone.status).toBe(400);
    expect(noPhone.json.field).toBe("phone");

    const { start, verify: done } = await completeSms(verify.json.secondFactor.stepToken, "(555) 700-1001");
    expect(start.json).toMatchObject({ mode: "enroll", destination: "•••-•••-1001" });
    expect(done.status).toBe(200);
    expect(done.json).toEqual({
      ok: true,
      realm: "staff",
      tokenHash: "hashed-rivera@clinic.example",
      signInId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(backend.tables.auth_sign_ins).toHaveLength(1);
    expect(backend.tables.auth_sign_ins[0]).toMatchObject({ realm: "staff", method: "email_sms_code", user_id: provider.auth_user_id });
    expect(backend.tables.staff_second_factors).toEqual([
      expect.objectContaining({ staff_kind: "provider", staff_ref: "20002", phone: OWNER_PHONE, enabled: true }),
    ]);
    expect(backend.audits.some((a) => a.p_action === "security_second_factor_enrolled" && a.p_target_id === "20002")).toBe(true);
    // Both ledger rows are finished; neither step can be replayed.
    const rows = backend.tables.claim_verifications;
    expect(rows.filter((r) => r.purpose === "login")[0].consumed_at).toBeTruthy();
    expect(rows.filter((r) => r.purpose === "staff_sms")[0].consumed_at).toBeTruthy();
    const replay = await api("POST", "/api/auth/login/phone/verify", { stepToken: verify.json.secondFactor.stepToken, requestId: start.json.requestId, code: start.json.devCode });
    expect(replay.status).toBe(400);
  });

  it("texts the phone on file (never a supplied one) and refuses a stale phone binding", async () => {
    setPolicy({ managers: true });
    seedProvider();
    seedFactor("provider", "20002");
    const verify = await proveEmail("rivera@clinic.example");
    expect(verify.json.secondFactor).toMatchObject({ mode: "sms", destination: "•••-•••-1001" });
    const token = verify.json.secondFactor.stepToken;

    const repoint = await api("POST", "/api/auth/login/phone/start", { stepToken: token, phone: "+15559990000" });
    expect(repoint.status).toBe(409);

    const start = await api("POST", "/api/auth/login/phone/start", { stepToken: token });
    expect(start.status).toBe(200);
    expect(start.json.mode).toBe("sms");
    const smsRow = backend.tables.claim_verifications.find((r) => r.purpose === "staff_sms")!;
    expect(smsRow.identifier).toBe(OWNER_PHONE);

    // HQ clears the phone mid-step: the on-file code must not re-enrol it.
    backend.tables.staff_second_factors = [];
    const done = await api("POST", "/api/auth/login/phone/verify", { stepToken: token, requestId: start.json.requestId, code: start.json.devCode });
    expect(done.status).toBe(409);
    expect(backend.tables.auth_sign_ins).toHaveLength(0);
    expect(backend.tables.staff_second_factors).toEqual([]);
  });

  it("applies the HQ rule to HQ members and the all-staff rule to ordinary teammates", async () => {
    seedProvider();
    const hq = seedHqMember();
    seedTeamMember();

    // Rule off for everyone → plain sign-ins.
    expect((await proveEmail("boss@thinnr.example")).json.tokenHash).toBeTruthy();
    expect((await proveEmail("sam@clinic.example")).json.tokenHash).toBeTruthy();

    setPolicy({ hq: true });
    backend.tables.claim_verifications = [];
    const hqStep = await proveEmail("boss@thinnr.example");
    expect(hqStep.json.secondFactor?.mode).toBe("enroll");
    expect((await proveEmail("sam@clinic.example")).json.tokenHash).toBeTruthy();
    const { verify: hqDone } = await completeSms(hqStep.json.secondFactor.stepToken, "+15557002002");
    expect(hqDone.status).toBe(200);
    expect(backend.tables.staff_second_factors).toContainEqual(expect.objectContaining({ staff_kind: "hq", staff_ref: String(hq.id) }));

    setPolicy({ hq: false, all: true });
    backend.tables.claim_verifications = [];
    expect((await proveEmail("sam@clinic.example")).json.secondFactor?.mode).toBe("enroll");
  });

  it("covers office admins under the managers rule, and a personal opt-in covers anyone", async () => {
    setPolicy({ managers: true });
    seedProvider();
    const admin = seedTeamMember({ id: crypto.randomUUID(), email: "ada@clinic.example", office_role: "admin" });
    const staff = seedTeamMember();
    expect((await proveEmail("ada@clinic.example")).json.secondFactor?.mode).toBe("enroll");
    expect((await proveEmail("sam@clinic.example")).json.tokenHash).toBeTruthy();
    expect(admin.id).toBeTruthy();

    // Ordinary staff who enrolled from their Security page get the step too.
    seedFactor("team_member", String(staff.id), "+15557003003", true);
    backend.tables.claim_verifications = [];
    const step = await proveEmail("sam@clinic.example");
    expect(step.json.secondFactor).toMatchObject({ mode: "sms", destination: "•••-•••-3003" });
    const { verify: done } = await completeSms(step.json.secondFactor.stepToken);
    expect(done.status).toBe(200);
    expect(backend.tables.auth_sign_ins.at(-1)?.method).toBe("email_sms_code");

    // Opt-in switched off (and no rule) → emailed code alone again.
    backend.tables.staff_second_factors[0].enabled = false;
    backend.tables.claim_verifications = [];
    expect((await proveEmail("sam@clinic.example")).json.tokenHash).toBeTruthy();
  });

  it("shares the per-phone hourly send pot with every other rail and answers 429 past it", async () => {
    setPolicy({ managers: true });
    seedProvider();
    seedFactor("provider", "20002");
    const token = (await proveEmail("rivera@clinic.example")).json.secondFactor.stepToken;
    for (let i = 0; i < 3; i += 1) {
      expect((await api("POST", "/api/auth/login/phone/start", { stepToken: token })).status).toBe(200);
    }
    const fourth = await api("POST", "/api/auth/login/phone/start", { stepToken: token });
    expect(fourth.status).toBe(429);
    expect(fourth.json.retryable).toBe(true);
    expect(backend.tables.claim_verifications.filter((r) => r.purpose === "staff_sms")).toHaveLength(3);
  });

  it("treats an unknown, patient, expired, or finished step token like an expired session", async () => {
    setPolicy({ managers: true });
    seedProvider();
    const unknown = await api("POST", "/api/auth/login/phone/start", { stepToken: "f".repeat(64), phone: OWNER_PHONE });
    expect(unknown.status).toBe(400);
    expect(unknown.json.code).toBe("STEP_EXPIRED");

    const verify = await proveEmail("rivera@clinic.example");
    const token = verify.json.secondFactor.stepToken;
    backend.tables.claim_verifications[0].verified_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const stale = await api("POST", "/api/auth/login/phone/start", { stepToken: token, phone: OWNER_PHONE });
    expect(stale.status).toBe(400);
    expect(stale.json.code).toBe("STEP_EXPIRED");
    expect(backend.tables.auth_sign_ins).toHaveLength(0);
  });

  it("falls back to the default rule (HQ + managers on) when the policy cannot be read", async () => {
    backend.tables.hq_organization_settings = [];
    seedProvider();
    seedTeamMember();
    expect((await proveEmail("rivera@clinic.example")).json.secondFactor?.mode).toBe("enroll");
    expect((await proveEmail("sam@clinic.example")).json.tokenHash).toBeTruthy();
  });

  it("rejects a texted code that belongs to a different step", async () => {
    setPolicy({ managers: true });
    seedProvider();
    seedProvider({ provider_id: "20003", email: "other@clinic.example", provider_name: "Dr. Other" });
    const a = (await proveEmail("rivera@clinic.example")).json.secondFactor.stepToken;
    const b = (await proveEmail("other@clinic.example")).json.secondFactor.stepToken;
    const startB = await api("POST", "/api/auth/login/phone/start", { stepToken: b, phone: "+15557004004" });
    expect(startB.status).toBe(200);
    const crossed = await api("POST", "/api/auth/login/phone/verify", { stepToken: a, requestId: startB.json.requestId, code: startB.json.devCode });
    expect(crossed.status).toBe(400);
    expect(backend.tables.auth_sign_ins).toHaveLength(0);
    expect(backend.tables.staff_second_factors).toEqual([]);
  });
});

describe("patient password + MFA login", () => {
  function seedLinkedPasswordPatient(overrides: Row = {}) {
    const patient = seedPatient({ activation_status: "activated", ...overrides });
    const user = backend.seedAuthUser({
      email: `pt-${String(patient.id).toLowerCase()}@patients.thinnr.invalid`,
      password: "OldStrong!Pass",
    });
    patient.auth_user_id = user.id;
    return { patient, user };
  }

  it("signs a patient in by phone, minting a synthetic-email login", async () => {
    const patient = seedPatient();
    const start = await startLogin("patient", "(555) 201-3344");
    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(verify.status).toBe(200);
    expect(verify.json.realm).toBe("patient");
    expect(patient.auth_user_id).toBeTruthy();
    const user = backend.authUsers.get(String(patient.auth_user_id))!;
    expect(user.email).toBe(`pt-${String(patient.id).toLowerCase()}@patients.thinnr.invalid`);
    expect(user.phone).toBe("+15552013344");
    expect(verify.json.tokenHash).toBe(`hashed-${user.email}`);
  });

  it("falls back to email codes for patients", async () => {
    seedPatient({ email: "casey@example.com" });
    const start = await startLogin("patient", "Casey@Example.com");
    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(verify.status).toBe(200);
    expect(verify.json.realm).toBe("patient");
    expect(backend.tables.claim_verifications[0].identifier_kind).toBe("email");
  });

  it("never surfaces disabled patients", async () => {
    seedPatient({ activation_status: "disabled" });
    const result = await livePatientLogin("5552013344");
    expect(result.status).toBe(401);
    expect(result.json.error).toContain("password");
    expect(backend.tables.claim_verifications).toHaveLength(0);
  });

  it("spends a password MFA code when the patient is disabled before verification", async () => {
    const { patient } = seedLinkedPasswordPatient();
    const start = await api("POST", "/api/auth/patient/password/login", {
      identifier: "5552013344", password: "OldStrong!Pass",
    });
    patient.activation_status = "disabled";

    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId, code: start.json.devCode,
    });
    expect(verify.status).toBe(409);
    expect(verify.json.error).toContain("contact your clinic");
    expect(verify.json.tokenHash).toBeUndefined();
    expect(backend.tables.claim_verifications[0].consumed_at).toBeTruthy();
  });

  it("spends a password MFA code when its identifier is reassigned or auth link changes", async () => {
    const { patient: original, user: originalUser } = seedLinkedPasswordPatient();
    const start = await api("POST", "/api/auth/patient/password/login", {
      identifier: "5552013344", password: "OldStrong!Pass",
    });

    // Model a completed reassignment with no duplicate contacts: the old row
    // loses the identifier and link while a distinct, linked row receives it.
    original.phone = "+15559990000";
    original.auth_user_id = backend.seedAuthUser({
      email: `pt-${String(original.id).toLowerCase()}-relinked@patients.thinnr.invalid`,
      password: "OtherStrong!Pass",
    }).id;
    const replacementUser = backend.seedAuthUser({
      email: "pt-reassigned@patients.thinnr.invalid",
      password: "ReplacementStrong!Pass",
    });
    const replacement = seedPatient({
      phone: "+15552013344",
      auth_user_id: replacementUser.id,
    });
    expect(
      backend.tables.patients.filter((p) => p.phone === "+15552013344"),
    ).toEqual([replacement]);

    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId, code: start.json.devCode,
    });
    expect(verify.status).toBe(409);
    expect(verify.json.error).toContain("contact your clinic");
    expect(verify.json.tokenHash).toBeUndefined();
    expect(backend.tables.claim_verifications[0].consumed_at).toBeTruthy();
    expect(backend.authUsers.get(String(originalUser.id))).toBe(originalUser);
  });
});

describe("patient signup", () => {
  it("resolves offices by onboarding code and legacy id, hiding locked or disabled ones", async () => {
    seedSignupOffice();
    seedProvider({ provider_id: "10001", office_name: "Bayshore Annex", email: "annex@clinic.example" });
    const byCode = await api("POST", "/api/auth/signup/office", { code: "654321" });
    expect(byCode.status).toBe(200);
    expect(byCode.json.officeName).toBe("Bayshore Slim Clinic");
    const byLegacy = await api("POST", "/api/auth/signup/office", { code: "10001" });
    expect(byLegacy.status).toBe(200);
    expect(byLegacy.json.officeName).toBe("Bayshore Annex");

    const unknown = await api("POST", "/api/auth/signup/office", { code: "99999" });
    expect(unknown.status).toBe(404);

    backend.tables.provider_account_locks.push({ account_id: SIGNUP_OFFICE_ID });
    const locked = await api("POST", "/api/auth/signup/office", { code: "654321" });
    expect(locked.status).toBe(404);

    backend.tables.provider_account_locks.length = 0;
    (backend.tables.providers[0] as Row).access_disabled = true;
    const disabled = await api("POST", "/api/auth/signup/office", { code: "654321" });
    expect(disabled.status).toBe(404);
  });

  it("creates a real patient under the office end to end", async () => {
    seedSignupOffice();
    const token = await signupToDetails("813-555-0101");
    const complete = await api("POST", "/api/auth/signup/complete", {
      signupToken: token,
      password: "Strong!Pass",
      name: "  Riley   Newcomer ",
      email: "Riley@Example.com",
    });
    expect(complete.status).toBe(200);
    expect(complete.json.ok).toBe(true);

    const patient = backend.tables.patients[0];
    expect(patient.provider_id).toBe(SIGNUP_OFFICE_ID);
    expect(patient.name).toBe("Riley Newcomer");
    expect(patient.email).toBe("riley@example.com");
    expect(patient.phone).toBe("+18135550101");
    expect(patient.activation_status).toBe("activated");
    expect(patient.auth_user_id).toBeTruthy();
    expect(patient.claimed_at).toBeTruthy();
    // The signup code went to the phone; the email still needs its own code.
    expect(patient.phone_verified_at).toEqual(expect.any(String));
    expect(patient.email_verified_at ?? null).toBeNull();

    const user = backend.authUsers.get(String(patient.auth_user_id))!;
    expect(user.email).toBe(`pt-${String(patient.id).toLowerCase()}@patients.thinnr.invalid`);
    expect(user.phone).toBe("+18135550101");
    expect((user.app_metadata as Row).thinnr_claim).toBe("patient");
    expect(complete.json.tokenHash).toBe(`hashed-${user.email}`);
  });

  it("requires an explicit password without creating or mutating a patient", async () => {
    seedSignupOffice();
    const token = await signupToDetails("813-555-0199");
    const result = await api("POST", "/api/auth/signup/complete", {
      signupToken: token, name: "No Password", email: "no-password@example.com",
    });
    expect(result.status).toBe(400);
    expect(result.json.field).toBe("password");
    expect(backend.tables.patients).toHaveLength(0);
    expect(backend.authUsers.size).toBe(0);
  });

  it("enrolls an existing phone through completion instead of duplicating", async () => {
    seedSignupOffice();
    const patient = seedPatient({ phone: "+18135550101" });
    const start = await api("POST", "/api/auth/signup/start", {
      code: "654321",
      phone: "8135550101",
    });
    expect(start.status).toBe(200);
    const verify = await api("POST", "/api/auth/signup/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(verify.status).toBe(200);
    expect(verify.json.mode).toBe("enroll");
    expect(verify.json.signupToken).toMatch(/^[0-9a-f]{64}$/);
    const complete = await api("POST", "/api/auth/signup/complete", {
      signupToken: verify.json.signupToken,
      password: "Strong!Pass",
      email: "existing@example.com",
    });
    expect(complete.status).toBe(200);
    expect(complete.json.tokenHash).toBeTruthy();
    expect(backend.tables.patients).toHaveLength(1);
    expect(patient.auth_user_id).toBeTruthy();
  });

  it("sends ambiguous shared phones to the clinic", async () => {
    seedSignupOffice();
    seedPatient({ phone: "+18135550101" });
    seedPatient({ phone: "+18135550101" });
    const start = await api("POST", "/api/auth/signup/start", {
      code: "654321",
      phone: "8135550101",
    });
    const verify = await api("POST", "/api/auth/signup/verify", {
      requestId: start.json.requestId,
      code: start.json.devCode,
    });
    expect(verify.status).toBe(409);
    expect(verify.json.error).toContain("contact your clinic");
  });

  it("rejects an email already on a patient account before creating anything", async () => {
    seedSignupOffice();
    seedPatient({ email: "taken@example.com", phone: "+18135550999" });
    const token = await signupToDetails("813-555-0101");
    const complete = await api("POST", "/api/auth/signup/complete", {
      signupToken: token,
      password: "Strong!Pass",
      name: "Riley Newcomer",
      email: "Taken@Example.com",
    });
    expect(complete.status).toBe(409);
    expect(complete.json.field).toBe("email");
    expect(backend.tables.patients).toHaveLength(1);
    expect(backend.authUsers.size).toBe(0); // pre-check fired before any login was created
  });

  it("lets the unique index backstop an email landing mid-request", async () => {
    seedSignupOffice();
    const token = await signupToDetails("813-555-0101");
    backend.onEmailPrecheck = () => {
      backend.tables.patients.push({
        id: crypto.randomUUID(),
        provider_id: SIGNUP_OFFICE_ID,
        name: "Photo Finish",
        email: "riley@example.com",
        phone: "+18135550777",
        activation_status: "activated",
        auth_user_id: crypto.randomUUID(),
      });
    };
    const complete = await api("POST", "/api/auth/signup/complete", {
      signupToken: token,
      password: "Strong!Pass",
      name: "Riley Newcomer",
      email: "riley@example.com",
    });
    expect(complete.status).toBe(409);
    expect(complete.json.field).toBe("email");
    expect(backend.deletedUsers).toHaveLength(1); // the just-created login was rolled back
    expect(backend.tables.patients).toHaveLength(1);
  });

  it("maps the hardened normalized index names and removes the orphan login", async () => {
    seedSignupOffice();
    for (const [indexName, field] of [
      ["patients_email_normalized_unique_idx", "email"],
      ["patients_phone_normalized_unique_idx", undefined],
    ] as const) {
      const token = await signupToDetails(
        indexName.includes("email") ? "813-555-0101" : "813-555-0102",
      );
      const originalHandle = backend.handle.bind(backend);
      let intercepted = false;
      backend.handle = ((input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (
          !intercepted &&
          url.pathname === "/rest/v1/patients" &&
          init?.method === "POST"
        ) {
          intercepted = true;
          return json(409, {
            message: `duplicate key value violates unique constraint "${indexName}"`,
          });
        }
        return originalHandle(input, init);
      }) as typeof backend.handle;
      const complete = await api("POST", "/api/auth/signup/complete", {
        signupToken: token,
        password: "Strong!Pass",
        name: "Riley Newcomer",
        email: `${indexName}@example.com`,
      });
      backend.handle = originalHandle;
      expect(complete.status).toBe(409);
      expect(complete.json.field).toBe(field);
    }
    expect(backend.tables.patients).toHaveLength(0);
    expect(backend.authUsers.size).toBe(0);
    expect(backend.deletedUsers).toHaveLength(2);
  });

  it("lands exactly one patient when the same verified signup completes in parallel", async () => {
    seedSignupOffice();
    const firstToken = await signupToDetails("813-555-0101");
    const secondToken = await signupToDetails("813-555-0101");
    const finish = (signupToken: string) =>
      api("POST", "/api/auth/signup/complete", {
        signupToken,
        password: "Strong!Pass",
        name: "Riley Newcomer",
        email: "riley@example.com",
      });
    const responses = await Promise.all([finish(firstToken), finish(secondToken)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(backend.tables.patients).toHaveLength(1);
    expect(backend.authUsers.size).toBe(1);
    expect(backend.tables.patients[0].auth_user_id).toBe(
      [...backend.authUsers.keys()][0],
    );
  });

  it("refuses signup completion when the phone already holds a login", async () => {
    seedSignupOffice();
    backend.seedAuthUser({ email: "someone@else.example", phone: "+18135550101" });
    const token = await signupToDetails("813-555-0101");
    const complete = await api("POST", "/api/auth/signup/complete", {
      signupToken: token,
      password: "Strong!Pass",
      name: "Riley Newcomer",
      email: "riley@example.com",
    });
    expect(complete.status).toBe(409);
    expect(complete.json.error).toContain("already has a login");
    expect(backend.tables.patients).toHaveLength(0);
  });

  it("re-checks the office at completion so a mid-signup lock blocks it", async () => {
    seedSignupOffice();
    const token = await signupToDetails("813-555-0101");
    backend.tables.provider_account_locks.push({ account_id: SIGNUP_OFFICE_ID });
    const complete = await api("POST", "/api/auth/signup/complete", {
      signupToken: token,
      password: "Strong!Pass",
      name: "Riley Newcomer",
      email: "riley@example.com",
    });
    expect(complete.status).toBe(409);
    expect(complete.json.error).toContain("provider code");
    expect(backend.tables.patients).toHaveLength(0);
    expect(backend.authUsers.size).toBe(0);
  });

  it("caps signup sends per office, silently", async () => {
    seedSignupOffice();
    for (let i = 0; i < 30; i += 1) {
      backend.tables.claim_verifications.push({
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        purpose: "signup",
        identifier_kind: "phone",
        identifier: `+1813555${String(1000 + i)}`,
        scope_key: `signup:${SIGNUP_OFFICE_ID}`,
        code_attempts: 0,
      });
    }
    const res = await api("POST", "/api/auth/signup/start", {
      code: "654321",
      phone: "813-555-0101",
    });
    expect(res.status).toBe(200);
    expect(res.json.devCode).toMatch(/^\d{6}$/); // decoy — nothing was stored
    expect(backend.tables.claim_verifications).toHaveLength(30);
  });

  it("caps total sends per destination across login and signup without inventing a patient code", async () => {
    seedSignupOffice();
    seedPatient({ phone: "+18135550101" });
    const loginStart = () => startLogin("patient", "813-555-0101");
    const signupStart = () =>
      api("POST", "/api/auth/signup/start", { code: "654321", phone: "813-555-0101" });

    expect((await loginStart()).status).toBe(200); // 1st stored
    expect((await signupStart()).status).toBe(200); // 2nd stored
    expect((await loginStart()).status).toBe(200); // 3rd stored
    expect(backend.tables.claim_verifications).toHaveLength(3);

    // The 3/hr destination budget is one shared pot across ALL code purposes.
    // Signup stays neutral; password login can safely explain the cap because
    // the password has already been proven.
    const fourth = await signupStart();
    expect(fourth.status).toBe(200);
    expect(fourth.json.devCode).toMatch(/^\d{6}$/); // decoy
    const fifth = await api("POST", "/api/auth/patient/password/login", {
      identifier: "813-555-0101",
      password: "OldStrong!Pass",
    });
    expect(fifth.status).toBe(429);
    expect(fifth.json.requestId).toBeUndefined();
    expect(backend.tables.claim_verifications).toHaveLength(3);
  });
});

describe("parallel code redemption", () => {
  // A one-time code must be redeemable exactly once even when the same code
  // arrives in several concurrent verify requests: the winner claims the
  // ledger row atomically and every racer gets the same wrong-code error.

  it("redeems a login code exactly once under parallel verification", async () => {
    seedPatient();
    const start = await startLogin("patient", "(555) 201-3344");
    const requestId = start.json.requestId as string;
    const code = start.json.devCode as string;
    const fire = () => api("POST", "/api/auth/login/verify", { requestId, code });

    // Park the first verify right after its code check (its next backend
    // call is the patient lookup RPC) so it cannot finish, then replay the same
    // code through two full-speed challengers — the widest possible race.
    let release!: () => void;
    backend.pauseOnce = {
      pathPrefix: "/rest/v1/rpc/claim_find_candidates",
      gate: new Promise((resolve) => {
        release = resolve;
      }),
    };
    const parked = fire();
    await new Promise((resolve) => setTimeout(resolve, 5)); // parked mid-flight
    const challengers = await Promise.all([fire(), fire()]);
    release();
    const results = [await parked, ...challengers];

    const wins = results.filter((r) => r.status === 200 && r.json.tokenHash);
    expect(wins).toHaveLength(1);
    for (const r of results) {
      if (r === wins[0]) continue;
      expect(r.status).toBe(400);
      expect(r.json.tokenHash).toBeUndefined();
    }
    // Exactly one session was minted end to end.
    expect(backend.tables.claim_verifications.filter((r) => r.consumed_at)).toHaveLength(1);
  });

  it("issues exactly one signup token under parallel verification", async () => {
    seedSignupOffice();
    const start = await api("POST", "/api/auth/signup/start", {
      code: "654321",
      phone: "813-555-0187",
    });
    const requestId = start.json.requestId as string;
    const code = start.json.devCode as string;
    const fire = () => api("POST", "/api/auth/signup/verify", { requestId, code });

    let release!: () => void;
    backend.pauseOnce = {
      pathPrefix: "/rest/v1/rpc/claim_find_candidates",
      gate: new Promise((resolve) => {
        release = resolve;
      }),
    };
    const parked = fire();
    await new Promise((resolve) => setTimeout(resolve, 5)); // parked mid-flight
    const challengers = await Promise.all([fire(), fire()]);
    release();
    const results = [await parked, ...challengers];

    const tokens = results.filter((r) => r.status === 200 && r.json.signupToken);
    expect(tokens).toHaveLength(1);
    for (const r of results) {
      if (r === tokens[0]) continue;
      expect(r.status).toBe(400);
      expect(r.json.signupToken).toBeUndefined();
    }
    // Exactly one verification token exists in the ledger.
    expect(
      backend.tables.claim_verifications.filter((r) => r.claim_token_hash),
    ).toHaveLength(1);
  });
});

describe("live delivery", () => {
  it("fails loudly when flipped live without credentials", async () => {
    seedPatient();
    process.env.CLAIM_SMS_DELIVERY_MODE = "live";
    const sms = await livePatientLogin("5552013344");
    expect(sms.status).toBe(503);

    process.env.CLAIM_SMS_DELIVERY_MODE = "dev";
    process.env.CLAIM_EMAIL_DELIVERY_MODE = "live";
    seedProvider();
    const email = await api("POST", "/api/auth/login/start", {
      realm: "staff",
      identifier: "rivera@clinic.example",
    });
    expect(email.status).toBe(503);
  });

  it("texts through Twilio Verify and verifies through it", async () => {
    seedPatient();
    process.env.CLAIM_SMS_DELIVERY_MODE = "live";
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest";

    const start = await livePatientLogin("5552013344");
    expect(start.status).toBe(200);
    expect(start.json.devCode).toBeUndefined();
    expect(backend.twilioStarts).toEqual(["+15552013344"]);

    backend.twilioApprovedCode = "246810";
    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: "246810",
    });
    expect(verify.status).toBe(200);
    expect(verify.json.realm).toBe("patient");
  });

  it("uses the patient-row phone for a linked patient when auth has no phone", async () => {
    const auth = backend.seedAuthUser({
      email: "placeholder",
      phone: null,
      password: "OldStrong!Pass",
    });
    const patient = seedPatient({
      phone: "+1 (555) 201-3344",
      email: "casey@example.com",
      activation_status: "activated",
      auth_user_id: auth.id,
    });
    auth.email = `pt-${String(patient.id).toLowerCase()}@patients.thinnr.invalid`;
    process.env.CLAIM_SMS_DELIVERY_MODE = "live";
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest";

    const start = await livePatientLogin("555-201-3344");
    expect(start.status).toBe(200);
    expect(backend.twilioStarts).toEqual(["+15552013344"]);
    expect(backend.tables.claim_verifications[0].identifier).toBe("+15552013344");

    backend.twilioApprovedCode = "135790";
    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: "135790",
    });
    expect(verify.status).toBe(200);
    expect(verify.json.tokenHash).toBe(`hashed-${String(auth.email)}`);
    expect(patient.auth_user_id).toBe(auth.id);
    expect(backend.authUsers.get(String(auth.id))?.phone).toBeNull();
  });

  it("opens MFA before Twilio settles, then spends a rejected send so retry stays available", async () => {
    seedPatient();
    process.env.CLAIM_SMS_DELIVERY_MODE = "live";
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest";
    backend.twilioStartFailure = { status: 400, code: 60200 };

    const rejected = await livePatientLogin("5552013344");
    expect(rejected.status).toBe(200);
    expect(rejected.json.requestId).toBeTruthy();
    await vi.waitFor(() => {
      expect(backend.tables.claim_verifications[0].consumed_at).toBeTruthy();
    });
    expect(routeErrors).toContain(
      "patient password sms delivery rejected: Twilio Verify start rejected (400, provider code 60200)",
    );
    expect(backend.tables.claim_verifications).toHaveLength(1);

    backend.twilioStartFailure = null;
    const retry = await livePatientLogin("5552013344");
    expect(retry.status).toBe(200);
    expect(backend.tables.claim_verifications).toHaveLength(2);
    expect(backend.twilioStarts).toHaveLength(2);
  });

  it("waits for Resend acceptance before opening the patient code step", async () => {
    const patient = seedPatient({ email: "casey@example.com", activation_status: "activated" });
    const user = backend.seedAuthUser({
      email: `pt-${String(patient.id).toLowerCase()}@patients.thinnr.invalid`,
      password: "OldStrong!Pass",
    });
    patient.auth_user_id = user.id;
    process.env.CLAIM_EMAIL_DELIVERY_MODE = "live";
    process.env.RESEND_API_KEY = "re_test";
    process.env.CLAIM_EMAIL_FROM = "THINNR <no-reply@thinnr.example>";
    backend.resendFailure = true;

    const rejected = await livePatientLogin("casey@example.com");
    expect(rejected.status).toBe(502);
    expect(rejected.json.requestId).toBeUndefined();
    expect(backend.tables.claim_verifications[0].consumed_at).toBeTruthy();

    backend.resendFailure = false;
    const accepted = await livePatientLogin("casey@example.com");
    expect(accepted.status).toBe(200);
    expect(accepted.json.requestId).toBeTruthy();
    expect(backend.sentEmails).toHaveLength(2);
  });

  it("opens the code step while Twilio starts, then preserves the send cap", async () => {
    seedPatient();
    process.env.CLAIM_SMS_DELIVERY_MODE = "live";
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest";
    backend.twilioStartFailure = { status: 429, code: 20429 };

    const miss = await livePatientLogin("5559990000");
    const hits = [];
    for (let index = 0; index < 4; index += 1) {
      hits.push(
        await livePatientLogin("5552013344"),
      );
    }

    expect(miss.status).toBe(401);
    expect(hits.slice(0, 3).every((hit) => hit.status === 200)).toBe(true);
    expect(hits.slice(0, 3).every((hit) => hit.json.requestId)).toBe(true);
    expect(hits[3].status).toBe(429);
    expect(hits[3].json.retryable).toBe(true);
    expect(backend.twilioStarts).toHaveLength(3);
    expect(backend.tables.claim_verifications).toHaveLength(3);
    expect(backend.tables.claim_verifications.every((row) => row.consumed_at)).toBe(true);
  });

  it("does not pull the patient back from MFA when rejected-send recording also fails", async () => {
    seedPatient();
    process.env.CLAIM_SMS_DELIVERY_MODE = "live";
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest";
    backend.twilioStartFailure = { status: 500 };
    backend.failRejectedSendSpend = true;

    const miss = await livePatientLogin("5559990000");
    const hit = await livePatientLogin("5552013344");
    expect(miss.status).toBe(401);
    expect(hit.status).toBe(200);
    expect(hit.json.requestId).toBeTruthy();
    expect(backend.tables.claim_verifications).toHaveLength(1);
    expect(routeErrors.some((line) => line.includes("ledger update failed"))).toBe(true);
  });

  it("does not let a stalled rejected-send ledger update delay the MFA screen", async () => {
    seedPatient();
    process.env.CLAIM_SMS_DELIVERY_MODE = "live";
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest";
    process.env.AUTH_SMS_DELIVERY_FLOOR_MS = "30";
    backend.twilioStartFailure = { status: 500 };
    let release!: () => void;
    backend.pauseOnce = {
      pathPrefix: "/rest/v1/claim_verifications",
      gate: new Promise((resolve) => {
        release = resolve;
      }),
    };

    const started = performance.now();
    const hit = await livePatientLogin("5552013344");
    const elapsed = performance.now() - started;
    expect(hit.status).toBe(200);
    expect(hit.json.requestId).toBeTruthy();
    expect(elapsed).toBeLessThan(200);
    expect(backend.tables.claim_verifications).toHaveLength(1);

    release();
    await settle();
    expect(backend.tables.claim_verifications[0].consumed_at).toBeTruthy();
  });

  it("lets a proven password skip the SMS floor while unknown phones keep it", async () => {
    seedPatient();
    process.env.CLAIM_SMS_DELIVERY_MODE = "live";
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest";
    process.env.AUTH_SMS_DELIVERY_FLOOR_MS = "30";

    const timed = async (identifier: string) => {
      const started = performance.now();
      const response = await livePatientLogin(identifier);
      return { response, elapsed: performance.now() - started };
    };
    const hit = await timed("5552013344");
    const miss = await timed("5559990000");
    expect(hit.response.status).toBe(200);
    expect(miss.response.status).toBe(401);
    expect(hit.elapsed).toBeLessThan(25);
    expect(miss.elapsed).toBeGreaterThanOrEqual(25);
  });

  it("forces production SMS live while leaving the email channel independently configurable", async () => {
    seedPatient();
    process.env.NODE_ENV = "production";
    process.env.CLAIM_DELIVERY_MODE = "dev";
    process.env.CLAIM_SMS_DELIVERY_MODE = "dev";
    process.env.CLAIM_EMAIL_DELIVERY_MODE = "dev";
    try {
      const sms = await livePatientLogin("5552013344");
      expect(sms.status).toBe(503);

      seedProvider();
      const email = await api("POST", "/api/auth/login/start", {
        realm: "staff",
        identifier: "rivera@clinic.example",
      });
      expect(email.status).toBe(200);
      expect(email.json.devCode).toMatch(/^\d{6}$/);
    } finally {
      process.env.NODE_ENV = "test";
    }
  });

  it("does not apply the SMS floor to staff or patient email logins", async () => {
    seedProvider();
    seedPatient({ email: "casey@example.com" });
    process.env.NODE_ENV = "production";
    process.env.CLAIM_SMS_DELIVERY_MODE = "dev";
    process.env.CLAIM_EMAIL_DELIVERY_MODE = "dev";
    try {
      for (const [realm, known, unknown] of [
        ["staff", "rivera@clinic.example", "missing-staff@example.com"],
        ["patient", "casey@example.com", "missing-patient@example.com"],
      ] as const) {
        const timed = async (identifier: string) => {
          const started = performance.now();
          const response = realm === "staff"
            ? await api("POST", "/api/auth/login/start", { realm, identifier })
            : await livePatientLogin(identifier);
          return { response, elapsed: performance.now() - started };
        };
        const hit = await timed(known);
        const miss = await timed(unknown);
        expect(hit.response.status).toBe(200);
        expect(miss.response.status).toBe(realm === "staff" ? 200 : 401);
        if (realm === "staff") {
          expect(Object.keys(hit.response.json).sort()).toEqual(
            Object.keys(miss.response.json).sort(),
          );
        } else {
          expect(miss.response.json.error).toContain("password");
        }
        expect(hit.elapsed).toBeLessThan(500);
        expect(miss.elapsed).toBeLessThan(500);
      }
    } finally {
      process.env.NODE_ENV = "test";
    }
  });

  it("emails staff codes through Resend", async () => {
    seedProvider();
    process.env.CLAIM_EMAIL_DELIVERY_MODE = "live";
    process.env.RESEND_API_KEY = "re_test";
    process.env.CLAIM_EMAIL_FROM = "THINNR <no-reply@thinnr.example>";

    const start = await api("POST", "/api/auth/login/start", {
      realm: "staff",
      identifier: "rivera@clinic.example",
    });
    expect(start.status).toBe(200);
    expect(start.json.devCode).toBeUndefined();
    await settle();
    expect(backend.sentEmails).toHaveLength(1);
    expect(backend.sentEmails[0].to).toBe("rivera@clinic.example");
    expect(backend.sentEmails[0].code).toMatch(/^\d{6}$/);

    const verify = await api("POST", "/api/auth/login/verify", {
      requestId: start.json.requestId,
      code: backend.sentEmails[0].code,
    });
    expect(verify.status).toBe(200);
    expect(verify.json.realm).toBe("staff");
  });
});
