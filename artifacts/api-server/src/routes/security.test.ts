/**
 * Account security suite — sign-in ledger, session management, password
 * change, "this wasn't me", recovery hardening, staff/HQ views, and the
 * neutrality rules, all against an in-memory fake of Supabase REST, GoTrue,
 * Resend and the audit RPC.
 *
 * The auth suite (auth.test.ts) owns the login rails themselves; this file
 * checks what those rails now record and what the /security routes do with
 * it. Sessions are faked as JWTs whose payload carries `sub` + `session_id`,
 * which is exactly what the routes read (unverified) to know "this device".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { createFakeSigner } from "../auth/testing/fake-jwt";
import { resetAccessTokenVerifierForTests } from "../auth/access-token";

const FAKE_SUPABASE = "http://fake.supabase.local";
/** ES256 signer standing in for the project's GoTrue key; served at the fake JWKS endpoint. */
const signer = createFakeSigner({ kid: "kid-live", issuer: `${FAKE_SUPABASE}/auth/v1` });

type Row = Record<string, unknown>;
type Cond = [string, string, string];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fake access token: `<header>.<payload>.<sig>` with sub + session_id. */
function tokenFor(userId: string, sessionId: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

function claimsOf(token: string): { sub?: string; session_id?: string } | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

class FakeBackend {
  tables: Record<string, Row[]> = {};
  authUsers = new Map<string, Row>();
  /** Live GoTrue sessions: session_id → row. */
  sessions = new Map<string, Row>();
  audits: Row[] = [];
  emails: Array<{ to: string; subject: string; html: string; text: string }> = [];
  adminLogouts: string[] = [];
  othersLogouts: string[] = [];
  failOthersLogout = false;
  failAdminLogout = false;
  failRevocationWrites = false;
  /** Every Supabase call the API made, as "METHOD /path". */
  requests: string[] = [];

  reset() {
    this.tables = {
      patients: [],
      providers: [],
      team_members: [],
      hq_memberships: [],
      hq_team_members: [],
      // The HQ roster dates pending setup links from this table.
      hq_invitations: [],
      profiles: [],
      provider_account_locks: [],
      claim_verifications: [],
      auth_sign_ins: [],
      account_security_state: [],
      patient_push_tokens: [],
      patient_notifications: [],
      auth_session_revocations: [],
      staff_second_factors: [],
      hq_organization_settings: [
        { singleton: true, second_factor_hq_users: false, second_factor_office_managers: false, second_factor_all_staff: false },
      ],
    };
    this.authUsers.clear();
    this.sessions.clear();
    this.audits = [];
    this.emails = [];
    this.adminLogouts = [];
    this.othersLogouts = [];
    this.failOthersLogout = false;
    this.failAdminLogout = false;
    this.failRevocationWrites = false;
    this.requests = [];
  }

  seedAuthUser(overrides: Row = {}): Row {
    const id = (overrides.id as string | undefined) ?? crypto.randomUUID();
    const user = { id, email: null, phone: null, app_metadata: {}, user_metadata: {}, ...overrides };
    this.authUsers.set(id, user);
    return user;
  }

  /** Open a GoTrue session for the user and return its bearer token. */
  openSession(userId: string, userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) THINNR/1.0"): { sessionId: string; token: string } {
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    this.sessions.set(sessionId, { session_id: sessionId, user_id: userId, created_at: now, updated_at: now, refreshed_at: now, not_after: null, user_agent: userAgent, ip: "203.0.113.9/32" });
    return { sessionId, token: tokenFor(userId, sessionId) };
  }

  /** Like openSession, but the token is a genuine ES256 JWT the API can verify locally. */
  openVerifiedSession(userId: string, userAgent = IPHONE_UA): { sessionId: string; token: string } {
    const opened = this.openSession(userId, userAgent);
    const user = this.authUsers.get(userId);
    return { sessionId: opened.sessionId, token: signer.sign({ sub: userId, session_id: opened.sessionId, email: user?.email ?? undefined }) };
  }

  private rowMatches(row: Row, [col, op, value]: Cond): boolean {
    const cell = row[col];
    if (op === "eq") return String(cell ?? "") === value;
    if (op === "neq") return String(cell ?? "") !== value;
    if (op === "ilike") return String(cell ?? "").toLowerCase() === value.toLowerCase();
    if (op === "gt") return typeof cell === "string" && cell > value;
    if (op === "lt") return typeof cell === "string" && cell < value;
    if (op === "in") {
      const list = value.replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/^"|"$/g, ""));
      return list.includes(String(cell ?? ""));
    }
    if (op === "is") {
      if (value === "null") return cell === null || cell === undefined;
      if (value === "false") return cell === false;
      if (value === "true") return cell === true;
    }
    throw new Error(`fake: unsupported op ${op}`);
  }

  private parse(url: URL): { conditions: Cond[]; orGroups: Cond[][]; order: string | null; limit: number | null } {
    const conditions: Cond[] = [];
    const orGroups: Cond[][] = [];
    let order: string | null = null;
    let limit: number | null = null;
    url.searchParams.forEach((raw, key) => {
      if (key === "select" || key === "on_conflict") return;
      if (key === "order") {
        order = raw;
        return;
      }
      if (key === "limit") {
        limit = Number(raw);
        return;
      }
      if (key === "or") {
        const inner = raw.replace(/^\(|\)$/g, "");
        orGroups.push(
          inner.split(",").map((clause) => {
            const [col, op, ...rest] = clause.split(".");
            return [col, op, rest.join(".")] as Cond;
          }),
        );
        return;
      }
      const dot = raw.indexOf(".");
      conditions.push([key, raw.slice(0, dot), raw.slice(dot + 1)]);
    });
    return { conditions, orGroups, order, limit };
  }

  private match(table: string, url: URL): Row[] {
    const { conditions, orGroups, order, limit } = this.parse(url);
    let rows = (this.tables[table] ?? []).filter(
      (row) => conditions.every((c) => this.rowMatches(row, c)) && orGroups.every((g) => g.some((c) => this.rowMatches(row, c))),
    );
    if (order) {
      const [col, dir] = order.split(".");
      rows = [...rows].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1) * (dir === "desc" ? -1 : 1));
    }
    if (limit !== null) rows = rows.slice(0, limit);
    return rows;
  }

  handle(input: string, init?: RequestInit): Response {
    const res = this.handleInner(input, init);
    if (process.env.SEC_TEST_TRACE) console.log("TRACE", (init?.method ?? "GET"), input, res.status);
    return res;
  }

  handleInner(input: string, init?: RequestInit): Response {
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Row | Row[]) : null;
    const bearer = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
    this.requests.push(`${method} ${url.pathname}`);

    if (url.hostname === "api.resend.com") {
      const b = body as Row;
      this.emails.push({ to: (b.to as string[])[0], subject: String(b.subject), html: String(b.html), text: String(b.text) });
      return json(200, { id: "email-1" });
    }

    // ── GoTrue ────────────────────────────────────────────────────────────
    if (url.pathname === "/auth/v1/.well-known/jwks.json") return json(200, signer.jwks());
    if (url.pathname === "/auth/v1/user") {
      const claims = claimsOf(bearer);
      const session = claims?.session_id ? this.sessions.get(claims.session_id) : null;
      const user = claims?.sub ? this.authUsers.get(claims.sub) : null;
      if (!session || !user) return json(401, { msg: "invalid token" });
      return json(200, user);
    }
    if (method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      const b = body as Row;
      const email = String(b.email ?? "").toLowerCase();
      const user = [...this.authUsers.values()].find((u) => String(u.email ?? "").toLowerCase() === email);
      if (user && user.password === b.password) return json(200, { access_token: "grant", user });
      return json(400, { error: "invalid_grant" });
    }
    if (method === "POST" && url.pathname === "/auth/v1/admin/generate_link") {
      return json(200, { properties: { hashed_token: `hashed-${String((body as Row).email)}` } });
    }
    const idMatch = url.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
    if (idMatch && method === "GET") {
      const user = this.authUsers.get(idMatch[1]);
      return user ? json(200, user) : json(404, {});
    }
    if (idMatch && method === "PUT") {
      const user = this.authUsers.get(idMatch[1]);
      if (!user) return json(404, {});
      Object.assign(user, body);
      return json(200, user);
    }

    // ── RPCs ──────────────────────────────────────────────────────────────
    if (url.pathname === "/rest/v1/rpc/security_revoke_auth_sessions") {
      // Atomic list-and-end: every targeted session goes on the revocation
      // list and out of the live set in one step, or nothing happens.
      const p = body as Row;
      const target = String(p.p_user_id);
      const except = p.p_except_session_id;
      if (except) this.othersLogouts.push(String(except)); else this.adminLogouts.push(target);
      if (except ? this.failOthersLogout : this.failAdminLogout) return json(500, {});
      if (this.failRevocationWrites) return json(500, { message: "fake: revocation write refused" });
      if (!this.tables.auth_session_revocations) return json(500, { message: "fake: revocation table missing" });
      const ttlMs = Number(p.p_ttl_seconds) * 1000;
      const nowMs = Date.now();
      let ended = 0;
      for (const [id, row] of this.sessions) {
        if (row.user_id !== target || id === except) continue;
        this.sessions.delete(id);
        ended += 1;
        const issued = Math.max(...[row.refreshed_at, row.updated_at, row.created_at].map((v) => (v ? new Date(String(v)).getTime() : 0)), nowMs);
        let expires = issued + ttlMs;
        if (row.not_after && new Date(String(row.not_after)).getTime() < expires) expires = new Date(String(row.not_after)).getTime();
        expires = Math.max(expires, nowMs + 60_000);
        const rowOut = { session_id: id, user_id: target, reason: p.p_reason, revoked_at: new Date(nowMs).toISOString(), expires_at: new Date(expires).toISOString() };
        const existing = this.tables.auth_session_revocations.find((r) => r.session_id === id);
        if (existing) Object.assign(existing, rowOut); else this.tables.auth_session_revocations.push({ id: crypto.randomUUID(), ...rowOut });
      }
      return json(200, ended);
    }
    if (url.pathname === "/rest/v1/rpc/security_list_auth_sessions") {
      const target = String((body as Row).p_user_id);
      return json(200, [...this.sessions.values()].filter((s) => s.user_id === target));
    }
    if (url.pathname === "/rest/v1/rpc/record_admin_audit_event") {
      this.audits.push(body as Row);
      return json(200, crypto.randomUUID());
    }
    if (url.pathname === "/rest/v1/rpc/provision_staff_login") {
      const p = body as Row;
      const user = this.authUsers.get(String(p.p_user_id ?? ""));
      if (!user) return json(400, { message: "bad provision call" });
      user.app_metadata = { ...(user.app_metadata as Row), thinnr_provisioned: true };
      return json(200, null);
    }
    if (url.pathname === "/rest/v1/rpc/claim_find_candidates") {
      const p = body as { p_kind: string; p_value: string };
      const out = this.tables.patients
        .filter((pt) =>
          p.p_kind === "email"
            ? String(pt.email ?? "").toLowerCase() === p.p_value.toLowerCase()
            : String(pt.phone ?? "").replace(/\D/g, "").slice(-10) === p.p_value.replace(/\D/g, "").slice(-10),
        )
        .map((pt) => ({ type: "patient", ref: String(pt.id), name: pt.name ?? null, dob: null, claimed: Boolean(pt.auth_user_id), auth_user_id: pt.auth_user_id ?? null }));
      return json(200, out);
    }
    if (url.pathname === "/rest/v1/rpc/claim_register_send") {
      const p = body as Row;
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const ledger = this.tables.claim_verifications;
      const inHour = ledger.filter((r) => String(r.created_at) > hourAgo);
      if (inHour.filter((r) => r.identifier === p.p_identifier).length >= Number(p.p_max_per_hour)) return json(200, []);
      if (p.p_scope_key != null && p.p_scope_max_per_hour != null) {
        if (inHour.filter((r) => r.scope_key === p.p_scope_key).length >= Number(p.p_scope_max_per_hour)) return json(200, []);
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

    // ── Generic REST ──────────────────────────────────────────────────────
    const tableMatch = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (tableMatch) {
      const table = tableMatch[1];
      if (!(table in this.tables)) return json(404, { message: `fake: no table ${table}` });
      if (method === "GET") return json(200, this.match(table, url));
      if (method === "PATCH") {
        const rows = this.match(table, url);
        for (const row of rows) Object.assign(row, body);
        return json(200, rows);
      }
      if (method === "DELETE") {
        const doomed = new Set(this.match(table, url));
        this.tables[table] = this.tables[table].filter((r) => !doomed.has(r));
        return json(200, [...doomed]);
      }
      if (method === "POST") {
        const incoming = Array.isArray(body) ? body : [body as Row];
        const out: Row[] = [];
        for (const item of incoming) {
          if (table === "account_security_state") {
            const existing = this.tables[table].find((r) => r.user_id === item.user_id);
            if (existing) {
              Object.assign(existing, item);
              out.push(existing);
              continue;
            }
          }
          if (table === "staff_second_factors") {
            const existing = this.tables[table].find((r) => r.staff_kind === item.staff_kind && r.staff_ref === item.staff_ref);
            if (existing) {
              Object.assign(existing, item);
              out.push(existing);
              continue;
            }
          }
          if (table === "patient_notifications" && item.dedupe_key && this.tables[table].some((r) => r.dedupe_key === item.dedupe_key)) continue;
          const row: Row = {
            id: crypto.randomUUID(),
            created_at: new Date().toISOString(),
            ...(table === "auth_sign_ins" ? { last_seen_at: new Date().toISOString(), session_id: null, revoked_at: null, revoked_reason: null, reported_at: null } : {}),
            ...item,
          };
          this.tables[table].push(row);
          out.push(row);
        }
        return json(201, out);
      }
    }
    return json(404, { message: `fake: unhandled ${method} ${url.pathname}` });
  }
}

