import express, {
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const VIDEO_ID = "11111111-1111-4111-8111-111111111111";
const VIDEO_PATH = `/objects/training-videos/${VIDEO_ID}/video-current`;
const OLD_VIDEO_PATH = `/objects/training-videos/${VIDEO_ID}/video-old`;
const OLD_THUMB_PATH = `/objects/training-videos/${VIDEO_ID}/thumb-old`;
const CUSTOM_THUMB_PATH = `/objects/training-videos/${VIDEO_ID}/thumb-22222222-2222-4222-8222-222222222222`;
const ATTACHMENT_PATH = `/objects/training-attachments/${VIDEO_ID}/file-33333333-3333-4333-8333-333333333333`;
const SECOND_ATTACHMENT_PATH = `/objects/training-attachments/${VIDEO_ID}/file-44444444-4444-4444-8444-444444444444`;

const state = vi.hoisted(() => ({
  record: {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Lesson",
    duration_seconds: 120,
    description: [],
    chapters: [],
    thumbnail_chapter: 0,
    video_source: "/objects/training-videos/11111111-1111-4111-8111-111111111111/video-current" as string | null,
    thumbnail_source: "/objects/training-videos/11111111-1111-4111-8111-111111111111/thumb-old" as string | null,
    attachments: [] as unknown[],
  },
  deleted: [] as string[],
  saved: [] as Array<{ path: string; contentType: string }>,
  updates: [] as Array<Record<string, unknown>>,
  metadataSet: [] as Array<Record<string, unknown>>,
  detectedType: "image/png" as string | null,
  uploadedContentType: "image/png",
  uploadedSize: 68,
  captureAt: [] as number[],
  decodeValid: true,
  entityMissing: false,
  raceBeforeReplace: false,
  mediaRaceThumbnail: false,
  attachmentsRaceOnce: false,
  attachmentsCasAlwaysFail: false,
  mediaCasAlwaysFail: false,
  failDeletePaths: new Set<string>(),
  failQueuePaths: new Set<string>(),
  queueFailOnlySecond: false,
  setMetadataThrows: false,
  replaceThumbnailThrows: false,
  transcriptDeletes: 0,
  cleanupQueued: [] as Array<{ path: string; videoId: string | null; reason: string }>,
  cleanupRows: [] as Array<{ id: string; object_path: string; video_id?: string | null }>,
}));

const aiState = vi.hoisted(() => ({
  create: vi.fn(async () => {
    throw new Error("AI must not be called by thumbnail routes");
  }),
}));

vi.mock("../lib/staff-auth", () => ({
  requireHqPermission: () => (req: Request, res: ExpressResponse, next: NextFunction) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/, "");
    if (!token) return void res.status(401).json({ error: "Sign in to continue." });
    if (token !== "content-token" && token !== "admin-token") {
      return void res.status(403).json({ error: "Your HQ role does not have permission to do this." });
    }
    next();
  },
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
      if (state.replaceThumbnailThrows) throw new Error("thumbnail swap unavailable");
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
      if (state.mediaCasAlwaysFail) return false;
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
  updateAttachmentsIfCurrent: vi.fn(
    async (_id: string, expected: unknown, next: unknown[]) => {
      if (state.attachmentsCasAlwaysFail) return false;
      if (state.attachmentsRaceOnce) {
        // A concurrent writer lands between the caller's read and this CAS.
        state.attachmentsRaceOnce = false;
        state.record.attachments = [
          ...state.record.attachments,
          { id: "raced-in", name: "Raced.pdf", sizeLabel: "1 KB", source: null, contentType: null, sizeBytes: null },
        ];
      }
      if (JSON.stringify(state.record.attachments ?? null) !== JSON.stringify(expected ?? null)) {
        return false;
      }
      state.record.attachments = next;
      state.updates.push({ attachments: next });
      return true;
    },
  ),
  deleteTranscript: vi.fn(async () => {
    state.transcriptDeletes += 1;
  }),
  queueMediaCleanup: vi.fn(async (objectPath: string, videoId: string | null, reason: string) => {
    const exists = state.cleanupRows.some((row) => row.object_path === objectPath);
    if (state.failQueuePaths.has(objectPath) && (!state.queueFailOnlySecond || exists)) {
      throw new Error("cleanup ledger unavailable");
    }
    state.cleanupQueued.push({ path: objectPath, videoId, reason });
    if (!exists) {
      state.cleanupRows.push({ id: `row-${objectPath}`, object_path: objectPath, video_id: videoId });
    }
  }),
  listMediaCleanup: vi.fn(async (limit: number) =>
    state.cleanupRows.slice(0, limit).map((row) => ({ ...row })),
  ),
  deleteMediaCleanup: vi.fn(async (id: string) => {
    state.cleanupRows = state.cleanupRows.filter((row) => row.id !== id);
  }),
  dequeueMediaCleanup: vi.fn(async (objectPath: string) => {
    state.cleanupRows = state.cleanupRows.filter((row) => row.object_path !== objectPath);
  }),
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
      trainingAttachmentUploadURL: vi.fn(async (_videoId: string) => ({
        uploadUrl: "https://storage.test/upload-attachment",
        objectPath: ATTACHMENT_PATH,
      })),
      entityFile: vi.fn(async () => {
        if (state.entityMissing) throw new ObjectNotFoundError();
        return {
          getMetadata: vi.fn(async () => [
            { size: state.uploadedSize, contentType: state.uploadedContentType },
          ]),
          setMetadata: vi.fn(async (metadata: Record<string, unknown>) => {
          if (state.setMetadataThrows) throw new Error("metadata write failed");
            state.metadataSet.push(metadata);
          }),
          download: vi.fn(async (options?: { destination?: string }) =>
            options?.destination ? undefined : [Buffer.alloc(state.uploadedSize)],
          ),
        };
      }),
      signedDownloadURL: vi.fn(async (path: string) => `https://storage.test${path}`),
      saveBuffer: vi.fn(async (path: string, _content: Buffer, contentType: string) => {
        state.saved.push({ path, contentType });
      }),
      deleteObject: vi.fn(async (path: string) => {
        state.deleted.push(path);
      }),
      deleteObjectStrict: vi.fn(async (path: string) => {
        if (state.failDeletePaths.has(path)) throw new Error("storage refused the delete");
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
  state.record.attachments = [];
  state.deleted.length = 0;
  state.saved.length = 0;
  state.updates.length = 0;
  state.metadataSet.length = 0;
  state.captureAt.length = 0;
  state.detectedType = "image/png";
  state.uploadedContentType = "image/png";
  state.uploadedSize = 68;
  state.decodeValid = true;
  state.entityMissing = false;
  state.raceBeforeReplace = false;
  state.mediaRaceThumbnail = false;
  state.attachmentsRaceOnce = false;
  state.attachmentsCasAlwaysFail = false;
  state.mediaCasAlwaysFail = false;
  state.failDeletePaths.clear();
  state.failQueuePaths.clear();
  state.queueFailOnlySecond = false;
  state.setMetadataThrows = false;
  state.replaceThumbnailThrows = false;
  state.transcriptDeletes = 0;
  state.cleanupQueued = [];
  state.cleanupRows = [];
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
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, Authorization: "Bearer content-token" },
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

describe("content authorization", () => {
  it("preserves the learner media read while denying anonymous, Clinical, and Support mutations", async () => {
    const tokenless = await fetch(`${baseUrl}/training/videos/${VIDEO_ID}/media`, {
      headers: { "X-Forwarded-For": nextIp() },
    });
    expect(tokenless.status).toBe(200);
    const anonymousWrite = await fetch(`${baseUrl}/training/videos/${VIDEO_ID}/upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": nextIp() },
      body: JSON.stringify({ fileName: "lesson.mp4", contentType: "video/mp4", sizeBytes: 1024 }),
    });
    expect(anonymousWrite.status).toBe(401);
    for (const token of ["clinical-token", "support-token"]) {
      const response = await fetch(`${baseUrl}/training/videos/${VIDEO_ID}/upload-url`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": nextIp(),
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ fileName: "lesson.mp4", contentType: "video/mp4", sizeBytes: 1024 }),
      });
      expect(response.status).toBe(403);
    }
  });

  it.each(["content-token", "admin-token"])("allows %s", async (token) => {
    const response = await fetch(`${baseUrl}/training/videos/${VIDEO_ID}/media`, {
      headers: { "X-Forwarded-For": nextIp(), Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });
});

describe("lesson attachments", () => {
  const finalizeBody = {
    objectPath: ATTACHMENT_PATH,
    name: "Intake worksheet.pdf",
    contentType: "application/pdf",
  };

  async function del(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "DELETE",
      headers: { "X-Forwarded-For": nextIp(), Authorization: "Bearer content-token" },
    });
  }

  async function get(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { "X-Forwarded-For": nextIp(), Authorization: "Bearer content-token" } });
  }

  it("mints attachment uploads in their own folder — never the video prefix", async () => {
    const mint = await post(`/training/videos/${VIDEO_ID}/attachment-upload-url`, {
      fileName: "Worksheet.pdf",
      contentType: "application/pdf",
      sizeBytes: 431104,
    });
    expect(mint.status).toBe(200);
    const body = (await mint.json()) as Record<string, unknown>;
    expect(body.objectPath).toBe(ATTACHMENT_PATH);
    expect(String(body.objectPath)).toContain("/objects/training-attachments/");
    expect(String(body.objectPath)).not.toContain("/objects/training-videos/");
  });

  it("refuses disallowed types, oversize declarations, and full lessons", async () => {
    const exe = await post(`/training/videos/${VIDEO_ID}/attachment-upload-url`, {
      fileName: "setup.exe",
      contentType: "application/x-msdownload",
      sizeBytes: 1024,
    });
    expect(exe.status).toBe(415);

    // The zod bound IS the 25 MB cap, so an oversize declaration dies as an
    // invalid body before the route's own defense-in-depth check.
    const big = await post(`/training/videos/${VIDEO_ID}/attachment-upload-url`, {
      fileName: "huge.pdf",
      contentType: "application/pdf",
      sizeBytes: 30_000_000,
    });
    expect(big.status).toBe(400);

    state.record.attachments = Array.from({ length: 12 }, (_, i) => ({
      id: `a${i}`,
      name: `File ${i}`,
      sizeLabel: "1 KB",
      source: null,
      contentType: null,
      sizeBytes: null,
    }));
    const full = await post(`/training/videos/${VIDEO_ID}/attachment-upload-url`, {
      fileName: "one-more.pdf",
      contentType: "application/pdf",
      sizeBytes: 1024,
    });
    expect(full.status).toBe(409);
  });

  it("finalize verifies stored bytes, stamps the download name, and appends the entry", async () => {
    state.uploadedContentType = "application/pdf";
    state.uploadedSize = 431104;
    const finalize = await post(`/training/videos/${VIDEO_ID}/attachments`, finalizeBody);
    expect(finalize.status).toBe(200);
    const body = (await finalize.json()) as { attachment: Record<string, unknown> };
    expect(body.attachment).toMatchObject({
      name: "Intake worksheet.pdf",
      sizeLabel: "421 KB",
      source: ATTACHMENT_PATH,
      contentType: "application/pdf",
      sizeBytes: 431104,
    });
    expect(typeof body.attachment.id).toBe("string");
    expect(state.record.attachments).toHaveLength(1);
    // The stored object now downloads under its real name forever.
    expect(
      state.metadataSet.some((metadata) =>
        String(metadata.contentDisposition).includes('filename="Intake worksheet.pdf"'),
      ),
    ).toBe(true);
    expect(state.deleted).toEqual([]);
  });

  it("finalize rejects paths outside this video's attachments folder", async () => {
    // The video folder — right video, wrong lifecycle.
    const cross = await post(`/training/videos/${VIDEO_ID}/attachments`, {
      ...finalizeBody,
      objectPath: VIDEO_PATH,
    });
    expect(cross.status).toBe(400);

    // Another video's attachments folder.
    const foreign = await post(`/training/videos/${VIDEO_ID}/attachments`, {
      ...finalizeBody,
      objectPath: "/objects/training-attachments/99999999-9999-4999-8999-999999999999/file-x",
    });
    expect(foreign.status).toBe(400);
    expect(state.record.attachments).toEqual([]);
  });

  it("finalize deletes the stray object when stored bytes flunk re-validation", async () => {
    state.uploadedContentType = "application/pdf";
    state.uploadedSize = 0;
    const empty = await post(`/training/videos/${VIDEO_ID}/attachments`, finalizeBody);
    expect(empty.status).toBe(413);
    expect(state.deleted).toContain(ATTACHMENT_PATH);

    state.deleted.length = 0;
    state.uploadedSize = 26_214_401;
    const oversize = await post(`/training/videos/${VIDEO_ID}/attachments`, finalizeBody);
    expect(oversize.status).toBe(413);
    expect(state.deleted).toContain(ATTACHMENT_PATH);

    state.deleted.length = 0;
    state.uploadedSize = 2048;
    state.uploadedContentType = "application/zip";
    const mismatch = await post(`/training/videos/${VIDEO_ID}/attachments`, finalizeBody);
    expect(mismatch.status).toBe(422);
    expect(state.deleted).toContain(ATTACHMENT_PATH);

    expect(state.record.attachments).toEqual([]);
  });

  it("finalize 404s a missing upload and 415s an undeclared type", async () => {
    state.entityMissing = true;
    const missing = await post(`/training/videos/${VIDEO_ID}/attachments`, finalizeBody);
    expect(missing.status).toBe(404);

    state.entityMissing = false;
    const badType = await post(`/training/videos/${VIDEO_ID}/attachments`, {
      ...finalizeBody,
      contentType: "application/zip",
    });
    expect(badType.status).toBe(415);
    expect(state.record.attachments).toEqual([]);
  });

  it("finalize retries through a concurrent append and keeps both entries", async () => {
    state.uploadedContentType = "application/pdf";
    state.uploadedSize = 2048;
    state.attachmentsRaceOnce = true;
    const finalize = await post(`/training/videos/${VIDEO_ID}/attachments`, finalizeBody);
    expect(finalize.status).toBe(200);
    const list = state.record.attachments as Array<{ id: string }>;
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe("raced-in");
  });

  it("finalize gives up after persistent CAS losses and deletes the upload", async () => {
    state.uploadedContentType = "application/pdf";
    state.uploadedSize = 2048;
    state.attachmentsCasAlwaysFail = true;
    const finalize = await post(`/training/videos/${VIDEO_ID}/attachments`, finalizeBody);
    expect(finalize.status).toBe(409);
    expect(state.deleted).toContain(ATTACHMENT_PATH);
    expect(state.record.attachments).toEqual([]);
  });

  it("downloads mint short-lived URLs for hosted entries; legacy entries 404 honestly", async () => {
    state.record.attachments = [
      {
        id: "att-hosted",
        name: "Guide.pdf",
        sizeLabel: "421 KB",
        source: ATTACHMENT_PATH,
        contentType: "application/pdf",
        sizeBytes: 431104,
      },
      { id: "att-legacy", name: "Old sheet", sizeLabel: "1.2 MB" },
    ];
    const hosted = await get(
      `/training/videos/${VIDEO_ID}/attachments/att-hosted/download-url`,
    );
    expect(hosted.status).toBe(200);
    const body = (await hosted.json()) as Record<string, unknown>;
    expect(body.downloadUrl).toBe(`https://storage.test${ATTACHMENT_PATH}`);
    expect(body.name).toBe("Guide.pdf");
    expect(typeof body.expiresAtMs).toBe("number");

    const legacy = await get(
      `/training/videos/${VIDEO_ID}/attachments/att-legacy/download-url`,
    );
    expect(legacy.status).toBe(404);

    const unknown = await get(
      `/training/videos/${VIDEO_ID}/attachments/att-nope/download-url`,
    );
    expect(unknown.status).toBe(404);
  });

  it("removing an attachment deletes its stored file; legacy removals skip storage", async () => {
    state.record.attachments = [
      {
        id: "att-hosted",
        name: "Guide.pdf",
        sizeLabel: "421 KB",
        source: ATTACHMENT_PATH,
        contentType: "application/pdf",
        sizeBytes: 431104,
      },
      { id: "att-legacy", name: "Old sheet", sizeLabel: "1.2 MB" },
    ];
    const removeHosted = await del(`/training/videos/${VIDEO_ID}/attachments/att-hosted`);
    expect(removeHosted.status).toBe(200);
    expect(state.deleted).toEqual([ATTACHMENT_PATH]);
    expect(state.record.attachments).toHaveLength(1);

    const removeLegacy = await del(`/training/videos/${VIDEO_ID}/attachments/att-legacy`);
    expect(removeLegacy.status).toBe(200);
    expect(state.record.attachments).toEqual([]);
    expect(state.deleted).toEqual([ATTACHMENT_PATH]);

    const gone = await del(`/training/videos/${VIDEO_ID}/attachments/att-legacy`);
    expect(gone.status).toBe(404);
  });

  it("a refused storage delete keeps the entry retryable — never an invisible orphan", async () => {
    state.record.attachments = [
      {
        id: "att-hosted",
        name: "Guide.pdf",
        sizeLabel: "421 KB",
        source: ATTACHMENT_PATH,
        contentType: "application/pdf",
        sizeBytes: 431104,
      },
    ];
    state.failDeletePaths.add(ATTACHMENT_PATH);
    const refused = await del(`/training/videos/${VIDEO_ID}/attachments/att-hosted`);
    expect(refused.status).toBe(502);
    // The row still references the file: it stays visible, downloadable, and
    // removable — the DB reference is the retry handle.
    expect(state.record.attachments).toHaveLength(1);
    expect(state.deleted).toEqual([]);
    const stillThere = await get(`/training/videos/${VIDEO_ID}/attachments/att-hosted/download-url`);
    expect(stillThere.status).toBe(200);

    // Storage heals → the same call finishes both halves.
    state.failDeletePaths.clear();
    const retry = await del(`/training/videos/${VIDEO_ID}/attachments/att-hosted`);
    expect(retry.status).toBe(200);
    expect(state.deleted).toEqual([ATTACHMENT_PATH]);
    expect(state.record.attachments).toEqual([]);
  });

  it("clear-all keeps exactly the entries whose files refused deletion", async () => {
    const hosted = {
      id: "att-one",
      name: "Guide.pdf",
      sizeLabel: "421 KB",
      source: ATTACHMENT_PATH,
      contentType: "application/pdf",
      sizeBytes: 431104,
    };
    const stubborn = {
      id: "att-two",
      name: "Sheet.xlsx",
      sizeLabel: "2 KB",
      source: SECOND_ATTACHMENT_PATH,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 2048,
    };
    state.record.attachments = [hosted, stubborn, { id: "att-legacy", name: "Old sheet", sizeLabel: "1.2 MB" }];
    state.failDeletePaths.add(SECOND_ATTACHMENT_PATH);
    const partial = await del(`/training/videos/${VIDEO_ID}/attachments`);
    expect(partial.status).toBe(502);
    // The deletable file and the legacy entry are gone; the refused one keeps
    // its entry so a retry can finish the job.
    expect(state.deleted).toEqual([ATTACHMENT_PATH]);
    expect(state.record.attachments).toEqual([stubborn]);

    state.failDeletePaths.clear();
    const retry = await del(`/training/videos/${VIDEO_ID}/attachments`);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ removed: 1, deletedObjects: 1 });
    expect(state.record.attachments).toEqual([]);
    expect(state.deleted).toEqual([ATTACHMENT_PATH, SECOND_ATTACHMENT_PATH]);
  });

  it("hosted-file removal is object-first too: objects, then references, then transcript", async () => {
    const videoObj = `/objects/training-videos/${VIDEO_ID}/video-current`;
    const thumbObj = `/objects/training-videos/${VIDEO_ID}/thumb-old`;
    state.record.video_source = videoObj;
    state.record.thumbnail_source = thumbObj;
    const removed = await del(`/training/videos/${VIDEO_ID}/video`);
    expect(removed.status).toBe(200);
    expect(state.deleted).toEqual([videoObj, thumbObj]);
    expect(state.record.video_source).toBeNull();
    expect(state.record.thumbnail_source).toBeNull();
    expect(state.transcriptDeletes).toBe(1);
  });

  it("a refused video-object delete keeps the row's media references and transcript", async () => {
    const videoObj = `/objects/training-videos/${VIDEO_ID}/video-current`;
    const thumbObj = `/objects/training-videos/${VIDEO_ID}/thumb-old`;
    state.record.video_source = videoObj;
    state.record.thumbnail_source = thumbObj;
    state.failDeletePaths.add(videoObj);
    const refused = await del(`/training/videos/${VIDEO_ID}/video`);
    expect(refused.status).toBe(502);
    // Nothing changed: the row still points at its media, the transcript
    // survives, and no object was deleted — the row is the retry handle.
    expect(state.record.video_source).toBe(videoObj);
    expect(state.record.thumbnail_source).toBe(thumbObj);
    expect(state.deleted).toEqual([]);
    expect(state.transcriptDeletes).toBe(0);

    state.failDeletePaths.clear();
    const retry = await del(`/training/videos/${VIDEO_ID}/video`);
    expect(retry.status).toBe(200);
    expect(state.deleted).toEqual([videoObj, thumbObj]);
    expect(state.record.video_source).toBeNull();
    expect(state.transcriptDeletes).toBe(1);
  });

  it("a refused thumbnail delete aborts before any reference is cleared — retry converges", async () => {
    const videoObj = `/objects/training-videos/${VIDEO_ID}/video-current`;
    const thumbObj = `/objects/training-videos/${VIDEO_ID}/thumb-old`;
    state.record.video_source = videoObj;
    state.record.thumbnail_source = thumbObj;
    state.failDeletePaths.add(thumbObj);
    const refused = await del(`/training/videos/${VIDEO_ID}/video`);
    expect(refused.status).toBe(502);
    expect(state.record.video_source).toBe(videoObj);
    expect(state.record.thumbnail_source).toBe(thumbObj);
    expect(state.deleted).toEqual([videoObj]);
    expect(state.transcriptDeletes).toBe(0);

    state.failDeletePaths.clear();
    const retry = await del(`/training/videos/${VIDEO_ID}/video`);
    expect(retry.status).toBe(200);
    // The video object is re-deleted as a no-op (missing counts as deleted),
    // then the thumbnail comes out and the references clear.
    expect(state.deleted).toEqual([videoObj, videoObj, thumbObj]);
    expect(state.record.video_source).toBeNull();
    expect(state.record.thumbnail_source).toBeNull();
    expect(state.transcriptDeletes).toBe(1);
  });

  it("a refused displaced delete after a video replace keeps the new reference and queues retry handles", async () => {
    const oldVideo = `/objects/training-videos/${VIDEO_ID}/video-current`;
    const oldThumb = `/objects/training-videos/${VIDEO_ID}/thumb-old`;
    const newVideo = `/objects/training-videos/${VIDEO_ID}/video-new`;
    state.record.video_source = oldVideo;
    state.record.thumbnail_source = oldThumb;
    state.failDeletePaths.add(oldVideo);
    state.failDeletePaths.add(oldThumb);
    const replaced = await post(`/training/videos/${VIDEO_ID}/video`, { objectPath: newVideo });
    expect(replaced.status).toBe(200);
    // The active reference is the NEW file — cleanup trouble never corrupts it.
    expect(state.record.video_source).toBe(newVideo);
    expect(state.deleted).not.toContain(oldVideo);
    expect(state.deleted).not.toContain(oldThumb);
    expect(state.cleanupQueued).toEqual(
      expect.arrayContaining([
        { path: oldVideo, videoId: state.record.id, reason: "displaced" },
        { path: oldThumb, videoId: state.record.id, reason: "displaced" },
      ]),
    );
  });

  it("a raced-in thumbnail whose displaced delete is refused still queues cleanup", async () => {
    const oldVideo = `/objects/training-videos/${VIDEO_ID}/video-current`;
    const newVideo = `/objects/training-videos/${VIDEO_ID}/video-new`;
    const raceWinner = `${CUSTOM_THUMB_PATH}-race-winner`;
    state.record.video_source = oldVideo;
    state.record.thumbnail_source = null;
    state.mediaRaceThumbnail = true;
    state.failDeletePaths.add(raceWinner);
    const replaced = await post(`/training/videos/${VIDEO_ID}/video`, { objectPath: newVideo });
    expect(replaced.status).toBe(200);
    // The healthy displaced video still deletes; only the raced-in thumbnail
    // needs a retry handle.
    expect(state.deleted).toContain(oldVideo);
    expect(state.deleted).not.toContain(raceWinner);
    expect(state.cleanupQueued).toContainEqual({
      path: raceWinner,
      videoId: state.record.id,
      reason: "displaced",
    });
  });

  it("custom thumbnail finalize keeps the new thumbnail when the old one's delete is refused", async () => {
    state.failDeletePaths.add(OLD_THUMB_PATH);
    const finalized = await post(`/training/videos/${VIDEO_ID}/thumbnail-upload`, {
      objectPath: CUSTOM_THUMB_PATH,
      contentType: "image/png",
      videoSource: VIDEO_PATH,
    });
    expect(finalized.status).toBe(200);
    expect(state.record.thumbnail_source).toBe(CUSTOM_THUMB_PATH);
    expect(state.deleted).not.toContain(OLD_THUMB_PATH);
    expect(state.cleanupQueued).toContainEqual({
      path: OLD_THUMB_PATH,
      videoId: state.record.id,
      reason: "displaced",
    });
  });

  it("a stray upload whose delete is refused becomes a queued retry handle, not a silent orphan", async () => {
    const newVideo = `/objects/training-videos/${VIDEO_ID}/video-new`;
    state.mediaCasAlwaysFail = true;
    state.failDeletePaths.add(newVideo);
    const lost = await post(`/training/videos/${VIDEO_ID}/video`, { objectPath: newVideo });
    expect(lost.status).toBe(409);
    expect(state.record.video_source).not.toBe(newVideo);
    expect(state.cleanupQueued).toContainEqual({
      path: newVideo,
      videoId: state.record.id,
      reason: "stray",
    });
  });

  it("later finalize writes drain the cleanup ledger, keeping only still-refused rows", async () => {
    const stubborn = `/objects/training-videos/${VIDEO_ID}/old-stubborn`;
    const drainable = `/objects/training-videos/${VIDEO_ID}/old-drainable`;
    state.cleanupRows = [
      { id: "row-1", object_path: stubborn },
      { id: "row-2", object_path: drainable },
    ];
    state.failDeletePaths.add(stubborn);
    const finalized = await post(`/training/videos/${VIDEO_ID}/thumbnail-upload`, {
      objectPath: CUSTOM_THUMB_PATH,
      contentType: "image/png",
      videoSource: VIDEO_PATH,
    });
    expect(finalized.status).toBe(200);
    expect(state.deleted).toContain(drainable);
    expect(state.cleanupRows).toEqual([{ id: "row-1", object_path: stubborn }]);
  });

  it("a ledger outage before the swap aborts the replace with nothing mutated", async () => {
    const oldVideo = `/objects/training-videos/${VIDEO_ID}/video-current`;
    const newVideo = `/objects/training-videos/${VIDEO_ID}/video-new`;
    state.record.video_source = oldVideo;
    state.record.thumbnail_source = null;
    state.failQueuePaths.add(oldVideo);
    const blocked = await post(`/training/videos/${VIDEO_ID}/video`, { objectPath: newVideo });
    expect(blocked.status).toBe(500);
    // Nothing swapped — and the now-stray upload still got a durable fate.
    expect(state.record.video_source).toBe(oldVideo);
    expect(state.deleted).toContain(newVideo);
  });

  it("storage refusal plus ledger outage after the swap never reports success", async () => {
    const oldVideo = `/objects/training-videos/${VIDEO_ID}/video-current`;
    const newVideo = `/objects/training-videos/${VIDEO_ID}/video-new`;
    state.record.video_source = oldVideo;
    state.record.thumbnail_source = null;
    state.failDeletePaths.add(oldVideo);
    state.failQueuePaths.add(oldVideo);
    state.queueFailOnlySecond = true; // pre-registration lands; the re-ensure fails
    const replaced = await post(`/training/videos/${VIDEO_ID}/video`, { objectPath: newVideo });
    expect(replaced.status).toBe(502);
    // The swap honestly committed, and the pre-registered handle is still in
    // the ledger — nothing is lost even in this double failure.
    expect(state.record.video_source).toBe(newVideo);
    expect(state.cleanupRows.some((row) => row.object_path === oldVideo)).toBe(true);
  });

  it("a post-upload exception still hands the attachment stray a durable fate", async () => {
    const freshPath = `/objects/training-attachments/${VIDEO_ID}/file-55555555-5555-4555-8555-555555555555`;
    state.uploadedContentType = "application/pdf";
    state.setMetadataThrows = true;
    const failed = await post(`/training/videos/${VIDEO_ID}/attachments`, {
      objectPath: freshPath,
      name: "Worksheet.pdf",
      contentType: "application/pdf",
    });
    expect(failed.status).toBe(500);
    expect(state.deleted).toContain(freshPath);
  });

  it("an auto-thumbnail swap exception still cleans up the captured frame", async () => {
    const oldVideo = `/objects/training-videos/${VIDEO_ID}/video-current`;
    const newVideo = `/objects/training-videos/${VIDEO_ID}/video-new`;
    state.record.video_source = oldVideo;
    state.record.thumbnail_source = null;
    state.replaceThumbnailThrows = true;
    const replaced = await post(`/training/videos/${VIDEO_ID}/video`, { objectPath: newVideo });
    expect(replaced.status).toBe(200);
    // The capture failed non-fatally: no thumbnail reference, and the
    // captured-but-unswapped frame was deleted, not orphaned.
    expect(state.record.thumbnail_source).toBeNull();
    expect(state.deleted.some((p) => p.includes("/thumb-"))).toBe(true);
  });

  it("rejected uploads escalate to 502 when even the ledger fails", async () => {
    state.detectedType = null; // invalid image bytes
    state.failDeletePaths.add(CUSTOM_THUMB_PATH);
    state.failQueuePaths.add(CUSTOM_THUMB_PATH);
    const refused = await post(`/training/videos/${VIDEO_ID}/thumbnail-upload`, {
      objectPath: CUSTOM_THUMB_PATH,
      contentType: "image/png",
      videoSource: VIDEO_PATH,
    });
    expect(refused.status).toBe(502);
    // With the ledger healthy the same rejection is an honest 422 plus a handle.
    state.failQueuePaths.clear();
    const rejected = await post(`/training/videos/${VIDEO_ID}/thumbnail-upload`, {
      objectPath: CUSTOM_THUMB_PATH,
      contentType: "image/png",
      videoSource: VIDEO_PATH,
    });
    expect(rejected.status).toBe(422);
    expect(state.cleanupQueued).toContainEqual({
      path: CUSTOM_THUMB_PATH,
      videoId: state.record.id,
      reason: "stray",
    });
  });

  it("drain never deletes an object its video row still references", async () => {
    const liveVideo = state.record.video_source as string;
    state.cleanupRows = [{ id: "live-row", object_path: liveVideo, video_id: state.record.id }];
    const finalized = await post(`/training/videos/${VIDEO_ID}/thumbnail-upload`, {
      objectPath: CUSTOM_THUMB_PATH,
      contentType: "image/png",
      videoSource: VIDEO_PATH,
    });
    expect(finalized.status).toBe(200);
    // The pre-registration whose swap never committed loses its row — but
    // the live object it points at is never touched.
    expect(state.deleted).not.toContain(liveVideo);
    expect(state.cleanupRows.some((row) => row.id === "live-row")).toBe(false);
  });

  it("clear-all wipes the list in one write and deletes only hosted files", async () => {
    state.record.attachments = [
      {
        id: "att-one",
        name: "Guide.pdf",
        sizeLabel: "421 KB",
        source: ATTACHMENT_PATH,
        contentType: "application/pdf",
        sizeBytes: 431104,
      },
      {
        id: "att-two",
        name: "Sheet.xlsx",
        sizeLabel: "2 KB",
        source: SECOND_ATTACHMENT_PATH,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 2048,
      },
      { id: "att-legacy", name: "Old sheet", sizeLabel: "1.2 MB" },
      42, // outright junk rides the column too — swept out by the same write
    ];
    const clear = await del(`/training/videos/${VIDEO_ID}/attachments`);
    expect(clear.status).toBe(200);
    expect(await clear.json()).toEqual({ removed: 3, deletedObjects: 2 });
    expect(state.record.attachments).toEqual([]);
    expect(state.deleted).toEqual(
      expect.arrayContaining([ATTACHMENT_PATH, SECOND_ATTACHMENT_PATH]),
    );

    // Clearing an already-empty list is a cheap no-op success.
    const again = await del(`/training/videos/${VIDEO_ID}/attachments`);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ removed: 0, deletedObjects: 0 });
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
        headers: { "X-Forwarded-For": ip, Authorization: "Bearer content-token" },
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