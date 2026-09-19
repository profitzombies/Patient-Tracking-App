/**
 * Patient-data routes suite — the live per-patient diary rail.
 *
 * Runs against an in-memory fake of the Supabase REST + GoTrue surfaces so
 * the auth ladder (401/403/503), the client-shape mapping, PostgREST merge
 * semantics (partial target merges, created_at preservation), delete
 * scoping, and cross-patient isolation can all be exercised
 * deterministically. The claim/auth suites own the session mechanics; this
 * file focuses on what the diary rail adds on top.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_POLICY_VERSION } from "../privacy/consent";
import { PENDING_TTL_MS } from "../lib/idempotency";
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

const FAKE_SUPABASE = "http://fake.supabase.local";

type Row = Record<string, unknown>;

/** Lexicographically sortable fake created_at stamps. */
function stampAt(seq: number): string {
  return `2026-08-01T00:00:${String(seq).padStart(2, "0")}.000Z`;
}

class FakeBackend {
  tables: Record<string, Row[]> = {};
  /** access token → auth user id */
  tokens = new Map<string, string>();
  authOutage = false;
  /** one-shot 500s keyed `${method} ${table}` (or `RPC patient_diary_apply`) */
  failOnce = new Set<string>();
  /** Number of atomic patient_diary_apply RPC calls received. */
  rpcCalls = 0;
  /** Number of atomic patient_library_apply RPC calls received. */
  libraryRpcCalls = 0;
  /** Every record_patient_edit_history RPC body, in order (patient-made edits to shared families). */
  historyWrites: Row[] = [];
  /** Every patient_app_event_record RPC body, in order (HQ Insights seam). */
  eventCalls: Array<Record<string, unknown>> = [];
  private seq = 0;

  reset() {
    this.eventCalls = [];
    this.tables = {
      patients: [],
      patient_diary_entries: [],
      patient_water_days: [],
      patient_target_overrides: [],
      patient_food_prefs: [],
      patient_custom_foods: [],
      patient_saved_recipes: [],
      patient_media: [],
      patient_progress_photos: [],
      patient_check_ins: [],
      patient_health_measurements: [],
      patient_medications: [],
      patient_medication_dose_logs: [],
      patient_flags: [],
      patient_consents: [],
      patient_data_exports: [],
      patient_deletion_requests: [],
      claim_verifications: [],
      patient_write_receipts: [],
    };
    this.tokens.clear();
    this.authOutage = false;
    this.failOnce.clear();
    this.rpcCalls = 0;
    this.historyWrites = [];
    this.libraryRpcCalls = 0;
    this.seq = 0;
  }

  seedPatient(overrides: Row = {}): Row {
    const row: Row = {
      id: crypto.randomUUID(),
      auth_user_id: null,
      name: "Casey Patient",
      ...overrides,
    };
    this.tables.patients.push(row);
    return row;
  }

  /**
   * Signed-in patient: auth user + token + linked patients row, with the
   * CURRENT consent policy on record (every data route enforces it).
   * `{ consent: false }` seeds a patient who has not consented yet.
   */
  seedSignedInPatient(token: string, options: { consent?: boolean } = {}): { patientId: string; userId: string } {
    const userId = crypto.randomUUID();
    this.tokens.set(token, userId);
    const patient = this.seedPatient({ auth_user_id: userId });
    if (options.consent !== false) this.seedConsent(String(patient.id));
    return { patientId: String(patient.id), userId };
  }

  seedConsent(patientId: string, overrides: Row = {}): Row {
    const row: Row = {
      id: crypto.randomUUID(),
      patient_id: patientId,
      policy_version: CONSENT_POLICY_VERSION,
      terms_accepted: true,
      privacy_accepted: true,
      health_data_accepted: true,
      photo_analysis_accepted: true,
      app_version: "1.0.0",
      platform: "ios",
      recorded_at: "2026-09-01T00:00:00Z",
      ...overrides,
    };
    this.tables.patient_consents.push(row);
    return row;
  }

  private parseFilters(url: URL): Array<[string, string, string]> {
    const out: Array<[string, string, string]> = [];
    url.searchParams.forEach((raw, key) => {
      if (["select", "order", "limit", "on_conflict"].includes(key)) return;
      const dot = raw.indexOf(".");
      out.push([key, raw.slice(0, dot), raw.slice(dot + 1)]);
    });
    return out;
  }

  private matches(row: Row, [col, op, value]: [string, string, string]): boolean {
    const cell = row[col];
    if (op === "eq") return String(cell ?? "") === value;
    if (op === "is" && value === "null") return cell == null;
    if (op === "gte") return typeof cell === "string" && cell >= value;
    if (op === "lte") return typeof cell === "string" && cell <= value;
    if (op === "lt") return typeof cell === "string" && cell < value;
    if (op === "gt") return typeof cell === "string" && cell > value;
    if (op === "in") {
      const list = value
        .replace(/^\(|\)$/g, "")
        .split(",")
        .map(item => item.replace(/^"|"$/g, ""));
      return list.includes(String(cell ?? ""));
    }
    throw new Error(`fake: unsupported op ${op}`);
  }

  handle(href: string, init?: RequestInit): Response {
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);

    if (url.pathname === "/auth/v1/user") {
      if (this.authOutage) return json(500, { error: "outage" });
      const token = (headers.get("authorization") ?? "").replace(/^Bearer /i, "");
      const userId = this.tokens.get(token);
      if (!userId) return json(401, { message: "invalid token" });
      return json(200, { id: userId, email: null, phone: null });
    }