const backend = new FakeBackend();
const realFetch = globalThis.fetch.bind(globalThis);
const routeErrors: string[] = [];
let server: http.Server;
let base: string;

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const response = await realFetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) THINNR/1.0";
const MAC_CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function seedPatient(overrides: Row = {}): { patient: Row; user: Row } {
  const id = (overrides.id as string) ?? `PT-${crypto.randomUUID().slice(0, 8)}`;
  const user = backend.seedAuthUser({ email: `pt-${id.toLowerCase()}@patients.thinnr.invalid`, password: "OldStrong!Pass" });
  const patient: Row = {
    id,
    provider_id: "20002",
    name: "Jordan Lee",
    email: "jordan@example.com",
    phone: "+15552013344",
    activation_status: "activated",
    auth_user_id: user.id,
    ...overrides,
  };
  backend.tables.patients.push(patient);
  return { patient, user };
}

function seedHq(role = "admin"): { user: Row } {
  const user = backend.seedAuthUser({ email: "hq@thinnr.example" });
  backend.tables.hq_memberships.push({ id: "HQM-1", auth_user_id: user.id, display_name: "Avery HQ", email: "hq@thinnr.example", status: "active", department_role: role });
  return { user };
}

/**
 * Give a session a fresh code proof on the ledger, as the sign-in rails (or
 * the inline re-authentication flow) would. `ageMs` back-dates the proof.
 */
function proveCode(session: { sessionId: string; token: string }, ageMs = 0): Row {
  const claims = claimsOf(session.token)!;
  const at = new Date(Date.now() - ageMs).toISOString();
  const row: Row = { id: crypto.randomUUID(), user_id: claims.sub, realm: "staff", method: "email_code", platform: "web", user_agent: MAC_CHROME_UA, ip_region: null, device_fingerprint: "f".repeat(40), device_label: "Mac · Chrome", new_device: false, session_id: session.sessionId, created_at: at, last_seen_at: at, code_verified_at: at, revoked_at: null, revoked_reason: null, reported_at: null, report_token_hash: null, report_token_expires_at: null };
  backend.tables.auth_sign_ins.push(row);
  return row;
}

function seedOffice(): { provider: Row; user: Row } {
  const user = backend.seedAuthUser({ email: "rivera@clinic.example" });
  const provider: Row = { provider_id: "20002", provider_name: "Dr. Rivera", office_name: "Rivera Wellness", email: "rivera@clinic.example", onboarding_code: "RIV-1", access_disabled: false, auth_user_id: user.id };
  backend.tables.providers.push(provider);
  return { provider, user };
}

/** Sign a patient in through the real rails (password → code → verify). */
async function signInPatient(patient: Row, headers: Record<string, string> = {}, password = "OldStrong!Pass") {
  const start = await api("POST", "/api/auth/patient/password/login", { identifier: patient.phone, password }, headers);
  if (start.status !== 200) return { start, verify: null as null | { status: number; json: any } };
  const verify = await api("POST", "/api/auth/login/verify", { requestId: start.json.requestId, code: start.json.devCode }, headers);
  return { start, verify };
}

beforeAll(async () => {
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  process.env.CLAIM_DELIVERY_MODE = "dev";
  process.env.CLAIM_SMS_DELIVERY_MODE = "dev";
  process.env.CLAIM_EMAIL_DELIVERY_MODE = "dev";
  process.env.CLAIM_IDENTIFY_FLOOR_MS = "0";
  process.env.AUTH_SMS_DELIVERY_FLOOR_MS = "0";
  process.env.AUTH_GEOIP_LOOKUP = "off";
  process.env.RESEND_API_KEY = "re_test";
  process.env.CLAIM_EMAIL_FROM = "THINNR <security@thinnr.example>";
  process.env.PATIENT_APP_URL = "https://app.thinnr.example";
  process.env.OPERATIONS_APP_URL = "https://ops.thinnr.example";
  for (const knob of ["SEND", "CHECK", "OFFICE", "FINISH", "SECURITY"]) {
    process.env[`AUTH_${knob}_BURST`] = "100000";
    process.env[`AUTH_${knob}_DAILY_BUDGET`] = "100000";
  }

  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(href).hostname;
    if (host === "fake.supabase.local" || host === "api.resend.com") return Promise.resolve(backend.handle(href, init));
    return realFetch(input as string, init);
  });

  const { default: authRouter } = await import("./auth");
  const { default: securityRouter } = await import("./security");
  const { default: officeTeamRouter } = await import("./office-team");
  const { default: hqTeamRouter } = await import("./hq-team");
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: (obj: { err?: Error }, msg: string) => routeErrors.push(`${msg}: ${obj?.err?.message ?? String(obj)}`),
      warn: () => {},
    };
    next();
  });
  app.use("/api", authRouter);
  app.use("/api", securityRouter);
  app.use("/api", officeTeamRouter);
  app.use("/api", hqTeamRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  vi.unstubAllGlobals();
});

beforeEach(() => {
  backend.reset();
  resetAccessTokenVerifierForTests();
  routeErrors.length = 0;
});

// ── Ledger ───────────────────────────────────────────────────────────────────

