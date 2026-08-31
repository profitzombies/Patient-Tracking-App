/**
 * Per-patient media rail — the account-backed photo storage behind the
 * foods library (custom-food and saved-recipe photos), built as the
 * reusable helper later per-patient media needs ride too.
 *
 * Same three-step storage shape as progress photos (upload-url → presigned
 * PUT → finalize that re-validates the STORED bytes), with two differences
 * that make the media follow the ACCOUNT instead of the device:
 *
 *   1. WRITES ARE AUTHENTICATED. upload-url and finalize resolve the
 *      caller's bearer session to a patients row (lib/patient-auth), and
 *      the minted object path embeds that patient's id —
 *      `/objects/patient-media/<patientId>/<kind>-<uuid>` — so ownership is
 *      baked into the path and finalize can reject any path outside the
 *      caller's own prefix.
 *   2. THE ACCOUNT KEEPS A RECORD. finalize registers the verified object
 *      in the patient_media ledger (service-role-only table), so what the
 *      account references is queryable server-side; the library RPC
 *      de-references rows when the items pointing at them go away.
 *
 * READS ARE OWNERSHIP-GATED TOO. <Image> tags can't send bearer headers,
 * so GET /patient-media/file authorizes via a patient-scoped HMAC token
 * (lib/media-token, minted by the authenticated state hydrate) that must
 * match the patient id the path is namespaced under, then verifies the
 * object is still on that patient's media ledger before 302-redirecting
 * to a short-lived signed URL. A leaked path opens nothing on its own,
 * and a removed photo's URL dies with its ledger row.
 */
import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  detectThumbnailContentType,
  ObjectNotFoundError,
  objectStorage,
  THUMBNAIL_CONTENT_TYPES,
} from "../lib/objectStorage";
import { verifyPatientMediaToken } from "../lib/media-token";
import { resolvePatient } from "../lib/patient-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { createLimiter, envLimit } from "../coach/limits";

const router: IRouter = Router();

/** Hard cap on a stored photo — far above a compressed 1600px JPEG. */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/** Every patient-media object lives under this prefix, then the owner's id. */
export const PATIENT_MEDIA_PREFIX = "/objects/patient-media/";

/** Signed GET leash for library reads; redirects are re-minted per request. */
const MEDIA_DOWNLOAD_TTL_SEC = 3600;

/**
 * Magic-byte sniffing needs only the head of the file — but the head must
 * reach the JPEG SOF marker, and metadata-heavy files (EXIF/XMP, AI
 * generation tags) routinely push SOF past 4 KB. 64 KB clears any single
 * APPn segment while staying a trivial ranged read.
 */
const HEAD_SNIFF_BYTES = 64 * 1024;

const MEDIA_KINDS = new Set(["food", "recipe", "chat", "progress"]);

/**
 * Only paths this server itself minted pass: a patient-id directory, then
 * one flat object id of the form `<kind>-<uuid>`. No nesting beyond that,
 * no dots, no traversal.
 */
