/**
 * Same-phone re-signup after account closure, end to end through the real
 * routes: request closure -> drain at grace end -> sign up again with the
 * same phone -> whoami resolves a NEW patient id -> /patient-data/state is
 * empty -> the sealed chart is still on the office roster under Archived.
 *
 * One in-memory Supabase/GoTrue fake answers every route. Its RPCs mirror the
 * SQL in supabase/migrations/20261108000000_account_closure.sql (pending past
 * grace -> closing; closure deletes the PERSONAL families and seals the
 * patients row by nulling auth_user_id/email/phone and stamping
 * closed_at = archived_at) and the partial unique indexes on patients
 * (unique phone/email among archived_at IS NULL rows only). The closure worker
 * itself (drainDuePurges/runClosure) is the production code with its default
 * dependencies; the fake simply has no Stripe rows or media to touch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { CONSENT_POLICY_VERSION } from "../privacy/consent";

const FAKE_SUPABASE = "http://fake.supabase.local";
const SIGNUP_OFFICE_ID = "live-4b9d2f6c1a8e4703b5d6902c3e1f7a84";
const OFFICE_CODE = "654321";
const PHONE = "813-555-0101";
const E164 = "+18135550101";
const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;
type Filter = [string, string, string];

/** Tables the routes and the closure RPC touch. Unknown tables answer 404 so a new read fails loudly. */
const TABLES = [
  "patients", "providers", "team_members", "hq_memberships", "profiles", "provider_account_locks",
  "staff_role_assignments", "claim_verifications", "auth_sign_ins", "account_security_state",
  "hq_organization_settings", "patient_deletion_requests", "patient_tombstones",
  "patient_operational_follow_ups", "patient_consents", "patient_data_exports",
  "patient_diary_entries", "patient_water_days", "patient_target_overrides", "patient_food_prefs",
  "patient_custom_foods", "patient_saved_recipes", "patient_media", "patient_progress_photos",
  "patient_check_ins", "patient_flags", "patient_medications", "patient_medication_dose_logs",
  "patient_write_receipts", "patient_chat_conversations", "patient_staff_weights",
  "billing_subscriptions", "billing_payers", "billing_connected_accounts", "legal_holds",
  "practice_launch",
];

/** The personal families the closure RPC deletes (subset that exists in this fake). */
const PERSONAL_TABLES = [
  "patient_diary_entries", "patient_water_days", "patient_target_overrides", "patient_food_prefs",
  "patient_custom_foods", "patient_saved_recipes", "patient_consents", "patient_data_exports",
  "patient_write_receipts", "patient_flags",
];

function digits10(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "").slice(-10);
}

class FakeBackend {
  tables: Record<string, Row[]> = {};
  authUsers = new Map<string, Row>();
  /** access token -> auth user id (the client<->GoTrue token exchange is out of scope). */
  tokens = new Map<string, string>();
  /** Fake database clock; the test advances it past the grace window. */
  clock = new Date("2026-09-01T12:00:00.000Z");
  audits: Row[] = [];
  revokedUsers: string[] = [];
  deletedUsers: string[] = [];

  reset() {
    this.tables = Object.fromEntries(TABLES.map((name) => [name, []]));
    this.tables.hq_organization_settings = [
      { singleton: true, second_factor_hq_users: false, second_factor_office_managers: false, second_factor_all_staff: false },
    ];
    this.authUsers.clear();
    this.tokens.clear();
    this.clock = new Date("2026-09-01T12:00:00.000Z");
    this.audits = [];
    this.revokedUsers = [];
    this.deletedUsers = [];
  }

  now(): string {
    return this.clock.toISOString();
  }

  advance(ms: number) {
    this.clock = new Date(this.clock.getTime() + ms);
  }

  /** Auth user for a phone (the account signup/complete just created). */
  authUserByPhone(phone: string): Row | undefined {
    return [...this.authUsers.values()].find((user) => user.phone === phone);
  }

  // ── PostgREST filter model ───────────────────────────────────────────────

