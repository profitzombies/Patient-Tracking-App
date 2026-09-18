/**
 * Progress-on-the-account routes suite — photos, check-ins, and flags.
 *
 * Runs against an in-memory fake of the Supabase REST + GoTrue surfaces
 * (same harness family as patient-data.test.ts, trimmed to the tables this
 * slice touches) with object storage mocked, so the grid-row contract, the
 * same-day check-in replacement, the partial flag merge, rows-before-bytes
 * photo deletion, and cross-patient isolation can all be exercised
 * deterministically. The diary rail's auth ladder and limiter mechanics are
 * covered in patient-data.test.ts; this file focuses on what the progress
 * slice adds.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_POLICY_VERSION } from "../privacy/consent";
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

const FAKE_SUPABASE = "http://fake.supabase.local";

type Row = Record<string, unknown>;

const storageState = vi.hoisted(() => ({
  deleted: [] as string[],
  failDelete: false,
}));

// patient-data.ts (byte deletes) and patient-media.ts (finalize helpers)
// both import this module; the router under test only ever calls
// deleteObjectStrict, the rest exists so the import graph resolves.
vi.mock("../lib/objectStorage", () => {
  class ObjectNotFoundError extends Error {}
  return {
    ObjectNotFoundError,
    THUMBNAIL_CONTENT_TYPES: new Set(["image/jpeg", "image/png", "image/webp"]),
    detectThumbnailContentType: () => "image/jpeg",
    objectStorage: {
      deleteObjectStrict: vi.fn(async (path: string) => {
        if (storageState.failDelete) throw new Error("storage refused the delete");
        storageState.deleted.push(path);
      }),
    },
  };
});

/** Lexicographically sortable fake created_at stamps. */
function stampAt(seq: number): string {
  return `2026-08-01T00:00:${String(seq).padStart(2, "0")}.000Z`;
}

class FakeBackend {
  tables: Record<string, Row[]> = {};
  /** access token → auth user id */
  tokens = new Map<string, string>();
  /** one-shot 500s keyed `${method} ${table}` or `RPC patient_progress_photos_remove` */
  failOnce = new Set<string>();
  /** Number of atomic remove RPC calls received. */
  removeRpcCalls = 0;
  private seq = 0;

