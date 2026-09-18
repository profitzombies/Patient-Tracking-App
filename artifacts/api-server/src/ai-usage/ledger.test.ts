/**
 * The usage ledger's batching and pricing: rows are shaped and priced
 * synchronously, written in batches on a timer or when the batch fills,
 * retried a bounded number of times, and dropped (counted) beyond the
 * buffer ceiling. Also pins the model knobs' blank-means-default rule.
 */
import { describe, expect, it, vi } from "vitest";
import type { ModelUsageEvent } from "@workspace/integrations-openai-ai-server/usage";
import { createModelUsageLedger, resolveLedgerMode, toUsageRow, type UsageRow } from "./ledger";
import { estimateCostMicros, loadPricingTable, rateFor, PRICING_VERSION } from "./pricing";
import { DEFAULT_MODELS, modelAssignments, modelFor, modelKnobName } from "../ai/models";

const PATIENT = "0a1b2c3d-0000-4000-8000-000000000001";
const quiet = { info() {}, warn() {}, error() {} };

function event(over: Partial<ModelUsageEvent> = {}): ModelUsageEvent {
  return {
    api: "chat.completions", model: "gpt-5.6-terra", responseModel: "gpt-5.6-terra-2026", stream: true, status: "ok",
    usageReported: true, promptTokens: 2000, cachedTokens: 1500, completionTokens: 400, reasoningTokens: 100,
    latencyMs: 3210.6, firstTokenMs: 900.2, startedAt: new Date("2026-09-18T12:00:00Z"),
    context: { surface: "coach.chat", patientId: PATIENT, providerId: "office-1", requestId: "req-1" },
    ...over,
  };
}

/** A manual timer so flushes happen when the test says so. */
function manualTimer() {
  const pending: (() => void)[] = [];
  return {
    setTimer: (fn: () => void) => { pending.push(fn); return { unref() {} }; },
    fire: () => { const fns = pending.splice(0); fns.forEach((fn) => fn()); },
    armed: () => pending.length,
  };
}

describe("pricing", () => {
  it("matches the longest model prefix and prices cached prompt tokens at the cached rate", () => {
    const table = loadPricingTable({});
    expect(rateFor("gpt-5-nano-2025-08-07", table)).toEqual(table.rates["gpt-5-nano"]);
    expect(rateFor("gpt-5.4-mini", table)).toEqual(table.rates["gpt-5.4-mini"]);
    expect(rateFor("gpt-5.6-terra", table)).toEqual(table.rates["gpt-5.6"]);
    expect(rateFor("claude-x", table)).toBeNull();
    // 500 uncached @ $1.25/M + 1500 cached @ $0.125/M + 400 out @ $10/M
    expect(estimateCostMicros("gpt-5.6-terra", { promptTokens: 2000, cachedTokens: 1500, completionTokens: 400 }, table))
      .toBe(Math.round(500 * 1.25 + 1500 * 0.125 + 400 * 10));
    expect(estimateCostMicros("unknown", { promptTokens: 1, cachedTokens: 0, completionTokens: 1 }, table)).toBeNull();
  });

  it("merges AI_MODEL_PRICING_JSON over the snapshot and rejects malformed overrides", () => {
    const table = loadPricingTable({ AI_MODEL_PRICING_JSON: '{"gpt-5.6-terra":{"input":2,"cached":0.2,"output":16}}' });
    expect(table.version).toBe(`${PRICING_VERSION}+env`);
    expect(rateFor("gpt-5.6-terra", table)).toEqual({ input: 2, cached: 0.2, output: 16 });
    expect(rateFor("gpt-5.6-luna", table)).toEqual(loadPricingTable({}).rates["gpt-5.6"]);
    expect(() => loadPricingTable({ AI_MODEL_PRICING_JSON: "{nope" })).toThrow(/valid JSON/);
    expect(() => loadPricingTable({ AI_MODEL_PRICING_JSON: '{"m":{"input":"1"}}' })).toThrow(/numeric/);
    expect(loadPricingTable({ AI_MODEL_PRICING_JSON: "   " }).version).toBe(PRICING_VERSION);
  });
});

describe("toUsageRow", () => {
  it("shapes an attributed call with its estimated cost and pricing version", () => {
    const row = toUsageRow(event(), loadPricingTable({}));
    expect(row).toMatchObject({
      occurred_at: "2026-09-18T12:00:00.000Z", surface: "coach.chat", api: "chat.completions", model: "gpt-5.6-terra",
      response_model: "gpt-5.6-terra-2026", scope: "patient", patient_id: PATIENT, provider_id: "office-1", stream: true,
      status: "ok", usage_reported: true, prompt_tokens: 2000, cached_tokens: 1500, completion_tokens: 400, reasoning_tokens: 100,
      latency_ms: 3211, first_token_ms: 900, pricing_version: PRICING_VERSION, request_id: "req-1",
    });
    expect(row.estimated_cost_micros).toBe(Math.round(500 * 1.25 + 1500 * 0.125 + 400 * 10));
  });

  it("derives scope from the ids, drops non-uuid patient ids, and leaves unpriced or unreported calls at null cost", () => {
    const table = loadPricingTable({});
    expect(toUsageRow(event({ context: { surface: "coach.chat", patientId: "demo-persona", providerId: "office-1" } }), table))
      .toMatchObject({ scope: "office", patient_id: null, provider_id: "office-1" });
    expect(toUsageRow(event({ context: { surface: "coach.chat" } }), table)).toMatchObject({ scope: "anonymous", patient_id: null, provider_id: null });
    expect(toUsageRow(event({ context: null }), table)).toMatchObject({ scope: "unattributed", surface: "unattributed" });
    expect(toUsageRow(event({ context: { surface: "coach.title", patientId: PATIENT, scope: "system" } }), table)).toMatchObject({ scope: "system", patient_id: PATIENT });
    expect(toUsageRow(event({ model: "mystery" }), table)).toMatchObject({ estimated_cost_micros: null, pricing_version: null });
    expect(toUsageRow(event({ status: "error", usageReported: false, promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0 }), table))
      .toMatchObject({ status: "error", estimated_cost_micros: null });
    // Provider-reported cached/reasoning counts can never exceed their parents in the table's checks.
    expect(toUsageRow(event({ cachedTokens: 9999, reasoningTokens: 9999 }), table)).toMatchObject({ cached_tokens: 2000, reasoning_tokens: 400 });
  });
});

