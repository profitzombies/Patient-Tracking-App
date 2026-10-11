/**
 * Structured recipe / cravings-fix generation for the coach chat.
 *
 * When a turn asks for meal ideas (or mentions a craving) the route calls
 * `generateRecipeTurn()` instead of the plain streaming completion. The model
 * must answer with a single JSON object: a short text reply plus an optional
 * structured recipe. Cravings mode is stricter — every ingredient must carry
 * an `approvedItemId` from the Approved Foods catalog, validated server-side
 * with one corrective retry. If the model still cannot comply, the coach
 * declines honestly instead of inventing items.
 *
 * The validation boundary is deterministic, no extra AI: every cited id must
 * exist in the catalog AND the ingredient's display name must provably read
 * as that catalog item (catalog words plus non-food preparation words only),
 * so a valid id cannot smuggle in an off-list food name. Grocery lines for
 * cravings are derived server-side from the official catalog names.
 */
import { z } from "zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { COMPARTMENTS, type Compartment } from "./compartments";
import { cleanModelText, extractModelJson } from "./model-json";
import { stripDashes, toTitleCase } from "./text-style";
import {
  COACH_PERSONA_LINE,
  COACH_VOICE_RULES,
  patientContextLine,
  sourcesBlock,
  type PatientContext,
} from "./prompt";
import { UpstreamTimeoutError, createUpstreamDeadline } from "./upstream";
import {
  approvedItemName,
  catalogPromptLines,
  ingredientNameMatchesItem,
  isApprovedItemId,
} from "./approved-catalog";
import { MEAL_SLOTS, type MealSlotContext } from "./meal-slot";
import { recipeDietProblems } from "./diet-guard";
import type { DietGrounding } from "./diet-grounding";
import { withModelUsageSurface } from "@workspace/integrations-openai-ai-server/usage";
import { modelFor } from "../ai/models";

export type RecipeMode = "recipe" | "cravings";

/** Canonical slot list — shared with the meal-slot module that owns it. */
const MEALS = MEAL_SLOTS;

const IngredientNutritionSchema = z.object({
  calories: z.number().min(0).max(4000),
  protein: z.number().min(0).max(500),
  carbs: z.number().min(0).max(500),
  fat: z.number().min(0).max(500),
});

const IngredientSchema = z.object({
  amount: z.number().min(0).max(1000),
  unit: z.string().max(24),
  name: z.string().min(1).max(80),
  approvedItemId: z.string().max(120).optional(),
  /** Contribution to ONE serving — required from the model, checked below. */
  nutrition: IngredientNutritionSchema,
});

const GeneratedRecipeSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(220),
  meal: z.enum(MEALS),
  minutes: z.number().min(1).max(240),
  servings: z.number().min(1).max(8),
  calories: z.number().min(0).max(2500),
  protein: z.number().min(0).max(300),
  carbs: z.number().min(0).max(300),
  fat: z.number().min(0).max(300),
  ingredients: z.array(IngredientSchema).min(1).max(20),
  steps: z.array(z.string().min(1).max(400)).min(1).max(12),
  groceryList: z.array(z.string().min(1).max(120)).max(30).optional(),
});

const ModelOutputSchema = z.object({
  reply: z.string().min(1).max(800),
  recipe: GeneratedRecipeSchema.nullable(),
});

/**
 * Exported for the meal-photo pipeline, which builds a recipe-shaped result
 * (one serving, per-ingredient nutrition) so normalizeIngredientNutrition and
 * the whole downstream card/editor path can be reused unchanged.
 */
export type GeneratedRecipe = z.infer<typeof GeneratedRecipeSchema>;

/**
 * Card modes: model-generated "recipe"/"cravings", plus "meal" for the
 * photo-logging pipeline (a photographed plate rendered as an editable
 * one-serving meal — steps are empty and minutes meaningless there).
 */
export type RecipeCardMode = RecipeMode | "meal";