    if (url.pathname === "/rest/v1/rpc/record_patient_edit_history") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Row;
      this.historyWrites.push(body);
      return json(200, `chg-${this.historyWrites.length}`);
    }
    if (url.pathname === "/rest/v1/rpc/patient_diary_apply") {
      this.rpcCalls += 1;
      if (this.failOnce.has("RPC patient_diary_apply")) {
        this.failOnce.delete("RPC patient_diary_apply");
        return json(500, { message: "fake upstream failure" });
      }
      // Mirrors the SQL function: one transaction — upsert merge that
      // preserves created_at, patient-scoped deletes, recents bump.
      const args = JSON.parse(String(init?.body ?? "{}")) as {
        p_patient_id: string;
        p_upsert?: Array<Record<string, unknown>>;
        p_delete_ids?: string[];
        p_recents?: unknown[] | null;
      };
      const createdIds: string[] = [];
      for (const incoming of args.p_upsert ?? []) {
        const existing = this.tables.patient_diary_entries.find(
          row =>
            String(row.patient_id) === args.p_patient_id &&
            String(row.entry_id) === String(incoming.entry_id),
        );
        if (existing) {
          const { patient_id: _pid, created_at: _created, ...rest } = incoming;
          Object.assign(existing, rest);
        } else {
          this.tables.patient_diary_entries.push({
            ...incoming,
            patient_id: args.p_patient_id,
            created_at: stampAt(this.seq++),
          });
          createdIds.push(String(incoming.entry_id));
        }
      }
      if ((args.p_delete_ids ?? []).length > 0) {
        const doomed = new Set(args.p_delete_ids);
        this.tables.patient_diary_entries = this.tables.patient_diary_entries.filter(
          row =>
            !(String(row.patient_id) === args.p_patient_id && doomed.has(String(row.entry_id))),
        );
      }
      if (args.p_recents !== null && args.p_recents !== undefined) {
        const prefs = this.tables.patient_food_prefs.find(
          row => String(row.patient_id) === args.p_patient_id,
        );
        if (prefs) {
          prefs.recents = args.p_recents;
        } else {
          this.tables.patient_food_prefs.push({
            patient_id: args.p_patient_id,
            favorites: [],
            recents: args.p_recents,
          });
        }
      }
      // The RPC returns the entry ids it newly created (sorted), never the merged ones.
      return json(200, createdIds.sort());
    }

    if (url.pathname === "/rest/v1/rpc/patient_app_event_record") {
      const args = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      this.eventCalls.push(args);
      const keys = Array.isArray(args.p_source_keys) ? args.p_source_keys.length : Number(args.p_count ?? 1);
      return json(200, keys);
    }

    if (url.pathname === "/rest/v1/rpc/patient_library_apply") {
      this.libraryRpcCalls += 1;
      if (this.failOnce.has("RPC patient_library_apply")) {
        this.failOnce.delete("RPC patient_library_apply");
        return json(500, { message: "fake upstream failure" });
      }
      // Mirrors the SQL function: one transaction — photo-ledger
      // de-reference on replace, upsert merge that preserves created_at,
      // ledger re-register (conflict keeps the finalize row), deletes that
      // drop the ledger rows first, and a coalescing prefs merge.
      const args = JSON.parse(String(init?.body ?? "{}")) as {
        p_patient_id: string;
        p_food_upsert?: Array<Record<string, unknown>>;
        p_food_delete_ids?: string[];
        p_recipe_upsert?: Array<Record<string, unknown>>;
        p_recipe_delete_ids?: string[];
        p_favorites?: unknown[] | null;
        p_recents?: unknown[] | null;
      };
      const pid = args.p_patient_id;
      const deref = (path: unknown) => {
        if (typeof path !== "string" || !path) return;
        this.tables.patient_media = this.tables.patient_media.filter(
          row => !(String(row.patient_id) === pid && String(row.object_path) === path),
        );
      };
      const register = (path: unknown, kind: string) => {
        if (typeof path !== "string" || !path) return;
        if (this.tables.patient_media.some(row => String(row.object_path) === path)) return;
        this.tables.patient_media.push({
          object_path: path,
          patient_id: pid,
          kind,
          content_type: null,
          size_bytes: null,
          created_at: stampAt(this.seq++),
        });
      };
      const applyUpserts = (
        table: string,
        idCol: string,
        kind: string,
        upserts: Array<Record<string, unknown>>,
      ) => {
        for (const incoming of upserts) {
          const existing = this.tables[table].find(
            row =>
              String(row.patient_id) === pid && String(row[idCol]) === String(incoming[idCol]),
          );
          if (existing) {
            if (
              existing.photo_path &&
              String(existing.photo_path) !== String(incoming.photo_path ?? "")
            ) {
              deref(existing.photo_path);
            }
            const { patient_id: _pid, created_at: _created, ...rest } = incoming;
            Object.assign(existing, rest);
          } else {
            this.tables[table].push({
              ...incoming,
              patient_id: pid,
              created_at: stampAt(this.seq++),
            });
          }
          register(incoming.photo_path, kind);
        }
      };
      const applyDeletes = (table: string, idCol: string, ids: string[]) => {
        if (ids.length === 0) return;
        const doomed = new Set(ids);
        for (const row of this.tables[table]) {
          if (String(row.patient_id) === pid && doomed.has(String(row[idCol]))) {
            deref(row.photo_path);
          }
        }
        this.tables[table] = this.tables[table].filter(
          row => !(String(row.patient_id) === pid && doomed.has(String(row[idCol]))),
        );
      };
      applyUpserts("patient_custom_foods", "food_id", "food", args.p_food_upsert ?? []);
      applyUpserts("patient_saved_recipes", "recipe_id", "recipe", args.p_recipe_upsert ?? []);
      applyDeletes("patient_custom_foods", "food_id", args.p_food_delete_ids ?? []);
      applyDeletes("patient_saved_recipes", "recipe_id", args.p_recipe_delete_ids ?? []);
      if (
        (args.p_favorites !== null && args.p_favorites !== undefined) ||
        (args.p_recents !== null && args.p_recents !== undefined)
      ) {
        const prefs = this.tables.patient_food_prefs.find(
          row => String(row.patient_id) === pid,
        );
        if (prefs) {
          if (args.p_favorites !== null && args.p_favorites !== undefined) {
            prefs.favorites = args.p_favorites;
          }
          if (args.p_recents !== null && args.p_recents !== undefined) {
            prefs.recents = args.p_recents;
          }
        } else {
          this.tables.patient_food_prefs.push({
            patient_id: pid,
            favorites: args.p_favorites ?? [],
            recents: args.p_recents ?? [],
          });
        }
      }
      // PostgREST answers a void RPC with 204 and no body.
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/rest/v1/rpc/claim_register_send") {
      const args = JSON.parse(String(init?.body ?? "{}")) as Row;
      const code = "246810";
      const row: Row = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        purpose: args.p_purpose,
        identifier_kind: args.p_identifier_kind,
        identifier: args.p_identifier,
        account_type: args.p_account_type,
        candidates: [],
        delivery: args.p_delivery,
        code_salt: args.p_code_salt,
        code_hash: args.p_code_hash,
        code_expires_at: args.p_code_expires_at,
        code_attempts: 0,
        verified_at: null,
        consumed_at: null,
        auth_user_id: args.p_auth_user_id,
        scope_key: args.p_scope_key,
        _unused_code: code,
      };
      this.tables.claim_verifications.push(row);
      return json(200, [row]);
    }

    if (url.pathname === "/rest/v1/rpc/patient_apply_verified_contact") {
      const args = JSON.parse(String(init?.body ?? "{}")) as Row;
      const verification = this.tables.claim_verifications.find(row => row.id === args.p_verification_id);
      const patient = this.tables.patients.find(
        row => row.id === args.p_patient_id && row.auth_user_id === args.p_auth_user_id,
      );
      if (!verification || !patient || verification.verified_at || verification.consumed_at) {
        return json(400, { message: "not eligible" });
      }
      const column = verification.purpose === "profile_phone" ? "phone" : "email";
      const value = String(verification.identifier);
      const duplicate = this.tables.patients.some(
        row => row.id !== patient.id && String(row[column] ?? "").toLowerCase() === value.toLowerCase(),
      );
      if (duplicate) return json(409, { message: "duplicate key violates unique constraint" });
      patient[column] = value;
      verification.verified_at = new Date().toISOString();
      verification.consumed_at = new Date().toISOString();
      return json(200, patient);
    }

    if (url.pathname === "/rest/v1/rpc/patient_apply_profile_setup") {
      if (this.failOnce.has("RPC patient_apply_profile_setup")) {
        this.failOnce.delete("RPC patient_apply_profile_setup");
        return json(500, { message: "atomic setup failed" });
      }
      const args = JSON.parse(String(init?.body ?? "{}")) as {
        p_patient_id: string;
        p_auth_user_id: string;
        p_profile: Row;
        p_onboarding_answers: Row;
        p_notification_prefs: Row | null;
        p_complete: boolean;
      };
      const patient = this.tables.patients.find(
        row => row.id === args.p_patient_id && row.auth_user_id === args.p_auth_user_id,
      );
      if (!patient) return json(400, { message: "owner mismatch" });
      Object.assign(patient, args.p_profile, {
        profile_completed_at: args.p_complete ? new Date().toISOString() : patient.profile_completed_at,
      });
      const existing = this.tables.patient_flags.find(row => row.patient_id === args.p_patient_id);
      const flags = {
        patient_id: args.p_patient_id,
        onboarding_answers: args.p_onboarding_answers,
        ...(args.p_notification_prefs ? { notification_prefs: args.p_notification_prefs } : {}),
        ...(args.p_complete ? { onboarding_complete: true } : {}),
      };
      if (existing) Object.assign(existing, flags);
      else this.tables.patient_flags.push(flags);
      return json(200, patient);
    }

    const restMatch = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!restMatch) return json(404, { message: `fake: no route ${url.pathname}` });
    const table = restMatch[1];
    if (!(table in this.tables)) return json(404, { message: `fake: no table ${table}` });

    const failKey = `${method} ${table}`;
    if (this.failOnce.has(failKey)) {
      this.failOnce.delete(failKey);
      return json(500, { message: "fake upstream failure" });
    }

    const filters = this.parseFilters(url);

    if (method === "GET") {
      let rows = this.tables[table].filter(row => filters.every(f => this.matches(row, f)));
      const order = url.searchParams.get("order");
      if (order) {
        const keys = order.split(",").map(part => part.split(".")[0]);
        rows = [...rows].sort((a, b) => {
          for (const key of keys) {
            const av = String(a[key] ?? "");
            const bv = String(b[key] ?? "");
            if (av !== bv) return av < bv ? -1 : 1;
          }
          return 0;
        });
      }
      const limit = url.searchParams.get("limit");
      if (limit) rows = rows.slice(0, Number(limit));
      return json(200, rows);
    }

    if (method === "POST") {
      const conflictCols = (url.searchParams.get("on_conflict") ?? "").split(",").filter(Boolean);
      const raw = JSON.parse(String(init?.body ?? "[]")) as Row[] | Row;
      const payload = Array.isArray(raw) ? raw : [raw];
      const prefer = headers.get("prefer") ?? "";
      const ignoreDuplicates = prefer.includes("resolution=ignore-duplicates");
      const written: Row[] = [];
      for (const incoming of payload) {
        const existing = conflictCols.length
          ? this.tables[table].find(row =>
              conflictCols.every(col => String(row[col] ?? "") === String(incoming[col] ?? "")),
            )
          : undefined;
        if (existing && ignoreDuplicates) {
          // PostgREST ignore-duplicates: the conflicting row is left alone
          // and is NOT part of the returned representation.
          continue;
        }
        if (existing) {
          // PostgREST merge-duplicates: update ONLY the payload's columns.
          Object.assign(existing, incoming);
          written.push(existing);
        } else if (
          table === "patient_write_receipts" &&
          this.tables[table].some(
            row =>
              row.patient_id === incoming.patient_id &&
              row.idempotency_key === incoming.idempotency_key,
          )
        ) {
          // Primary key (patient_id, idempotency_key): a plain insert of a
          // duplicate is a 409, exactly as PostgREST reports it.
          return json(409, { code: "23505", message: "duplicate key value violates unique constraint" });
        } else {
          const row = { id: crypto.randomUUID(), created_at: stampAt(this.seq++), ...incoming };
          this.tables[table].push(row);
          written.push(row);
        }
      }
      return json(201, prefer.includes("return=representation") ? written : []);
    }

    if (method === "PATCH") {
      const payload = JSON.parse(String(init?.body ?? "{}")) as Row;
      const matched = this.tables[table].filter(row => filters.every(f => this.matches(row, f)));
      for (const row of matched) Object.assign(row, payload);
      return json(200, matched);
    }

    if (method === "DELETE") {
      this.tables[table] = this.tables[table].filter(
        row => !filters.every(f => this.matches(row, f)),
      );
      // PostgREST answers DELETE with 204 and no body.
      return new Response(null, { status: 204 });
    }

    return json(405, { message: `fake: unsupported ${method}` });
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
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any; headers: Headers }> {
  const response = await realFetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, headers: response.headers };
}

function entryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "e-1",
    dateKey: "2026-08-30",
    meal: "lunch",
    kind: "food",
    refId: "grilled-chicken",
    name: "Grilled Chicken Breast",
    detail: "1 serving",
    quantity: 1,
    calories: 231,
    protein: 43,
    carbs: 0,
    fat: 5,
    ...overrides,
  };
}

function nutritionSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    source: {
      provider: "usda",
      recordId: "171077",
      release: "foundation-2026",
      revision: "sha256:exact",
      canonicalName: "Egg, whole, cooked, hard-boiled",
    },
    basis: { amount: 100, unit: "g", label: "100 g", grams: 100 },
    nutrients: [
      { id: "energy", name: "Energy", unit: "kcal", amount: 155.123456 },
      { id: "sodium", name: "Sodium", unit: "mg", amount: 124 },
      { id: "fiber", name: "Fiber", unit: "g", amount: 0 },
    ],
    portions: [
      {
        id: "large-egg",
        label: "1 large egg",
        unit: "egg",
        dimension: "count",
        basisMultiplier: 0.5,
        grams: 50,
        evidence: "USDA portion",
      },
    ],
    variant: {
      familyKey: "eggs",
      summary: "Whole, hard-boiled, large",
      dimensions: { form: "whole", preparation: "hard-boiled", size: "large" },
    },
    selected: { amount: 2, unitId: "large-egg", scale: 1 },
    provenance: "generic_source",
    ...overrides,
  };
}

beforeAll(async () => {
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  process.env.CLAIM_EMAIL_DELIVERY_MODE = "dev";
  process.env.CLAIM_SMS_DELIVERY_MODE = "dev";
  for (const knob of ["READ", "WRITE"]) {
    process.env[`PATIENT_DATA_${knob}_BURST`] = "100000";
    process.env[`PATIENT_DATA_${knob}_DAILY_BUDGET`] = "100000";
  }

  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(href).hostname === "fake.supabase.local") {
      return Promise.resolve(backend.handle(href, init));
    }
    return realFetch(input as string, init);
  });

  const { default: patientDataRouter } = await import("./patient-data");
  // The consent/privacy rail is mounted too so the enforcement tests prove
  // the exemption (a patient with no consent can still record it).
  const { default: patientPrivacyRouter } = await import("./patient-privacy");
  const { default: patientMedicationsRouter } = await import("./patient-medications");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: (obj: { err?: Error }, msg: string) =>
        console.log("ROUTELOG", msg, obj?.err?.message ?? obj),
    };
    next();
  });
  app.use("/api", patientDataRouter);
  app.use("/api", patientPrivacyRouter);
  app.use("/api", patientMedicationsRouter);
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  backend.reset();
});

describe("auth ladder", () => {
  it("rejects requests without a bearer token", async () => {
    const res = await api("GET", "/api/patient-data/state");
    expect(res.status).toBe(401);
    expect(res.json.error).toBe("Sign in required.");
  });

  it("rejects unknown/expired tokens on every route", async () => {
    for (const [method, path, body] of [
      ["GET", "/api/patient-data/state", undefined],
      ["POST", "/api/patient-data/entries", { upsert: [entryPayload()] }],
      ["PUT", "/api/patient-data/water", { dateKey: "2026-08-30", oz: 16 }],
      ["PUT", "/api/patient-data/targets", { calories: 1500 }],
      ["PUT", "/api/patient-data/prefs", { favorites: [] }],
      ["POST", "/api/patient-data/library", { foodUpsert: [] }],
      ["POST", "/api/patient-data/health-measurements", { measurements: [] }],
    ] as const) {
      const res = await api(method, path, { token: "stale-token", body });
      expect(res.status).toBe(401);
      expect(res.json.error).toBe("Sign in required.");
    }
  });

  it("responds 503 (not 401) when the auth lookup is down", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.authOutage = true;
    const res = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(res.status).toBe(503);
    expect(res.json.error).toBe("Account lookup is unavailable right now.");
  });

  it("rejects signed-in accounts with no linked patient row", async () => {
    const userId = crypto.randomUUID();
    backend.tokens.set("tok-staff", userId);
    const res = await api("GET", "/api/patient-data/state", { token: "tok-staff" });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("This account is not linked to a patient record.");
  });
});

