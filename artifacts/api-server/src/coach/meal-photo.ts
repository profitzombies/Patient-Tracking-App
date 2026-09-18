/**
 * Meal photo analysis — "log what's on my plate" for a patient mid-meal.
 *
 * The route hands one photo over as a data URI; the vision model identifies
 * the foods it can actually SEE and answers with a single JSON object: a
 * short coach-voiced message plus the visible items, each with a committed
 * best-guess portion (never "can't tell") and that portion's estimated
 * nutrition. The result is shaped like the AI recipe pipeline's output — one
 * serving, per-ingredient nutrition — so the existing card, breakdown
 * editor, diary logging, and save-as-recipe paths are reused unchanged.
 *
 * Two rules the prompt AND the validator enforce:
 * - Visible items only: no assumed butter, cooking oil, marinades, or hidden
 *   ingredients, and no decomposing a dish beyond what the photo shows.
 * - Always estimate: every item must carry a positive amount. A zero amount
 *   fails validation and triggers the corrective retry, so "I can't
 *   determine the portion" can never reach the patient.
 *
 * Follows the menu scan's JSON-validation-with-corrective-retry pattern:
 * invalid output gets one corrective retry, then the caller reports an
 * honest failure instead of inventing a meal. The photo lives only in this
 * request's memory; it is never logged, written to disk, or stored.
 */

import { z } from "zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { catalogPromptLines, verifiedApprovedCitation } from "./approved-catalog";
import { cleanModelText, extractModelJson } from "./model-json";
import { stripDashes, toTitleCase } from "./text-style";
import { patientContextLine, type PatientContext } from "./prompt";
import {
  normalizeIngredientNutrition,
  type GeneratedRecipe,
  type RecipeCardPayload,
} from "./recipe";
import { MEAL_SLOTS, type MealSlotContext } from "./meal-slot";
import { UpstreamTimeoutError, createUpstreamDeadline } from "./upstream";
import type { UsageRecorder } from "./usage";
import { withModelUsageSurface } from "@workspace/integrations-openai-ai-server/usage";
import { DEFAULT_MODELS, modelFor } from "../ai/models";

/**
 * Mid-tier by the user's explicit cost decision: the nano tier misread real
 * plates (merged dishes, split one roast into two meats, invented sides),
 * while the affordable tier of the newest fleet read the same probe photos
 * with everyday names in a fraction of the time (~3-8s vs 16-30s) at well
 * under half a cent per photo. Do NOT move this to a top-tier model
 * (gpt-5.6-terra / gpt-5.6-sol) without the user's sign-off.
 */
export const MEAL_PHOTO_MODEL = DEFAULT_MODELS["coach.meal_photo"];

/**
 * The gpt-5.6 fleet's reasoning-effort vocabulary on this gateway
 * ("minimal" is rejected as unsupported). Production plate reads never send
 * any of these — the read runs at the model's DEFAULT effort, which is the
 * accuracy bar. Only the side-by-side harness (scripts/meal-read-harness)
 * pins explicit values, to compare candidate latency knobs against that
 * default on this exact code path.
 */
export type MealReadReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

/** One corrective retry when the model's JSON fails validation. */
const RETRY_LIMIT = 1;

/** One extra attempt per model call for transient upstream failures. */
const TRANSIENT_RETRY_LIMIT = 1;
const TRANSIENT_RETRY_DELAY_MS = 400;

// ─── Output contract ─────────────────────────────────────────────────────────

/** Canonical slot list — shared with the meal-slot module that owns it. */
const MEALS = MEAL_SLOTS;

const ItemNutritionSchema = z.object({
  calories: z.number().min(0).max(4000),
  protein: z.number().min(0).max(500),
  carbs: z.number().min(0).max(500),
  fat: z.number().min(0).max(500),
});

