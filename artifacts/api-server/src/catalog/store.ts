import { supabaseAdmin } from "../lib/supabase-admin";
import type { BarcodeProductFacts } from "../barcode/normalize";

export interface CatalogItem {
  id: string;
  kind: "generic" | "branded" | "personal";
  name: string;
  brand: string | null;
  serving: string;
  serving_grams: number | null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  measures: unknown[];
  source: "usda_fdc" | "openfoodfacts" | "patient";
  source_id: string;
  barcode: string | null;
  quality_status: "reviewed" | "community_verified" | "private";
  approvals: unknown[];
  resultKey?: string;
  familyKey?: string;
  familyKeyAliases?: string[];
  variantSummary?: string;
  dimensions?: Record<string, string>;
  choiceRequired?: boolean;
  nutritionSnapshot?: unknown;
  nutrition_snapshot?: unknown;
  catalogMetadata?: Record<string, unknown>;
  catalog_metadata?: Record<string, unknown>;
}

export async function searchCatalogGrouped(
  patientId: string | null,
  query: string,
  approvedOnly: boolean,
  limit: number,
  offset: number,
): Promise<CatalogItem[]> {
  const response = await supabaseAdmin("POST", "/rest/v1/rpc/search_food_catalog_grouped", {
    p_patient_id: patientId,
    p_query: query,
    p_approved_only: approvedOnly,
    p_limit: limit,
    p_offset: offset,
  });
  assertOk(response.status, "grouped catalog search");
  return cleanCatalogItems(Array.isArray(response.json) ? response.json as CatalogItem[] : []);
}

export async function getCatalogFamily(
  familyKey: string,
  approvedOnly: boolean,
): Promise<CatalogItem[]> {
  const response = await supabaseAdmin("POST", "/rest/v1/rpc/get_food_catalog_family", {
    p_family_key: familyKey,
    p_approved_only: approvedOnly,
  });
  assertOk(response.status, "catalog family lookup");
  return cleanCatalogItems(Array.isArray(response.json) ? response.json as CatalogItem[] : []);
}

function assertOk(status: number, operation: string): void {
  if (status >= 300) throw new Error(`${operation} failed (${status})`);
}

function cleanCatalogItems(items: CatalogItem[]): CatalogItem[] {
  return items.map(item => ({
    ...item,
    measures: Array.isArray(item.measures)
      ? item.measures.filter(measure => {
        if (!measure || typeof measure !== "object") return false;
        const label = String((measure as Record<string, unknown>).label ?? "").trim().toLowerCase();
        return label !== "" && label !== "quantity not specified" && label !== "amount not specified";
      })
      : [],
  }));
}

export async function searchCatalog(
  patientId: string | null,
  query: string,
  limit: number,
): Promise<CatalogItem[]> {
  const response = await supabaseAdmin("POST", "/rest/v1/rpc/search_food_catalog", {
    p_patient_id: patientId,
    p_query: query,
    p_limit: limit,
  });
  assertOk(response.status, "catalog search");
  return cleanCatalogItems(Array.isArray(response.json) ? response.json as CatalogItem[] : []);
}

