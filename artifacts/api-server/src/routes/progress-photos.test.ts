import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MINTED_PATH = "/objects/progress-photos/front-11111111-1111-4111-8111-111111111111";
const SIDE_PATH = "/objects/progress-photos/side-22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  uploadedSize: 4321,
  detectedType: "image/jpeg" as string | null,
  entityMissing: false,
  deleted: [] as string[],
  metadataSet: [] as Array<Record<string, unknown>>,
  mintedAngles: [] as string[],
  downloadRanges: [] as Array<{ start?: number; end?: number }>,
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
      progressPhotoUploadURL: vi.fn(async (angle: string) => {
        state.mintedAngles.push(angle);
        return {
          uploadUrl: "https://storage.test/upload",
          objectPath: `/objects/progress-photos/${angle}-11111111-1111-4111-8111-111111111111`,
        };
      }),
      entityFile: vi.fn(async () => {
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

import progressPhotosRouter from "./progress-photos";
import { isPhotoObjectPath } from "./progress-photos";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  const app = express();
  // Same as the real app: X-Forwarded-For controls req.ip, so every call
  // can ride its own client IP and the write limiter never interferes.
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
  state.uploadedSize = 4321;
  state.detectedType = "image/jpeg";
  state.entityMissing = false;
  state.deleted.length = 0;
  state.metadataSet.length = 0;
  state.mintedAngles.length = 0;
  state.downloadRanges.length = 0;
  state.failDelete = false;
  state.metadataThrows = false;
});

