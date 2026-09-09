/**
 * Authenticated mobile seam for the growing food catalog.
 *
 * Kept deliberately small until /food-catalog is part of the generated
 * workspace client. The exported types mirror that contract, while the
 * defensive parser prevents incomplete upstream products from becoming
 * loggable foods.
 */
import type { FoodItem } from '@/data/patient-data';
import { parseNutritionSnapshot, type FoodNutritionSnapshot } from '@/data/food-nutrition';
// @ts-ignore
import { catalogSearch, catalogSelect, catalogFamily } from '@workspace/api-client-react';

export type CatalogGroup = 'common' | 'personal' | 'branded';
export type CatalogSource = 'usda' | 'thinnr' | 'openfoodfacts' | 'personal' | 'catalog';

export interface CatalogFood extends FoodItem {
  catalogId: string;
  group: CatalogGroup;
  source: CatalogSource;
  sourceLabel: string;
  approved: boolean;
  /** Search-time identity, retained when selection promotes an off: row. */
  lookupId?: string;
  selectionToken?: string;
  servingGrams?: number;
  measures: Array<{ label: string; grams: number }>;
  canonicalName?: string;
  resultKey?: string;
  familyKey?: string;
  familyKeyAliases?: string[];
  variantSummary?: string;
  dimensions?: Record<string, string>;
  choiceRequired?: boolean;
  nutritionSnapshot?: FoodNutritionSnapshot;
}

export interface CatalogSearchResult {
  common: CatalogFood[];
  personal: CatalogFood[];
  branded: CatalogFood[];
  results?: CatalogFood[];
  upstreamUnavailable: boolean;
  message?: string;
  hasMore?: boolean;
  nextCursor?: string;
  rankingVersion?: string;
  querySuggestions?: string[];
  correctedQuery?: string;
}

/** A private lookup copy only; it is never sent through the custom-food rail. */
export function catalogFoodSnapshot(food: CatalogFood): FoodItem {
  return {
    id: food.catalogId,
    name: food.name,
    ...(food.brand ? { brand: food.brand } : {}),
    serving: food.serving,
    calories: food.calories,
    protein: food.protein,
    carbs: food.carbs,
    fat: food.fat,
    category: food.group === 'branded' ? 'Branded Products' : 'Common Foods',
    catalogShared: true,
    catalogSourceLabel: food.sourceLabel,
    catalogApproved: food.approved,
    ...(food.lookupId ? { catalogLookupId: food.lookupId } : {}),
    ...(food.servingGrams ? { catalogServingGrams: food.servingGrams } : {}),
    catalogMeasures: food.measures,
    ...(food.canonicalName ? { catalogCanonicalName: food.canonicalName } : {}),
    ...(food.nutritionSnapshot ? { nutritionSnapshot: food.nutritionSnapshot } : {}),
  };
}

export interface CatalogSearchOptions {
  approvedOnly?: boolean;
  includeBranded?: boolean;
  signal?: AbortSignal;
}

export class FoodCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FoodCatalogError';
  }
}

/** Runs dependent mutations without allowing an account switch between them. */
export async function runAccountGuardedSteps<T, U>(
  first: () => Promise<T>,
  second: (value: T) => Promise<U>,
  isCurrent: () => boolean,
): Promise<{ status: 'complete'; first: T; second: U } | { status: 'stale' }> {
  const firstValue = await first();
  if (!isCurrent()) return { status: 'stale' };
  const secondValue = await second(firstValue);
  if (!isCurrent()) return { status: 'stale' };
  return { status: 'complete', first: firstValue, second: secondValue };
}

const CATALOG_UNAVAILABLE_MESSAGE = 'Shared food search is unavailable right now. Please try again.';

/** Never let proxy/server diagnostics become patient-facing food-search copy. */
export function catalogErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return CATALOG_UNAVAILABLE_MESSAGE;
  const message = error.message.trim();
  if (
    !message ||
    /^HTTP\s+\d{3}\b/i.test(message) ||
    /<(?:!doctype|html|head|body|pre)\b/i.test(message) ||
    /\bCannot\s+(?:GET|POST|PUT|PATCH|DELETE)\b/i.test(message)
  ) {
    return CATALOG_UNAVAILABLE_MESSAGE;
  }
  return message.slice(0, 300);
}

const SOURCE_LABELS: Record<CatalogSource, string> = {
  usda: 'USDA FoodData Central',
  thinnr: 'THINNR catalog',
  openfoodfacts: 'Open Food Facts',
  personal: 'My Foods',
  catalog: 'Food catalog',
};

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function sourceOf(value: unknown, group: CatalogGroup): CatalogSource {
  if (value === 'usda' || value === 'thinnr' || value === 'openfoodfacts' || value === 'personal') {
    return value;
  }
  if (value === 'usda_fdc') return 'usda';
  if (value === 'patient') return 'personal';
  return group === 'personal' ? 'personal' : group === 'branded' ? 'openfoodfacts' : 'catalog';
}