export function isPatientMediaPath(objectPath: string): boolean {
  if (typeof objectPath !== "string" || objectPath.length > 300) return false;
  if (!objectPath.startsWith(PATIENT_MEDIA_PREFIX)) return false;
  const rest = objectPath.slice(PATIENT_MEDIA_PREFIX.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(food|recipe|chat|progress)-[A-Za-z0-9-]{8,64}$/i.test(
    rest,
  );
}

/** The ownership check writes ride: a valid path under THIS patient's prefix. */
export function isOwnPatientMediaPath(objectPath: string, patientId: string): boolean {
  return (
    isPatientMediaPath(objectPath) &&
    objectPath.startsWith(`${PATIENT_MEDIA_PREFIX}${patientId}/`)
  );
}

/**
 * Per-IP limit on media WRITES — the same limiter machinery as the other
 * media rails with its OWN knobs. PATIENT_MEDIA_WRITE_BURST /
 * PATIENT_MEDIA_WRITE_DAILY_BUDGET stage denials for tests (read at server
 * start; restart to change). The burst absorbs a save spree: each photo is
 * an upload-url + finalize pair.
 */
const acquireMediaWriteSlot = createLimiter({
  burst: envLimit("PATIENT_MEDIA_WRITE_BURST", 30),
  refillPerMinute: 15,
  maxConcurrent: 8,
  dailyBudget: envLimit("PATIENT_MEDIA_WRITE_DAILY_BUDGET", 600),
  dailyMessage: "Photo uploads have reached their daily limit. Please try again tomorrow.",
  busyMessage: "Photo uploads are busy right now. Please try again in a moment.",
  rapidMessage: "You are uploading too quickly. Please wait a moment.",
});

function limitWrites(req: Request, res: Response, next: NextFunction): void {
  const slot = acquireMediaWriteSlot(req.ip ?? "unknown");
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
 * A finalize rejection must not orphan the uploaded object. Best-effort:
 * a failed delete leaves an unreferenced object nothing points at, and the
 * client is told the truth about the photo either way.
 */
async function discardStray(objectPath: string, req: Request): Promise<void> {
  try {
    await objectStorage.deleteObjectStrict(objectPath);
  } catch (error) {
    req.log?.warn({ err: error, objectPath }, "patient media stray delete failed");
  }
}

// ---------------------------------------------------------------------------
// Presigned upload (authenticated)
// ---------------------------------------------------------------------------

router.post(
  "/patient-media/upload-url",
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const auth = await resolvePatient(req);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.kind !== "string" || !MEDIA_KINDS.has(body.kind)) {
        res.status(400).json({ error: "Invalid media kind." });
        return;
      }
      if (typeof body.contentType !== "string" || !THUMBNAIL_CONTENT_TYPES.has(body.contentType)) {
        res.status(415).json({ error: "Upload a JPEG, PNG, or WebP image." });
        return;
      }
      const sizeBytes = body.sizeBytes;
      if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
        res.status(400).json({ error: "Invalid photo size." });
        return;
      }
      if (sizeBytes > MAX_MEDIA_BYTES) {
        res.status(413).json({ error: "That photo is over the 10 MB limit." });
        return;
      }
      const { uploadUrl, objectPath } = await objectStorage.patientMediaUploadURL(
        auth.patientId,
        body.kind as "food" | "recipe" | "chat" | "progress",
      );
      res.json({ uploadUrl, objectPath });
    } catch (error) {
      req.log?.error({ err: error }, "patient media upload-url failed");
      res.status(500).json({ error: "Could not prepare the upload — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Finalize — verify the stored bytes, then register them on the account
// ---------------------------------------------------------------------------

router.post(
  "/patient-media/finalize",
  limitWrites,
  async (req: Request, res: Response) => {
    let strayCandidate: string | null = null;
    try {
      const auth = await resolvePatient(req);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const objectPath = typeof body.objectPath === "string" ? body.objectPath : "";
      // Ownership is baked into the path: anything outside the caller's own
      // prefix is rejected before storage is even consulted.
      if (!isOwnPatientMediaPath(objectPath, auth.patientId)) {
        res.status(400).json({ error: "That upload isn't yours to finalize." });
        return;
      }
      const objectId = objectPath.slice(`${PATIENT_MEDIA_PREFIX}${auth.patientId}/`.length);
      const kind = objectId.startsWith("recipe-")
        ? "recipe"
        : objectId.startsWith("chat-")
          ? "chat"
          : objectId.startsWith("progress-")
            ? "progress"
            : "food";

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

      // Re-validate against the STORED bytes — the declared upload-url body
      // was just a claim made before the PUT.
      const [metadata] = await file.getMetadata();
      const sizeBytes = Number(metadata.size ?? 0);
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_MEDIA_BYTES) {
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

      // The account's record of the object. If this write fails the object
      // is discarded and the client told — an upload the account has no
      // memory of would just be orphaned bytes.
      const registered = await supabaseAdmin(
        "POST",
        "/rest/v1/patient_media?on_conflict=object_path",
        [
          {
            object_path: objectPath,
            patient_id: auth.patientId,
            kind,
            content_type: detected,
            size_bytes: sizeBytes,
          },
        ],
        "resolution=merge-duplicates,return=minimal",
      );
      if (registered.status >= 300) {
        throw new Error(`patient media register failed (${registered.status})`);
      }

      res.json({ objectPath, sizeBytes, contentType: detected });
    } catch (error) {
      if (strayCandidate) {
        await discardStray(strayCandidate, req);
      }
      req.log?.error({ err: error }, "patient media finalize failed");
      res.status(500).json({ error: "Could not verify the upload — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Media reads — token-authorized 302 to a short-lived signed URL
// ---------------------------------------------------------------------------

/** Most orphan-discard paths a client may post at once (one guided set is 3). */
const MAX_CLEANUP_PATHS = 8;

/**
 * Discards progress uploads that never became grid rows. The photo save is
 * upload+finalize first, grid write second: when the grid write fails the
 * client holds the uploaded paths for retry, and if the patient abandons
 * instead it posts them here so the account isn't left owning invisible
 * objects. The RPC only deletes the caller's own progress-kind ledger rows
 * that NO grid row references — a path that made it into the grid (or any
 * other media kind) is untouched — and returns what it deleted so the
 * bytes can go too.
 */
router.post(
  "/patient-media/cleanup",
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const auth = await resolvePatient(req);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const paths = Array.isArray(body.paths) ? body.paths : null;
      if (!paths || paths.length === 0 || paths.length > MAX_CLEANUP_PATHS) {
        res.status(400).json({ error: "Send between 1 and 8 upload paths to discard." });
        return;
      }
      for (const path of paths) {
        if (typeof path !== "string" || !isOwnPatientMediaPath(path, auth.patientId)) {
          res.status(400).json({ error: "Only your own uploads can be discarded." });
          return;
        }
      }
      const rpc = await supabaseAdmin("POST", "/rest/v1/rpc/patient_media_cleanup_progress", {
        p_patient_id: auth.patientId,
        p_paths: paths,
      });
      if (rpc.status >= 300) {
        res.status(502).json({ error: "Could not discard the uploads — try again." });
        return;
      }
      const removed = Array.isArray(rpc.json)
        ? (rpc.json as unknown[]).filter((p): p is string => typeof p === "string")
        : [];
      // Rows first, bytes best-effort: a missed byte delete leaves an
      // unreferenced object for the storage sweep, not a correctness hole.
      for (const objectPath of removed) {
        try {
          await objectStorage.deleteObjectStrict(objectPath);
        } catch (error) {
          req.log?.warn({ err: error, objectPath }, "cleanup byte delete failed");
        }
      }
      res.json({ removed });
    } catch (error) {
      req.log?.error({ err: error }, "patient media cleanup failed");
      res.status(500).json({ error: "Could not discard the uploads — try again." });
    }
  },
);

router.get("/patient-media/file", async (req: Request, res: Response) => {
  try {
    const objectPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!isPatientMediaPath(objectPath)) {
      res.status(400).json({ error: "Not a patient media path." });
      return;
    }
    // Authorization rides the URL because <Image> can't send headers: the
    // token must verify for the patient id the path is namespaced under.
    // Knowing a path — even a leaked one — opens nothing by itself.
    const ownerId = objectPath.slice(PATIENT_MEDIA_PREFIX.length).split("/", 1)[0] ?? "";
    const token = typeof req.query.mt === "string" ? req.query.mt : "";
    if (token.length === 0) {
      res.status(401).json({ error: "Sign in to view this photo." });
      return;
    }
    if (!verifyPatientMediaToken(token, ownerId)) {
      res.status(403).json({ error: "That photo isn't yours to view." });
      return;
    }
    // The object must still be ON the account: removal deletes the ledger
    // row in the same RPC, so a removed photo's URL dies immediately even
    // while its bytes await the storage sweep.
    const ledger = await supabaseAdmin(
      "GET",
      `/rest/v1/patient_media?patient_id=eq.${encodeURIComponent(ownerId)}` +
        `&object_path=eq.${encodeURIComponent(objectPath)}&select=object_path&limit=1`,
    );
    if (ledger.status >= 300 || !Array.isArray(ledger.json)) {
      res.status(502).json({ error: "Could not open that photo — try again." });
      return;
    }
    if (ledger.json.length === 0) {
      res.status(404).json({ error: "No such photo." });
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
    const signedUrl = await objectStorage.signedDownloadURL(objectPath, MEDIA_DOWNLOAD_TTL_SEC);
    // The signed URL expires — a cached redirect would pin a dead link.
    res.setHeader("Cache-Control", "private, max-age=0, no-cache");
    res.redirect(302, signedUrl);
  } catch (error) {
    req.log?.error({ err: error }, "patient media file redirect failed");
    res.status(500).json({ error: "Could not open that photo — try again." });
  }
});

export default router;
