import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const VIDEO_ID = "11111111-1111-4111-8111-111111111111";
const VIDEO_PATH = `/objects/training-videos/${VIDEO_ID}/video-current`;
const OLD_VIDEO_PATH = `/objects/training-videos/${VIDEO_ID}/video-old`;
const OLD_THUMB_PATH = `/objects/training-videos/${VIDEO_ID}/thumb-old`;
const CUSTOM_THUMB_PATH = `/objects/training-videos/${VIDEO_ID}/thumb-22222222-2222-4222-8222-222222222222`;

const state = vi.hoisted(() => ({
  record: {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Lesson",
    duration_seconds: 120,
    description: [],
    chapters: [],
    thumbnail_chapter: 0,
    video_source: "/objects/training-videos/11111111-1111-4111-8111-111111111111/video-current",
    thumbnail_source: "/objects/training-videos/11111111-1111-4111-8111-111111111111/thumb-old",
  },
  deleted: [] as string[],
  saved: [] as Array<{ path: string; contentType: string }>,
  updates: [] as Array<Record<string, unknown>>,
  detectedType: "image/png" as string | null,
  uploadedContentType: "image/png",
  uploadedSize: 68,
  captureAt: [] as number[],
  decodeValid: true,
  raceBeforeReplace: false,
  mediaRaceThumbnail: false,
}));

const aiState = vi.hoisted(() => ({
  create: vi.fn(async () => {
    throw new Error("AI must not be called by thumbnail routes");
  }),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: aiState.create } } },
}));

vi.mock("../training/videos-store", () => ({
  isVideoId: () => true,
  getVideoRecord: vi.fn(async () => ({ ...state.record })),
  updateVideoRecord: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
    state.updates.push(patch);
    Object.assign(state.record, patch);
  }),
  replaceThumbnailIfCurrent: vi.fn(
    async (
      _id: string,
      expectedVideoSource: string,
      expectedThumbnailSource: string | null,
      thumbnailSource: string,
    ) => {
      if (state.raceBeforeReplace) {
        state.record.video_source = `${VIDEO_PATH}-replaced-during-write`;
        state.raceBeforeReplace = false;
      }
      if (
        state.record.video_source !== expectedVideoSource ||
        state.record.thumbnail_source !== expectedThumbnailSource
      ) {
        return false;
      }
      state.record.thumbnail_source = thumbnailSource;
      state.updates.push({ thumbnail_source: thumbnailSource });
      return true;
    },
  ),
  updateHostedMediaIfCurrent: vi.fn(
    async (
      _id: string,
      expectedVideoSource: string | null,
      expectedThumbnailSource: string | null,
      patch: Record<string, unknown>,
    ) => {
      if (state.mediaRaceThumbnail) {
        state.record.thumbnail_source = `${CUSTOM_THUMB_PATH}-race-winner`;
        state.mediaRaceThumbnail = false;
      }
      if (
        state.record.video_source !== expectedVideoSource ||
        state.record.thumbnail_source !== expectedThumbnailSource
      ) {
        return false;
      }
      Object.assign(state.record, patch);
      state.updates.push(patch);
      return true;
    },
  ),
  deleteTranscript: vi.fn(async () => {}),
  getTranscript: vi.fn(async () => null),
  upsertTranscript: vi.fn(async () => {}),
}));

vi.mock("../training/pipeline", () => ({
  captureFrame: vi.fn(async (_input: string, atSeconds: number) => {
    state.captureAt.push(atSeconds);
  }),
  cleanupWorkDir: vi.fn(async () => {}),
  extractAudioSegments: vi.fn(async () => []),
  makeWorkDir: vi.fn(async () => "/tmp/training-media-test"),
  probeMedia: vi.fn(async () => ({ durationSeconds: 90.4, hasVideo: true, hasAudio: true })),
  transcribeSegments: vi.fn(async () => []),
  writeChapters: vi.fn(async () => []),
  writeDescription: vi.fn(async () => []),
  validateThumbnailImage: vi.fn(async () => {
    if (!state.decodeValid) throw new Error("decode failed");
  }),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(async () => Buffer.from("captured frame")),
  writeFile: vi.fn(async () => {}),
}));