  reset() {
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
      patient_medications: [],
      patient_medication_dose_logs: [],
      patient_flags: [],
      patient_consents: [],
      patient_data_exports: [],
      patient_deletion_requests: [],
      patient_write_receipts: [],
    };
    this.tokens.clear();
    this.failOnce.clear();
    this.removeRpcCalls = 0;
    this.seq = 0;
  }

  /** Signed-in patient: auth user + token + linked patients row. */
  seedSignedInPatient(token: string, options: { consent?: boolean } = {}): { patientId: string; userId: string } {
    const userId = crypto.randomUUID();
    this.tokens.set(token, userId);
    const patientId = crypto.randomUUID();
    this.tables.patients.push({ id: patientId, auth_user_id: userId, name: "Casey Patient" });
    // Every data route enforces the current consent policy version.
    if (options.consent !== false) {
      this.tables.patient_consents.push({
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
      });
    }
    return { patientId, userId };
  }

  /** The ledger row finalize would have written for an uploaded object. */
  seedLedger(patientId: string, objectPath: string) {
    this.tables.patient_media.push({
      object_path: objectPath,
      patient_id: patientId,
      kind: "progress",
      content_type: "image/jpeg",
      size_bytes: 4321,
      created_at: stampAt(this.seq++),
    });
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
      const token = (headers.get("authorization") ?? "").replace(/^Bearer /i, "");
      const userId = this.tokens.get(token);
      if (!userId) return json(401, { message: "invalid token" });
      return json(200, { id: userId, email: null, phone: null });
    }

    if (url.pathname === "/rest/v1/rpc/patient_progress_photos_remove") {
      this.removeRpcCalls += 1;
      if (this.failOnce.has("RPC patient_progress_photos_remove")) {
        this.failOnce.delete("RPC patient_progress_photos_remove");
        return json(500, { message: "fake upstream failure" });
      }
      // Mirrors the SQL function: ONE transaction — drop the grid rows and
      // their media-ledger rows, return the object paths that were removed.
      const args = JSON.parse(String(init?.body ?? "{}")) as {
        p_patient_id: string;
        p_photo_ids?: string[];
      };
      const doomed = new Set(args.p_photo_ids ?? []);
      const removed = this.tables.patient_progress_photos.filter(
        row => String(row.patient_id) === args.p_patient_id && doomed.has(String(row.photo_id)),
      );
      const paths = removed.map(row => String(row.object_path));
      this.tables.patient_progress_photos = this.tables.patient_progress_photos.filter(
        row => !(String(row.patient_id) === args.p_patient_id && doomed.has(String(row.photo_id))),
      );
      this.tables.patient_media = this.tables.patient_media.filter(
        row =>
          !(
            String(row.patient_id) === args.p_patient_id &&
            paths.includes(String(row.object_path))
          ),
      );
      return json(200, paths);
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
      const payload = JSON.parse(String(init?.body ?? "[]")) as Row[];
      const prefer = headers.get("prefer") ?? "";
      const ignoreDuplicates = prefer.includes("resolution=ignore-duplicates");
      const written: Row[] = [];
      for (const incoming of payload) {
        const existing = conflictCols.length
          ? this.tables[table].find(row =>
              conflictCols.every(col => String(row[col] ?? "") === String(incoming[col] ?? "")),
            )
          : undefined;
        // PostgREST ignore-duplicates: the conflicting row is left alone and
        // is NOT part of the returned representation.
        if (existing && ignoreDuplicates) continue;
        // The live table also carries unique (patient_id, object_path): a
        // row reusing an object that a DIFFERENT photo row already owns
        // trips 23505, which PostgREST surfaces as 409.
        if (table === "patient_progress_photos") {
          const clash = this.tables[table].find(
            row =>
              row !== existing &&
              String(row.patient_id) === String(incoming.patient_id) &&
              String(row.object_path) === String(incoming.object_path),
          );
          if (clash) return json(409, { code: "23505", message: "duplicate key value" });
        }
        if (existing) {
          // PostgREST merge-duplicates: update ONLY the payload's columns.
          Object.assign(existing, incoming);
          written.push(existing);
        } else {
          const row = { created_at: stampAt(this.seq++), ...incoming };
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

function progressPath(patientId: string, suffix = "11111111-1111-4111-8111-111111111111"): string {
  return `/objects/patient-media/${patientId}/progress-${suffix}`;
}

function photoPayload(patientId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p-1",
    dateKey: "2026-08-30",
    label: "Week 12",
    angle: "front",
    objectPath: progressPath(patientId),
    ...overrides,
  };
}

function checkInPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c-1",
    dateKey: "2026-08-30",
    weight: 182.4,
    mood: 4,
    sideEffects: ["Mild nausea"],
    notes: "Feeling steadier this week.",
    ...overrides,
  };
}

async function fetchState(token: string): Promise<any> {
  const res = await api("GET", "/api/patient-data/state", { token });
  expect(res.status).toBe(200);
  return res.json;
}

beforeAll(async () => {
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
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
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: (obj: { err?: Error }, msg: string) =>
        console.log("ROUTELOG", msg, obj?.err?.message ?? obj),
      warn: () => {},
    };
    next();
  });
  app.use("/api", patientDataRouter);
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
  storageState.deleted.length = 0;
  storageState.failDelete = false;
});

describe("auth", () => {
  it("rejects the progress routes without a bearer token", async () => {
    for (const [method, path, body] of [
      ["POST", "/api/patient-data/check-ins", checkInPayload()],
      ["POST", "/api/patient-data/photos", { deleteIds: ["p-1"] }],
      ["PUT", "/api/patient-data/flags", { nudgeOptOut: true }],
    ] as const) {
      const res = await api(method, path, { body });
      expect(res.status).toBe(401);
      expect(res.json.error).toBe("Sign in required.");
    }
  });
});