  private cell(row: Row, col: string): unknown {
    const dot = col.indexOf(".");
    if (dot < 0) return row[col];
    // Embedded filter such as `patients.provider_id` on a patient-owned table.
    const [embed, field] = [col.slice(0, dot), col.slice(dot + 1)];
    if (embed === "patients") {
      const patient = this.tables.patients.find((p) => p.id === row.patient_id);
      return patient?.[field];
    }
    throw new Error(`fake: unsupported embed filter ${col}`);
  }

  private matches(row: Row, [col, op, value]: Filter): boolean {
    const cell = this.cell(row, col);
    if (op === "eq") return String(cell ?? "") === value;
    if (op === "neq") return String(cell ?? "") !== value;
    if (op === "ilike") return String(cell ?? "").toLowerCase() === value.toLowerCase().replace(/%/g, "");
    if (op === "is") {
      if (value === "null") return cell == null;
      if (value === "true") return cell === true;
      if (value === "false") return cell === false;
    }
    if (op === "not" && value === "is.null") return cell != null;
    if (op === "gt") return typeof cell === "string" && cell > value;
    if (op === "gte") return typeof cell === "string" && cell >= value;
    if (op === "lt") return typeof cell === "string" && cell < value;
    if (op === "lte") return typeof cell === "string" && cell <= value;
    if (op === "in") {
      const list = value.replace(/^\(|\)$/g, "").split(",").map((item) => item.replace(/^"|"$/g, ""));
      return list.includes(String(cell ?? ""));
    }
    throw new Error(`fake: unsupported op ${op} on ${col}`);
  }

  private parse(url: URL): { filters: Filter[]; orGroups: Filter[][] } {
    const filters: Filter[] = [];
    const orGroups: Filter[][] = [];
    url.searchParams.forEach((raw, key) => {
      if (["select", "order", "limit", "on_conflict"].includes(key)) return;
      if (key === "or") {
        const inner = raw.replace(/^\(|\)$/g, "");
        orGroups.push(inner.split(",").map((clause) => {
          const [col, op, ...rest] = clause.split(".");
          return [col, op, rest.join(".")] as Filter;
        }));
        return;
      }
      const dot = raw.indexOf(".");
      filters.push([key, raw.slice(0, dot), raw.slice(dot + 1)]);
    });
    return { filters, orGroups };
  }

  private select(table: string, url: URL): Row[] {
    const { filters, orGroups } = this.parse(url);
    let rows = this.tables[table].filter(
      (row) => filters.every((f) => this.matches(row, f)) && orGroups.every((g) => g.some((f) => this.matches(row, f))),
    );
    const order = url.searchParams.get("order");
    if (order) {
      const keys = order.split(",").map((part) => part.split("."));
      rows = [...rows].sort((a, b) => {
        for (const [key, dir] of keys) {
          const av = String(a[key] ?? "");
          const bv = String(b[key] ?? "");
          if (av !== bv) return (av < bv ? -1 : 1) * (dir === "desc" ? -1 : 1);
        }
        return 0;
      });
    }
    const limit = url.searchParams.get("limit");
    return limit ? rows.slice(0, Number(limit)) : rows;
  }

  // ── GoTrue ───────────────────────────────────────────────────────────────

  private auth(method: string, url: URL, body: Row | null, headers: Headers): Response {
    if (url.pathname === "/auth/v1/user") {
      const token = (headers.get("authorization") ?? "").replace(/^Bearer /i, "");
      const userId = this.tokens.get(token);
      if (!userId || !this.authUsers.has(userId)) return json(401, { message: "invalid token" });
      return json(200, { id: userId, email: null, phone: null });
    }
    if (method === "POST" && url.pathname === "/auth/v1/admin/users") {
      const email = body?.email ? String(body.email).toLowerCase() : null;
      const phone = body?.phone ? String(body.phone) : null;
      for (const user of this.authUsers.values()) {
        if (email && String(user.email ?? "").toLowerCase() === email) {
          return json(422, { error_code: "email_exists", msg: "A user with this email address has already been registered" });
        }
        if (phone && user.phone === phone) {
          return json(422, { error_code: "phone_exists", msg: "Phone number already registered by another user" });
        }
      }
      const user = { id: crypto.randomUUID(), email, phone, app_metadata: body?.app_metadata ?? {}, user_metadata: body?.user_metadata ?? {} };
      this.authUsers.set(user.id, user);
      return json(200, user);
    }
    if (method === "POST" && url.pathname === "/auth/v1/admin/generate_link") {
      const email = String(body?.email ?? "").toLowerCase();
      const user = [...this.authUsers.values()].find((u) => String(u.email ?? "").toLowerCase() === email);
      if (!user) return json(404, { msg: "User not found" });
      return json(200, { hashed_token: `hashed-${email}`, properties: { hashed_token: `hashed-${email}` } });
    }
    const idMatch = url.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
    if (idMatch) {
      const user = this.authUsers.get(idMatch[1]);
      if (!user) return json(404, { msg: "User not found" });
      if (method === "GET") return json(200, user);
      if (method === "PUT") {
        Object.assign(user, body);
        return json(200, user);
      }
      if (method === "DELETE") {
        this.authUsers.delete(idMatch[1]);
        this.deletedUsers.push(idMatch[1]);
        return json(200, {});
      }
    }
    return json(404, { msg: `fake: no auth route ${method} ${url.pathname}` });
  }

