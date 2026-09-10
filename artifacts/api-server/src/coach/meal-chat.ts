/**
 * Meal photo turns inside the coach chat.
 *
 * When a chat message arrives with a photo flagged `photoKind: "meal"`, the
 * route runs the meal analysis (see meal-photo.ts) and formats the result as
 * a conversational coach reply: the model's warm reaction, one compact block
 * listing each visible food with its committed portion estimate, and a
 * closing line that points at the attached editable meal card. The card
 * itself rides the SSE `card` slot as the existing recipe payload (mode
 * "meal"), so the client's breakdown editor, diary logging, and
 * save-as-recipe paths all reuse the recipe plumbing.
 *
 * The analysis also judges every item against the Approved Foods catalog
 * (meal-photo.ts). A fully approved plate earns a one-line nod; a plate with
 * off-list items gets a plain-words callout naming them plus the makeover
 * offer — the ONE meal reply allowed to end with "?", because the curated
 * yes/no chips ride that turn. Saying yes leads to generateMealMakeoverTurn
 * (the concrete swaps + the version question), and the version answer routes
 * to either the approved-only recipe pipeline or the canned keep-it reply.
 * All of that is coaching in the chat: the card, the diary, and logging never
 * carry a verdict.
 *
 * Not-food and unreadable photos come back as friendly conversational
 * notices — never error events. The retake affordance is client-side (a chip
 * under the reply); the closer only mentions it in words.
 */
import { openai } from "@workspace/integrations-openai-ai-server";
import { catalogPromptLines } from "./approved-catalog";
import type { Compartment } from "./compartments";
import { generateMealPhotoAnalysis, type MealPhotoAnalysis, type MealPhotoOutcome } from "./meal-photo";
import type { MealSlotContext } from "./meal-slot";
import { isAffirmativeReply } from "./menu-chat";
import { cleanModelText } from "./model-json";
import {
  COACH_PERSONA_LINE,
  COACH_VOICE_RULES,
  patientContextLine,
  sourcesBlock,
  type PatientContext,
} from "./prompt";
import { ensureApprovedFoodsCompartment, type RecipeCardPayload } from "./recipe";
import { stripDashes } from "./text-style";
import { createUpstreamDeadline, UpstreamTimeoutError } from "./upstream";
import type { UsageRecorder } from "./usage";

/**
 * Closer under the item list. Must not end with a question mark — on a fully
 * approved plate the reply ends here, and the client's fallback yes/no chips
 * fit nothing (the makeover-offer turn is the one that WANTS chips, and it
 * brings its own). Invites BOTH fixes in words: typing what the plate really
 * is (the correction turn below) or retaking the photo (the client's
 * "Retake photo" chip). The typed example primes the phrasing
 * isMealCorrectionText detects.
 */
export const MEAL_CARD_CLOSER =
  "These amounts are my best read of the photo. Open the meal card below to fine-tune them, then log the meal or save it for next time. And if I misread your plate, type what it really is, something like no, that's steak and sweet potatoes, or just retake the photo.";

/** Closer for photos that couldn't be read as a meal. No "?" ending either. */
export const MEAL_TRY_ANOTHER_PHOTO =
  "Whenever you're ready, snap another photo of your meal and I'll take a look.";

/**
 * One-line nod when every visible item verified against the Approved Foods
 * catalog. No question mark (no chips belong here) and no dashes.
 */
export const MEAL_ON_PLAN_NOD =
  "And a nice bonus: everything I can see here is on your THINNR Approved Foods list.";
/** Trims "6.00" → "6" and "1.50" → "1.5" for the reply's portion lines. */
function formatAmount(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}

/**
 * One line per visible food: the card's name VERBATIM (payload assembly
 * already Title Cased it — the single casing seam), its committed portion,
 * and the same integer calorie figure the card shows (post-normalization),
 * so the words and the card never disagree.
 */
function itemLine(item: RecipeCardPayload["ingredients"][number]): string {
  const portion = item.unit ? `${formatAmount(item.amount)} ${item.unit}` : formatAmount(item.amount);
  const calories = item.nutrition.calories;
  return `${item.name}: about ${portion} · est. ${calories} cal`;
}

/**
 * Formats the structured analysis as blank-line-separated thought blocks
 * (the shape the chat bubbles render). `offerMakeover` tells the route to
 * send the curated yes/no chips with this reply — true exactly when the
 * reply closes with the makeover offer.
 */