function parseMeasures(value: unknown): Array<{ label: string; grams: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const measure = raw as Record<string, unknown>;
    return typeof measure.label === 'string' && measure.label.trim() && nonNegative(measure.grams) && measure.grams > 0
      ? [{ label: measure.label.trim().slice(0, 80), grams: measure.grams }]
      : [];
  });
}

/** Public for focused contract regression tests. */
export function parseCatalogFood(raw: unknown, fallbackGroup: CatalogGroup): CatalogFood | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const rawId =
    typeof value.catalogId === 'string' ? value.catalogId :
      typeof value.id === 'string' ? value.id : null;
  if (
    !rawId ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    typeof value.serving !== 'string' ||
    !value.serving.trim() ||
    !nonNegative(value.calories) ||
    !nonNegative(value.protein) ||
    !nonNegative(value.carbs) ||
    !nonNegative(value.fat)
  ) return null;
  const group =
    value.group === 'common' || value.group === 'personal' || value.group === 'branded'
      ? value.group
      : value.kind === 'personal' ? 'personal' : value.kind === 'branded' ? 'branded' : fallbackGroup;
  // The server returns the same raw, owner-scoped custom id the local library
  // and diary use. Keep accepting a short-lived legacy `custom:<id>` response
  // for cached/older servers, but never add that prefix to current requests.
  // Approval metadata can contain null official fields and a structured
  // constraints object; this parser intentionally treats it only as a
  // reviewed-badge signal, so omitted official wording is never invented.
  const catalogId = group === 'personal' && rawId.startsWith('custom:') ? rawId.slice(7) : rawId;
  const source = sourceOf(value.source, group);
  const food: CatalogFood = {
    id: catalogId,
    catalogId,
    name: value.name.trim().slice(0, 120),
    serving: value.serving.trim().slice(0, 80),
    calories: value.calories,
    protein: value.protein,
    carbs: value.carbs,
    fat: value.fat,
    category: group === 'personal' ? 'My Foods' : group === 'branded' ? 'Branded Products' : 'Common Foods',
    group,
    source,
    sourceLabel:
      typeof value.sourceLabel === 'string' && value.sourceLabel.trim()
        ? value.sourceLabel.trim().slice(0, 100)
        : SOURCE_LABELS[source],
    approved: value.approved === true || (Array.isArray(value.approvals) && value.approvals.length > 0),
    lookupId: rawId,
    measures: parseMeasures(value.measures),
  };
  if (nonNegative(value.servingGrams) && value.servingGrams > 0) food.servingGrams = value.servingGrams;
  if (typeof value.canonicalName === 'string' && value.canonicalName.trim()) {
    food.canonicalName = value.canonicalName.trim().slice(0, 160);
  }
  if (typeof value.brand === 'string' && value.brand.trim()) food.brand = value.brand.trim().slice(0, 80);
  if (typeof value.selectionToken === 'string' && value.selectionToken) {
    food.selectionToken = value.selectionToken;
  }
  if (typeof value.resultKey === 'string') food.resultKey = value.resultKey;
  if (typeof value.familyKey === 'string') food.familyKey = value.familyKey;
  if (Array.isArray(value.familyKeyAliases)) {
    food.familyKeyAliases = Array.from(new Set(value.familyKeyAliases
      .filter((alias): alias is string => typeof alias === 'string' && !!alias.trim())
      .map(alias => alias.trim().slice(0, 160))));
  }
  if (typeof value.variantSummary === 'string') food.variantSummary = value.variantSummary;
  if (value.dimensions && typeof value.dimensions === 'object') food.dimensions = value.dimensions as Record<string, string>;
  if (typeof value.choiceRequired === 'boolean') food.choiceRequired = value.choiceRequired;
  if (value.nutritionSnapshot !== undefined) {
    const snapshot = parseNutritionSnapshot(value.nutritionSnapshot);
    if (snapshot) food.nutritionSnapshot = snapshot;
  }

  return food;
}

