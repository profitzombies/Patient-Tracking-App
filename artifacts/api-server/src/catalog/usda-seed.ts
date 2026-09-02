/**
 * Database-facing projection of the reviewed mobile/shared seed.
 *
 * This intentionally contains no database calls, so migrations or one-shot
 * service-role seed runners can consume the exact same deterministic rows.
 * Upsert items on (source, source_id), then resolve aliases/links through
 * source_id; database UUIDs are storage details and are not compatibility IDs.
 */
import {
  APPROVED_CATALOG_REVIEW,
  LEGACY_FOOD_CATALOG_ALIAS,
} from "../../../thinnr-mobile/data/catalog-cross-reference";
import {
  APPROVED_FOOD_CATEGORIES,
  approvedPortion,
} from "../../../thinnr-mobile/data/approved-foods";
import { USDA_ESSENTIALS } from "../../../thinnr-mobile/data/usda-essentials";

export const USDA_CATALOG_SEED_ROWS = USDA_ESSENTIALS.map(food => ({
  kind: "generic" as const,
  name: food.name,
  brand: null,
  serving_label: "100 g",
  serving_grams: 100,
  calories: food.nutrients.calories,
  protein: food.nutrients.proteinGrams,
  carbs: food.nutrients.carbohydrateGrams,
  fat: food.nutrients.fatGrams,
  measures: food.measures,
  source: "usda_fdc" as const,
  source_id: food.provenance.fdcId,
  barcode: null,
  quality_status: "reviewed" as const,
  provenance: food.provenance,
}));

const sourceIdByAlias = new Map<string, string>();
for (const food of USDA_ESSENTIALS) {
  for (const alias of food.aliases) {
    if (!sourceIdByAlias.has(alias)) sourceIdByAlias.set(alias, food.provenance.fdcId);
  }
}

export const USDA_CATALOG_ALIAS_SEED_ROWS = [
  ...USDA_ESSENTIALS.flatMap(food =>
    food.aliases.map(alias => ({
      source_id: food.provenance.fdcId,
      alias,
      legacy_id: null as string | null,
    })),
  ),
  ...Object.entries(LEGACY_FOOD_CATALOG_ALIAS).flatMap(([legacyId, alias]) => {
    const sourceId = alias ? sourceIdByAlias.get(alias) : undefined;
    return sourceId ? [{ source_id: sourceId, alias: legacyId, legacy_id: legacyId }] : [];
  }),
];

const officialById = new Map(
  APPROVED_FOOD_CATEGORIES.flatMap(category =>
    category.items.map(item => [
      item.id,
      {
        name: item.name,
        portion: approvedPortion(item, category) ?? null,
        phaseGuidance: category.group === "normalization"
          ? "Thinnr Metabolic Normalization Phase"
          : null,
      },
    ] as const),
  ),
);

export const USDA_CATALOG_APPROVAL_SEED_ROWS = APPROVED_CATALOG_REVIEW.flatMap(review => {
  if (review.status !== "mapped") return [];
  const official = officialById.get(review.approvedItemId);
  if (!official) throw new Error(`Missing official approved item ${review.approvedItemId}`);
  // One canonical nutrition variant per official item prevents a broad badge
  // fan-out; alternate USDA variants remain searchable but unbadged.
  return review.catalogIds.slice(0, 1).map(catalogId => {
    const food = USDA_ESSENTIALS.find(candidate => candidate.id === catalogId);
    if (!food) throw new Error(`Missing USDA seed ${catalogId}`);
    return {
      source_id: food.provenance.fdcId,
      approved_food_id: review.approvedItemId,
      official_name: official.name,
      official_portion: official.portion,
      phase_guidance: official.phaseGuidance,
      constraints: { reviewRationale: review.rationale },
    };
  });
});