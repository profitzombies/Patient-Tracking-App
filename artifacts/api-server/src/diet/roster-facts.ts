// Diet facts for the office roster: one RPC per roster load joins each live
// patient's active diet, pending safety block, severe-allergy flag and the
// last-14-day "fits the diet" verdict counts (the patient app writes one
// verdict per diary entry; the server only counts them).
//
// Three-way model (same as the activity signals): a patient the RPC did not
// list gets NO_DIET_FACTS ("no diet, nothing pending"); a patient with facts
// but no verdict-bearing entries has `fitsDietPct: null` (unknown, never
// 0 %). When the RPC itself cannot run the roster still loads and every row
// carries `diet: null` (whole-family unknown) so the clients render unknown,
// not "no diet".
import { supabaseAdmin } from "../lib/supabase-admin";

export interface DietFactsRpcRow {
  patient_id: string;
  diet_slug: string | null;
  diet_name: string | null;
  diet_started_at: string | null;
  pending_block_id: string | null;
  pending_block_created_at: string | null;
  severe_allergy: boolean | null;
  fit_count: number | string | null;
  fit_total: number | string | null;
  fit_window_days: number | null;
}

export interface RosterDietDto {
  /** Active diet (library slug + display name); null = no diet chosen. "just_tracking" is a real entry. */
  diet: { slug: string; name: string; startedAt: string | null } | null;
  /** Newest pending safety block awaiting provider review; null when none. */
  pendingBlock: { id: string; createdAt: string | null } | null;
  /** True when any current allergy item is marked severe. */
  severeAllergy: boolean;
  /**
   * Share of recent logged foods that fit the diet in force (0–100, rounded).
   * null = unknown: no diet, or no verdict-bearing entries in the window.
   */
  fitsDietPct: number | null;
  /** Verdict-bearing entries behind the percentage (0 when unknown). */
  fitsDietSample: number;
  fitWindowDays: number;
}

const count = (value: number | string | null | undefined): number => {
  const n = typeof value === "string" ? Number(value) : value ?? 0;
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
};

export function rosterDietDto(row: DietFactsRpcRow): RosterDietDto {
  const total = count(row.fit_total);
  const fits = count(row.fit_count);
  return {
    diet: row.diet_slug ? { slug: String(row.diet_slug), name: String(row.diet_name ?? row.diet_slug), startedAt: row.diet_started_at ?? null } : null,
    pendingBlock: row.pending_block_id ? { id: String(row.pending_block_id), createdAt: row.pending_block_created_at ?? null } : null,
    severeAllergy: row.severe_allergy === true,
    fitsDietPct: row.diet_slug && total > 0 ? Math.round((fits / total) * 100) : null,
    fitsDietSample: total,
    fitWindowDays: Number(row.fit_window_days ?? 14),
  };
}

/** No facts on file: no diet, nothing pending, no severe allergy, percentage unknown. */
export const NO_DIET_FACTS: RosterDietDto = {
  diet: null, pendingBlock: null, severeAllergy: false, fitsDietPct: null, fitsDietSample: 0, fitWindowDays: 14,
};

/** Facts keyed by patient id for one office. Throws when the RPC fails; callers decide how to degrade. */
export async function loadOfficeDietFacts(providerId: string, at: Date): Promise<Map<string, RosterDietDto>> {
  const response = await supabaseAdmin("POST", "/rest/v1/rpc/provider_patient_diet_facts", {
    p_provider_id: providerId,
    p_at: at.toISOString(),
  });
  if (response.status >= 300 || !Array.isArray(response.json)) {
    throw new Error(`diet roster facts failed (${response.status})`);
  }
  return new Map((response.json as DietFactsRpcRow[]).map((row) => [String(row.patient_id), rosterDietDto(row)]));
}