describe("canonical patient profile", () => {
  it("sets up, validates, and reads only the signed-in patient's profile", async () => {
    const mine = backend.seedSignedInPatient("tok-1");
    const other = backend.seedSignedInPatient("tok-2");
    Object.assign(backend.tables.patients.find(row => row.id === mine.patientId)!, {
      email: "casey@example.com",
      phone: "+15550001010",
    });
    const invalid = await api("POST", "/api/patient-data/profile/setup", {
      token: "tok-1",
      body: {
        firstName: "Casey",
        lastName: "Ortiz",
        dateOfBirth: "not-a-date",
        heightInches: 66,
        startingWeight: 205,
        goalWeight: 165,
        timezone: "America/New_York",
      },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json.field).toBe("dateOfBirth");

    const underage = await api("POST", "/api/patient-data/profile/setup", {
      token: "tok-1",
      body: {
        firstName: "Casey",
        lastName: "Ortiz",
        dateOfBirth: "2015-04-03",
        heightInches: 66,
        startingWeight: 205,
        currentWeight: 191,
        goalWeight: 165,
        timezone: "America/New_York",
        programId: "glp1",
        programStartDate: "2026-01-05",
      },
    });
    expect(underage.status).toBe(400);
    expect(underage.json.field).toBe("dateOfBirth");

    const setup = await api("POST", "/api/patient-data/setup/complete", {
      token: "tok-1",
      body: {
        profile: {
          firstName: "Casey",
          lastName: "Ortiz",
          dateOfBirth: "1985-04-03",
          gender: "female",
          heightUnit: "imperial",
          heightInches: 66,
          heightCm: 167.64,
          startingWeight: 205,
          currentWeight: 191,
          goalWeight: 165,
          programId: "glp1",
          programStartDate: "2026-01-05",
          timezone: "America/New_York",
        },
        onboardingAnswers: { medication: "semaglutide", password: "must-not-persist" },
        notificationPrefs: { reminders: true },
      },
    });
    expect(setup.status).toBe(200);
    expect(setup.json.profile).toMatchObject({
      name: "Casey Ortiz",
      firstName: "Casey",
      lastName: "Ortiz",
      dateOfBirth: "1985-04-03",
      heightInches: 66,
      startingWeight: 205,
      currentWeight: 191,
      timezone: "America/New_York",
      programId: "glp1",
      program: "glp1",
      setupComplete: true,
    });
    expect(backend.tables.patients.find(row => row.id === mine.patientId)?.name).toBe("Casey Ortiz");
    expect(backend.tables.patient_flags[0]).toMatchObject({
      onboarding_answers: { medication: "semaglutide" },
      onboarding_complete: true,
    });
    expect(backend.tables.patients.find(row => row.id === other.patientId)?.first_name).toBeUndefined();

    const read = await api("GET", "/api/patient-data/profile", { token: "tok-1" });
    expect(read.status).toBe(200);
    expect(read.json).toEqual(setup.json);
  });

  it("changes contact only after an account-bound code and rejects duplicates atomically", async () => {
    const mine = backend.seedSignedInPatient("tok-1");
    backend.seedSignedInPatient("tok-2");
    Object.assign(backend.tables.patients.find(row => row.id === mine.patientId)!, {
      email: "old@example.com",
      phone: "+15550001111",
    });
    backend.tables.patients.find(row => row.auth_user_id !== mine.userId)!.email = "taken@example.com";

    const started = await api("POST", "/api/patient-data/profile/contact/start", {
      token: "tok-1",
      body: { kind: "email", value: "New@Example.com" },
    });
    expect(started.status).toBe(200);
    const wrongOwner = await api("POST", "/api/patient-data/profile/contact/verify", {
      token: "tok-2",
      body: { requestId: started.json.requestId, code: started.json.devCode },
    });
    expect(wrongOwner.status).toBe(400);
    expect(backend.tables.patients.find(row => row.id === mine.patientId)?.email).toBe("old@example.com");

    const verified = await api("POST", "/api/patient-data/profile/contact/verify", {
      token: "tok-1",
      body: { requestId: started.json.requestId, code: started.json.devCode },
    });
    expect(verified.status).toBe(200);
    expect(verified.json.profile.email).toBe("new@example.com");

    const duplicateStart = await api("POST", "/api/patient-data/profile/verification/request", {
      token: "tok-1",
      body: { kind: "email", value: "taken@example.com" },
    });
    const duplicate = await api("POST", "/api/patient-data/profile/verification/confirm", {
      token: "tok-1",
      body: { kind: "email", value: "taken@example.com", code: duplicateStart.json.devCode },
    });
    expect(duplicate.status).toBe(409);
    expect(backend.tables.patients.find(row => row.id === mine.patientId)?.email).toBe("new@example.com");
    const duplicateRow = backend.tables.claim_verifications.find(
      row => row.id === duplicateStart.json.requestId,
    );
    expect(duplicateRow).toMatchObject({ verified_at: null, consumed_at: null });
  });

  it("does not partially save profile data or completion when setup's atomic RPC fails", async () => {
    const mine = backend.seedSignedInPatient("tok-1");
    Object.assign(backend.tables.patients.find(row => row.id === mine.patientId)!, {
      name: "Before Patient",
      current_weight: 200,
      email: "before@example.com",
      phone: "+15550002020",
    });
    backend.failOnce.add("RPC patient_apply_profile_setup");
    const failed = await api("POST", "/api/patient-data/setup/complete", {
      token: "tok-1",
      body: {
        profile: {
          firstName: "After",
          lastName: "Patient",
          dateOfBirth: "1985-04-03",
          heightInches: 66,
          startingWeight: 200,
          currentWeight: 180,
          goalWeight: 160,
          timezone: "America/New_York",
          programId: "glp1",
          programStartDate: "2026-01-05",
        },
        onboardingAnswers: { medication: "glp1" },
      },
    });
    expect(failed.status).toBe(502);
    const patient = backend.tables.patients.find(row => row.id === mine.patientId)!;
    expect(patient).toMatchObject({
      name: "Before Patient",
      current_weight: 200,
    });
    expect(patient).not.toHaveProperty("profile_completed_at");
    expect(backend.tables.patient_flags).toEqual([]);
  });
});

describe("consent enforcement (server-side gate)", () => {
  const CONSENT_FAILURE = {
    error: expect.any(String),
    code: "CONSENT_REQUIRED",
    consent: expect.objectContaining({ requiredVersion: CONSENT_POLICY_VERSION, satisfied: false }),
  };

  it("refuses every data read and write for a patient with no consent on record", async () => {
    backend.seedSignedInPatient("tok-1", { consent: false });
    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.status).toBe(403);
    expect(state.json).toEqual({ ...CONSENT_FAILURE, consent: expect.objectContaining({ recordedVersion: null }) });
    // No diary, water, targets, library, profile, or flag payload leaks.
    expect(Object.keys(state.json).sort()).toEqual(["code", "consent", "error"]);

    const diary = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { upsert: [entryPayload()] },
    });
    expect(diary.status).toBe(403);
    expect(diary.json.code).toBe("CONSENT_REQUIRED");
    expect(backend.tables.patient_diary_entries).toHaveLength(0);
    expect(backend.rpcCalls).toBe(0);

    const profile = await api("GET", "/api/patient-data/profile", { token: "tok-1" });
    expect(profile.status).toBe(403);
    expect(profile.json.code).toBe("CONSENT_REQUIRED");
  });

  it("treats a record for an OLDER policy version as no consent", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1", { consent: false });
    backend.seedConsent(patientId, { policy_version: "2020-01-01", recorded_at: "2020-01-02T00:00:00Z" });
    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.status).toBe(403);
    expect(state.json).toEqual({
      ...CONSENT_FAILURE,
      consent: expect.objectContaining({ recordedVersion: "2020-01-01", satisfied: false }),
    });
  });

  it("keeps the consent and privacy endpoints reachable so the patient can act", async () => {
    backend.seedSignedInPatient("tok-1", { consent: false });
    const privacy = await api("GET", "/api/patient-data/privacy", { token: "tok-1" });
    expect(privacy.status).toBe(200);
    expect(privacy.json.consent.satisfied).toBe(false);

    const recorded = await api("PUT", "/api/patient-data/consent", {
      token: "tok-1",
      body: {
        policyVersion: CONSENT_POLICY_VERSION,
        terms: true,
        privacy: true,
        healthData: true,
        photoAnalysis: false,
        appVersion: "1.4.0",
        platform: "ios",
      },
    });
    expect(recorded.status).toBe(200);
    expect(recorded.json.consent.satisfied).toBe(true);

    // The very next data call opens.
    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.status).toBe(200);
    expect(state.json.privacy.consent).toMatchObject({ satisfied: true, photoAnalysis: false });
  });

  it("never touches demo or unauthenticated callers (401 stays 401)", async () => {
    const res = await api("GET", "/api/patient-data/state");
    expect(res.status).toBe(401);
    expect(res.json.code).toBeUndefined();
  });
});