describe("sign-in ledger", () => {
  it("records each patient sign-in with method, platform, device and a returned signInId", async () => {
    const { patient } = seedPatient();
    const { verify } = await signInPatient(patient, { "user-agent": IPHONE_UA, "x-thinnr-platform": "ios", "x-thinnr-device": "device-aaaa-1111" });
    expect(verify!.status).toBe(200);
    expect(verify!.json.signInId).toMatch(/^[0-9a-f-]{36}$/);
    const rows = backend.tables.auth_sign_ins;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ realm: "patient", method: "password_sms_code", platform: "ios", new_device: false });
    expect(rows[0].device_fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(String(rows[0].device_label)).toMatch(/iPhone/);
    expect(rows[0].report_token_hash).toBeNull();
  });

  it("uses the emailed-code method label when the patient signs in by email", async () => {
    const { patient } = seedPatient();
    const start = await api("POST", "/api/auth/patient/password/login", { identifier: patient.email, password: "OldStrong!Pass" });
    const verify = await api("POST", "/api/auth/login/verify", { requestId: start.json.requestId, code: start.json.devCode });
    expect(verify.status).toBe(200);
    expect(backend.tables.auth_sign_ins[0].method).toBe("password_email_code");
  });

  it("attaches the GoTrue session to its ledger row and marks it current", async () => {
    const { patient, user } = seedPatient();
    const { verify } = await signInPatient(patient);
    const { token, sessionId } = backend.openSession(String(user.id));
    const attach = await api("POST", "/api/security/me/attach", { signInId: verify!.json.signInId }, auth(token));
    expect(attach.status).toBe(200);
    expect(attach.json.attached).toBe(true);
    expect(backend.tables.auth_sign_ins[0].session_id).toBe(sessionId);

    const me = await api("GET", "/api/security/me", undefined, auth(token));
    expect(me.status).toBe(200);
    expect(me.json.realm).toBe("patient");
    expect(me.json.canChangePassword).toBe(true);
    expect(me.json.signIns[0]).toMatchObject({ id: verify!.json.signInId, current: true, active: true, methodLabel: "Password + texted code" });
    expect(me.json.sessions).toHaveLength(1);
    expect(me.json.sessions[0]).toMatchObject({ current: true, signInId: verify!.json.signInId });
    // Never a token or a raw session id.
    const wire = JSON.stringify(me.json);
    expect(wire).not.toContain(sessionId);
    expect(wire).not.toContain(token);
    expect(me.json.sessions[0].ref).toHaveLength(16);
  });

  it("refuses to attach another user's sign-in row", async () => {
    const a = seedPatient({ id: "PT-A", phone: "+15552010001", email: "a@example.com" });
    const b = seedPatient({ id: "PT-B", phone: "+15552010002", email: "b@example.com" });
    const { verify } = await signInPatient(a.patient);
    const { token } = backend.openSession(String(b.user.id));
    const attach = await api("POST", "/api/security/me/attach", { signInId: verify!.json.signInId }, auth(token));
    expect(attach.status).toBe(200);
    expect(attach.json.attached).toBe(false);
    expect(backend.tables.auth_sign_ins[0].session_id).toBeNull();
  });

  it("answers 401 without a live session and 403 for an auth user with no account", async () => {
    const anon = await api("GET", "/api/security/me");
    expect(anon.status).toBe(401);
    const orphan = backend.seedAuthUser({ email: "orphan@example.com" });
    const { token } = backend.openSession(String(orphan.id));
    const res = await api("GET", "/api/security/me", undefined, auth(token));
    expect(res.status).toBe(403);
  });
});

// ── New-device detection + alerts ────────────────────────────────────────────

describe("new-device alerts", () => {
  it("flags the second device, pushes to the patient, and never alerts the first sign-in", async () => {
    const { patient } = seedPatient();
    backend.tables.patient_push_tokens.push({ id: "tok-1", patient_id: patient.id, token: "ExponentPushToken[x]", disabled_at: null, last_registered_at: new Date().toISOString() });
    await signInPatient(patient, { "user-agent": IPHONE_UA, "x-thinnr-platform": "ios", "x-thinnr-device": "device-aaaa-1111" });
    await settle();
    expect(backend.tables.patient_notifications).toHaveLength(0);

    await signInPatient(patient, { "user-agent": MAC_CHROME_UA, "x-thinnr-platform": "web", "x-thinnr-device": "device-bbbb-2222" });
    await settle();
    const rows = backend.tables.auth_sign_ins;
    expect(rows[1].new_device).toBe(true);
    expect(rows[1].report_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(backend.tables.patient_notifications).toHaveLength(1);
    expect(backend.tables.patient_notifications[0]).toMatchObject({
      patient_id: patient.id,
      kind: "security_new_sign_in",
      category: "account",
      dedupe_key: `security-sign-in:${rows[1].id}`,
    });
    expect((backend.tables.patient_notifications[0].data as Row).route).toBe("/security");
    expect(backend.emails).toHaveLength(0);

    // Same device again: nothing new.
    await signInPatient(patient, { "user-agent": IPHONE_UA, "x-thinnr-platform": "ios", "x-thinnr-device": "device-aaaa-1111" });
    await settle();
    expect(backend.tables.auth_sign_ins[2].new_device).toBe(false);
    expect(backend.tables.patient_notifications).toHaveLength(1);
  });

  it("falls back to email with a report link when the patient has no push device", async () => {
    const { patient } = seedPatient();
    await signInPatient(patient, { "user-agent": IPHONE_UA, "x-thinnr-device": "device-aaaa-1111" });
    await signInPatient(patient, { "user-agent": MAC_CHROME_UA, "x-thinnr-device": "device-bbbb-2222" });
    await settle();
    expect(backend.emails).toHaveLength(1);
    expect(backend.emails[0].to).toBe("jordan@example.com");
    expect(backend.emails[0].subject).toMatch(/new sign-in/i);
    expect(backend.emails[0].text).toMatch(/https:\/\/app\.thinnr\.example\/security-report\?token=[0-9a-f]{64}/);
    expect(backend.emails[0].text).toMatch(/Chrome/);
  });

  it("emails staff on a new device with the operations report link", async () => {
    const { user } = seedOffice();
    const identifier = "rivera@clinic.example";
    const first = await api("POST", "/api/auth/login/start", { realm: "staff", identifier }, { "user-agent": MAC_CHROME_UA });
    const v1 = await api("POST", "/api/auth/login/verify", { requestId: first.json.requestId, code: first.json.devCode }, { "user-agent": MAC_CHROME_UA });
    expect(v1.status).toBe(200);
    await settle();
    expect(backend.emails.filter((e) => /new sign-in/i.test(e.subject))).toHaveLength(0);

    const second = await api("POST", "/api/auth/login/start", { realm: "staff", identifier }, { "user-agent": IPHONE_UA });
    const v2 = await api("POST", "/api/auth/login/verify", { requestId: second.json.requestId, code: second.json.devCode }, { "user-agent": IPHONE_UA });
    expect(v2.status).toBe(200);
    await settle();
    const alerts = backend.emails.filter((e) => /new sign-in/i.test(e.subject));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].to).toBe("rivera@clinic.example");
    expect(alerts[0].text).toMatch(/https:\/\/ops\.thinnr\.example\/security\/report\?token=/);
    expect(backend.tables.auth_sign_ins.every((r) => r.user_id === user.id && r.realm === "staff" && r.method === "email_code")).toBe(true);
  });
});

// ── This wasn't me ───────────────────────────────────────────────────────────