/** Payload shape the mobile app renders as a chat card and preview screen. */
export interface RecipeCardPayload {
  id: string;
  mode: RecipeCardMode;
  name: string;
  description: string;
  meal: (typeof MEALS)[number];
  minutes: number;
  servings: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  ingredients: {
    amount: number;
    unit: string;
    name: string;
    approvedItemId?: string;
    /** Per-ingredient contribution to ONE serving; sums match the totals above. */
    nutrition: { calories: number; protein: number; carbs: number; fat: number };
  }[];
  steps: string[];
  groceryList?: string[];
}

export interface RecipeTurnResult {
  reply: string;
  card: { kind: "recipe"; payload: RecipeCardPayload } | null;
}

interface MinimalLog {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface RecipeTurnArgs {
  mode: RecipeMode;
  /**
   * Set on follow-up turns that seed the recipe from earlier conversation:
   * - "menu": the patient reviewed restaurant-menu suggestions (in `history`)
   *   and said yes to a custom recipe inspired by them. Swaps the task
   *   wording and grounds the turn in the approved-foods list.
   * - "meal-makeover": the patient photographed a meal with off-list items,
   *   heard the approved swaps, and chose the THINNR-approved version. Swaps
   *   the task wording AND enforces the cravings-strength approved-only
   *   ingredient contract (every ingredient must cite a catalog id).
   * Recipe mode only.
   */
  inspiration?: "menu" | "meal-makeover";
  history: { role: "user" | "assistant"; content: string }[];
  compartments: Compartment[];
  patient: PatientContext;
  /** Server-recalled, bounded patient context. Never client-supplied. */
  coachingContext?: string;
  /**
   * Meal-slot context for the card. An explicit client pin wins outright
   * (overriding even the model's answer); otherwise the prompt tells the
   * model to honor a meal the patient names, with the time-derived default
   * as the fallback when the client sent its local time. Cravings keep
   * their snacks default regardless of the clock. Absent on old clients —
   * legacy behavior.
   */
  slot?: MealSlotContext;
  signal: AbortSignal;
  log: MinimalLog;
}

/** Cravings replies must ground in the official list; force its compartment in. */
export function ensureApprovedFoodsCompartment(selected: Compartment[]): Compartment[] {
  if (selected.some((c) => c.id === "approved-foods")) return selected;
  const approved = COMPARTMENTS.find((c) => c.id === "approved-foods");
  return approved ? [...selected, approved] : selected;
}

/**
 * Honest declines when the model cannot produce a valid suggestion. Fixed
 * strings — never model text — but written in the same warm coach voice as
 * generated replies, shaped as two blank-line blocks like any other reply.
 * Deliberately no trailing question mark: the client shows its fallback
 * yes/no chips under any finished reply that ends with one, and they fit
 * nothing here.
 */
const DECLINE_REPLY: Record<RecipeMode, string> = {
  recipe:
    "That one didn't come together the way I'd want for you, and I'd rather tell you that than guess.\n\nGive me another try in a moment — a fresh run usually does it.",
  cravings:
    "I tried to build that fix straight from the Approved Foods list and couldn't quite get there — and I won't improvise around the program.\n\nTry me again in a moment, or toss me a different craving to work with.",
};

/**
 * Decline for the meal-makeover version specifically: it must point back at
 * the original meal card (logging as photographed was always allowed), not
 * at "a different craving".
 */
const MAKEOVER_DECLINE_REPLY =
  "I tried to rebuild that plate straight from the Approved Foods list and couldn't quite get there, and I won't improvise around the program.\n\nYour meal card above still logs it exactly as photographed, or give me another try in a moment.";
const RECIPE_JSON_CONTRACT = `Respond with a single JSON object and nothing else — no markdown, no code fences:
{
  "reply": string,
  "recipe": object or null
}
"reply" is your short text-message answer, in the same warm voice as the rest of the chat: react to what the patient said first — a quick, natural beat in your own words — then point at the dish in a sentence. The details live in the recipe object, not the reply, so keep it to a few short sentences total. Split it into 2 short blocks separated by a blank line (write \\n\\n inside the JSON string), and make the second block a brief, natural follow-up question or practical tip — skip it only when the patient is clearly wrapping up. Plain text, never emojis, no markdown.
"recipe" fields (all required unless noted):
- "name": short dish name
- "description": one appetizing sentence
- "meal": "breakfast" | "lunch" | "dinner" | "snacks"
- "minutes": total time as a number
- "servings": how many servings the recipe makes
- "calories", "protein", "carbs", "fat": estimated numbers PER SERVING (grams for macros); keep them realistic for the portions
- "ingredients": array of { "amount": number, "unit": string, "name": string, "nutrition": object } — use amount 0 for "to taste", unit "" when countable. "nutrition" is required on EVERY ingredient: { "calories": number, "protein": number, "carbs": number, "fat": number }, that ingredient's contribution to ONE serving at its listed amount (zeros are fine for water, plain seasonings, or "to taste" rows). Across all ingredients these must add up to the per-serving "calories", "protein", "carbs", "fat" above — the server checks the sums.
- "steps": array of short instruction strings in cooking order`;

/**
 * The approved-only ingredient contract, shared verbatim by cravings mode
 * and the meal-makeover inspiration. interpret() enforces it
 * deterministically whenever `approvedOnly` is set for the turn.
 */
const STRICT_APPROVED_INGREDIENT_RULES = `- Every ingredient must be an item from the APPROVED FOODS CATALOG below. Each ingredient object MUST also include "approvedItemId" copied exactly from the catalog.
- Do not use any food that is not in the catalog — no exceptions, not even pantry basics. If it is not in the catalog, leave it out.
- Each ingredient's "name" may add simple preparation words to its catalog item (for example an id whose catalog name is "Skinless White Meat Chicken Breast" may be written "grilled chicken breast"), but every food word in the name must come from the cited catalog item's own name. The server rejects any name containing a food word that is not part of that catalog entry — never name a different food, and never a food the patient craved that is off the list.`;
const RECIPE_STATIC_PREFIX = `${COACH_PERSONA_LINE}

${COACH_VOICE_RULES}

${RECIPE_JSON_CONTRACT}

Grounding rules:
- Keep the suggestion consistent with the THINNR program materials inside the <source> blocks below. When your reply states a program rule, amount, or allowed food, use the source's exact wording for the rule itself.
- If you cannot propose something that fits the program, set "recipe" to null and say so plainly in "reply". Never invent program rules.
- You are informational only, not medical advice. Never suggest changing doses or medications.`;

function buildRecipeSystemPrompt(
  mode: RecipeMode,
  compartments: Compartment[],
  patient: PatientContext,
  inspiration: RecipeTurnArgs["inspiration"],
  slot: MealSlotContext,
): string {
  // Static rules first (byte-stable, cacheable), then the patient line,
  // then this turn's task, catalog and sources.
  const shared = `${RECIPE_STATIC_PREFIX}

${patientContextLine(patient)}`;

  if (mode === "recipe") {
    const task =
      inspiration === "menu"
        ? `Task: the patient just reviewed a restaurant menu with you — your ordering suggestions are earlier in this conversation — and said yes to a custom recipe inspired by it. Propose exactly one home-cooked recipe inspired by that menu, ideally a homemade version of a dish you suggested from it, adapted to fit their current phase. In "reply", connect it naturally to the menu conversation.`
        : inspiration === "meal-makeover"
          ? `Task: earlier in this conversation the patient photographed a meal, the reply named which items are not on the THINNR Approved Foods list, and the approved swaps for them were described. The patient chose the THINNR-approved version. Build exactly one recipe: that same meal made fully approved — keep the items that were already on the list and swap each off-list item the way the swaps described. In "reply", connect it naturally to their photographed meal. Never set "recipe" to null here unless even the swapped version genuinely cannot be built from the catalog.`
          : "Task: the patient asked for a meal or snack idea. Propose exactly one recipe that fits their current phase.";
    const approvedRules =
      inspiration === "meal-makeover"
        ? `

STRICT APPROVED-FOODS RULES:
${STRICT_APPROVED_INGREDIENT_RULES}

APPROVED FOODS CATALOG (id — official name):
${catalogPromptLines()}`
        : "";
    return `${shared}

${task}
${recipeMealRule(slot)}${approvedRules}

THINNR program materials for this question:

${sourcesBlock(compartments)}`;
  }

  return `${shared}

Task: the patient mentioned a craving. Offer one simple approved snack fix for it.

STRICT CRAVINGS RULES:
${STRICT_APPROVED_INGREDIENT_RULES}
${cravingsMealRule(slot)}
- "reply" meets the craving like a person first — acknowledge it specifically and warmly in your own words — then point at the approved swap. If no approved combination genuinely answers the craving, set "recipe" to null and say so straight and kindly, without inventing anything.

APPROVED FOODS CATALOG (id — official name):
${catalogPromptLines()}

THINNR program materials for this question:

${sourcesBlock(compartments)}`;
}

/**
 * Meal-slot instruction for recipe mode. Resolution order: an explicit
 * client pin decides outright; otherwise a meal the patient NAMES wins,
 * falling back to the clock-derived default when the client sent its local
 * time. Old clients (no time) leave the choice to the model.
 */
function recipeMealRule(slot: MealSlotContext): string {
  if (slot.explicit) {
    return `Meal slot: set "meal" to "${slot.explicit}" — the patient is filling that diary slot, so ignore other hints.`;
  }
  if (slot.timeDefault) {
    return `Meal slot: when the patient names a meal for this dish ("for dinner", "a breakfast idea"), set "meal" to that meal. Otherwise set "meal" to "${slot.timeDefault}" — the patient's clock reads ${slot.localTime}, and that is where a dish suggested now gets logged.`;
  }
  return `Meal slot: when the patient names a meal for this dish ("for dinner", "a breakfast idea"), set "meal" to that meal. Otherwise pick the slot the dish naturally fits.`;
}

/**
 * Cravings keep their snacks default on purpose — a craving fix is a snack
 * whatever the clock says — so the time default never applies here. Only an
 * explicit pin (or the patient naming a meal) moves it.
 */
function cravingsMealRule(slot: MealSlotContext): string {
  if (slot.explicit) {
    return `- "meal" must be "${slot.explicit}" — the patient is filling that diary slot.`;
  }
  return `- "meal" is "snacks" unless the patient named a different meal for this fix — a craving is a snack whatever the clock says.`;
}

type Interpretation =
  | { ok: true; reply: string; recipe: GeneratedRecipe | null }
  | { ok: false; problems: string[] };

function interpret(raw: string, approvedOnly: boolean, diet?: DietGrounding): Interpretation {
  const json = extractModelJson(raw);
  if (json === null) return { ok: false, problems: ["response was not valid JSON"] };
  const parsed = ModelOutputSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`);
    return { ok: false, problems };
  }
  const { reply, recipe } = parsed.data;
  if (recipe && approvedOnly) {
    const problems: string[] = [];
    for (const ingredient of recipe.ingredients) {
      if (!ingredient.approvedItemId) {
        problems.push(`ingredient "${ingredient.name}" is missing approvedItemId`);
      } else if (!isApprovedItemId(ingredient.approvedItemId)) {
        problems.push(
          `ingredient "${ingredient.name}" cites approvedItemId "${ingredient.approvedItemId}" which is not in the catalog`,
        );
      } else if (!ingredientNameMatchesItem(ingredient.name, ingredient.approvedItemId)) {
        problems.push(
          `ingredient "${ingredient.name}" does not read as its cited catalog item "${approvedItemName(ingredient.approvedItemId)}" — name it as that catalog item (preparation words are fine) or cite the right id`,
        );
      }
    }
    if (problems.length > 0) return { ok: false, problems };
  }
  if (recipe) {
    const nutritionProblems = ingredientNutritionProblems(recipe);
    if (nutritionProblems.length > 0) return { ok: false, problems: nutritionProblems };
    // Real accounts: the draft must clear the patient's diet and lists
    // (allergies, sensitivities, restrictions, dislikes, kosher / halal
    // pairing) before it can return; a miss sends the model back exactly
    // like a bad citation does.
    if (diet) {
      const dietProblems = recipeDietProblems(recipe, diet);
      if (dietProblems.length > 0) return { ok: false, problems: dietProblems };
    }
  }
  return {
    ok: true,
    reply: stripDashes(cleanModelText(reply)).trim(),
    recipe: recipe ? normalizeIngredientNutrition(cleanRecipeText(recipe)) : null,
  };
}

/**
 * The card's user-facing strings follow the same output rules as the reply:
 * the shared model-text cleaning (THINNR brand spelling, no pictographs)
 * plus the no-dash voice rule. Applied after validation (names were already
 * matched against the catalog) and before normalization; numbers are
 * untouched.
 */
function cleanRecipeText(recipe: GeneratedRecipe): GeneratedRecipe {
  const clean = (text: string): string => stripDashes(cleanModelText(text)).trim();
  return {
    ...recipe,
    name: clean(recipe.name),
    description: clean(recipe.description),
    steps: recipe.steps.map(clean),
    ingredients: recipe.ingredients.map((ingredient) => ({
      ...ingredient,
      name: clean(ingredient.name),
    })),
  };
}

// ── Per-ingredient nutrition: deterministic validation + normalization ──────

const MACROS = [
  { key: "calories", label: "calories", small: 25 },
  { key: "protein", label: "protein", small: 5 },
  { key: "carbs", label: "carbs", small: 5 },
  { key: "fat", label: "fat", small: 5 },
] as const;

/**
 * Checks that per-ingredient nutrition plausibly decomposes the per-serving
 * totals. Tolerant by design (the numbers are estimates): each macro's
 * ingredient sum must land within ±40% of the per-serving total, OR within
 * ±40% of the whole-batch total (servings × per-serving) — a common model
 * slip that normalization rescales away exactly. Tiny targets (≤25 cal / ≤5g)
 * are skipped: rounding noise dwarfs them. Exported for direct unit tests.
 */
export function ingredientNutritionProblems(recipe: GeneratedRecipe): string[] {
  const problems: string[] = [];
  for (const macro of MACROS) {
    const total = recipe[macro.key];
    if (total <= macro.small) continue;
    const sum = recipe.ingredients.reduce((acc, i) => acc + i.nutrition[macro.key], 0);
    const ratio = sum / total;
    const perServingOk = ratio >= 0.6 && ratio <= 1.4;
    const batchOk =
      recipe.servings >= 2 && ratio >= 0.6 * recipe.servings && ratio <= 1.4 * recipe.servings;
    if (!perServingOk && !batchOk) {
      problems.push(
        `ingredient "nutrition" ${macro.label} values sum to ${Math.round(sum * 10) / 10} but the per-serving ${macro.label} is ${total} — "nutrition" must be each ingredient's contribution to ONE serving, and the sums must match the per-serving totals`,
      );
    }
  }
  return problems;
}

