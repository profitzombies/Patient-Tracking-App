/**
 * Nutrition label reading — "photograph the box" for a packaged food.
 *
 * The route hands one photo of a Nutrition Facts panel over as a data URI;
 * the vision model TRANSCRIBES what the label prints: serving size, servings
 * per container, calories, and the macro rows, plus fiber, sugar, and sodium
 * when legible. Nothing is estimated — that is the rule that separates this
 * pipeline from the meal analysis. A value the model cannot read stays null,
 * and when any required value is illegible the whole shot comes back
 * "unreadable" with a warm retake nudge instead of guessed numbers.
 *
 * The validated read becomes a label DRAFT, not yet a food: labels rarely
 * carry the product's name, so the reply asks the patient what to call it
 * and the client holds the draft through that name conversation, building
 * the food card locally once the name settles. The draft rides its own SSE
 * event (`labelDraft`) that old clients simply ignore.
 *
 * A deterministic consistency check compares printed calories against the
 * 4/4/9 macro math and flags wild disagreement (misprint or misread) so the
 * reply and card can ask the patient to double-check the package — the read
 * still goes through, it is their label after all.
 *
 * Follows the meal photo's JSON-validation-with-corrective-retry pattern:
 * invalid output gets one corrective retry, then the caller reports an
 * honest failure instead of inventing numbers. The photo lives only in this
 * request's memory; it is never logged, written to disk, or stored.
 */

import { z } from "zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { cleanModelText, extractModelJson } from "./model-json";
import { stripDashes } from "./text-style";
import { patientContextLine, type PatientContext } from "./prompt";
import { type MealSlotContext, MEAL_SLOTS } from "./meal-slot";
import { UpstreamTimeoutError, createUpstreamDeadline } from "./upstream";
import type { UsageRecorder } from "./usage";
import { withModelUsageSurface } from "@workspace/integrations-openai-ai-server/usage";
import { DEFAULT_MODELS, modelFor } from "../ai/models";

export const LABEL_PHOTO_MODEL = DEFAULT_MODELS["coach.label_scan"];

/** One corrective retry when the model's JSON fails validation. */
const RETRY_LIMIT = 1;

/** One extra attempt per model call for transient upstream failures. */
const TRANSIENT_RETRY_LIMIT = 1;
const TRANSIENT_RETRY_DELAY_MS = 400;

// ─── Output contract ─────────────────────────────────────────────────────────

const LabelFactsSchema = z.object({
  servingSize: z.string().min(1).max(60),
  servingsPerContainer: z.number().min(0.5).max(1000).nullish(),
  calories: z.number().min(0).max(4000),
  protein: z.number().min(0).max(500),
  carbs: z.number().min(0).max(500),
  fat: z.number().min(0).max(500),
  fiber: z.number().min(0).max(200).nullish(),
  sugar: z.number().min(0).max(500).nullish(),
  sodium: z.number().min(0).max(20000).nullish(),
});

const ModelOutputSchema = z.object({
  result: z.enum(["ok", "not_label", "unreadable"]),
  message: z.string().min(1).max(500),
  label: LabelFactsSchema.nullish(),
});

export type LabelPhotoOutcome = "ok" | "not_label" | "unreadable";

/**
 * The validated per-serving read of one label, sent to the client as the
 * `labelDraft` SSE event. The client holds it through the name conversation
 * and builds the food card locally — the name never round-trips.
 */
export interface LabelDraft {
  id: string;
  /** Printed serving size line, e.g. "2/3 cup (55g)". */
  servingSize: string;
  servingsPerContainer: number | null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Present only when printed and legible. */
  fiber?: number;
  sugar?: number;
  sodium?: number;
  /** Diary slot the eventual food card preselects. */
  suggestedSlot: (typeof MEAL_SLOTS)[number];
  /** Printed calories disagree wildly with the 4/4/9 macro math. */
  flagged?: boolean;
}

export interface LabelPhotoAnalysis {
  outcome: LabelPhotoOutcome;
  /** Coach-voiced reaction (ok) or warm nudge (not_label / unreadable). */
  message: string;
  /** Validated label read — present only when outcome is "ok". */
  draft: LabelDraft | null;
}

/** The model kept returning invalid output; the route answers with an error. */
export class LabelPhotoModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabelPhotoModelError";
  }
}

