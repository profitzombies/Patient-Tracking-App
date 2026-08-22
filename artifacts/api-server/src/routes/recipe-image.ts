/**
 * POST /coach/recipe-image — on-demand dish photo for an AI-suggested recipe.
 *
 * The client sends the recipe name/description; the server builds a fixed
 * photography prompt around the sanitized strings (client text can never
 * rewrite the instruction frame) and returns a small JPEG as a data URI —
 * `quality: "low"` keeps it ~100–200 KB so saved recipes can persist the
 * photo inside localStorage/AsyncStorage without blowing quotas.
 */
import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { CoachRecipeImageBody } from "@workspace/api-zod";
import { sanitizeInline } from "../coach/prompt";
import { acquireImageSlot } from "../coach/limits";

const router: IRouter = Router();

router.post("/coach/recipe-image", async (req, res) => {
  // Limit first: image calls are the priciest AI spend in this demo.
  const slot = acquireImageSlot(req.ip ?? "unknown");
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }

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
      `Professional food photography of ${name}. ${description ? `${description} ` : ""}` +
      "Overhead angle, single dish on a matte ceramic plate, muted warm neutral background, " +
      "soft window light, realistic and appetizing. No people, no hands, no text, no logos.";

    const response = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      size: "1024x1024",
      quality: "low",
      output_format: "jpeg",
    });

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) throw new Error("image response contained no data");
    res.json({ image: `data:image/jpeg;base64,${b64}` });
  } catch (error) {
    req.log.error({ err: error }, "recipe image generation failed");
    if (!res.headersSent) {
      res.status(502).json({ error: "Photo generation failed. Please try again." });
    }
  } finally {
    slot.release();
  }
});

export default router;