describe("GET /patient-data/state", () => {
  it("mints a media read token scoped to the caller only", async () => {
    const { verifyPatientMediaToken } = await import("../lib/media-token");
    const seeded = backend.seedSignedInPatient("tok-1");
    const res = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(res.status).toBe(200);
    const token = res.json.mediaToken as string;
    expect(verifyPatientMediaToken(token, seeded.patientId)).toBe(true);
    expect(verifyPatientMediaToken(token, "someone-else")).toBe(false);
  });

  it("returns an empty slice for a fresh account", async () => {
    backend.seedSignedInPatient("tok-1");
    const res = await api("GET", "/api/patient-data/state?from=2026-07-01&to=2026-08-31&today=2026-08-31", {
      token: "tok-1",
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      entries: [],
      water: {},
      targets: {},
      favorites: [],
      recents: [],
      customFoods: [],
      catalogFoods: [],
      savedRecipes: [],
      photos: [],
      checkIns: [],
      medications: [],
      doseLogs: [],
      flags: {
        nudgeOptOut: false,
        nudgeEngaged: false,
        nudgeLastSentKey: null,
        nudgeLastCrossingKey: null,
        onboardingComplete: false,
      },
      entry: {
        firstName: "Casey",
        programStartDate: "2026-08-31",
        todayKey: "2026-08-31",
        programDay: 1,
      },
      privacy: {
        consent: { requiredVersion: CONSENT_POLICY_VERSION, recordedVersion: CONSENT_POLICY_VERSION, satisfied: true, photoAnalysis: true, recordedAt: "2026-09-01T00:00:00Z" },
        export: null,
        deletion: null,
      },
      mediaToken: expect.any(String),
    });
  });

  it("returns live identity and elapsed program facts, falling back to row creation day", async () => {
    const current = backend.seedSignedInPatient("tok-1");
    Object.assign(
      backend.tables.patients.find(row => row.id === current.patientId)!,
      {
        name: "Riley Chen",
        program_start_date: "2026-08-10",
        created_at: "2026-08-01T10:00:00Z",
      },
    );
    const live = await api("GET", "/api/patient-data/state?today=2026-08-22", { token: "tok-1" });
    expect(live.status).toBe(200);
    expect(live.json.entry).toEqual({
      firstName: "Riley",
      programStartDate: "2026-08-10",
      todayKey: "2026-08-22",
      programDay: 12,
    });

    const legacy = backend.seedSignedInPatient("tok-2");
    Object.assign(
      backend.tables.patients.find(row => row.id === legacy.patientId)!,
      {
        name: "Legacy Patient",
        program_start_date: null,
        created_at: "2026-08-01T10:00:00Z",
      },
    );
    const fallback = await api("GET", "/api/patient-data/state?today=2026-08-22", { token: "tok-2" });
    expect(fallback.status).toBe(200);
    expect(fallback.json.entry).toEqual({
      firstName: "Legacy",
      programStartDate: "2026-08-01",
      todayKey: "2026-08-22",
      programDay: 21,
    });
  });

  it("rejects malformed date ranges", async () => {
    backend.seedSignedInPatient("tok-1");
    for (const range of [
      "from=2026-13-01",
      "to=2026-02-30",
      "from=garbage",
      "today=2026-02-30",
    ]) {
      const res = await api("GET", `/api/patient-data/state?${range}`, { token: "tok-1" });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("Invalid date range.");
    }
  });

  it("maps rows to the client entry shape (id, optional refId/adjustments)", async () => {
    backend.seedSignedInPatient("tok-1");
    const write = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: {
        upsert: [
          entryPayload({
            id: "e-recipe",
            kind: "recipe",
            refId: "r-tuscan",
            adjustments: [{ index: 2, amount: 4, unit: "oz" }],
          }),
          entryPayload({ id: "e-quick", kind: "quick", refId: null, detail: undefined }),
        ],
      },
    });
    expect(write.status).toBe(200);

    const res = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(res.status).toBe(200);
    expect(res.json.entries).toEqual([
      {
        id: "e-recipe",
        dateKey: "2026-08-30",
        meal: "lunch",
        kind: "recipe",
        refId: "r-tuscan",
        name: "Grilled Chicken Breast",
        detail: "1 serving",
        quantity: 1,
        calories: 231,
        protein: 43,
        carbs: 0,
        fat: 5,
        adjustments: [{ index: 2, amount: 4, unit: "oz" }],
      },
      {
        id: "e-quick",
        dateKey: "2026-08-30",
        meal: "lunch",
        kind: "quick",
        name: "Grilled Chicken Breast",
        detail: "",
        quantity: 1,
        calories: 231,
        protein: 43,
        carbs: 0,
        fat: 5,
      },
    ]);
  });

  it("keeps insertion order across merges (created_at asc) and filters by range", async () => {
    backend.seedSignedInPatient("tok-1");
    await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: {
        upsert: [
          entryPayload({ id: "e-a", dateKey: "2026-08-28", name: "First" }),
          entryPayload({ id: "e-b", dateKey: "2026-08-29", name: "Second" }),
          entryPayload({ id: "e-c", dateKey: "2026-08-30", name: "Third" }),
        ],
      },
    });
    // Editing the oldest row must not move it to the end.
    await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { upsert: [entryPayload({ id: "e-a", dateKey: "2026-08-28", name: "First Edited" })] },
    });

    const all = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(all.json.entries.map((e: any) => e.name)).toEqual([
      "First Edited",
      "Second",
      "Third",
    ]);
    expect(backend.tables.patient_diary_entries).toHaveLength(3);

    const ranged = await api(
      "GET",
      "/api/patient-data/state?from=2026-08-29&to=2026-08-29",
      { token: "tok-1" },
    );
    expect(ranged.json.entries.map((e: any) => e.id)).toEqual(["e-b"]);
  });

  it("never mixes two patients' data", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.seedSignedInPatient("tok-2");
    await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { upsert: [entryPayload({ id: "mine", name: "Mine" })], recents: ["grilled-chicken"] },
    });
    await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      body: { dateKey: "2026-08-30", oz: 40 },
    });

    const other = await api("GET", "/api/patient-data/state?today=2026-08-31", { token: "tok-2" });
    expect(other.json).toEqual({
      entries: [],
      water: {},
      targets: {},
      favorites: [],
      recents: [],
      customFoods: [],
      catalogFoods: [],
      savedRecipes: [],
      photos: [],
      checkIns: [],
      medications: [],
      doseLogs: [],
      flags: {
        nudgeOptOut: false,
        nudgeEngaged: false,
        nudgeLastSentKey: null,
        nudgeLastCrossingKey: null,
        onboardingComplete: false,
      },
      entry: {
        firstName: "Casey",
        programStartDate: "2026-08-31",
        todayKey: "2026-08-31",
        programDay: 1,
      },
      privacy: {
        consent: { requiredVersion: CONSENT_POLICY_VERSION, recordedVersion: CONSENT_POLICY_VERSION, satisfied: true, photoAnalysis: true, recordedAt: "2026-09-01T00:00:00Z" },
        export: null,
        deletion: null,
      },
      mediaToken: expect.any(String),
    });
  });

  it("responds 502 with a friendly message when the store is down", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.failOnce.add("GET patient_diary_entries");
    const res = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("Couldn't load your diary right now. Please try again.");
  });
});

