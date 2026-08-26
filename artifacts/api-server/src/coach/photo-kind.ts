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

export const PHOTO_TRIAGE_MODEL = "gpt-5-nano";

/** The pipelines a chat photo can route to. */
export type ResolvedPhotoKind = "menu" | "meal";

const TriageSchema = z.object({ subject: z.enum(["menu", "food", "other"]) });

/**
 * Kept as an exported constant so route tests can recognize a triage call by
 * its system prompt (the mocks answer it differently from the scan calls).
 */
export const PHOTO_TRIAGE_PROMPT = `You are the photo triage step inside the THINNR patient app. The patient attached a photo in a chat with their coach; decide what it mainly shows so the right helper answers.

Respond with a single JSON object and nothing else, no markdown: {"subject": "menu" | "food" | "other"}

- "menu": a restaurant menu the patient could order from: a printed page, folded card, menu board, or menu shown on a screen, listing dishes or drinks, usually with prices.
- "food": actual food or drink in front of the patient: a plate, bowl, cup, container, or packaged item they could eat or drink now.
- "other": neither of those is clearly the subject.

If both appear, pick the one that dominates the frame. Printed dish photos ON a menu page still mean "menu".`;

interface MinimalLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Classifies one chat photo. Returns "menu" only when the model clearly saw
 * a menu; "food" and "other" both resolve to "meal" (see module docs).
 */
export async function resolvePhotoKind(args: {
  /** Validated image data URI (jpeg/png/webp). Kept in memory only. */
  image: string;
  signal: AbortSignal;
  log: MinimalLog;
}): Promise<ResolvedPhotoKind> {
  const deadline = createUpstreamDeadline(args.signal);
  try {
    const completion = await openai.chat.completions.create(
      {
        model: PHOTO_TRIAGE_MODEL,
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
    );
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = TriageSchema.safeParse(extractModelJson(raw));
    if (!parsed.success) {
      args.log.warn({ raw: raw.slice(0, 200) }, "photo triage output invalid; defaulting to meal");
      return "meal";
    }
    return parsed.data.subject === "menu" ? "menu" : "meal";
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
