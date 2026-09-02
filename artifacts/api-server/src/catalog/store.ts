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
}

function assertOk(status: number, operation: string): void {
  if (status >= 300) throw new Error(`${operation} failed (${status})`);
}

export async function searchCatalog(
  patientId: string,
  query: string,
  limit: number,
): Promise<CatalogItem[]> {
  const response = await supabaseAdmin("POST", "/rest/v1/rpc/search_food_catalog", {
    p_patient_id: patientId,
    p_query: query,
    p_limit: limit,
  });
  assertOk(response.status, "catalog search");
  return Array.isArray(response.json) ? response.json as CatalogItem[] : [];
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
    `/rest/v1/food_catalog_items?id=eq.${encodeURIComponent(catalogId)}&select=id,kind,name,brand,serving:serving_label,serving_grams,calories,protein,carbs,fat,measures,source,source_id,barcode,quality_status,food_catalog_approved_links(approved_food_id,official_name,official_portion,phase_guidance,constraints)`,
  );
  assertOk(response.status, "catalog item lookup");
  if (!Array.isArray(response.json) || !response.json[0]) return null;
  const row = response.json[0] as CatalogItem & {
    food_catalog_approved_links?: Array<{
      approved_food_id: string;
      official_name: string;
      official_portion: string | null;
      phase_guidance: string | null;
      constraints: Record<string, unknown> | null;
    }>;
  };
  const { food_catalog_approved_links: links = [], ...item } = row;
  return {
    ...item,
    approvals: links.map(link => ({
      id: link.approved_food_id,
      name: link.official_name,
      portion: link.official_portion,
      phaseGuidance: link.phase_guidance,
      constraints: link.constraints,
    })),
  };
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
): Promise<CatalogItem> {
  const response = await supabaseAdmin(
    "POST",
    "/rest/v1/food_catalog_items?on_conflict=source,source_id&select=id,kind,name,brand,serving:serving_label,serving_grams,calories,protein,carbs,fat,measures,source,source_id,barcode,quality_status",
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
    }],
    "resolution=merge-duplicates,return=representation",
  );
  assertOk(response.status, "catalog upsert");
  if (!Array.isArray(response.json) || !response.json[0]) throw new Error("catalog upsert returned no row");
  return response.json[0] as CatalogItem;
}