/**
 * Hosted training-video media routes.
 *
 * Auth model: every route verifies the caller's EXISTING Supabase session
 * (Authorization: Bearer <access token>) and their profile role — HQ admins
 * upload, replace, remove, and run AI processing; HQ admins and provider
 * staff fetch playback URLs. There is no separate login and no Replit Auth.
 *
 * Storage model: browsers upload straight to App Storage via a presigned PUT
 * (the API never proxies 500 MB bodies), then hit finalize, which probes the
 * file with ffprobe (authoritative duration + "is this actually a video"),
 * writes ONLY the object path to the row, and cleans up the replaced file.
 * Playback and thumbnails are short-lived signed GETs so <video> seeking
 * range-requests storage directly.
 *
 * The AI pass streams over SSE (same event shape conventions as the coach:
 * `data: {...}` lines, comment keepalives, an explicit done event) — one run
 * per video at a time, each step persisted the moment it succeeds so a later
 * failure never rolls back an earlier result.
 */
import { randomUUID } from "crypto";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  TrainingVideoUploadUrlBody,
  TrainingVideoFinalizeBody,
  TrainingVideoThumbnailBody,
  TrainingThumbnailUploadUrlBody,
  TrainingThumbnailUploadBody,
  TrainingVideoProcessBody,
} from "@workspace/api-zod";
import { requireStaff } from "../lib/staff-auth";
import {
  ObjectNotFoundError,
  objectStorage,
  PLAYBACK_URL_TTL_SEC,
  THUMBNAIL_CONTENT_TYPES,
  detectThumbnailContentType,
} from "../lib/objectStorage";
import {
  deleteTranscript,
  getTranscript,
  getVideoRecord,
  isVideoId,
  replaceThumbnailIfCurrent,
  updateHostedMediaIfCurrent,
  updateVideoRecord,
  upsertTranscript,
  type TranscriptSegment,
} from "../training/videos-store";
import {
  captureFrame,
  cleanupWorkDir,
  extractAudioSegments,
  makeWorkDir,
  probeMedia,
  transcribeSegments,
  validateThumbnailImage,
  writeChapters,
  writeDescription,
} from "../training/pipeline";
import { keepaliveIntervalMs, UpstreamTimeoutError } from "../coach/upstream";

const router: IRouter = Router();

export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;

/** Container types the Media card accepts (MP4 / WebM / MOV). */
const ALLOWED_CONTENT_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

const PROCESS_STEPS = ["transcribe", "describe", "chapters", "thumbnail"] as const;
type ProcessStep = (typeof PROCESS_STEPS)[number];

/** One AI run per video at a time — repeats would double-spend credits. */
const activeRuns = new Set<string>();

function plainError(error: unknown): string {
  if (error instanceof UpstreamTimeoutError) {
    return "The AI didn't answer in time — try again.";
  }
  if (error instanceof Error && error.message) {
    return error.message.length > 240 ? `${error.message.slice(0, 240)}…` : error.message;
  }
  return "That step failed — try again.";
}

async function loadVideoOr404(videoId: string, res: Response) {
  if (!isVideoId(videoId)) {
    res.status(404).json({ error: "No such training video." });
    return null;
  }
  const record = await getVideoRecord(videoId);
  if (!record) {
    res.status(404).json({ error: "No such training video." });
    return null;
  }
  return record;
}

/** The object path this video's files must live under. */
function videoPrefix(videoId: string): string {
  return `/objects/training-videos/${videoId}/`;
}

/**
 * Capture one frame of the hosted video and persist it as this video's
 * thumbnail, deleting the thumbnail it replaces. Shared by finalize (the
 * automatic first-frame capture on every upload) and the manual scrubber
 * route. Remote capture can trip on moov-at-end files, so it retries once
 * from a local download.
 */
