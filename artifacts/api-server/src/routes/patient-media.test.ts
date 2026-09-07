/**
 * Patient-media routes suite — the account-backed photo rail behind the
 * foods library.
 *
 * Storage is mocked the same way as the progress-photos suite (hoisted
 * state + vi.mock of lib/objectStorage); auth and the patient_media ledger
 * run against an in-memory fake of the Supabase GoTrue + REST surfaces, so
 * the full contract is exercised: writes authenticate to a patients row,
 * minted paths embed the caller's id, finalize re-validates the STORED
 * bytes and registers the object on the account, and reads demand the
 * owner's media token plus a live ledger row before redirecting.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_POLICY_VERSION } from "../privacy/consent";
import {
  mintPatientMediaToken,
  PATIENT_MEDIA_TOKEN_TTL_SEC,
} from "../lib/media-token";

const FAKE_SUPABASE = "http://fake.supabase.local";

const PATIENT_ID = "12345678-1234-4123-8123-123456789abc";
const OTHER_ID = "87654321-4321-4321-8321-cba987654321";
const MINTED_ID = "11111111-1111-4111-8111-111111111111";
const FOOD_PATH = `/objects/patient-media/${PATIENT_ID}/food-${MINTED_ID}`;
const RECIPE_PATH = `/objects/patient-media/${PATIENT_ID}/recipe-${MINTED_ID}`;

const state = vi.hoisted(() => ({
  uploadedSize: 4321,
  detectedType: "image/jpeg" as string | null,
  entityMissing: false,
  deleted: [] as string[],
  metadataSet: [] as Array<Record<string, unknown>>,
  minted: [] as Array<{ patientId: string; kind: string }>,
  downloadRanges: [] as Array<{ start?: number; end?: number }>,
  entityCalls: 0,
  failDelete: false,
  metadataThrows: false,
}));

vi.mock("../lib/objectStorage", () => {
  class ObjectNotFoundError extends Error {}
  return {
    ObjectNotFoundError,
    THUMBNAIL_CONTENT_TYPES: new Set(["image/jpeg", "image/png", "image/webp"]),
    detectThumbnailContentType: () => state.detectedType,
    objectStorage: {
      patientMediaUploadURL: vi.fn(async (patientId: string, kind: string) => {
        state.minted.push({ patientId, kind });
        return {
          uploadUrl: "https://storage.test/upload",
          objectPath: `/objects/patient-media/${patientId}/${kind}-11111111-1111-4111-8111-111111111111`,
        };
      }),
      entityFile: vi.fn(async () => {
        state.entityCalls += 1;
        if (state.entityMissing) throw new ObjectNotFoundError();
        return {
          getMetadata: vi.fn(async () => [{ size: state.uploadedSize }]),
          setMetadata: vi.fn(async (metadata: Record<string, unknown>) => {
            if (state.metadataThrows) throw new Error("metadata write failed");
            state.metadataSet.push(metadata);
          }),
          download: vi.fn(async (options?: { start?: number; end?: number }) => {
            state.downloadRanges.push({ start: options?.start, end: options?.end });
            return [Buffer.alloc(Math.min(state.uploadedSize, 4096))];
          }),
        };
      }),
      signedDownloadURL: vi.fn(
        async (path: string, ttlSec: number) => `https://storage.test${path}?ttl=${ttlSec}`,
      ),
      deleteObjectStrict: vi.fn(async (path: string) => {
        if (state.failDelete) throw new Error("storage refused the delete");
        state.deleted.push(path);
      }),
    },
  };
});

// ── Mini Supabase fake: GoTrue user lookup, patients read, ledger insert ────

const fake = {
  tokens: new Map<string, string>(),
  authOutage: false,
  patients: [] as Array<{ id: string; auth_user_id: string | null }>,
  /** Patient ids with the current consent policy on record (routes enforce it). */
  consented: new Set<string>(),
  mediaRows: [] as Array<Record<string, unknown>>,
  failLedger: false,
  /** Object paths a progress GRID row references (cleanup must skip them). */
  referencedPaths: new Set<string>(),
  /** Upload intents recorded for the abandoned-upload sweep. */
  intents: [] as Array<Record<string, unknown>>,
  /** Job-run ledger rows (user-triggered clean-up logs here too). */
  jobRuns: [] as Array<Record<string, unknown>>,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeSupabase(href: string, init?: RequestInit): Response {
  const url = new URL(href);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);

  if (url.pathname === "/auth/v1/user") {
    if (fake.authOutage) return json(500, { error: "outage" });
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /i, "");
    const userId = fake.tokens.get(token);
    if (!userId) return json(401, { message: "invalid token" });
    return json(200, { id: userId, email: null, phone: null });
  }
  if (url.pathname === "/rest/v1/patients" && method === "GET") {
    const wanted = (url.searchParams.get("auth_user_id") ?? "").replace(/^eq\./, "");
    return json(
      200,
      fake.patients.filter(p => p.auth_user_id === wanted).map(p => ({ id: p.id })),
    );
  }
  if (url.pathname === "/rest/v1/patient_consents" && method === "GET") {
    const pid = (url.searchParams.get("patient_id") ?? "").replace(/^eq\./, "");
    return json(
      200,
      fake.consented.has(pid)
        ? [{ id: `consent-${pid}`, patient_id: pid, policy_version: CONSENT_POLICY_VERSION, terms_accepted: true, privacy_accepted: true, health_data_accepted: true, photo_analysis_accepted: true, app_version: null, platform: null, recorded_at: "2026-09-01T00:00:00Z" }]
        : [],
    );
  }
  if (url.pathname === "/rest/v1/patient_media" && method === "GET") {
    if (fake.failLedger) return json(500, { message: "fake ledger failure" });
    const pid = (url.searchParams.get("patient_id") ?? "").replace(/^eq\./, "");
    const path = (url.searchParams.get("object_path") ?? "").replace(/^eq\./, "");
    return json(
      200,
      fake.mediaRows
        .filter(r => r.patient_id === pid && r.object_path === path)
        .map(r => ({ object_path: r.object_path })),
    );
  }
  if (url.pathname === "/rest/v1/patient_media" && method === "POST") {
    if (fake.failLedger) return json(500, { message: "fake ledger failure" });
    const payload = JSON.parse(String(init?.body ?? "[]")) as Array<Record<string, unknown>>;
    for (const incoming of payload) {
      const existing = fake.mediaRows.find(r => r.object_path === incoming.object_path);
      if (existing) {
        Object.assign(existing, incoming);
      } else {
        fake.mediaRows.push({ ...incoming });
      }
    }
    return json(201, []);
  }
  if (url.pathname === "/rest/v1/rpc/patient_media_cleanup_progress" && method === "POST") {
    if (fake.failLedger) return json(500, { message: "fake ledger failure" });
    const args = JSON.parse(String(init?.body ?? "{}")) as {
      p_patient_id?: string;
      p_paths?: string[];
    };
    const removed: string[] = [];
    for (const path of args.p_paths ?? []) {
      const index = fake.mediaRows.findIndex(
        r =>
          r.patient_id === args.p_patient_id &&
          r.object_path === path &&
          r.kind === "progress" &&
          !fake.referencedPaths.has(path),
      );
      if (index < 0) continue;
      fake.mediaRows.splice(index, 1);
      removed.push(path);
    }
    return json(200, removed);
  }
  if (url.pathname === "/rest/v1/storage_upload_intents" && method === "POST") {
    fake.intents.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return json(201, []);
  }
  if (url.pathname === "/rest/v1/system_job_runs" && method === "POST") {
    const row = { id: `run-${fake.jobRuns.length + 1}`, status: "running", started_at: "2026-09-07T12:00:00Z", finished_at: null, counts: {}, failure_count: 0, error: null, ...(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>) };
    fake.jobRuns.push(row);
    return json(201, [row]);
  }
  if (url.pathname === "/rest/v1/rpc/finish_system_job_run" && method === "POST") {
    const args = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const row = fake.jobRuns.find(r => r.id === args.p_run_id);
    if (row) Object.assign(row, { status: args.p_status, counts: args.p_counts, failure_count: args.p_failure_count, error: args.p_error, finished_at: "2026-09-07T12:00:01Z" });
    return json(200, null);
  }
  return json(404, { message: `fake: no route ${url.pathname}` });
}