/**
 * Weights for splitting one macro's card total across ingredients. Only
 * `eligible` (measurable, amount > 0) rows may carry weight — the breakdown
 * UI cannot edit "to taste" rows, so nutrition parked there could never be
 * adjusted. Preference order: the model's own claims on eligible rows, else
 * their calorie claims (the macro likely rides the caloric ingredients),
 * else an even split across them. Guarantees a positive weight sum whenever
 * any row is eligible, so every positive card total gets allocated — even
 * the tiny ones validation doesn't argue about.
 */
function macroWeights(
  recipe: GeneratedRecipe,
  key: "calories" | "protein" | "carbs" | "fat",
  eligible: boolean[],
): number[] {
  const masked = (values: number[]) => values.map((value, i) => (eligible[i] ? value : 0));
  const claims = masked(recipe.ingredients.map((i) => i.nutrition[key]));
  if (claims.some((value) => value > 0)) return claims;
  const calories = masked(recipe.ingredients.map((i) => i.nutrition.calories));
  if (calories.some((value) => value > 0)) return calories;
  return eligible.map((flag) => (flag ? 1 : 0));
}

/**
 * Integer split of `target` across weights (largest remainder, exact sum).
 * Zero-weight rows always receive exactly 0 — the leftover pass only visits
 * positive-weight rows.
 */