/** Accepts the grouped response and the early flat-items draft of the API. */
export function parseCatalogSearch(raw: unknown): CatalogSearchResult {
  if (!raw || typeof raw !== 'object') throw new FoodCatalogError('The food catalog sent an unexpected response.');
  const value = raw as Record<string, unknown>;
  const grouped: Record<CatalogGroup | 'results', CatalogFood[]> = { common: [], personal: [], branded: [], results: [] };
  for (const group of ['common', 'personal', 'branded'] as const) {
    const rows = Array.isArray(value[group]) ? value[group] : [];
    grouped[group] = rows
      .map(row => parseCatalogFood(row, group))
      .filter((row): row is CatalogFood => row !== null);
  }
  if (Array.isArray(value.items)) {
    for (const row of value.items) {
      const parsed = parseCatalogFood(row, 'common');
      if (parsed) grouped[parsed.group].push(parsed);
    }
  }
  if (Array.isArray(value.results)) {
    for (const row of value.results) {
      const parsed = parseCatalogFood(row, 'common');
      if (parsed) {
        grouped.results.push(parsed);
        if (!grouped[parsed.group].some(existing => existing.catalogId === parsed.catalogId)) {
          grouped[parsed.group].push(parsed);
        }
      }
    }
  }
  const status = typeof value.upstreamStatus === 'string' ? value.upstreamStatus : '';
  return {
    ...grouped,
    upstreamUnavailable:
      value.upstreamUnavailable === true ||
      value.externalUnavailable === true ||
      status === 'unavailable' ||
      status === 'offline',
    ...(typeof value.message === 'string' && value.message.trim()
      ? { message: value.message.trim().slice(0, 300) }
      : {}),
    hasMore: value.hasMore === true,
    nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : undefined,
    rankingVersion: typeof value.rankingVersion === 'string' ? value.rankingVersion : undefined,
    querySuggestions: Array.isArray(value.querySuggestions)
      ? value.querySuggestions
          .filter((suggestion): suggestion is string => typeof suggestion === 'string' && !!suggestion.trim())
          .map(suggestion => suggestion.trim().slice(0, 80))
          .slice(0, 4)
      : undefined,
    correctedQuery: typeof value.correctedQuery === 'string' && value.correctedQuery.trim()
      ? value.correctedQuery.trim().slice(0, 80)
      : undefined,
  };
}

export interface CatalogSearchOptions {
  approvedOnly?: boolean;
  includeBranded?: boolean;
  signal?: AbortSignal;
  grouped?: boolean;
  intent?: 'basic' | 'packaged';
  cursor?: string;
  limit?: number;
}

export async function searchFoodCatalog(
  query: string,
  options: CatalogSearchOptions = {},
): Promise<CatalogSearchResult> {
  try {
    const result = parseCatalogSearch(await catalogSearch({
      q: query.trim(),
      limit: options.limit ?? 30,
      branded: options.includeBranded !== false && options.approvedOnly !== true,
      // @ts-ignore - waiting for codegen
      grouped: options.grouped,
      // @ts-ignore - waiting for codegen
      intent: options.intent,
      // @ts-ignore - waiting for codegen
      cursor: options.cursor,
      // @ts-ignore - waiting for codegen
      approvedOnly: options.approvedOnly,
    }, { signal: options.signal }));
    if (options.approvedOnly) {
      result.common = result.common.filter(food => food.approved);
      result.personal = [];
      result.branded = [];
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new FoodCatalogError(catalogErrorMessage(error));
  }
}

/** Records usage and promotes a valid external result through the server-owned upsert path. */
export async function selectCatalogFood(food: CatalogFood, signal?: AbortSignal): Promise<CatalogFood> {
  try {
    const result = await catalogSelect({ id: food.catalogId }, { signal });
    const selected = parseCatalogFood(result.food, food.group) ?? {
      ...food,
      catalogId: result.selectedId,
      id: result.selectedId,
    };
    return preserveSelectedCatalogDraft(food, selected);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new FoodCatalogError(
      error instanceof Error && error.message ? error.message : 'That food could not be selected right now.',
    );
  }
}

/**
 * Promotion assigns a stable catalog id, but the exact search/detail draft is
 * the patient-reviewed nutrition record. A technical lookup projection must
 * never replace its friendly name, family dimensions, portions, or immutable
 * source snapshot with a family default.
 */
export function preserveSelectedCatalogDraft(
  draft: CatalogFood,
  promoted: CatalogFood,
): CatalogFood {
  return {
    ...promoted,
    ...draft,
    id: promoted.catalogId,
    catalogId: promoted.catalogId,
    ...(draft.lookupId || promoted.lookupId
      ? { lookupId: draft.lookupId ?? promoted.lookupId }
      : {}),
    ...(promoted.selectionToken || draft.selectionToken
      ? { selectionToken: promoted.selectionToken ?? draft.selectionToken }
      : {}),
  };
}

export async function getFamilyVariants(familyKey: string, approvedOnly?: boolean, signal?: AbortSignal): Promise<CatalogFood[]> {
  try {
    if (typeof catalogFamily !== 'function') {
      return [];
    }
    const result = await catalogFamily(familyKey, { approvedOnly }, { signal });
    if (!result || !Array.isArray(result.variants)) return [];
    return result.variants.map((v: unknown) => parseCatalogFood(v, 'common')).filter((f: CatalogFood | null): f is CatalogFood => f !== null);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new FoodCatalogError(
      error instanceof Error && error.message ? error.message : 'Could not load food variants.',
    );
  }
}
