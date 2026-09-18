/**
 * Conversation titles for the patient's coach history.
 *
 * The title job hands the first patient message here and a small model
 * writes a short, specific name for the chat (the way a person would label
 * it), so the history list reads "Chipotle dinner plan" instead of a stack of
 * "New conversation". Output is shaped and cleaned before it is stored, and
 * a keyword fallback keeps the list usable when the model is unavailable.
 * The patient can rename any conversation; the database keeps that choice
 * over anything the job writes later.
 */
import { z } from "zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { cleanModelText, extractModelJson } from "./model-json";
import { withModelUsageSurface } from "@workspace/integrations-openai-ai-server/usage";
import { DEFAULT_MODELS, modelFor } from "../ai/models";

export const COACH_TITLE_MODEL = DEFAULT_MODELS["coach.title"];
export const COACH_TITLE_MAX_CHARS = 40;

export const COACH_TITLE_PROMPT = `You name chat conversations for the history list in the THINNR patient app. The patient is chatting with their weight-loss coach; you get the patient's first message and reply with a short title for that conversation.

Respond with a single JSON object and nothing else, no markdown: {"title": "..."}

Rules for the title:
- 2 to 5 words, at most ${COACH_TITLE_MAX_CHARS} characters, sentence case (capitalize the first word and proper nouns only).
- Name the specific topic: the food, restaurant, situation, or question. Keep brand and restaurant names as written.
- No quotes, no emoji, no punctuation at the end, no dashes, no colons.
- Never start with "Conversation", "Chat", "Question", "Help", or "Asking about".
- Do not include the patient's name or any health numbers such as weights, doses, or lab values.
- If the message is only a greeting or too short to name, reply {"title": "Quick check in"}.`;

const TitleSchema = z.object({ title: z.string() });

interface MinimalLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Deterministic screen behind the prompt rule: a title that carries a health
 * measurement, a dose, a percentage, a contact detail, or a long digit run is
 * discarded in favor of the keyword fallback. Titles show on the patient's
 * history list and on office review screens; plain counts ("3 day plan") pass.
 */
export function titleLooksSensitive(title: string): boolean {
  const text = title.toLowerCase();
  if (/\d[\d.,]*\s*(lb|lbs|pound|pounds|kg|kgs|kilo|kilos|mg|mcg|ug|ml|iu|units?|cc|%|percent|a1c|bmi|mmol|mg\/dl|bpm|cal|kcal|calories|oz|stone)(?![a-z])/.test(text)) return true;
  if (/\b(a1c|bmi|blood pressure|glucose|cholesterol|ldl|hdl|triglycerides|tsh|dose|dosage|weigh(?:s|ed|ing)?|weight)\b.*\d|\d.*\b(a1c|bmi|weigh(?:s|ed|ing)?|weight|dose|dosage)\b/.test(text)) return true;
  if (/\d{4,}|\d{3}[\s.]\d{3,}|@|https?:|www\./.test(text)) return true;
  return false;
}

/** Keyword fallback: a usable generic name when the model is unavailable. */
export function safeCoachTitle(text: string): string {
  const input = text.toLowerCase();
  if (/\b(recipe|cook|meal|dinner|lunch|breakfast)\b/.test(input)) return "Meal ideas";
  if (/\b(grocery|shop|store|ingredient)\b/.test(input)) return "Grocery planning";
  if (/\b(craving|snack|hungry)\b/.test(input)) return "Snack support";
  if (/\b(progress|goal|routine|plan)\b/.test(input)) return "Coaching plan";
  return "Coach conversation";
}

/**
 * Shapes a candidate title to the stored contract: brand spelling, no
 * emoji, no dashes or wrapping quotes, single spaces, trailing punctuation
 * dropped, hard length cap on a word boundary. Returns "" when nothing
 * usable remains.
 */
export function shapeCoachTitle(candidate: string): string {
  let title = cleanModelText(candidate)
    .replace(/[\u2010-\u2015\u2212-]+/g, " ")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/[\s:;,.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length > COACH_TITLE_MAX_CHARS) {
    const cut = title.slice(0, COACH_TITLE_MAX_CHARS + 1);
    const boundary = cut.lastIndexOf(" ");
    title = (boundary > 12 ? cut.slice(0, boundary) : cut.slice(0, COACH_TITLE_MAX_CHARS)).replace(/[\s:;,.!?]+$/g, "");
  }
  return title;
}

/**
 * Writes a title for a conversation from its first patient message. Never
 * throws: any model or shape failure returns the keyword fallback so the job
 * can always complete the work item.
 */
export async function generateCoachTitle(args: {
  firstMessage: string;
  signal?: AbortSignal;
  log?: MinimalLog;
}): Promise<{ title: string; source: "model" | "fallback" }> {
  const fallback = { title: safeCoachTitle(args.firstMessage), source: "fallback" as const };
  const firstMessage = args.firstMessage.trim().slice(0, 1200);
  if (!firstMessage) return fallback;
  try {
    const completion = await withModelUsageSurface("coach.title", () => openai.chat.completions.create(
      {
        model: modelFor("coach.title"),
        // Reasoning models spend part of this budget internally before
        // emitting text; smaller caps come back empty.
        max_completion_tokens: 4096,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: COACH_TITLE_PROMPT },
          { role: "user", content: `Patient's first message:\n\n${firstMessage}\n\nReply with the single JSON object.` },
        ],
      },
      { signal: args.signal },
    ));
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = TitleSchema.safeParse(extractModelJson(raw));
    const title = parsed.success ? shapeCoachTitle(parsed.data.title) : "";
    if (!title || titleLooksSensitive(title)) {
      // Never log the raw reply: it can echo the patient's own words.
      const reason = !parsed.success ? "unparseable" : !title ? "empty_after_shaping" : "sensitive";
      args.log?.warn({ reason }, "coach title output unusable; using fallback");
      return fallback;
    }
    return { title, source: "model" };
  } catch (error) {
    args.log?.warn({ reason: error instanceof Error ? error.name : "unknown" }, "coach title call failed; using fallback");
    return fallback;
  }
}