function allocateIntegers(weights: number[], target: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || target <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w * target) / sum);
  const base = exact.map(Math.floor);
  let leftover = target - base.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, i) => ({ i, frac: value - Math.floor(value) }))
    .filter(({ i }) => weights[i] > 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (leftover <= 0) break;
    base[i] += 1;
    leftover -= 1;
  }
  return base;
}

/**
 * Rescales each macro so the INTEGER per-ingredient values sum exactly to the
 * rounded per-serving totals the card displays. Handles the batch-basis slip
 * (values ~servings× too big) for free — proportions are kept, scale is not.
 * All nutrition lands on measurable (amount > 0) rows — claims a model parks
 * on "to taste" rows are reallocated, since the UI cannot edit those — and
 * unclaimed macros fall back to calorie-weighted then even splits (see
 * macroWeights), so payload sums always equal the displayed totals and edits
 * can move every macro. If NO row is measurable (degenerate all-to-taste
 * recipe), every row becomes eligible so totals still decompose. Exported
 * for unit tests.
 */
export function normalizeIngredientNutrition(recipe: GeneratedRecipe): GeneratedRecipe {
  const measurable = recipe.ingredients.map((i) => i.amount > 0);
  const eligible = measurable.some(Boolean)
    ? measurable
    : recipe.ingredients.map(() => true);
  const perMacro = MACROS.map((macro) =>
    allocateIntegers(macroWeights(recipe, macro.key, eligible), Math.round(recipe[macro.key])),
  );
  return {
    ...recipe,
    ingredients: recipe.ingredients.map((ingredient, index) => ({
      ...ingredient,
      nutrition: {
        calories: perMacro[0][index],
        protein: perMacro[1][index],
        carbs: perMacro[2][index],
        fat: perMacro[3][index],
      },
    })),
  };
}

