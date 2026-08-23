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
import { patientContextLine, sourcesBlock, type PatientContext } from "./prompt";
import {
  approvedItemName,
  catalogPromptLines,
  ingredientNameMatchesItem,
  isApprovedItemId,
} from "./approved-catalog";

export type RecipeMode = "recipe" | "cravings";

const MEALS = ["breakfast", "lunch", "dinner", "snacks"] as const;

const IngredientSchema = z.object({
  amount: z.number().min(0).max(1000),
  unit: z.string().max(24),
  name: z.string().min(1).max(80),
  approvedItemId: z.string().max(120).optional(),
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

type GeneratedRecipe = z.infer<typeof GeneratedRecipeSchema>;

/** Payload shape the mobile app renders as a chat card and preview screen. */
export interface RecipeCardPayload {
  id: string;
  mode: RecipeMode;
  name: string;
  description: string;
  meal: (typeof MEALS)[number];
  minutes: number;
  servings: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  ingredients: { amount: number; unit: string; name: string; approvedItemId?: string }[];
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
  history: { role: "user" | "assistant"; content: string }[];
  compartments: Compartment[];
  patient: PatientContext;
  signal: AbortSignal;
  log: MinimalLog;
}

/** Cravings replies must ground in the official list; force its compartment in. */
export function ensureApprovedFoodsCompartment(selected: Compartment[]): Compartment[] {
  if (selected.some((c) => c.id === "approved-foods")) return selected;
  const approved = COMPARTMENTS.find((c) => c.id === "approved-foods");
  return approved ? [...selected, approved] : selected;
}

const DECLINE_REPLY: Record<RecipeMode, string> = {
  recipe:
    "I had trouble putting a solid recipe together just now, so I would rather not guess. Please ask me again in a moment.",
  cravings:
    "I could not build a fix for that craving using only the Approved Foods list just now, so I will not improvise around the program. Please try me again in a moment.",
};

const RECIPE_JSON_CONTRACT = `Respond with a single JSON object and nothing else — no markdown, no code fences:
{
  "reply": string,
  "recipe": object or null
}
"reply" is your short text-message answer: 1 to 3 short sentences, plain text, never emojis. Normally split it into 2 short blocks separated by a blank line (write \\n\\n inside the JSON string): the suggestion first, then a one-line follow-up question or practical tip. Mention the dish briefly; the details live in the recipe object, not the reply.
"recipe" fields (all required unless noted):
- "name": short dish name
- "description": one appetizing sentence
- "meal": "breakfast" | "lunch" | "dinner" | "snacks"
- "minutes": total time as a number
- "servings": how many servings the recipe makes
- "calories", "protein", "carbs", "fat": estimated numbers PER SERVING (grams for macros); keep them realistic for the portions
- "ingredients": array of { "amount": number, "unit": string, "name": string } — use amount 0 for "to taste", unit "" when countable
- "steps": array of short instruction strings in cooking order`;

function buildRecipeSystemPrompt(
  mode: RecipeMode,
  compartments: Compartment[],
  patient: PatientContext,
): string {
  const shared = `You are the THINNR Coach, an AI assistant inside the THINNR patient app.

${patientContextLine(patient)}

${RECIPE_JSON_CONTRACT}

Grounding rules:
- Keep the suggestion consistent with the THINNR program materials inside the <source> blocks below. When your reply states a program rule, amount, or allowed food, use the source's exact wording for the rule itself.
- If you cannot propose something that fits the program, set "recipe" to null and say so plainly in "reply". Never invent program rules.
- You are informational only, not medical advice. Never suggest changing doses or medications.`;

  if (mode === "recipe") {
    return `${shared}

Task: the patient asked for a meal or snack idea. Propose exactly one recipe that fits their current phase.

THINNR program materials for this question:

${sourcesBlock(compartments)}`;
  }

  return `${shared}

Task: the patient mentioned a craving. Offer one simple approved snack fix for it.

STRICT CRAVINGS RULES:
- Every ingredient must be an item from the APPROVED FOODS CATALOG below. Each ingredient object MUST also include "approvedItemId" copied exactly from the catalog.
- Do not use any food that is not in the catalog — no exceptions, not even pantry basics. If it is not in the catalog, leave it out.
- Each ingredient's "name" may add simple preparation words to its catalog item (for example an id whose catalog name is "Skinless White Meat Chicken Breast" may be written "grilled chicken breast"), but every food word in the name must come from the cited catalog item's own name. The server rejects any name containing a food word that is not part of that catalog entry — never name a different food, and never a food the patient craved that is off the list.
- "meal" should normally be "snacks".
- "reply" briefly acknowledges the craving and points at the approved swap. If no approved combination genuinely answers the craving, set "recipe" to null and say so.

APPROVED FOODS CATALOG (id — official name):
${catalogPromptLines()}

THINNR program materials for this question:

${sourcesBlock(compartments)}`;
}

function extractJson(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Style insurance: the prompt forbids emojis, this makes it structural. */
function cleanReply(reply: string): string {
  return reply.replace(/\p{Extended_Pictographic}/gu, "").trim();
}

type Interpretation =
  | { ok: true; reply: string; recipe: GeneratedRecipe | null }
  | { ok: false; problems: string[] };

function interpret(raw: string, mode: RecipeMode): Interpretation {
  const json = extractJson(raw);
  if (json === null) return { ok: false, problems: ["response was not valid JSON"] };
  const parsed = ModelOutputSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`);
    return { ok: false, problems };
  }
  const { reply, recipe } = parsed.data;
  if (recipe && mode === "cravings") {
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
  return { ok: true, reply: cleanReply(reply), recipe };
}

let suggestionSeq = 0;

/** Grocery lines always carry the OFFICIAL catalog name for cited items. */
function formatGroceryLine(ingredient: GeneratedRecipe["ingredients"][number]): string {
  const official = ingredient.approvedItemId
    ? approvedItemName(ingredient.approvedItemId)
    : undefined;
  const label = official ?? ingredient.name;
  if (ingredient.amount <= 0) return label;
  const unit = ingredient.unit ? ` ${ingredient.unit}` : "";
  return `${ingredient.amount}${unit} ${label}`;
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
    name: recipe.name,
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
    try {
      const completion = await openai.chat.completions.create(
        {
          model: "gpt-5.6-terra",
          // Reasoning models spend part of this budget internally; the AI
          // integration requires >= 8192 to avoid empty replies.
          max_completion_tokens: 8192,
          response_format: { type: "json_object" },
          messages,
        },
        { signal },
      );
      return completion.choices[0]?.message?.content ?? "";
    } catch (error) {
      lastError = error;
      // Never retry a request the client abandoned, and don't swallow the
      // final failure — the route's catch logs it and tells the client.
      if (signal.aborted || attempt === TRANSIENT_RETRY_LIMIT) throw error;
      log.warn({ err: error, attempt }, "coach recipe model call failed; retrying once");
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
      if (signal.aborted) throw error;
    }
  }
  throw lastError;
}

/** One corrective retry, then an honest decline. */
const RETRY_LIMIT = 1;

export async function generateRecipeTurn(args: RecipeTurnArgs): Promise<RecipeTurnResult> {
  const compartments =
    args.mode === "cravings"
      ? ensureApprovedFoodsCompartment(args.compartments)
      : args.compartments;
  const baseMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: buildRecipeSystemPrompt(args.mode, compartments, args.patient) },
    ...args.history,
  ];

  let messages = baseMessages;
  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    const raw = await callModel(messages, args.signal, args.log);
    const outcome = interpret(raw, args.mode);
    if (outcome.ok) {
      if (!outcome.recipe) return { reply: outcome.reply, card: null };
      return {
        reply: outcome.reply,
        card: { kind: "recipe", payload: toPayload(outcome.recipe, args.mode) },
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
  return { reply: DECLINE_REPLY[args.mode], card: null };
}