describe("this wasn't me", () => {
  async function reportedPatient() {
    const { patient, user } = seedPatient();
    await signInPatient(patient, { "user-agent": IPHONE_UA, "x-thinnr-device": "device-aaaa-1111" });
    const phone = backend.openSession(String(user.id), IPHONE_UA);
    await api("POST", "/api/security/me/attach", { signInId: backend.tables.auth_sign_ins[0].id }, auth(phone.token));
    await signInPatient(patient, { "user-agent": MAC_CHROME_UA, "x-thinnr-device": "device-bbbb-2222" });
    const laptop = backend.openSession(String(user.id), MAC_CHROME_UA);
    await api("POST", "/api/security/me/attach", { signInId: backend.tables.auth_sign_ins[1].id }, auth(laptop.token));
    await settle();
    return { patient, user, phone, laptop };
  }

  it("signs out everything from the email link and forces a password reset on the next sign-in", async () => {
    const { patient, user, phone, laptop } = await reportedPatient();
    const link = backend.emails.find((e) => /new sign-in/i.test(e.subject))!.text.match(/token=([0-9a-f]{64})/)![1];

    const report = await api("POST", "/api/security/report", { token: link });
    expect(report.status).toBe(200);
    expect(report.json).toMatchObject({ ok: true, signedOut: true, forcedReset: true, realm: "patient" });
    expect(backend.adminLogouts).toEqual([user.id]);
    expect(backend.sessions.has(phone.sessionId)).toBe(false);
    expect(backend.sessions.has(laptop.sessionId)).toBe(false);
    expect(backend.tables.auth_sign_ins.every((r) => r.revoked_reason === "reported")).toBe(true);
    expect(backend.tables.auth_sign_ins[1].reported_at).toBeTruthy();
    expect(backend.tables.auth_sign_ins[1].report_token_hash).toBeNull();
    expect(backend.tables.account_security_state[0]).toMatchObject({ user_id: user.id, force_password_reset: true, forced_reason: "reported_sign_in" });
    await settle();
    expect(backend.audits.some((a) => a.p_action === "security_sign_in_reported")).toBe(true);

    // The link is one-shot.
    const again = await api("POST", "/api/security/report", { token: link });
    expect(again.status).toBe(400);

    // Next sign-in: a correct password no longer opens a session.
    const blocked = await api("POST", "/api/auth/patient/password/login", { identifier: patient.phone, password: "OldStrong!Pass" });
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe("PASSWORD_RESET_REQUIRED");
    // A wrong password stays neutral (401), so the forced flag is not an oracle.
    const wrong = await api("POST", "/api/auth/patient/password/login", { identifier: patient.phone, password: "Nope!Pass123" });
    expect(wrong.status).toBe(401);

    // Recovery lifts the hold and sweeps sessions.
    const start = await api("POST", "/api/auth/patient/recovery/start", { identifier: patient.phone });
    const verify = await api("POST", "/api/auth/patient/recovery/verify", { requestId: start.json.requestId, code: start.json.devCode });
    expect(verify.status).toBe(200);
    const complete = await api("POST", "/api/auth/patient/recovery/complete", { requestId: start.json.requestId, resetToken: verify.json.resetToken, password: "BrandNew!Pass9" });
    expect(complete.status).toBe(200);
    expect(backend.tables.account_security_state[0].force_password_reset).toBe(false);
    expect(backend.adminLogouts).toEqual([user.id, user.id]);
    await settle();
    expect(backend.audits.some((a) => a.p_action === "security_recovery_completed")).toBe(true);
    // The hold is lifted: a correct new password is no longer refused with
    // the forced-reset code (the shared hourly send pot is spent by now, so
    // the proven password lands on the send cap instead).
    const after = await api("POST", "/api/auth/patient/password/login", { identifier: patient.phone, password: "BrandNew!Pass9" });
    expect(after.status).toBe(429);
    expect(after.json.code).toBeUndefined();
  });

  it("never says 'signed out' when GoTrue refuses: the link stays live, the hold is on, and a retry finishes the job", async () => {
    const { user, phone, laptop } = await reportedPatient();
    const link = backend.emails.find((e) => /new sign-in/i.test(e.subject))!.text.match(/token=([0-9a-f]{64})/)![1];

    backend.failAdminLogout = true;
    const refused = await api("POST", "/api/security/report", { token: link });
    expect(refused.status).toBe(502);
    expect(refused.json).toMatchObject({ code: "SESSION_SIGN_OUT_FAILED", retryable: true });
    expect(refused.json.signedOut).toBeUndefined();
    expect(refused.json.ok).toBeUndefined();
    // Nothing changed: sessions alive, ledger untouched, token unspent, no forced-reset hold.
    expect(backend.sessions.has(phone.sessionId)).toBe(true);
    expect(backend.sessions.has(laptop.sessionId)).toBe(true);
    expect(backend.tables.auth_sign_ins.every((r) => r.revoked_at == null && r.reported_at == null)).toBe(true);
    expect(backend.tables.auth_sign_ins[1].report_token_hash).toBeTruthy();
    expect(backend.tables.account_security_state.find((r) => r.user_id === user.id)?.force_password_reset ?? false).toBe(false);
    await settle();
    expect(backend.audits.find((a) => a.p_action === "security_sign_in_reported")?.p_metadata).toMatchObject({ sessions: "sign_out_failed" });

    backend.failAdminLogout = false;
    const retry = await api("POST", "/api/security/report", { token: link });
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ ok: true, signedOut: true, forcedReset: true });
    expect(backend.sessions.has(phone.sessionId)).toBe(false);
    expect(backend.sessions.has(laptop.sessionId)).toBe(false);
    expect(backend.tables.auth_sign_ins.every((r) => r.revoked_reason === "reported")).toBe(true);
    expect(backend.tables.account_security_state[0]).toMatchObject({ user_id: user.id, force_password_reset: true, forced_reason: "reported_sign_in" });

    // Same contract for the signed-in report endpoint.
    const { user: other } = seedPatient({ id: "PT-OTHER", phone: "+15552019999", email: "o@example.com" });
    await signInPatient({ phone: "+15552019999" }, { "x-thinnr-device": "device-cccc-3333" });
    const otherSession = backend.openSession(String(other.id));
    const otherRow = backend.tables.auth_sign_ins.find((r) => r.user_id === other.id)!;
    backend.failAdminLogout = true;
    const own = await api("POST", `/api/security/me/sign-ins/${otherRow.id}/report`, {}, auth(otherSession.token));
    expect(own.status).toBe(502);
    expect(own.json.code).toBe("SESSION_SIGN_OUT_FAILED");
    expect(backend.sessions.has(otherSession.sessionId)).toBe(true);
    expect(otherRow.revoked_at == null).toBe(true);
  });

  it("lets a signed-in patient report a sign-in on their own account only", async () => {
    const { user, phone } = await reportedPatient();
    const other = seedPatient({ id: "PT-OTHER", phone: "+15552019999", email: "o@example.com" });
    const otherSession = backend.openSession(String(other.user.id));
    const foreign = await api("POST", `/api/security/me/sign-ins/${backend.tables.auth_sign_ins[1].id}/report`, {}, auth(otherSession.token));
    expect(foreign.status).toBe(404);
    expect(backend.adminLogouts).toEqual([]);

    const own = await api("POST", `/api/security/me/sign-ins/${backend.tables.auth_sign_ins[1].id}/report`, {}, auth(phone.token));
    expect(own.status).toBe(200);
    expect(own.json.forcedReset).toBe(true);
    expect(backend.adminLogouts).toEqual([user.id]);
  });

  it("answers invalid or expired links generically", async () => {
    const bad = await api("POST", "/api/security/report", { token: "z".repeat(64) });
    expect(bad.status).toBe(400);
    const unknown = await api("POST", "/api/security/report", { token: "a".repeat(64) });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toBe(bad.json.error);
    const { user } = seedPatient();
    backend.tables.auth_sign_ins.push({ id: crypto.randomUUID(), user_id: user.id, realm: "patient", method: "signup", platform: "ios", user_agent: IPHONE_UA, ip_region: null, device_fingerprint: "f".repeat(40), device_label: "iPhone", new_device: true, session_id: null, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), revoked_at: null, revoked_reason: null, reported_at: null, report_token_hash: crypto.createHash("sha256").update("b".repeat(64)).digest("hex"), report_token_expires_at: new Date(Date.now() - 1000).toISOString() });
    const expired = await api("POST", "/api/security/report", { token: "b".repeat(64) });
    expect(expired.status).toBe(400);
    expect(backend.adminLogouts).toEqual([]);
  });

  it("does not force a reset for staff reports (they have no password)", async () => {
    const { user } = seedOffice();
    const identifier = "rivera@clinic.example";
    for (const ua of [MAC_CHROME_UA, IPHONE_UA]) {
      const start = await api("POST", "/api/auth/login/start", { realm: "staff", identifier }, { "user-agent": ua });
      await api("POST", "/api/auth/login/verify", { requestId: start.json.requestId, code: start.json.devCode }, { "user-agent": ua });
    }
    await settle();
    const link = backend.emails.find((e) => /new sign-in/i.test(e.subject))!.text.match(/token=([0-9a-f]{64})/)![1];
    const report = await api("POST", "/api/security/report", { token: link });
    expect(report.status).toBe(200);
    expect(report.json).toMatchObject({ forcedReset: false, realm: "staff" });
    expect(backend.adminLogouts).toEqual([user.id]);
    expect(backend.tables.account_security_state).toHaveLength(0);
  });
});

// ── Sign out others ──────────────────────────────────────────────────────────

describe("sign out everywhere else", () => {
  it("ends every other session, keeps this one, marks the ledger and audits", async () => {
    const { patient, user } = seedPatient();
    await signInPatient(patient, { "x-thinnr-device": "device-aaaa-1111" });
    const phone = backend.openSession(String(user.id));
    await api("POST", "/api/security/me/attach", { signInId: backend.tables.auth_sign_ins[0].id }, auth(phone.token));
    await signInPatient(patient, { "x-thinnr-device": "device-bbbb-2222" });
    const laptop = backend.openSession(String(user.id), MAC_CHROME_UA);
    await api("POST", "/api/security/me/attach", { signInId: backend.tables.auth_sign_ins[1].id }, auth(laptop.token));

    const res = await api("POST", "/api/security/me/sign-out-others", {}, auth(phone.token));
    expect(res.status).toBe(200);
    expect(backend.othersLogouts).toEqual([phone.sessionId]);
    expect(backend.sessions.has(phone.sessionId)).toBe(true);
    expect(backend.sessions.has(laptop.sessionId)).toBe(false);
    expect(backend.tables.auth_sign_ins[0].revoked_at).toBeNull();
    expect(backend.tables.auth_sign_ins[1]).toMatchObject({ revoked_reason: "signed_out_others" });
    await settle();
    expect(backend.audits.some((a) => a.p_action === "security_sessions_signed_out")).toBe(true);

    const me = await api("GET", "/api/security/me", undefined, auth(phone.token));
    expect(me.json.sessions).toHaveLength(1);
    expect(me.json.signIns.map((s: any) => s.active)).toEqual([false, true]);
    expect(me.json.signIns[0].revokedReason).toBe("signed_out_others");
  });

  it("reports failure instead of pretending when GoTrue refuses", async () => {
    const { user } = seedPatient();
    const { token } = backend.openSession(String(user.id));
    backend.failOthersLogout = true;
    const res = await api("POST", "/api/security/me/sign-out-others", {}, auth(token));
    expect(res.status).toBe(502);
  });
});

// ── Change password ──────────────────────────────────────────────────────────