let suggestionSeq = 0;

/** Grocery lines always carry the OFFICIAL catalog name for cited items. */
function formatGroceryLine(ingredient: GeneratedRecipe["ingredients"][number]): string {
  const official = ingredient.approvedItemId
    ? approvedItemName(ingredient.approvedItemId)
    : undefined;
  const label = official ?? ingredient.name;
  // Display text follows the coach's no-dash rule even when the official
  // catalog wording carries one ("Canned Tuna – Water Packed") — validation
  // matched on the catalog id long before this, so only the shown line
  // changes.
  if (ingredient.amount <= 0) return stripDashes(label);
  const unit = ingredient.unit ? ` ${ingredient.unit}` : "";
  return stripDashes(`${ingredient.amount}${unit} ${label}`);
}

function toPayload(recipe: GeneratedRecipe, mode: RecipeMode): RecipeCardPayload {
  suggestionSeq += 1;
  // Cravings grocery lists are derived from the validated ingredients (one
  // line per cited catalog item, official wording) — model-supplied free-text
  // lists are ignored so nothing off-catalog can appear in them.
  const groceryList =
    mode === "cravings" ? recipe.ingredients.map(formatGroceryLine) : undefined;
  return {
    id: `sugg_${Date.now().toString(36)}_${suggestionSeq}`,
    mode,
    // Created names are Title Case everywhere (chat label foods, the
    // create-food screen, meal cards) — recipe cards included.
    name: toTitleCase(recipe.name),
    description: recipe.description,
    meal: recipe.meal,
    minutes: Math.max(1, Math.round(recipe.minutes)),
    servings: Math.max(1, Math.min(8, Math.round(recipe.servings))),
    calories: Math.round(recipe.calories),
    protein: Math.round(recipe.protein),
    carbs: Math.round(recipe.carbs),
    fat: Math.round(recipe.fat),
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    ...(groceryList ? { groceryList } : {}),
  };
}