  // ── RPCs (mirroring the SQL functions) ──────────────────────────────────

  private rpc(name: string, p: Row): Response {
    switch (name) {
      case "claim_register_send": {
        const row: Row = {
          id: crypto.randomUUID(), created_at: this.now(), code_attempts: 0, birthday_checked: false,
          resolved_ref: null, verified_at: null, claim_token_hash: null, consumed_at: null,
          purpose: p.p_purpose, identifier_kind: p.p_identifier_kind, identifier: p.p_identifier,
          account_type: p.p_account_type, candidates: p.p_candidates, delivery: p.p_delivery,
          code_salt: p.p_code_salt, code_hash: p.p_code_hash, code_expires_at: p.p_code_expires_at,
          auth_user_id: p.p_auth_user_id, scope_key: p.p_scope_key,
        };
        this.tables.claim_verifications.push(row);
        return json(200, [row]);
      }
      case "claim_find_candidates": {
        // Patients only; sealed (archived) rows never match — exactly the SQL.
        const kind = String(p.p_kind);
        const value = String(p.p_value);
        const out = this.tables.patients
          .filter((pa) => pa.archived_at == null && pa.activation_status !== "disabled")
          .filter((pa) => kind === "email"
            ? pa.email != null && String(pa.email).toLowerCase() === value.toLowerCase()
            : pa.phone != null && digits10(pa.phone) === digits10(value) && String(pa.phone).replace(/\D/g, "").length >= 10)
          .map((pa) => ({
            type: "patient", ref: String(pa.id), name: pa.name ?? null, email: pa.email ?? null, phone: pa.phone ?? null,
            dob: pa.date_of_birth ?? null, claimed: Boolean(pa.auth_user_id), auth_user_id: pa.auth_user_id ?? null,
          }));
        return json(200, out);
      }
      case "patient_deletion_request": {
        const patient = this.tables.patients.find((pa) => pa.id === p.p_patient_id && pa.archived_at == null);
        if (!patient) return json(400, { message: "unknown patient" });
        let request = this.tables.patient_deletion_requests.find(
          (r) => r.patient_id === patient.id && ["pending", "held", "closing", "closed", "purging", "failed"].includes(String(r.status)),
        );
        if (!request) {
          const grace = Math.max(0, Number(p.p_grace_seconds ?? 604_800));
          request = {
            id: crypto.randomUUID(), patient_id: patient.id, provider_id: patient.provider_id, auth_user_id: patient.auth_user_id,
            requested_at: this.now(), purge_after: new Date(this.clock.getTime() + grace * 1000).toISOString(),
            status: "pending", held_at: null, cancelled_at: null, started_at: null, purged_at: null, attempts: 0,
            next_attempt_at: null, lease_owner: null, lease_until: null, closed_at: null, retain_until: null,
            last_error: null, steps: {},
          };
          this.tables.patient_deletion_requests.push(request);
        }
        patient.deletion_requested_at ??= this.now();
        return json(200, [request]);
      }
      case "claim_due_patient_deletions": {
        if (!p.p_owner) return json(400, { message: "lease owner is required" });
        const now = this.now();
        const due = this.tables.patient_deletion_requests
          .filter((r) =>
            (r.status === "pending" && String(r.purge_after) <= now) ||
            (r.status === "closed" && r.retain_until != null && String(r.retain_until) <= now) ||
            (r.status === "failed" && r.next_attempt_at != null && String(r.next_attempt_at) <= now) ||
            ((r.status === "closing" || r.status === "purging") && (r.lease_until == null || String(r.lease_until) < now)))
          .filter((r) => !this.tables.legal_holds.some((h) => h.patient_id === r.patient_id && h.lifted_at == null))
          .sort((a, b) => String(a.closed_at == null ? a.purge_after : a.retain_until).localeCompare(String(b.closed_at == null ? b.purge_after : b.retain_until)))
          .slice(0, Math.max(1, Math.min(Number(p.p_limit ?? 5), 50)));
        for (const r of due) {
          r.status = r.closed_at == null ? "closing" : "purging";
          r.started_at ??= now;
          r.attempts = Number(r.attempts) + 1;
          r.lease_owner = p.p_owner;
          r.lease_until = new Date(this.clock.getTime() + Math.max(30, Number(p.p_lease_seconds ?? 600)) * 1000).toISOString();
        }
        return json(200, due.map((r) => ({ ...r })));
      }
      case "patient_close_rows": {
        const request = this.tables.patient_deletion_requests.find((r) => r.id === p.p_request_id);
        if (!request) return json(400, { message: "unknown deletion request" });
        if (request.status !== "closing") return json(400, { message: "deletion request is not being closed" });
        const patient = this.tables.patients.find((pa) => pa.id === request.patient_id);
        if (!patient) return json(400, { message: "unknown patient" });
        const alreadyClosed = patient.closed_at != null;
        const closedAt = alreadyClosed ? String(patient.closed_at) : this.now();
        const retainUntil = alreadyClosed
          ? String(patient.record_retain_until)
          : new Date(new Date(closedAt).getTime() + 7 * 365 * DAY_MS).toISOString();
        const tables: Record<string, number> = {};
        if (!alreadyClosed) {
          const owned = (row: Row) => row.patient_id === patient.id;
          const drop = (table: string, keep: (row: Row) => boolean) => {
            const before = this.tables[table].length;
            this.tables[table] = this.tables[table].filter(keep);
            tables[table] = before - this.tables[table].length;
          };
          drop("patient_chat_conversations", (row) => !owned(row));
          drop("patient_media", (row) => !(owned(row) && ["food", "recipe", "chat"].includes(String(row.kind))));
          for (const table of PERSONAL_TABLES) drop(table, (row) => !owned(row));
          drop("auth_sign_ins", (row) => !(row.user_id === patient.auth_user_id && row.realm === "patient"));
          drop("account_security_state", (row) => row.user_id !== patient.auth_user_id);
          Object.assign(patient, {
            closed_at: closedAt, archived_at: closedAt, record_retain_until: retainUntil,
            auth_user_id: null, email: null, phone: null, deletion_requested_at: null, archived_into_patient_id: null,
          });
        }
        request.closed_at = closedAt;
        request.retain_until = retainUntil;
        return json(200, { tables, mediaPaths: [], authUserId: request.auth_user_id, closedAt, retainUntil, alreadyClosed });
      }
      case "patient_deletion_finish": {
        const status = String(p.p_status);
        if (!["closed", "purged", "failed"].includes(status)) return json(400, { message: "invalid finish status" });
        const request = this.tables.patient_deletion_requests.find(
          (r) => r.id === p.p_request_id && (r.status === "closing" || r.status === "purging"),
        );
        if (!request) return json(200, []);
        Object.assign(request, {
          status,
          purge_after: status === "closed" ? request.retain_until : request.purge_after,
          purged_at: status === "purged" ? this.now() : request.purged_at,
          last_error: status === "failed" ? String(p.p_error ?? "").slice(0, 400) : null,
          next_attempt_at: status === "failed" && p.p_retry_after_seconds != null
            ? new Date(this.clock.getTime() + Math.max(0, Number(p.p_retry_after_seconds)) * 1000).toISOString()
            : null,
          lease_owner: null, lease_until: null, steps: p.p_steps ?? {},
        });
        return json(200, [request]);
      }
      case "security_revoke_auth_sessions":
        this.revokedUsers.push(String(p.p_user_id));
        return json(200, 0);
      case "record_admin_audit_event":
        this.audits.push(p);
        return json(204, null);
      case "record_admin_audit_read_event":
        return json(200, [{ recorded: true, window_started_at: this.now() }]);
      case "provider_patient_activity_summary":
        return json(200, this.tables.patients
          .filter((pa) => pa.provider_id === p.p_provider_id && pa.archived_at == null)
          .map((pa) => ({
            patient_id: pa.id, latest_activity_date: null, latest_diary_date: null, latest_water_date: null,
            latest_check_in_date: null, latest_weight_date: null, latest_photo_date: null, logged_days_7: 0, check_ins_7: 0,
          })));
      case "provider_outreach_states":
      case "billing_office_patient_spend":
        return json(200, []);
      case "patient_app_presence_touch":
        return json(200, null);
      case "patient_app_event_record":
        return json(200, 1);
      default:
        return json(404, { message: `fake: no rpc ${name}` });
    }
  }

