/**
 * Legacy progress-photo READS — the anonymous write rail (upload-url /
 * finalize) is gone: progress photo bytes now ride the authenticated
 * per-patient media rail and grid rows live on the account (see
 * patient-progress.test.ts). What remains here is the signed-GET redirect
 * for objects the retired rail stored, plus the path guard that keeps it
 * from leaking anything else.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MINTED_PATH = "/objects/progress-photos/front-11111111-1111-4111-8111-111111111111";
const SIDE_PATH = "/objects/progress-photos/side-22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  entityMissing: false,
}));

vi.mock("../lib/objectStorage", () => {
  class ObjectNotFoundError extends Error {}
  return {
    ObjectNotFoundError,
    objectStorage: {
      entityFile: vi.fn(async () => {
        if (state.entityMissing) throw new ObjectNotFoundError();
        return {};
      }),
      signedDownloadURL: vi.fn(
        async (path: string, ttlSec: number) => `https://storage.test${path}?ttl=${ttlSec}`,
      ),
    },
  };
});

import progressPhotosRouter from "./progress-photos";
import { isPhotoObjectPath } from "./progress-photos";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(progressPhotosRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  state.entityMissing = false;
});

async function getRaw(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { redirect: "manual" });
}

describe("isPhotoObjectPath", () => {
  it("accepts paths the retired rail itself minted", () => {
    expect(isPhotoObjectPath(MINTED_PATH)).toBe(true);
    expect(isPhotoObjectPath(SIDE_PATH)).toBe(true);
    expect(isPhotoObjectPath("/objects/progress-photos/back-abcdef12")).toBe(true);
  });

  it("rejects every other shape", () => {
    expect(isPhotoObjectPath("/objects/training-videos/x/video-1")).toBe(false);
    expect(isPhotoObjectPath("/objects/progress-photos/../knowledge-docs/a/doc-1")).toBe(false);
    expect(isPhotoObjectPath("/objects/progress-photos/..")).toBe(false);
    expect(isPhotoObjectPath("/objects/progress-photos/front-1/nested")).toBe(false);
    expect(isPhotoObjectPath("/objects/progress-photos/rear-11111111")).toBe(false);
    expect(isPhotoObjectPath("/objects/progress-photos/front-short")).toBe(false);
    expect(isPhotoObjectPath("/objects/progress-photos/")).toBe(false);
    expect(isPhotoObjectPath("")).toBe(false);
    // The authenticated rail's paths are NOT this route's to serve.
    expect(
      isPhotoObjectPath(
        "/objects/patient-media/11111111-1111-4111-8111-111111111111/progress-22222222-2222-4222-8222-222222222222",
      ),
    ).toBe(false);
  });
});

describe("the anonymous write rail is gone", () => {
  it("upload-url no longer exists", async () => {
    const response = await fetch(`${baseUrl}/progress-photos/upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ angle: "front", contentType: "image/jpeg", sizeBytes: 1000 }),
    });
    expect(response.status).toBe(404);
  });

  it("finalize no longer exists", async () => {
    const response = await fetch(`${baseUrl}/progress-photos/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectPath: MINTED_PATH }),
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /progress-photos/file", () => {
  it("302-redirects to a short-lived signed URL without caching", async () => {
    const response = await getRaw(`/progress-photos/file?path=${encodeURIComponent(MINTED_PATH)}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`https://storage.test${MINTED_PATH}?ttl=3600`);
    expect(response.headers.get("cache-control")).toContain("no-cache");
  });

  it("rejects non-photo paths before touching storage", async () => {
    const response = await getRaw(
      `/progress-photos/file?path=${encodeURIComponent("/objects/knowledge-docs/a/doc-1")}`,
    );
    expect(response.status).toBe(400);
  });

  it("404s for a photo that does not exist", async () => {
    state.entityMissing = true;
    const response = await getRaw(`/progress-photos/file?path=${encodeURIComponent(MINTED_PATH)}`);
    expect(response.status).toBe(404);
  });

  it("400s when the path parameter is missing", async () => {
    const response = await getRaw("/progress-photos/file");
    expect(response.status).toBe(400);
  });
});
