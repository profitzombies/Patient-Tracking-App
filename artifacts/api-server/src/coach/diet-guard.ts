/**
 * Reply-side diet guard — the deterministic check that runs the shared
 * classifier over the foods a coach surface is about to suggest or report.
 *
 * The prompt already tells the model about the diet and the four lists
 * (coach/diet-grounding.ts); this module is the backstop the model cannot
 * talk its way around:
 *
 * - menu reads: a pick that hits an allergy, restriction, sensitivity or
 *   diet rule moves to the skip list with the reason; disliked picks drop;
 * - recipes: ingredient hits (and kosher / halal meat-with-dairy across the
 *   whole dish) become validation problems that send the model back for a
 *   corrected draft, exactly like a bad citation does;
 * - meal and label reads: a fits / does not fit / can't tell line with the
 *   reason, written from the classifier's verdict;
 * - quick-reply chips: labels that name a hit never reach the client.
 *
 * Every verdict comes from the lib classifier plus the conservative
 * free-text tagger; a food it cannot place stays "unknown" rather than
 * silently passing as "fits".
 */
import {
  classifyFood,
  inferFoodTags,
  type ClassifierContext,
  type FitReason,
  type FitResult,
  type FoodDescription,
  type FoodTag,
} from "@workspace/diet-programs";
import { classifierContextOf, type DietGrounding } from "./diet-grounding";
import type { MenuScanPayload } from "./menu-scan";
import type { LabelDraft } from "./label-photo";

export interface FoodCheck {
  name: string;
  result: FitResult;
  /** Reasons that make this food a no (allergy, restriction, sensitivity, diet, protocol, dislike). */
  hits: FitReason[];
}

/** Classify one free-text food (a dish, an ingredient, a chip label). */
export function checkFood(name: string, context: ClassifierContext, extra: Partial<FoodDescription> = {}): FoodCheck {
  const tags = new Set<string>([...inferFoodTags(name, extra.ingredients ?? []), ...(extra.tags ?? [])]);
  const result = classifyFood({ ...extra, name, tags: [...tags] }, context);
  return { name, result, hits: result.reasons.filter((reason) => reason.kind === "hit") };
}

/** Lower-case, trailing-period-free reason text for inline use. */
function inline(reason: FitReason): string {
  return reason.message.replace(/\.$/, "");
}

/** What the fit verdict was checked against, for the "yes" line. */
function checkedAgainst(diet: DietGrounding): string {
  if (diet.phase === "protocol") return "the Approved Foods list and your food lists";
  if (diet.diet && diet.diet.slug !== "just_tracking") return `${diet.diet.name} and your food lists`;
  return "your food lists";
}

// ─── Menu reads ─────────────────────────────────────────────────────────────

export interface MenuGuardOutcome {
  payload: MenuScanPayload;
  /** Picks removed or moved, for the route's log (dish names only). */
  moved: Array<{ name: string; code: string }>;
}

/**
 * Picks that hit a list or diet rule move to "avoid" with the reason;
 * disliked picks simply drop (visible on the menu, never suggested).
 */
export function guardMenuPayload(payload: MenuScanPayload, diet: DietGrounding): MenuGuardOutcome {
  if (payload.result !== "ok") return { payload, moved: [] };
  const context = classifierContextOf(diet);
  const moved: MenuGuardOutcome["moved"] = [];
  const order: MenuScanPayload["order"] = [];
  const avoid: MenuScanPayload["avoid"] = [...payload.avoid];
  const avoidNames = new Set(avoid.map((dish) => dish.name.toLowerCase()));
  for (const dish of payload.order) {
    const check = checkFood(dish.name, context, { ingredients: [dish.howToOrder, dish.note ?? ""] });
    if (check.hits.length === 0) {
      order.push(dish);
      continue;
    }
    const first = check.hits[0]!;
    moved.push({ name: dish.name, code: first.code });
    if (first.source === "dislike") continue;
    if (!avoidNames.has(dish.name.toLowerCase())) {
      avoid.push({ name: dish.name, reason: inline(first).slice(0, 200) });
      avoidNames.add(dish.name.toLowerCase());
    }
  }
  return { payload: { ...payload, order, avoid: avoid.slice(0, 10) }, moved };
}

// ─── Recipes ────────────────────────────────────────────────────────────────

/**
 * Validation problems for a drafted recipe: every ingredient that hits a
 * list or diet rule, plus combination rules (kosher: meat with dairy)
 * judged across the whole dish. Empty means the draft may return.
 */