  // ── Dispatcher ───────────────────────────────────────────────────────────

  handle(href: string, init?: RequestInit): Response {
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
    const body = init?.body ? (JSON.parse(String(init.body)) as Row | Row[]) : null;

    if (url.pathname.startsWith("/auth/v1/")) return this.auth(method, url, Array.isArray(body) ? null : body, headers);

    const rpcMatch = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (rpcMatch) return this.rpc(rpcMatch[1], (Array.isArray(body) ? {} : body) ?? {});

    const tableMatch = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!tableMatch) return json(404, { message: `fake: no route ${url.pathname}` });
    const table = tableMatch[1];
    if (!(table in this.tables)) return json(404, { message: `fake: no table ${table}` });

    if (method === "GET") return json(200, this.select(table, url));

    if (method === "POST") {
      const payload = Array.isArray(body) ? body : body ? [body] : [];
      const conflictCols = (url.searchParams.get("on_conflict") ?? "").split(",").filter(Boolean);
      const prefer = headers.get("prefer") ?? "";
      const written: Row[] = [];
      for (const incoming of payload) {
        const existing = conflictCols.length
          ? this.tables[table].find((row) => conflictCols.every((col) => String(row[col] ?? "") === String(incoming[col] ?? "")))
          : undefined;
        if (existing && prefer.includes("resolution=ignore-duplicates")) continue;
        if (existing) {
          Object.assign(existing, incoming);
          written.push(existing);
          continue;
        }
        if (table === "patients") {
          // The PARTIAL unique indexes: live (archived_at IS NULL) rows only.
          const live = this.tables.patients.filter((pa) => pa.archived_at == null);
          const email = String(incoming.email ?? "").toLowerCase();
          if (email && live.some((pa) => String(pa.email ?? "").toLowerCase() === email)) {
            return json(409, { message: 'duplicate key value violates unique constraint "patients_email_normalized_unique_idx"' });
          }
          const phone = digits10(incoming.phone);
          if (phone.length === 10 && live.some((pa) => digits10(pa.phone) === phone)) {
            return json(409, { message: 'duplicate key value violates unique constraint "patients_phone_normalized_unique_idx"' });
          }
        }
        const row: Row = { id: crypto.randomUUID(), created_at: this.now(), ...incoming };
        this.tables[table].push(row);
        written.push(row);
      }
      return json(201, written);
    }

