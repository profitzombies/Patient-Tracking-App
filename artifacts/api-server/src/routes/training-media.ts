/**
 * Hosted training-video media routes.
 *
 * Access model (demo posture): reaching the admin portal is enough — these
 * routes have NO sign-in gate, the same opening as the AI Support knowledge
 * library. The staff identity was only ever a gate here: there is one
 * shared training catalog, read and written with the service role, with no
 * office scoping or attribution. A signed-in caller's bearer, when
 * attached, is simply ignored. In its place every WRITE (upload, finalize,
 * replace, remove, thumbnails, AI processing) rides a modest per-IP
 * limiter, while reads (playback URLs, transcript) stay open so lesson
 * pages can stream; re-tightening later is one middleware away. Type and
 * size rules are enforced exactly as before.
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
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import {
  TrainingVideoUploadUrlBody,
  TrainingVideoFinalizeBody,
  TrainingVideoThumbnailBody,
  TrainingThumbnailUploadUrlBody,
  TrainingThumbnailUploadBody,
  TrainingVideoProcessBody,
  TrainingAttachmentUploadUrlBody,
  TrainingAttachmentFinalizeBody,
} from "@workspace/api-zod";
import { acquireTrainingWriteSlot } from "../training/limits";
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
  updateAttachmentsIfCurrent,
  updateHostedMediaIfCurrent,
  updateVideoRecord,
  upsertTranscript,
  type TranscriptSegment,
  deleteMediaCleanup,
  dequeueMediaCleanup,
  listMediaCleanup,
  queueMediaCleanup,
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
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_VIDEO = 12;

/** Container types the Media card accepts (MP4 / WebM / MOV). */
const ALLOWED_CONTENT_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

/** Types the File attachments card accepts — documents, sheets, decks, text, images. */
export const ATTACHMENT_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** Download links are minted per click, so a short leash costs nothing. */
const ATTACHMENT_DOWNLOAD_TTL_SEC = 300;

const ATTACHMENT_TYPE_ERROR = "Upload a PDF, Word, Excel, PowerPoint, text, CSV, or image file.";

const PROCESS_STEPS = ["transcribe", "describe", "chapters", "thumbnail"] as const;
type ProcessStep = (typeof PROCESS_STEPS)[number];

/** One AI run per video at a time — repeats would double-spend credits. */
const activeRuns = new Set<string>();

/**
 * Per-IP limit on every media WRITE — the stand-in for the retired sign-in
 * gate. Limit first, like the chat route: denials are cheap JSON answers
 * before any storage or database work.
 */
function limitWrites(req: Request, res: Response, next: NextFunction): void {
  const slot = acquireTrainingWriteSlot(req.ip ?? "unknown");
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  // "close" fires whether the response finished or the connection died
  // mid-request, and release is idempotent — concurrency can never leak.
  // The SSE process route holds its slot for the whole run, which is the
  // bound on concurrent AI passes.
  res.on("close", slot.release);
  next();
}

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
  log?: RouteLog,
): Promise<{ thumbnailSource: string; thumbnailUrl: string }> {
  if (!record.video_source) {
    throw new Error("No hosted video to capture a frame from.");
  }
  const workDir = await makeWorkDir();
  let candidate: string | null = null;
  let committed = false;
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
    candidate = thumbnailSource;
    // Pre-register the displaced thumbnail BEFORE the swap: a ledger outage
    // aborts here with nothing mutated, and once the swap commits the old
    // object already carries its durable retry handle.
    const displaced = record.thumbnail_source ? [record.thumbnail_source] : [];
    await preRegisterDisplaced(displaced, record.id);
    const replaced = await replaceThumbnailIfCurrent(
      record.id,
      record.video_source,
      record.thumbnail_source,
      thumbnailSource,
    );
    if (!replaced) {
      await unregisterDisplaced(displaced);
      throw new Error("The video changed while capturing the frame — try again.");
    }
    committed = true;
    if (!(await settleDisplaced(displaced, record.id, log))) {
      throw new Error("Thumbnail captured, but the old thumbnail's cleanup could not be recorded — try again.");
    }
    const thumbnailUrl = await objectStorage.signedDownloadURL(thumbnailSource, PLAYBACK_URL_TTL_SEC);
    return { thumbnailSource, thumbnailUrl };
  } catch (error) {
    // Until the swap commits we own the captured frame — give it a durable
    // fate on every thrown path. (After the commit the frame is referenced,
    // so it must never be deleted here.)
    if (candidate && !committed) {
      await deleteOrQueue(candidate, record.id, "stray", log);
    }
    throw error;
  } finally {
    await cleanupWorkDir(workDir);
  }
}