/** Signed-in patient: auth user + token + linked patients row. */
function seedSignedInPatient(token: string, patientId: string, options: { consent?: boolean } = {}): void {
  const userId = `user-for-${patientId}`;
  fake.tokens.set(token, userId);
  fake.patients.push({ id: patientId, auth_user_id: userId });
  if (options.consent !== false) fake.consented.add(patientId);
}

const realFetch = globalThis.fetch.bind(globalThis);
let server: Server;
let baseUrl = "";
let isPatientMediaPath: (path: string) => boolean;
let isOwnPatientMediaPath: (path: string, patientId: string) => boolean;

beforeAll(async () => {
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  process.env.PATIENT_MEDIA_WRITE_BURST = "100000";
  process.env.PATIENT_MEDIA_WRITE_DAILY_BUDGET = "100000";

  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(href).hostname === "fake.supabase.local") {
      return Promise.resolve(fakeSupabase(href, init));
    }
    return realFetch(input as string, init);
  });

  const routerModule = await import("./patient-media");
  isPatientMediaPath = routerModule.isPatientMediaPath;
  isOwnPatientMediaPath = routerModule.isOwnPatientMediaPath;

  const app = express();
  // Same as the real app: X-Forwarded-For controls req.ip, so every call
  // can ride its own client IP and the write limiter never interferes.
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(routerModule.default);
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  state.uploadedSize = 4321;
  state.detectedType = "image/jpeg";
  state.entityMissing = false;
  state.deleted.length = 0;
  state.metadataSet.length = 0;
  state.minted.length = 0;
  state.downloadRanges.length = 0;
  state.entityCalls = 0;
  state.failDelete = false;
  state.metadataThrows = false;
  fake.tokens.clear();
  fake.authOutage = false;
  fake.patients.length = 0;
  fake.consented.clear();
  fake.mediaRows.length = 0;
  fake.failLedger = false;
  seedSignedInPatient("tok-1", PATIENT_ID);
});

