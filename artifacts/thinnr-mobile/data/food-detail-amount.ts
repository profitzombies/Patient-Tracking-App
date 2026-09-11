/**
 * Compatibility adapter for foods that predate nutrition snapshots.
 *
 * The detail screen works with the same immutable source/basis model for both
 * catalog snapshots and the older FoodItem rows.  This adapter is deliberately
 * conservative: a legacy row gets a source portion and its four legacy macro
 * values, but weight choices are added only when a gram relationship is
 * actually recorded.  In particular, a household measure is never treated as
 * eight ounces just because it is a cup.
 */
import type { LoggableItem } from '@/hooks/useLoggableItems';
import {
  nutritionPortionDimension,
  nutritionPortionPresentation,
  parseNutritionSnapshot,
  selectSnapshotPortion,
  selectSnapshotDisplayedPortion,
  type FoodNutritionSnapshot,
} from './food-nutrition';

export interface LegacyFoodDetailSelection {
  /** Number of original servings when no weighed amount is selected. */
  quantity: number;
  /** Existing legacy weighed selection, when one was stored. */
  ounces?: number;
}

interface LegacyMeasure {
  grams: number;
  evidence: string;
}

interface ParsedServing {
  amount: number;
  unit: string;
  dimension: FoodNutritionSnapshot['portions'][number]['dimension'];
}

const GRAMS_PER_OUNCE = 28.349523125;
const MAX_AMOUNT = 1_000_000;

const BROWN_RICE_ID = 'fd_brown_rice';
const BROWN_RICE_SOURCE_GRAMS_PER_CUP = 195;
const BROWN_RICE_SOURCE_EVIDENCE =
  'USDA FoodData Central SR Legacy FDC 168875, Rice, brown, medium-grain, cooked: 1 cup = 195 g. ' +
  'https://fdc.nal.usda.gov/food-details/168875/nutrients';

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_AMOUNT;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT;
}

function normalizeUnit(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === 'cups') return 'cup';
  if (normalized === 'tablespoon' || normalized === 'tablespoons') return 'tbsp';
  if (normalized === 'teaspoon' || normalized === 'teaspoons') return 'tsp';
  if (normalized === 'ounces' || normalized === 'ounce') return 'oz';
  if (normalized === 'grams' || normalized === 'gram') return 'g';
  if (normalized === 'milliliters' || normalized === 'milliliter') return 'ml';
  if (normalized === 'fluid ounce' || normalized === 'fluid ounces') return 'fl oz';
  return normalized;
}

function parseServing(label: string): ParsedServing {
  const normalized = label.trim().replace(/\s+/g, ' ');
  /*
   * nutritionPortionPresentation owns the household-label parser (mixed
   * fractions, unicode fractions, qualifiers, and pluralization).  Start with
   * an undetermined provisional portion so its label-derived unit wins.
   */
  const presentation = nutritionPortionPresentation({
    id: 'legacy-source',
    label: normalized,
    unit: 'undetermined',
    dimension: 'serving',
    basisMultiplier: 1,
  });
  const unit = normalizeUnit(presentation.singular);
  const weight = /^(?:g|gram|grams|oz|ounce|ounces|kg|kilogram|kilograms)$/.test(unit);
  const provisional: FoodNutritionSnapshot['portions'][number] = {
    id: 'legacy-source',
    label: normalized,
    unit,
    dimension: weight ? 'weight' : 'serving',
    basisMultiplier: 1,
  };
  const amount = presentation.sourceAmount;
  const dimension = weight ? 'weight' : nutritionPortionDimension(provisional);
  return { amount, unit, dimension };
}

