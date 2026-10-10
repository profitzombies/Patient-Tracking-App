/**
 * Safety screening and diet-choice gating — pure rules, shared by the API
 * (which enforces them) and the app (which previews them).
 *
 *  - Fasting and keto ask the insulin / diabetes-medication question;
 *    carnivore, Whole30, AIP and guided elimination ask the brief
 *    eating-disorder question. Which questions a diet asks is content
 *    (catalog / database), not code: this module reads the entry.
 *  - Pregnancy / breastfeeding is asked once, optionally, of female patients
 *    only. A yes blocks every pregnancy-blocked diet outright and suggests the
 *    fertility / pregnancy plan. No provider override exists for it.
 *  - A yes to the medication or eating-disorder question turns the pick into
 *    a PENDING BLOCK the provider reviews; the provider may override it after
 *    a second confirmation.
 *  - During the protocol the picker is locked unless the patient is on the
 *    GLP-1 program, whose suggested default is GLP-1 companion. Finishing the
 *    protocol unlocks the picker with "just tracking" over maintenance as the
 *    default.
 */
import { DIET_BY_SLUG, FERTILITY_PREGNANCY_SLUG, GLP1_COMPANION_SLUG, JUST_TRACKING_SLUG, type DietCatalogEntry } from "./catalog";
import type { ProgramId } from "./phase";
import type { ScreeningAnswer, ScreeningQuestion } from "./vocabulary";

/** The fields of a library entry the rules need (catalog entry or database row). */
export type ScreeningDietFacts = Pick<DietCatalogEntry, "slug" | "pregnancyBlocked" | "screeningQuestions" | "oversightNote">;

export type ScreeningAnswers = Partial<Record<ScreeningQuestion, ScreeningAnswer | null | undefined>>;

export interface DietChoiceContext {
  phase: "protocol" | "maintenance";
  programId: ProgramId | null | undefined;
  gender: "male" | "female" | null | undefined;
  /** Latest stored answer per question (null = never answered). */
  answers: ScreeningAnswers;
  /** True when the caller is office staff setting the diet on the patient's behalf. */
  actor: "patient" | "staff";
}

export type ChoiceOutcome =
  | { kind: "locked"; reason: "protocol" }
  | { kind: "needs_answers"; questions: ScreeningQuestion[] }
  | { kind: "blocked_pregnancy"; suggestedSlug: string }
  | { kind: "pending_block"; questions: ScreeningQuestion[] }
  | { kind: "allowed"; notifyCareTeam: CareTeamSignal[] };

export type CareTeamSignal = "diet_changed" | "oversight_recommended" | "medication_yes";

/** Questions this diet asks, with pregnancy only for female patients. */
export function questionsForDiet(entry: ScreeningDietFacts, gender: DietChoiceContext["gender"]): ScreeningQuestion[] {
  const asked = new Set<ScreeningQuestion>(entry.screeningQuestions);
  if (entry.pregnancyBlocked) asked.add("pregnancy");
  if (gender !== "female") asked.delete("pregnancy");
  return [...asked];
}

/** Questions the diet asks that the patient has not answered yet. Pregnancy is optional: a skip counts as answered. */
export function unansweredQuestions(entry: ScreeningDietFacts, context: DietChoiceContext): ScreeningQuestion[] {
  return questionsForDiet(entry, context.gender).filter((question) => {
    const answer = context.answers[question];
    return answer !== "yes" && answer !== "no" && answer !== "skipped";
  });
}

export function pregnancyConflict(entry: ScreeningDietFacts, answers: ScreeningAnswers): boolean {
  return entry.pregnancyBlocked && answers.pregnancy === "yes";
}

/** Blocking questions: a yes parks the pick for provider review. */
export function blockingYeses(entry: ScreeningDietFacts, answers: ScreeningAnswers): ScreeningQuestion[] {
  return entry.screeningQuestions.filter((question) => question !== "pregnancy" && answers[question] === "yes");
}

export function evaluateDietChoice(entry: ScreeningDietFacts, context: DietChoiceContext): ChoiceOutcome {
  if (context.phase === "protocol" && (context.programId ?? "thinnr") === "thinnr") {
    return { kind: "locked", reason: "protocol" };
  }
  if (entry.slug === JUST_TRACKING_SLUG) return { kind: "allowed", notifyCareTeam: ["diet_changed"] };
  const open = unansweredQuestions(entry, context);
  if (open.length > 0) return { kind: "needs_answers", questions: open };
  if (pregnancyConflict(entry, context.answers)) return { kind: "blocked_pregnancy", suggestedSlug: FERTILITY_PREGNANCY_SLUG };
  const yeses = blockingYeses(entry, context.answers);
  const signals: CareTeamSignal[] = ["diet_changed"];
  if (entry.oversightNote) signals.push("oversight_recommended");
  if (yeses.includes("medication")) signals.push("medication_yes");
  if (yeses.length > 0) return { kind: "pending_block", questions: yeses };
  return { kind: "allowed", notifyCareTeam: signals };
}

/** The slug the picker should pre-select for a patient with no current diet. */
export function suggestedDefaultSlug(programId: ProgramId | null | undefined): string {
  return programId === "glp1" ? GLP1_COMPANION_SLUG : JUST_TRACKING_SLUG;
}

/** Diets a new "yes" to pregnancy conflicts with, given the current one. */
export function pregnancyWarningFor(currentSlug: string | null, facts?: ScreeningDietFacts | null): boolean {
  if (!currentSlug) return false;
  const entry = facts ?? DIET_BY_SLUG.get(currentSlug) ?? null;
  return entry ? entry.pregnancyBlocked : false;
}