function isThumbnailObjectPath(videoId: string, objectPath: string): boolean {
  const prefix = videoPrefix(videoId);
  const name = objectPath.slice(prefix.length);
  return objectPath.startsWith(prefix) && name.startsWith("thumb-") && !name.includes("/");
}

type RouteLog = { error: (obj: unknown, msg?: string) => void };

/**
 * Strictly delete a storage object that no row references any more — one
 * displaced by a replace, or a stray upload that failed validation. Missing
 * counts as already deleted. If storage refuses, the caller's own write has
 * already landed (the active reference must stay valid), so instead of
 * failing the request the path is queued in the durable cleanup ledger as a
 * retry handle; later training-media writes drain it. Never throws.
 */
async function deleteOrQueue(
  objectPath: string,
  videoId: string | null,
  reason: "displaced" | "stray",
  log?: RouteLog,
): Promise<boolean> {
  try {
    await objectStorage.deleteObjectStrict(objectPath);
    return true;
  } catch (error) {
    log?.error(
      { err: error, objectPath, reason },
      "training media: storage refused a delete — queuing a retry handle",
    );
    try {
      await queueMediaCleanup(objectPath, videoId, reason);
      return true;
    } catch (queueError) {
      log?.error(
        { err: queueError, objectPath },
        "training media: cleanup queue write failed — no durable retry handle",
      );
      return false;
    }
  }
}

/**
 * Reject a request whose uploaded object is now a stray. The object must get
 * a durable fate — deleted or queued — before the rejection goes out; when
 * storage AND the ledger both fail, the response escalates to 502 so no
 * plain 4xx ever hides an untracked orphan.
 */
async function rejectStray(
  res: Response,
  status: number,
  message: string,
  objectPath: string,
  videoId: string | null,
  log?: RouteLog,
): Promise<void> {
  if (!(await deleteOrQueue(objectPath, videoId, "stray", log))) {
    res.status(502).json({ error: "Could not clean up the rejected upload — try again." });
    return;
  }
  res.status(status).json({ error: message });
}

/**
 * Pre-register soon-to-be-displaced objects in the cleanup ledger BEFORE the
 * reference swap commits. If the ledger is unreachable this THROWS and the
 * caller aborts with nothing mutated; once the swap lands, the old objects
 * already carry durable retry handles, so even a total storage outage after
 * the commit cannot lose track of them.
 */
async function preRegisterDisplaced(paths: string[], videoId: string): Promise<void> {
  for (const path of paths) {
    await queueMediaCleanup(path, videoId, "displaced");
  }
}

/**
 * Drop stale pre-registrations after a lost swap. Best-effort: a leftover
 * row is harmless because the reference-aware drain skips live paths and
 * removes the row itself.
 */
async function unregisterDisplaced(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      await dequeueMediaCleanup(path);
    } catch {
      // The drain mops up rows whose objects are still referenced.
    }
  }
}

/**
 * After a committed swap: delete the pre-registered displaced objects and
 * settle their ledger rows. A refused delete keeps (re-ensures) the row as
 * the retry handle. Returns false only when an object is undeletable AND its
 * ledger row could not be re-ensured — callers must then fail loudly rather
 * than report success.
 */
