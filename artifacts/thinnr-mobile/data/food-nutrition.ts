export type NutritionProvenance =
  | 'generic_source'
  | 'generic_dish_estimate'
  | 'identified_product'
  | 'personal_label';

export interface FoodNutritionSnapshot {
  version: 1;
  source: {
    provider: string;
    recordId: string;
    release?: string;
    revision: string;
    canonicalName?: string;
  };
  basis: {
    amount: number;
    unit: string;
    label: string;
    grams?: number;
  };
  nutrients: Array<{
    id: string;
    name: string;
    unit: string;
    amount: number;
  }>;
  portions: Array<{
    id: string;
    label: string;
    unit: string;
    dimension: 'weight' | 'volume' | 'count' | 'serving';
    basisMultiplier: number;
    grams?: number;
    evidence?: string;
  }>;
  variant?: {
    familyKey: string;
    summary: string;
    dimensions: Record<string, string>;
  };
  selected: {
    amount: number;
    unitId: string;
    scale: number;
  };
  provenance: NutritionProvenance;
}

const DIMENSIONS = new Set(['weight', 'volume', 'count', 'serving']);
const PROVENANCE = new Set([
  'generic_source',
  'generic_dish_estimate',
  'identified_product',
  'personal_label',
]);
const MAX_NUTRIENTS = 200;
const MAX_PORTIONS = 100;
const MAX_TEXT = 500;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Strictly validates the version-one wire snapshot. Invalid optional snapshots
 * are returned as null so legacy foods remain usable, while callers validating
 * a supplied snapshot can reject it explicitly.
 */