vi.mock("../lib/objectStorage", () => {
  class ObjectNotFoundError extends Error {}
  return {
    ObjectNotFoundError,
    PLAYBACK_URL_TTL_SEC: 10_800,
    THUMBNAIL_CONTENT_TYPES: new Set(["image/jpeg", "image/png", "image/webp"]),
    detectThumbnailContentType: () => state.detectedType,
    objectStorage: {
      trainingUploadURL: vi.fn(async (_videoId: string, kind: string) => ({
        uploadUrl: "https://storage.test/upload",
        objectPath:
          kind === "thumb"
            ? CUSTOM_THUMB_PATH
            : `/objects/training-videos/${VIDEO_ID}/video-new`,
      })),
      entityFile: vi.fn(async () => ({
        getMetadata: vi.fn(async () => [
          { size: state.uploadedSize, contentType: state.uploadedContentType },
        ]),
        download: vi.fn(async (options?: { destination?: string }) =>
          options?.destination ? undefined : [Buffer.alloc(state.uploadedSize)],
        ),
      })),
      signedDownloadURL: vi.fn(async (path: string) => `https://storage.test${path}`),
      saveBuffer: vi.fn(async (path: string, _content: Buffer, contentType: string) => {
        state.saved.push({ path, contentType });
      }),
      deleteObject: vi.fn(async (path: string) => {
        state.deleted.push(path);
      }),
    },
  };
});

import trainingMediaRouter from "./training-media";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  const app = express();
  // Same as the real app: X-Forwarded-For controls req.ip, so every call
  // can ride its own client IP and the write limiter never interferes.
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(trainingMediaRouter);
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
  state.record.video_source = VIDEO_PATH;
  state.record.thumbnail_source = OLD_THUMB_PATH;
  state.record.duration_seconds = 120;
  state.deleted.length = 0;
  state.saved.length = 0;
  state.updates.length = 0;
  state.captureAt.length = 0;
  state.detectedType = "image/png";
  state.uploadedContentType = "image/png";
  state.uploadedSize = 68;
  state.decodeValid = true;
  state.raceBeforeReplace = false;
  state.mediaRaceThumbnail = false;
  aiState.create.mockClear();
});

let ipCounter = 0;

/** Distinct client IP per call; the limiter test pins one IP explicitly. */
function nextIp(): string {
  ipCounter += 1;
  return `10.9.${Math.floor(ipCounter / 200)}.${(ipCounter % 200) + 1}`;
}

async function post(path: string, body: unknown, ip = nextIp()): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify(body),
  });
}

describe("training thumbnail lifecycle", () => {
  it("mints a video-owned custom upload and replaces the previous thumbnail", async () => {
    const mint = await post(`/training/videos/${VIDEO_ID}/thumbnail-upload-url`, {
      fileName: "cover.png",
      contentType: "image/png",
      sizeBytes: 68,
    });
    expect(mint.status).toBe(200);
    expect(await mint.json()).toMatchObject({
      objectPath: CUSTOM_THUMB_PATH,
      videoSource: VIDEO_PATH,
    });

    const finalize = await post(`/training/videos/${VIDEO_ID}/thumbnail-upload`, {
      objectPath: CUSTOM_THUMB_PATH,
      contentType: "image/png",
      videoSource: VIDEO_PATH,
    });
    expect(finalize.status).toBe(200);
    expect(state.record.thumbnail_source).toBe(CUSTOM_THUMB_PATH);
    expect(state.deleted).toContain(OLD_THUMB_PATH);
  });

  it("rejects invalid image bytes and stale video revisions", async () => {
    state.detectedType = null;
    const invalid = await post(`/training/videos/${VIDEO_ID}/thumbnail-upload`, {
      objectPath: CUSTOM_THUMB_PATH,
      contentType: "image/png",
      videoSource: VIDEO_PATH,
    });
    expect(invalid.status).toBe(422);
    expect(state.deleted).toContain(CUSTOM_THUMB_PATH);
    expect(state.record.thumbnail_source).toBe(OLD_THUMB_PATH);

    state.detectedType = "image/png";
    state.decodeValid = false;
    const damaged = await post(`/training/videos/${VIDEO_ID}/thumbnail-upload`, {
      objectPath: CUSTOM_THUMB_PATH,
      contentType: "image/png",
      videoSource: VIDEO_PATH,
    });
    expect(damaged.status).toBe(422);
    expect(state.deleted).toContain(CUSTOM_THUMB_PATH);

    state.decodeValid = true;
    const stale = await post(`/training/videos/${VIDEO_ID}/thumbnail-upload`, {
      objectPath: CUSTOM_THUMB_PATH,
      contentType: "image/png",
      videoSource: OLD_VIDEO_PATH,
    });
    expect(stale.status).toBe(409);
    expect(state.record.thumbnail_source).toBe(OLD_THUMB_PATH);
  });

  it("loses an atomic race safely and deletes the unused candidate", async () => {
    state.raceBeforeReplace = true;
    const raced = await post(`/training/videos/${VIDEO_ID}/thumbnail-upload`, {
      objectPath: CUSTOM_THUMB_PATH,
      contentType: "image/png",
      videoSource: VIDEO_PATH,
    });
    expect(raced.status).toBe(409);
    expect(state.deleted).toContain(CUSTOM_THUMB_PATH);
    expect(state.record.thumbnail_source).toBe(OLD_THUMB_PATH);
  });

  it("keeps automatic first-frame and scrub capture free of model calls", async () => {
    state.record.video_source = OLD_VIDEO_PATH;
    state.mediaRaceThumbnail = true;
    const replacement = await post(`/training/videos/${VIDEO_ID}/video`, {
      objectPath: `/objects/training-videos/${VIDEO_ID}/video-new`,
    });
    expect(replacement.status).toBe(200);
    expect(state.captureAt).toContain(0);
    expect(state.deleted).toEqual(
      expect.arrayContaining([
        OLD_VIDEO_PATH,
        `${CUSTOM_THUMB_PATH}-race-winner`,
      ]),
    );
    expect(state.saved.some((item) => item.contentType === "image/jpeg")).toBe(true);

    state.captureAt.length = 0;
    state.deleted.length = 0;
    const prior = state.record.thumbnail_source;
    const scrub = await post(`/training/videos/${VIDEO_ID}/thumbnail`, { atSeconds: 37 });
    expect(scrub.status).toBe(200);
    expect(state.captureAt).toEqual([37]);
    expect(state.deleted).toContain(prior);
    expect(aiState.create).not.toHaveBeenCalled();
  });
});

