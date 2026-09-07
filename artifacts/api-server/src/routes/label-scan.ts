/**
 * POST /coach/label-scan — read a Nutrition Facts photo into per-serving
 * values for non-chat surfaces (the create-food screen's "Scan a label").
 *
 * Runs the exact same label reader as the coach chat's label photo turns
 * (see coach/label-photo.ts): transcription only, never estimates, and an
 * illegible required value makes the whole shot "unreadable" with a warm
 * retake nudge instead of guessed numbers. Unlike the chat turn, the result
 * comes back as one JSON payload — no SSE, no name conversation — because
 * the create-food form already has fields for the patient to review, name,
 * and save.
 *
 * The photo arrives as a data URI inside JSON, so this route mounts its own
 * large-body JSON parser (app.ts skips the global 100kb parser for exactly
 * this path). The photo is analyzed in request memory only — never logged,
 * written to disk, or stored — and label scans share the photo-scan rate
 * budget with menu scans and chat photo turns.
 */
import express, { Router, type IRouter } from "express";
import { CoachLabelScanBody } from "@workspace/api-zod";
import { demoPatientContext } from "../coach/demo-patient";
import { LABEL_TRY_ANOTHER_PHOTO } from "../coach/label-chat";
import { generateLabelPhotoAnalysis, type LabelDraft } from "../coach/label-photo";
import { acquireMenuScanSlot } from "../coach/limits";
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
export const LABEL_SCAN_PATH = "/api/coach/label-scan";

const SCAN_FAILED_MESSAGE = "The label scan is unavailable right now. Please try again.";

/**
 * Response shape of the draft: `servingsPerContainer` is omitted when the
 * panel prints none (the chat's SSE event keeps an explicit null, but a
 * REST schema is cleaner without nullable fields; the client treats absent
 * and null identically).
 */
function labelPayload(draft: LabelDraft): Omit<LabelDraft, "servingsPerContainer"> &
  Partial<Pick<LabelDraft, "servingsPerContainer">> {
  const { servingsPerContainer, ...rest } = draft;
  return servingsPerContainer === null ? rest : draft;
}

router.post("/coach/label-scan", express.json({ limit: PHOTO_BODY_LIMIT }), async (req, res) => {
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
    const parsed = CoachLabelScanBody.safeParse(req.body);
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

    const analysis = await generateLabelPhotoAnalysis({
      image,
      patient: demoPatientContext(),
      signal: abort.signal,
      log: req.log,
    });
    if (abort.signal.aborted) return;

    // Log outcome shape only — never the photo or its size-revealing body.
    req.log.info(
      { result: analysis.outcome, flagged: analysis.draft?.flagged === true },
      "label scan completed",
    );
    if (analysis.outcome === "ok" && analysis.draft !== null) {
      res.json({ result: "ok", message: analysis.message, label: labelPayload(analysis.draft) });
    } else {
      // Same warm re-ask the chat appends under a failed label turn, so the
      // create-food notice and the chat bubble ask in one voice.
      res.json({
        result: analysis.outcome,
        message: `${analysis.message}\n\n${LABEL_TRY_ANOTHER_PHOTO}`,
      });
    }
  } catch (error) {
    if (res.headersSent || res.writableEnded) return;
    req.log.error({ err: error }, "label scan failed");
    res.status(502).json({ error: SCAN_FAILED_MESSAGE });
  } finally {
    slot.release();
  }
});

export default router;
