/**
 * Estimated cost of one model call.
 *
 * The gateway returns token counts but no price, so cost is estimated from
 * a rate table: US dollars per million tokens for prompt, cached-prompt,
 * and completion tokens, matched by the longest model-name prefix. Costs
 * are stored as integer micro-dollars (1 USD = 1,000,000) — at these rates
 * a nano call is a few micro-dollars, far below a cent.
 *
 * Because $X per million tokens is exactly X micro-dollars per token, the
 * arithmetic is tokens × rate, summed, rounded.
 *
 * Rates are a snapshot (PRICING_VERSION names it) and an estimate by
 * definition; every row records the version it was priced with so a rate
 * change never silently rewrites history. HQ can correct or extend rates
 * without a deploy through AI_MODEL_PRICING_JSON, e.g.
 * `{"gpt-5.6-terra":{"input":1.25,"cached":0.125,"output":10}}`. A model
 * with no matching rate gets a null cost (counted, unpriced) rather than a
 * guess.
 */

export interface ModelRate {
  /** USD per million prompt tokens (uncached). */
  input: number;
  /** USD per million prompt tokens served from the prompt cache. */
  cached: number;
  /** USD per million completion tokens (reasoning included). */
  output: number;
}

export const PRICING_VERSION = "2026-09-18.1";

/**
 * Rate snapshot. The gateway's gpt-5.6 fleet names (terra/luna/sol) are
 * priced at the flagship gpt-5 tier and the mini/nano tiers at theirs; the
 * image model is priced by its reported input/output tokens.
 */
export const RATE_TABLE: Record<string, ModelRate> = {
  "gpt-5.6": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5.4": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5.4-mini": { input: 0.25, cached: 0.025, output: 2 },
  "gpt-5.1": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5.1-mini": { input: 0.25, cached: 0.025, output: 2 },
  "gpt-5": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5-mini": { input: 0.25, cached: 0.025, output: 2 },
  "gpt-5-nano": { input: 0.05, cached: 0.005, output: 0.4 },
  "gpt-4.1": { input: 2, cached: 0.5, output: 8 },
  "gpt-4.1-mini": { input: 0.4, cached: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cached: 0.025, output: 0.4 },
  "gpt-4o": { input: 2.5, cached: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cached: 0.075, output: 0.6 },
  "gpt-4o-transcribe": { input: 6, cached: 6, output: 10 },
  "gpt-4o-mini-transcribe": { input: 3, cached: 3, output: 5 },
  "gpt-image-1": { input: 10, cached: 2.5, output: 40 },
};

export interface PricingTable {
  version: string;
  rates: Record<string, ModelRate>;
}

function isRate(value: unknown): value is ModelRate {
  if (!value || typeof value !== "object") return false;
  const rate = value as Record<string, unknown>;
  return ["input", "cached", "output"].every(
    (key) => typeof rate[key] === "number" && Number.isFinite(rate[key] as number) && (rate[key] as number) >= 0,
  );
}

/**
 * The effective table: the snapshot with AI_MODEL_PRICING_JSON merged over
 * it. A malformed override is reported (thrown) rather than ignored, so a
 * typo cannot quietly leave every row at the old rates.
 */
export function loadPricingTable(env: NodeJS.ProcessEnv = process.env): PricingTable {
  const raw = (env.AI_MODEL_PRICING_JSON ?? "").trim();
  if (raw.length === 0) return { version: PRICING_VERSION, rates: RATE_TABLE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`AI_MODEL_PRICING_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI_MODEL_PRICING_JSON must be an object of model prefix -> {input, cached, output}");
  }
  const rates: Record<string, ModelRate> = { ...RATE_TABLE };
  for (const [model, rate] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isRate(rate)) throw new Error(`AI_MODEL_PRICING_JSON: rate for "${model}" must have numeric input, cached, output`);
    rates[model] = { input: rate.input, cached: rate.cached, output: rate.output };
  }
  return { version: `${PRICING_VERSION}+env`, rates };
}

/** Longest-prefix match: `gpt-5-nano-2025-08-07` → `gpt-5-nano`, not `gpt-5`. */
export function rateFor(model: string, table: PricingTable): ModelRate | null {
  let best: string | null = null;
  for (const key of Object.keys(table.rates)) {
    if (model === key || model.startsWith(`${key}-`)) {
      if (best === null || key.length > best.length) best = key;
    }
  }
  return best === null ? null : table.rates[best]!;
}

export interface PricedTokens {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

/** Estimated cost in micro-dollars, or null when the model has no rate. */
export function estimateCostMicros(model: string, tokens: PricedTokens, table: PricingTable): number | null {
  const rate = rateFor(model, table);
  if (!rate) return null;
  const cached = Math.min(Math.max(0, tokens.cachedTokens), Math.max(0, tokens.promptTokens));
  const uncached = Math.max(0, tokens.promptTokens) - cached;
  const micros = uncached * rate.input + cached * rate.cached + Math.max(0, tokens.completionTokens) * rate.output;
  return Math.round(micros);
}