describe("change password", () => {
  async function seeded() {
    const { patient, user } = seedPatient();
    await signInPatient(patient, { "x-thinnr-device": "device-aaaa-1111" });
    const phone = backend.openSession(String(user.id));
    await api("POST", "/api/security/me/attach", { signInId: backend.tables.auth_sign_ins[0].id }, auth(phone.token));
    const laptop = backend.openSession(String(user.id), MAC_CHROME_UA);
    return { patient, user, phone, laptop };
  }

  it("rejects a wrong current password without sending a code", async () => {
    const { phone } = await seeded();
    const res = await api("POST", "/api/security/me/password/start", { currentPassword: "Wrong!Pass123" }, auth(phone.token));
    expect(res.status).toBe(401);
    expect(res.json.field).toBe("currentPassword");
    expect(backend.tables.claim_verifications.filter((r) => r.purpose === "password_change")).toHaveLength(0);
  });

  it("sends the code to the verified phone, enforces signup password rules, and rejects a mismatched code", async () => {
    const { patient, user, phone, laptop } = await seeded();
    const start = await api("POST", "/api/security/me/password/start", { currentPassword: "OldStrong!Pass" }, auth(phone.token));
    expect(start.status).toBe(200);
    expect(start.json).toMatchObject({ ok: true, channel: "sms", destination: "•••-3344" });
    expect(start.json.devCode).toMatch(/^\d{6}$/);
    const row = backend.tables.claim_verifications.find((r) => r.purpose === "password_change")!;
    expect(row.scope_key).toBe(`password-change:${patient.id}`);
    expect(JSON.stringify(start.json)).not.toContain(patient.phone as string);

    const weak = await api("POST", "/api/security/me/password/complete", { requestId: start.json.requestId, code: start.json.devCode, newPassword: "short" }, auth(phone.token));
    expect(weak.status).toBe(400);
    expect(weak.json.field).toBe("newPassword");

    const mismatch = await api("POST", "/api/security/me/password/complete", { requestId: start.json.requestId, code: "000000", newPassword: "BrandNew!Pass9" }, auth(phone.token));
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.field).toBe("code");
    expect(user.password).toBe("OldStrong!Pass");

    const done = await api("POST", "/api/security/me/password/complete", { requestId: start.json.requestId, code: start.json.devCode, newPassword: "BrandNew!Pass9" }, auth(phone.token));
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ ok: true, othersSignedOut: true });
    expect(user.password).toBe("BrandNew!Pass9");
    expect(backend.sessions.has(phone.sessionId)).toBe(true);
    expect(backend.sessions.has(laptop.sessionId)).toBe(false);
    expect(backend.tables.account_security_state[0].password_changed_at).toBeTruthy();
    await settle();
    expect(backend.audits.some((a) => a.p_action === "security_password_changed")).toBe(true);
    // Confirmation by email (no push device) with a working report link.
    const confirmation = backend.emails.find((e) => /password/i.test(e.subject));
    expect(confirmation?.to).toBe("jordan@example.com");
    const token = confirmation!.text.match(/token=([0-9a-f]{64})/)![1];
    const undo = await api("POST", "/api/security/report", { token });
    expect(undo.status).toBe(200);
    expect(backend.sessions.has(phone.sessionId)).toBe(false);

    // The code is spent.
    const replay = await api("POST", "/api/security/me/password/complete", { requestId: start.json.requestId, code: start.json.devCode, newPassword: "Another!Pass9" }, auth(phone.token));
    expect(replay.status).not.toBe(200);
  });

  it("refuses to change the password when other sessions cannot be signed out, sends no confirmation, and lets the same code retry", async () => {
    const { user, phone, laptop } = await seeded();
    const start = await api("POST", "/api/security/me/password/start", { currentPassword: "OldStrong!Pass" }, auth(phone.token));
    expect(start.status).toBe(200);

    backend.failOthersLogout = true;
    const refused = await api("POST", "/api/security/me/password/complete", { requestId: start.json.requestId, code: start.json.devCode, newPassword: "BrandNew!Pass9" }, auth(phone.token));
    expect(refused.status).toBe(502);
    expect(refused.json).toMatchObject({ code: "SESSION_SIGN_OUT_FAILED", retryable: true });
    expect(refused.json.ok).toBeUndefined();
    expect(refused.json.othersSignedOut).toBeUndefined();
    expect(refused.json.error).toMatch(/password was not changed/i);
    // Nothing moved: password, sessions, ledger, the code is still unclaimed, and no "every other device was signed out" mail.
    expect(user.password).toBe("OldStrong!Pass");
    expect(backend.sessions.has(laptop.sessionId)).toBe(true);
    expect(backend.tables.auth_sign_ins.every((r) => r.revoked_at == null)).toBe(true);
    const codeRow = backend.tables.claim_verifications.find((r) => r.purpose === "password_change")!;
    expect(codeRow.verified_at ?? null).toBeNull();
    expect(codeRow.consumed_at ?? null).toBeNull();
    expect(backend.tables.account_security_state.find((r) => r.password_changed_at)).toBeUndefined();
    await settle();
    expect(backend.emails.filter((e) => /password/i.test(e.subject))).toHaveLength(0);
    expect(backend.audits.find((a) => a.p_action === "security_password_changed")?.p_metadata).toMatchObject({ sessions: "sign_out_failed", outcome: "aborted" });

    backend.failOthersLogout = false;
    // The same code retries: containment ran before the one-time claim.
    const retry = await api("POST", "/api/security/me/password/complete", { requestId: start.json.requestId, code: start.json.devCode, newPassword: "BrandNew!Pass9" }, auth(phone.token));
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ ok: true, othersSignedOut: true });
    expect(user.password).toBe("BrandNew!Pass9");
    expect(backend.sessions.has(phone.sessionId)).toBe(true);
    expect(backend.sessions.has(laptop.sessionId)).toBe(false);
    await settle();
    expect(backend.emails.filter((e) => /password/i.test(e.subject))).toHaveLength(1);
  });

  it("never lets another account redeem a patient's password-change code", async () => {
    const { phone } = await seeded();
    const start = await api("POST", "/api/security/me/password/start", { currentPassword: "OldStrong!Pass" }, auth(phone.token));
    expect(start.status).toBe(200);
    const other = seedPatient({ id: "PT-OTHER", phone: "+15552019999", email: "o@example.com" });
    const otherSession = backend.openSession(String(other.user.id));
    const stolen = await api("POST", "/api/security/me/password/complete", { requestId: start.json.requestId, code: start.json.devCode, newPassword: "BrandNew!Pass9" }, auth(otherSession.token));
    expect(stolen.status).toBe(400);
    expect(stolen.json.field).toBe("code");
    expect(other.user.password).toBe("OldStrong!Pass");
    // Fail closed: the code is spent for everyone, including the owner.
    const owner = await api("POST", "/api/security/me/password/complete", { requestId: start.json.requestId, code: start.json.devCode, newPassword: "BrandNew!Pass9" }, auth(phone.token));
    expect(owner.status).toBe(400);
  });

  it("uses email when the patient has no phone and refuses staff", async () => {
    const { patient, user } = seedPatient({ phone: null });
    const { token } = backend.openSession(String(user.id));
    const start = await api("POST", "/api/security/me/password/start", { currentPassword: "OldStrong!Pass" }, auth(token));
    expect(start.status).toBe(200);
    expect(start.json).toMatchObject({ channel: "email", destination: "j•••@example.com" });
    expect(patient.id).toBeTruthy();

    const staff = seedOffice();
    const staffSession = backend.openSession(String(staff.user.id));
    const refused = await api("POST", "/api/security/me/password/start", { currentPassword: "x" }, auth(staffSession.token));
    expect(refused.status).toBe(403);
    const me = await api("GET", "/api/security/me", undefined, auth(staffSession.token));
    expect(me.json.canChangePassword).toBe(false);
    expect(me.json.realm).toBe("staff");
  });
});

// ── Recovery hardening ───────────────────────────────────────────────────────

describe("recovery hardening", () => {
  it("caps recovery codes per identity per day with a neutral body", async () => {
    const { patient } = seedPatient();
    const identifier = patient.phone as string;
    // Six older sends today (outside the hourly pot, inside the day).
    for (let i = 0; i < 6; i++) {
      backend.tables.claim_verifications.push({ id: crypto.randomUUID(), created_at: new Date(Date.now() - (2 + i) * 60 * 60 * 1000).toISOString(), purpose: "recovery", identifier, identifier_kind: "phone", consumed_at: null });
    }
    const capped = await api("POST", "/api/auth/patient/recovery/start", { identifier });
    expect(capped.status).toBe(200);
    expect(capped.json.ok).toBe(true);
    expect(capped.json.devCode).toMatch(/^\d{6}$/);
    expect(backend.tables.claim_verifications.filter((r) => r.purpose === "recovery")).toHaveLength(6);
    // Unknown identifiers look identical.
    const unknown = await api("POST", "/api/auth/patient/recovery/start", { identifier: "+15559990000" });
    expect(unknown.status).toBe(200);
    expect(Object.keys(unknown.json).sort()).toEqual(Object.keys(capped.json).sort());
    expect(unknown.json.message).toBe(capped.json.message);
  });

  it("signs out every existing session when a recovery completes", async () => {
    const { patient, user } = seedPatient();
    const live = backend.openSession(String(user.id));
    await signInPatient(patient);
    const start = await api("POST", "/api/auth/patient/recovery/start", { identifier: patient.phone });
    const verify = await api("POST", "/api/auth/patient/recovery/verify", { requestId: start.json.requestId, code: start.json.devCode });
    const complete = await api("POST", "/api/auth/patient/recovery/complete", { requestId: start.json.requestId, resetToken: verify.json.resetToken, password: "BrandNew!Pass9" });
    expect(complete.status).toBe(200);
    expect(backend.sessions.has(live.sessionId)).toBe(false);
    expect(backend.tables.auth_sign_ins.every((r) => r.revoked_reason === "recovery")).toBe(true);
  });

  it("refuses to finish a recovery when sessions cannot be swept: password and proof untouched, hold kept, same token retries", async () => {
    const { patient, user } = seedPatient();
    const live = backend.openSession(String(user.id));
    await signInPatient(patient);
    // A forced-reset hold must survive a refused sweep.
    backend.tables.account_security_state.push({ user_id: user.id, force_password_reset: true, forced_reason: "reported_sign_in", forced_at: new Date().toISOString(), password_changed_at: null, updated_at: new Date().toISOString() });
    const start = await api("POST", "/api/auth/patient/recovery/start", { identifier: patient.phone });
    const verify = await api("POST", "/api/auth/patient/recovery/verify", { requestId: start.json.requestId, code: start.json.devCode });
    expect(verify.status).toBe(200);

    backend.failAdminLogout = true;
    const refused = await api("POST", "/api/auth/patient/recovery/complete", { requestId: start.json.requestId, resetToken: verify.json.resetToken, password: "BrandNew!Pass9" });
    expect(refused.status).toBe(502);
    expect(refused.json).toMatchObject({ code: "SESSION_SIGN_OUT_FAILED", retryable: true });
    expect(refused.json.ok).toBeUndefined();
    expect(user.password).toBe("OldStrong!Pass");
    expect(backend.sessions.has(live.sessionId)).toBe(true);
    expect(backend.tables.auth_sign_ins.every((r) => r.revoked_at == null)).toBe(true);
    expect(backend.tables.account_security_state[0].force_password_reset).toBe(true);
    expect(backend.tables.claim_verifications.find((r) => r.purpose === "recovery")!.consumed_at ?? null).toBeNull();
    await settle();
    expect(backend.audits.some((a) => a.p_action === "security_recovery_completed")).toBe(false);

    backend.failAdminLogout = false;
    const retry = await api("POST", "/api/auth/patient/recovery/complete", { requestId: start.json.requestId, resetToken: verify.json.resetToken, password: "BrandNew!Pass9" });
    expect(retry.status).toBe(200);
    expect(user.password).toBe("BrandNew!Pass9");
    expect(backend.sessions.has(live.sessionId)).toBe(false);
    expect(backend.tables.account_security_state[0].force_password_reset).toBe(false);
    expect(backend.tables.auth_sign_ins.every((r) => r.revoked_reason === "recovery")).toBe(true);
  });
});

// ── Staff and HQ views ───────────────────────────────────────────────────────

const TM_ID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const TM_MANY = "7a2d3e4f-5b6c-4d7e-9f0a-1b2c3d4e5f60";
const TM_LATE = "8b3e4f50-6c7d-4e8f-a01b-2c3d4e5f6071";