describe("POST /patient-data/check-ins", () => {
  it("stores a check-in and the state read returns it for the weight chart", async () => {
    backend.seedSignedInPatient("tok-1");
    const res = await api("POST", "/api/patient-data/check-ins", {
      token: "tok-1",
      body: checkInPayload(),
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });

    const state = await fetchState("tok-1");
    expect(state.checkIns).toEqual([
      {
        id: "c-1",
        dateKey: "2026-08-30",
        weight: 182.4,
        mood: 4,
        sideEffects: ["Mild nausea"],
        notes: "Feeling steadier this week.",
      },
    ]);
  });

  it("replaces a same-day check-in wholesale (id included, absent fields cleared)", async () => {
    backend.seedSignedInPatient("tok-1");
    await api("POST", "/api/patient-data/check-ins", { token: "tok-1", body: checkInPayload() });
    const res = await api("POST", "/api/patient-data/check-ins", {
      token: "tok-1",
      body: { id: "c-2", dateKey: "2026-08-30", mood: 2, sideEffects: [] },
    });
    expect(res.status).toBe(200);

    const state = await fetchState("tok-1");
    // One row for the day, carrying ONLY the second submission's answers.
    expect(state.checkIns).toEqual([
      { id: "c-2", dateKey: "2026-08-30", mood: 2, sideEffects: [] },
    ]);
    expect(backend.tables.patient_check_ins).toHaveLength(1);
  });

  it("keeps different days as separate rows, ordered by date", async () => {
    backend.seedSignedInPatient("tok-1");
    await api("POST", "/api/patient-data/check-ins", {
      token: "tok-1",
      body: checkInPayload({ id: "c-later", dateKey: "2026-08-30", weight: 181 }),
    });
    await api("POST", "/api/patient-data/check-ins", {
      token: "tok-1",
      body: checkInPayload({ id: "c-earlier", dateKey: "2026-08-23", weight: 183.5 }),
    });

    const state = await fetchState("tok-1");
    expect(state.checkIns.map((c: any) => [c.id, c.weight])).toEqual([
      ["c-earlier", 183.5],
      ["c-later", 181],
    ]);
  });

  it("rejects malformed check-ins field by field", async () => {
    backend.seedSignedInPatient("tok-1");
    const cases: Array<Record<string, unknown>> = [
      checkInPayload({ id: "bad id!" }),
      checkInPayload({ dateKey: "2026-02-30" }),
      checkInPayload({ weight: 0 }),
      checkInPayload({ weight: "182" }),
      checkInPayload({ mood: 0 }),
      checkInPayload({ mood: 3.5 }),
      checkInPayload({ sideEffects: "Nausea" }),
      checkInPayload({ sideEffects: ["x".repeat(61)] }),
      checkInPayload({ notes: "" }),
      checkInPayload({ notes: "x".repeat(2001) }),
    ];
    for (const body of cases) {
      const res = await api("POST", "/api/patient-data/check-ins", { token: "tok-1", body });
      expect(res.status).toBe(400);
    }
    expect(backend.tables.patient_check_ins).toHaveLength(0);
  });

  it("responds 502 with a friendly message when the store is down", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.failOnce.add("POST patient_check_ins");
    const res = await api("POST", "/api/patient-data/check-ins", {
      token: "tok-1",
      body: checkInPayload(),
    });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("Couldn't save your check-in right now. Please try again.");
  });

  it("never mixes two patients' check-ins", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.seedSignedInPatient("tok-2");
    await api("POST", "/api/patient-data/check-ins", { token: "tok-1", body: checkInPayload() });

    const other = await fetchState("tok-2");
    expect(other.checkIns).toEqual([]);
  });
});