let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `10.9.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

async function post(
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: any }> {
  const response = await realFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": nextIp(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  return { status: response.status, json: parsed };
}

async function getRaw(path: string): Promise<Response> {
  return realFetch(`${baseUrl}${path}`, {
    redirect: "manual",
    headers: { "X-Forwarded-For": nextIp() },
  });
}

describe("isPatientMediaPath / isOwnPatientMediaPath", () => {
  it("accepts only patient-dir + minted-style ids under the prefix", () => {
    expect(isPatientMediaPath(FOOD_PATH)).toBe(true);
    expect(isPatientMediaPath(RECIPE_PATH)).toBe(true);
    expect(isPatientMediaPath(`/objects/patient-media/${OTHER_ID}/food-abcdef12`)).toBe(true);
  });

  it("rejects traversal, nesting, other prefixes, and free-form names", () => {
    expect(isPatientMediaPath("/objects/progress-photos/front-11111111")).toBe(false);
    expect(isPatientMediaPath(`/objects/patient-media/${PATIENT_ID}/../escape`)).toBe(false);
    expect(isPatientMediaPath(`/objects/patient-media/${PATIENT_ID}/food-1/nested`)).toBe(false);
    expect(isPatientMediaPath(`/objects/patient-media/${PATIENT_ID}/photo-${MINTED_ID}`)).toBe(false);
    expect(isPatientMediaPath(`/objects/patient-media/${PATIENT_ID}/food-short`)).toBe(false);
    expect(isPatientMediaPath(`/objects/patient-media/not-a-uuid/food-${MINTED_ID}`)).toBe(false);
    expect(isPatientMediaPath(`/objects/patient-media/${PATIENT_ID}/`)).toBe(false);
    expect(isPatientMediaPath("")).toBe(false);
  });

  it("binds ownership to the patient directory", () => {
    expect(isOwnPatientMediaPath(FOOD_PATH, PATIENT_ID)).toBe(true);
    expect(isOwnPatientMediaPath(FOOD_PATH, OTHER_ID)).toBe(false);
    expect(isOwnPatientMediaPath(`/objects/patient-media/${OTHER_ID}/food-${MINTED_ID}`, PATIENT_ID)).toBe(false);
  });
});

describe("POST /patient-media/upload-url", () => {
  it("requires a signed-in patient before minting anything", async () => {
    const anon = await post("/patient-media/upload-url", {
      kind: "food",
      contentType: "image/jpeg",
      sizeBytes: 1000,
    });
    expect(anon.status).toBe(401);

    const stale = await post(
      "/patient-media/upload-url",
      { kind: "food", contentType: "image/jpeg", sizeBytes: 1000 },
      "tok-stale",
    );
    expect(stale.status).toBe(401);
    expect(state.minted).toEqual([]);
  });

  it("records an upload intent so the abandoned-upload sweep can find never-finalized objects", async () => {
    fake.intents.length = 0;
    const res = await post(
      "/patient-media/upload-url",
      { kind: "food", contentType: "image/jpeg", sizeBytes: 1000 },
      "tok-1",
    );
    expect(res.status).toBe(200);
    expect(fake.intents).toEqual([
      expect.objectContaining({ object_path: res.json.objectPath, surface: "patient_media", owner_id: PATIENT_ID }),
    ]);
  });

  it("responds 503 (not 401) when the auth lookup is down", async () => {
    fake.authOutage = true;
    const res = await post(
      "/patient-media/upload-url",
      { kind: "food", contentType: "image/jpeg", sizeBytes: 1000 },
      "tok-1",
    );
    expect(res.status).toBe(503);
    expect(res.json.error).toBe("Account lookup is unavailable right now.");
  });

  it("rejects signed-in accounts with no linked patient row", async () => {
    fake.tokens.set("tok-staff", "staff-user");
    const res = await post(
      "/patient-media/upload-url",
      { kind: "food", contentType: "image/jpeg", sizeBytes: 1000 },
      "tok-staff",
    );
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("This account is not linked to a patient record.");
  });

  it("mints a presigned PUT under the CALLER's own directory", async () => {
    const { status, json: body } = await post(
      "/patient-media/upload-url",
      { kind: "recipe", contentType: "image/png", sizeBytes: 123456 },
      "tok-1",
    );
    expect(status).toBe(200);
    expect(body.uploadUrl).toBe("https://storage.test/upload");
    expect(body.objectPath.startsWith(`/objects/patient-media/${PATIENT_ID}/recipe-`)).toBe(true);
    expect(state.minted).toEqual([{ patientId: PATIENT_ID, kind: "recipe" }]);
  });

  it("rejects unknown kinds, non-image types, and bad sizes", async () => {
    const badKind = await post(
      "/patient-media/upload-url",
      { kind: "selfie", contentType: "image/jpeg", sizeBytes: 100 },
      "tok-1",
    );
    expect(badKind.status).toBe(400);
    expect(badKind.json.error).toBe("Invalid media kind.");

    const badType = await post(
      "/patient-media/upload-url",
      { kind: "food", contentType: "video/mp4", sizeBytes: 100 },
      "tok-1",
    );
    expect(badType.status).toBe(415);

    const zero = await post(
      "/patient-media/upload-url",
      { kind: "food", contentType: "image/jpeg", sizeBytes: 0 },
      "tok-1",
    );
    expect(zero.status).toBe(400);

    const huge = await post(
      "/patient-media/upload-url",
      { kind: "food", contentType: "image/jpeg", sizeBytes: 10 * 1024 * 1024 + 1 },
      "tok-1",
    );
    expect(huge.status).toBe(413);
    expect(state.minted).toEqual([]);
  });
});

describe("POST /patient-media/finalize", () => {
  it("verifies the stored bytes, stamps the type, and registers the object on the account", async () => {
    const { status, json: body } = await post(
      "/patient-media/finalize",
      { objectPath: FOOD_PATH },
      "tok-1",
    );
    expect(status).toBe(200);
    expect(body).toEqual({ objectPath: FOOD_PATH, sizeBytes: 4321, contentType: "image/jpeg" });
    expect(state.metadataSet).toEqual([{ contentType: "image/jpeg" }]);
    expect(state.deleted).toEqual([]);
    expect(fake.mediaRows).toEqual([
      {
        object_path: FOOD_PATH,
        patient_id: PATIENT_ID,
        kind: "food",
        content_type: "image/jpeg",
        size_bytes: 4321,
      },
    ]);
  });

  it("derives the ledger kind from the object id (recipe)", async () => {
    const { status } = await post("/patient-media/finalize", { objectPath: RECIPE_PATH }, "tok-1");
    expect(status).toBe(200);
    expect(fake.mediaRows[0].kind).toBe("recipe");
  });

  it("is idempotent — re-finalizing the same object keeps one ledger row", async () => {
    await post("/patient-media/finalize", { objectPath: FOOD_PATH }, "tok-1");
    const again = await post("/patient-media/finalize", { objectPath: FOOD_PATH }, "tok-1");
    expect(again.status).toBe(200);
    expect(fake.mediaRows).toHaveLength(1);
  });

  it("requires a signed-in patient", async () => {
    const res = await post("/patient-media/finalize", { objectPath: FOOD_PATH });
    expect(res.status).toBe(401);
    expect(state.entityCalls).toBe(0);
    expect(fake.mediaRows).toEqual([]);
  });

  it("rejects a path under another patient's prefix before touching storage", async () => {
    const foreign = `/objects/patient-media/${OTHER_ID}/food-${MINTED_ID}`;
    const res = await post("/patient-media/finalize", { objectPath: foreign }, "tok-1");
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("That upload isn't yours to finalize.");
    expect(state.entityCalls).toBe(0);
    expect(state.deleted).toEqual([]);
    expect(fake.mediaRows).toEqual([]);
  });

  it("404s when the uploaded object never arrived", async () => {
    state.entityMissing = true;
    const res = await post("/patient-media/finalize", { objectPath: FOOD_PATH }, "tok-1");
    expect(res.status).toBe(404);
    expect(res.json.error).toMatch(/never arrived/);
    expect(fake.mediaRows).toEqual([]);
  });

  it("sniffs a 64 KB head so metadata-heavy JPEGs keep their SOF in view", async () => {
    state.uploadedSize = 200_000;
    const { status } = await post("/patient-media/finalize", { objectPath: FOOD_PATH }, "tok-1");
    expect(status).toBe(200);
    expect(state.downloadRanges).toEqual([{ start: 0, end: 64 * 1024 - 1 }]);
  });

  it("discards a stored file over the cap and answers 413 — nothing registered", async () => {
    state.uploadedSize = 10 * 1024 * 1024 + 5;
    const res = await post("/patient-media/finalize", { objectPath: FOOD_PATH }, "tok-1");
    expect(res.status).toBe(413);
    expect(state.deleted).toEqual([FOOD_PATH]);
    expect(fake.mediaRows).toEqual([]);
  });

  it("discards bytes that aren't an image and answers 422 — nothing registered", async () => {
    state.detectedType = null;
    const res = await post("/patient-media/finalize", { objectPath: FOOD_PATH }, "tok-1");
    expect(res.status).toBe(422);
    expect(state.deleted).toEqual([FOOD_PATH]);
    expect(state.metadataSet).toEqual([]);
    expect(fake.mediaRows).toEqual([]);
  });

  it("discards the object when the ledger write fails — the account never forgets an upload", async () => {
    fake.failLedger = true;
    const res = await post("/patient-media/finalize", { objectPath: FOOD_PATH }, "tok-1");
    expect(res.status).toBe(500);
    expect(state.deleted).toEqual([FOOD_PATH]);
    expect(fake.mediaRows).toEqual([]);
  });

  it("discards the object when a later step throws, then answers 500", async () => {
    state.metadataThrows = true;
    const res = await post("/patient-media/finalize", { objectPath: FOOD_PATH }, "tok-1");
    expect(res.status).toBe(500);
    expect(state.deleted).toEqual([FOOD_PATH]);
  });
});

describe("GET /patient-media/file", () => {
  /** The owner's live ledger row — the object is ON the account. */
  function seedLedger(path = FOOD_PATH, patientId = PATIENT_ID): void {
    fake.mediaRows.push({ object_path: path, patient_id: patientId, kind: "food" });
  }
  const fileUrl = (path: string, token?: string) =>
    `/patient-media/file?path=${encodeURIComponent(path)}` +
    (token ? `&mt=${encodeURIComponent(token)}` : "");

  it("302-redirects the owner (valid token + ledger row) without caching", async () => {
    seedLedger();
    const response = await getRaw(fileUrl(FOOD_PATH, mintPatientMediaToken(PATIENT_ID)));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`https://storage.test${FOOD_PATH}?ttl=3600`);
    expect(response.headers.get("cache-control")).toContain("no-cache");
  });

  it("401s without a token — a bare path opens nothing", async () => {
    seedLedger();
    const response = await getRaw(fileUrl(FOOD_PATH));
    expect(response.status).toBe(401);
    expect(state.entityCalls).toBe(0);
  });

  it("403s another patient's token — cross-patient reads are impossible", async () => {
    seedLedger();
    const response = await getRaw(fileUrl(FOOD_PATH, mintPatientMediaToken(OTHER_ID)));
    expect(response.status).toBe(403);
    expect(state.entityCalls).toBe(0);
  });

  it("403s an expired token", async () => {
    seedLedger();
    const stale = mintPatientMediaToken(
      PATIENT_ID,
      Date.now() - (PATIENT_MEDIA_TOKEN_TTL_SEC + 60) * 1000,
    );
    const response = await getRaw(fileUrl(FOOD_PATH, stale));
    expect(response.status).toBe(403);
  });

  it("403s a garbage token", async () => {
    seedLedger();
    const response = await getRaw(fileUrl(FOOD_PATH, "not.a-real-token"));
    expect(response.status).toBe(403);
  });

  it("404s a path that is not on the owner's ledger — removed photos die with their row", async () => {
    const response = await getRaw(fileUrl(FOOD_PATH, mintPatientMediaToken(PATIENT_ID)));
    expect(response.status).toBe(404);
    expect(state.entityCalls).toBe(0);
  });

  it("502s when the ledger read fails — never an open fallback", async () => {
    seedLedger();
    fake.failLedger = true;
    const response = await getRaw(fileUrl(FOOD_PATH, mintPatientMediaToken(PATIENT_ID)));
    expect(response.status).toBe(502);
    expect(state.entityCalls).toBe(0);
  });

  it("rejects non-media paths before touching storage", async () => {
    const response = await getRaw(
      `/patient-media/file?path=${encodeURIComponent("/objects/progress-photos/front-11111111")}`,
    );
    expect(response.status).toBe(400);
    expect(state.entityCalls).toBe(0);
  });

  it("404s for an object that does not exist", async () => {
    seedLedger();
    state.entityMissing = true;
    const response = await getRaw(fileUrl(FOOD_PATH, mintPatientMediaToken(PATIENT_ID)));
    expect(response.status).toBe(404);
  });

  it("400s when the path parameter is missing", async () => {
    const response = await getRaw("/patient-media/file");
    expect(response.status).toBe(400);
  });
});