describe("createModelUsageLedger", () => {
  it("buffers synchronously and writes on the timer, one batch per flush", async () => {
    const written: UsageRow[][] = [];
    const timer = manualTimer();
    const ledger = createModelUsageLedger({ writer: async (rows) => { written.push(rows); }, setTimer: timer.setTimer, log: quiet, pricing: loadPricingTable({}) });
    ledger.record(event());
    ledger.record(event({ context: { surface: "support.chat" } }));
    expect(written).toEqual([]);
    expect(ledger.stats()).toMatchObject({ recorded: 2, written: 0, buffered: 2 });
    expect(timer.armed()).toBe(1);
    timer.fire();
    await ledger.flush();
    expect(written).toHaveLength(1);
    expect(written[0]!.map((row) => row.surface)).toEqual(["coach.chat", "support.chat"]);
    expect(ledger.stats()).toMatchObject({ written: 2, buffered: 0, dropped: 0 });
  });

  it("flushes immediately when the batch fills, splitting into batch-sized writes", async () => {
    const written: number[] = [];
    const timer = manualTimer();
    const ledger = createModelUsageLedger({ writer: async (rows) => { written.push(rows.length); }, batchSize: 3, setTimer: timer.setTimer, log: quiet, pricing: loadPricingTable({}) });
    for (let i = 0; i < 7; i += 1) ledger.record(event());
    await ledger.flush();
    expect(written).toEqual([3, 3, 1]);
  });

  it("retries a failed batch on later flushes and drops rows after the attempt limit", async () => {
    const writer = vi.fn<(rows: UsageRow[]) => Promise<void>>().mockRejectedValue(new Error("db down"));
    const timer = manualTimer();
    const ledger = createModelUsageLedger({ writer, maxAttempts: 2, setTimer: timer.setTimer, log: quiet, pricing: loadPricingTable({}) });
    ledger.record(event());
    await ledger.flush();
    expect(ledger.stats()).toMatchObject({ failedWrites: 1, dropped: 0, buffered: 1 });
    expect(timer.armed()).toBe(1); // re-armed for the retry
    writer.mockResolvedValueOnce(undefined);
    timer.fire();
    await ledger.flush();
    expect(ledger.stats()).toMatchObject({ written: 1, buffered: 0 });
    ledger.record(event());
    await ledger.flush();
    await ledger.flush();
    expect(ledger.stats()).toMatchObject({ failedWrites: 3, dropped: 1, buffered: 0 });
  });

  it("caps the buffer, dropping the oldest rows, and refuses new rows after close", async () => {
    const timer = manualTimer();
    const written: UsageRow[][] = [];
    const ledger = createModelUsageLedger({ writer: async (rows) => { written.push(rows); }, batchSize: 100, maxBuffered: 3, setTimer: timer.setTimer, log: quiet, pricing: loadPricingTable({}) });
    for (const surface of ["a", "b", "c", "d", "e"]) ledger.record(event({ context: { surface } }));
    expect(ledger.stats()).toMatchObject({ dropped: 2, buffered: 3 });
    await ledger.close();
    expect(written[0]!.map((row) => row.surface)).toEqual(["c", "d", "e"]);
    ledger.record(event());
    expect(ledger.stats().buffered).toBe(0);
  });

  it("resolves its mode from the knob, defaulting to database only when credentials exist", () => {
    expect(resolveLedgerMode({})).toBe("memory");
    expect(resolveLedgerMode({ SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k" })).toBe("database");
    expect(resolveLedgerMode({ AI_USAGE_LEDGER: "off", SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k" })).toBe("off");
    expect(resolveLedgerMode({ AI_USAGE_LEDGER: " Memory " })).toBe("memory");
    expect(() => resolveLedgerMode({ AI_USAGE_LEDGER: "yes" })).toThrow(/AI_USAGE_LEDGER/);
  });
});

describe("model knobs", () => {
  it("default to today's production models and honor non-blank overrides only", () => {
    expect(modelFor("coach.chat", {})).toBe("gpt-5.6-terra");
    expect(modelFor("coach.meal_photo", {})).toBe("gpt-5.6-luna");
    expect(modelFor("coach.photo_classify", {})).toBe("gpt-5-nano");
    expect(modelKnobName("coach.meal_photo")).toBe("AI_MODEL_COACH_MEAL_PHOTO");
    expect(modelFor("coach.chat", { AI_MODEL_COACH_CHAT: "gpt-5.4-mini" })).toBe("gpt-5.4-mini");
    expect(modelFor("coach.chat", { AI_MODEL_COACH_CHAT: "   " })).toBe(DEFAULT_MODELS["coach.chat"]);
    const assignments = modelAssignments({ AI_MODEL_SUPPORT_CHAT: " gpt-5.4-mini " });
    expect(assignments.find((entry) => entry.surface === "support.chat")).toEqual({ surface: "support.chat", model: "gpt-5.4-mini", overridden: true });
    expect(assignments.filter((entry) => entry.overridden)).toHaveLength(1);
  });
});