export function parseNutritionSnapshot(value: unknown): FoodNutritionSnapshot | null {
  try {
    if (JSON.stringify(value).length > 64_000) return null;
  } catch {
    return null;
  }
  const root = record(value);
  const source = record(root?.source);
  const basis = record(root?.basis);
  const selected = record(root?.selected);
  if (
    root?.version !== 1 ||
    !source ||
    !text(source.provider, 80) ||
    !text(source.recordId, 160) ||
    !text(source.revision, 160) ||
    (source.release !== undefined && !text(source.release, 160)) ||
    (source.canonicalName !== undefined && !text(source.canonicalName)) ||
    !basis ||
    !finitePositive(basis.amount) || basis.amount > 1_000_000 ||
    !text(basis.unit, 40) ||
    !text(basis.label, 160) ||
    (basis.grams !== undefined && (!finitePositive(basis.grams) || basis.grams > 1_000_000)) ||
    !Array.isArray(root.nutrients) ||
    root.nutrients.length < 1 ||
    root.nutrients.length > MAX_NUTRIENTS ||
    !Array.isArray(root.portions) ||
    root.portions.length < 1 ||
    root.portions.length > MAX_PORTIONS ||
    !selected ||
    !finitePositive(selected.amount) || selected.amount > 1_000_000 ||
    !text(selected.unitId, 120) ||
    !finitePositive(selected.scale) || selected.scale > 1_000_000 ||
    typeof root.provenance !== 'string' ||
    !PROVENANCE.has(root.provenance)
  ) return null;

  const nutrients: FoodNutritionSnapshot['nutrients'] = [];
  const nutrientIds = new Set<string>();
  for (const raw of root.nutrients) {
    const nutrient = record(raw);
    if (
      !nutrient ||
      !text(nutrient.id, 120) ||
      nutrientIds.has(nutrient.id) ||
      !text(nutrient.name, 160) ||
      !text(nutrient.unit, 40) ||
      !finiteNonNegative(nutrient.amount) ||
      nutrient.amount > 10_000_000
    ) return null;
    nutrientIds.add(nutrient.id);
    nutrients.push({
      id: nutrient.id,
      name: nutrient.name.trim(),
      unit: nutrient.unit.trim(),
      amount: nutrient.amount,
    });
  }

  const portions: FoodNutritionSnapshot['portions'] = [];
  const portionIds = new Set<string>();
  for (const raw of root.portions) {
    const portion = record(raw);
    if (
      !portion ||
      !text(portion.id, 120) ||
      portionIds.has(portion.id) ||
      !text(portion.label, 160) ||
      !text(portion.unit, 40) ||
      typeof portion.dimension !== 'string' ||
      !DIMENSIONS.has(portion.dimension) ||
      !finitePositive(portion.basisMultiplier) ||
      portion.basisMultiplier > 1_000_000 ||
      (portion.grams !== undefined &&
        (!finitePositive(portion.grams) || portion.grams > 1_000_000)) ||
      (portion.evidence !== undefined && !text(portion.evidence))
    ) return null;
    portionIds.add(portion.id);
    portions.push({
      id: portion.id,
      label: portion.label.trim(),
      unit: portion.unit.trim(),
      dimension: portion.dimension as FoodNutritionSnapshot['portions'][number]['dimension'],
      basisMultiplier: portion.basisMultiplier,
      ...(portion.grams !== undefined ? { grams: portion.grams } : {}),
      ...(portion.evidence !== undefined ? { evidence: portion.evidence.trim() } : {}),
    });
  }
  if (!portionIds.has(selected.unitId)) return null;
  const selectedPortion = portions.find(portion => portion.id === selected.unitId);
  if (!selectedPortion) return null;
  const expectedScale = selected.amount * selectedPortion.basisMultiplier;
  if (Math.abs(expectedScale - selected.scale) > Math.max(1e-10, expectedScale * 1e-10)) {
    return null;
  }

  let variant: FoodNutritionSnapshot['variant'];
  if (root.variant !== undefined) {
    const rawVariant = record(root.variant);
    const dimensions = record(rawVariant?.dimensions);
    if (!rawVariant || !text(rawVariant.familyKey, 160) || !text(rawVariant.summary, 300) || !dimensions) {
      return null;
    }
    const cleanDimensions: Record<string, string> = {};
    const pairs = Object.entries(dimensions);
    if (pairs.length > 20) return null;
    for (const [key, dimensionValue] of pairs) {
      if (!text(key, 80) || !text(dimensionValue, 160)) return null;
      cleanDimensions[key] = dimensionValue.trim();
    }
    variant = {
      familyKey: rawVariant.familyKey.trim(),
      summary: rawVariant.summary.trim(),
      dimensions: cleanDimensions,
    };
  }

  return {
    version: 1,
    source: {
      provider: source.provider.trim(),
      recordId: source.recordId.trim(),
      ...(source.release !== undefined ? { release: source.release.trim() } : {}),
      revision: source.revision.trim(),
      ...(source.canonicalName !== undefined ? { canonicalName: source.canonicalName.trim() } : {}),
    },
    basis: {
      amount: basis.amount,
      unit: basis.unit.trim(),
      label: basis.label.trim(),
      ...(basis.grams !== undefined ? { grams: basis.grams } : {}),
    },
    nutrients,
    portions,
    ...(variant ? { variant } : {}),
    selected: {
      amount: selected.amount,
      unitId: selected.unitId.trim(),
      scale: selected.scale,
    },
    provenance: root.provenance as NutritionProvenance,
  };
}

export function snapshotPortion(
  snapshot: FoodNutritionSnapshot,
  unitId: string = snapshot.selected.unitId,
): FoodNutritionSnapshot['portions'][number] | undefined {
  return snapshot.portions.find(portion => portion.id === unitId);
}

export type NutritionPortion = FoodNutritionSnapshot['portions'][number];

export interface NutritionPortionPresentation {
  /** Number of displayed household units represented by one source portion. */
  sourceAmount: number;
  singular: string;
  plural: string;
  shortLabel: string;
  qualifier?: string;
}

const LEADING_PORTION_AMOUNT = /^(\d+\s+\d+\/\d+|\d+\/\d+|[¼½¾]|\d+(?:\.\d+)?)\s+(.+)$/;
const SIMPLE_UNIT = /^([a-zA-Z]+)(?=$|[\s,(])/;
const MULTI_WORD_UNIT = /^(fluid ounces?|fl\.?\s*oz|milliliters?|ml|cubic inch(?:es)?)\b/i;

function fractionNumber(value: string): number | null {
  if (value === '¼') return 0.25;
  if (value === '½') return 0.5;
  if (value === '¾') return 0.75;
  const pieces = value.trim().split(/\s+/);
  let total = 0;
  for (const piece of pieces) {
    if (piece.includes('/')) {
      const [numerator, denominator] = piece.split('/').map(Number);
      if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
      total += numerator / denominator;
    } else {
      const number = Number(piece);
      if (!finitePositive(number)) return null;
      total += number;
    }
  }
  return finitePositive(total) ? total : null;
}

function singularize(unit: string): string {
  const normalized = unit.toLowerCase();
  if (/^(?:g|gram|grams)$/.test(normalized)) return 'g';
  if (/^(?:oz|ounce|ounces)$/.test(normalized)) return 'oz';
  if (normalized === 'cubic inches') return 'cubic inch';
  if (normalized.endsWith('ies')) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith('ses')) return normalized.slice(0, -2);
  if (normalized.endsWith('s') && !normalized.endsWith('ss')) return normalized.slice(0, -1);
  return normalized;
}

