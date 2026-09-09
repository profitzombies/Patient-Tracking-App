import { supabaseAdmin } from "../lib/supabase-admin";

export interface CatalogQueryResolution {
  query: string;
  suggestions: string[];
  correctedQuery?: string;
}

/**
 * Resolves catalog wording from the database-owned review dictionary.
 * Keeping this async avoids a second typo/alias dictionary in application code.
 */
export async function resolveCatalogQuery(
  query: string,
  patientId: string | null = null,
): Promise<CatalogQueryResolution> {
  const response = await supabaseAdmin("POST", "/rest/v1/rpc/resolve_food_catalog_query", {
    p_query: query,
    p_patient_id: patientId,
  });
  if (response.status >= 300) {
    throw new Error(`catalog query resolution failed (${response.status})`);
  }
  const value = Array.isArray(response.json) ? response.json[0] : response.json;
  if (!value || typeof value !== "object") {
    throw new Error("catalog query resolution returned an invalid response");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.query !== "string" || !Array.isArray(row.suggestions)) {
    throw new Error("catalog query resolution returned an invalid shape");
  }
  const suggestions = row.suggestions.filter(
    (suggestion): suggestion is string => typeof suggestion === "string",
  );
  return {
    query: row.query,
    suggestions,
    ...(typeof row.correctedQuery === "string"
      ? { correctedQuery: row.correctedQuery }
      : {}),
  };
}