describe("open access (demo posture)", () => {
  it("serves tokenless callers and treats a bearer as decoration — ignored, not verified", async () => {
    const tokenless = await fetch(`${baseUrl}/training/videos/${VIDEO_ID}/media`, {
      headers: { "X-Forwarded-For": nextIp() },
    });
    expect(tokenless.status).toBe(200);

    // A synthetic bearer would 401 under the old staff gate; now it changes nothing.
    const withBearer = await fetch(`${baseUrl}/training/videos/${VIDEO_ID}/media`, {
      headers: { "X-Forwarded-For": nextIp(), Authorization: "Bearer synthetic-staff-bearer" },
    });
    expect(withBearer.status).toBe(200);
    // Compare the stable fields — expiresAtMs is clock-derived per call.
    const first = (await tokenless.json()) as Record<string, unknown>;
    const second = (await withBearer.json()) as Record<string, unknown>;
    expect(second.videoUrl).toBe(first.videoUrl);
    expect(second.thumbnailUrl).toBe(first.thumbnailUrl);
  });

  it("mints an upload URL for a tokenless caller — the demo can really upload", async () => {
    const mint = await post(`/training/videos/${VIDEO_ID}/upload-url`, {
      fileName: "lesson.mp4",
      contentType: "video/mp4",
      sizeBytes: 1024,
    });
    expect(mint.status).toBe(200);
    expect(await mint.json()).toMatchObject({
      uploadUrl: "https://storage.test/upload",
      objectPath: `/objects/training-videos/${VIDEO_ID}/video-new`,
    });
  });
});

describe("per-IP write limiter (runs last — drains one IP's bucket)", () => {
  it("429s rapid-fire writes from one IP; reads and other IPs stay open", async () => {
    const ip = "10.9.250.1";
    const denials: Array<Record<string, unknown> | null> = [];
    // TRAINING_WRITE_BURST defaults to 20; 30 attempts must trip it.
    for (let i = 0; i < 30; i++) {
      const response = await post(
        `/training/videos/${VIDEO_ID}/upload-url`,
        { fileName: "lesson.mp4", contentType: "video/mp4", sizeBytes: 1024 },
        ip,
      );
      if (response.status === 429) {
        denials.push((await response.json()) as Record<string, unknown>);
      }
    }
    expect(denials.length).toBeGreaterThan(0);
    for (const denial of denials) {
      expect(String(denial?.error)).toContain("too quickly");
      expect(denial?.retryable).toBe(true);
    }

    // Reads from the SAME drained IP still pass — only writes are limited.
    for (let i = 0; i < 5; i++) {
      const read = await fetch(`${baseUrl}/training/videos/${VIDEO_ID}/media`, {
        headers: { "X-Forwarded-For": ip },
      });
      expect(read.status).toBe(200);
    }

    // A fresh visitor's bucket is untouched.
    const fresh = await post(`/training/videos/${VIDEO_ID}/upload-url`, {
      fileName: "lesson.mp4",
      contentType: "video/mp4",
      sizeBytes: 1024,
    });
    expect(fresh.status).toBe(200);
  });
});