function pluralize(unit: string): string {
  if (unit === 'g' || unit === 'oz' || unit === 'fl oz' || unit === 'ml') return unit;
  if (unit.endsWith('y')) return `${unit.slice(0, -1)}ies`;
  if (unit.endsWith('ch')) return `${unit}es`;
  if (unit.endsWith('s')) return unit;
  return `${unit}s`;
}

/**
 * Derives editable, human-facing semantics without mutating the immutable
 * source label, quantity, gram statement, multiplier, or evidence.
 */
export function nutritionPortionPresentation(portion: NutritionPortion): NutritionPortionPresentation {
  const label = portion.label.trim().replace(/\s+/g, ' ');
  const leading = label.match(LEADING_PORTION_AMOUNT);
  const sourceAmount = leading ? fractionNumber(leading[1]) ?? 1 : 1;
  const remainder = leading ? leading[2] : label;
  const labelUnit = remainder.match(MULTI_WORD_UNIT)?.[1] ?? remainder.match(SIMPLE_UNIT)?.[1];
  const rawUnit = GRAM_OR_OUNCE_UNIT.test(portion.unit)
    ? portion.unit
    : labelUnit ?? (portion.unit !== 'undetermined' ? portion.unit : 'serving');
  const singular = singularize(rawUnit);
  const plural = pluralize(singular);
  const consumedUnit = labelUnit
    ? remainder.slice(labelUnit.length).replace(/^[\s,]+/, '').trim()
    : '';
  return {
    sourceAmount,
    singular,
    plural,
    shortLabel: singular === 'oz' ? 'Ounces'
      : singular === 'g' ? 'Grams'
        : singular === 'fl oz' || singular === 'fluid ounce' ? 'Fluid ounces'
          : singular === 'ml' || singular === 'milliliter' ? 'Milliliters'
            : singular === 'cubic inch' ? 'Cubic inches'
        : `${singular.charAt(0).toUpperCase()}${plural.slice(1)}`,
    ...(consumedUnit ? { qualifier: consumedUnit.replace(/^\((.*)\)$/, '$1') } : {}),
  };
}

export function nutritionPortionDimension(
  portion: NutritionPortion,
): 'weight' | 'volume' | 'count' | 'serving' {
  const unit = nutritionPortionPresentation(portion).singular;
  if (/^(?:fluid ounce|fl\.?\s*oz|milliliter|ml|cubic inch)$/.test(unit)) {
    return 'volume';
  }
  if (portion.dimension !== 'serving') return portion.dimension;
  if (/^(?:cup|tablespoon|tbsp|teaspoon|tsp)$/.test(unit)) return 'volume';
  // Source-classified "serving" portions admitted by availableNutritionPortions
  // have documented grams and evidence. A concrete noun is a count measure;
  // generic serving labels remain serving-only.
  return /^(?:serving|portion|unit)$/.test(unit) ? 'serving' : 'count';
}

export function snapshotDisplayedAmount(
  snapshot: FoodNutritionSnapshot,
  portion: NutritionPortion = snapshotPortion(snapshot)!,
): number {
  return snapshot.selected.amount * nutritionPortionPresentation(portion).sourceAmount;
}

export function selectSnapshotDisplayedPortion(
  snapshot: FoodNutritionSnapshot,
  displayedAmount: number,
  unitId: string,
): FoodNutritionSnapshot | null {
  const portion = snapshotPortion(snapshot, unitId);
  if (!portion || !finitePositive(displayedAmount)) return null;
  return selectSnapshotPortion(
    snapshot,
    displayedAmount / nutritionPortionPresentation(portion).sourceAmount,
    unitId,
  );
}

