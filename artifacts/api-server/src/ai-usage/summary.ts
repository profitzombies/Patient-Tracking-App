/**
 * HQ's read of the usage ledger: the `ai_usage_summary` RPC shaped into the
 * response the billing/HQ AI costs panel renders. Money leaves here as USD
 * numbers (the table stores micro-dollars); token shares and per-patient
 * figures are computed once, server-side, so every client agrees.
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import { modelAssignments } from "../ai/models";
import { loadPricingTable, rateFor } from "./pricing";

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number(value ?? 0) || 0);
const usd = (micros: unknown): number => Math.round(num(micros)) / 1_000_000;
const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);
const per = (cost: number, count: number): number | null => (count > 0 ? cost / count : null);

export interface AiCostTotals {
  calls: number;
  ok_calls: number;
  error_calls: number;
  aborted_calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  /** Share of prompt tokens the provider served from its prompt cache (0..1). */
  cached_share: number;
  cost_usd: number;
  /** Calls whose model had no rate; their spend is missing from cost_usd. */
  unpriced_calls: number;
  /** Distinct patients who opened the app in the range (presence days). */
  active_patients: number;
  /** Distinct patients with at least one attributed model call. */
  ai_patients: number;
  cost_per_active_patient_usd: number | null;
  cost_per_ai_patient_usd: number | null;
}

export interface AiCostDay {
  day: string;
  calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  cached_share: number;
  cost_usd: number;
  ai_patients: number;
}

export interface AiCostOffice {
  provider_id: string;
  office_name: string | null;
  provider_name: string | null;
  calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  cached_share: number;
  cost_usd: number;
  ai_patients: number;
  active_patients: number;
  cost_per_active_patient_usd: number | null;
}

export interface AiCostSurface {
  surface: string;
  calls: number;
  error_calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_share: number;
  cost_usd: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  /** The model this surface calls right now (knob or default), when it is a known surface. */
  model: string | null;
}

export interface AiCostModel {
  model: string;
  calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  cached_share: number;
  cost_usd: number;
  /** True when this model has no rate in the pricing table (cost_usd is 0 by omission). */
  unpriced: boolean;
  rate: { input: number; cached: number; output: number } | null;
}

export interface AiCostSummary {
  from: string;
  to: string;
  pricing_version: string;
  totals: AiCostTotals;
  unattributed: { calls: number; cost_usd: number };
  by_day: AiCostDay[];
  by_office: AiCostOffice[];
  by_surface: AiCostSurface[];
  by_model: AiCostModel[];
  /** Active model per surface, so HQ sees which tier each surface runs. */
  models: { surface: string; model: string; overridden: boolean }[];
}

export class AiCostSummaryError extends Error {
  constructor(message: string, readonly status = 503) {
    super(message);
    this.name = "AiCostSummaryError";
  }
}

type Rpc = typeof supabaseAdmin;

export async function loadAiCostSummary(from: string, to: string, rpc: Rpc = supabaseAdmin): Promise<AiCostSummary> {
  const result = await rpc("POST", "/rest/v1/rpc/ai_usage_summary", { p_from: from, p_to: to });
  if (result.status < 200 || result.status >= 300 || !result.json || typeof result.json !== "object") {
    throw new AiCostSummaryError(`ai_usage_summary failed: HTTP ${result.status}`);
  }
  const raw = result.json as Record<string, unknown>;
  const pricing = loadPricingTable();
  const assignments = modelAssignments();
  const modelBySurface = new Map(assignments.map((entry) => [entry.surface as string, entry.model]));

  const t = (raw.totals ?? {}) as Record<string, unknown>;
  const cost = usd(t.cost_micros);
  const activePatients = num(t.active_patients);
  const aiPatients = num(t.ai_patients);
  const totals: AiCostTotals = {
    calls: num(t.calls),
    ok_calls: num(t.ok_calls),
    error_calls: num(t.error_calls),
    aborted_calls: num(t.aborted_calls),
    prompt_tokens: num(t.prompt_tokens),
    cached_tokens: num(t.cached_tokens),
    completion_tokens: num(t.completion_tokens),
    reasoning_tokens: num(t.reasoning_tokens),
    cached_share: share(num(t.cached_tokens), num(t.prompt_tokens)),
    cost_usd: cost,
    unpriced_calls: num(t.unpriced_calls),
    active_patients: activePatients,
    ai_patients: aiPatients,
    cost_per_active_patient_usd: per(cost, activePatients),
    cost_per_ai_patient_usd: per(cost, aiPatients),
  };
  const un = (raw.unattributed ?? {}) as Record<string, unknown>;
  const rows = <T>(key: string): Record<string, unknown>[] => (Array.isArray(raw[key]) ? (raw[key] as Record<string, unknown>[]) : []) as T[] & Record<string, unknown>[];

  return {
    from,
    to,
    pricing_version: pricing.version,
    totals,
    unattributed: { calls: num(un.calls), cost_usd: usd(un.cost_micros) },
    by_day: rows("by_day").map((d) => ({
      day: String(d.day),
      calls: num(d.calls),
      prompt_tokens: num(d.prompt_tokens),
      cached_tokens: num(d.cached_tokens),
      completion_tokens: num(d.completion_tokens),
      cached_share: share(num(d.cached_tokens), num(d.prompt_tokens)),
      cost_usd: usd(d.cost_micros),
      ai_patients: num(d.ai_patients),
    })),
    by_office: rows("by_office").map((o) => {
      const officeCost = usd(o.cost_micros);
      const active = num(o.active_patients);
      return {
        provider_id: String(o.provider_id),
        office_name: typeof o.office_name === "string" ? o.office_name : null,
        provider_name: typeof o.provider_name === "string" ? o.provider_name : null,
        calls: num(o.calls),
        prompt_tokens: num(o.prompt_tokens),
        cached_tokens: num(o.cached_tokens),
        completion_tokens: num(o.completion_tokens),
        cached_share: share(num(o.cached_tokens), num(o.prompt_tokens)),
        cost_usd: officeCost,
        ai_patients: num(o.ai_patients),
        active_patients: active,
        cost_per_active_patient_usd: per(officeCost, active),
      };
    }),
    by_surface: rows("by_surface").map((s) => ({
      surface: String(s.surface),
      calls: num(s.calls),
      error_calls: num(s.error_calls),
      prompt_tokens: num(s.prompt_tokens),
      cached_tokens: num(s.cached_tokens),
      completion_tokens: num(s.completion_tokens),
      reasoning_tokens: num(s.reasoning_tokens),
      cached_share: share(num(s.cached_tokens), num(s.prompt_tokens)),
      cost_usd: usd(s.cost_micros),
      avg_latency_ms: num(s.avg_latency_ms),
      p95_latency_ms: num(s.p95_latency_ms),
      model: modelBySurface.get(String(s.surface)) ?? null,
    })),
    by_model: rows("by_model").map((m) => {
      const rate = rateFor(String(m.model), pricing);
      return {
        model: String(m.model),
        calls: num(m.calls),
        prompt_tokens: num(m.prompt_tokens),
        cached_tokens: num(m.cached_tokens),
        completion_tokens: num(m.completion_tokens),
        cached_share: share(num(m.cached_tokens), num(m.prompt_tokens)),
        cost_usd: usd(m.cost_micros),
        unpriced: m.unpriced === true || rate === null,
        rate,
      };
    }),
    models: assignments,
  };
}