async function settleDisplaced(paths: string[], videoId: string, log?: RouteLog): Promise<boolean> {
  let allDurable = true;
  for (const path of paths) {
    try {
      await objectStorage.deleteObjectStrict(path);
      try {
        await dequeueMediaCleanup(path);
      } catch {
        // The row now points at a deleted object — the drain removes it as a
        // no-op later.
      }
    } catch (error) {
      log?.error(
        { err: error, objectPath: path },
        "training media: storage refused a displaced delete — keeping its ledger row",
      );
      try {
        // Re-ensure the handle: a concurrent drain may have raced the
        // pre-registration away between our enqueue and the swap commit.
        await queueMediaCleanup(path, videoId, "displaced");
      } catch (queueError) {
        log?.error(
          { err: queueError, objectPath: path },
          "training media: could not re-ensure the cleanup handle",
        );
        allDurable = false;
      }
    }
  }
  return allDurable;
}

function videoReferencesPath(
  record: { video_source: string | null; thumbnail_source: string | null; attachments: unknown },
  objectPath: string,
): boolean {
  if (record.video_source === objectPath || record.thumbnail_source === objectPath) return true;
  return attachmentEntries(record.attachments).some((entry) => entry.source === objectPath);
}

/**
 * Opportunistic drain of the cleanup ledger, run at the top of the finalize
 * routes. Bounded and never throws. Reference-aware: a row whose video still
 * references the path is a stale pre-registration (its swap never committed)
 * — the row is dropped and the LIVE object is never touched. Everything else
 * is strictly deleted (missing counts as gone) before its row leaves.
 */
async function drainMediaCleanup(log?: RouteLog): Promise<void> {
  try {
    const rows = await listMediaCleanup(10);
    for (const row of rows) {
      try {
        if (row.video_id) {
          const owner = await getVideoRecord(row.video_id);
          if (owner && videoReferencesPath(owner, row.object_path)) {
            await deleteMediaCleanup(row.id);
            continue;
          }
        }
        await objectStorage.deleteObjectStrict(row.object_path);
        await deleteMediaCleanup(row.id);
      } catch {
        // Still refused (or the owner lookup failed) — the row stays.
      }
    }
  } catch {
    // Ledger unavailable — drain again on a later write.
  }
}

/**
 * The object path this video's attachment FILES must live under — a folder
 * of its own (`training-attachments/`), deliberately separate from the
 * hosted-video prefix so the two lifecycles never mix.
 */
function attachmentPrefix(videoId: string): string {
  return `/objects/training-attachments/${videoId}/`;
}

function isAttachmentObjectPath(videoId: string, objectPath: string): boolean {
  const prefix = attachmentPrefix(videoId);
  const name = objectPath.slice(prefix.length);
  return objectPath.startsWith(prefix) && name.startsWith("file-") && !name.includes("/");
}

/** Human size for a stored byte count — the label every surface shows. */
export function formatSizeLabel(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * One attachment entry as this route family stores it. The column may also
 * hold legacy name-only entries (no source) and outright junk; routes only
 * reason about id-keyed objects and let anything else ride along untouched.
 */
interface StoredAttachment {
  id: string;
  name?: unknown;
  sizeLabel?: unknown;
  source?: unknown;
  contentType?: unknown;
  sizeBytes?: unknown;
}

/** Raw jsonb → the entries we can reason about (id-keyed objects). */
function attachmentEntries(value: unknown): StoredAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is StoredAttachment =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string",
  );
}

function attachmentSource(entry: StoredAttachment): string | null {
  return typeof entry.source === "string" && entry.source ? entry.source : null;
}

/**
 * Content-Disposition stamped onto the stored object at finalize, so every
 * later signed GET downloads under the real file name (the sidecar signer
 * takes no per-request response overrides).
 */