interface MinimalLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(patient: PatientContext): string {
  return `You are the THINNR label reader, an AI helper inside the THINNR patient app. The patient photographed a packaged food's Nutrition Facts label so the app can turn it into a food they log. Transcribe what the label prints. Never estimate: a value you cannot read clearly is null, never a guess.

Respond with a single JSON object and nothing else — no markdown, no code fences:
{
  "result": "ok" | "not_label" | "unreadable",
  "message": string,
  "label": {
    "servingSize": string,
    "servingsPerContainer": number or null,
    "calories": number,
    "protein": number,
    "carbs": number,
    "fat": number,
    "fiber": number or null,
    "sugar": number or null,
    "sodium": number or null
  } or null
}

Reading the photo:
- "not_label": the photo does not show a nutrition label. In "message", say warmly and without any blame what you see instead, and set "label" to null.
- "unreadable": it does look like a nutrition label, but serving size, calories, total fat, total carbohydrate, or protein cannot be read with certainty because the shot is blurry, dark, too small, cropped, glared, or wrapped around a curve. Say so in "message" the way a coach would, no fault, and ask for one more shot taken straight on with the panel filling the frame. Set "label" to null. Choose "unreadable" over guessing, every single time.
- "ok": serving size, calories, total fat, total carbohydrate, and protein are all clearly legible. Fill in "label".

Filling "label" (when "result" is "ok"):
- Transcribe the printed PER SERVING values exactly as printed. Never compute, convert, or infer a value the label does not print.
- "servingSize": the printed serving size line, like "2/3 cup (55g)", at most 50 characters.
- "servingsPerContainer": the printed count ("about 8" means 8), or null when not shown or not legible.
- "calories", "protein", "carbs", "fat": the per-serving numbers, macros in grams. Use the Total Fat and Total Carbohydrate rows.
- "fiber", "sugar", "sodium": per-serving dietary fiber in grams, total sugars in grams, sodium in milligrams. Null for any that is not printed or not legible — these three are optional, the required five are not.
- A per-100g table with no serving column: treat 100 g as the serving, with "100 g" as servingSize.

"message" is 1-2 short sentences in the patient's coach's own texting voice — react like you really just read their label, specific and warm, contractions and plain words, never gushing. Plain text, never emojis, and never an em dash or en dash; punctuate with commas and periods. Never ask a question and never mention the numbers themselves; the app prints the values and asks its own follow-up after your message.

${patientContextLine(patient)}`;
}

// ─── Model call ──────────────────────────────────────────────────────────────

type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type AnalysisMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: UserContentPart[] };

function buildMessages(
  systemPrompt: string,
  image: string,
  previous: { raw: string; problems: string } | null,
): AnalysisMessage[] {
  const intro =
    "Here is the photo of the nutrition label. Transcribe it and reply with the single JSON object.";
  const text = previous
    ? `${intro}

Your previous answer was:
${previous.raw.slice(0, 6000)}

That answer was invalid: ${previous.problems}. Reply again with ONLY the corrected JSON object.`
    : intro;
  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text },
        { type: "image_url", image_url: { url: image } },
      ],
    },
  ];
}

async function callModel(
  messages: AnalysisMessage[],
  signal: AbortSignal,
  log: MinimalLog,
  onUsage: UsageRecorder | undefined,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_LIMIT; attempt++) {
    // Idle deadline per attempt: a wedged vision upstream must become a
    // prompt, explainable failure, not a request that hangs until a proxy
    // kills the connection.
    const deadline = createUpstreamDeadline(signal);
    const attemptStartedAt = Date.now();
    try {
      const completion = await withModelUsageSurface("coach.label_scan", () => openai.chat.completions.create(
        {
          model: modelFor("coach.label_scan"),
          // Reasoning models spend part of this budget internally before
          // emitting text; smaller caps come back empty.
          max_completion_tokens: 8192,
          response_format: { type: "json_object" },
          messages,
        },
        { signal: deadline.signal },
      ));
      onUsage?.(completion.usage);
      return completion.choices[0]?.message?.content ?? "";
    } catch (error) {
      // A deadline expiry already consumed the full idle budget; a transient
      // retry would stack another silent wait on top of it, so surface the
      // named timeout immediately instead of burning the retry.
      if (deadline.expired) {
        throw new UpstreamTimeoutError("label photo model call", deadline.idleMs, { cause: error });
      }
      lastError = error;
      if (signal.aborted || attempt >= TRANSIENT_RETRY_LIMIT) throw error;
      log.warn(
        { err: error, attempt, elapsedMs: Date.now() - attemptStartedAt },
        "label photo model call failed; retrying once",
      );
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
      if (signal.aborted) throw error;
    } finally {
      deadline.finish();
    }
  }
  throw lastError;
}

// ─── Interpretation ──────────────────────────────────────────────────────────

/** Coach-surface cleaning: emoji strip + trim, then the no-dash voice rule. */
function cleanCoachText(text: string): string {
  return stripDashes(cleanModelText(text)).trim();
}

/** Calories and grams round to one decimal (labels print halves), mg to whole. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * True when the printed calories disagree wildly with the 4/4/9 macro math.
 * Labels legitimately drift from the formula (fiber handling, rounding), so
 * only a large relative gap with a real absolute floor counts: over 40% off
 * AND at least 40 calories apart. Deterministic — no model judgment.
 */