const MealItemSchema = z.object({
  name: z.string().min(1).max(80),
  // min(0) so a zero amount parses — the interpreter then reports it as an
  // always-estimate violation with a targeted corrective message instead of
  // a generic zod issue.
  amount: z.number().min(0).max(1000),
  unit: z.string().max(24),
  nutrition: ItemNutritionSchema,
  /**
   * The Approved Foods catalog id the model cites when the food IS on the
   * THINNR approved list. Judged server-side (see interpret): a bad or
   * missing citation simply means "not approved" — never a retry, and never
   * a change to what gets logged.
   */
  approvedItemId: z.string().max(120).nullish(),
});

const ModelOutputSchema = z.object({
  result: z.enum(["ok", "not_food", "unreadable"]),
  message: z.string().min(1).max(500),
  mealName: z.string().max(80).nullish(),
  description: z.string().max(240).nullish(),
  meal: z.enum(MEALS).nullish(),
  items: z.array(MealItemSchema).max(12).default([]),
});

export type MealPhotoOutcome = "ok" | "not_food" | "unreadable";

export interface MealPhotoAnalysis {
  outcome: MealPhotoOutcome;
  /** Coach-voiced reaction (ok) or warm nudge (not_food / unreadable). */
  message: string;
  /** Editable one-serving meal card — present only when outcome is "ok". */
  payload: RecipeCardPayload | null;
  /**
   * Display names of visible items that did NOT verify against the Approved
   * Foods catalog (uncited, unknown id, or a name the citation cannot back).
   * Empty means the whole plate is on the list. A chat-only coaching signal:
   * it shapes the reply's callout and makeover offer, and deliberately never
   * rides the card payload — the diary stays judgment-free.
   */
  offPlanItems: string[];
}

/** The model kept returning invalid output; the route answers with an error. */
export class MealPhotoModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MealPhotoModelError";
  }
}

interface MinimalLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

/**
 * Appended to the system prompt on a typed-correction turn: the patient
 * already saw a misread of this same photo and typed what the plate really
 * is. Their words decide WHAT the foods are; the photo still sizes them.
 */
function correctionRule(correction: string | undefined): string {
  if (!correction) return "";
  return `

The patient already sent this same photo once and the earlier read named the foods wrong. Their latest message tells you what the food really is. Treat their naming as ground truth for WHAT the foods are, even when the photo alone would read differently, and use their everyday words. Anything clearly visible that they did not rename still gets listed as you see it. Portions and nutrition still come from the photo, unless their message states an amount. In "message", own the fix in one short natural clause, no over-apologizing, then react to the real meal.`;
}