export function formatNutritionAmount(snapshot: FoodNutritionSnapshot): {
  text: string;
  amount: number;
  unit: string;
  qualifier?: string;
} {
  const portion = snapshotPortion(snapshot);
  if (!portion) {
    return { text: `${snapshot.selected.amount} ${snapshot.selected.unitId}`, amount: snapshot.selected.amount, unit: snapshot.selected.unitId };
  }
  const presentation = nutritionPortionPresentation(portion);
  const amount = snapshotDisplayedAmount(snapshot, portion);
  const compact = Number(amount.toFixed(4));
  const fraction = nutritionPortionDimension(portion) === 'volume'
    ? new Map([[0.25, '¼'], [0.5, '½'], [0.75, '¾']]).get(compact)
    : undefined;
  const number = fraction ?? compact.toString();
  const unit = amount <= 1 ? presentation.singular : presentation.plural;
  return {
    text: `${number} ${unit}`,
    amount,
    unit,
    ...(presentation.qualifier ? { qualifier: presentation.qualifier } : {}),
  };
}

const VAGUE_PORTION_LABEL = /^(?:(?:quantity|amount)\s+)?(?:not\s+specified|unspecified|undetermined|unknown|not\s+applicable|n\/?a|none)$/i;
const GENERIC_PORTION_LABEL = /^(?:amount|measure|portion|quantity|serving|unit)$/i;
const GRAM_OR_OUNCE_UNIT = /^(?:g|gram|grams|oz|ounce|ounces)$/i;
const GRAM_OR_OUNCE_LABEL = /(?:^|[\s(])(?:\d+(?:\.\d+)?\s*)?(?:g|gram|grams|oz|ounce|ounces)(?=$|[\s,)])/i;

function isUnderstandablePortionLabel(label: string): boolean {
  const normalized = label.trim().replace(/\s+/g, ' ');
  return (
    normalized.length > 0 &&
    !VAGUE_PORTION_LABEL.test(normalized) &&
    !GENERIC_PORTION_LABEL.test(normalized)
  );
}

/**
 * Portions suitable for configuring a new food selection.
 *
 * The snapshot remains the immutable source record: this returns references to
 * its supported portions without deleting raw evidence needed to validate old
 * saved selections. Weight choices are deliberately limited to source-provided
 * grams and ounces. Count and volume choices rely on the source-classified
 * dimension and must have a useful household label. Some source DTOs retain
 * the broader "serving" dimension for a real household/count portion; those
 * remain available only when documented grams and source evidence accompany
 * the meaningful label.
 */
export function availableNutritionPortions(
  snapshot: FoodNutritionSnapshot,
): NutritionPortion[] {
  return snapshot.portions.filter(portion => {
    if (!isUnderstandablePortionLabel(portion.label)) return false;
    if (portion.dimension === 'weight') {
      return (
        GRAM_OR_OUNCE_UNIT.test(portion.unit.trim()) ||
        GRAM_OR_OUNCE_LABEL.test(portion.label.trim())
      );
    }
    if (portion.dimension === 'count' || portion.dimension === 'volume') return true;
    return (
      portion.dimension === 'serving' &&
      portion.grams !== undefined &&
      finitePositive(portion.grams) &&
      portion.evidence !== undefined &&
      text(portion.evidence)
    );
  });
}

/**
 * UI-facing portions. By default, a historical selected portion is retained
 * even when its old label is no longer suitable as a new choice. Pass
 * preserveSelected: false (or call availableNutritionPortions) when starting a
 * new configuration.
 */
export function visibleNutritionPortions(
  snapshot: FoodNutritionSnapshot,
  options: { preserveSelected?: boolean } = {},
): NutritionPortion[] {
  const preserveSelected = options.preserveSelected ?? true;
  if (!preserveSelected) return availableNutritionPortions(snapshot);
  const availableIds = new Set(availableNutritionPortions(snapshot).map(portion => portion.id));
  return snapshot.portions.filter(portion =>
    availableIds.has(portion.id) || portion.id === snapshot.selected.unitId);
}

function isOuncePortion(portion: NutritionPortion): boolean {
  const presentation = nutritionPortionPresentation(portion);
  return portion.dimension === 'weight' && presentation.singular === 'oz';
}