describe("office team sessions", () => {
  function seedTeam() {
    const office = seedOffice();
    const memberUser = backend.seedAuthUser({ email: "sam@clinic.example" });
    backend.tables.team_members.push({ id: TM_ID, provider_id: "20002", name: "Sam Staff", email: "sam@clinic.example", office_role: "staff", activation_status: "activated", auth_user_id: memberUser.id, invited_at: null, joined_at: null, deactivated_at: null });
    return { office, memberUser };
  }

  it("shows an owner the teammate's sessions and records the reason on force sign-out", async () => {
    const { office, memberUser } = seedTeam();
    const owner = backend.openSession(String(office.user.id), MAC_CHROME_UA);
    proveCode(owner);
    const teammate = backend.openSession(String(memberUser.id), IPHONE_UA);
    backend.tables.auth_sign_ins.push({ id: crypto.randomUUID(), user_id: memberUser.id, realm: "staff", method: "email_code", platform: "ios", user_agent: IPHONE_UA, ip_region: "Austin, Texas, US", device_fingerprint: "a".repeat(40), device_label: "iPhone · THINNR app", new_device: false, session_id: teammate.sessionId, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), revoked_at: null, revoked_reason: null, reported_at: null, report_token_hash: null, report_token_expires_at: null });

    const list = await api("GET", `/api/office/team/${TM_ID}/sessions`, undefined, auth(owner.token));
    expect(list.status).toBe(200);
    expect(list.json.sessions).toHaveLength(1);
    expect(list.json.sessions[0]).toMatchObject({ current: false, region: "Austin, Texas, US", device: "iPhone · THINNR app" });
    expect(list.json.signIns).toHaveLength(1);
    expect(list.json.signIns[0].current).toBe(false);
    expect(JSON.stringify(list.json)).not.toContain(teammate.sessionId);
    await settle();
    expect(backend.audits.some((a) => a.p_action === "office_team_sessions_viewed")).toBe(true);

    const badReason = await api("POST", `/api/office/team/${TM_ID}/sign-out`, { reason: "because" }, auth(owner.token));
    expect(badReason.status).toBe(400);

    const out = await api("POST", `/api/office/team/${TM_ID}/sign-out`, { reason: "lost_device" }, auth(owner.token));
    expect(out.status).toBe(200);
    expect(out.json.sessionInvalidation).toBe("complete");
    expect(backend.sessions.has(teammate.sessionId)).toBe(false);
    expect(backend.tables.auth_sign_ins.find((r) => r.session_id === teammate.sessionId)!.revoked_reason).toBe("lost_device");
    await settle();
    const audit = backend.audits.find((a) => a.p_action === "office_team_signed_out")!;
    expect((audit.p_metadata as Row).reason).toBe("lost_device");
  });

  it("keeps a staff-role teammate out of the session list", async () => {
    const { memberUser } = seedTeam();
    const staffSession = backend.openSession(String(memberUser.id));
    const res = await api("GET", `/api/office/team/${TM_ID}/sessions`, undefined, auth(staffSession.token));
    expect(res.status).toBe(403);
  });
});

describe("HQ views", () => {
  it("lets HQ view and force sign-out a patient with a recorded reason, but not an office login", async () => {
    seedOffice();
    const hq = seedHq();
    const { patient, user } = seedPatient();
    const patientSession = backend.openSession(String(user.id));
    const hqSession = backend.openSession(String(hq.user.id), MAC_CHROME_UA);
    proveCode(hqSession);

    const list = await api("GET", `/api/office/patients/${patient.id}/sessions?office=20002`, undefined, auth(hqSession.token));
    expect(list.status).toBe(200);
    expect(list.json.linked).toBe(true);
    expect(list.json.sessions).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toContain(patientSession.sessionId);
    await settle();
    expect(backend.audits.some((a) => a.p_action === "patient_sessions_viewed")).toBe(true);

    const noReason = await api("POST", `/api/office/patients/${patient.id}/sign-out?office=20002`, {}, auth(hqSession.token));
    expect(noReason.status).toBe(400);
    const out = await api("POST", `/api/office/patients/${patient.id}/sign-out?office=20002`, { reason: "lost_device" }, auth(hqSession.token));
    expect(out.status).toBe(200);
    expect(backend.sessions.has(patientSession.sessionId)).toBe(false);
    await settle();
    const audit = backend.audits.find((a) => a.p_action === "patient_signed_out")!;
    expect((audit.p_metadata as Row).reason).toBe("lost_device");

    // Office owner: same office, still refused.
    const owner = backend.openSession(String(backend.tables.providers[0].auth_user_id));
    const refused = await api("GET", `/api/office/patients/${patient.id}/sessions`, undefined, auth(owner.token));
    expect(refused.status).toBe(403);

    // Wrong office for the patient reads as not found — same as an unknown id.
    backend.tables.providers.push({ provider_id: "30003", provider_name: "Other", office_name: "Other", email: "o@x.example", onboarding_code: null, access_disabled: false, auth_user_id: null });
    const wrongOffice = await api("GET", `/api/office/patients/${patient.id}/sessions?office=30003`, undefined, auth(hqSession.token));
    const unknownId = await api("GET", `/api/office/patients/PT-NOPE/sessions?office=30003`, undefined, auth(hqSession.token));
    expect(wrongOffice.status).toBe(404);
    expect(unknownId.json).toEqual(wrongOffice.json);
  });

  it("lets an HQ admin view and sign out an HQ teammate, never themselves", async () => {
    const hq = seedHq();
    backend.tables.hq_team_members.push({ id: "HQ-ME", auth_user_id: hq.user.id, name: "Avery HQ", email: "hq@thinnr.example", title: "", role: "admin", status: "active", invited_at: null, joined_at: null });
    const mate = backend.seedAuthUser({ email: "mate@thinnr.example" });
    backend.tables.hq_team_members.push({ id: "HQ-MATE", auth_user_id: mate.id, name: "Morgan", email: "mate@thinnr.example", title: "", role: "support", status: "active", invited_at: null, joined_at: null });
    const me = backend.openSession(String(hq.user.id), MAC_CHROME_UA);
    proveCode(me);
    const mateSession = backend.openSession(String(mate.id));

    const list = await api("GET", "/api/hq-team/HQ-MATE/sessions", undefined, auth(me.token));
    expect(list.status).toBe(200);
    expect(list.json.sessions).toHaveLength(1);
    const self = await api("POST", "/api/hq-team/HQ-ME/sign-out", { reason: "other" }, auth(me.token));
    expect(self.status).toBe(409);
    const out = await api("POST", "/api/hq-team/HQ-MATE/sign-out", { reason: "suspicious_activity" }, auth(me.token));
    expect(out.status).toBe(200);
    expect(backend.sessions.has(mateSession.sessionId)).toBe(false);
    await settle();
    expect(backend.audits.some((a) => a.p_action === "hq_team_sessions_viewed")).toBe(true);
    expect(backend.audits.some((a) => a.p_action === "hq_team_signed_out" && (a.p_metadata as Row).reason === "suspicious_activity")).toBe(true);
  });
});

// ── Fresh-code gate + inline re-authentication ───────────────────────────────

