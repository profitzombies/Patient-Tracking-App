/**
 * Photo triage for the coach chat's camera button.
 *
 * The Library/Diary meal flows label their photos (photoKind "meal"), and
 * the retry path replays whatever kind the original turn carried — but the
 * chat composer's camera sends no kind at all: the patient just snapped
 * whatever is in front of them. One tiny vision call looks at the photo and
 * decides which pipeline should answer:
 *
 *   "menu" → the restaurant menu scan (picks, skips, recipe offer)
 *   "label" → the nutrition label reader (facts read-back, then a name ask)
 *   anything else → the meal analysis, whose not-food outcome already reads
 *   junk photos warmly (so "other" needs no pipeline of its own).
 *
 * The triage is a router, not the answer: when the call fails or returns
 * nonsense it defaults to "meal" rather than killing the turn. Only a real
 * upstream timeout (the shared idle deadline) propagates — after that much
 * silence the follow-on pipeline call would almost certainly hang too, and
 * the route's named-timeout error is the honest reply.
 *
 * The photo lives in this request's memory only; it is never logged or
 * stored.
 */

import { z } from "zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { extractModelJson } from "./model-json";
import { UpstreamTimeoutError, createUpstreamDeadline } from "./upstream";
import type { UsageRecorder } from "./usage";
import { withModelUsageSurface } from "@workspace/integrations-openai-ai-server/usage";
import { DEFAULT_MODELS, modelFor } from "../ai/models";

export const PHOTO_TRIAGE_MODEL = DEFAULT_MODELS["coach.photo_classify"];

/** The pipelines a chat photo can route to. */
export type ResolvedPhotoKind = "menu" | "meal" | "label";

const TriageSchema = z.object({ subject: z.enum(["menu", "food", "label", "other"]) });

/**
 * Kept as an exported constant so route tests can recognize a triage call by
 * its system prompt (the mocks answer it differently from the scan calls).
 */
export const PHOTO_TRIAGE_PROMPT = `You are the photo triage step inside the THINNR patient app. The patient attached a photo in a chat with their coach; decide what it mainly shows so the right helper answers.

Respond with a single JSON object and nothing else, no markdown: {"subject": "menu" | "food" | "label" | "other"}

- "menu": a restaurant menu the patient could order from: a printed page, folded card, menu board, or menu shown on a screen, listing dishes or drinks, usually with prices.
- "label": a packaged food's Nutrition Facts panel is the subject: the boxed table with serving size, calories, and the fat, carbohydrate, and protein rows.
- "food": actual food or drink in front of the patient: a plate, bowl, cup, container, or packaged item they could eat or drink now.
- "other": none of those is clearly the subject.

If several appear, pick the one that dominates the frame. Printed dish photos ON a menu page still mean "menu". A package shot from the front, brand art showing, is "food"; only the facts panel itself means "label".`;

interface MinimalLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Classifies one chat photo. Returns "menu" or "label" only when the model
 * clearly saw one; "food" and "other" both resolve to "meal" (see module
 * docs).
 */
export async function resolvePhotoKind(args: {
  /** Validated image data URI (jpeg/png/webp). Kept in memory only. */
  image: string;
  /** Per-call token usage sink (the route's photo usage log). */
  onUsage?: UsageRecorder;
  signal: AbortSignal;
  log: MinimalLog;
}): Promise<ResolvedPhotoKind> {
  const deadline = createUpstreamDeadline(args.signal);
  try {
    const completion = await withModelUsageSurface("coach.photo_classify", () => openai.chat.completions.create(
      {
        model: modelFor("coach.photo_classify"),
        // Reasoning models spend part of this budget internally before
        // emitting text; smaller caps come back empty.
        max_completion_tokens: 8192,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: PHOTO_TRIAGE_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Here is the photo. Reply with the single JSON object." },
              { type: "image_url", image_url: { url: args.image } },
            ],
          },
        ],
      },
      { signal: deadline.signal },
    ));
    args.onUsage?.(completion.usage);
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = TriageSchema.safeParse(extractModelJson(raw));
    if (!parsed.success) {
      args.log.warn({ raw: raw.slice(0, 200) }, "photo triage output invalid; defaulting to meal");
      return "meal";
    }
    if (parsed.data.subject === "menu") return "menu";
    if (parsed.data.subject === "label") return "label";
    return "meal";
  } catch (error) {
    if (deadline.expired) {
      throw new UpstreamTimeoutError("photo triage call", deadline.idleMs, { cause: error });
    }
    // A client disconnect aborts everything; let the route's catch stay silent.
    if (args.signal.aborted) throw error;
    args.log.warn({ err: error }, "photo triage call failed; defaulting to meal");
    return "meal";
  } finally {
    deadline.finish();
  }
}