export function caloriesDisagreeWithMacros(facts: {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}): boolean {
  const computed = facts.protein * 4 + facts.carbs * 4 + facts.fat * 9;
  const deviation = Math.abs(facts.calories - computed);
  return deviation > Math.max(40, 0.4 * Math.max(computed, facts.calories));
}

interface CleanFacts {
  servingSize: string;
  servingsPerContainer: number | null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
  sugar?: number;
  sodium?: number;
}

type Interpretation =
  | { ok: true; outcome: "not_label" | "unreadable"; message: string; facts: null }
  | { ok: true; outcome: "ok"; message: string; facts: CleanFacts }
  | { ok: false; problems: string[] };

function interpret(raw: string): Interpretation {
  const json = extractModelJson(raw);
  if (json === null) {
    return { ok: false, problems: ["the response was not a valid JSON object"] };
  }
  const parsed = ModelOutputSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "output"}: ${issue.message}`,
      ),
    };
  }
  const data = parsed.data;
  const message = cleanCoachText(data.message);
  if (!message) {
    return { ok: false, problems: ["message: must not be empty after cleaning"] };
  }

  if (data.result !== "ok") {
    return { ok: true, outcome: data.result, message, facts: null };
  }
  if (data.label === null || data.label === undefined) {
    return {
      ok: false,
      problems: [
        'result was "ok" but "label" was null — fill in the printed values, or use "not_label" / "unreadable"',
      ],
    };
  }
  const servingSize = cleanCoachText(data.label.servingSize).slice(0, 50);
  if (!servingSize) {
    return { ok: false, problems: ["label.servingSize: must not be empty after cleaning"] };
  }
  return {
    ok: true,
    outcome: "ok",
    message,
    facts: {
      servingSize,
      servingsPerContainer:
        data.label.servingsPerContainer === null || data.label.servingsPerContainer === undefined
          ? null
          : round1(data.label.servingsPerContainer),
      calories: Math.round(data.label.calories),
      protein: round1(data.label.protein),
      carbs: round1(data.label.carbs),
      fat: round1(data.label.fat),
      ...(data.label.fiber === null || data.label.fiber === undefined
        ? {}
        : { fiber: round1(data.label.fiber) }),
      ...(data.label.sugar === null || data.label.sugar === undefined
        ? {}
        : { sugar: round1(data.label.sugar) }),
      ...(data.label.sodium === null || data.label.sodium === undefined
        ? {}
        : { sodium: Math.round(data.label.sodium) }),
    },
  };
}

// ─── Draft assembly ──────────────────────────────────────────────────────────

let labelSeq = 0;

function toLabelDraft(facts: CleanFacts, slot: MealSlotContext): LabelDraft {
  labelSeq += 1;
  return {
    id: `label_${Date.now().toString(36)}_${labelSeq}`,
    ...facts,
    // Slot resolution is fully deterministic here: an explicit client pin
    // wins, then the patient's clock. A label photo shows a package, not an
    // eating occasion, so the model gets no say at all; without a clock
    // (old clients) a packaged food files under snacks.
    suggestedSlot: slot.explicit ?? slot.timeDefault ?? "snacks",
    ...(caloriesDisagreeWithMacros(facts) ? { flagged: true } : {}),
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function generateLabelPhotoAnalysis(args: {
  /** Validated image data URI (jpeg/png/webp). Kept in memory only. */
  image: string;
  patient: PatientContext;
  /**
   * Meal-slot context from the request (explicit client pin and/or the
   * default derived from the patient's local time). Decides the draft's
   * suggested diary slot; absent on old clients — snacks then.
   */
  slot?: MealSlotContext;
  /** Per-call token usage sink (the route's photo usage log). */
  onUsage?: UsageRecorder;
  signal: AbortSignal;
  log: MinimalLog;
}): Promise<LabelPhotoAnalysis> {
  const slot = args.slot ?? {};
  const systemPrompt = buildSystemPrompt(args.patient);

  let previous: { raw: string; problems: string } | null = null;
  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    const messages = buildMessages(systemPrompt, args.image, previous);
    const raw = await callModel(messages, args.signal, args.log, args.onUsage);
    const outcome = interpret(raw);
    if (outcome.ok) {
      return {
        outcome: outcome.outcome,
        message: outcome.message,
        draft: outcome.outcome === "ok" ? toLabelDraft(outcome.facts, slot) : null,
      };
    }
    args.log.warn(
      { attempt, problems: outcome.problems },
      "label photo output failed validation",
    );
    previous = { raw, problems: outcome.problems.join("; ") };
  }
  throw new LabelPhotoModelError("label photo output stayed invalid after corrective retry");
}
