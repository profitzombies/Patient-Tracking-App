/**
 * Progress-photo media routes: presign + finalize against a mocked storage
 * layer. Mirrors the training-media harness — a bare express app on an
 * ephemeral port, per-test client IPs via X-Forwarded-For so the real
 * per-IP limiter never bleeds between tests, and one test that exhausts a
 * single IP's budget to prove the limiter actually guards these routes.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  minted: [] as string[],
  missing: false,
  metadataSize: 123456,
  sniff: "image/jpeg" as string | null,
  downloadFails: false,
  deleted: [] as string[],
}));

vi.mock("../lib/objectStorage", () => {
  class ObjectNotFoundError extends Error {
    constructor() {
      super("Object not found");
      this.name = "ObjectNotFoundError";
    }
  }
  return {
    ObjectNotFoundError,
    THUMBNAIL_CONTENT_TYPES: new Set(["image/jpeg", "image/png", "image/webp"]),
    detectThumbnailContentType: () => state.sniff,
    objectStorage: {
      progressPhotoUploadURL: async (angle: string) => {
        state.minted.push(angle);
        return {
          uploadUrl: "https://storage.example/signed-put",
          objectPath: `/objects/progress-photos/2026-08/${angle}-mock-uuid`,
        };
      },
      entityFile: async (objectPath: string) => {
        if (state.missing) throw new ObjectNotFoundError();
        return {
          getMetadata: async () => [{ size: String(state.metadataSize), contentType: "image/jpeg" }],
          download: async () => {
            if (state.downloadFails) throw new Error("range read failed");
            return [Buffer.from([0xff, 0xd8, 0xff, 0xe0])];
          },
          delete: async () => {
            state.deleted.push(objectPath);
          },
        };
      },
    },
  };
});

import progressMediaRouter from "./progress-media";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(progressMediaRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state.minted = [];
  state.missing = false;
  state.metadataSize = 123456;
  state.sniff = "image/jpeg";
  state.downloadFails = false;
  state.deleted = [];
});

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.9.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

async function post(path: string, body: unknown, ip: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

const GOOD_UPLOAD = { contentType: "image/jpeg", sizeBytes: 500_000 };
const GOOD_PATH = "/objects/progress-photos/2026-08/front-mock-uuid";

describe("POST /progress-photos/upload-url", () => {
  it("mints a presigned URL and server-owned path for a named angle", async () => {
    const res = await post("/progress-photos/upload-url", { ...GOOD_UPLOAD, angle: "front" }, nextIp());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uploadUrl: string; objectPath: string };
    expect(body.uploadUrl).toBe("https://storage.example/signed-put");
    expect(body.objectPath).toBe("/objects/progress-photos/2026-08/front-mock-uuid");
    expect(state.minted).toEqual(["front"]);
  });

  it("falls back to a generic object name when no angle is sent", async () => {
    const res = await post("/progress-photos/upload-url", GOOD_UPLOAD, nextIp());
    expect(res.status).toBe(200);
    expect(state.minted).toEqual(["shot"]);
  });

  it("rejects an unknown angle with 400 (schema enum)", async () => {
    const res = await post("/progress-photos/upload-url", { ...GOOD_UPLOAD, angle: "upward" }, nextIp());
    expect(res.status).toBe(400);
    expect(state.minted).toEqual([]);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await post("/progress-photos/upload-url", { sizeBytes: 100 }, nextIp());
    expect(res.status).toBe(400);
  });

  it("rejects non-image content types with 415", async () => {
    const res = await post(
      "/progress-photos/upload-url",
      { contentType: "video/mp4", sizeBytes: 1000 },
      nextIp(),
    );
    expect(res.status).toBe(415);
    expect(state.minted).toEqual([]);
  });

  it("rejects oversize declarations with 413", async () => {
    const res = await post(
      "/progress-photos/upload-url",
      { contentType: "image/jpeg", sizeBytes: 16 * 1024 * 1024 },
      nextIp(),
    );
    expect(res.status).toBe(413);
    expect(state.minted).toEqual([]);
  });
});

describe("POST /progress-photos/finalize", () => {
  it("verifies a landed object and reports its stored size", async () => {
    const res = await post("/progress-photos/finalize", { objectPath: GOOD_PATH }, nextIp());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ objectPath: GOOD_PATH, sizeBytes: 123456 });
    expect(state.deleted).toEqual([]);
  });

  it("refuses paths outside the progress prefix with 400", async () => {
    const res = await post(
      "/progress-photos/finalize",
      { objectPath: "/objects/training-videos/abc/video-current" },
      nextIp(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when the object never arrived", async () => {
    state.missing = true;
    const res = await post("/progress-photos/finalize", { objectPath: GOOD_PATH }, nextIp());
    expect(res.status).toBe(404);
  });

  it("deletes oversize stored objects and returns 413", async () => {
    state.metadataSize = 20 * 1024 * 1024;
    const res = await post("/progress-photos/finalize", { objectPath: GOOD_PATH }, nextIp());
    expect(res.status).toBe(413);
    expect(state.deleted).toEqual([GOOD_PATH]);
  });

  it("deletes objects that are not really images and returns 415", async () => {
    state.sniff = null;
    const res = await post("/progress-photos/finalize", { objectPath: GOOD_PATH }, nextIp());
    expect(res.status).toBe(415);
    expect(state.deleted).toEqual([GOOD_PATH]);
  });

  it("treats an unreadable object head as not-an-image (415), never a crash", async () => {
    state.downloadFails = true;
    state.sniff = null;
    const res = await post("/progress-photos/finalize", { objectPath: GOOD_PATH }, nextIp());
    expect(res.status).toBe(415);
    expect(state.deleted).toEqual([GOOD_PATH]);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await post("/progress-photos/finalize", { path: GOOD_PATH }, nextIp());
    expect(res.status).toBe(400);
  });
});

describe("write limiter", () => {
  it("lets a fresh caller through, then cuts off a hammering IP with 429", async () => {
    const ip = nextIp();
    const first = await post("/progress-photos/upload-url", { ...GOOD_UPLOAD, angle: "front" }, ip);
    expect(first.status).toBe(200);
    let last = first.status;
    for (let i = 0; i < 45; i += 1) {
      const res = await post("/progress-photos/upload-url", GOOD_UPLOAD, ip);
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