function buildSystemPrompt(
  patient: PatientContext,
  slot: MealSlotContext,
  correction?: string,
): string {
  return `You are the THINNR meal logger, an AI helper inside the THINNR patient app. The patient photographed food they are about to eat — a plate, bowl, container, or packaged item — so the app can log it to their food diary. Identify what is visible and commit to portion estimates.

Respond with a single JSON object and nothing else — no markdown, no code fences:
{
  "result": "ok" | "not_food" | "unreadable",
  "message": string,
  "mealName": string or null,
  "description": string or null,
  "meal": "breakfast" | "lunch" | "dinner" | "snacks" or null,
  "items": [ { "name": string, "amount": number, "unit": string, "nutrition": { "calories": number, "protein": number, "carbs": number, "fat": number }, "approvedItemId": string (only when that food is on the approved list) } ]
}

Reading the photo:
- "not_food": there is no food or drink to log in the photo. In "message", say warmly and without any blame what the photo shows instead — keep it light, like a friend noticing — and leave "items" empty.
- "unreadable": it does look like food, but the photo is too dark, blurry, or cropped to tell what the foods are. Say so in "message" the way a coach would — no fault, just a quick suggestion to retake it closer or with more light — and leave "items" empty.
- "ok": you can see the food. Fill in every field.

Listing items (when "result" is "ok"):
- List ONLY food and drink you can actually SEE in the photo — at most 12 items.
- Never add ingredients you cannot see. No assumed butter, cooking oil, marinade, dressing, sugar, or seasoning — include one only when it is visibly present in the photo (a pat of butter, a pool of dressing, a sauce cup).
- Keep each item at the level a person would say it: "grilled chicken breast", "roasted sweet potatoes", "side salad". Never split a visible dish into its parts — a turkey sandwich is one item, not bread plus turkey plus lettuce.
- Default to everyday home-cooked names, the way a home cook would say them: "sliced steak", "roasted sweet potato wedges", "green beans". Never name a specialty restaurant dish unless packaging or an unmistakable presentation proves it.
- Separate the plate the way the patient would log it: the protein is one item and each vegetable or side is its own item. Never fold a side into the protein's name and never merge distinct foods into one dish.
- One visible protein is ONE item — never list the same piece of meat as two different meats. Torn between two reads of the same meat, pick the more common home-cooked one and keep it as a single item.
- When you are genuinely unsure what a food is, use the plain generic name, like "steak" or "roast beef", and let "message" admit the uncertainty in one short natural clause. Never dress uncertainty up as a specialty dish.
- ALWAYS commit to one specific portion per item. "amount" must be a positive number — never zero, never a range, never a guess refusal. Size it from the photo's cues (plate diameter, cutlery, hands, packaging). A committed estimate the patient can nudge up or down beats no estimate every single time.
- "unit": a familiar kitchen measure — "oz" for proteins and cheese, "cup", "tbsp", or "tsp" for sides, grains, and sauces, or "" (empty string) with a count for whole pieces (2 eggs → amount 2, unit ""). Prefer exactly these units.
- "nutrition": your calorie/protein/carbs/fat estimate for THAT item at YOUR estimated amount. The app sums the items into the meal's totals and labels everything as an estimate.
- "mealName": a short natural name for the whole meal, like "Grilled chicken with sweet potato" — at most 60 characters.
- "description": one plain sentence describing what is on the plate.
${mealSlotRule(slot)}

Judging items against the THINNR approved list (when "result" is "ok"):
- The APPROVED FOODS CATALOG below is the THINNR program's Approved Foods list. For each item, decide whether that food IS one of the catalog entries. When it is, add "approvedItemId" with that entry's id copied exactly from the catalog. When it is not on the list, or you are not sure which entry it is, leave "approvedItemId" out entirely — never guess or force an id.
- An item's "name" may add plain preparation words around its entry's name ("grilled chicken breast" citing the entry named "Skinless White Meat Chicken Breast"), but the food itself must BE the cited entry. Never cite an entry for a different food, even a similar one — a regular flour tortilla is not the catalog's named tortilla brand unless visible packaging proves that exact brand.
- This judgment never changes what you list, the portions, or the nutrition — the plate is read exactly as photographed either way.

APPROVED FOODS CATALOG (id — official name):
${catalogPromptLines()}

"message" is 1-2 short sentences in the patient's coach's own texting voice — react like you really just looked at their plate, specific and warm, contractions and plain words, never gushing. Plain text, never emojis, and never an em dash or en dash; punctuate with commas and periods. Never say you cannot determine the portions and never ask the patient to weigh or measure anything — your best estimates are already in "items" and the patient can adjust them.

${patientContextLine(patient)}${correctionRule(correction)}`;
}

/**
 * The "meal" line of the JSON contract. An explicit client pin or the
 * patient's clock decides the slot ahead of the model — a photo turn is an
 * image-only call, so the patient cannot name a meal here and the model's
 * answer is only a visual guess (interpret() enforces the same order, so a
 * disobedient model cannot leak through). Only old clients, which send no
 * local time, leave the slot to that guess.
 */