describe("POST /patient-data/photos — grid rows", () => {
  it("replays a keyed photo write from its receipt — the delete RPC never re-runs", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    backend.seedLedger(patientId, progressPath(patientId));
    await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { upsert: [photoPayload(patientId, { id: "p-front", angle: "front" })] },
    });
    const send = () =>
      api("POST", "/api/patient-data/photos", {
        token: "tok-1",
        headers: { "Idempotency-Key": "q_photos_remove_1" },
        body: { deleteIds: ["p-front"] },
      });
    const first = await send();
    expect(first.status).toBe(200);
    expect(backend.removeRpcCalls).toBe(1);
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(backend.removeRpcCalls).toBe(1);
    expect(backend.tables.patient_write_receipts).toHaveLength(1);
  });

  it("records uploaded photos and the state read lists them in insertion order", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    backend.seedLedger(patientId, progressPath(patientId));
    backend.seedLedger(patientId, progressPath(patientId, "22222222-2222-4222-8222-222222222222"));
    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: {
        upsert: [
          photoPayload(patientId, { id: "p-front", angle: "front" }),
          photoPayload(patientId, {
            id: "p-side",
            angle: "side",
            objectPath: progressPath(patientId, "22222222-2222-4222-8222-222222222222"),
          }),
        ],
      },
    });
    expect(res.status).toBe(200);

    const state = await fetchState("tok-1");
    expect(state.photos).toEqual([
      {
        id: "p-front",
        dateKey: "2026-08-30",
        label: "Week 12",
        angle: "front",
        objectPath: progressPath(patientId),
      },
      {
        id: "p-side",
        dateKey: "2026-08-30",
        label: "Week 12",
        angle: "side",
        objectPath: progressPath(patientId, "22222222-2222-4222-8222-222222222222"),
      },
    ]);
  });

  it("stores a picker photo without an angle and returns it without one", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    backend.seedLedger(patientId, progressPath(patientId));
    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { upsert: [photoPayload(patientId, { id: "p-pick", angle: undefined })] },
    });
    expect(res.status).toBe(200);

    const state = await fetchState("tok-1");
    expect(state.photos).toEqual([
      {
        id: "p-pick",
        dateKey: "2026-08-30",
        label: "Week 12",
        objectPath: progressPath(patientId),
      },
    ]);
  });

  it("rejects a row pointing at another patient's object", async () => {
    const { patientId: theirs } = backend.seedSignedInPatient("tok-2");
    backend.seedSignedInPatient("tok-1");
    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { upsert: [photoPayload(theirs)] },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("A photo isn't on your account's progress rail.");
    expect(backend.tables.patient_progress_photos).toHaveLength(0);
  });

  it("rejects a row pointing at a non-progress object on the caller's own rail", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: {
        upsert: [
          photoPayload(patientId, {
            objectPath: `/objects/patient-media/${patientId}/food-11111111-1111-4111-8111-111111111111`,
          }),
        ],
      },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a legacy anonymous-rail path outright", async () => {
    backend.seedSignedInPatient("tok-1");
    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: {
        upsert: [
          photoPayload("ignored", {
            objectPath: "/objects/progress-photos/front-11111111-1111-4111-8111-111111111111",
          }),
        ],
      },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a batch where two rows share one object", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    backend.seedLedger(patientId, progressPath(patientId));
    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: {
        upsert: [photoPayload(patientId, { id: "p-a" }), photoPayload(patientId, { id: "p-b" })],
      },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Photo batch is invalid (duplicate photo objects).");
    expect(backend.tables.patient_progress_photos).toHaveLength(0);
  });

  it("rejects a row whose object was never finalized on the media ledger", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { upsert: [photoPayload(patientId)] },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("A photo upload didn't finish. Retake it and try again.");
    expect(backend.tables.patient_progress_photos).toHaveLength(0);
  });

  it("rejects a second grid row claiming an object another row already backs", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    backend.seedLedger(patientId, progressPath(patientId));
    const first = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { upsert: [photoPayload(patientId, { id: "p-owner" })] },
    });
    expect(first.status).toBe(200);

    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { upsert: [photoPayload(patientId, { id: "p-intruder" })] },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Photo batch is invalid (photo object already in use).");
    expect(backend.tables.patient_progress_photos).toHaveLength(1);
    expect(backend.tables.patient_progress_photos[0].photo_id).toBe("p-owner");

    // A legitimate update of the OWNING row (relabel, same object) still
    // merges cleanly — the 409 mapping must not misfire on updates.
    const relabel = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { upsert: [photoPayload(patientId, { id: "p-owner", label: "Week 13" })] },
    });
    expect(relabel.status).toBe(200);
    expect(backend.tables.patient_progress_photos[0].label).toBe("Week 13");
  });

  it("responds 502 when the ledger check can't run (nothing written)", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    backend.seedLedger(patientId, progressPath(patientId));
    backend.failOnce.add("GET patient_media");
    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { upsert: [photoPayload(patientId)] },
    });
    expect(res.status).toBe(502);
    expect(backend.tables.patient_progress_photos).toHaveLength(0);
  });

  it("rejects malformed rows field by field", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    const cases: Array<Record<string, unknown>> = [
      photoPayload(patientId, { id: "bad id!" }),
      photoPayload(patientId, { dateKey: "not-a-date" }),
      photoPayload(patientId, { label: "" }),
      photoPayload(patientId, { label: "x".repeat(81) }),
      photoPayload(patientId, { angle: "rear" }),
    ];
    for (const photo of cases) {
      const res = await api("POST", "/api/patient-data/photos", {
        token: "tok-1",
        body: { upsert: [photo] },
      });
      expect(res.status).toBe(400);
    }
  });

  it("rejects an empty gesture", async () => {
    backend.seedSignedInPatient("tok-1");
    const res = await api("POST", "/api/patient-data/photos", { token: "tok-1", body: {} });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Nothing to save.");
  });
});