describe("fresh-code gate", () => {
  function seedOwnerWithTeammate() {
    const office = seedOffice();
    const memberUser = backend.seedAuthUser({ email: "sam@clinic.example" });
    backend.tables.team_members.push({ id: TM_ID, provider_id: "20002", name: "Sam Staff", email: "sam@clinic.example", office_role: "staff", activation_status: "activated", auth_user_id: memberUser.id, invited_at: null, joined_at: null, deactivated_at: null });
    const owner = backend.openSession(String(office.user.id), MAC_CHROME_UA);
    const teammate = backend.openSession(String(memberUser.id), IPHONE_UA);
    return { office, owner, teammate };
  }

  it("refuses a sensitive action with reauth_required when the session never proved a code, or proved one too long ago", async () => {
    const { owner, teammate } = seedOwnerWithTeammate();
    const never = await api("POST", `/api/office/team/${TM_ID}/sign-out`, { reason: "lost_device" }, auth(owner.token));
    expect(never.status).toBe(401);
    expect(never.json).toMatchObject({ code: "reauth_required", windowMinutes: 10 });
    expect(backend.sessions.has(teammate.sessionId)).toBe(true);

    proveCode(owner, 11 * 60 * 1000);
    const stale = await api("POST", `/api/office/team/${TM_ID}/sign-out`, { reason: "lost_device" }, auth(owner.token));
    expect(stale.status).toBe(401);
    expect(stale.json.code).toBe("reauth_required");
    expect(backend.sessions.has(teammate.sessionId)).toBe(true);
  });

  it("lets a session with a code proven inside the window act, and a proof on another session of the same user does not count", async () => {
    const { office, owner, teammate } = seedOwnerWithTeammate();
    const otherDevice = backend.openSession(String(office.user.id), IPHONE_UA);
    proveCode(otherDevice, 60 * 1000);
    const wrongSession = await api("POST", `/api/office/team/${TM_ID}/sign-out`, { reason: "lost_device" }, auth(owner.token));
    expect(wrongSession.status).toBe(401);

    proveCode(owner, 9 * 60 * 1000);
    const ok = await api("POST", `/api/office/team/${TM_ID}/sign-out`, { reason: "lost_device" }, auth(owner.token));
    expect(ok.status).toBe(200);
    expect(backend.sessions.has(teammate.sessionId)).toBe(false);
  });

  it("gates staff sign-out-everywhere-else but leaves the patient app's identical call untouched", async () => {
    const { office, owner } = seedOwnerWithTeammate();
    backend.openSession(String(office.user.id), IPHONE_UA);
    const gated = await api("POST", "/api/security/me/sign-out-others", {}, auth(owner.token));
    expect(gated.status).toBe(401);
    expect(gated.json.code).toBe("reauth_required");

    const { user } = seedPatient();
    const phone = backend.openSession(String(user.id));
    backend.openSession(String(user.id), MAC_CHROME_UA);
    const patient = await api("POST", "/api/security/me/sign-out-others", {}, auth(phone.token));
    expect(patient.status).toBe(200);
  });

  it("re-authenticates inline: emails a code bound to this account, verify stamps the session, and the action then succeeds", async () => {
    const { owner, teammate } = seedOwnerWithTeammate();
    proveCode(owner, 30 * 60 * 1000);

    const start = await api("POST", "/api/security/me/reauth/start", {}, auth(owner.token));
    expect(start.status).toBe(200);
    expect(start.json).toMatchObject({ ok: true, channel: "email", windowMinutes: 10 });
    expect(start.json.destination).not.toBe("rivera@clinic.example");
    expect(typeof start.json.devCode).toBe("string");
    const sendRow = backend.tables.claim_verifications.find((r) => r.id === start.json.requestId)!;
    expect(sendRow.purpose).toBe("login");
    expect(sendRow.scope_key).toBe(`staff-reauth:${claimsOf(owner.token)!.sub}`);
    // No new GoTrue session is minted by re-authentication.
    expect(backend.requests.filter((r) => r.includes("/auth/v1/admin/generate_link"))).toHaveLength(0);

    // A re-auth code is not a sign-in code: the login rails refuse AND burn it.
    const asLogin = await api("POST", "/api/auth/login/verify", { requestId: start.json.requestId, code: start.json.devCode }, { "x-thinnr-device": "device-zzzz-9999" });
    expect(asLogin.status).toBe(400);
    const burned = await api("POST", "/api/security/me/reauth/verify", { requestId: start.json.requestId, code: start.json.devCode }, auth(owner.token));
    expect(burned.status).toBe(400);

    const again = await api("POST", "/api/security/me/reauth/start", {}, auth(owner.token));
    expect(again.status).toBe(200);
    const wrong = await api("POST", "/api/security/me/reauth/verify", { requestId: again.json.requestId, code: "000000" }, auth(owner.token));
    expect(wrong.status).toBe(400);
    const stillStale = await api("POST", `/api/office/team/${TM_ID}/sign-out`, { reason: "lost_device" }, auth(owner.token));
    expect(stillStale.status).toBe(401);

    const verified = await api("POST", "/api/security/me/reauth/verify", { requestId: again.json.requestId, code: again.json.devCode }, auth(owner.token));
    expect(verified.status).toBe(200);
    expect(verified.json.ok).toBe(true);
    const ledger = backend.tables.auth_sign_ins.find((r) => r.session_id === owner.sessionId)!;
    expect(Date.now() - new Date(String(ledger.code_verified_at)).getTime()).toBeLessThan(5_000);
    await settle();
    expect(backend.audits.some((a) => a.p_action === "security_reauthenticated")).toBe(true);

    const out = await api("POST", `/api/office/team/${TM_ID}/sign-out`, { reason: "lost_device" }, auth(owner.token));
    expect(out.status).toBe(200);
    expect(backend.sessions.has(teammate.sessionId)).toBe(false);
  });

  it("a re-auth code sent to one staffer proves nothing for another, and verify creates the ledger row when the session has none", async () => {
    const { owner } = seedOwnerWithTeammate();
    const hq = seedHq();
    const hqSession = backend.openSession(String(hq.user.id), MAC_CHROME_UA);

    const start = await api("POST", "/api/security/me/reauth/start", {}, auth(hqSession.token));
    expect(start.status).toBe(200);
    const crossed = await api("POST", "/api/security/me/reauth/verify", { requestId: start.json.requestId, code: start.json.devCode }, auth(owner.token));
    expect(crossed.status).toBe(400);
    // That attempt consumed the code; HQ starts over and lands a fresh proof on a session with no ledger row yet.
    const again = await api("POST", "/api/security/me/reauth/start", {}, auth(hqSession.token));
    const verified = await api("POST", "/api/security/me/reauth/verify", { requestId: again.json.requestId, code: again.json.devCode }, auth(hqSession.token));
    expect(verified.status).toBe(200);
    const row = backend.tables.auth_sign_ins.find((r) => r.session_id === hqSession.sessionId)!;
    expect(row).toBeTruthy();
    expect(typeof row.code_verified_at).toBe("string");
  });

  it("patients cannot start re-authentication, and a staffer with no email on file is told so", async () => {
    const { user } = seedPatient();
    const phone = backend.openSession(String(user.id));
    const patient = await api("POST", "/api/security/me/reauth/start", {}, auth(phone.token));
    expect(patient.status).toBe(403);

    const office = seedOffice();
    const provider = backend.tables.providers.find((p) => p.auth_user_id === office.user.id)!;
    provider.email = null;
    const authUser = backend.authUsers.get(String(office.user.id))!;
    authUser.email = null;
    const owner = backend.openSession(String(office.user.id), MAC_CHROME_UA);
    const noEmail = await api("POST", "/api/security/me/reauth/start", {}, auth(owner.token));
    expect(noEmail.status).toBe(409);
  });
});


// ── Staff second factor: self-service + admin clear ──────────────────────────

describe("staff second factor", () => {
  const policy = () => backend.tables.hq_organization_settings[0];

  async function enrolPhone(token: string, phone: string) {
    const start = await api("POST", "/api/security/me/second-factor/phone/start", { phone }, auth(token));
    expect(start.status).toBe(200);
    expect(start.json.devCode).toMatch(/^\d{6}$/);
    return api("POST", "/api/security/me/second-factor/phone/complete", { requestId: start.json.requestId, code: start.json.devCode }, auth(token));
  }

  it("lets an uncovered teammate enrol a phone, opt in, and turn it off again", async () => {
    seedOffice();
    const memberUser = backend.seedAuthUser({ email: "sam@clinic.example" });
    backend.tables.team_members.push({ id: TM_ID, provider_id: "20002", name: "Sam Staff", email: "sam@clinic.example", office_role: "staff", activation_status: "activated", auth_user_id: memberUser.id });
    const { token } = backend.openSession(String(memberUser.id));

    const before = await api("GET", "/api/security/me", undefined, auth(token));
    expect(before.json.secondFactor).toEqual({ policyRequired: false, enabled: false, phone: null, verifiedAt: null });

    // Opting in without a phone is refused; the phone must be proven first.
    const early = await api("POST", "/api/security/me/second-factor", { enabled: true }, auth(token));
    expect(early.status).toBe(409);

    const bad = await api("POST", "/api/security/me/second-factor/phone/start", { phone: "sam@clinic.example" }, auth(token));
    expect(bad.status).toBe(400);
    expect(bad.json.field).toBe("phone");

    const done = await enrolPhone(token, "(555) 700-1001");
    expect(done.status).toBe(200);
    expect(done.json.secondFactor).toMatchObject({ policyRequired: false, enabled: true, phone: "•••-•••-1001" });
    expect(backend.tables.staff_second_factors).toEqual([
      expect.objectContaining({ staff_kind: "team_member", staff_ref: TM_ID, phone: "+15557001001", enabled: true }),
    ]);
    await settle();
    expect(backend.audits.some((a) => a.p_action === "security_second_factor_enrolled" && a.p_target_id === TM_ID)).toBe(true);

    const off = await api("POST", "/api/security/me/second-factor", { enabled: false }, auth(token));
    expect(off.status).toBe(200);
    expect(off.json.secondFactor.enabled).toBe(false);
    expect(backend.tables.staff_second_factors[0].enabled).toBe(false);
    await settle();
    expect(backend.audits.some((a) => a.p_action === "security_second_factor_changed" && (a.p_metadata as Row).enabled === false)).toBe(true);

    // Enrolment codes must be proven by the same signed-in identity.
    const other = backend.seedAuthUser({ email: "rival@clinic.example" });
    backend.tables.team_members.push({ id: TM_MANY, provider_id: "20002", name: "Rival", email: "rival@clinic.example", office_role: "staff", activation_status: "activated", auth_user_id: other.id });
    const rival = backend.openSession(String(other.id));
    const start = await api("POST", "/api/security/me/second-factor/phone/start", { phone: "+15557002002" }, auth(token));
    const stolen = await api("POST", "/api/security/me/second-factor/phone/complete", { requestId: start.json.requestId, code: start.json.devCode }, auth(rival.token));
    expect(stolen.status).toBe(400);
    expect(backend.tables.staff_second_factors.find((r) => r.staff_ref === TM_MANY)).toBeUndefined();
  });

  it("reports the policy requirement for owners and refuses to turn it off; patients have no second factor block", async () => {
    policy().second_factor_office_managers = true;
    const office = seedOffice();
    const { token } = backend.openSession(String(office.user.id));
    const me = await api("GET", "/api/security/me", undefined, auth(token));
    expect(me.json.secondFactor).toMatchObject({ policyRequired: true, enabled: true, phone: null });
    const off = await api("POST", "/api/security/me/second-factor", { enabled: false }, auth(token));
    expect(off.status).toBe(409);

    const { user } = seedPatient();
    const patient = backend.openSession(String(user.id));
    const pm = await api("GET", "/api/security/me", undefined, auth(patient.token));
    expect(pm.json.secondFactor).toBeNull();
    const refused = await api("POST", "/api/security/me/second-factor/phone/start", { phone: "+15557001001" }, auth(patient.token));
    expect(refused.status).toBe(403);
  });

  it("lets an owner clear a teammate's phone (audited) and lists the masked phone on the team", async () => {
    const office = seedOffice();
    const memberUser = backend.seedAuthUser({ email: "sam@clinic.example" });
    backend.tables.team_members.push({ id: TM_ID, provider_id: "20002", name: "Sam Staff", email: "sam@clinic.example", office_role: "staff", activation_status: "activated", auth_user_id: memberUser.id });
    backend.tables.staff_second_factors.push({ staff_kind: "team_member", staff_ref: TM_ID, phone: "+15557001001", verified_at: new Date().toISOString(), enabled: true });
    const owner = backend.openSession(String(office.user.id), MAC_CHROME_UA);

    const team = await api("GET", "/api/office/team", undefined, auth(owner.token));
    expect(team.status).toBe(200);
    expect(team.json.members[0].secondFactorPhone).toBe("•••-•••-1001");
    expect(team.json.accountOwner.secondFactorPhone).toBeNull();
    expect(JSON.stringify(team.json)).not.toContain("5557001001");

    // Clearing someone's phone lowers their security: like a forced sign-out
    // it needs a fresh code from the person at the keyboard.
    const stale = await api("POST", `/api/office/team/${TM_ID}/second-factor/clear`, {}, auth(owner.token));
    expect(stale.status).toBe(401);
    expect(stale.json.code).toBe("reauth_required");
    expect(backend.tables.staff_second_factors).toHaveLength(1);
    proveCode(owner);
    const cleared = await api("POST", `/api/office/team/${TM_ID}/second-factor/clear`, {}, auth(owner.token));
    expect(cleared.status).toBe(200);
    expect(cleared.json).toMatchObject({ cleared: true, member: { id: TM_ID, secondFactorPhone: null } });
    expect(backend.tables.staff_second_factors).toEqual([]);
    await settle();
    expect(backend.audits.some((a) => a.p_action === "office_team_phone_cleared" && a.p_target_id === TM_ID)).toBe(true);

    // The account holder's own phone is HQ-only.
    const ownerPhone = await api("POST", "/api/office/team/account-owner/second-factor/clear", {}, auth(owner.token));
    expect(ownerPhone.status).toBe(403);
  });

  it("lets an HQ admin clear an HQ teammate's phone, never their own", async () => {
    const hq = seedHq();
    backend.tables.hq_team_members.push({ id: "HQ-ME", auth_user_id: hq.user.id, name: "Avery HQ", email: "hq@thinnr.example", title: "", role: "admin", status: "active", invited_at: null, joined_at: null });
    const mate = backend.seedAuthUser({ email: "mate@thinnr.example" });
    backend.tables.hq_team_members.push({ id: "HQ-MATE", auth_user_id: mate.id, name: "Morgan", email: "mate@thinnr.example", title: "", role: "support", status: "active", invited_at: null, joined_at: null });
    backend.tables.staff_second_factors.push({ staff_kind: "hq", staff_ref: "HQ-MATE", phone: "+15557003003", verified_at: new Date().toISOString(), enabled: true });
    const me = backend.openSession(String(hq.user.id), MAC_CHROME_UA);

    const list = await api("GET", "/api/hq-team", undefined, auth(me.token));
    expect(list.status).toBe(200);
    expect(list.json.members.find((m: Row) => m.id === "HQ-MATE").secondFactorPhone).toBe("•••-•••-3003");

    const self = await api("POST", "/api/hq-team/HQ-ME/second-factor/clear", {}, auth(me.token));
    expect(self.status).toBe(409);
    const stale = await api("POST", "/api/hq-team/HQ-MATE/second-factor/clear", {}, auth(me.token));
    expect(stale.status).toBe(401);
    expect(stale.json.code).toBe("reauth_required");
    proveCode(me);
    const out = await api("POST", "/api/hq-team/HQ-MATE/second-factor/clear", {}, auth(me.token));
    expect(out.status).toBe(200);
    expect(out.json.cleared).toBe(true);
    expect(backend.tables.staff_second_factors).toEqual([]);
    await settle();
    expect(backend.audits.some((a) => a.p_action === "hq_team_phone_cleared" && a.p_target_id === "HQ-MATE")).toBe(true);
  });
});

