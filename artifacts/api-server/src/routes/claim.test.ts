/**
 * Account-claiming route suite — runs against an in-memory fake of the
 * Supabase REST + Auth + Twilio/Resend surfaces so every privacy and
 * race-condition rule can be exercised deterministically.
 *
 * The env-gated live suite (src/claim/claim-live.test.ts) re-proves the
 * critical paths against the real database with synthetic rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

const FAKE_SUPABASE = "http://fake.supabase.local";
const PWNED_PASSWORD = "Breached!Password";

type Row = Record<string, unknown>;

class FakeBackend {
  tables: Record<string, Row[]> = {};
  authUsers = new Map<string, Row>();
  sessions = new Map<string, string>();
  sentEmails: Array<{ to: string; code: string | null }> = [];
  twilioStarts: string[] = [];
  twilioApprovedCode: string | null = null;
  failEmailSend = false;
  deletedUsers: string[] = [];
  /** One-shot hook fired right after a login is created — simulates a rival
   *  claim landing between user creation and the guarded link update. */
  onUserCreate: (() => void) | null = null;

  reset() {
    this.tables = {
      claim_verifications: [],
      patients: [],
      providers: [],
      team_members: [],
      profiles: [],
      staff_role_assignments: [],
    };
    this.authUsers.clear();
    this.sessions.clear();
    this.sentEmails = [];
    this.twilioStarts = [];
    this.twilioApprovedCode = null;
    this.failEmailSend = false;
    this.deletedUsers = [];
    this.onUserCreate = null;
  }

  addSession(userId: string): string {
    const token = `session-${crypto.randomUUID()}`;
    this.sessions.set(token, userId);
    return token;
  }

  private matchRows(table: string, conditions: Array<[string, string, string]>): Row[] {
    return (this.tables[table] ?? []).filter((row) =>
      conditions.every(([col, op, value]) => {
        const cell = row[col];
        if (op === "eq") return String(cell ?? "") === value;
        if (op === "gt") return typeof cell === "string" && cell > value;
        if (op === "lt") return typeof cell === "string" && cell < value;
        if (op === "is") {
          if (value === "null") return cell === null || cell === undefined;
          if (value === "false") return cell === false;
          if (value === "true") return cell === true;
        }
        throw new Error(`fake: unsupported op ${op}`);
      }),
    );
  }

  private parseConditions(url: URL): Array<[string, string, string]> {
    const conditions: Array<[string, string, string]> = [];
    url.searchParams.forEach((raw, key) => {
      if (key === "select" || key === "order" || key === "limit") return;
      const dot = raw.indexOf(".");
      conditions.push([key, raw.slice(0, dot), raw.slice(dot + 1)]);
    });
    return conditions;
  }

  private runRpc(body: { p_kind: string; p_value: string }): Row[] {
    const out: Row[] = [];
    const value = body.p_value.toLowerCase();
    const active = (row: Row, field: string, disabledValue: unknown) =>
      row[field] !== disabledValue;
    if (body.p_kind === "email") {
      for (const p of this.tables.providers) {
        if (String(p.email ?? "").toLowerCase() === value && !p.access_disabled) {
          out.push({
            type: "provider",
            ref: String(p.provider_id),
            name: p.provider_name ?? null,
            dob: null,
            claimed: Boolean(p.auth_user_id),
            auth_user_id: p.auth_user_id ?? null,
          });
        }
      }
      for (const t of this.tables.team_members) {
        if (
          String(t.email ?? "").toLowerCase() === value &&
          active(t, "activation_status", "disabled")
        ) {
          out.push({
            type: "team_member",
            ref: String(t.id),
            name: t.name ?? null,
            dob: null,
            claimed: Boolean(t.auth_user_id),
            auth_user_id: t.auth_user_id ?? null,
          });
        }
      }
      for (const p of this.tables.patients) {
        if (
          String(p.email ?? "").toLowerCase() === value &&
          active(p, "activation_status", "disabled")
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
        if (digits.slice(-10) === last10 && digits.length >= 10 &&
          active(p, "activation_status", "disabled")) {
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
    const idMatch = url.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
    if (method === "POST" && url.pathname === "/auth/v1/admin/users") {
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
      if (body?.password === PWNED_PASSWORD) {
        return json(422, {
          error_code: "weak_password",
          msg: "Password is known to be weak and easy to guess",
        });
      }
      const id = crypto.randomUUID();
      const user = {
        id,
        email,
        phone,
        password: body?.password,
        app_metadata: body?.app_metadata ?? {},
        user_metadata: body?.user_metadata ?? {},
      };
      this.authUsers.set(id, user);
      if (this.onUserCreate) {
        const hook = this.onUserCreate;
        this.onUserCreate = null;
        hook();
      }
      return json(200, user);
    }
    if (idMatch && method === "PUT") {
      const user = this.authUsers.get(idMatch[1]);
      if (!user) return json(404, { msg: "User not found" });
      if (body?.phone) {
        for (const [otherId, other] of this.authUsers) {
          if (otherId !== idMatch[1] && other.phone === body.phone) {
            return json(422, {
              error_code: "phone_exists",
              msg: "Phone number already registered by another user",
            });
          }
        }
        user.phone = String(body.phone);
      }
      if (body?.password) {
        if (body.password === PWNED_PASSWORD) {
          return json(422, {
            error_code: "weak_password",
            msg: "Password is known to be weak and easy to guess",
          });
        }
        user.password = String(body.password);
      }
      return json(200, user);
    }
    if (idMatch && method === "DELETE") {
      this.authUsers.delete(idMatch[1]);
      this.deletedUsers.push(idMatch[1]);
      return json(200, {});
    }
    return json(404, { msg: `fake: no auth route ${method} ${url.pathname}` });
  }

  handle(input: string, init?: RequestInit): Response {
    const url = new URL(input);
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
        return json(201, { status: "pending" });
      }
      if (url.pathname.endsWith("/VerificationCheck")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const approved = this.twilioApprovedCode !== null &&
          params.get("Code") === this.twilioApprovedCode;
        return json(200, { status: approved ? "approved" : "pending" });
      }
      return json(404, {});
    }
    if (url.hostname === "api.resend.com") {
      if (this.failEmailSend) return json(500, { message: "boom" });
      const to = Array.isArray(body?.to) ? String(body?.to[0]) : "";
      const code = /code is (\d{6})/.exec(String(body?.text ?? ""))?.[1] ?? null;
      this.sentEmails.push({ to, code });
      return json(200, { id: crypto.randomUUID() });
    }

    if (url.pathname === "/auth/v1/user") {
      const header = String(
        (init?.headers as Record<string, string> | undefined)?.Authorization ?? "",
      );
      const token = header.replace(/^Bearer /i, "");
      const userId = this.sessions.get(token);
      const user = userId ? this.authUsers.get(userId) : null;
      if (!user) return json(401, { msg: "invalid token" });
      return json(200, { id: user.id, email: user.email ?? undefined, phone: user.phone ?? undefined });
    }
    if (url.pathname.startsWith("/auth/v1/admin/")) {
      return this.authAdmin(method, url, body);
    }

    if (url.pathname === "/rest/v1/rpc/claim_find_candidates") {
      return json(200, this.runRpc(body as { p_kind: string; p_value: string }));
    }

    if (url.pathname === "/rest/v1/rpc/claim_register_send") {
      // Mirrors the real atomic function: purpose-scoped hourly counts for
      // the destination and the optional account scope, then insert-or-empty.
      const p = body as Row;
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const ledger = this.tables.claim_verifications;
      const inHour = ledger.filter(
        (r) => r.purpose === p.p_purpose && String(r.created_at) > hourAgo,
      );
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
      const conditions = this.parseConditions(url);
      if (method === "GET") return json(200, this.matchRows(table, conditions));
      if (method === "DELETE") {
        const doomed = new Set(this.matchRows(table, conditions));
        this.tables[table] = this.tables[table].filter((row) => !doomed.has(row));
        return json(200, []);
      }
      if (method === "PATCH") {
        const rows = this.matchRows(table, conditions);
        for (const row of rows) Object.assign(row, body);
        return json(200, rows);
      }
      if (method === "POST") {
        const row: Row = {
          ...(table === "claim_verifications"
            ? {
                id: crypto.randomUUID(),
                created_at: new Date().toISOString(),
                code_attempts: 0,
                birthday_checked: false,
                resolved_ref: null,
                verified_at: null,
                claim_token_hash: null,
                consumed_at: null,
                auth_user_id: null,
              }
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
let server: http.Server;
let base: string;

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: any }> {
  const response = await realFetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

/** Runs identify→verify and returns the verify response body. */
async function identifyAndVerify(identifier: string) {
  const identify = await api("POST", "/api/claim/identify", { identifier });
  expect(identify.status).toBe(200);
  expect(identify.json.devCode).toMatch(/^\d{6}$/);
  const verify = await api("POST", "/api/claim/verify", {
    requestId: identify.json.requestId,
    code: identify.json.devCode,
  });
  return { identify, verify };
}

beforeAll(async () => {
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  process.env.CLAIM_DELIVERY_MODE = "dev";
  process.env.CLAIM_IDENTIFY_FLOOR_MS = "0"; // timing test opts back in
  process.env.CLAIM_IDENTIFY_BURST = "100000";
  process.env.CLAIM_IDENTIFY_DAILY_BUDGET = "100000";
  process.env.CLAIM_VERIFY_BURST = "100000";
  process.env.CLAIM_VERIFY_DAILY_BUDGET = "100000";
  process.env.CLAIM_COMPLETE_BURST = "100000";
  process.env.CLAIM_COMPLETE_DAILY_BUDGET = "100000";

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

  const { default: claimRouter } = await import("./claim");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: (obj: { err?: Error }, msg: string) =>
        console.log("ROUTELOG", msg, obj?.err?.message ?? obj),
    };
    next();
  });
  app.use("/api", claimRouter);
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  backend.reset();
  process.env.CLAIM_DELIVERY_MODE = "dev";
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_VERIFY_SERVICE_SID;
  delete process.env.RESEND_API_KEY;
  delete process.env.CLAIM_EMAIL_FROM;
});

function seedPatient(overrides: Row = {}): Row {
  const row: Row = {
    id: crypto.randomUUID(),
    name: "Casey Claimant",
    email: null,
    phone: "(555) 201-3344",
    date_of_birth: "1984-03-19",
    activation_status: "active",
    provider_id: "10001",
    auth_user_id: null,
    claimed_at: null,
    ...overrides,
  };
  backend.tables.patients.push(row);
  return row;
}

describe("identify", () => {
  it("rejects identifiers that are neither phone nor email", async () => {
    const res = await api("POST", "/api/claim/identify", { identifier: "x" });
    expect(res.status).toBe(400);
    expect(res.json.field).toBe("identifier");
  });

  it("answers unknown and known identifiers with identical shapes", async () => {
    seedPatient();
    const unknown = await api("POST", "/api/claim/identify", { identifier: "555-999-0000" });
    const known = await api("POST", "/api/claim/identify", { identifier: "555-201-3344" });
    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    expect(Object.keys(unknown.json).sort()).toEqual(Object.keys(known.json).sort());
    expect(unknown.json.message).toBe(known.json.message);
    // Only the real match stores a ledger row.
    expect(backend.tables.claim_verifications).toHaveLength(1);
    expect(backend.tables.claim_verifications[0].identifier).toBe("+15552013344");
  });

  it("never surfaces disabled patients", async () => {
    seedPatient({ activation_status: "disabled" });
    const res = await api("POST", "/api/claim/identify", { identifier: "5552013344" });
    expect(res.status).toBe(200);
    expect(backend.tables.claim_verifications).toHaveLength(0);
  });

  it("caps sends per identifier per hour, silently", async () => {
    seedPatient();
    for (let i = 0; i < 3; i += 1) {
      await api("POST", "/api/claim/identify", { identifier: "5552013344" });
    }
    const fourth = await api("POST", "/api/claim/identify", { identifier: "5552013344" });
    expect(fourth.status).toBe(200);
    expect(fourth.json.devCode).toMatch(/^\d{6}$/); // decoy — indistinguishable
    expect(backend.tables.claim_verifications).toHaveLength(3);
  });

  it("holds the cap for concurrent identify bursts (single atomic registration call)", async () => {
    seedPatient();
    const burst = await Promise.all(
      Array.from({ length: 6 }, () =>
        api("POST", "/api/claim/identify", { identifier: "5552013344" }),
      ),
    );
    for (const result of burst) {
      expect(result.status).toBe(200);
      expect(result.json.devCode).toMatch(/^\d{6}$/); // real or decoy, same shape
    }
    expect(backend.tables.claim_verifications).toHaveLength(3);
  });

  it("starts live delivery only after the response went out (no hit-only signal)", async () => {
    process.env.CLAIM_DELIVERY_MODE = "live";
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest";
    process.env.CLAIM_IDENTIFY_FLOOR_MS = "200";
    try {
      seedPatient();
      const pending = api("POST", "/api/claim/identify", { identifier: "5552013344" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Mid-floor: the response hasn't gone out, so Twilio MUST be untouched.
      expect(backend.twilioStarts).toHaveLength(0);
      const response = await pending;
      expect(response.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(backend.twilioStarts).toEqual(["+15552013344"]);
    } finally {
      process.env.CLAIM_IDENTIFY_FLOOR_MS = "0";
    }
  });

  it("answers hits and misses in the same time (identify floor)", async () => {
    process.env.CLAIM_IDENTIFY_FLOOR_MS = "150";
    try {
      seedPatient();
      const timings: number[] = [];
      for (const identifier of ["5552013344", "5559990000"]) {
        const startedAt = Date.now();
        const result = await api("POST", "/api/claim/identify", { identifier });
        timings.push(Date.now() - startedAt);
        expect(result.status).toBe(200);
      }
      // Both outcomes are held to the floor — the miss cannot return early.
      expect(Math.min(...timings)).toBeGreaterThanOrEqual(140);
    } finally {
      process.env.CLAIM_IDENTIFY_FLOOR_MS = "0";
    }
  });

  it("prefers provider over patient when one email lives in both tables", async () => {
    seedPatient({ email: "shared@example.com", phone: null });
    backend.tables.providers.push({
      provider_id: "20001",
      provider_name: "Dr. Shared",
      office_name: "Shared Clinic",
      email: "shared@example.com",
      access_disabled: false,
      auth_user_id: null,
    });
    await api("POST", "/api/claim/identify", { identifier: "Shared@Example.com" });
    expect(backend.tables.claim_verifications[0].account_type).toBe("provider");
  });
});

describe("verify + claim completion", () => {
  it("refuses to finish unless the retyped password matches", async () => {
    seedPatient();
    const { verify } = await identifyAndVerify("555-201-3344");

    const mismatch = await api("POST", "/api/claim/complete", {
      claimToken: verify.json.claimToken,
      password: "Sturdy!Passphrase",
      passwordConfirm: "Sturdy!Typo",
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.field).toBe("passwordConfirm");

    const missing = await api("POST", "/api/claim/complete", {
      claimToken: verify.json.claimToken,
      password: "Sturdy!Passphrase",
    });
    expect(missing.status).toBe(400);
    expect(missing.json.field).toBe("passwordConfirm");

    // The token survives a mismatch — retyping it correctly still finishes.
    const complete = await api("POST", "/api/claim/complete", {
      claimToken: verify.json.claimToken,
      password: "Sturdy!Passphrase",
      passwordConfirm: "Sturdy!Passphrase",
    });
    expect(complete.status).toBe(200);
  });

  it("claims a single-match patient by phone end to end", async () => {
    const patient = seedPatient();
    const { verify } = await identifyAndVerify("555-201-3344");
    expect(verify.status).toBe(200);
    expect(verify.json.next).toBe("password");
    expect(verify.json.mode).toBe("create");
    expect(verify.json.masked).toContain("3344");

    const complete = await api("POST", "/api/claim/complete", {
      claimToken: verify.json.claimToken,
      password: "Sturdy!Passphrase",
      passwordConfirm: "Sturdy!Passphrase",
    });
    expect(complete.status).toBe(200);
    expect(complete.json.mode).toBe("create");
    expect(complete.json.signIn).toEqual({ method: "phone", identifier: "+15552013344" });

    expect(patient.auth_user_id).toBeTruthy();
    expect(patient.claimed_at).toBeTruthy();
    const user = backend.authUsers.get(String(patient.auth_user_id))!;
    expect(user.phone).toBe("+15552013344");
    expect(user.email).toBeNull(); // only the verified contact attaches
    expect(user.app_metadata).toEqual({
      thinnr_claim: "patient",
      thinnr_claim_ref: String(patient.id),
    });
    expect(backend.tables.claim_verifications[0].consumed_at).toBeTruthy();
  });

  it("gives one generic error for wrong codes and locks after five attempts", async () => {
    seedPatient();
    const identify = await api("POST", "/api/claim/identify", { identifier: "5552013344" });
    for (let i = 0; i < 5; i += 1) {
      const wrong = await api("POST", "/api/claim/verify", {
        requestId: identify.json.requestId,
        code: "000000",
      });
      expect(wrong.status).toBe(400);
      expect(wrong.json.error).toContain("didn't match or has expired");
    }
    // Correct code now also fails — attempts are spent.
    const late = await api("POST", "/api/claim/verify", {
      requestId: identify.json.requestId,
      code: identify.json.devCode,
    });
    expect(late.status).toBe(400);
    expect(late.json.error).toContain("didn't match or has expired");
  });

  it("treats expired codes exactly like wrong ones", async () => {
    seedPatient();
    const identify = await api("POST", "/api/claim/identify", { identifier: "5552013344" });
    backend.tables.claim_verifications[0].code_expires_at = new Date(
      Date.now() - 1000,
    ).toISOString();
    const res = await api("POST", "/api/claim/verify", {
      requestId: identify.json.requestId,
      code: identify.json.devCode,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("didn't match or has expired");
  });

  it("refuses to verify the same code twice", async () => {
    seedPatient();
    const identify = await api("POST", "/api/claim/identify", { identifier: "5552013344" });
    const first = await api("POST", "/api/claim/verify", {
      requestId: identify.json.requestId,
      code: identify.json.devCode,
    });
    expect(first.status).toBe(200);
    const second = await api("POST", "/api/claim/verify", {
      requestId: identify.json.requestId,
      code: identify.json.devCode,
    });
    expect(second.status).toBe(400);
  });

  it("resets the password when the record is already claimed", async () => {
    const authId = crypto.randomUUID();
    backend.authUsers.set(authId, { id: authId, phone: "+15552013344", password: "Old!Password" });
    seedPatient({ auth_user_id: authId, claimed_at: new Date().toISOString() });
    const { verify } = await identifyAndVerify("5552013344");
    expect(verify.json.mode).toBe("reset");

    const complete = await api("POST", "/api/claim/complete", {
      claimToken: verify.json.claimToken,
      password: "Fresh!Passphrase",
      passwordConfirm: "Fresh!Passphrase",
    });
    expect(complete.status).toBe(200);
    expect(complete.json.mode).toBe("reset");
    expect(backend.authUsers.get(authId)!.password).toBe("Fresh!Passphrase");
    expect(backend.authUsers.size).toBe(1); // no duplicate login
  });

  it("enforces the password rules with specific guidance", async () => {
    seedPatient();
    const { verify } = await identifyAndVerify("5552013344");
    const cases: Array<[string, RegExp]> = [
      ["Sh0rt!", /at least 8/],
      ["lowercase!only", /uppercase/],
      ["UPPERCASE!ONLY", /lowercase/],
      ["NoSymbolHere1", /symbol/],
    ];
    for (const [password, pattern] of cases) {
      const res = await api("POST", "/api/claim/complete", {
        claimToken: verify.json.claimToken,
        password,
      });
      expect(res.status).toBe(400);
      expect(res.json.field).toBe("password");
      expect(res.json.error).toMatch(pattern);
    }
  });

  it("relays the leaked-password rejection in plain language", async () => {
    seedPatient();
    const { verify } = await identifyAndVerify("5552013344");
    const res = await api("POST", "/api/claim/complete", {
      claimToken: verify.json.claimToken,
      password: PWNED_PASSWORD,
      passwordConfirm: PWNED_PASSWORD,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("data breach");
  });

  it("turns a late duplicate claim into a password reset, never a second login", async () => {
    // Two parallel flows, both proving the same phone. The second to finish
    // sees the record already linked and simply resets that login's password
    // — the same trust level, no duplicate account.
    const patient = seedPatient();
    const flowA = await identifyAndVerify("5552013344");
    const flowB = await identifyAndVerify("5552013344");

    const first = await api("POST", "/api/claim/complete", {
      claimToken: flowA.verify.json.claimToken,
      password: "Winner!Passphrase",
      passwordConfirm: "Winner!Passphrase",
    });
    expect(first.status).toBe(200);
    expect(first.json.mode).toBe("create");
    const linkedUserId = String(patient.auth_user_id);

    const second = await api("POST", "/api/claim/complete", {
      claimToken: flowB.verify.json.claimToken,
      password: "Second!Passphrase",
      passwordConfirm: "Second!Passphrase",
    });
    expect(second.status).toBe(200);
    expect(second.json.mode).toBe("reset");
    expect(patient.auth_user_id).toBe(linkedUserId); // link untouched
    expect(backend.authUsers.size).toBe(1); // still exactly one login
    expect(backend.authUsers.get(linkedUserId)!.password).toBe("Second!Passphrase");
  });

  it("rolls back the created login when the link is lost to a photo-finish race", async () => {
    const patient = seedPatient();
    const { verify } = await identifyAndVerify("5552013344");

    // Rival claim lands in the window between login creation and the
    // guarded link update.
    backend.onUserCreate = () => {
      patient.auth_user_id = "rival-user-id";
      patient.claimed_at = new Date().toISOString();
    };
    const res = await api("POST", "/api/claim/complete", {
      claimToken: verify.json.claimToken,
      password: "Racer!Passphrase",
      passwordConfirm: "Racer!Passphrase",
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("already claimed");
    expect(patient.auth_user_id).toBe("rival-user-id"); // rival's link untouched
    expect(backend.deletedUsers).toHaveLength(1); // our orphan login removed
    expect(backend.authUsers.size).toBe(0);
  });
});

describe("shared phones and birthdays", () => {
  function seedSiblings() {
    const a = seedPatient({ name: "Alex Shared", date_of_birth: "1990-05-02" });
    const b = seedPatient({ name: "Bailey Shared", date_of_birth: "1996-11-23" });
    return { a, b };
  }

  it("asks for the birthday and claims the matching sibling", async () => {
    const { b } = seedSiblings();
    const { verify } = await identifyAndVerify("5552013344");
    expect(verify.status).toBe(200);
    expect(verify.json.next).toBe("birthday");

    const birthday = await api("POST", "/api/claim/birthday", {
      claimToken: verify.json.claimToken,
      birthday: "1996-11-23",
    });
    expect(birthday.status).toBe(200);
    expect(birthday.json.next).toBe("password");
    expect(birthday.json.mode).toBe("create");

    const complete = await api("POST", "/api/claim/complete", {
      claimToken: verify.json.claimToken,
      password: "Sibling!Passphrase",
      passwordConfirm: "Sibling!Passphrase",
    });
    expect(complete.status).toBe(200);
    expect(b.auth_user_id).toBeTruthy();
  });

  it("gives exactly one birthday try, then points to the clinic", async () => {
    seedSiblings();
    const { verify } = await identifyAndVerify("5552013344");
    const wrong = await api("POST", "/api/claim/birthday", {
      claimToken: verify.json.claimToken,
      birthday: "2000-01-01",
    });
    expect(wrong.status).toBe(409);
    expect(wrong.json.error).toContain("contact your clinic");

    const retry = await api("POST", "/api/claim/birthday", {
      claimToken: verify.json.claimToken,
      birthday: "1990-05-02",
    });
    expect(retry.status).toBe(400);
    expect(retry.json.error).toContain("expired");
  });

  it("stops neutrally when two siblings share the same birthday", async () => {
    seedPatient({ name: "Twin One", date_of_birth: "2001-07-07" });
    seedPatient({ name: "Twin Two", date_of_birth: "2001-07-07" });
    const { verify } = await identifyAndVerify("5552013344");
    const res = await api("POST", "/api/claim/birthday", {
      claimToken: verify.json.claimToken,
      birthday: "2001-07-07",
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("contact your clinic");
  });

  it("blocks a sibling whose shared phone already secures another login", async () => {
    const { a } = seedSiblings();
    const flowA = await identifyAndVerify("5552013344");
    await api("POST", "/api/claim/birthday", {
      claimToken: flowA.verify.json.claimToken,
      birthday: "1990-05-02",
    });
    await api("POST", "/api/claim/complete", {
      claimToken: flowA.verify.json.claimToken,
      password: "FirstSib!Pass",
      passwordConfirm: "FirstSib!Pass",
    });
    expect(a.auth_user_id).toBeTruthy();

    const flowB = await identifyAndVerify("5552013344");
    await api("POST", "/api/claim/birthday", {
      claimToken: flowB.verify.json.claimToken,
      birthday: "1996-11-23",
    });
    const res = await api("POST", "/api/claim/complete", {
      claimToken: flowB.verify.json.claimToken,
      password: "SecondSib!Pass",
      passwordConfirm: "SecondSib!Pass",
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("email instead");
  });
});

describe("staff, providers, and the HQ admin", () => {
  it("claims a provider by email", async () => {
    const provider = {
      provider_id: "20002",
      provider_name: "Dr. Rivera",
      office_name: "Rivera Wellness",
      email: "rivera@clinic.example",
      access_disabled: false,
      auth_user_id: null,
      claimed_at: null,
    };
    backend.tables.providers.push(provider);
    const { verify } = await identifyAndVerify("rivera@clinic.example");
    expect(verify.json.accountType).toBe("provider");
    const complete = await api("POST", "/api/claim/complete", {
      claimToken: verify.json.claimToken,
      password: "Provider!Pass",
      passwordConfirm: "Provider!Pass",
    });
    expect(complete.status).toBe(200);
    expect(provider.auth_user_id).toBeTruthy();
    const user = backend.authUsers.get(String(provider.auth_user_id))!;
    expect(user.email).toBe("rivera@clinic.example");
    expect((user.user_metadata as Row).display_name).toBe("Dr. Rivera");
  });

  it("sends duplicate staff emails to the clinic instead of guessing", async () => {
    backend.tables.team_members.push(
      { id: crypto.randomUUID(), name: "Sam One", email: "dup@clinic.example", activation_status: "active", provider_id: "20002", auth_user_id: null },
      { id: crypto.randomUUID(), name: "Sam Two", email: "dup@clinic.example", activation_status: "active", provider_id: "20003", auth_user_id: null },
    );
    const { verify } = await identifyAndVerify("dup@clinic.example");
    expect(verify.status).toBe(409);
    expect(verify.json.error).toContain("contact your clinic");
  });

  it("routes the pre-approved HQ admin email to a password reset", async () => {
    const adminId = crypto.randomUUID();
    backend.authUsers.set(adminId, { id: adminId, email: "hq@thinnr.example", password: "unset" });
    backend.tables.staff_role_assignments.push({ email: "hq@thinnr.example", role: "hq_admin" });
    backend.tables.profiles.push({ id: adminId, email: "hq@thinnr.example", role: "hq_admin", display_name: "HQ Admin" });

    const { verify } = await identifyAndVerify("hq@thinnr.example");
    expect(verify.json.accountType).toBe("hq_admin");
    expect(verify.json.mode).toBe("reset");
    const complete = await api("POST", "/api/claim/complete", {
      claimToken: verify.json.claimToken,
      password: "Admin!Passphrase",
      passwordConfirm: "Admin!Passphrase",
    });
    expect(complete.status).toBe(200);
    expect(backend.authUsers.get(adminId)!.password).toBe("Admin!Passphrase");
    expect(backend.authUsers.size).toBe(1);
  });
});

describe("whoami and add-phone", () => {
  it("describes claimed patients, providers, and strangers", async () => {
    const authId = crypto.randomUUID();
    backend.authUsers.set(authId, { id: authId, phone: "+15552013344" });
    const patient = seedPatient({ auth_user_id: authId });
    const token = backend.addSession(authId);

    const who = await api("GET", "/api/claim/whoami", undefined, {
      Authorization: `Bearer ${token}`,
    });
    expect(who.status).toBe(200);
    expect(who.json.kind).toBe("patient");
    expect(who.json.patientId).toBe(String(patient.id));
    expect(who.json.hasPhone).toBe(true);
    expect(who.json.hasEmail).toBe(false);

    const provId = crypto.randomUUID();
    backend.authUsers.set(provId, { id: provId, email: "rivera@clinic.example" });
    backend.tables.providers.push({
      provider_id: "20002",
      provider_name: "Dr. Rivera",
      office_name: "Rivera Wellness",
      email: "rivera@clinic.example",
      access_disabled: false,
      auth_user_id: provId,
    });
    const provToken = backend.addSession(provId);
    const whoProv = await api("GET", "/api/claim/whoami", undefined, {
      Authorization: `Bearer ${provToken}`,
    });
    expect(whoProv.json.kind).toBe("provider");
    expect(whoProv.json.officeName).toBe("Rivera Wellness");

    const anon = await api("GET", "/api/claim/whoami", undefined, {
      Authorization: "Bearer session-not-real",
    });
    expect(anon.status).toBe(401);
  });

  it("lets an email-claimed patient add and verify a phone", async () => {
    const authId = crypto.randomUUID();
    backend.authUsers.set(authId, { id: authId, email: "casey@example.com", phone: null });
    seedPatient({ auth_user_id: authId, email: "casey@example.com", phone: null });
    const token = backend.addSession(authId);

    const start = await api(
      "POST",
      "/api/claim/add-phone",
      { phone: "555-777-8899" },
      { Authorization: `Bearer ${token}` },
    );
    expect(start.status).toBe(200);
    expect(start.json.devCode).toMatch(/^\d{6}$/);

    const done = await api(
      "POST",
      "/api/claim/add-phone/verify",
      { requestId: start.json.requestId, code: start.json.devCode },
      { Authorization: `Bearer ${token}` },
    );
    expect(done.status).toBe(200);
    expect(backend.authUsers.get(authId)!.phone).toBe("+15557778899");
  });

  it("refuses add-phone for accounts that already have one, non-patients, and taken numbers", async () => {
    const withPhone = crypto.randomUUID();
    backend.authUsers.set(withPhone, { id: withPhone, phone: "+15550001111" });
    seedPatient({ auth_user_id: withPhone, phone: "5550001111" });
    const resA = await api(
      "POST",
      "/api/claim/add-phone",
      { phone: "5557778899" },
      { Authorization: `Bearer ${backend.addSession(withPhone)}` },
    );
    expect(resA.status).toBe(409);

    const provId = crypto.randomUUID();
    backend.authUsers.set(provId, { id: provId, email: "prov@clinic.example" });
    backend.tables.providers.push({
      provider_id: "20009",
      email: "prov@clinic.example",
      access_disabled: false,
      auth_user_id: provId,
    });
    const resB = await api(
      "POST",
      "/api/claim/add-phone",
      { phone: "5557778899" },
      { Authorization: `Bearer ${backend.addSession(provId)}` },
    );
    expect(resB.status).toBe(403);

    const emailOnly = crypto.randomUUID();
    backend.authUsers.set(emailOnly, { id: emailOnly, email: "solo@example.com", phone: null });
    seedPatient({ auth_user_id: emailOnly, email: "solo@example.com", phone: null });
    const token = backend.addSession(emailOnly);
    const start = await api(
      "POST",
      "/api/claim/add-phone",
      { phone: "5550001111" }, // already on withPhone's login
      { Authorization: `Bearer ${token}` },
    );
    const done = await api(
      "POST",
      "/api/claim/add-phone/verify",
      { requestId: start.json.requestId, code: start.json.devCode },
      { Authorization: `Bearer ${token}` },
    );
    expect(done.status).toBe(409);
    expect(done.json.error).toContain("different login");
  });

  it("caps add-phone sends per destination and per account", async () => {
    const authId = crypto.randomUUID();
    backend.authUsers.set(authId, { id: authId, email: "capped@example.com", phone: null });
    seedPatient({ auth_user_id: authId, email: "capped@example.com", phone: null });
    const token = backend.addSession(authId);
    const send = (phone: string) =>
      api("POST", "/api/claim/add-phone", { phone }, { Authorization: `Bearer ${token}` });

    // Destination cap: 3 codes per number per hour, honest 429 after.
    for (let i = 0; i < 3; i += 1) expect((await send("5557778899")).status).toBe(200);
    const fourthSame = await send("5557778899");
    expect(fourthSame.status).toBe(429);

    // Account scope cap: rotating numbers stops at 6 total sends.
    expect((await send("5557778801")).status).toBe(200);
    expect((await send("5557778802")).status).toBe(200);
    expect((await send("5557778803")).status).toBe(200);
    const seventh = await send("5557778804");
    expect(seventh.status).toBe(429);
    expect(seventh.json.error).toContain("wait an hour");
  });
});

describe("live delivery mode", () => {
  it("fails loudly when flipped live without credentials", async () => {
    process.env.CLAIM_DELIVERY_MODE = "live";
    seedPatient();
    const sms = await api("POST", "/api/claim/identify", { identifier: "5552013344" });
    expect(sms.status).toBe(503);
    expect(sms.json.error).toContain("Twilio");
    const email = await api("POST", "/api/claim/identify", { identifier: "any@example.com" });
    expect(email.status).toBe(503);
    expect(email.json.error).toContain("Resend");
  });

  it("uses Twilio Verify for SMS when configured", async () => {
    process.env.CLAIM_DELIVERY_MODE = "live";
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "secret";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest";
    seedPatient();
    const identify = await api("POST", "/api/claim/identify", { identifier: "5552013344" });
    expect(identify.status).toBe(200);
    expect(identify.json.devCode).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20)); // fire-and-forget send
    expect(backend.twilioStarts).toEqual(["+15552013344"]);

    backend.twilioApprovedCode = "424242";
    const wrong = await api("POST", "/api/claim/verify", {
      requestId: identify.json.requestId,
      code: "111111",
    });
    expect(wrong.status).toBe(400);
    const right = await api("POST", "/api/claim/verify", {
      requestId: identify.json.requestId,
      code: "424242",
    });
    expect(right.status).toBe(200);
    expect(right.json.next).toBe("password");
  });

  it("emails through Resend and stays neutral even when the send fails", async () => {
    process.env.CLAIM_DELIVERY_MODE = "live";
    process.env.RESEND_API_KEY = "re_test";
    process.env.CLAIM_EMAIL_FROM = "THINNR <no-reply@thinnr.example>";
    seedPatient({ email: "casey@example.com", phone: null });

    const ok = await api("POST", "/api/claim/identify", { identifier: "casey@example.com" });
    expect(ok.status).toBe(200);
    expect(ok.json.devCode).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backend.sentEmails).toHaveLength(1);
    expect(backend.sentEmails[0].to).toBe("casey@example.com");
    const code = backend.sentEmails[0].code!;
    const verify = await api("POST", "/api/claim/verify", {
      requestId: ok.json.requestId,
      code,
    });
    expect(verify.status).toBe(200);

    backend.failEmailSend = true;
    const failed = await api("POST", "/api/claim/identify", { identifier: "casey@example.com" });
    expect(failed.status).toBe(200); // delivery failure never becomes an oracle
    expect(failed.json.message).toContain("If those details match");
  });
});