    if (method === "PATCH") {
      const matched = this.select(table, url);
      for (const row of matched) Object.assign(row, body);
      return json(200, matched);
    }

    if (method === "DELETE") {
      const doomed = new Set(this.select(table, url));
      this.tables[table] = this.tables[table].filter((row) => !doomed.has(row));
      return new Response(null, { status: 204 });
    }
    return json(405, { message: `fake: unsupported ${method}` });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(body === null && status === 204 ? null : JSON.stringify(body), {
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
  options: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: any }> {
  const response = await realFetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

/** Full signup rail for one phone; returns a bearer for the new account. */
async function signUp(input: { phone: string; name: string; email: string; token: string }): Promise<{ status: number; json: any }> {
  const start = await api("POST", "/api/auth/signup/start", { body: { code: OFFICE_CODE, phone: input.phone } });
  expect(start.status).toBe(200);
  const verify = await api("POST", "/api/auth/signup/verify", {
    body: { requestId: start.json.requestId, code: start.json.devCode },
  });
  expect(verify.status).toBe(200);
  expect(verify.json.mode).toBe("enroll");
  const complete = await api("POST", "/api/auth/signup/complete", {
    body: { signupToken: verify.json.signupToken, password: "Strong!Pass1", name: input.name, email: input.email },
  });
  if (complete.status === 200) {
    const user = backend.authUserByPhone(E164);
    expect(user).toBeDefined();
    backend.tokens.set(input.token, String(user!.id));
  }
  return complete;
}

async function recordConsent(token: string) {
  const res = await api("PUT", "/api/patient-data/consent", {
    token,
    body: { policyVersion: CONSENT_POLICY_VERSION, terms: true, privacy: true, healthData: true, photoAnalysis: true, platform: "ios" },
  });
  expect(res.status).toBeLessThan(300);
}

function seedOffice() {
  backend.tables.providers.push({
    provider_id: SIGNUP_OFFICE_ID, provider_name: "Dr. Bayshore", office_name: "Bayshore Slim Clinic",
    email: "bayshore@clinic.example", onboarding_code: OFFICE_CODE, access_disabled: false,
    auth_user_id: "provider-user", claimed_at: "2026-01-01T00:00:00Z", offboarding_status: null,
  });
  // The office-scope resolver consults practice setup; this synthetic office
  // has its gate waived, like any demonstration account.
  backend.tables.practice_launch.push({
    provider_id: SIGNUP_OFFICE_ID, required: false, version: 0, details_confirmed: false, products_confirmed: false,
    completed_at: null, setup_override_at: "2026-01-01T00:00:00Z",
  });
  backend.authUsers.set("provider-user", { id: "provider-user", email: "bayshore@clinic.example", phone: null });
  backend.tokens.set("provider-token", "provider-user");
}

beforeAll(async () => {
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  process.env.CLAIM_DELIVERY_MODE = "dev";
  process.env.CLAIM_EMAIL_DELIVERY_MODE = "dev";
  process.env.CLAIM_SMS_DELIVERY_MODE = "dev";
  process.env.CLAIM_IDENTIFY_FLOOR_MS = "0";
  for (const knob of ["SEND", "CHECK", "OFFICE", "FINISH"]) {
    process.env[`AUTH_${knob}_BURST`] = "100000";
    process.env[`AUTH_${knob}_DAILY_BUDGET`] = "100000";
  }
  for (const knob of ["READ", "WRITE"]) {
    process.env[`PATIENT_DATA_${knob}_BURST`] = "100000";
    process.env[`PATIENT_DATA_${knob}_DAILY_BUDGET`] = "100000";
  }
  delete process.env.PATIENT_DELETION_GRACE_SECONDS;
  delete process.env.PATIENT_DELETION_GRACE_DAYS;

  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(href).hostname === "fake.supabase.local") return Promise.resolve(backend.handle(href, init));
    return realFetch(input as string, init);
  });

  const [auth, claim, privacy, data, roster] = await Promise.all([
    import("./auth"), import("./claim"), import("./patient-privacy"), import("./patient-data"), import("./office-roster"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: (obj: { err?: Error }, msg: string) => routeErrors.push(`${msg}: ${obj?.err?.message ?? String(obj)}`),
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use("/api", auth.default);
  app.use("/api", claim.default);
  app.use("/api", privacy.default);
  app.use("/api", data.default);
  app.use("/api", roster.default);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  backend.reset();
  routeErrors.length = 0;
  seedOffice();
});

describe("account closure followed by same-phone re-signup", () => {
  it("gives the returning patient a fresh, empty account while the office keeps the sealed chart", async () => {
    const { drainDuePurges, deletionGraceSeconds } = await import("../privacy/purge");

    // 1. First life: sign up, consent, and put some personal data on the chart.
    const first = await signUp({ phone: PHONE, name: "Riley Newcomer", email: "riley@example.com", token: "riley-first" });
    expect(first.status).toBe(200);
    const firstWhoami = await api("GET", "/api/claim/whoami", { token: "riley-first" });
    expect(firstWhoami.status).toBe(200);
    expect(firstWhoami.json.kind).toBe("patient");
    const sealedId = String(firstWhoami.json.patientId);
    await recordConsent("riley-first");
    backend.tables.patient_diary_entries.push({
      id: crypto.randomUUID(), patient_id: sealedId, date_key: "2026-09-01", meal: "breakfast", food_id: "eggs",
      name: "Eggs", quantity: 2, calories: 140, protein: 12, carbs: 1, fat: 10, logged_at: backend.now(),
    });
    backend.tables.patient_water_days.push({ id: crypto.randomUUID(), patient_id: sealedId, date_key: "2026-09-01", oz: 40 });
    backend.tables.patient_flags.push({ id: crypto.randomUUID(), patient_id: sealedId, onboarding_complete: true });
    // A staff-recorded weight is clinical: it must survive closure with the chart.
    backend.tables.patient_staff_weights.push({ id: crypto.randomUUID(), patient_id: sealedId, provider_id: SIGNUP_OFFICE_ID, weight: 201.5 });

    // 2. The patient asks to close the account.
    const requested = await api("POST", "/api/patient-data/deletion", { token: "riley-first", body: { confirm: "DELETE" } });
    expect(requested.status).toBe(202);
    expect(requested.json.deletion.status).toBe("pending");
    const rosterPending = await api("GET", "/api/office/roster", { token: "provider-token" });
    expect(rosterPending.status).toBe(200);
    expect(rosterPending.json.patients.map((p: any) => p.id)).toEqual([sealedId]);
    expect(rosterPending.json.patients[0].deletion).not.toBeNull();
    expect(rosterPending.json.summary.deletionRequested).toBe(1);

    // 3. Inside the grace window nothing is due: the account is untouched.
    backend.advance(deletionGraceSeconds() * 1000 - 60_000);
    expect(await drainDuePurges(5)).toBe(0);
    expect((await api("GET", "/api/claim/whoami", { token: "riley-first" })).json.patientId).toBe(sealedId);

    // 4. Grace end: the worker claims the request and seals the chart.
    backend.advance(120_000);
    expect(await drainDuePurges(5)).toBe(1);
    expect(routeErrors).toEqual([]);
    const request = backend.tables.patient_deletion_requests[0];
    expect(request.status).toBe("closed");
    expect(request.closed_at).toBeTruthy();
    const sealedRow = backend.tables.patients.find((p) => p.id === sealedId)!;
    expect(sealedRow.archived_at).toBe(sealedRow.closed_at);
    expect(sealedRow.auth_user_id).toBeNull();
    expect(sealedRow.phone).toBeNull();
    expect(backend.deletedUsers).toHaveLength(1);
    expect(backend.revokedUsers).toEqual(backend.deletedUsers);
    expect(backend.tables.patient_diary_entries).toEqual([]);
    expect(backend.tables.patient_water_days).toEqual([]);
    expect(backend.tables.patient_consents).toEqual([]);
    expect(backend.tables.patient_staff_weights).toHaveLength(1);
    expect(backend.audits.map((a) => a.p_action ?? a.action)).toContain("patient_account_closed");

    // The old session is dead: its auth user is gone, so every patient route is a 401.
    expect((await api("GET", "/api/claim/whoami", { token: "riley-first" })).status).toBe(401);
    expect((await api("GET", "/api/patient-data/state?today=2026-09-08", { token: "riley-first" })).status).toBe(401);

    // 5. Same phone, same email, brand-new signup: neither pre-check sees the sealed chart.
    const second = await signUp({ phone: PHONE, name: "Riley Newcomer", email: "riley@example.com", token: "riley-second" });
    expect(second.status).toBe(200);
    expect(second.json.ok).toBe(true);

    const secondWhoami = await api("GET", "/api/claim/whoami", { token: "riley-second" });
    expect(secondWhoami.status).toBe(200);
    expect(secondWhoami.json.kind).toBe("patient");
    const freshId = String(secondWhoami.json.patientId);
    expect(freshId).not.toBe(sealedId);
    expect(secondWhoami.json.hasPhone).toBe(true);
    expect(secondWhoami.json.providerId).toBe(SIGNUP_OFFICE_ID);
    expect(backend.tables.patients).toHaveLength(2);

    // 6. The new account starts empty — no diary, water, flags, consent, or deletion carried over.
    await recordConsent("riley-second");
    const today = backend.now().slice(0, 10);
    const state = await api("GET", `/api/patient-data/state?from=2026-08-01&to=${today}&today=${today}`, { token: "riley-second" });
    expect(state.status).toBe(200);
    expect(state.json).toMatchObject({
      entries: [], water: {}, targets: {}, favorites: [], recents: [], customFoods: [], catalogFoods: [],
      savedRecipes: [], photos: [], checkIns: [], medications: [], doseLogs: [],
      flags: { nudgeOptOut: false, nudgeEngaged: false, nudgeLastSentKey: null, nudgeLastCrossingKey: null, onboardingComplete: false },
      entry: { firstName: "Riley", programDay: 1, todayKey: today },
      privacy: { export: null, deletion: null, consent: { satisfied: true } },
    });
    expect(routeErrors).toEqual([]);

    // 7. The office: the default roster shows only the new account; Archived adds the sealed chart.
    const roster = await api("GET", "/api/office/roster", { token: "provider-token" });
    expect(roster.status).toBe(200);
    expect(roster.json.patients.map((p: any) => p.id)).toEqual([freshId]);
    expect(roster.json.patients[0].closure).toBeNull();
    expect(roster.json.patients[0].deletion).toBeNull();
    expect(roster.json.summary).toMatchObject({ totalPatients: 1, archived: 1, deletionRequested: 0, deletedAccounts: 0 });

    const archived = await api("GET", "/api/office/roster?include=archived", { token: "provider-token" });
    expect(archived.status).toBe(200);
    const byId = new Map<string, any>(archived.json.patients.map((p: any) => [p.id, p]));
    expect([...byId.keys()].sort()).toEqual([freshId, sealedId].sort());
    expect(byId.get(sealedId).closure).toEqual({
      closedAt: sealedRow.closed_at,
      recordRetainUntil: sealedRow.record_retain_until,
    });
    expect(byId.get(sealedId).phone).toBeNull();
    expect(byId.get(sealedId).email).toBeNull();
    expect(byId.get(freshId).closure).toBeNull();
    // Sealed charts are listed, never counted as live patients.
    expect(archived.json.summary).toMatchObject({ totalPatients: 1, archived: 1 });
    expect(routeErrors).toEqual([]);
  });

  it("keeps one account on a phone whose first account is only pending closure", async () => {
    const first = await signUp({ phone: PHONE, name: "Riley Newcomer", email: "riley@example.com", token: "riley-first" });
    expect(first.status).toBe(200);
    const sealedId = String((await api("GET", "/api/claim/whoami", { token: "riley-first" })).json.patientId);
    const requested = await api("POST", "/api/patient-data/deletion", { token: "riley-first", body: { confirm: "DELETE" } });
    expect(requested.status).toBe(202);
    const usersBefore = backend.authUsers.size;

    // Before grace end the chart is still live: the signup rail resolves the
    // verified phone to the EXISTING chart (a password reset), never a new row.
    const start = await api("POST", "/api/auth/signup/start", { body: { code: OFFICE_CODE, phone: PHONE } });
    expect(start.status).toBe(200);
    const verify = await api("POST", "/api/auth/signup/verify", { body: { requestId: start.json.requestId, code: start.json.devCode } });
    expect(verify.status).toBe(200);
    const complete = await api("POST", "/api/auth/signup/complete", {
      body: { signupToken: verify.json.signupToken, password: "Another!Pass1", name: "Riley Newcomer", email: "riley@example.com" },
    });
    expect(complete.status).toBe(200);
    expect(backend.tables.patients).toHaveLength(1);
    expect(backend.authUsers.size).toBe(usersBefore);
    expect((await api("GET", "/api/claim/whoami", { token: "riley-first" })).json.patientId).toBe(sealedId);
    expect(routeErrors).toEqual([]);
  });
});