describe("POST /patient-data/photos — deletes", () => {
  it("drops the grid row, the ledger row, and the stored bytes", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    const path = progressPath(patientId);
    backend.seedLedger(patientId, path);
    await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { upsert: [photoPayload(patientId)] },
    });

    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { deleteIds: ["p-1"] },
    });
    expect(res.status).toBe(200);
    expect(backend.removeRpcCalls).toBe(1);
    expect(backend.tables.patient_progress_photos).toHaveLength(0);
    expect(backend.tables.patient_media).toHaveLength(0);
    // The original AND both display variants go in one delete.
    expect(storageState.deleted).toEqual([path, `${path}.thumb`, `${path}.medium`]);

    const state = await fetchState("tok-1");
    expect(state.photos).toEqual([]);
  });

  it("is idempotent: deleting an unknown id succeeds and touches no bytes", async () => {
    backend.seedSignedInPatient("tok-1");
    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { deleteIds: ["ghost"] },
    });
    expect(res.status).toBe(200);
    expect(storageState.deleted).toEqual([]);
  });

  it("cannot delete another patient's photo", async () => {
    const { patientId: theirs } = backend.seedSignedInPatient("tok-2");
    backend.seedSignedInPatient("tok-1");
    const theirPath = progressPath(theirs);
    backend.seedLedger(theirs, theirPath);
    await api("POST", "/api/patient-data/photos", {
      token: "tok-2",
      body: { upsert: [photoPayload(theirs)] },
    });

    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { deleteIds: ["p-1"] },
    });
    expect(res.status).toBe(200);
    expect(backend.tables.patient_progress_photos).toHaveLength(1);
    expect(backend.tables.patient_media).toHaveLength(1);
    expect(storageState.deleted).toEqual([]);

    const other = await fetchState("tok-2");
    expect(other.photos).toHaveLength(1);
  });

  it("still succeeds when the byte delete fails (rows already gone, object merely orphaned)", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    backend.seedLedger(patientId, progressPath(patientId));
    await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { upsert: [photoPayload(patientId)] },
    });

    storageState.failDelete = true;
    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { deleteIds: ["p-1"] },
    });
    expect(res.status).toBe(200);
    expect(backend.tables.patient_progress_photos).toHaveLength(0);
    expect(storageState.deleted).toEqual([]);
  });

  it("responds 502 and deletes no bytes when the remove RPC fails", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    backend.seedLedger(patientId, progressPath(patientId));
    await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { upsert: [photoPayload(patientId)] },
    });

    backend.failOnce.add("RPC patient_progress_photos_remove");
    const res = await api("POST", "/api/patient-data/photos", {
      token: "tok-1",
      body: { deleteIds: ["p-1"] },
    });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("Couldn't save your photos right now. Please try again.");
    expect(backend.tables.patient_progress_photos).toHaveLength(1);
    expect(storageState.deleted).toEqual([]);
  });
});