let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `10.7.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": nextIp() },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

async function getRaw(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    headers: { "X-Forwarded-For": nextIp() },
  });
}

describe("isPhotoObjectPath", () => {
  it("accepts only flat minted-style ids under the prefix", () => {
    expect(isPhotoObjectPath(MINTED_PATH)).toBe(true);
    expect(isPhotoObjectPath(SIDE_PATH)).toBe(true);
    expect(isPhotoObjectPath("/objects/progress-photos/back-abcdef12")).toBe(true);
  });

  it("rejects traversal, nesting, other prefixes, and free-form names", () => {
    expect(isPhotoObjectPath("/objects/training-videos/x/video-1")).toBe(false);
    expect(isPhotoObjectPath("/objects/progress-photos/../knowledge-docs/a/doc-1")).toBe(false);
    expect(isPhotoObjectPath("/objects/progress-photos/..")).toBe(false);
    expect(isPhotoObjectPath("/objects/progress-photos/front-1/nested")).toBe(false);
    expect(isPhotoObjectPath("/objects/progress-photos/rear-11111111")).toBe(false);
    expect(isPhotoObjectPath("/objects/progress-photos/front-short")).toBe(false);
    expect(isPhotoObjectPath("/objects/progress-photos/")).toBe(false);
    expect(isPhotoObjectPath("")).toBe(false);
  });
});

describe("POST /progress-photos/upload-url", () => {
  it("mints a presigned PUT bound to the requested angle", async () => {
    const { status, json } = await post("/progress-photos/upload-url", {
      angle: "front",
      contentType: "image/jpeg",
      sizeBytes: 123456,
    });
    expect(status).toBe(200);
    expect(json.uploadUrl).toBe("https://storage.test/upload");
    expect(json.objectPath.startsWith("/objects/progress-photos/front-")).toBe(true);
    expect(state.mintedAngles).toEqual(["front"]);
  });

  it("rejects an unknown angle at the schema", async () => {
    const { status } = await post("/progress-photos/upload-url", {
      angle: "rear",
      contentType: "image/jpeg",
      sizeBytes: 100,
    });
    expect(status).toBe(400);
    expect(state.mintedAngles).toEqual([]);
  });

  it("rejects a non-image content type at the schema", async () => {
    const { status } = await post("/progress-photos/upload-url", {
      angle: "side",
      contentType: "video/mp4",
      sizeBytes: 100,
    });
    expect(status).toBe(400);
    expect(state.mintedAngles).toEqual([]);
  });

  it("rejects a declared size over the 10 MB cap", async () => {
    const { status } = await post("/progress-photos/upload-url", {
      angle: "back",
      contentType: "image/png",
      sizeBytes: 10 * 1024 * 1024 + 1,
    });
    // The zod maximum rejects before the route's own 413 guard.
    expect(status).toBe(400);
    expect(state.mintedAngles).toEqual([]);
  });
});

describe("POST /progress-photos/finalize", () => {
  it("verifies the stored bytes and stamps the detected content type", async () => {
    const { status, json } = await post("/progress-photos/finalize", {
      objectPath: MINTED_PATH,
    });
    expect(status).toBe(200);
    expect(json).toEqual({
      objectPath: MINTED_PATH,
      sizeBytes: 4321,
      contentType: "image/jpeg",
    });
    expect(state.metadataSet).toEqual([{ contentType: "image/jpeg" }]);
    expect(state.deleted).toEqual([]);
    // The whole 4321-byte file fits inside the sniff window.
    expect(state.downloadRanges).toEqual([{ start: 0, end: 4320 }]);
  });

  it("sniffs a 64 KB head so metadata-heavy JPEGs keep their SOF in view", async () => {
    // Real files (EXIF/XMP/Photoshop stacks, AI-generation tags) routinely
    // push the JPEG size marker past 4 KB; a 4 KB window rejected them.
    state.uploadedSize = 200_000;
    const { status } = await post("/progress-photos/finalize", { objectPath: MINTED_PATH });
    expect(status).toBe(200);
    expect(state.downloadRanges).toEqual([{ start: 0, end: 64 * 1024 - 1 }]);
  });

  it("reads to the end of a file smaller than the sniff window", async () => {
    state.uploadedSize = 68;
    const { status } = await post("/progress-photos/finalize", { objectPath: MINTED_PATH });
    expect(status).toBe(200);
    expect(state.downloadRanges).toEqual([{ start: 0, end: 67 }]);
  });

  it("rejects a path outside the progress-photos prefix", async () => {
    const { status } = await post("/progress-photos/finalize", {
      objectPath: "/objects/training-videos/v/video-1",
    });
    expect(status).toBe(400);
    expect(state.deleted).toEqual([]);
  });

  it("404s when the uploaded object never arrived", async () => {
    state.entityMissing = true;
    const { status, json } = await post("/progress-photos/finalize", {
      objectPath: MINTED_PATH,
    });
    expect(status).toBe(404);
    expect(json.error).toMatch(/never arrived/);
    expect(state.deleted).toEqual([]);
  });

  it("discards a stored file over the cap and answers 413", async () => {
    state.uploadedSize = 10 * 1024 * 1024 + 5;
    const { status } = await post("/progress-photos/finalize", { objectPath: MINTED_PATH });
    expect(status).toBe(413);
    expect(state.deleted).toEqual([MINTED_PATH]);
  });

  it("discards an empty stored file and answers 413", async () => {
    state.uploadedSize = 0;
    const { status } = await post("/progress-photos/finalize", { objectPath: MINTED_PATH });
    expect(status).toBe(413);
    expect(state.deleted).toEqual([MINTED_PATH]);
  });

  it("discards bytes that aren't an image and answers 422", async () => {
    state.detectedType = null;
    const { status, json } = await post("/progress-photos/finalize", {
      objectPath: MINTED_PATH,
    });
    expect(status).toBe(422);
    expect(json.error).toMatch(/aren't a JPEG/);
    expect(state.deleted).toEqual([MINTED_PATH]);
    expect(state.metadataSet).toEqual([]);
  });

  it("still answers 422 when the stray delete itself fails", async () => {
    state.detectedType = null;
    state.failDelete = true;
    const { status } = await post("/progress-photos/finalize", { objectPath: MINTED_PATH });
    expect(status).toBe(422);
    expect(state.deleted).toEqual([]);
  });

  it("discards the object when a later step throws, then answers 500", async () => {
    state.metadataThrows = true;
    const { status } = await post("/progress-photos/finalize", { objectPath: MINTED_PATH });
    expect(status).toBe(500);
    expect(state.deleted).toEqual([MINTED_PATH]);
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