export function formatMealReply(analysis: MealPhotoAnalysis): {
  reply: string;
  offerMakeover: boolean;
} {
  if (analysis.outcome !== "ok" || analysis.payload === null) {
    return { reply: `${analysis.message}\n\n${MEAL_TRY_ANOTHER_PHOTO}`, offerMakeover: false };
  }
  const blocks: string[] = [analysis.message];
  blocks.push(analysis.payload.ingredients.map(itemLine).join("\n"));
  if (analysis.offPlanItems.length === 0) {
    // Fully approved plate: brief nod, then the usual closer ends the reply
    // (no "?", so no chips — exactly like today).
    blocks.push(MEAL_ON_PLAN_NOD);
    blocks.push(MEAL_CARD_CLOSER);
    return { reply: blocks.join("\n\n"), offerMakeover: false };
  }
  // Off-list items spotted: closer first (the card guidance still applies),
  // then the callout + offer as the final block so the reply ends with the
  // question the chips answer.
  blocks.push(MEAL_CARD_CLOSER);
  blocks.push(`${offPlanCallout(analysis.offPlanItems)} ${MEAL_MAKEOVER_OFFER}`);
  return { reply: blocks.join("\n\n"), offerMakeover: true };
}

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}
export interface MealChatTurn {
  reply: string;
  card: { kind: "recipe"; payload: RecipeCardPayload } | null;
  outcome: MealPhotoOutcome;
  itemCount: number;
  /** True when this turn re-ran the analysis under a typed correction. */
  corrected: boolean;
  /** True when the reply ends with the makeover offer — send yes/no chips. */
  offerMakeover: boolean;
  /** How many items failed the Approved Foods verification (log signal). */
  offPlanCount: number;
}

