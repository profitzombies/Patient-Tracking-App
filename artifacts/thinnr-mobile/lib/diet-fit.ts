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
  calculateTargets,
  classifyFood,
  derivePhase,
  mifflinStJeor,
  programDayBetween,
  PROTOCOL_LENGTH_DAYS,
  type ActivityLevel,
  type ClassifierContext,
  type FitResult,
  type FitVerdict,
  type FoodDescription,
  type PhaseState,
  type PreferenceItemInput,
  type TargetInput,
  type TargetOverrides,
} from '@workspace/diet-programs';

/** Attach the Approved Foods answer for a catalog food id before classifying. */
export function describeCatalogFood(food: FoodDescription, foodId: string | undefined): FoodDescription {
  if (food.thinnrApproved !== undefined) return food;
  return { ...food, thinnrApproved: isApprovedFood(foodId) };
}

/** Classify a catalog food, letting the Approved Foods list decide during the protocol. */
export function classifyCatalogFood(food: FoodDescription, foodId: string | undefined, context: ClassifierContext): FitResult {
  return classifyFood(context.phase === 'protocol' ? describeCatalogFood(food, foodId) : food, context);
}