function attachmentDisposition(name: string): string {
  const fallback =
    name
      .replace(/[^\x20-\x7e]+/g, "_")
      .replace(/["\\]/g, "_")
      .trim() || "attachment";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------------------
// Presigned upload
// ---------------------------------------------------------------------------

router.post(
  "/training/videos/:videoId/upload-url",
  limitWrites,
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
  limitWrites,
  async (req: Request, res: Response) => {
    let strayCandidate: string | null = null;
    let strayVideoId: string | null = null;
    try {
      const parsed = TrainingVideoFinalizeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      await drainMediaCleanup(req.log);
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

      // From here the uploaded object exists and we own it until the
      // swap commits; the outer catch hands it a durable fate on any
      // thrown path.
      strayCandidate = objectPath;
      strayVideoId = record.id;

      const [metadata] = await file.getMetadata();
      const sizeBytes = Number(metadata.size ?? 0);
      if (sizeBytes > MAX_VIDEO_BYTES) {
        await rejectStray(res, 413, "That file is over the 500 MB limit.", objectPath, record.id, req.log);
        return;
      }

      // ffprobe over a short signed URL: authoritative duration, and proof
      // the bytes are actually a playable video before anything persists.
      const probeUrl = await objectStorage.signedDownloadURL(objectPath, 900);
      let probe;
      try {
        probe = await probeMedia(probeUrl);
      } catch {
        await rejectStray(res, 422, "That file doesn't look like a playable video.", objectPath, record.id, req.log);
        return;
      }
      if (!probe.hasVideo || probe.durationSeconds <= 0) {
        await rejectStray(res, 422, "That file doesn't look like a playable video.", objectPath, record.id, req.log);
        return;
      }
      if (probe.durationSeconds > 86_400) {
        await rejectStray(res, 422, "Videos longer than 24 hours aren't supported.", objectPath, record.id, req.log);
        return;
      }

      const durationSeconds = Math.min(86_400, Math.max(1, Math.round(probe.durationSeconds)));
      // A replaced file's transcript and thumbnail describe the OLD video;
      // clear them so nothing stale pretends to describe the new upload.
      let displaced: string[] | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await getVideoRecord(record.id);
        if (!current || current.video_source !== record.video_source) break;
        const candidates = [
          ...(current.video_source && current.video_source !== objectPath
            ? [current.video_source]
            : []),
          ...(current.thumbnail_source ? [current.thumbnail_source] : []),
        ];
        // Pre-register the displaced objects BEFORE the swap: a ledger
        // outage aborts (throws) with nothing mutated, and once the swap
        // lands the old objects already carry durable retry handles.
        await preRegisterDisplaced(candidates, record.id);
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
          displaced = candidates;
          break;
        }
        await unregisterDisplaced(candidates);
      }
      if (displaced === null) {
        await rejectStray(
          res,
          409,
          "The video changed while finalizing — upload the replacement again.",
          objectPath,
          record.id,
          req.log,
        );
        return;
      }
      strayCandidate = null; // the row now references the new file
      await deleteTranscript(record.id);
      if (!(await settleDisplaced(displaced, record.id, req.log))) {
        res.status(502).json({
          error: "The new file is in place, but the old file's cleanup could not be recorded — try again shortly.",
        });
        return;
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
          req.log,
        );
        thumbnailSource = captured.thumbnailSource;
      } catch (error) {
        req.log?.error({ err: error, videoId: record.id }, "training auto-thumbnail failed");
      }

      res.json({ videoSource: objectPath, durationSeconds, thumbnailSource });
    } catch (error) {
      // We own the uploaded object until the swap commits: any thrown path
      // hands it a durable fate before the error goes out.
      if (strayCandidate) {
        await deleteOrQueue(strayCandidate, strayVideoId, "stray", req.log);
      }
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
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      if (!record.video_source) {
        res.status(409).json({ error: "There is no hosted file to remove." });
        return;
      }
      // Storage objects go FIRST — strictly, with a missing object counting
      // as already deleted so retries converge. A refusal aborts here with
      // the row's references and transcript intact as the retry handle;
      // clearing references before the deletes land would strand objects
      // nothing points at.
      try {
        await objectStorage.deleteObjectStrict(record.video_source);
        if (record.thumbnail_source) {
          await objectStorage.deleteObjectStrict(record.thumbnail_source);
        }
      } catch (error) {
        req.log?.error({ err: error }, "training remove file: storage refused the delete");
        res.status(502).json({ error: "Storage refused to delete the hosted file — nothing was changed. Try again." });
        return;
      }
      let cleared = false;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await getVideoRecord(record.id);
        if (
          !current ||
          current.video_source !== record.video_source ||
          current.thumbnail_source !== record.thumbnail_source
        ) {
          // The lesson's media changed under us. The objects we deleted are
          // gone (retries treat missing as success); leave the newer
          // references alone and let the caller refresh.
          break;
        }
        const updated = await updateHostedMediaIfCurrent(
          record.id,
          current.video_source,
          current.thumbnail_source,
          { video_source: null, thumbnail_source: null },
        );
        if (updated) {
          cleared = true;
          break;
        }
      }
      if (!cleared) {
        res.status(409).json({ error: "The video changed while removing it — refresh and try again." });
        return;
      }
      await deleteTranscript(record.id);
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
  limitWrites,
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
  limitWrites,
  async (req: Request, res: Response) => {
    let strayCandidate: string | null = null;
    let strayVideoId: string | null = null;
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
      await drainMediaCleanup(req.log);
      if (!record.video_source) {
        await rejectStray(res, 409, "Upload a video before adding a custom thumbnail.", parsed.data.objectPath, record.id, req.log);
        return;
      }
      if (parsed.data.videoSource !== record.video_source) {
        await rejectStray(res, 409, "The video changed while you were uploading — choose the thumbnail again.", parsed.data.objectPath, record.id, req.log);
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
      // From here the uploaded object exists and we own it until the
      // swap commits; the outer catch hands it a durable fate on any
      // thrown path.
      strayCandidate = parsed.data.objectPath;
      strayVideoId = record.id;

      const [metadata] = await file.getMetadata();
      const sizeBytes = Number(metadata.size ?? 0);
      if (sizeBytes <= 0 || sizeBytes > MAX_THUMBNAIL_BYTES) {
        await rejectStray(res, 413, "That thumbnail is empty or over the 10 MB limit.", parsed.data.objectPath, record.id, req.log);
        return;
      }
      const [content] = await file.download();
      const detectedType = detectThumbnailContentType(content);
      if (
        !detectedType ||
        !THUMBNAIL_CONTENT_TYPES.has(parsed.data.contentType) ||
        detectedType !== parsed.data.contentType
      ) {
        await rejectStray(res, 422, "That file doesn't look like a valid JPG, PNG, or WebP image.", parsed.data.objectPath, record.id, req.log);
        return;
      }
      if (metadata.contentType && metadata.contentType !== detectedType) {
        await rejectStray(res, 422, "The uploaded image type didn't match its contents.", parsed.data.objectPath, record.id, req.log);
        return;
      }

      const imageDir = await makeWorkDir();
      try {
        const extension = detectedType === "image/jpeg" ? "jpg" : detectedType.slice("image/".length);
        const imagePath = join(imageDir, `uploaded-thumbnail.${extension}`);
        await writeFile(imagePath, content);
        await validateThumbnailImage(imagePath);
      } catch {
        await rejectStray(res, 422, "That image is damaged or couldn't be decoded.", parsed.data.objectPath, record.id, req.log);
        return;
      } finally {
        await cleanupWorkDir(imageDir);
      }

      // Pre-register the displaced thumbnail BEFORE the swap — a ledger
      // outage aborts (throws) with nothing mutated; once the swap commits
      // the old object already carries its durable retry handle.
      const displacedThumb =
        record.thumbnail_source && record.thumbnail_source !== parsed.data.objectPath
          ? [record.thumbnail_source]
          : [];
      await preRegisterDisplaced(displacedThumb, record.id);
      const replaced = await replaceThumbnailIfCurrent(
        record.id,
        parsed.data.videoSource,
        record.thumbnail_source,
        parsed.data.objectPath,
      );
      if (!replaced) {
        await unregisterDisplaced(displacedThumb);
        await rejectStray(
          res,
          409,
          "The video changed while you were uploading — choose the thumbnail again.",
          parsed.data.objectPath,
          record.id,
          req.log,
        );
        return;
      }
      strayCandidate = null; // the row now references the new thumbnail
      if (!(await settleDisplaced(displacedThumb, record.id, req.log))) {
        res.status(502).json({
          error: "The new thumbnail is in place, but the old one's cleanup could not be recorded — try again shortly.",
        });
        return;
      }
      const thumbnailUrl = await objectStorage.signedDownloadURL(
        parsed.data.objectPath,
        PLAYBACK_URL_TTL_SEC,
      );
      res.json({ thumbnailSource: parsed.data.objectPath, thumbnailUrl });
    } catch (error) {
      if (strayCandidate) {
        await deleteOrQueue(strayCandidate, strayVideoId, "stray", req.log);
      }
      req.log?.error({ err: error }, "training custom thumbnail finalize failed");
      res.status(500).json({ error: "Could not attach that thumbnail — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Lesson attachments (worksheets, PDFs, docs, images) — the same presigned-PUT
// + verified-finalize shape as the video, in a storage folder of their own.
// Entries live in the row's attachments jsonb; every write is a CAS on the
// whole list so concurrent appends/removals re-read instead of clobbering.
// ---------------------------------------------------------------------------

router.post(
  "/training/videos/:videoId/attachment-upload-url",
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const parsed = TrainingAttachmentUploadUrlBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      const { contentType, sizeBytes } = parsed.data;
      if (!ATTACHMENT_CONTENT_TYPES.has(contentType)) {
        res.status(415).json({ error: ATTACHMENT_TYPE_ERROR });
        return;
      }
      if (sizeBytes > MAX_ATTACHMENT_BYTES) {
        res.status(413).json({ error: "That file is over the 25 MB limit." });
        return;
      }
      if (attachmentEntries(record.attachments).length >= MAX_ATTACHMENTS_PER_VIDEO) {
        res.status(409).json({
          error: `This lesson already has ${MAX_ATTACHMENTS_PER_VIDEO} attachments — remove one first.`,
        });
        return;
      }
      const { uploadUrl, objectPath } = await objectStorage.trainingAttachmentUploadURL(record.id);
      res.json({ uploadUrl, objectPath });
    } catch (error) {
      req.log?.error({ err: error }, "training attachment upload-url failed");
      res.status(500).json({ error: "Could not prepare the attachment upload — try again." });
    }
  },
);

router.post(
  "/training/videos/:videoId/attachments",
  limitWrites,
  async (req: Request, res: Response) => {
    let strayCandidate: string | null = null;
    let strayVideoId: string | null = null;
    try {
      const parsed = TrainingAttachmentFinalizeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      const { objectPath, contentType } = parsed.data;
      const name = parsed.data.name.trim() || "Attachment";
      if (!isAttachmentObjectPath(record.id, objectPath)) {
        res.status(400).json({ error: "That upload doesn't belong to this video's attachments." });
        return;
      }
      if (!ATTACHMENT_CONTENT_TYPES.has(contentType)) {
        res.status(415).json({ error: ATTACHMENT_TYPE_ERROR });
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
      // From here the uploaded object exists and we own it until the
      // swap commits; the outer catch hands it a durable fate on any
      // thrown path.
      strayCandidate = objectPath;
      strayVideoId = record.id;

      await drainMediaCleanup(req.log);
      // Re-validate against the STORED bytes — the declared body is just a
      // claim. Any rejection deletes the stray object so nothing orphans.
      const [metadata] = await file.getMetadata();
      const sizeBytes = Number(metadata.size ?? 0);
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_ATTACHMENT_BYTES) {
        await rejectStray(res, 413, "That file is empty or over the 25 MB limit.", objectPath, record.id, req.log);
        return;
      }
      const storedType = typeof metadata.contentType === "string" && metadata.contentType
        ? metadata.contentType
        : null;
      if (storedType && storedType !== contentType) {
        await rejectStray(res, 422, "The uploaded bytes don't match the declared file type — try the upload again.", objectPath, record.id, req.log);
        return;
      }
      // Download clicks are plain signed GETs, so stamping the disposition
      // here is what makes every later download save under the real name.
      await file.setMetadata({
        contentType: storedType ?? contentType,
        contentDisposition: attachmentDisposition(name),
      });

      const entry = {
        id: randomUUID(),
        name,
        sizeLabel: formatSizeLabel(sizeBytes),
        source: objectPath,
        contentType,
        sizeBytes,
      };
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = attempt === 0 ? record : await getVideoRecord(record.id);
        if (!current) break;
        if (attachmentEntries(current.attachments).length >= MAX_ATTACHMENTS_PER_VIDEO) {
          await rejectStray(
            res,
            409,
            `This lesson already has ${MAX_ATTACHMENTS_PER_VIDEO} attachments — remove one first.`,
            objectPath,
            record.id,
            req.log,
          );
          return;
        }
        const raw = Array.isArray(current.attachments) ? current.attachments : [];
        if (await updateAttachmentsIfCurrent(current.id, current.attachments, [...raw, entry])) {
          strayCandidate = null;
          res.json({ attachment: entry });
          return;
        }
      }
      await rejectStray(res, 409, "The lesson changed while attaching the file — try again.", objectPath, record.id, req.log);
    } catch (error) {
      if (strayCandidate) {
        await deleteOrQueue(strayCandidate, strayVideoId, "stray", req.log);
      }
      req.log?.error({ err: error }, "training attachment finalize failed");
      res.status(500).json({ error: "Could not attach the file — try again." });
    }
  },
);

router.delete(
  "/training/videos/:videoId/attachments/:attachmentId",
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      const attachmentId = String(req.params.attachmentId);
      const target = attachmentEntries(record.attachments).find((item) => item.id === attachmentId);
      if (!target) {
        res.status(404).json({ error: "No such attachment." });
        return;
      }
      // File first, entry second: if storage refuses the delete we bail with
      // the row untouched, so the attachment stays visible and the remove can
      // simply be retried (a missing object counts as deleted, which is what
      // keeps that retry idempotent). The reverse order would strand an
      // unreferenced object nothing could ever clean up.
      const source = attachmentSource(target);
      if (source) {
        try {
          await objectStorage.deleteObjectStrict(source);
        } catch (error) {
          req.log?.error({ err: error, attachmentId }, "training attachment object delete refused");
          res.status(502).json({
            error: "Could not delete the stored file — the attachment was left in place; try again.",
          });
          return;
        }
      }
      let entryGone = false;
      for (let attempt = 0; attempt < 5 && !entryGone; attempt += 1) {
        const current = attempt === 0 ? record : await getVideoRecord(record.id);
        if (!current) {
          // The whole video vanished mid-flight — its file is gone either way.
          entryGone = true;
          break;
        }
        if (!attachmentEntries(current.attachments).some((item) => item.id === attachmentId)) {
          // Someone else already removed it — the desired state holds.
          entryGone = true;
          break;
        }
        const raw = Array.isArray(current.attachments) ? current.attachments : [];
        const next = raw.filter(
          (item) => !(item && typeof item === "object" && (item as { id?: unknown }).id === attachmentId),
        );
        if (await updateAttachmentsIfCurrent(current.id, current.attachments, next)) {
          entryGone = true;
        }
      }
      if (!entryGone) {
        // The object is already gone; the stale entry stays retryable — the
        // next attempt tolerates the missing file and finishes the row.
        res.status(409).json({ error: "The lesson changed while removing the attachment — try again." });
        return;
      }
      res.json({ removed: true });
    } catch (error) {
      req.log?.error({ err: error }, "training attachment remove failed");
      res.status(500).json({ error: "Could not remove the attachment — try again." });
    }
  },
);

// Clear-all: the video-deletion flow calls this FIRST so dropping the row
// never orphans stored files. Legacy name-only entries clear with no
// storage work; junk entries are swept out with the same write.
router.delete(
  "/training/videos/:videoId/attachments",
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      if (Array.isArray(record.attachments) && record.attachments.length === 0) {
        res.json({ removed: 0, deletedObjects: 0 });
        return;
      }
      // Files first, row second (same rule as single removal): a stored
      // object that refuses deletion keeps its row entry, so the caller sees
      // an error and retries just the leftovers — nothing ever orphans.
      const entries = attachmentEntries(record.attachments);
      let deletedObjects = 0;
      const failedIds = new Set<string>();
      for (const entry of entries) {
        const source = attachmentSource(entry);
        if (!source) continue;
        try {
          await objectStorage.deleteObjectStrict(source);
          deletedObjects += 1;
        } catch (error) {
          req.log?.error({ err: error, attachmentId: entry.id }, "training attachment object delete refused");
          failedIds.add(entry.id);
        }
      }
      const removableIds = new Set(entries.filter((entry) => !failedIds.has(entry.id)).map((entry) => entry.id));
      let swapped = false;
      for (let attempt = 0; attempt < 5 && !swapped; attempt += 1) {
        const current = attempt === 0 ? record : await getVideoRecord(record.id);
        if (!current) {
          // Video vanished mid-flight; there is no row left to clean.
          swapped = true;
          break;
        }
        const raw = Array.isArray(current.attachments) ? current.attachments : [];
        // Keep entries whose files refused deletion plus anything appended
        // concurrently; sweep id-less junk with the same write.
        const next = raw.filter((item) => {
          const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
          if (typeof id !== "string") return false;
          return !removableIds.has(id);
        });
        if (next.length === raw.length && next.every((item, index) => item === raw[index])) {
          swapped = true;
          break;
        }
        if (await updateAttachmentsIfCurrent(current.id, current.attachments, next)) {
          swapped = true;
        }
      }
      if (!swapped) {
        res.status(409).json({ error: "The lesson changed while clearing attachments — try again." });
        return;
      }
      if (failedIds.size > 0) {
        res.status(502).json({
          error:
            failedIds.size === 1
              ? "Could not delete a stored file — that attachment was left in place; try again."
              : `Could not delete ${failedIds.size} stored files — those attachments were left in place; try again.`,
        });
        return;
      }
      res.json({ removed: removableIds.size, deletedObjects });
    } catch (error) {
      req.log?.error({ err: error }, "training attachments clear failed");
      res.status(500).json({ error: "Could not clear the attachments — try again." });
    }
  },
);