describe("POST /patient-data/health-measurements", () => {
  const measurement = (overrides: Row = {}): Row => ({
    sourceId: "apple-weight-1",
    source: "apple_health",
    kind: "weight_lb",
    value: 180.5,
    measuredAt: new Date().toISOString(),
    ...overrides,
  });

  it("requires a bearer-resolved patient and scopes accepted rows to that patient", async () => {
    const mine = backend.seedSignedInPatient("health-mine");
    const other = backend.seedSignedInPatient("health-other");
    expect((await api("POST", "/api/patient-data/health-measurements", { body: { measurements: [] } })).status).toBe(401);
    backend.tokens.set("health-unlinked", crypto.randomUUID());
    expect((await api("POST", "/api/patient-data/health-measurements", {
      token: "health-unlinked", body: { measurements: [] },
    })).status).toBe(403);
    const accepted = await api("POST", "/api/patient-data/health-measurements", {
      token: "health-mine",
      body: { measurements: [measurement(), measurement({ sourceId: "hc-steps-1", source: "health_connect", kind: "steps", value: 8321 })] },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json).toEqual({ imported: 2 });
    expect(backend.tables.patient_health_measurements).toHaveLength(2);
    expect(backend.tables.patient_health_measurements.every(row => row.patient_id === mine.patientId)).toBe(true);
    expect(backend.tables.patient_health_measurements.some(row => row.patient_id === other.patientId)).toBe(false);
  });

  it("rejects malformed batches and all disallowed measurement fields", async () => {
    backend.seedSignedInPatient("health-invalid");
    const invalid = [
      { measurements: {} },
      { measurements: new Array(501).fill(measurement()) },
      { measurements: [measurement({ source: "other" })] },
      { measurements: [measurement({ kind: "heart_rate" })] },
      { measurements: [measurement({ value: -1 })] },
      { measurements: [measurement({ sourceId: "" })] },
      { measurements: [measurement({ measuredAt: "not-a-date" })] },
      { measurements: [measurement({ measuredAt: new Date(Date.now() - 32 * 86400000).toISOString() })] },
      { measurements: [measurement({ measuredAt: new Date(Date.now() + 6 * 60000).toISOString() })] },
    ];
    for (const body of invalid) {
      expect((await api("POST", "/api/patient-data/health-measurements", { token: "health-invalid", body })).status).toBe(400);
    }
  });

  it("uses the per-account source key as an idempotent upsert contract", async () => {
    const mine = backend.seedSignedInPatient("health-repeat");
    const body = { measurements: [measurement()] };
    expect((await api("POST", "/api/patient-data/health-measurements", { token: "health-repeat", body })).status).toBe(200);
    expect((await api("POST", "/api/patient-data/health-measurements", { token: "health-repeat", body })).status).toBe(200);
    expect(backend.tables.patient_health_measurements.filter(row => row.patient_id === mine.patientId)).toHaveLength(1);
  });

  it("returns a friendly failure when the health upsert upstream fails", async () => {
    backend.seedSignedInPatient("health-fail");
    backend.failOnce.add("POST patient_health_measurements");
    const res = await api("POST", "/api/patient-data/health-measurements", {
      token: "health-fail", body: { measurements: [measurement()] },
    });
    expect(res.status).toBe(503);
    expect(res.json.error).toBeTruthy();
  });
});

describe("idempotency keys (offline queue replay)", () => {
  const KEY = "q_01J8ZC0K9ABCDEF.entries:1";

  it("replays the stored response without applying the write again", async () => {
    backend.seedSignedInPatient("tok-1");
    const first = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { upsert: [entryPayload({ id: "e-1" })], recents: ["grilled-chicken"] },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("idempotency-replayed")).toBeNull();
    expect(backend.tables.patient_write_receipts).toHaveLength(1);
    const rpcAfterFirst = backend.rpcCalls;

    // Same key again — as the app does after a lost response — must not
    // reach the diary RPC (and so cannot re-bump recents or re-run deletes).
    const replay = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { upsert: [entryPayload({ id: "e-1" })], recents: ["grilled-chicken"] },
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({ ok: true });
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(backend.rpcCalls).toBe(rpcAfterFirst);
    expect(backend.tables.patient_diary_entries).toHaveLength(1);
    expect(backend.tables.patient_write_receipts).toHaveLength(1);
  });

  it("scopes keys per patient — another account's identical key is a fresh write", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.seedSignedInPatient("tok-2");
    for (const token of ["tok-1", "tok-2"]) {
      const res = await api("PUT", "/api/patient-data/water", {
        token,
        headers: { "Idempotency-Key": KEY },
        body: { dateKey: "2026-08-30", oz: 24 },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("idempotency-replayed")).toBeNull();
    }
    expect(backend.tables.patient_water_days).toHaveLength(2);
    expect(backend.tables.patient_write_receipts).toHaveLength(2);
  });

  it("refuses a key reused for a different route", async () => {
    backend.seedSignedInPatient("tok-1");
    await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { dateKey: "2026-08-30", oz: 24 },
    });
    const res = await api("PUT", "/api/patient-data/targets", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { calories: 1500 },
    });
    expect(res.status).toBe(409);
    expect(backend.tables.patient_target_overrides).toHaveLength(0);
  });

  it("does not record validation failures, so the corrected retry runs for real", async () => {
    backend.seedSignedInPatient("tok-1");
    const bad = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { dateKey: "not-a-day", oz: 24 },
    });
    expect(bad.status).toBe(400);
    expect(backend.tables.patient_write_receipts).toHaveLength(0);
    const good = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { dateKey: "2026-08-30", oz: 24 },
    });
    expect(good.status).toBe(200);
    expect(backend.tables.patient_water_days).toHaveLength(1);
  });

  it("does not record upstream failures either — the retry applies", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.failOnce.add("POST patient_water_days");
    const failed = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { dateKey: "2026-08-30", oz: 24 },
    });
    expect(failed.status).toBe(502);
    // The pending claim is released when the failed response ends.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(backend.tables.patient_write_receipts).toHaveLength(0);
    const retry = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { dateKey: "2026-08-30", oz: 24 },
    });
    expect(retry.status).toBe(200);
    expect(backend.tables.patient_water_days).toHaveLength(1);
  });

  it("claims the receipt BEFORE writing: a claim failure means nothing was written", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.failOnce.add("POST patient_write_receipts");
    const res = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { dateKey: "2026-08-30", oz: 24 },
    });
    expect(res.status).toBe(502);
    expect(backend.tables.patient_water_days).toHaveLength(0);
    expect(backend.tables.patient_write_receipts).toHaveLength(0);
  });

  it("fails closed when the receipt lookup behind a duplicate claim is unavailable", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    backend.tables.patient_write_receipts.push({
      patient_id: patientId,
      idempotency_key: KEY,
      route: "water",
      state: "done",
      status: 200,
      response: { ok: true },
      claimed_at: new Date().toISOString(),
    });
    backend.failOnce.add("GET patient_write_receipts");
    const res = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { dateKey: "2026-08-30", oz: 24 },
    });
    expect(res.status).toBe(502);
    expect(backend.tables.patient_water_days).toHaveLength(0);
  });

  it("marks the receipt done with the response, so a replay after a lost response never re-applies", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    const first = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { dateKey: "2026-08-30", oz: 24 },
    });
    expect(first.status).toBe(200);
    const receipt = backend.tables.patient_write_receipts[0];
    expect(receipt).toMatchObject({
      patient_id: patientId,
      idempotency_key: KEY,
      route: "water",
      state: "done",
      status: 200,
      response: { ok: true },
    });
    // Pretend the 200 never reached the phone: it replays with different
    // (older) content under the same key — the receipt answers, the water
    // row keeps the value the first attempt landed.
    const replay = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { dateKey: "2026-08-30", oz: 8 },
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(backend.tables.patient_water_days).toHaveLength(1);
    expect(backend.tables.patient_water_days[0].oz).toBe(24);
  });

  it("tells a twin request to retry while the first attempt is still in flight", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    backend.tables.patient_write_receipts.push({
      patient_id: patientId,
      idempotency_key: KEY,
      route: "water",
      state: "pending",
      status: null,
      response: null,
      claimed_at: new Date().toISOString(),
    });
    const res = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { dateKey: "2026-08-30", oz: 24 },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(backend.tables.patient_water_days).toHaveLength(0);
    // The pending claim is left to its owner — not released, not flipped.
    expect(backend.tables.patient_write_receipts).toHaveLength(1);
    expect(backend.tables.patient_write_receipts[0].state).toBe("pending");
  });

  it("takes over a stale pending claim (owner died mid-write) and completes it", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    const stale = new Date(Date.now() - PENDING_TTL_MS - 1_000).toISOString();
    backend.tables.patient_write_receipts.push({
      patient_id: patientId,
      idempotency_key: KEY,
      route: "water",
      state: "pending",
      status: null,
      response: null,
      claimed_at: stale,
    });
    const res = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { dateKey: "2026-08-30", oz: 24 },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotency-replayed")).toBeNull();
    expect(backend.tables.patient_water_days).toHaveLength(1);
    expect(backend.tables.patient_write_receipts).toHaveLength(1);
    expect(backend.tables.patient_write_receipts[0]).toMatchObject({ state: "done", status: 200 });
    expect(String(backend.tables.patient_write_receipts[0].claimed_at) > stale).toBe(true);

    const replay = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { dateKey: "2026-08-30", oz: 24 },
    });
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
  });

  it("still answers success when the done-flip fails after the write landed (write is not re-run by the client)", async () => {
    backend.seedSignedInPatient("tok-1");
    // Three flip attempts, all failing.
    backend.failOnce.add("PATCH patient_write_receipts");
    const res = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": KEY },
      body: { dateKey: "2026-08-30", oz: 24 },
    });
    // failOnce is one-shot: the second flip attempt succeeds.
    expect(res.status).toBe(200);
    expect(backend.tables.patient_water_days).toHaveLength(1);
    expect(backend.tables.patient_write_receipts[0].state).toBe("done");
  });

  it("rejects malformed keys and ignores absent ones", async () => {
    backend.seedSignedInPatient("tok-1");
    const bad = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      headers: { "Idempotency-Key": "has spaces!" },
      body: { dateKey: "2026-08-30", oz: 24 },
    });
    expect(bad.status).toBe(400);
    const plain = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      body: { dateKey: "2026-08-30", oz: 24 },
    });
    expect(plain.status).toBe(200);
    expect(backend.tables.patient_write_receipts).toHaveLength(0);
  });

  it("covers every patient write route (photos: see patient-progress.test.ts)", async () => {
    backend.seedSignedInPatient("tok-1");
    const routes: Array<[string, string, unknown]> = [
      ["POST", "/api/patient-data/entries", { upsert: [entryPayload({ id: "e-9" })] }],
      ["PUT", "/api/patient-data/water", { dateKey: "2026-08-30", oz: 8 }],
      ["PUT", "/api/patient-data/targets", { calories: 1400 }],
      ["PUT", "/api/patient-data/prefs", { favorites: ["grilled-chicken"] }],
      ["POST", "/api/patient-data/library", { foodDeleteIds: ["nothing"] }],
      ["POST", "/api/patient-data/check-ins", { id: "c-1", dateKey: "2026-08-30", weight: 180, mood: 4, sideEffects: [] }],
      ["PUT", "/api/patient-data/flags", { nudgeOptOut: true }],
    ];
    for (const [method, path, body] of routes) {
      const key = `${KEY}.${path.split("/").pop()}`;
      const first = await api(method, path, { token: "tok-1", headers: { "Idempotency-Key": key }, body });
      expect(first.status, `${method} ${path}`).toBe(200);
      const replay = await api(method, path, { token: "tok-1", headers: { "Idempotency-Key": key }, body });
      expect(replay.status, `${method} ${path} replay`).toBe(200);
      expect(replay.headers.get("idempotency-replayed"), `${method} ${path} replay`).toBe("true");
    }
    expect(backend.tables.patient_write_receipts).toHaveLength(routes.length);
  });
});

describe("POST /patient-data/entries", () => {
  it("round-trips the unrounded nutrition baseline and rejects malformed supplied snapshots", async () => {
    backend.seedSignedInPatient("tok-1");
    const snapshot = nutritionSnapshot();
    const saved = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { upsert: [entryPayload({ nutritionSnapshot: snapshot })] },
    });
    expect(saved.status).toBe(200);
    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.entries[0].nutritionSnapshot).toEqual(snapshot);
    expect(state.json.entries[0].nutritionSnapshot.nutrients[0].amount).toBe(155.123456);
    expect(state.json.entries[0].nutritionSnapshot.nutrients[2].amount).toBe(0);

    for (const bad of [
      null,
      nutritionSnapshot({ selected: { amount: 0, unitId: "large-egg", scale: 0 } }),
      nutritionSnapshot({ selected: { amount: 2, unitId: "missing", scale: 1 } }),
      nutritionSnapshot({ selected: { amount: 2, unitId: "large-egg", scale: Number.NaN } }),
    ]) {
      const rejected = await api("POST", "/api/patient-data/entries", {
        token: "tok-1",
        body: { upsert: [entryPayload({ id: `bad-${String(bad)}`, nutritionSnapshot: bad })] },
      });
      expect(rejected.status).toBe(400);
    }
  });

  it("requires at least one of upsert/deleteIds/recents", async () => {
    backend.seedSignedInPatient("tok-1");
    const res = await api("POST", "/api/patient-data/entries", { token: "tok-1", body: {} });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Nothing to save.");
  });

  it("merges an edit into the same row and preserves created_at", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { upsert: [entryPayload({ id: "e-1", quantity: 1 })] },
    });
    const created = backend.tables.patient_diary_entries[0].created_at;

    const res = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { upsert: [entryPayload({ id: "e-1", quantity: 2.5, calories: 577 })] },
    });
    expect(res.status).toBe(200);
    const rows = backend.tables.patient_diary_entries;
    expect(rows).toHaveLength(1);
    expect(rows[0].patient_id).toBe(patientId);
    expect(rows[0].quantity).toBe(2.5);
    expect(rows[0].calories).toBe(577);
    expect(rows[0].created_at).toBe(created);
  });

  it("records one food_log usage event per NEW entry, keyed on the entry — edits and deletes record nothing", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const foodLogCalls = () => backend.eventCalls.filter((call) => call.p_feature === "food_log");

    // Create: two new entries → two keyed events.
    let res = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      headers: { "x-thinnr-platform": "ios" },
      body: { upsert: [entryPayload({ id: "e-1" }), entryPayload({ id: "e-2" })] },
    });
    expect(res.status).toBe(200);
    await flush();
    expect(foodLogCalls()).toEqual([
      expect.objectContaining({
        p_patient_id: patientId,
        p_platform: "ios",
        p_source_keys: [`${patientId}:e-1`, `${patientId}:e-2`],
      }),
    ]);

    // Edit of an existing entry: the apply RPC reports nothing new → no event write at all.
    res = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { upsert: [entryPayload({ id: "e-1", quantity: 3 })] },
    });
    expect(res.status).toBe(200);
    await flush();
    expect(foodLogCalls()).toHaveLength(1);

    // Mixed batch: one edit + one new → exactly the new one is keyed.
    res = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { upsert: [entryPayload({ id: "e-2", quantity: 2 }), entryPayload({ id: "e-3" })] },
    });
    expect(res.status).toBe(200);
    await flush();
    expect(foodLogCalls()).toHaveLength(2);
    expect(foodLogCalls()[1].p_source_keys).toEqual([`${patientId}:e-3`]);

    // Deletes and recents bumps are not logs.
    res = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { deleteIds: ["e-1"], recents: ["egg"] },
    });
    expect(res.status).toBe(200);
    await flush();
    expect(foodLogCalls()).toHaveLength(2);
  });

  it("deletes only the caller's rows, matching exotic-but-legal ids", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.seedSignedInPatient("tok-2");
    const sharedId = "p1:copy.2026-08-30_x-7";
    for (const token of ["tok-1", "tok-2"]) {
      await api("POST", "/api/patient-data/entries", {
        token,
        body: { upsert: [entryPayload({ id: sharedId }), entryPayload({ id: "keep-me" })] },
      });
    }

    const res = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { deleteIds: [sharedId] },
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });

    const mine = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(mine.json.entries.map((e: any) => e.id)).toEqual(["keep-me"]);
    const theirs = await api("GET", "/api/patient-data/state", { token: "tok-2" });
    expect(theirs.json.entries.map((e: any) => e.id).sort()).toEqual(["keep-me", sharedId].sort());
  });

  it("lets a recents bump ride an add", async () => {
    backend.seedSignedInPatient("tok-1");
    const res = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { upsert: [entryPayload()], recents: ["grilled-chicken", "oatmeal"] },
    });
    expect(res.status).toBe(200);
    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.recents).toEqual(["grilled-chicken", "oatmeal"]);
    expect(state.json.favorites).toEqual([]);
  });

  it("applies a compound mutation through one atomic upstream call", async () => {
    backend.seedSignedInPatient("tok-1");
    await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { upsert: [entryPayload({ id: "old-1" })] },
    });

    const before = backend.rpcCalls;
    const res = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: {
        upsert: [entryPayload({ id: "new-1", name: "Replacement" })],
        deleteIds: ["old-1"],
        recents: ["fd-replacement"],
      },
    });
    expect(res.status).toBe(200);
    expect(backend.rpcCalls - before).toBe(1);

    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.entries.map((e: any) => e.id)).toEqual(["new-1"]);
    expect(state.json.recents).toEqual(["fd-replacement"]);
  });

  it("commits nothing when the atomic apply fails — no partial write can reappear later", async () => {
    backend.seedSignedInPatient("tok-1");
    await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { upsert: [entryPayload({ id: "keep-1" })], recents: ["fd-keep"] },
    });

    backend.failOnce.add("RPC patient_diary_apply");
    const res = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: {
        upsert: [entryPayload({ id: "stranded", name: "Stranded" })],
        deleteIds: ["keep-1"],
        recents: ["fd-new"],
      },
    });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("Couldn't save to your diary right now. Please try again.");

    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.entries.map((e: any) => e.id)).toEqual(["keep-1"]);
    expect(state.json.recents).toEqual(["fd-keep"]);
  });

  it("rejects malformed entries field by field", async () => {
    backend.seedSignedInPatient("tok-1");
    const cases: Array<[Record<string, unknown>, string]> = [
      [entryPayload({ id: "bad id!" }), "Entry id is invalid."],
      [entryPayload({ dateKey: "2026-02-30" }), "Entry date is invalid."],
      [entryPayload({ meal: "brunch" }), "Entry meal slot is invalid."],
      [entryPayload({ kind: "mystery" }), "Entry kind is invalid."],
      [entryPayload({ name: "   " }), "Entry name must be 1-200 characters."],
      [entryPayload({ quantity: 0 }), "Entry quantity is invalid."],
      [entryPayload({ calories: -5 }), "Entry calories are invalid."],
      [entryPayload({ adjustments: [{ index: 1.5, amount: 2, unit: "oz" }] }), "Entry adjustments are invalid."],
      [entryPayload({ adjustments: [{ index: 1, amount: 2, unit: "x".repeat(41) }] }), "Entry adjustments are invalid."],
    ];
    for (const [entry, message] of cases) {
      const res = await api("POST", "/api/patient-data/entries", {
        token: "tok-1",
        body: { upsert: [entry] },
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe(message);
    }
    expect(backend.tables.patient_diary_entries).toHaveLength(0);
  });

  it("rejects oversized batches and bad delete lists", async () => {
    backend.seedSignedInPatient("tok-1");
    const big = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { upsert: Array.from({ length: 81 }, (_, i) => entryPayload({ id: `e-${i}` })) },
    });
    expect(big.status).toBe(400);
    expect(big.json.error).toBe("Entry batch is invalid (at most 80 entries).");

    const badDelete = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { deleteIds: ["ok", "has space"] },
    });
    expect(badDelete.status).toBe(400);
    expect(badDelete.json.error).toBe("Delete list is invalid.");
  });

  it("responds 502 when the upsert fails upstream", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.failOnce.add("RPC patient_diary_apply");
    const res = await api("POST", "/api/patient-data/entries", {
      token: "tok-1",
      body: { upsert: [entryPayload()] },
    });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("Couldn't save to your diary right now. Please try again.");
  });
});