export async function getCatalogItem(id: string): Promise<CatalogItem | null> {
  let catalogId = id;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    const alias = await supabaseAdmin(
      "GET",
      `/rest/v1/food_catalog_aliases?legacy_id=eq.${encodeURIComponent(id)}&select=catalog_id&limit=1`,
    );
    assertOk(alias.status, "catalog compatibility lookup");
    const resolved = Array.isArray(alias.json) ? alias.json[0] as { catalog_id?: unknown } | undefined : undefined;
    if (typeof resolved?.catalog_id !== "string") return null;
    catalogId = resolved.catalog_id;
  }
  const response = await supabaseAdmin(
    "GET",
    `/rest/v1/food_catalog_items?id=eq.${encodeURIComponent(catalogId)}&select=id,kind,name,brand,serving:serving_label,serving_grams,calories,protein,carbs,fat,measures,source,source_id,barcode,quality_status,nutrition_snapshot,provenance,food_catalog_family_variants(family_key,variant_summary,dimensions,food_catalog_families(name)),food_catalog_approved_links(approved_food_id,official_name,official_portion,phase_guidance,constraints)`,
  );
  assertOk(response.status, "catalog item lookup");
  if (!Array.isArray(response.json) || !response.json[0]) return null;
  const row = response.json[0] as CatalogItem & {
    provenance?: Record<string, unknown>;
    food_catalog_family_variants?: {
      family_key: string;
      variant_summary: string;
      dimensions: Record<string, string>;
      food_catalog_families?: { name?: string } | Array<{ name?: string }>;
    } | Array<{
      family_key: string;
      variant_summary: string;
      dimensions: Record<string, string>;
      food_catalog_families?: { name?: string } | Array<{ name?: string }>;
    }>;
    food_catalog_approved_links?: Array<{
      approved_food_id: string;
      official_name: string;
      official_portion: string | null;
      phase_guidance: string | null;
      constraints: Record<string, unknown> | null;
    }>;
  };
  const {
    food_catalog_approved_links: links = [],
    food_catalog_family_variants: variants = [],
    provenance,
    ...item
  } = row;
  const variant = Array.isArray(variants) ? variants[0] : variants;
  const familyRecord = Array.isArray(variant?.food_catalog_families)
    ? variant.food_catalog_families[0]
    : variant?.food_catalog_families;
  const canonicalName = typeof provenance?.canonicalName === "string"
    ? provenance.canonicalName
    : undefined;
  return cleanCatalogItems([{
    ...item,
    ...(familyRecord?.name ? { name: familyRecord.name } : {}),
    ...(canonicalName && canonicalName !== (familyRecord?.name ?? item.name)
      ? { catalogMetadata: { canonicalName } }
      : {}),
    ...(variant ? {
      resultKey: `family:${variant.family_key}:${item.id}`,
      familyKey: variant.family_key,
      variantSummary: variant.variant_summary,
      dimensions: variant.dimensions,
      choiceRequired: false,
    } : {}),
    approvals: links.map(link => ({
      id: link.approved_food_id,
      name: link.official_name,
      portion: link.official_portion,
      phaseGuidance: link.phase_guidance,
      constraints: link.constraints,
    })),
  }])[0];
}

export async function recordSelection(patientId: string, catalogId: string): Promise<void> {
  const response = await supabaseAdmin("POST", "/rest/v1/rpc/record_food_catalog_selection", {
    p_patient_id: patientId,
    p_catalog_id: catalogId,
  });
  assertOk(response.status, "catalog selection");
}

export async function upsertOffCatalogItem(
  code: string,
  facts: BarcodeProductFacts,
  nutritionSnapshot?: unknown,
): Promise<CatalogItem> {
  const response = await supabaseAdmin(
    "POST",
    "/rest/v1/food_catalog_items?on_conflict=source,source_id&select=id,kind,name,brand,serving:serving_label,serving_grams,calories,protein,carbs,fat,measures,source,source_id,barcode,quality_status,nutrition_snapshot",
    [{
      kind: "branded",
      name: facts.name,
      brand: facts.brand ?? null,
      serving_label: facts.serving,
      serving_grams: null,
      calories: facts.calories,
      protein: facts.protein,
      carbs: facts.carbs,
      fat: facts.fat,
      source: "openfoodfacts",
      source_id: code,
      barcode: code,
      quality_status: "community_verified",
      provenance: { provider: "Open Food Facts", selected: true },
      ...(nutritionSnapshot ? { nutrition_snapshot: nutritionSnapshot } : {}),
    }],
    "resolution=merge-duplicates,return=representation",
  );
  assertOk(response.status, "catalog upsert");
  if (!Array.isArray(response.json) || !response.json[0]) throw new Error("catalog upsert returned no row");
  return response.json[0] as CatalogItem;
}