// ── Local verification + revocation list ─────────────────────────────────────

describe("local token verification", () => {
  const authUserCalls = () => backend.requests.filter((r) => r === "GET /auth/v1/user").length;

  it("serves ordinary staff reads from a locally verified token — no /auth/v1/user round trip", async () => {
    const office = seedOffice();
    const owner = backend.openVerifiedSession(String(office.user.id), MAC_CHROME_UA);
    const first = await api("GET", "/api/office/team", undefined, auth(owner.token));
    expect(first.status).toBe(200);
    const again = await api("GET", "/api/office/team", undefined, auth(owner.token));
    expect(again.status).toBe(200);
    expect(authUserCalls()).toBe(0);
    expect(backend.requests.filter((r) => r === "GET /auth/v1/.well-known/jwks.json")).toHaveLength(1);
    expect(backend.requests.filter((r) => r === "GET /rest/v1/auth_session_revocations")).toHaveLength(2);
  });

  it("still asks Supabase Auth on the security-settings family, per the route policy", async () => {
    const office = seedOffice();
    const owner = backend.openVerifiedSession(String(office.user.id), MAC_CHROME_UA);
    const me = await api("GET", "/api/security/me", undefined, auth(owner.token));
    expect(me.status).toBe(200);
    expect(authUserCalls()).toBe(1);
    // The revocation list is authoritative on every route, remote ones included.
    expect(backend.requests.filter((r) => r === "GET /rest/v1/auth_session_revocations")).toHaveLength(1);
  });

  it("rejects expired, tampered, and foreign-project tokens without consulting Supabase Auth", async () => {
    const office = seedOffice();
    const userId = String(office.user.id);
    const sessionId = crypto.randomUUID();
    const expired = signer.sign({ sub: userId, session_id: sessionId }, { nowSeconds: Math.floor(Date.now() / 1000) - 7200 });
    const foreign = signer.sign({ sub: userId, session_id: sessionId }, { issuer: "https://someone-else.supabase.co/auth/v1" });
    const genuine = signer.sign({ sub: userId, session_id: sessionId });
    const [h, p] = genuine.split(".");
    const tampered = `${h}.${p}.${Buffer.from("not-the-signature").toString("base64url")}`;
    for (const token of [expired, foreign, tampered]) {
      const res = await api("GET", "/api/office/team", undefined, auth(token));
      expect(res.status).toBe(401);
    }
    expect(authUserCalls()).toBe(0);
  });

  it("cuts a signed-out-everywhere session off on an ordinary read within the same second", async () => {
    const office = seedOffice();
    const userId = String(office.user.id);
    const phone = backend.openVerifiedSession(userId, IPHONE_UA);
    proveCode(phone);
    const laptop = backend.openVerifiedSession(userId, MAC_CHROME_UA);
    expect((await api("GET", "/api/office/team", undefined, auth(laptop.token))).status).toBe(200);

    const out = await api("POST", "/api/security/me/sign-out-others", {}, auth(phone.token));
    expect(out.status).toBe(200);
    // The laptop's session id is on the list with an expiry, the phone's is not.
    const rows = backend.tables.auth_session_revocations;
    expect(rows.map((r) => r.session_id)).toEqual([laptop.sessionId]);
    expect(rows[0]).toMatchObject({ user_id: userId, reason: "signed_out_others" });
    expect(new Date(String(rows[0].expires_at)).getTime()).toBeGreaterThan(Date.now());

    const before = authUserCalls();
    const refused = await api("GET", "/api/office/team", undefined, auth(laptop.token));
    expect(refused.status).toBe(401);
    const kept = await api("GET", "/api/office/team", undefined, auth(phone.token));
    expect(kept.status).toBe(200);
    expect(authUserCalls()).toBe(before);
  });

  it("refuses to report a sign-out when the revocation list cannot be written", async () => {
    const office = seedOffice();
    const userId = String(office.user.id);
    const phone = backend.openVerifiedSession(userId, IPHONE_UA);
    const laptop = backend.openVerifiedSession(userId, MAC_CHROME_UA);
    proveCode(phone);
    backend.failRevocationWrites = true;
    const out = await api("POST", "/api/security/me/sign-out-others", {}, auth(phone.token));
    expect(out.status).toBe(502);
    // The atomic RPC refused as a whole: no row on the list, no session ended.
    expect(backend.tables.auth_session_revocations).toEqual([]);
    expect(backend.sessions.has(laptop.sessionId)).toBe(true);
    expect((await api("GET", "/api/office/team", undefined, auth(laptop.token))).status).toBe(200);
  });

  it("signs out every one of a teammate's sessions, however many, with no list cap", async () => {
    const office = seedOffice();
    const memberUser = backend.seedAuthUser({ email: "sam@clinic.example" });
    backend.tables.team_members.push({ id: TM_MANY, provider_id: "20002", name: "Sam Staff", email: "sam@clinic.example", office_role: "admin", activation_status: "activated", auth_user_id: memberUser.id, invited_at: null, joined_at: null, deactivated_at: null });
    const memberId = String(memberUser.id);
    const owner = backend.openVerifiedSession(String(office.user.id), MAC_CHROME_UA);
    proveCode(owner);
    const devices = Array.from({ length: 130 }, (_, i) => backend.openVerifiedSession(memberId, i % 2 ? IPHONE_UA : MAC_CHROME_UA));
    expect((await api("GET", "/api/office/team", undefined, auth(devices[129].token))).status).toBe(200);

    const out = await api("POST", `/api/office/team/${TM_MANY}/sign-out`, { reason: "lost_device" }, auth(owner.token));
    expect(out.status).toBe(200);
    // The forced sign-out itself is a security-settings route (remote); every
    // ordinary read below is refused locally, without asking Supabase Auth.
    const before = authUserCalls();
    expect(backend.tables.auth_session_revocations.map((r) => r.session_id).sort()).toEqual(devices.map((d) => d.sessionId).sort());
    expect([...backend.sessions.keys()]).toEqual([owner.sessionId]);
    for (const device of devices) {
      expect((await api("GET", "/api/office/team", undefined, auth(device.token))).status).toBe(401);
    }
    expect((await api("GET", "/api/office/team", undefined, auth(owner.token))).status).toBe(200);
    expect(authUserCalls()).toBe(before);
  });

  it("a session opened after the sweep is a new login and stays valid, while every earlier one is refused", async () => {
    const office = seedOffice();
    const memberUser = backend.seedAuthUser({ email: "sam@clinic.example" });
    backend.tables.team_members.push({ id: TM_LATE, provider_id: "20002", name: "Sam Staff", email: "sam@clinic.example", office_role: "admin", activation_status: "activated", auth_user_id: memberUser.id, invited_at: null, joined_at: null, deactivated_at: null });
    const memberId = String(memberUser.id);
    const owner = backend.openVerifiedSession(String(office.user.id), MAC_CHROME_UA);
    proveCode(owner);
    const stale = backend.openVerifiedSession(memberId, IPHONE_UA);
    expect((await api("POST", `/api/office/team/${TM_LATE}/sign-out`, { reason: "lost_device" }, auth(owner.token))).status).toBe(200);
    const fresh = backend.openVerifiedSession(memberId, MAC_CHROME_UA);
    expect((await api("GET", "/api/office/team", undefined, auth(stale.token))).status).toBe(401);
    expect((await api("GET", "/api/office/team", undefined, auth(fresh.token))).status).toBe(200);
    expect(backend.tables.auth_session_revocations.map((r) => r.session_id)).toEqual([stale.sessionId]);
  });

  it("answers with an outage, never 'signed out', when the revocation list cannot be read", async () => {
    const office = seedOffice();
    const owner = backend.openVerifiedSession(String(office.user.id), MAC_CHROME_UA);
    delete backend.tables.auth_session_revocations;
    // Office routes map any identity outage to their 502 "try again"; the
    // staff guards answer 503. Neither may look like a sign-out.
    const res = await api("GET", "/api/office/team", undefined, auth(owner.token));
    expect(res.status).toBeGreaterThanOrEqual(502);
    expect(res.status).toBeLessThan(504);
    const hq = await api("GET", "/api/hq-team", undefined, auth(owner.token));
    expect(hq.status).toBe(503);
  });
});
