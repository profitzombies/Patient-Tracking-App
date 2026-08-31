/**
 * Patient-media routes suite — the account-backed photo rail behind the
 * foods library.
 *
 * Storage is mocked the same way as the progress-photos suite (hoisted
 * state + vi.mock of lib/objectStorage); auth and the patient_media ledger
 * run against an in-memory fake of the Supabase GoTrue + REST surfaces, so
 * the full contract is exercised: writes authenticate to a patients row,
 * minted paths embed the caller's id, finalize re-validates the STORED
 * bytes and registers the object on the account, and reads stay open 302s.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  mediaRows: [] as Array<Record<string, unknown>>,
  failLedger: false,
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
  return json(404, { message: `fake: no route ${url.pathname}` });
}

/** Signed-in patient: auth user + token + linked patients row. */
function seedSignedInPatient(token: string, patientId: string): void {
  const userId = `user-for-${patientId}`;
  fake.tokens.set(token, userId);
  fake.patients.push({ id: patientId, auth_user_id: userId });
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
  it("302-redirects to a short-lived signed URL without caching", async () => {
    const response = await getRaw(`/patient-media/file?path=${encodeURIComponent(FOOD_PATH)}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`https://storage.test${FOOD_PATH}?ttl=3600`);
    expect(response.headers.get("cache-control")).toContain("no-cache");
  });

  it("rejects non-media paths before touching storage", async () => {
    const response = await getRaw(
      `/patient-media/file?path=${encodeURIComponent("/objects/progress-photos/front-11111111")}`,
    );
    expect(response.status).toBe(400);
    expect(state.entityCalls).toBe(0);
  });

  it("404s for an object that does not exist", async () => {
    state.entityMissing = true;
    const response = await getRaw(`/patient-media/file?path=${encodeURIComponent(FOOD_PATH)}`);
    expect(response.status).toBe(404);
  });

  it("400s when the path parameter is missing", async () => {
    const response = await getRaw("/patient-media/file");
    expect(response.status).toBe(400);
  });
});