describe("POST /patient-media/cleanup", () => {
  const PROGRESS_A = `/objects/patient-media/${PATIENT_ID}/progress-aaaaaaaa`;
  const PROGRESS_B = `/objects/patient-media/${PATIENT_ID}/progress-bbbbbbbb`;

  beforeEach(() => {
    fake.mediaRows.length = 0;
    fake.referencedPaths.clear();
    state.deleted.length = 0;
  });

  function seedProgress(path: string): void {
    fake.mediaRows.push({ object_path: path, patient_id: PATIENT_ID, kind: "progress" });
  }

  it("requires a signed-in patient", async () => {
    const res = await post("/patient-media/cleanup", { paths: [PROGRESS_A] });
    expect(res.status).toBe(401);
    expect(state.deleted).toEqual([]);
  });

  it("refuses paths outside the caller's own namespace", async () => {
    const res = await post(
      "/patient-media/cleanup",
      { paths: [PROGRESS_A, `/objects/patient-media/${OTHER_ID}/progress-zzzzzzzz`] },
      "tok-1",
    );
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Only your own uploads can be discarded.");
    expect(state.deleted).toEqual([]);
  });

  it("rejects an empty or oversized batch", async () => {
    expect((await post("/patient-media/cleanup", { paths: [] }, "tok-1")).status).toBe(400);
    const many = Array.from(
      { length: 9 },
      (_, i) => `/objects/patient-media/${PATIENT_ID}/progress-${i}`,
    );
    expect((await post("/patient-media/cleanup", { paths: many }, "tok-1")).status).toBe(400);
  });

  it("deletes unreferenced progress uploads — rows AND bytes — but never grid-referenced ones", async () => {
    seedProgress(PROGRESS_A);
    seedProgress(PROGRESS_B);
    fake.referencedPaths.add(PROGRESS_B); // a grid row points at B
    const res = await post(
      "/patient-media/cleanup",
      { paths: [PROGRESS_A, PROGRESS_B] },
      "tok-1",
    );
    expect(res.status).toBe(200);
    expect(res.json.removed).toEqual([PROGRESS_A]);
    expect(state.deleted).toEqual([PROGRESS_A]);
    expect(fake.mediaRows.map(r => r.object_path)).toEqual([PROGRESS_B]);
  });

  it("logs the user-triggered clean-up to the job-runs ledger with its counts", async () => {
    fake.jobRuns.length = 0;
    seedProgress(PROGRESS_A);
    const res = await post("/patient-media/cleanup", { paths: [PROGRESS_A] }, "tok-1");
    expect(res.status).toBe(200);
    expect(fake.jobRuns).toEqual([
      expect.objectContaining({ job_name: "patient-media-cleanup", trigger: "user", dry_run: false, status: "succeeded", counts: { requested: 1, rowsRemoved: 1, objectsDeleted: 1 } }),
    ]);
  });

  it("reports 502 when the ledger delete fails and touches no bytes", async () => {
    fake.jobRuns.length = 0;
    seedProgress(PROGRESS_A);
    fake.failLedger = true;
    const res = await post("/patient-media/cleanup", { paths: [PROGRESS_A] }, "tok-1");
    expect(res.status).toBe(502);
    expect(state.deleted).toEqual([]);
    expect(fake.mediaRows).toHaveLength(1);
    expect(fake.jobRuns[0]).toMatchObject({ job_name: "patient-media-cleanup", status: "failed" });
  });

  it("survives a failed byte delete — the ledger row still goes", async () => {
    seedProgress(PROGRESS_A);
    state.failDelete = true;
    const res = await post("/patient-media/cleanup", { paths: [PROGRESS_A] }, "tok-1");
    state.failDelete = false;
    expect(res.status).toBe(200);
    expect(res.json.removed).toEqual([PROGRESS_A]);
    expect(fake.mediaRows).toHaveLength(0);
  });
});