describe("PUT /patient-data/water", () => {
  it("upserts one day's ounces and overwrites on repeat", async () => {
    backend.seedSignedInPatient("tok-1");
    for (const oz of [16, 48]) {
      const res = await api("PUT", "/api/patient-data/water", {
        token: "tok-1",
        body: { dateKey: "2026-08-30", oz },
      });
      expect(res.status).toBe(200);
    }
    await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      body: { dateKey: "2026-08-29", oz: 8 },
    });
    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.water).toEqual({ "2026-08-30": 48, "2026-08-29": 8 });
    expect(backend.tables.patient_water_days).toHaveLength(2);
  });

  it("rejects bad dates and out-of-range ounces", async () => {
    backend.seedSignedInPatient("tok-1");
    const badDate = await api("PUT", "/api/patient-data/water", {
      token: "tok-1",
      body: { dateKey: "yesterday", oz: 16 },
    });
    expect(badDate.status).toBe(400);
    expect(badDate.json.error).toBe("Water date is invalid.");
    for (const oz of [-8, 201, 12.5]) {
      const res = await api("PUT", "/api/patient-data/water", {
        token: "tok-1",
        body: { dateKey: "2026-08-30", oz },
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("Water ounces are invalid.");
    }
  });
});

describe("POST /patient-data/check-ins", () => {
  it("keeps the overwritten weight of a re-submitted day in the edit history, attributed to the patient", async () => {
    const mine = backend.seedSignedInPatient("tok-1");
    const checkIn = (over: Record<string, unknown>) => ({ id: "c-1", dateKey: "2026-08-30", mood: 4, sideEffects: [], ...over });
    // First submit of the day: a create with the new weight; a weightless
    // check-in and a same-weight re-submit write nothing.
    expect((await api("POST", "/api/patient-data/check-ins", { token: "tok-1", body: checkIn({ weight: 182.4 }) })).status).toBe(200);
    expect((await api("POST", "/api/patient-data/check-ins", { token: "tok-1", body: checkIn({ weight: 182.4, mood: 2 }) })).status).toBe(200);
    expect((await api("POST", "/api/patient-data/check-ins", { token: "tok-1", body: checkIn({ id: "c-2", dateKey: "2026-08-31" }) })).status).toBe(200);
    // Two overwrites of the same day: both prior values remain, oldest first.
    expect((await api("POST", "/api/patient-data/check-ins", { token: "tok-1", body: checkIn({ weight: 181 }) })).status).toBe(200);
    expect((await api("POST", "/api/patient-data/check-ins", { token: "tok-1", body: checkIn({ weight: 180.2 }) })).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(backend.historyWrites.map(row => [row.p_change_kind, row.p_fields])).toEqual([
      ["create", [{ field: "weight", old: null, new: 182.4 }]],
      ["update", [{ field: "weight", old: 182.4, new: 181 }]],
      ["update", [{ field: "weight", old: 181, new: 180.2 }]],
    ]);
    expect(backend.historyWrites[0]).toMatchObject({
      p_patient_id: mine.patientId, p_family: "weight", p_record_id: "check-in:2026-08-30", p_actor_kind: "patient",
      p_actor_user_id: mine.userId, p_actor_name: null, p_audit_event_id: null,
    });
    expect(backend.tables.patient_check_ins).toHaveLength(2);
  });
});

describe("PUT /patient-data/targets", () => {
  it("merges partial updates instead of clobbering other fields", async () => {
    backend.seedSignedInPatient("tok-1");
    await api("PUT", "/api/patient-data/targets", { token: "tok-1", body: { calories: 1500 } });
    await api("PUT", "/api/patient-data/targets", {
      token: "tok-1",
      body: { waterOz: 70, protein: 120 },
    });
    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.targets).toEqual({ calories: 1500, protein: 120, waterOz: 70 });
    expect(backend.tables.patient_target_overrides).toHaveLength(1);
  });

  it("rejects empty and out-of-range payloads", async () => {
    backend.seedSignedInPatient("tok-1");
    const empty = await api("PUT", "/api/patient-data/targets", { token: "tok-1", body: {} });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe("Nothing to save.");
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ calories: 20001 }, "Calorie target is invalid."],
      [{ protein: -1 }, "Protein target is invalid."],
      [{ carbs: 9999 }, "Carb target is invalid."],
      [{ fat: Number.NaN }, "Fat target is invalid."],
      [{ waterOz: 500 }, "Water target is invalid."],
    ];
    for (const [body, message] of cases) {
      const res = await api("PUT", "/api/patient-data/targets", { token: "tok-1", body });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe(message);
    }
  });
});

describe("PUT /patient-data/prefs", () => {
  it("writes favorites and recents, merging partial updates", async () => {
    backend.seedSignedInPatient("tok-1");
    await api("PUT", "/api/patient-data/prefs", {
      token: "tok-1",
      body: { favorites: ["oatmeal", "salmon"], recents: ["salmon"] },
    });
    // A recents-only follow-up must not wipe favorites.
    await api("PUT", "/api/patient-data/prefs", {
      token: "tok-1",
      body: { recents: ["oatmeal", "salmon"] },
    });
    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.favorites).toEqual(["oatmeal", "salmon"]);
    expect(state.json.recents).toEqual(["oatmeal", "salmon"]);
    expect(backend.tables.patient_food_prefs).toHaveLength(1);
  });

  it("rejects empty payloads and malformed lists", async () => {
    backend.seedSignedInPatient("tok-1");
    const empty = await api("PUT", "/api/patient-data/prefs", { token: "tok-1", body: {} });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe("Nothing to save.");
    const bad = await api("PUT", "/api/patient-data/prefs", {
      token: "tok-1",
      body: { favorites: ["ok", 42] },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("Favorites list is invalid.");
  });
});

// ── Foods library (custom foods + saved recipes) ────────────────────────────

function mediaPath(patientId: string, rest: string): string {
  return `/objects/patient-media/${patientId}/${rest}`;
}

function foodPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "custom-1",
    name: "Overnight Oats",
    brand: "Homemade",
    serving: "1 jar (240 g)",
    calories: 320,
    protein: 18,
    carbs: 45,
    fat: 8,
    ...overrides,
  };
}

function recipePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "airec-1",
    name: "Tuscan Chicken Skillet",
    meal: "dinner",
    mode: "recipe",
    tags: ["High protein", "One pan"],
    minutes: 25,
    servings: 2,
    calories: 410,
    protein: 38,
    carbs: 22,
    fat: 17,
    description: "A one-pan dinner the coach suggested.",
    ingredients: [
      {
        amount: 8,
        unit: "oz",
        name: "Chicken breast",
        nutrition: { calories: 220, protein: 41, carbs: 0, fat: 5 },
      },
      { amount: 1, unit: "cup", name: "Cherry tomatoes" },
    ],
    steps: ["Sear the chicken.", "Simmer with tomatoes."],
    groceryList: ["Chicken breast", "Cherry tomatoes"],
    savedAt: "2026-08-30T18:04:05.000Z",
    ...overrides,
  };
}

