/**
 * Guided progress photo storage — upload-url → presigned PUT → finalize,
 * the same three-step shape as training media but with no database row:
 * the phone is the source of truth for which photos exist. The server's
 * whole job is (1) mint a presigned PUT bound to a fresh object under the
 * progress-photos prefix, (2) verify after the PUT that the STORED bytes
 * really are an image within the cap (magic bytes, not the declared
 * type), and (3) redirect grid reads to short-lived signed GETs — so the
 * app persists object paths, never URLs.
 *
 * Demo posture mirrors training media: no sign-in; every WRITE rides a
 * per-IP limiter with its own knobs so a photo session never shares a
 * budget with lesson uploads. Reads are open — the grid redirect is
 * cheap and re-minted as the patient scrolls.
 */
import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  ProgressPhotoFinalizeBody,
  ProgressPhotoUploadUrlBody,
} from "@workspace/api-zod";
import {
  detectThumbnailContentType,
  ObjectNotFoundError,
  objectStorage,
  THUMBNAIL_CONTENT_TYPES,
} from "../lib/objectStorage";
import { createLimiter, envLimit } from "../coach/limits";

const router: IRouter = Router();

/** Hard cap on a stored shot — far above a compressed 1600px JPEG. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Every stored photo lives flat under this prefix. */
export const PROGRESS_PHOTO_PREFIX = "/objects/progress-photos/";

/** Signed GET leash for grid reads; redirects are re-minted per request. */
const PHOTO_DOWNLOAD_TTL_SEC = 3600;

/**
 * Magic-byte sniffing needs only the head of the file — but the head must
 * reach the JPEG SOF marker, and metadata-heavy files (EXIF/XMP/Photoshop
 * stacks, AI-generation tags) routinely push SOF past 4 KB. 64 KB clears
 * any single APPn segment (their length field caps at 64 KB) while staying
 * a trivial ranged read.
 */
const HEAD_SNIFF_BYTES = 64 * 1024;

/**
 * Only paths this server itself minted pass: one flat object id of the
 * form `<angle>-<uuid>`. No nesting, no dots, no traversal — a hostile
 * path can never reach outside the progress-photos folder.
 */
export function isPhotoObjectPath(objectPath: string): boolean {
  if (!objectPath.startsWith(PROGRESS_PHOTO_PREFIX)) return false;
  const rest = objectPath.slice(PROGRESS_PHOTO_PREFIX.length);
  return /^(front|side|back)-[A-Za-z0-9-]{8,64}$/.test(rest);
}

/**
 * Per-IP limit on photo WRITES — the same limiter machinery as training
 * media with its OWN knobs. PROGRESS_PHOTO_WRITE_BURST /
 * PROGRESS_PHOTO_WRITE_DAILY_BUDGET stage denials for tests (read at
 * server start; restart to change). The burst absorbs a full session:
 * three angles × (upload-url + finalize) plus a retry pass.
 */
const acquirePhotoWriteSlot = createLimiter({
  burst: envLimit("PROGRESS_PHOTO_WRITE_BURST", 30),
  refillPerMinute: 15,
  maxConcurrent: 8,
  dailyBudget: envLimit("PROGRESS_PHOTO_WRITE_DAILY_BUDGET", 600),
  dailyMessage: "Photo uploads have reached their daily limit. Please try again tomorrow.",
  busyMessage: "Photo uploads are busy right now. Please try again in a moment.",
  rapidMessage: "You are uploading too quickly. Please wait a moment.",
});

function limitWrites(req: Request, res: Response, next: NextFunction): void {
  const slot = acquirePhotoWriteSlot(req.ip ?? "unknown");
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  // "close" fires whether the response finished or the connection died
  // mid-request, and release is idempotent — concurrency can never leak.
  res.on("close", slot.release);
  next();
}

/**
 * A finalize rejection must not orphan the uploaded object. Photos have
 * no cleanup ledger (no database at all), so this is best-effort: a
 * failed delete leaves an unreferenced object nothing points at, and the
 * client is told the truth about the photo either way.
 */
async function discardStray(objectPath: string, req: Request): Promise<void> {
  try {
    await objectStorage.deleteObjectStrict(objectPath);
  } catch (error) {
    req.log?.warn({ err: error, objectPath }, "progress photo stray delete failed");
  }
}