async function persistThumbnailFrame(
  record: { id: string; video_source: string | null; thumbnail_source: string | null },
  atSeconds: number,
): Promise<{ thumbnailSource: string; thumbnailUrl: string }> {
  if (!record.video_source) {
    throw new Error("No hosted video to capture a frame from.");
  }
  const workDir = await makeWorkDir();
  try {
    const outPath = join(workDir, "thumb.jpg");
    const sourceUrl = await objectStorage.signedDownloadURL(record.video_source, 900);
    try {
      await captureFrame(sourceUrl, atSeconds, outPath);
    } catch {
      const localPath = join(workDir, "video-src");
      const file = await objectStorage.entityFile(record.video_source);
      await file.download({ destination: localPath });
      await captureFrame(localPath, atSeconds, outPath);
    }
    const frame = await readFile(outPath);
    const thumbnailSource = `${videoPrefix(record.id)}thumb-${randomUUID()}.jpg`;
    await objectStorage.saveBuffer(thumbnailSource, frame, "image/jpeg");
    const replaced = await replaceThumbnailIfCurrent(
      record.id,
      record.video_source,
      record.thumbnail_source,
      thumbnailSource,
    );
    if (!replaced) {
      await objectStorage.deleteObject(thumbnailSource);
      throw new Error("The video changed while capturing the frame — try again.");
    }
    if (record.thumbnail_source) {
      await objectStorage.deleteObject(record.thumbnail_source);
    }
    const thumbnailUrl = await objectStorage.signedDownloadURL(thumbnailSource, PLAYBACK_URL_TTL_SEC);
    return { thumbnailSource, thumbnailUrl };
  } finally {
    await cleanupWorkDir(workDir);
  }
}

function isThumbnailObjectPath(videoId: string, objectPath: string): boolean {
  const prefix = videoPrefix(videoId);
  const name = objectPath.slice(prefix.length);
  return objectPath.startsWith(prefix) && name.startsWith("thumb-") && !name.includes("/");
}

// ---------------------------------------------------------------------------
// Presigned upload
// ---------------------------------------------------------------------------