describe("POST /patient-data/library", () => {
  it("round-trips an account-private exact catalog configuration separately from My Foods", async () => {
    backend.seedSignedInPatient("tok-1");
    const snapshot = nutritionSnapshot();
    const write = await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: {
        foodUpsert: [foodPayload({
          id: "usda:171077",
          catalogShared: true,
          catalogSourceLabel: "USDA FoodData Central",
          catalogLookupId: "usda:171077",
          catalogApproved: true,
          nutritionSnapshot: snapshot,
        })],
        favorites: ["usda:171077"],
      },
    });
    expect(write.status).toBe(200);
    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.customFoods).toEqual([]);
    expect(state.json.catalogFoods).toEqual([
      expect.objectContaining({
        id: "usda:171077",
        catalogShared: true,
        catalogLookupId: "usda:171077",
        nutritionSnapshot: snapshot,
      }),
    ]);
    expect(state.json.favorites).toEqual(["usda:171077"]);
  });

  it("round-trips a custom food through the state read (client shape, category injected)", async () => {
    backend.seedSignedInPatient("tok-1");
    const write = await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { foodUpsert: [foodPayload()] },
    });
    expect(write.status).toBe(200);

    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.customFoods).toEqual([
      {
        id: "custom-1",
        name: "Overnight Oats",
        brand: "Homemade",
        serving: "1 jar (240 g)",
        calories: 320,
        protein: 18,
        carbs: 45,
        fat: 8,
        category: "My Foods",
      },
    ]);
    // The category is a client constant — never a stored column.
    expect(backend.tables.patient_custom_foods[0]).not.toHaveProperty("category");
  });

  it("round-trips a saved recipe verbatim, source injected and savedAt untouched", async () => {
    backend.seedSignedInPatient("tok-1");
    const write = await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { recipeUpsert: [recipePayload()] },
    });
    expect(write.status).toBe(200);

    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    const { id: _id, ...expected } = recipePayload();
    expect(state.json.savedRecipes).toEqual([
      { id: "airec-1", ...expected, source: "coach" },
    ]);
    expect(backend.tables.patient_saved_recipes[0]).not.toHaveProperty("source");
    expect(backend.tables.patient_saved_recipes[0].saved_at).toBe("2026-08-30T18:04:05.000Z");
  });

  it("omits optional fields (brand, groceryList, photoPath) instead of nulling them", async () => {
    backend.seedSignedInPatient("tok-1");
    await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: {
        foodUpsert: [foodPayload({ brand: undefined })],
        recipeUpsert: [recipePayload({ groceryList: undefined, description: undefined })],
      },
    });
    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.customFoods[0]).not.toHaveProperty("brand");
    expect(state.json.customFoods[0]).not.toHaveProperty("photoPath");
    expect(state.json.savedRecipes[0]).not.toHaveProperty("groceryList");
    expect(state.json.savedRecipes[0]).not.toHaveProperty("photoPath");
    expect(state.json.savedRecipes[0].description).toBe("");
  });

  it("keeps insertion order across edits (created_at preserved on merge)", async () => {
    backend.seedSignedInPatient("tok-1");
    await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: {
        foodUpsert: [
          foodPayload({ id: "custom-a", name: "First" }),
          foodPayload({ id: "custom-b", name: "Second" }),
        ],
      },
    });
    await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { foodUpsert: [foodPayload({ id: "custom-a", name: "First Edited" })] },
    });
    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.customFoods.map((f: any) => f.name)).toEqual(["First Edited", "Second"]);
    expect(backend.tables.patient_custom_foods).toHaveLength(2);
  });

  it("applies a compound mutation through one atomic upstream call", async () => {
    backend.seedSignedInPatient("tok-1");
    const before = backend.libraryRpcCalls;
    const res = await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: {
        foodUpsert: [foodPayload()],
        recipeUpsert: [recipePayload()],
        favorites: ["custom-1"],
        recents: ["custom-1"],
      },
    });
    expect(res.status).toBe(200);
    expect(backend.libraryRpcCalls - before).toBe(1);
    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.customFoods).toHaveLength(1);
    expect(state.json.savedRecipes).toHaveLength(1);
    expect(state.json.favorites).toEqual(["custom-1"]);
    expect(state.json.recents).toEqual(["custom-1"]);
  });

  it("stores photo paths and keeps the account's media ledger in lockstep", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    const photoA = mediaPath(patientId, "food-aaaaaaaa-1111-4111-8111-111111111111");
    const photoB = mediaPath(patientId, "food-bbbbbbbb-2222-4222-8222-222222222222");

    // Save with photo A → referenced.
    await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { foodUpsert: [foodPayload({ photoPath: photoA })] },
    });
    let state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.customFoods[0].photoPath).toBe(photoA);
    expect(backend.tables.patient_media.map(r => r.object_path)).toEqual([photoA]);

    // Replace with photo B → A de-referenced, B registered.
    await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { foodUpsert: [foodPayload({ photoPath: photoB })] },
    });
    expect(backend.tables.patient_media.map(r => r.object_path)).toEqual([photoB]);

    // Delete the food → nothing referenced any more.
    await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { foodDeleteIds: ["custom-1"], favorites: [], recents: [] },
    });
    expect(backend.tables.patient_custom_foods).toHaveLength(0);
    expect(backend.tables.patient_media).toHaveLength(0);

    // Undo restores the same row → its photo is referenced again.
    await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { foodUpsert: [foodPayload({ photoPath: photoB })], favorites: [], recents: [] },
    });
    state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.customFoods[0].photoPath).toBe(photoB);
    expect(backend.tables.patient_media.map(r => r.object_path)).toEqual([photoB]);
  });

  it("lets favorites/recents ride a delete without clobbering the other list", async () => {
    backend.seedSignedInPatient("tok-1");
    await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { foodUpsert: [foodPayload()], favorites: ["custom-1", "oatmeal"], recents: ["custom-1"] },
    });
    // Delete strips the food from favorites but says nothing about recents.
    await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { foodDeleteIds: ["custom-1"], favorites: ["oatmeal"] },
    });
    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.json.favorites).toEqual(["oatmeal"]);
    expect(state.json.recents).toEqual(["custom-1"]);
  });

  it("rejects photo paths outside the caller's own prefix", async () => {
    backend.seedSignedInPatient("tok-1");
    const { patientId: otherId } = backend.seedSignedInPatient("tok-2");
    for (const path of [
      mediaPath(otherId, "food-aaaaaaaa-1111-4111-8111-111111111111"),
      "/objects/progress-photos/front-abc12345",
      "../escape",
    ]) {
      const res = await api("POST", "/api/patient-data/library", {
        token: "tok-1",
        body: { foodUpsert: [foodPayload({ photoPath: path })] },
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("Photo reference is invalid.");
    }
    expect(backend.tables.patient_custom_foods).toHaveLength(0);
  });

  it("rejects malformed foods field by field", async () => {
    backend.seedSignedInPatient("tok-1");
    const cases: Array<[Record<string, unknown>, string]> = [
      [foodPayload({ id: "bad id" }), "Food id is invalid."],
      [foodPayload({ name: "x".repeat(201) }), "Food name must be 1-200 characters."],
      [foodPayload({ name: "   " }), "Food name must be 1-200 characters."],
      [foodPayload({ brand: "x".repeat(121) }), "Food brand is invalid."],
      [foodPayload({ serving: "" }), "Food serving is invalid."],
      [foodPayload({ calories: -1 }), "Food calories are invalid."],
      [foodPayload({ protein: Number.NaN }), "Food protein is invalid."],
      [foodPayload({ carbs: "12" }), "Food carbs are invalid."],
      [foodPayload({ fat: 5001 }), "Food fat is invalid."],
    ];
    for (const [food, message] of cases) {
      const res = await api("POST", "/api/patient-data/library", {
        token: "tok-1",
        body: { foodUpsert: [food] },
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe(message);
    }
    expect(backend.tables.patient_custom_foods).toHaveLength(0);
  });

  it("rejects malformed recipes field by field", async () => {
    backend.seedSignedInPatient("tok-1");
    const cases: Array<[Record<string, unknown>, string]> = [
      [recipePayload({ meal: "brunch" }), "Recipe meal slot is invalid."],
      [recipePayload({ mode: "improv" }), "Recipe mode is invalid."],
      [recipePayload({ tags: Array(13).fill("tag") }), "Recipe tags are invalid."],
      [recipePayload({ minutes: 2001 }), "Recipe minutes are invalid."],
      [recipePayload({ servings: -1 }), "Recipe servings are invalid."],
      [recipePayload({ description: "x".repeat(2001) }), "Recipe description is too long."],
      [recipePayload({ ingredients: [{ amount: 1, unit: "cup" }] }), "Recipe ingredients are invalid."],
      [
        recipePayload({
          ingredients: [{ amount: 1, unit: "cup", name: "Rice", nutrition: { calories: -5, protein: 0, carbs: 0, fat: 0 } }],
        }),
        "Recipe ingredients are invalid.",
      ],
      [recipePayload({ steps: ["x".repeat(601)] }), "Recipe steps are invalid."],
      [recipePayload({ groceryList: [42] }), "Recipe grocery list is invalid."],
      [recipePayload({ savedAt: "x".repeat(41) }), "Recipe save time is invalid."],
      [recipePayload({ savedAt: "" }), "Recipe save time is invalid."],
    ];
    for (const [recipe, message] of cases) {
      const res = await api("POST", "/api/patient-data/library", {
        token: "tok-1",
        body: { recipeUpsert: [recipe] },
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe(message);
    }
    expect(backend.tables.patient_saved_recipes).toHaveLength(0);
  });

  it("rejects oversized batches, bad delete lists, and empty payloads", async () => {
    backend.seedSignedInPatient("tok-1");
    const bigFoods = await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { foodUpsert: Array(41).fill(foodPayload()) },
    });
    expect(bigFoods.status).toBe(400);
    expect(bigFoods.json.error).toBe("Food batch is invalid (at most 40 foods).");

    const bigRecipes = await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { recipeUpsert: Array(21).fill(recipePayload()) },
    });
    expect(bigRecipes.status).toBe(400);
    expect(bigRecipes.json.error).toBe("Recipe batch is invalid (at most 20 recipes).");

    const badDeletes = await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { foodDeleteIds: ["ok", "not ok"] },
    });
    expect(badDeletes.status).toBe(400);
    expect(badDeletes.json.error).toBe("Food delete list is invalid.");

    const badRecipeDeletes = await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { recipeDeleteIds: [42] },
    });
    expect(badRecipeDeletes.status).toBe(400);
    expect(badRecipeDeletes.json.error).toBe("Recipe delete list is invalid.");

    const empty = await api("POST", "/api/patient-data/library", { token: "tok-1", body: {} });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe("Nothing to save.");
  });

  it("commits nothing when the atomic apply fails — and the retry lands", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.failOnce.add("RPC patient_library_apply");
    const failed = await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { foodUpsert: [foodPayload()], favorites: ["custom-1"] },
    });
    expect(failed.status).toBe(502);
    expect(failed.json.error).toBe("Couldn't save your library right now. Please try again.");
    expect(backend.tables.patient_custom_foods).toHaveLength(0);
    expect(backend.tables.patient_food_prefs).toHaveLength(0);

    const retry = await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { foodUpsert: [foodPayload()], favorites: ["custom-1"] },
    });
    expect(retry.status).toBe(200);
    expect(backend.tables.patient_custom_foods).toHaveLength(1);
  });

  it("never mixes two patients' libraries — deletes stay scoped to the caller", async () => {
    const { patientId: firstId } = backend.seedSignedInPatient("tok-1");
    backend.seedSignedInPatient("tok-2");
    const photo = mediaPath(firstId, "food-aaaaaaaa-1111-4111-8111-111111111111");
    await api("POST", "/api/patient-data/library", {
      token: "tok-1",
      body: { foodUpsert: [foodPayload({ photoPath: photo })], recipeUpsert: [recipePayload()] },
    });
    await api("POST", "/api/patient-data/library", {
      token: "tok-2",
      body: { foodUpsert: [foodPayload()] },
    });

    // The other account sees none of it.
    const other = await api("GET", "/api/patient-data/state", { token: "tok-2" });
    expect(other.json.customFoods).toHaveLength(1);
    expect(other.json.customFoods[0]).not.toHaveProperty("photoPath");
    expect(other.json.savedRecipes).toEqual([]);

    // A same-id delete from the other account touches only its own rows.
    await api("POST", "/api/patient-data/library", {
      token: "tok-2",
      body: { foodDeleteIds: ["custom-1"] },
    });
    const mine = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(mine.json.customFoods).toHaveLength(1);
    expect(mine.json.customFoods[0].photoPath).toBe(photo);
    expect(backend.tables.patient_media.map(r => r.object_path)).toEqual([photo]);
  });

  it("responds 502 with a friendly message when the library read is down", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.failOnce.add("GET patient_custom_foods");
    const res = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("Couldn't load your diary right now. Please try again.");
  });
});