// ---------------------------------------------------------------------------
// Presigned upload
// ---------------------------------------------------------------------------

router.post(
  "/progress-photos/upload-url",
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const parsed = ProgressPhotoUploadUrlBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const { angle, contentType, sizeBytes } = parsed.data;
      // The zod enum/max already reject these at 400; the explicit checks
      // keep the 415/413 contract honest if the schema ever loosens.
      if (!THUMBNAIL_CONTENT_TYPES.has(contentType)) {
        res.status(415).json({ error: "Upload a JPEG, PNG, or WebP image." });
        return;
      }
      if (sizeBytes > MAX_PHOTO_BYTES) {
        res.status(413).json({ error: "That photo is over the 10 MB limit." });
        return;
      }
      const { uploadUrl, objectPath } = await objectStorage.progressPhotoUploadURL(angle);
      res.json({ uploadUrl, objectPath });
    } catch (error) {
      req.log?.error({ err: error }, "progress photo upload-url failed");
      res.status(500).json({ error: "Could not prepare the upload — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Finalize (verify the stored bytes before the app keeps the path)
// ---------------------------------------------------------------------------

router.post(
  "/progress-photos/finalize",
  limitWrites,
  async (req: Request, res: Response) => {
    let strayCandidate: string | null = null;
    try {
      const parsed = ProgressPhotoFinalizeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const { objectPath } = parsed.data;
      if (!isPhotoObjectPath(objectPath)) {
        res.status(400).json({ error: "That upload isn't a progress photo." });
        return;
      }

      let file;
      try {
        file = await objectStorage.entityFile(objectPath);
      } catch (error) {
        if (error instanceof ObjectNotFoundError) {
          res.status(404).json({ error: "The uploaded photo never arrived — try the upload again." });
          return;
        }
        throw error;
      }
      // From here the object exists and we own its fate: every rejection
      // below discards it so nothing orphans.
      strayCandidate = objectPath;

      // Re-validate against the STORED bytes — the declared upload-url
      // body was just a claim made before the PUT.
      const [metadata] = await file.getMetadata();
      const sizeBytes = Number(metadata.size ?? 0);
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_PHOTO_BYTES) {
        strayCandidate = null;
        await discardStray(objectPath, req);
        res.status(413).json({ error: "That photo is empty or over the 10 MB limit." });
        return;
      }
      const [head] = await file.download({
        start: 0,
        end: Math.min(sizeBytes, HEAD_SNIFF_BYTES) - 1,
      });
      const detected = detectThumbnailContentType(head);
      if (!detected) {
        strayCandidate = null;
        await discardStray(objectPath, req);
        res.status(422).json({ error: "The uploaded bytes aren't a JPEG, PNG, or WebP image." });
        return;
      }
      // Stamp the DETECTED type so later signed GETs serve with the right
      // Content-Type no matter what the PUT declared.
      await file.setMetadata({ contentType: detected });

      res.json({ objectPath, sizeBytes, contentType: detected });
    } catch (error) {
      if (strayCandidate) {
        await discardStray(strayCandidate, req);
      }
      req.log?.error({ err: error }, "progress photo finalize failed");
      res.status(500).json({ error: "Could not verify the upload — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Grid reads — 302 to a short-lived signed URL
// ---------------------------------------------------------------------------

router.get("/progress-photos/file", async (req: Request, res: Response) => {
  try {
    const objectPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!isPhotoObjectPath(objectPath)) {
      res.status(400).json({ error: "Not a progress photo path." });
      return;
    }
    try {
      await objectStorage.entityFile(objectPath);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "No such photo." });
        return;
      }
      throw error;
    }
    const signedUrl = await objectStorage.signedDownloadURL(objectPath, PHOTO_DOWNLOAD_TTL_SEC);
    // The signed URL expires — a cached redirect would pin a dead link.
    res.setHeader("Cache-Control", "private, max-age=0, no-cache");
    res.redirect(302, signedUrl);
  } catch (error) {
    req.log?.error({ err: error }, "progress photo file redirect failed");
    res.status(500).json({ error: "Could not open that photo — try again." });
  }
});

export default router;
