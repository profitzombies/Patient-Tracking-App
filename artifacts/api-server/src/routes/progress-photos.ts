/**
 * Legacy progress-photo READS — a 302 to a short-lived signed GET for
 * objects the retired anonymous rail stored flat under the
 * progress-photos prefix. Photos saved before accounts existed still
 * live at those paths on devices' demo grids, so the redirect stays;
 * the app persists object paths, never URLs.
 *
 * The anonymous WRITE routes (upload-url → presigned PUT → finalize)
 * are gone for good: progress photo bytes now ride the authenticated
 * per-patient media rail (/api/patient-media/*, kind "progress") with a
 * grid row recorded on the account (/api/patient-data/photos), and the
 * demo persona keeps its shots on-device without any server writes.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { ObjectNotFoundError, objectStorage } from "../lib/objectStorage";

const router: IRouter = Router();

/** Every legacy stored photo lives flat under this prefix. */
export const PROGRESS_PHOTO_PREFIX = "/objects/progress-photos/";

/** Signed GET leash for grid reads; redirects are re-minted per request. */
const PHOTO_DOWNLOAD_TTL_SEC = 3600;

/**
 * Only paths the retired rail itself minted pass: one flat object id of
 * the form `<angle>-<uuid>`. No nesting, no dots, no traversal — a hostile
 * path can never reach outside the progress-photos folder.
 */
export function isPhotoObjectPath(objectPath: string): boolean {
  if (!objectPath.startsWith(PROGRESS_PHOTO_PREFIX)) return false;
  const rest = objectPath.slice(PROGRESS_PHOTO_PREFIX.length);
  return /^(front|side|back)-[A-Za-z0-9-]{8,64}$/.test(rest);
}

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
