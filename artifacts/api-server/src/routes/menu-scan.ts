/**
 * POST /coach/menu-scan — scan a restaurant menu photo for what a patient
 * can order under the THINNR program.
 *
 * The photo arrives as a data URI inside JSON. This is the only route that
 * accepts a photo-sized body, so it mounts its own JSON parser with a larger
 * limit (app.ts skips the global 100kb parser for exactly this path). The
 * photo is validated, sent to the vision model, and discarded with the
 * request — never logged, written to disk, or stored.
 */
import express, { Router, type IRouter } from "express";
import { CoachMenuScanBody } from "@workspace/api-zod";
import { demoPatientContext } from "../coach/demo-patient";
import { acquireMenuScanSlot } from "../coach/limits";
import { generateMenuScan } from "../coach/menu-scan";
import {
  INVALID_PHOTO_MESSAGE,
  MAX_PHOTO_BYTES,
  PHOTO_BODY_LIMIT,
  PHOTO_DATA_URI_PATTERN,
  PHOTO_TOO_LARGE_MESSAGE,
  decodedPhotoBytes,
} from "../lib/photo-guards";
import { gatePhotoAnalysis } from "../lib/patient-auth";

const router: IRouter = Router();

/** Absolute request path — app.ts skips the global JSON parser here. */
export const MENU_SCAN_PATH = "/api/coach/menu-scan";

const SCAN_FAILED_MESSAGE = "The menu scan is unavailable right now. Please try again.";

router.post("/coach/menu-scan", express.json({ limit: PHOTO_BODY_LIMIT }), async (req, res) => {
  // Limit first: every scan is a paid vision call with a photo attached.
  const slot = acquireMenuScanSlot(req.ip ?? "unknown");
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }

  try {
    // Consent gate: a signed-in patient who declined photo analysis (or has
    // not accepted the current policy) never gets a photo to the model.
    // The lookup can throw when the patients table is unreachable; that
    // falls through to the route's generic failure answer below.
    const gate = await gatePhotoAnalysis(req);
    if (!gate.ok) {
      res.status(gate.status).json(gate.body);
      return;
    }
    const parsed = CoachMenuScanBody.safeParse(req.body);
    if (!parsed.success || !PHOTO_DATA_URI_PATTERN.test(parsed.data.image)) {
      res.status(400).json({ error: INVALID_PHOTO_MESSAGE });
      return;
    }
    const image = parsed.data.image;
    if (decodedPhotoBytes(image) > MAX_PHOTO_BYTES) {
      res.status(413).json({ error: PHOTO_TOO_LARGE_MESSAGE });
      return;
    }

    // Stop paying for the model call when the patient cancels mid-scan.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    const payload = await generateMenuScan({
      image,
      patient: demoPatientContext(),
      signal: abort.signal,
      log: req.log,
    });
    if (abort.signal.aborted) return;

    // Log outcome shape only — never the photo or its size-revealing body.
    req.log.info(
      { result: payload.result, order: payload.order.length, avoid: payload.avoid.length },
      "menu scan completed",
    );
    res.json(payload);
  } catch (error) {
    if (res.headersSent || res.writableEnded) return;
    req.log.error({ err: error }, "menu scan failed");
    res.status(502).json({ error: SCAN_FAILED_MESSAGE });
  } finally {
    slot.release();
  }
});

export default router;