export function recipeDietProblems(recipe: { name: string; ingredients: ReadonlyArray<{ name: string }> }, diet: DietGrounding): string[] {
  const context = classifierContextOf(diet);
  const problems: string[] = [];
  const dishTags = new Set<FoodTag>();
  for (const ingredient of recipe.ingredients) {
    for (const tag of inferFoodTags(ingredient.name)) dishTags.add(tag);
    // Approved-ness is judged by the citation gate, not here: during the
    // protocol, ingredient-level checks only enforce the lists.
    const check = checkFood(ingredient.name, { ...context, phase: context.phase === "protocol" ? null : context.phase, dietSlug: context.phase === "protocol" ? null : context.dietSlug });
    const hit = check.hits.find((reason) => reason.source !== "protocol");
    if (hit) problems.push(`ingredient "${ingredient.name}" does not fit the patient: ${inline(hit)} — replace it`);
  }
  // Whole-dish combination rules (meat with dairy in one dish).
  // One problem per rule source: kosher lists several meat/dairy pairings
  // and a chicken-and-cheese dish trips more than one of them.
  const composite = classifyFood({ name: recipe.name, tags: [...dishTags] }, { ...context, phase: null });
  const seen = new Set<string>();
  for (const reason of composite.reasons) {
    const marker = reason.code.indexOf(":combination:");
    if (reason.kind !== "hit" || marker < 0) continue;
    const rule = reason.code.slice(0, marker);
    if (seen.has(rule)) continue;
    seen.add(rule);
    problems.push(`the dish as a whole does not fit the patient: ${inline(reason)} — drop one side of that pairing`);
  }
  return problems;
}

// ─── Meal and label reads ───────────────────────────────────────────────────

export interface PlateItem {
  name: string;
  /** True when verified on the Approved Foods list, false when known off-list, undefined when unknown. */
  thinnrApproved?: boolean;
}

export interface FitLine {
  verdict: "fits" | "does_not_fit" | "unknown";
  text: string;
}

const MAX_REASONS = 3;

/** The "Fits your diet" line for a photographed plate. */
export function plateFitLine(items: readonly PlateItem[], diet: DietGrounding): FitLine {
  const context = classifierContextOf(diet);
  const checks = items.map((item) => checkFood(item.name, context, { thinnrApproved: item.thinnrApproved }));
  const hits = checks.flatMap((check) => check.hits.map((reason) => `${check.name}: ${inline(reason)}`));
  if (hits.length > 0) {
    const shown = hits.slice(0, MAX_REASONS).join("; ");
    const more = hits.length > MAX_REASONS ? ` (and ${hits.length - MAX_REASONS} more)` : "";
    return { verdict: "does_not_fit", text: `Fits your diet: no. ${shown}${more}. I've still logged it as photographed; just know it's not one I'd suggest.` };
  }
  const unknown = checks.filter((check) => check.result.verdict === "unknown");
  if (unknown.length > 0) {
    const names = unknown.slice(0, MAX_REASONS).map((check) => check.name).join(", ");
    return { verdict: "unknown", text: `Fits your diet: can't tell for sure. I couldn't match ${names} against ${checkedAgainst(diet)}, so give ${unknown.length === 1 ? "it" : "those"} a quick check yourself.` };
  }
  const notes = checks.flatMap((check) => check.result.reasons.filter((reason) => reason.kind === "note").map((reason) => inline(reason)));
  const note = notes.length > 0 ? ` One note: ${[...new Set(notes)].slice(0, 2).join("; ")}.` : "";
  return { verdict: "fits", text: `Fits your diet: yes. Nothing on this plate hits ${checkedAgainst(diet)}.${note}` };
}

/** Serving grams printed inside the serving-size line, e.g. "2/3 cup (55g)". */
function servingGramsOf(servingSize: string): number | undefined {
  const match = /\((\d+(?:\.\d+)?)\s*g\)/i.exec(servingSize);
  return match ? Number(match[1]) : undefined;
}

const ALLERGY_NOTE_LIMIT = 4;

/**
 * The fit line for a Nutrition Facts read. A label photo gives numbers, not
 * an ingredient list, so the honest answer is usually "the numbers fit,
 * check the ingredients for X" — never a "yes" the photo cannot back.
 */
export function labelFitLine(draft: LabelDraft, diet: DietGrounding): FitLine {
  const context = classifierContextOf(diet);
  const result = classifyFood(
    { name: "packaged food", carbsPerServing: draft.carbs, caloriesPerServing: draft.calories, servingGrams: servingGramsOf(draft.servingSize) },
    { ...context, phase: context.phase === "protocol" ? null : context.phase },
  );
  const hits = result.reasons.filter((reason) => reason.kind === "hit");
  if (hits.length > 0) {
    return { verdict: "does_not_fit", text: `Fits your diet: no. ${hits.slice(0, MAX_REASONS).map(inline).join("; ")}. You can still log it; it's just not one I'd suggest.` };
  }
  const watch = diet.lists
    .filter((item) => item.list !== "dislike")
    .map((item) => item.label)
    .slice(0, ALLERGY_NOTE_LIMIT);
  const checkFor = watch.length > 0 ? ` and check the ingredient list for ${watch.join(", ")}` : "";
  const protocol = diet.phase === "protocol" ? " During the protocol, packaged foods also need to be on the Approved Foods list." : "";
  return { verdict: "unknown", text: `Fits your diet: can't tell from the numbers alone. Nothing printed here breaks ${checkedAgainst(diet)}, but a label photo doesn't show ingredients, so turn the package over${checkFor}.${protocol}` };
}

// ─── Quick-reply chips ──────────────────────────────────────────────────────

/** Chip labels that name a food the patient must not be offered are dropped. */
export function filterChipLabels(labels: readonly string[], diet: DietGrounding): string[] {
  const context = classifierContextOf(diet);
  return labels.filter((label) => checkFood(label, context).hits.every((hit) => hit.source === "protocol"));
}