describe("medications and dose logs", () => {
  const MED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const LOG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const NY = "America/New_York";
  const todayNY = () => new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const shift = (key: string, days: number) => {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  };
  const dailyMed = (over: Record<string, unknown> = {}) => ({
    id: MED, name: "THINNR Protocol drops", form: "drops", dose: "1 mL", scheduleKind: "daily", times: ["08:00", "15:00", "22:00"],
    weekday: null, notes: null, startDate: "2026-01-01", stopDate: null, ...over,
  });

  const withContact = (patientId: string, n: number) =>
    Object.assign(backend.tables.patients.find(row => row.id === patientId)!, { email: `p${n}@example.com`, phone: `+1555000${1000 + n}` });

  it("completing setup seeds the list from the program choice once, and the state read carries it", async () => {
    const mine = backend.seedSignedInPatient("tok-1");
    withContact(mine.patientId, 1);
    const profile = {
      firstName: "Casey", lastName: "Ortiz", dateOfBirth: "1985-04-03", heightInches: 66, startingWeight: 200, currentWeight: 200,
      goalWeight: 160, timezone: NY, programId: "thinnr", programStartDate: "2026-08-20",
    };
    const done = await api("POST", "/api/patient-data/setup/complete", {
      token: "tok-1",
      body: { profile, onboardingAnswers: { program: "thinnr", reminderMorning: "7:30 AM", reminderAfternoon: "2:30 PM", reminderEvening: "9:30 PM" } },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(backend.tables.patient_medications).toHaveLength(1);
    expect(backend.tables.patient_medications[0]).toMatchObject({
      patient_id: mine.patientId, name: "THINNR Protocol drops", form: "drops", schedule_kind: "daily", times: ["07:30", "14:30", "21:30"],
      start_date: "2026-08-20", source: "onboarding",
    });
    // A re-run (retry after a lost response) never duplicates the record.
    await api("POST", "/api/patient-data/setup/complete", { token: "tok-1", body: { profile, onboardingAnswers: { program: "thinnr" } } });
    expect(backend.tables.patient_medications).toHaveLength(1);

    const state = await api("GET", "/api/patient-data/state", { token: "tok-1" });
    expect(state.status).toBe(200);
    expect(state.json.medications).toEqual([expect.objectContaining({ name: "THINNR Protocol drops", times: ["07:30", "14:30", "21:30"] })]);
    expect(state.json.doseLogs).toEqual([]);

    // GLP-1 seeds a weekly injection on the chosen day; without a day nothing is seeded.
    withContact(backend.seedSignedInPatient("tok-2").patientId, 2);
    await api("POST", "/api/patient-data/setup/complete", {
      token: "tok-2",
      body: { profile: { ...profile, programId: "glp1" }, onboardingAnswers: { program: "glp1", injectionDay: 3, injectionTime: "9:00 AM" } },
    });
    const shot = backend.tables.patient_medications.find(row => row.patient_id !== mine.patientId);
    expect(shot).toMatchObject({ name: "GLP-1 injection", form: "injection", schedule_kind: "weekly", weekday: 3, times: ["09:00"] });
    withContact(backend.seedSignedInPatient("tok-3").patientId, 3);
    await api("POST", "/api/patient-data/setup/complete", {
      token: "tok-3",
      body: { profile: { ...profile, programId: "glp1" }, onboardingAnswers: { program: "glp1" } },
    });
    expect(backend.tables.patient_medications).toHaveLength(2);
  });

  it("upserts a medication owned by the caller, validates it, and refuses an id that belongs to someone else", async () => {
    const mine = backend.seedSignedInPatient("tok-1");
    const other = backend.seedSignedInPatient("tok-2");
    const created = await api("PUT", "/api/patient-data/medications", { token: "tok-1", body: { medication: dailyMed() } });
    expect(created.status).toBe(200);
    expect(created.json.medication).toMatchObject({ id: MED, name: "THINNR Protocol drops", source: "patient", stopDate: null });
    expect(backend.tables.patient_medications[0]).toMatchObject({ patient_id: mine.patientId, source: "patient" });

    const edited = await api("PUT", "/api/patient-data/medications", { token: "tok-1", body: { medication: dailyMed({ dose: "2 mL", stopDate: "2026-12-31" }) } });
    expect(edited.status).toBe(200);
    expect(backend.tables.patient_medications).toHaveLength(1);
    expect(backend.tables.patient_medications[0]).toMatchObject({ dose: "2 mL", stop_date: "2026-12-31", source: "patient" });
    // The patient's own edits append to the same edit history staff corrections
    // use, attributed to the patient: a create snapshot, then only the changed fields.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(backend.historyWrites.map(row => [row.p_family, row.p_change_kind, row.p_actor_kind, row.p_actor_name, row.p_audit_event_id])).toEqual([
      ["medication", "create", "patient", null, null],
      ["medication", "update", "patient", null, null],
    ]);
    expect(backend.historyWrites[0]).toMatchObject({ p_patient_id: mine.patientId, p_record_id: MED, p_actor_user_id: mine.userId });
    expect((backend.historyWrites[0].p_fields as Row[]).find(f => f.field === "dose")).toEqual({ field: "dose", old: null, new: "1 mL" });
    expect(backend.historyWrites[1].p_fields).toEqual([{ field: "dose", old: "1 mL", new: "2 mL" }, { field: "stopDate", old: null, new: "2026-12-31" }]);

    const stolen = await api("PUT", "/api/patient-data/medications", { token: "tok-2", body: { medication: dailyMed({ name: "Mine now" }) } });
    expect(stolen.status).toBe(400);
    expect(stolen.json.field).toBe("id");
    expect(backend.tables.patient_medications[0]).toMatchObject({ patient_id: mine.patientId, name: "THINNR Protocol drops" });
    expect(backend.tables.patient_medications.some(row => row.patient_id === other.patientId)).toBe(false);

    for (const bad of [
      dailyMed({ id: "not-a-uuid" }),
      dailyMed({ name: "   " }),
      dailyMed({ times: ["25:00"] }),
      dailyMed({ scheduleKind: "weekly", weekday: 7 }),
      dailyMed({ startDate: "2026-02-30" }),
      dailyMed({ stopDate: "2025-01-01" }),
    ]) {
      const res = await api("PUT", "/api/patient-data/medications", { token: "tok-1", body: { medication: bad } });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(typeof res.json.field).toBe("string");
    }

    const list = await api("GET", "/api/patient-data/medications", { token: "tok-1" });
    expect(list.status).toBe(200);
    expect(list.json.medications).toHaveLength(1);
    const otherList = await api("GET", "/api/patient-data/medications", { token: "tok-2" });
    expect(otherList.json.medications).toEqual([]);
  });

  it("logs, corrects, and clears a dose within the seven-day window, one decision per scheduled occurrence", async () => {
    const mine = backend.seedSignedInPatient("tok-1");
    backend.tables.patients.find(row => row.id === mine.patientId)!.timezone = NY;
    backend.seedSignedInPatient("tok-2");
    await api("PUT", "/api/patient-data/medications", { token: "tok-1", body: { medication: dailyMed() } });
    const today = todayNY();
    const dose = (over: Record<string, unknown> = {}) => ({ id: LOG, medicationId: MED, dueDate: today, dueTime: "08:00", status: "taken", source: "reminder", ...over });

    const taken = await api("POST", "/api/patient-data/medication-doses", { token: "tok-1", body: dose() });
    expect(taken.status).toBe(200);
    expect(taken.json.log).toMatchObject({ id: LOG, medicationId: MED, dueDate: today, dueTime: "08:00", status: "taken", source: "reminder" });
    expect(backend.tables.patient_medication_dose_logs).toEqual([expect.objectContaining({ patient_id: mine.patientId, status: "taken" })]);

    // A second decision for the same occurrence merges rather than duplicating (unique per occurrence).
    const corrected = await api("POST", "/api/patient-data/medication-doses", { token: "tok-1", body: dose({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "skipped", source: "check_in" }) });
    expect(corrected.status).toBe(200);
    expect(backend.tables.patient_medication_dose_logs).toHaveLength(1);
    expect(backend.tables.patient_medication_dose_logs[0]).toMatchObject({ status: "skipped", source: "check_in" });

    // Six days back is a correction; eight days back is outside the window; tomorrow+1 is future.
    expect((await api("POST", "/api/patient-data/medication-doses", { token: "tok-1", body: dose({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", dueDate: shift(today, -6) }) })).status).toBe(200);
    const late = await api("POST", "/api/patient-data/medication-doses", { token: "tok-1", body: dose({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", dueDate: shift(today, -8) }) });
    expect(late.status).toBe(400);
    expect(late.json.field).toBe("dueDate");
    const future = await api("POST", "/api/patient-data/medication-doses", { token: "tok-1", body: dose({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff", dueDate: shift(today, 2) }) });
    expect(future.status).toBe(400);
    expect(future.json.error).toMatch(/isn't due yet/);
    // Not a scheduled time for this medication.
    const offSchedule = await api("POST", "/api/patient-data/medication-doses", { token: "tok-1", body: dose({ id: "ffffffff-ffff-4fff-8fff-fffffffffff0", dueTime: "09:00" }) });
    expect(offSchedule.status).toBe(400);
    expect(offSchedule.json.field).toBe("dueTime");
    // Another account cannot log against this medication.
    expect((await api("POST", "/api/patient-data/medication-doses", { token: "tok-2", body: dose() })).status).toBe(404);
    expect(backend.tables.patient_medication_dose_logs).toHaveLength(2);

    // Clearing a decision removes the row; the same idempotency key replays without a second write.
    const cleared = await api("POST", "/api/patient-data/medication-doses", {
      token: "tok-1", headers: { "Idempotency-Key": "q_dose.clear:1" }, body: dose({ status: null }),
    });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toEqual({ deleted: true });
    expect(backend.tables.patient_medication_dose_logs).toHaveLength(1);
    const replay = await api("POST", "/api/patient-data/medication-doses", {
      token: "tok-1", headers: { "Idempotency-Key": "q_dose.clear:1" }, body: dose({ status: null }),
    });
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(backend.tables.patient_write_receipts.filter(row => row.patient_id === mine.patientId)).toHaveLength(1);
  });
});
