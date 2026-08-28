/**
 * Progress-photo media routes for the guided photo session.
 *
 * Access model (demo posture): the same opening as training media and the
 * knowledge library — no patient sign-in gate; every WRITE rides a modest
 * per-IP limiter with its own knobs (src/progress/limits.ts). Both routes
 * here are writes; nothing is ever read back publicly. The app keeps the
 * on-device copy for display and records the object path on the photo.
 *
 * Storage model: the phone compresses each shot, asks for a presigned PUT
 * (the server mints the WHOLE object path — clients never choose where
 * bytes land), uploads straight to App Storage, then hits finalize, which
 * verifies the object really landed under the progress prefix with an
 * accepted image type and sane size — and deletes the stray otherwise, so
 * a lying client can't park junk under our prefix.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { ProgressPhotoFinalizeBody, ProgressPhotoUploadUrlBody } from "@workspace/api-zod";
import {
  ObjectNotFoundError,
  objectStorage,
  THUMBNAIL_CONTENT_TYPES,
  detectThumbnailContentType,
} from "../lib/objectStorage";
import { acquireProgressWriteSlot } from "../progress/limits";

const router: IRouter = Router();

/** Hard cap on one compressed shot; the app compresses to well under this. */
export const MAX_PROGRESS_PHOTO_BYTES = 15 * 1024 * 1024;

/** Every minted path lives under this prefix; finalize refuses anything else. */
export const PROGRESS_OBJECT_PREFIX = "/objects/progress-photos/";

/**
 * Per-IP limit on both routes — the stand-in for a sign-in gate, exactly
 * like training media. Limit first: denials are cheap JSON answers before
 * any storage work.
 */
function limitWrites(req: Request, res: Response, next: NextFunction): void {
  const slot = acquireProgressWriteSlot(req.ip ?? "unknown");
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  // "close" fires whether the response finished or the connection died
  // mid-request, and release is idempotent — concurrency can never leak.
  res.on("close", slot.release);
  next();
}

router.post("/progress-photos/upload-url", limitWrites, async (req: Request, res: Response) => {
  try {
    const parsed = ProgressPhotoUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const { contentType, sizeBytes, angle } = parsed.data;
    if (!THUMBNAIL_CONTENT_TYPES.has(contentType)) {
      res.status(415).json({ error: "Upload a JPG, PNG, or WebP image." });
      return;
    }
    if (sizeBytes > MAX_PROGRESS_PHOTO_BYTES) {
      res.status(413).json({ error: "That photo is over the 15 MB limit." });
      return;
    }
    const minted = await objectStorage.progressPhotoUploadURL(angle ?? "shot");
    res.json(minted);
  } catch (error) {
    req.log?.error({ err: error }, "progress upload-url failed");
    res.status(500).json({ error: "Could not prepare the upload. Please try again." });
  }
});

router.post("/progress-photos/finalize", limitWrites, async (req: Request, res: Response) => {
  try {
    const parsed = ProgressPhotoFinalizeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const { objectPath } = parsed.data;
    if (!objectPath.startsWith(PROGRESS_OBJECT_PREFIX)) {
      res.status(400).json({ error: "That upload isn't a progress photo." });
      return;
    }

    let file;
    try {
      file = await objectStorage.entityFile(objectPath);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res
          .status(404)
          .json({ error: "The uploaded photo never arrived — try the upload again." });
        return;
      }
      throw error;
    }

    const [metadata] = await file.getMetadata();
    const sizeBytes = Number(metadata.size ?? 0);
    if (sizeBytes > MAX_PROGRESS_PHOTO_BYTES) {
      await file.delete().catch(() => undefined);
      res.status(413).json({ error: "That photo is over the 15 MB limit." });
      return;
    }

    // Magic-byte sniff of the object head: proof the bytes are actually a
    // JPG/PNG/WebP before anything references the path — the declared
    // content type on the PUT is client-controlled and proves nothing.
    let head: Buffer;
    try {
      const [buf] = await file.download({ start: 0, end: 63 });
      head = buf;
    } catch {
      head = Buffer.alloc(0);
    }
    const sniffed = detectThumbnailContentType(head);
    if (!sniffed) {
      await file.delete().catch(() => undefined);
      res
        .status(415)
        .json({ error: "That upload isn't a photo we can keep — use a JPG, PNG, or WebP." });
      return;
    }

    res.json({ objectPath, sizeBytes });
  } catch (error) {
    req.log?.error({ err: error }, "progress finalize failed");
    res.status(500).json({ error: "Could not verify the upload. Please try again." });
  }
});

export default router;