function exactSourceGrams(
  item: LoggableItem,
  serving: ParsedServing,
): LegacyMeasure | null {
  /*
   * Recorded source weights always win over a calculated conversion.  This is
   * important for legacy labels such as 4 oz = 113 g: preserving 113 is part
   * of the source record, rather than silently replacing it with 113.398...
   */
  const catalogGrams = item.catalog?.servingGrams;
  if (finitePositive(catalogGrams)) {
    return {
      grams: catalogGrams,
      evidence: item.catalog?.sourceLabel
        ? `${item.catalog.sourceLabel}: recorded serving weight ${catalogGrams} g.`
        : `Recorded serving weight ${catalogGrams} g.`,
    };
  }

  const sourceLabel = item.serving.trim().replace(/\s+/g, ' ').toLowerCase();
  const matchingMeasure = item.catalog?.measures.find((measure: { label: string; grams: number }) =>
    typeof measure.label === 'string' &&
    measure.label.trim().replace(/\s+/g, ' ').toLowerCase() === sourceLabel &&
    finitePositive(measure.grams),
  );
  if (matchingMeasure) {
    return {
      grams: matchingMeasure.grams,
      evidence: item.catalog?.sourceLabel
        ? `${item.catalog.sourceLabel}: recorded ${matchingMeasure.label} = ${matchingMeasure.grams} g.`
        : `Recorded source measure ${matchingMeasure.label} = ${matchingMeasure.grams} g.`,
    };
  }

  /*
   * This is an item-specific USDA portion, not the generic recipe-rice
   * heuristic.  The food seed is 1 cup; retaining the source amount also makes
   * a deliberately edited legacy row (for example, 1/2 cup) scale to the same
   * documented 195 g/cup relationship without guessing another density.
   */
  if (item.refId === BROWN_RICE_ID && serving.unit === 'cup') {
    const grams = serving.amount * BROWN_RICE_SOURCE_GRAMS_PER_CUP;
    return {
      grams,
      evidence: BROWN_RICE_SOURCE_EVIDENCE,
    };
  }

  // Exact conversions are the last resort when no source weight was recorded.
  if (serving.unit === 'g') {
    return {
      grams: serving.amount,
      evidence: 'Legacy source serving states grams directly.',
    };
  }
  if (serving.unit === 'oz') {
    return {
      grams: serving.amount * GRAMS_PER_OUNCE,
      evidence: 'Exact avoirdupois conversion from the legacy ounce serving statement.',
    };
  }
  return null;
}

function sourceEvidence(item: LoggableItem, measure: LegacyMeasure | null): string | undefined {
  if (measure) return measure.evidence;
  if (item.catalog?.sourceLabel) return `${item.catalog.sourceLabel}: original serving statement.`;
  return 'Legacy food serving statement; no weight conversion is documented.';
}

function sourceProvider(item: LoggableItem): string {
  /*
   * Keep catalog attribution attached to the generated snapshot.  Legacy seed
   * rows have no provider metadata and are explicitly labelled as adapted
   * rather than being misrepresented as USDA/OFF records.
   */
  return item.catalog?.sourceLabel?.trim() || 'legacy';
}

function sourceRevision(item: LoggableItem): string {
  return item.catalog?.resultKey?.trim() ||
    item.catalog?.lookupId?.trim() ||
    'legacy-v1';
}

function canAdapt(item: LoggableItem): boolean {
  return item.kind === 'food';
}

function portionId(unit: string): string {
  if (unit === 'oz') return 'ounce';
  if (unit === 'g') return 'gram';
  return 'legacy-source';
}

/**
 * Adapt a snapshotless legacy food into the version-one nutrition contract.
 *
 * `selection.quantity` is an original-serving multiplier, not the displayed
 * number.  That distinction matters for labels such as "1/2 cup": quantity 2
 * means two original servings (displayed as 1 cup), not four servings.
 *
 * A stored legacy `ounces` selection takes precedence over `quantity` and is
 * applied once.  It is honored only when the source has a documented gram
 * relationship; otherwise the adapter safely falls back to the original
 * measure.  An existing valid snapshot is returned unchanged.
 */