router.post(
  "/training/videos/:videoId/upload-url",
  requireStaff(["hq_admin"]),
  async (req: Request, res: Response) => {
    try {
      const parsed = TrainingVideoUploadUrlBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      const { contentType, sizeBytes } = parsed.data;
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        res.status(415).json({ error: "Upload an MP4, WebM, or MOV video file." });
        return;
      }
      if (sizeBytes > MAX_VIDEO_BYTES) {
        res.status(413).json({ error: "That file is over the 500 MB limit." });
        return;
      }
      const { uploadUrl, objectPath } = await objectStorage.trainingUploadURL(record.id, "video");
      res.json({ uploadUrl, objectPath });
    } catch (error) {
      req.log?.error({ err: error }, "training upload-url failed");
      res.status(500).json({ error: "Could not prepare the upload — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Finalize upload (probe, persist path + duration, clean up replaced file)
// ---------------------------------------------------------------------------

router.post(
  "/training/videos/:videoId/video",
  requireStaff(["hq_admin"]),
  async (req: Request, res: Response) => {
    try {
      const parsed = TrainingVideoFinalizeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      const { objectPath } = parsed.data;
      if (!objectPath.startsWith(videoPrefix(record.id))) {
        res.status(400).json({ error: "That upload doesn't belong to this video." });
        return;
      }

      let file;
      try {
        file = await objectStorage.entityFile(objectPath);
      } catch (error) {
        if (error instanceof ObjectNotFoundError) {
          res.status(404).json({ error: "The uploaded file never arrived — try the upload again." });
          return;
        }
        throw error;
      }

      const [metadata] = await file.getMetadata();
      const sizeBytes = Number(metadata.size ?? 0);
      if (sizeBytes > MAX_VIDEO_BYTES) {
        await objectStorage.deleteObject(objectPath);
        res.status(413).json({ error: "That file is over the 500 MB limit." });
        return;
      }

      // ffprobe over a short signed URL: authoritative duration, and proof
      // the bytes are actually a playable video before anything persists.
      const probeUrl = await objectStorage.signedDownloadURL(objectPath, 900);
      let probe;
      try {
        probe = await probeMedia(probeUrl);
      } catch {
        await objectStorage.deleteObject(objectPath);
        res.status(422).json({ error: "That file doesn't look like a playable video." });
        return;
      }
      if (!probe.hasVideo || probe.durationSeconds <= 0) {
        await objectStorage.deleteObject(objectPath);
        res.status(422).json({ error: "That file doesn't look like a playable video." });
        return;
      }
      if (probe.durationSeconds > 86_400) {
        await objectStorage.deleteObject(objectPath);
        res.status(422).json({ error: "Videos longer than 24 hours aren't supported." });
        return;
      }

      const durationSeconds = Math.min(86_400, Math.max(1, Math.round(probe.durationSeconds)));
      // A replaced file's transcript and thumbnail describe the OLD video;
      // clear them so nothing stale pretends to describe the new upload.
      let displaced:
        | { videoSource: string | null; thumbnailSource: string | null }
        | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await getVideoRecord(record.id);
        if (!current || current.video_source !== record.video_source) break;
        const updated = await updateHostedMediaIfCurrent(
          record.id,
          current.video_source,
          current.thumbnail_source,
          {
            video_source: objectPath,
            duration_seconds: durationSeconds,
            thumbnail_source: null,
          },
        );
        if (updated) {
          displaced = {
            videoSource: current.video_source,
            thumbnailSource: current.thumbnail_source,
          };
          break;
        }
      }
      if (!displaced) {
        await objectStorage.deleteObject(objectPath);
        res.status(409).json({ error: "The video changed while finalizing — upload the replacement again." });
        return;
      }
      await deleteTranscript(record.id);
      if (displaced.videoSource && displaced.videoSource !== objectPath) {
        await objectStorage.deleteObject(displaced.videoSource);
      }
      if (displaced.thumbnailSource) {
        await objectStorage.deleteObject(displaced.thumbnailSource);
      }

      // Automatic thumbnail: capture the first frame right away so the
      // lesson has real cover art the moment the upload lands — even if the
      // AI pass never runs. A capture failure is non-fatal: the response
      // says null, and the AI pass or the scrubber dialog can set one later.
      let thumbnailSource: string | null = null;
      try {
        const captured = await persistThumbnailFrame(
          { id: record.id, video_source: objectPath, thumbnail_source: null },
          0,
        );
        thumbnailSource = captured.thumbnailSource;
      } catch (error) {
        req.log?.error({ err: error, videoId: record.id }, "training auto-thumbnail failed");
      }

      res.json({ videoSource: objectPath, durationSeconds, thumbnailSource });
    } catch (error) {
      req.log?.error({ err: error }, "training finalize failed");
      res.status(500).json({ error: "Could not attach the uploaded video — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Remove hosted file (Danger zone) — the lesson row itself stays
// ---------------------------------------------------------------------------

router.delete(
  "/training/videos/:videoId/video",
  requireStaff(["hq_admin"]),
  async (req: Request, res: Response) => {
    try {
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      if (!record.video_source) {
        res.status(409).json({ error: "There is no hosted file to remove." });
        return;
      }
      let displaced:
        | { videoSource: string; thumbnailSource: string | null }
        | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await getVideoRecord(record.id);
        if (!current || current.video_source !== record.video_source) break;
        const updated = await updateHostedMediaIfCurrent(
          record.id,
          current.video_source,
          current.thumbnail_source,
          { video_source: null, thumbnail_source: null },
        );
        if (updated) {
          displaced = {
            videoSource: current.video_source,
            thumbnailSource: current.thumbnail_source,
          };
          break;
        }
      }
      if (!displaced) {
        res.status(409).json({ error: "The video changed while removing it — refresh and try again." });
        return;
      }
      await deleteTranscript(record.id);
      await objectStorage.deleteObject(displaced.videoSource);
      if (displaced.thumbnailSource) {
        await objectStorage.deleteObject(displaced.thumbnailSource);
      }
      res.json({ removed: true });
    } catch (error) {
      req.log?.error({ err: error }, "training remove file failed");
      res.status(500).json({ error: "Could not remove the video file — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Custom thumbnail upload (presigned PUT, then byte-validated finalize)
// ---------------------------------------------------------------------------

router.post(
  "/training/videos/:videoId/thumbnail-upload-url",
  requireStaff(["hq_admin"]),
  async (req: Request, res: Response) => {
    try {
      const parsed = TrainingThumbnailUploadUrlBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      if (!record.video_source) {
        res.status(409).json({ error: "Upload a video before adding a custom thumbnail." });
        return;
      }
      const { contentType, sizeBytes } = parsed.data;
      if (!THUMBNAIL_CONTENT_TYPES.has(contentType)) {
        res.status(415).json({ error: "Upload a JPG, PNG, or WebP image." });
        return;
      }
      if (sizeBytes > MAX_THUMBNAIL_BYTES) {
        res.status(413).json({ error: "That thumbnail is over the 10 MB limit." });
        return;
      }
      const { uploadUrl, objectPath } = await objectStorage.trainingUploadURL(record.id, "thumb");
      res.json({ uploadUrl, objectPath, videoSource: record.video_source });
    } catch (error) {
      req.log?.error({ err: error }, "training thumbnail upload-url failed");
      res.status(500).json({ error: "Could not prepare the thumbnail upload — try again." });
    }
  },
);

router.post(
  "/training/videos/:videoId/thumbnail-upload",
  requireStaff(["hq_admin"]),
  async (req: Request, res: Response) => {
    try {
      const parsed = TrainingThumbnailUploadBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      if (!isThumbnailObjectPath(record.id, parsed.data.objectPath)) {
        res.status(400).json({ error: "That upload doesn't belong to this video's thumbnail." });
        return;
      }
      if (!record.video_source) {
        await objectStorage.deleteObject(parsed.data.objectPath);
        res.status(409).json({ error: "Upload a video before adding a custom thumbnail." });
        return;
      }
      if (parsed.data.videoSource !== record.video_source) {
        await objectStorage.deleteObject(parsed.data.objectPath);
        res.status(409).json({ error: "The video changed while you were uploading — choose the thumbnail again." });
        return;
      }

      let file;
      try {
        file = await objectStorage.entityFile(parsed.data.objectPath);
      } catch (error) {
        if (error instanceof ObjectNotFoundError) {
          res.status(404).json({ error: "The uploaded thumbnail never arrived — try the upload again." });
          return;
        }
        throw error;
      }
      const [metadata] = await file.getMetadata();
      const sizeBytes = Number(metadata.size ?? 0);
      if (sizeBytes <= 0 || sizeBytes > MAX_THUMBNAIL_BYTES) {
        await objectStorage.deleteObject(parsed.data.objectPath);
        res.status(413).json({ error: "That thumbnail is empty or over the 10 MB limit." });
        return;
      }
      const [content] = await file.download();
      const detectedType = detectThumbnailContentType(content);
      if (
        !detectedType ||
        !THUMBNAIL_CONTENT_TYPES.has(parsed.data.contentType) ||
        detectedType !== parsed.data.contentType
      ) {
        await objectStorage.deleteObject(parsed.data.objectPath);
        res.status(422).json({ error: "That file doesn't look like a valid JPG, PNG, or WebP image." });
        return;
      }
      if (metadata.contentType && metadata.contentType !== detectedType) {
        await objectStorage.deleteObject(parsed.data.objectPath);
        res.status(422).json({ error: "The uploaded image type didn't match its contents." });
        return;
      }

      const imageDir = await makeWorkDir();
      try {
        const extension = detectedType === "image/jpeg" ? "jpg" : detectedType.slice("image/".length);
        const imagePath = join(imageDir, `uploaded-thumbnail.${extension}`);
        await writeFile(imagePath, content);
        await validateThumbnailImage(imagePath);
      } catch {
        await objectStorage.deleteObject(parsed.data.objectPath);
        res.status(422).json({ error: "That image is damaged or couldn't be decoded." });
        return;
      } finally {
        await cleanupWorkDir(imageDir);
      }

      const replaced = await replaceThumbnailIfCurrent(
        record.id,
        parsed.data.videoSource,
        record.thumbnail_source,
        parsed.data.objectPath,
      );
      if (!replaced) {
        await objectStorage.deleteObject(parsed.data.objectPath);
        res.status(409).json({ error: "The video changed while you were uploading — choose the thumbnail again." });
        return;
      }
      if (record.thumbnail_source && record.thumbnail_source !== parsed.data.objectPath) {
        await objectStorage.deleteObject(record.thumbnail_source);
      }
      const thumbnailUrl = await objectStorage.signedDownloadURL(
        parsed.data.objectPath,
        PLAYBACK_URL_TTL_SEC,
      );
      res.json({ thumbnailSource: parsed.data.objectPath, thumbnailUrl });
    } catch (error) {
      req.log?.error({ err: error }, "training custom thumbnail finalize failed");
      res.status(500).json({ error: "Could not attach that thumbnail — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Playback (staff + HQ): short-lived signed URLs, range requests hit storage
// ---------------------------------------------------------------------------

router.get(
  "/training/videos/:videoId/media",
  requireStaff(["hq_admin", "provider_staff"]),
  async (req: Request, res: Response) => {
    try {
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      if (!record.video_source) {
        res.status(404).json({ error: "No video file is hosted for this lesson." });
        return;
      }
      const videoUrl = await objectStorage.signedDownloadURL(record.video_source, PLAYBACK_URL_TTL_SEC);
      const thumbnailUrl = record.thumbnail_source
        ? await objectStorage.signedDownloadURL(record.thumbnail_source, PLAYBACK_URL_TTL_SEC)
        : null;
      res.json({
        videoUrl,
        thumbnailUrl,
        expiresAtMs: Date.now() + PLAYBACK_URL_TTL_SEC * 1000,
      });
    } catch (error) {
      req.log?.error({ err: error }, "training media urls failed");
      res.status(500).json({ error: "Could not load the video — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Transcript (editor viewer) — HQ admins; provider staff have no surface yet
// ---------------------------------------------------------------------------

router.get(
  "/training/videos/:videoId/transcript",
  requireStaff(["hq_admin"]),
  async (req: Request, res: Response) => {
    try {
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      const segments = await getTranscript(record.id);
      if (!segments) {
        res.status(404).json({ error: "No transcript yet — run AI processing first." });
        return;
      }
      res.json({ segments });
    } catch (error) {
      req.log?.error({ err: error }, "training transcript fetch failed");
      res.status(500).json({ error: "Could not load the transcript — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Manual thumbnail from a chosen frame (the dialog's scrubber)
// ---------------------------------------------------------------------------

router.post(
  "/training/videos/:videoId/thumbnail",
  requireStaff(["hq_admin"]),
  async (req: Request, res: Response) => {
    try {
      const parsed = TrainingVideoThumbnailBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      if (!record.video_source) {
        res.status(409).json({ error: "Upload a video before capturing a thumbnail." });
        return;
      }
      const atSeconds = Math.min(
        Math.max(0, parsed.data.atSeconds),
        Math.max(0, record.duration_seconds - 0.1),
      );
      const { thumbnailSource, thumbnailUrl } = await persistThumbnailFrame(record, atSeconds);
      res.json({ thumbnailSource, thumbnailUrl });
    } catch (error) {
      req.log?.error({ err: error }, "training thumbnail capture failed");
      res.status(500).json({ error: "Could not capture that frame — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// AI processing pipeline (SSE)
// ---------------------------------------------------------------------------

router.post(
  "/training/videos/:videoId/process",
  requireStaff(["hq_admin"]),
  async (req: Request, res: Response) => {
    const parsed = TrainingVideoProcessBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const record = await loadVideoOr404(String(req.params.videoId), res);
    if (!record) return;
    if (!record.video_source) {
      res.status(409).json({ error: "Upload a video before running AI processing." });
      return;
    }
    if (activeRuns.has(record.id)) {
      res.status(409).json({ error: "AI processing is already running for this video." });
      return;
    }

    const requested = parsed.data.steps && parsed.data.steps.length > 0
      ? new Set(parsed.data.steps)
      : new Set<ProcessStep>(PROCESS_STEPS);
    const steps = PROCESS_STEPS.filter((step) => requested.has(step));

    activeRuns.add(record.id);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (payload: unknown): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const keepalive = setInterval(() => {
      res.write(`: keepalive\n\n`);
    }, keepaliveIntervalMs());

    const clientGone = new AbortController();
    req.on("close", () => clientGone.abort());

    let workDir: string | null = null;
    let localVideo: string | null = null;
    const ensureLocalVideo = async (): Promise<string> => {
      if (localVideo) return localVideo;
      workDir ??= await makeWorkDir();
      const destination = join(workDir, "video-src");
      const file = await objectStorage.entityFile(record.video_source as string);
      await file.download({ destination });
      localVideo = destination;
      return destination;
    };

    let transcript: TranscriptSegment[] | null = null;
    let failedStep: ProcessStep | null = null;
    const blockedSteps: ProcessStep[] = [];

    try {
      for (const step of steps) {
        if (clientGone.signal.aborted) break;

        // Description and chapters are written FROM the transcript; if the
        // transcription step just failed there is nothing honest to write.
        if (
          (step === "describe" || step === "chapters") &&
          failedStep === "transcribe"
        ) {
          blockedSteps.push(step);
          send({ step, status: "skipped", error: "Waiting on a transcript." });
          continue;
        }

        send({ step, status: "running" });
        try {
          if (step === "transcribe") {
            const videoPath = await ensureLocalVideo();
            const probe = await probeMedia(videoPath);
            if (!probe.hasAudio) {
              throw new Error("This video has no audio track to transcribe.");
            }
            const audioDir = await makeWorkDir();
            try {
              const files = await extractAudioSegments(videoPath, audioDir);
              send({ step, status: "running", done: 0, total: files.length });
              const segments = await transcribeSegments(files, record.duration_seconds, {
                signal: clientGone.signal,
                onProgress: (done, total) => send({ step, status: "running", done, total }),
              });
              await upsertTranscript(record.id, segments);
              transcript = segments;
              send({ step, status: "done", transcript: { segments } });
            } finally {
              await cleanupWorkDir(audioDir);
            }
          } else if (step === "describe") {
            transcript ??= await getTranscript(record.id);
            if (!transcript) {
              throw new Error("No transcript yet — run transcription first.");
            }
            const description = await writeDescription(record.title, transcript, clientGone.signal);
            await updateVideoRecord(record.id, { description });
            send({ step, status: "done", description });
          } else if (step === "chapters") {
            transcript ??= await getTranscript(record.id);
            if (!transcript) {
              throw new Error("No transcript yet — run transcription first.");
            }
            const drafts = await writeChapters(
              record.title,
              transcript,
              record.duration_seconds,
              clientGone.signal,
            );
            const chapters = drafts.map((draft) => ({
              id: randomUUID(),
              at: draft.at,
              title: draft.title,
            }));
            await updateVideoRecord(record.id, { chapters });
            send({ step, status: "done", chapters });
          } else if (step === "thumbnail") {
            const { thumbnailSource, thumbnailUrl } = await persistThumbnailFrame(record, 0);
            send({ step, status: "done", thumbnailSource, thumbnailUrl });
          }
        } catch (error) {
          req.log?.error({ err: error, step, videoId: record.id }, "training AI step failed");
          failedStep ??= step;
          send({ step, status: "failed", error: plainError(error) });
        }
      }

      send({
        done: true,
        ok: failedStep === null && blockedSteps.length === 0,
        failedStep: failedStep ?? undefined,
        blockedSteps: blockedSteps.length > 0 ? blockedSteps : undefined,
      });
    } catch (error) {
      // Unexpected plumbing failure (storage download, DB write): still end
      // the stream explicitly — a dropped stream must never read as success.
      req.log?.error({ err: error, videoId: record.id }, "training AI run crashed");
      send({ done: true, ok: false, error: plainError(error) });
    } finally {
      clearInterval(keepalive);
      activeRuns.delete(record.id);
      if (workDir) await cleanupWorkDir(workDir);
      res.end();
    }
  },
);

export default router;