/**
 * One automatic retry for transient upstream failures (proxy hiccup, dropped
 * connection). Without it a single blip surfaces as the red "coach is
 * unavailable" bubble even though an immediate manual retry would succeed.
 */
const TRANSIENT_RETRY_LIMIT = 1;
const TRANSIENT_RETRY_DELAY_MS = 400;

async function callModel(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  signal: AbortSignal,
  log: RecipeTurnArgs["log"],
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_LIMIT; attempt++) {
    // Idle deadline per attempt: recipe turns are the longest silent calls in
    // the coach, so a wedged upstream here must become a prompt, explainable
    // failure instead of a stream that hangs until a proxy kills it.
    const deadline = createUpstreamDeadline(signal);
    const attemptStartedAt = Date.now();
    try {
      const completion = await withModelUsageSurface("coach.recipe", () => openai.chat.completions.create(
        {
          model: modelFor("coach.recipe"),
          // Reasoning models spend part of this budget internally; the AI
          // integration requires >= 8192 to avoid empty replies.
          max_completion_tokens: 8192,
          response_format: { type: "json_object" },
          messages,
        },
        { signal: deadline.signal },
      ));
      return completion.choices[0]?.message?.content ?? "";
    } catch (error) {
      // A deadline expiry already consumed the full idle budget; a transient
      // retry would stack another silent wait on top of it, so surface the
      // named timeout immediately instead of burning the retry.
      if (deadline.expired) {
        throw new UpstreamTimeoutError("coach recipe model call", deadline.idleMs, {
          cause: error,
        });
      }
      lastError = error;
      // Never retry a request the client abandoned, and don't swallow the
      // final failure — the route's catch logs it and tells the client.
      if (signal.aborted || attempt === TRANSIENT_RETRY_LIMIT) throw error;
      log.warn(
        { err: error, attempt, elapsedMs: Date.now() - attemptStartedAt },
        "coach recipe model call failed; retrying once",
      );
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
      if (signal.aborted) throw error;
    } finally {
      deadline.finish();
    }
  }
  throw lastError;
}