describe("PUT /patient-data/flags", () => {
  it("merges partial writes into one flags row", async () => {
    backend.seedSignedInPatient("tok-1");
    const first = await api("PUT", "/api/patient-data/flags", {
      token: "tok-1",
      body: { nudgeOptOut: true },
    });
    expect(first.status).toBe(200);
    const second = await api("PUT", "/api/patient-data/flags", {
      token: "tok-1",
      body: { nudgeLastSentKey: "2026-08-29", nudgeLastCrossingKey: "2026-08-27", nudgeEngaged: false },
    });
    expect(second.status).toBe(200);

    const state = await fetchState("tok-1");
    expect(state.flags).toEqual({
      nudgeOptOut: true,
      nudgeEngaged: false,
      nudgeLastSentKey: "2026-08-29",
      nudgeLastCrossingKey: "2026-08-27",
      onboardingComplete: false,
    });
    expect(backend.tables.patient_flags).toHaveLength(1);
  });

  it("persists onboarding answers, completion, and notification prefs together", async () => {
    backend.seedSignedInPatient("tok-1");
    const answers = { medication: "semaglutide", goalWeight: 165, unitPref: "lb" };
    const prefs = { notifications: true, reminderMorning: true, reminderEvening: false };
    const res = await api("PUT", "/api/patient-data/flags", {
      token: "tok-1",
      body: { onboardingAnswers: answers, onboardingComplete: true, notificationPrefs: prefs },
    });
    expect(res.status).toBe(200);

    const state = await fetchState("tok-1");
    expect(state.flags.onboardingComplete).toBe(true);
    expect(state.flags.onboardingAnswers).toEqual(answers);
    expect(state.flags.notificationPrefs).toEqual(prefs);
  });

  it("accepts explicit nulls to clear the nudge cooldown keys", async () => {
    backend.seedSignedInPatient("tok-1");
    await api("PUT", "/api/patient-data/flags", {
      token: "tok-1",
      body: { nudgeLastSentKey: "2026-08-29" },
    });
    const res = await api("PUT", "/api/patient-data/flags", {
      token: "tok-1",
      body: { nudgeLastSentKey: null },
    });
    expect(res.status).toBe(200);

    const state = await fetchState("tok-1");
    expect(state.flags.nudgeLastSentKey).toBeNull();
  });

  it("rejects malformed flags field by field", async () => {
    backend.seedSignedInPatient("tok-1");
    const cases: Array<Record<string, unknown>> = [
      { nudgeOptOut: "yes" },
      { nudgeEngaged: 1 },
      { nudgeLastSentKey: "yesterday" },
      { nudgeLastCrossingKey: 20260827 },
      { onboardingComplete: "done" },
      { onboardingAnswers: null },
      { onboardingAnswers: ["a"] },
      { onboardingAnswers: { blob: "x".repeat(17 * 1024) } },
      { notificationPrefs: null },
      { notificationPrefs: [1] },
    ];
    for (const body of cases) {
      const res = await api("PUT", "/api/patient-data/flags", { token: "tok-1", body });
      expect(res.status).toBe(400);
    }
    expect(backend.tables.patient_flags).toHaveLength(0);
  });

  it("rejects an empty write", async () => {
    backend.seedSignedInPatient("tok-1");
    const res = await api("PUT", "/api/patient-data/flags", { token: "tok-1", body: {} });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Nothing to save.");
  });

  it("responds 502 with a friendly message when the store is down", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.failOnce.add("POST patient_flags");
    const res = await api("PUT", "/api/patient-data/flags", {
      token: "tok-1",
      body: { nudgeOptOut: true },
    });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("Couldn't save your settings right now. Please try again.");
  });

  it("never mixes two patients' flags", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.seedSignedInPatient("tok-2");
    await api("PUT", "/api/patient-data/flags", { token: "tok-1", body: { nudgeOptOut: true } });

    const other = await fetchState("tok-2");
    expect(other.flags.nudgeOptOut).toBe(false);
  });
});