function isGramPortion(portion: NutritionPortion): boolean {
  const presentation = nutritionPortionPresentation(portion);
  return portion.dimension === 'weight' && presentation.singular === 'g';
}

/** Five ounces is an editable convenience for a genuinely fresh weighed draft. */
export function initializeFreshNutritionSnapshot(
  snapshot: FoodNutritionSnapshot,
  options: { foodName?: string; canonicalName?: string } = {},
): FoodNutritionSnapshot {
  const identity = `${options.foodName ?? ''} ${options.canonicalName ?? snapshot.source.canonicalName ?? ''}`;
  const liquid = /\b(?:beverages?|broths?|coffees?|drinks?|juices?|milks?|oils?|sodas?|soups?|teas?|waters?)\b/i;
  const dryMix = /\b(?:concentrate|dried|dry|mix|powder|powdered)\b/i;
  if (liquid.test(identity) && !dryMix.test(identity)) {
    const volume = availableNutritionPortions(snapshot)
      .find(portion => nutritionPortionDimension(portion) === 'volume');
    if (volume) return selectSnapshotDisplayedPortion(snapshot, 1, volume.id) ?? snapshot;
  }
  const ounce = availableNutritionPortions(snapshot).find(isOuncePortion);
  return ounce ? selectSnapshotDisplayedPortion(snapshot, 5, ounce.id) ?? snapshot : snapshot;
}

/**
 * Keeps the primary row compact and useful. Source portions not chosen here
 * remain available under More units and remain byte-for-byte intact.
 */
export function orderedNutritionPortions(
  snapshot: FoodNutritionSnapshot,
  options: { preserveSelected?: boolean } = {},
): NutritionPortion[] {
  const portions = visibleNutritionPortions(snapshot, options);
  const rank = (portion: NutritionPortion): number => {
    const dimension = nutritionPortionDimension(portion);
    if (isOuncePortion(portion)) return 0;
    if (dimension === 'count' && nutritionPortionPresentation(portion).sourceAmount === 1) return 1;
    if (dimension === 'volume') return 2;
    if (isGramPortion(portion)) return 3;
    if (dimension === 'count') return 4;
    return 5;
  };
  return portions.map((portion, index) => ({ portion, index }))
    .sort((left, right) => rank(left.portion) - rank(right.portion) || left.index - right.index)
    .map(({ portion }) => portion);
}

export function equivalentHouseholdPortion(
  from: NutritionPortion,
  candidates: NutritionPortion[],
): NutritionPortion | undefined {
  const fromDimension = nutritionPortionDimension(from);
  if (fromDimension !== 'count' && fromDimension !== 'volume') return undefined;
  const presentation = nutritionPortionPresentation(from);
  return candidates.find(candidate => {
    if (nutritionPortionDimension(candidate) !== fromDimension) return false;
    const next = nutritionPortionPresentation(candidate);
    return next.singular === presentation.singular &&
      (next.qualifier ?? '').toLowerCase() === (presentation.qualifier ?? '').toLowerCase();
  });
}

/** Recomputes from the immutable original basis; edits never compound. */
export function selectSnapshotPortion(
  snapshot: FoodNutritionSnapshot,
  amount: number,
  unitId: string,
): FoodNutritionSnapshot | null {
  if (!finitePositive(amount) || amount > 1_000_000) return null;
  const portion = snapshotPortion(snapshot, unitId);
  if (!portion) return null;
  const scale = amount * portion.basisMultiplier;
  if (!finitePositive(scale) || scale > 1_000_000) return null;
  return {
    ...snapshot,
    selected: { amount, unitId, scale },
  };
}

export function scaledSnapshotNutrients(
  snapshot: FoodNutritionSnapshot,
): FoodNutritionSnapshot['nutrients'] {
  return snapshot.nutrients.map(nutrient => ({
    ...nutrient,
    amount: nutrient.amount * snapshot.selected.scale,
  }));
}