export function createLegacyFoodDetailSnapshot(
  item: LoggableItem,
  selection?: LegacyFoodDetailSelection,
): FoodNutritionSnapshot | null {
  if (!canAdapt(item)) return null;
  const existing = item.nutritionSnapshot ?? item.catalog?.nutritionSnapshot;
  if (existing !== undefined) return parseNutritionSnapshot(existing);
  if (
    !finiteNonNegative(item.calories) ||
    !Number.isFinite(item.protein) || item.protein < 0 ||
    !Number.isFinite(item.carbs) || item.carbs < 0 ||
    !Number.isFinite(item.fat) || item.fat < 0 ||
    typeof item.serving !== 'string' || !item.serving.trim() ||
    typeof item.name !== 'string' || !item.name.trim() ||
    typeof item.refId !== 'string' || !item.refId.trim()
  ) return null;

  const servingLabel = item.serving.trim();
  const serving = parseServing(servingLabel);
  if (!finitePositive(serving.amount) || !serving.unit) return null;

  const sourceMeasure = exactSourceGrams(item, serving);
  const sourceId = portionId(serving.unit);
  const portions: FoodNutritionSnapshot['portions'] = [{
    id: sourceId,
    label: servingLabel,
    unit: serving.unit,
    dimension: serving.dimension,
    basisMultiplier: 1,
    ...(sourceMeasure ? { grams: sourceMeasure.grams } : {}),
    ...(sourceEvidence(item, sourceMeasure) ? { evidence: sourceEvidence(item, sourceMeasure) } : {}),
  }];

  if (sourceMeasure) {
    const ounceId = sourceId === 'ounce' ? null : 'ounce';
    const gramId = sourceId === 'gram' ? null : 'gram';
    if (ounceId) {
      portions.push({
        id: ounceId,
        label: 'oz',
        unit: 'oz',
        dimension: 'weight',
        basisMultiplier: GRAMS_PER_OUNCE / sourceMeasure.grams,
        grams: GRAMS_PER_OUNCE,
        evidence: sourceMeasure.evidence,
      });
    }
    if (gramId) {
      portions.push({
        id: gramId,
        label: 'g',
        unit: 'g',
        dimension: 'weight',
        basisMultiplier: 1 / sourceMeasure.grams,
        grams: 1,
        evidence: sourceMeasure.evidence,
      });
    }
  }

  const baseline: FoodNutritionSnapshot = {
    version: 1,
    source: {
      provider: sourceProvider(item),
      recordId: item.catalog?.catalogId ?? item.refId,
      revision: sourceRevision(item),
      canonicalName: item.catalog?.canonicalName ?? item.name.trim(),
    },
    basis: {
      amount: serving.amount,
      unit: serving.unit,
      label: servingLabel,
      ...(sourceMeasure ? { grams: sourceMeasure.grams } : {}),
    },
    nutrients: [
      { id: 'energy', name: 'Energy', unit: 'kcal', amount: item.calories },
      { id: 'protein', name: 'Protein', unit: 'g', amount: item.protein },
      { id: 'carbohydrate', name: 'Carbohydrate', unit: 'g', amount: item.carbs },
      { id: 'fat', name: 'Total Fat', unit: 'g', amount: item.fat },
    ],
    portions,
    selected: { amount: 1, unitId: sourceId, scale: 1 },
    provenance: item.catalog?.source === 'openfoodfacts'
      ? 'identified_product'
      : item.catalog?.group === 'personal' || item.catalog?.source === 'personal'
        ? 'personal_label'
        : 'generic_source',
  };

  const parsed = parseNutritionSnapshot(baseline);
  if (!parsed) return null;

  let selectedSnapshot = parsed;
  if (selection?.ounces !== undefined && finitePositive(selection.ounces) && sourceMeasure) {
    const ounce = parsed.portions.find(portion => portion.id === 'ounce');
    if (ounce) {
      selectedSnapshot = selectSnapshotDisplayedPortion(parsed, selection.ounces, ounce.id) ?? parsed;
    }
  } else if (selection?.quantity !== undefined && finitePositive(selection.quantity)) {
    selectedSnapshot = selectSnapshotPortion(parsed, selection.quantity, sourceId) ?? parsed;
  }
  return selectedSnapshot;
}