// Download URL (open read, like playback): minted fresh per click with a
// short TTL — nothing durable for clients to persist, so downloads keep
// working after reloads and in other browsers.
router.get(
  "/training/videos/:videoId/attachments/:attachmentId/download-url",
  async (req: Request, res: Response) => {
    try {
      const record = await loadVideoOr404(String(req.params.videoId), res);
      if (!record) return;
      const entry = attachmentEntries(record.attachments).find(
        (item) => item.id === String(req.params.attachmentId),
      );
      if (!entry) {
        res.status(404).json({ error: "No such attachment." });
        return;
      }
      const source = attachmentSource(entry);
      if (!source) {
        res.status(404).json({ error: "No file is hosted for this attachment — it predates file uploads." });
        return;
      }
      const downloadUrl = await objectStorage.signedDownloadURL(source, ATTACHMENT_DOWNLOAD_TTL_SEC);
      res.json({
        downloadUrl,
        name: typeof entry.name === "string" && entry.name ? entry.name : "Attachment",
        expiresAtMs: Date.now() + ATTACHMENT_DOWNLOAD_TTL_SEC * 1000,
      });
    } catch (error) {
      req.log?.error({ err: error }, "training attachment download-url failed");
      res.status(500).json({ error: "Could not prepare the download — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Playback (open, unlimited): short-lived signed URLs, range requests hit storage
// ---------------------------------------------------------------------------

router.get(
  "/training/videos/:videoId/media",
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
// Transcript (editor viewer) — open read, like playback
// ---------------------------------------------------------------------------

router.get(
  "/training/videos/:videoId/transcript",
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
  limitWrites,
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
      const { thumbnailSource, thumbnailUrl } = await persistThumbnailFrame(record, atSeconds, req.log);
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
  limitWrites,
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
            const { thumbnailSource, thumbnailUrl } = await persistThumbnailFrame(record, 0, req.log);
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