/** Legacy diary macro totals derived directly from the immutable source baseline. */
export function scaledSnapshotMacros(snapshot: FoodNutritionSnapshot): {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
} | null {
  const nutrients = scaledSnapshotNutrients(snapshot);
  const canonical = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const unit = (value: string) => value.toLowerCase().replace(/\s+/g, '');

  const grams = (amount: number, rawUnit: string): number | null => {
    switch (unit(rawUnit)) {
      case 'g': return amount;
      case 'mg': return amount / 1_000;
      case 'µg':
      case 'μg':
      case 'ug':
      case 'mcg': return amount / 1_000_000;
      case 'kg': return amount * 1_000;
      default: return null;
    }
  };
  const kilocalories = (amount: number, rawUnit: string): number | null => {
    switch (unit(rawUnit)) {
      case 'kcal':
      case 'calorie':
      case 'calories': return amount;
      case 'kj': return amount / 4.184;
      default: return null;
    }
  };

  const best = (
    ids: ReadonlySet<string>,
    names: ReadonlySet<string>,
    convert: (amount: number, rawUnit: string) => number | null,
    unitPreference: (rawUnit: string) => number,
  ): number | undefined => {
    let selected: { score: number; amount: number } | undefined;
    for (const nutrient of nutrients) {
      const id = nutrient.id.toLowerCase();
      const name = canonical(nutrient.name);
      const idMatch = ids.has(id);
      const nameMatch = names.has(name);
      if (!idMatch && !nameMatch) continue;
      const amount = convert(nutrient.amount, nutrient.unit);
      if (amount === null) continue;
      const score = (idMatch ? 20 : 10) + unitPreference(nutrient.unit);
      if (!selected || score > selected.score) selected = { score, amount };
    }
    return selected?.amount;
  };

  // OFF can supply both off:energy-kcal and off:energy. Unit preference makes
  // the kcal record authoritative regardless of source order, avoiding a
  // duplicate-energy overwrite or needless kJ conversion.
  const calories = best(
    new Set(['1008', 'energy', 'calories', 'off:energy-kcal', 'off:energy']),
    new Set(['energy', 'calories', 'energy kcal']),
    kilocalories,
    rawUnit => unit(rawUnit) === 'kcal' ? 5 : 0,
  );
  const macroUnitPreference = (rawUnit: string) => unit(rawUnit) === 'g' ? 3 : 0;
  const protein = best(
    new Set(['1003', 'protein', 'off:proteins', 'off:protein']),
    new Set(['protein', 'proteins', 'protein total']),
    grams,
    macroUnitPreference,
  );
  const carbs = best(
    new Set(['1005', 'carbohydrate', 'carbohydrates', 'carbs', 'off:carbohydrates']),
    new Set([
      'carbohydrate',
      'carbohydrates',
      'total carbohydrate',
      'carbohydrate by difference',
    ]),
    grams,
    macroUnitPreference,
  );
  const fat = best(
    new Set(['1004', 'fat', 'total-fat', 'off:fat']),
    new Set(['fat', 'total fat', 'total lipid fat']),
    grams,
    macroUnitPreference,
  );
  if (
    calories === undefined ||
    protein === undefined ||
    carbs === undefined ||
    fat === undefined
  ) {
    return null;
  }
  return { calories, protein, carbs, fat };
}

export function rescaleSnapshotSelection(
  snapshot: FoodNutritionSnapshot,
  factor: number,
): FoodNutritionSnapshot | null {
  if (!finitePositive(factor)) return null;
  const amount = snapshot.selected.amount * factor;
  const scale = snapshot.selected.scale * factor;
  if (!finitePositive(amount) || amount > 1_000_000 || !finitePositive(scale) || scale > 1_000_000) {
    return null;
  }
  return {
    ...snapshot,
    selected: {
      ...snapshot.selected,
      amount,
      scale,
    },
  };
}

/** Stable exact-configuration identity for account-scoped recent/favorite rails. */
export function snapshotConfigurationKey(snapshot: FoodNutritionSnapshot): string {
  const dimensions = snapshot.variant
    ? Object.entries(snapshot.variant.dimensions).sort(([a], [b]) => a.localeCompare(b))
    : [];
  return JSON.stringify([
    snapshot.source.provider,
    snapshot.source.recordId,
    snapshot.source.release ?? '',
    snapshot.source.revision,
    dimensions,
    snapshot.selected.amount,
    snapshot.selected.unitId,
  ]);
}

/** Opaque, deterministic library id; source identity remains readable in the snapshot itself. */
export function snapshotConfigurationId(snapshot: FoodNutritionSnapshot): string {
  const key = snapshotConfigurationKey(snapshot);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `cfg_${(first >>> 0).toString(36)}_${(second >>> 0).toString(36)}`;
}