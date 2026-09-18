/**
 * POST /coach/recipe-image — on-demand dish image for an AI-suggested recipe.
 *
 * The client sends the recipe name/description; the server builds a fixed
 * illustration prompt around the sanitized strings (client text can never
 * rewrite the instruction frame) and returns a small JPEG as a data URI —
 * `quality: "low"` keeps it ~100–200 KB so saved recipes can persist the
 * image inside localStorage/AsyncStorage without blowing quotas.
 *
 * The prompt deliberately mirrors the seeded Library set
 * (thinnr-mobile/assets/images/recipes/): flat illustrated top-down dish on
 * a white plate with cobalt accents — NOT photography — so coach-saved
 * recipes sit next to seeded ones as one family.
 *
 * Reliability: generation runs under the shared upstream idle deadline and
 * aborts when the client disconnects, so a hung call can never pin one of
 * the two concurrent image slots indefinitely (that jam was how later images
 * silently stopped generating). Image failures stay invisible in the chat by
 * design — the client swallows them — so the log lines here are the ONLY
 * trace; they carry pipeline/elapsedMs like the chat pipelines.
 */
import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { CoachRecipeImageBody } from "@workspace/api-zod";
import { sanitizeInline } from "../coach/prompt";
import { acquireImageSlot, type UsageSubject } from "../coach/limits";
import { UpstreamTimeoutError, createUpstreamDeadline } from "../coach/upstream";
import { bearerToken, resolvePatientIdentity } from "../lib/patient-auth";

const router: IRouter = Router();

/**
 * Who the image slot is charged to. Images carry no consent gate (the
 * prompt holds recipe text only), so the route stays open: a signed-in
 * patient's bearer keys the slot to the account and their office, and
 * anything else — the demo, a staff persona, a session the auth service
 * cannot resolve right now — falls back to the IP key rather than refusing
 * an optional illustration.
 */
async function imageSubject(req: Parameters<typeof resolvePatientIdentity>[0] & { ip?: string }): Promise<UsageSubject> {
  if (bearerToken(req) === null) return { ip: req.ip };
  const identity = await resolvePatientIdentity(req);
  if (!identity.ok) return { ip: req.ip };
  return { ip: req.ip, patientId: identity.patientId, officeId: identity.providerId };
}

router.post("/coach/recipe-image", async (req, res) => {
  // Limit first: image calls are the priciest AI spend in this demo. The
  // slot is reserved in the shared usage store, so the cap holds across
  // every server copy.
  const slot = await acquireImageSlot(await imageSubject(req), req.log);
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }

  const startedAt = Date.now();
  // A client that gave up (left the screen, closed the app) must not keep
  // burning a generation slot. `close` also fires after a normal completion,
  // hence the writableEnded guard.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  const deadline = createUpstreamDeadline(abort.signal);

  try {
    const parsed = CoachRecipeImageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const name = sanitizeInline(parsed.data.name, 80);
    const description = sanitizeInline(parsed.data.description ?? "", 200);
    if (!name) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const prompt =
      `Detailed flat vector illustration of ${name}. ${description ? `${description} ` : ""}` +
      "Square top-down view: the dish served on a single centered white ceramic plate or bowl " +
      "with a cobalt blue rim, one silver utensil beside the plate, plain pale cool blue-gray " +
      "background decorated with a few cobalt blue accent circles and small dotted-grid " +
      "patterns. Finely detailed stylized food with delicate highlights, clean saturated " +
      "colors, and smooth flat shading — soft shapes without dark ink outlines, like a " +
      "modern editorial food illustration. Soft drop shadow under the plate. Stylized " +
      "digital illustration, not photorealistic, no photo textures. " +
      "No people, no hands, no text, no logos.";

    const response = await openai.images.generate(
      {
        model: "gpt-image-1",
        prompt,
        size: "1024x1024",
        quality: "low",
        output_format: "jpeg",
      },
      { signal: deadline.signal },
    );

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) throw new Error("image response contained no data");
    res.json({ image: `data:image/jpeg;base64,${b64}` });
    req.log.info({ pipeline: "image", elapsedMs: Date.now() - startedAt }, "recipe image generated");
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    if (abort.signal.aborted) {
      // The client is gone; there is nobody to answer. Logged so abandoned
      // generations stay visible when reasoning about slot pressure.
      req.log.info({ pipeline: "image", elapsedMs }, "recipe image request abandoned by client");
      return;
    }
    const failure = deadline.expired
      ? new UpstreamTimeoutError("recipe image generation", deadline.idleMs, { cause: error })
      : error;
    req.log.error({ err: failure, pipeline: "image", elapsedMs }, "recipe image generation failed");
    if (!res.headersSent) {
      res.status(502).json({ error: "Photo generation failed. Please try again." });
    }
  } finally {
    // Stopping the deadline AFTER the call settles (success, failure, or
    // timeout-abort) guarantees the slot below can never leak behind a hung
    // upstream again.
    deadline.finish();
    slot.release();
  }
});

export default router;
