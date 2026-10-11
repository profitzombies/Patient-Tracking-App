/**
 * Mobile seam over the shared diet-programs library.
 *
 * Screens import the classifier, the phase model and the target calculator
 * from here (never from the API) so the app shows the same verdicts and
 * numbers offline that the server computes. The only mobile-specific piece is
 * the Approved Foods bridge: during the protocol phase the classifier needs
 * to know whether a catalog food is on the THINNR Approved Foods list, and
 * the app already carries that list.
 */
import { classifyFood, type ClassifierContext, type FitResult, type FoodDescription } from '@workspace/diet-programs';
import { isApprovedFood } from '@/data/approved-foods';

export {
  ACTIVITY_LABELS,
  ACTIVITY_LEVELS,
  ALLERGEN_KEYS,
  ALLERGEN_LABELS,
  DIET_BY_SLUG,
  DIET_CATALOG,
  DIET_DISCLAIMER,
  FERTILITY_PREGNANCY_SLUG,
  GLP1_COMPANION_SLUG,
  JUST_TRACKING_SLUG,
  OVERSIGHT_NOTE_TEXT,
  PREFERENCE_LISTS,
  RESTRICTIONS,
  SCREENING_PROMPTS,
  SENSITIVITIES,
  calculateTargets,
  classifyFood,
  derivePhase,
  evaluateDietChoice,
  isActivityLevel,
  mifflinStJeor,
  programDayBetween,
  questionsForDiet,
  suggestedDefaultSlug,
  unansweredQuestions,
  PROTOCOL_LENGTH_DAYS,
  type ActivityLevel,
  type ActivitySource,
  type ChoiceOutcome,
  type ClassifierContext,
  type DietCatalogEntry,
  type DietChoiceContext,
  type DietComplexity,
  type FitResult,
  type FitVerdict,
  type FoodDescription,
  type PhaseState,
  type PreferenceItemInput,
  type PreferenceList,
  type ScreeningAnswer,
  type ScreeningQuestion,
  type TargetInput,
  type TargetOverrides,
} from '@workspace/diet-programs';

/** Seeded catalog foods carry this prefix; every one was reviewed against the Approved Foods list. */
const SEEDED_CATALOG_PREFIX = 'fd_';

/**
 * Attach the Approved Foods answer for a food id before classifying.
 *
 * Only the seeded catalog was reviewed against the list, so a seeded id that
 * is not on it is a real "not approved". Anything else — patient-created
 * foods, recipes, shared catalog hits, no id at all — has no membership
 * evidence either way and stays unknown (no badge), never "doesn't fit".
 */
export function describeCatalogFood(food: FoodDescription, foodId: string | undefined): FoodDescription {
  if (food.thinnrApproved !== undefined) return food;
  if (isApprovedFood(foodId)) return { ...food, thinnrApproved: true };
  if (foodId?.startsWith(SEEDED_CATALOG_PREFIX)) return { ...food, thinnrApproved: false };
  return food;
}

/** Classify a catalog food, letting the Approved Foods list decide during the protocol. */
export function classifyCatalogFood(food: FoodDescription, foodId: string | undefined, context: ClassifierContext): FitResult {
  return classifyFood(context.phase === 'protocol' ? describeCatalogFood(food, foodId) : food, context);
}