/** One corrective retry, then an honest decline. */
const RETRY_LIMIT = 1;

export async function generateRecipeTurn(args: RecipeTurnArgs): Promise<RecipeTurnResult> {
  // Cravings must ground in the official list; menu-inspired home versions
  // and meal makeovers should too, so the adapted dish is built from
  // program-friendly items.
  const compartments =
    args.mode === "cravings" || args.inspiration !== undefined
      ? ensureApprovedFoodsCompartment(args.compartments)
      : args.compartments;
  // The deterministic approved-only gate in interpret(): every ingredient
  // must cite a verifiable catalog id. Cravings always; the meal makeover is
  // the promise "every ingredient verified against the Approved Foods
  // catalog", so it gets the same enforcement.
  const approvedOnly = args.mode === "cravings" || args.inspiration === "meal-makeover";
  const slot = args.slot ?? {};
  const baseMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
    {
      role: "system",
      content: [
        buildRecipeSystemPrompt(args.mode, compartments, args.patient, args.inspiration, slot),
        args.coachingContext,
      ].filter((part): part is string => Boolean(part)).join("\n\n"),
    },
    ...args.history,
  ];

  let messages = baseMessages;
  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    const raw = await callModel(messages, args.signal, args.log);
    const outcome = interpret(raw, approvedOnly, args.patient.diet);
    if (outcome.ok) {
      if (!outcome.recipe) return { reply: outcome.reply, card: null };
      // An explicit client pin wins over whatever the model chose — the
      // entry point already knew which diary slot it was filling.
      const recipe = slot.explicit
        ? { ...outcome.recipe, meal: slot.explicit }
        : outcome.recipe;
      return {
        reply: outcome.reply,
        card: { kind: "recipe", payload: toPayload(recipe, args.mode) },
      };
    }
    args.log.warn(
      { mode: args.mode, attempt, problems: outcome.problems },
      "coach recipe output rejected",
    );
    messages = [
      ...baseMessages,
      { role: "assistant", content: raw.slice(0, 6000) },
      {
        role: "user",
        content: `That response was invalid: ${outcome.problems.join("; ")}. Reply again with ONLY the corrected JSON object.`,
      },
    ];
  }
  return { reply: declineReplyFor(args.mode, args.inspiration), card: null };
}

function declineReplyFor(mode: RecipeMode, inspiration: RecipeTurnArgs["inspiration"]): string {
  return inspiration === "meal-makeover" ? MAKEOVER_DECLINE_REPLY : DECLINE_REPLY[mode];
}