/** Runs the analysis and shapes the whole chat turn for the route. */
export async function generateMealChatTurn(args: {
  image: string;
  patient: PatientContext;
  /**
   * Meal-slot context from the request (explicit client pin and/or the
   * default derived from the patient's local time), passed through to the
   * analysis so the card preselects the right diary slot.
   */
  slot?: MealSlotContext;
  /**
   * The patient's typed fix for a misread plate, when the route detected
   * one (isMealCorrectionText on the latest message). Passed through to the
   * analysis as ground truth for what the foods are. The re-read judges the
   * corrected items against the Approved Foods catalog again, so the callout
   * and offer always describe the corrected plate.
   */
  correction?: string;
  /**
   * Per-call token usage sink, passed through to the analysis so the
   * route's photo usage log sees every model call this turn makes. (The
   * analysis's harness-only effort pin is deliberately NOT exposed here —
   * nothing request-reachable may set it.)
   */
  onUsage?: UsageRecorder;
  signal: AbortSignal;
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<MealChatTurn> {
  const analysis = await generateMealPhotoAnalysis(args);
  const { reply, offerMakeover } = formatMealReply(analysis);
  return {
    reply,
    card: analysis.payload ? { kind: "recipe", payload: analysis.payload } : null,
    outcome: analysis.outcome,
    itemCount: analysis.payload?.ingredients.length ?? 0,
    corrected: args.correction !== undefined,
    offerMakeover,
    offPlanCount: analysis.offPlanItems.length,
  };
}

interface MinimalLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Same tier as the other non-streaming coach turns (recipes, menu scans):
 * the swaps must be grounded and specific, and this turn is rare enough that
 * the mid-tier price is fine.
 */
const MAKEOVER_MODEL = "gpt-5.6-terra";

/**
 * The swaps reply after they said yes to the makeover offer: model-written
 * concrete swaps (grounded in the catalog riding the prompt, off-list items
 * read from the replayed callout), then the server-authored version question
 * appended verbatim. Plain text end to end — no card on this turn.
 */
export async function generateMealMakeoverTurn(args: {
  history: HistoryEntry[];
  /** Compartments already selected for this turn; approved-foods is forced in. */
  compartments: Compartment[];
  patient: PatientContext;
  /** Server-recalled, bounded patient context for the coaching reply. */
  coachingContext?: string;
  signal: AbortSignal;
  log: MinimalLog;
}): Promise<MealMakeoverTurn> {
  const compartments = ensureApprovedFoodsCompartment(args.compartments);
  const messages = [
    {
      role: "system" as const,
      content: [buildMakeoverSystemPrompt(args.patient, compartments), args.coachingContext]
        .filter((part): part is string => Boolean(part)).join("\n\n"),
    },
    ...args.history,
  ];
  const raw = await callMakeoverModel(messages, args.signal, args.log);
  const text = stripDashes(cleanModelText(raw)).trim();
  if (!text) {
    args.log.warn({}, "meal makeover model returned empty text; sending decline");
    return { reply: MEAL_MAKEOVER_UNAVAILABLE, askVersion: false };
  }
  return { reply: `${text}\n\n${MEAL_VERSION_QUESTION}`, askVersion: true };
}

/**
 * True when the latest message is a bare yes to the makeover offer sitting
 * directly above it. Same strict adjacency as the menu recipe follow-up: the
 * offer is a server-authored constant, so replayed history contains it
 * verbatim, and anything beyond a one-tap affirmative ("what about the
 * rice?") falls through to plain chat, which reads the context anyway. If
 * the callout reply was stopped before the offer text revealed, the replayed
 * text won't contain it and the detector correctly stays quiet.
 */
export function detectMealMakeoverFollowUp(history: HistoryEntry[]): boolean {
  if (history.length < 2) return false;
  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
  if (latest.role !== "user" || previous.role !== "assistant") return false;
  if (!isAffirmativeReply(latest.content)) return false;
  return previous.content.includes(MEAL_MAKEOVER_OFFER);
}

export type MealVersionChoice = "approved" | "keep";

/**
 * Plain-words callout naming the off-list items, judgment explicitly waved
 * off in the same breath. Ends mid-thought on purpose: formatMealReply glues
 * the makeover offer right after it, in the same block.
 */
export function offPlanCallout(offPlanItems: string[]): string {
  const names = offPlanItems.map((name) => `the ${name.toLowerCase()}`);
  const verb = offPlanItems.length === 1 ? "isn't" : "aren't";
  return `One small heads up: ${joinWithAnd(names)} ${verb} on your THINNR Approved Foods list. That changes nothing about logging it, this meal is yours exactly as it is.`;
}

/**
 * Which version they picked at the version question, or null when the
 * conversation is not at that spot (or the answer is anything richer than a
 * one-tap choice — plain chat handles those with full context). Keys on the
 * server-authored MEAL_VERSION_QUESTION in the reply directly above, exactly
 * like the other adjacency detectors.
 */
export function detectMealVersionChoice(history: HistoryEntry[]): MealVersionChoice | null {
  if (history.length < 2) return null;
  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
  if (latest.role !== "user" || previous.role !== "assistant") return null;
  if (!previous.content.includes(MEAL_VERSION_QUESTION)) return null;
  const normalized = normalizeOneTap(latest.content);
  if (APPROVED_VERSION_REPLIES.has(normalized)) return "approved";
  if (KEEP_VERSION_REPLIES.has(normalized)) return "keep";
  return null;
}

function buildMakeoverSystemPrompt(patient: PatientContext, compartments: Compartment[]): string {
  return `${COACH_PERSONA_LINE}

${patientContextLine(patient)}

${COACH_VOICE_RULES}

Task: earlier in this conversation the patient photographed a meal, you listed what was on the plate, and your reply named which items are not on the THINNR Approved Foods list. The patient just said yes to a suggestion for a THINNR-approved version. Describe the concrete swaps that would make THAT exact meal fully approved: keep every item that is already on the list, and for each named off-list item point to the closest replacement from the APPROVED FOODS CATALOG below.

Rules for the swaps:
- Ground every swap in the catalog: only suggest replacements that appear there, named the way the catalog names them (plain preparation words are fine). Never invent a program rule, a food, or an amount that is not in this conversation or the catalog.
- If an off-list item has no reasonable replacement in the catalog, say plainly that it would simply come off the plate, and never dress that up as a rule the program does not state.
- Answer in plain text, no JSON and no markdown: one or two short blocks separated by a blank line, a few sentences total, in the same warm texting voice as the rest of the chat.
- Do NOT ask the patient anything and do NOT offer to build the recipe yourself. The app appends its own follow-up question right after your words, so end on the last swap, not a question.

APPROVED FOODS CATALOG (id — official name):
${catalogPromptLines()}

THINNR program materials for this question:

${sourcesBlock(compartments)}`;
}

/**
 * The which-version question closing the swaps reply. Server-authored
 * verbatim (appended after the model's swaps text) so detectMealVersionChoice
 * can key on it in replayed history; carried by the meal_version chip pair.
 */
export const MEAL_VERSION_QUESTION =
  "Want me to turn that into a THINNR-approved recipe card you can save and log, or would you rather keep the meal exactly as photographed?";

async function callMakeoverModel(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  signal: AbortSignal,
  log: MinimalLog,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_LIMIT; attempt++) {
    // Idle deadline per attempt, same posture as every non-streaming coach
    // call: a wedged upstream becomes a prompt, explainable failure.
    const deadline = createUpstreamDeadline(signal);
    const attemptStartedAt = Date.now();
    try {
      const completion = await openai.chat.completions.create(
        {
          model: MAKEOVER_MODEL,
          // Reasoning models spend part of this budget internally before
          // emitting text; smaller caps come back empty.
          max_completion_tokens: 8192,
          messages,
        },
        { signal: deadline.signal },
      );
      return completion.choices[0]?.message?.content ?? "";
    } catch (error) {
      if (deadline.expired) {
        throw new UpstreamTimeoutError("meal makeover model call", deadline.idleMs, { cause: error });
      }
      lastError = error;
      if (signal.aborted || attempt >= TRANSIENT_RETRY_LIMIT) throw error;
      log.warn(
        { err: error, attempt, elapsedMs: Date.now() - attemptStartedAt },
        "meal makeover model call failed; retrying once",
      );
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
      if (signal.aborted) throw error;
    } finally {
      deadline.finish();
    }
  }
  throw lastError;
}

/**
 * One-tap shapes that keep the meal as photographed. First entry is the
 * exact chip label. "no keep it as is" covers the natural typed decline;
 * a bare "no" deliberately is NOT here — it falls through to plain chat,
 * which can ask what they'd rather do.
 */
const KEEP_VERSION_REPLIES = new Set([
  "keep it as is",
  "keep it as it is",
  "keep it like it is",
  "keep it the same",
  "keep it",
  "keep mine",
  "keep the meal as is",
  "keep the original",
  "the original",
  "as is",
  "leave it",
  "leave it as is",
  "leave it be",
  "ill keep it",
  "ill keep it as is",
  "ill keep mine",
  "im keeping it",
  "no keep it as is",
  "no ill keep it",
]);

/**
 * The makeover offer appended after the callout when off-list items were
 * spotted. Server-authored verbatim so detectMealMakeoverFollowUp can key on
 * it in replayed history — the same contract the menu recipe offer uses. The
 * one meal-turn string that ends with "?": the curated yes/no chips ride it.
 */
export const MEAL_MAKEOVER_OFFER =
  "Would you like a suggestion for a THINNR-approved version of this meal?";

export interface MealMakeoverTurn {
  reply: string;
  /**
   * False when the model gave nothing usable and the canned decline went out
   * instead — no version question in the reply, so the route must not send
   * the version chips and the choice detector will correctly never fire.
   */
  askVersion: boolean;
}

/** "the flour tortilla", "the tortilla and the sour cream", "a, b, and c". */
function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

const TRANSIENT_RETRY_LIMIT = 1;

/**
 * One-tap shapes that pick the approved version. The first entry is the
 * exact chip label; the rest cover natural typed variants. Normalization
 * strips punctuation, so "Let's do the approved version!" matches too.
 */
const APPROVED_VERSION_REPLIES = new Set([
  "the approved version",
  "approved version",
  "the approved version please",
  "approved version please",
  "the approved one",
  "approved one",
  "approved",
  "approved please",
  "give me the approved version",
  "lets do the approved version",
  "lets do the approved one",
  "make it approved",
  "the makeover",
  "makeover",
  "makeover please",
  "the approved recipe",
  "approved recipe",
  "the recipe card",
  "recipe card please",
  "turn it into a recipe card",
  "the thinnr version",
  "the thinnr approved version",
  "thinnr approved version",
]);

/**
 * Canned acknowledgment when they choose to keep the meal as photographed.
 * Zero model calls, zero lecturing: it points straight back at the original
 * meal card. No "?" ending (nothing left to ask) and no dashes.
 */
export const MEAL_KEEP_REPLY =
  "Works for me, that plate is yours. The meal card above is ready whenever you want to log it exactly as photographed, and you can fine-tune the portions right on it.";

/**
 * Honest decline when the swaps model gave nothing usable even after a
 * retry. Sent WITHOUT the version question or chips — there is no suggestion
 * on the table to choose from. No "?" ending and no dashes.
 */
export const MEAL_MAKEOVER_UNAVAILABLE =
  "I couldn't put a solid swap list together just now, and I'd rather not wing it. Your meal card above still logs the plate exactly as photographed, and you can ask me again in a moment.";

/** Same normalization as the affirmative allow-list: letters and spaces only. */
function normalizeOneTap(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const TRANSIENT_RETRY_DELAY_MS = 400;