function mealSlotRule(slot: MealSlotContext): string {
  if (slot.explicit) {
    return `- "meal": answer exactly "${slot.explicit}" — the patient opened this log from their ${slot.explicit} slot, so that choice is already made.`;
  }
  if (slot.timeDefault) {
    return `- "meal": answer exactly "${slot.timeDefault}" — the patient's clock reads ${slot.localTime}, so a plate photographed now files under ${slot.timeDefault}. They can switch the slot by hand before logging.`;
  }
  return `- "meal": the diary slot this most looks like.`;
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
  correction?: string,
): AnalysisMessage[] {
  // On a correction turn the patient's own words ride inside the user text —
  // the model reads them as the truth about what the foods are, while the
  // photo (the same one, re-attached by the client) still sizes the portions.
  const intro = correction
    ? `I sent this same photo before and the foods were identified wrong. What the plate really is, in my words: "${correction}". Redo the read with my words as the truth about what the foods are, keep estimating the portions from the photo, and reply with the single JSON object.`
    : "Here is the photo of my meal. Identify the visible foods, commit to portion estimates, and reply with the single JSON object.";
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

interface CallOptions {
  /** Per-call token usage sink (the route's photo usage log). */
  onUsage?: UsageRecorder;
  /** Harness-only effort pin — see generateMealPhotoAnalysis. */
  reasoningEffort?: MealReadReasoningEffort;
}

async function callModel(
  messages: AnalysisMessage[],
  signal: AbortSignal,
  log: MinimalLog,
  options: CallOptions,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_LIMIT; attempt++) {
    // Idle deadline per attempt: a wedged vision upstream must become a
    // prompt, explainable failure, not a request that hangs until a proxy
    // kills the connection.
    const deadline = createUpstreamDeadline(signal);
    const attemptStartedAt = Date.now();
    try {
      const completion = await withModelUsageSurface("coach.meal_photo", () => openai.chat.completions.create(
        {
          model: modelFor("coach.meal_photo"),
          // Reasoning models spend part of this budget internally before
          // emitting text; smaller caps come back empty.
          max_completion_tokens: 8192,
          // DEFAULT reasoning effort on purpose — the pre-speed-up accuracy
          // bar. A latency pass (2026-08) set reasoning_effort: "none" here
          // after one clean single-plate probe, and real-world reads
          // degraded; restoring the default is the fix. The speed-ups that
          // survived (speculative parallel start, staged progress, stage
          // timing + usage logs) never touch this call's quality. Any
          // future effort experiment must pass the multi-plate side-by-side
          // gate in scripts/meal-read-harness before it ships — never a
          // one-photo probe. The spread below is that harness's pin;
          // nothing request-reachable sets it, so production omits the
          // knob entirely.
          ...(options.reasoningEffort !== undefined
            ? { reasoning_effort: options.reasoningEffort }
            : {}),
          response_format: { type: "json_object" },
          messages,
        },
        { signal: deadline.signal },
      ));
      options.onUsage?.(completion.usage);
      return completion.choices[0]?.message?.content ?? "";
    } catch (error) {
      // A deadline expiry already consumed the full idle budget; a transient
      // retry would stack another silent wait on top of it, so surface the
      // named timeout immediately instead of burning the retry.
      if (deadline.expired) {
        throw new UpstreamTimeoutError("meal photo model call", deadline.idleMs, { cause: error });
      }
      lastError = error;
      if (signal.aborted || attempt >= TRANSIENT_RETRY_LIMIT) throw error;
      log.warn(
        { err: error, attempt, elapsedMs: Date.now() - attemptStartedAt },
        "meal photo model call failed; retrying once",
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

interface CleanItem {
  name: string;
  amount: number;
  unit: string;
  nutrition: { calories: number; protein: number; carbs: number; fat: number };
  /**
   * Verified against the Approved Foods catalog: true only when the model
   * cited a real catalog id AND the item's name provably reads as that
   * entry. Uncited or unverifiable items are simply "not approved" — a
   * coaching signal for the reply, never a validation problem (no retry) and
   * never part of the card payload.
   */
  approved: boolean;
}

type Interpretation =
  | { ok: true; outcome: MealPhotoOutcome; message: string; items: CleanItem[]; mealName: string; description: string; meal: (typeof MEALS)[number] }
  | { ok: false; problems: string[] };

/** Coach-surface cleaning: emoji strip + trim, then the no-dash voice rule. */
function cleanCoachText(text: string): string {
  return stripDashes(cleanModelText(text)).trim();
}

function interpret(raw: string, slot: MealSlotContext): Interpretation {
  const json = extractModelJson(raw);
  if (json === null) {
    return { ok: false, problems: ["the response was not a valid JSON object"] };
  }
  const parsed = ModelOutputSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`);
    return { ok: false, problems };
  }

  const data = parsed.data;
  const message = cleanCoachText(data.message);
  if (!message) {
    return { ok: false, problems: ["message was empty"] };
  }

  if (data.result !== "ok") {
    // Non-food / unreadable photos never carry items; coercing (rather than
    // retrying) is the correct reading of that answer. No card is built from
    // this shape, so the meal field just takes the resolved default.
    return {
      ok: true,
      outcome: data.result,
      message,
      items: [],
      mealName: "",
      description: "",
      meal: slot.explicit ?? slot.timeDefault ?? "lunch",
    };
  }

  const problems: string[] = [];
  const items: CleanItem[] = [];
  data.items.forEach((item, index) => {
    const name = cleanCoachText(item.name);
    if (!name) return; // an unnameable row carries no signal — drop it
    // The always-estimate rule is enforced here, not just prompted: a zero
    // amount would render an uneditable row and an "I couldn't tell" meal.
    if (item.amount <= 0) {
      problems.push(
        `items.${index}.amount: must be a positive number — commit to your single best portion estimate for "${name}"`,
      );
      return;
    }
    items.push({
      name,
      amount: item.amount,
      unit: cleanCoachText(item.unit),
      nutrition: item.nutrition,
      approved: verifiedApprovedCitation(name, item.approvedItemId ?? undefined),
    });
  });

  if (problems.length > 0) return { ok: false, problems };
  if (items.length === 0) {
    return {
      ok: false,
      problems: [
        'result was "ok" but items was empty — list the foods you can see, or use "not_food" / "unreadable"',
      ],
    };
  }

  const fallbackName =
    items.length === 1
      ? capitalize(items[0].name)
      : `${capitalize(items[0].name)} with ${items[1].name}`;
  const mealName = cleanCoachText(data.mealName ?? "") || fallbackName;
  const description =
    cleanCoachText(data.description ?? "") ||
    "What I can see on your plate, sized with my best estimates.";

  return {
    ok: true,
    outcome: "ok",
    message,
    items,
    mealName: mealName.slice(0, 80),
    description: description.slice(0, 240),
    // Slot resolution: an explicit client pin wins (the entry point already
    // knew which meal it was logging). Next the clock: this is an image-only
    // model call — the patient has no way to name a meal on a photo turn —
    // so the model's slot answer is only a visual guess, and a known local
    // time deterministically outranks it (a steak plate at 14:05 still
    // files under lunch). Old clients fall back to that guess, then lunch.
    meal: slot.explicit ?? slot.timeDefault ?? data.meal ?? "lunch",
  };
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

// ─── Payload assembly ────────────────────────────────────────────────────────

let mealSeq = 0;

/**
 * Shapes the analysis as the one-serving recipe card the client already
 * knows how to render, edit, log, and save. Totals are the exact sums of the
 * item estimates, and normalizeIngredientNutrition re-slices the integer
 * per-item values so they add up to the rounded totals on the card — the
 * breakdown editor's math then works from a consistent baseline.
 */
function toMealPayload(
  items: CleanItem[],
  mealName: string,
  description: string,
  meal: (typeof MEALS)[number],
): RecipeCardPayload {
  mealSeq += 1;
  const total = (key: "calories" | "protein" | "carbs" | "fat") =>
    Math.round(items.reduce((sum, item) => sum + item.nutrition[key], 0));
  const shaped: GeneratedRecipe = {
    name: mealName,
    description,
    meal,
    minutes: 1, // placeholder — meal cards render no time chip
    servings: 1,
    calories: total("calories"),
    protein: total("protein"),
    carbs: total("carbs"),
    fat: total("fat"),
    ingredients: items.map((item) => ({
      amount: item.amount,
      unit: item.unit,
      // Detected food names take the same Title Case as the meal name
      // below, right where the payload is shaped — the chat's per-food
      // lines, the card, the breakdown screen, and both save paths all
      // read from here. Brand-style inner caps ("PB&J") survive untouched.
      name: toTitleCase(item.name),
      nutrition: item.nutrition,
    })),
    steps: [],
  };
  const normalized = normalizeIngredientNutrition(shaped);
  return {
    id: `meal_${Date.now().toString(36)}_${mealSeq}`,
    mode: "meal",
    // Created names are Title Case everywhere (chat label foods, the
    // create-food screen, recipe cards) — meal cards included.
    name: toTitleCase(shaped.name),
    description: shaped.description,
    meal: shaped.meal,
    minutes: 0,
    servings: 1,
    calories: shaped.calories,
    protein: shaped.protein,
    carbs: shaped.carbs,
    fat: shaped.fat,
    ingredients: normalized.ingredients,
    steps: [],
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function generateMealPhotoAnalysis(args: {
  /** Validated image data URI (jpeg/png/webp). Kept in memory only. */
  image: string;
  patient: PatientContext;
  /**
   * Meal-slot context from the request (explicit client pin and/or the
   * default derived from the patient's local time). Shapes the prompt's
   * "meal" line and the fallbacks; absent on old clients — legacy behavior.
   */
  slot?: MealSlotContext;
  /**
   * The patient's typed fix for a misread plate ("no, that's steak and sweet
   * potatoes"), sent with the SAME re-attached photo. Their naming is ground
   * truth for what the foods are; portions are still estimated from the
   * photo (unless their words state an amount).
   */
  correction?: string;
  /**
   * Per-call token usage sink. The route binds this to its photo usage log
   * so the turn's completion line carries prompt/completion/reasoning
   * counts for every model call this analysis makes (corrective and
   * transient retries included).
   */
  onUsage?: UsageRecorder;
  /**
   * HARNESS-ONLY (scripts/meal-read-harness): pins an explicit reasoning
   * effort so the side-by-side gate can compare candidate latency knobs
   * against the shipped default on this exact code path. Production plate
   * reads run at the model's DEFAULT effort — the accuracy bar restored
   * after the "none" regression — and no request-reachable caller passes
   * this. Do not wire it to anything a client can influence.
   */
  experimentReasoningEffort?: MealReadReasoningEffort;
  signal: AbortSignal;
  log: MinimalLog;
}): Promise<MealPhotoAnalysis> {
  const slot = args.slot ?? {};
  const systemPrompt = buildSystemPrompt(args.patient, slot, args.correction);

  let previous: { raw: string; problems: string } | null = null;
  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    // A cancelled read stays cancelled: the route abandons a speculative
    // read when triage picks another pipeline, and the corrective retry
    // must not fire a fresh upstream call after that. (callModel itself
    // would reject on the dead signal, but only after building and sending
    // the request — and test mocks would count it.)
    if (args.signal.aborted) {
      throw new Error("meal photo analysis cancelled");
    }
    const messages = buildMessages(systemPrompt, args.image, previous, args.correction);
    const raw = await callModel(messages, args.signal, args.log, {
      onUsage: args.onUsage,
      reasoningEffort: args.experimentReasoningEffort,
    });
    const outcome = interpret(raw, slot);
    if (outcome.ok) {
      return {
        outcome: outcome.outcome,
        message: outcome.message,
        payload:
          outcome.outcome === "ok"
            ? toMealPayload(outcome.items, outcome.mealName, outcome.description, outcome.meal)
            : null,
        offPlanItems:
          outcome.outcome === "ok"
            ? outcome.items.filter((item) => !item.approved).map((item) => item.name)
            : [],
      };
    }
    args.log.warn(
      { attempt, problems: outcome.problems },
      "meal photo output failed validation",
    );
    previous = { raw, problems: outcome.problems.join("; ") };
  }
  throw new MealPhotoModelError("meal photo output stayed invalid after corrective retry");
}
