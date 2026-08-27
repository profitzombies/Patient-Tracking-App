/**
 * Per-stage token accounting for the coach's photo turns.
 *
 * Photo turns are the chat's most expensive requests — a triage call plus a
 * vision read, sometimes a discarded speculative read on top — and until
 * this module their true cost was an estimate. Every vision pipeline accepts
 * an optional usage recorder; the route hands each pipeline a recorder bound
 * to its stage name ("classify", "meal", "menu", "label") and logs the
 * aggregated snapshot on the turn's completion and failure lines, next to
 * the existing classifyMs/analysisMs/firstTokenMs spans — so the cost of one
 * photo is computable from a single log line.
 *
 * Counts only: prompt / completion / reasoning token totals per stage, never
 * message content and never the photo. Retries within a stage sum into that
 * stage, with `calls` keeping the count of completions that actually
 * reported usage. A discarded speculative read reports whatever the upstream
 * returned before the abort; a call aborted before it answered has no usage
 * to report — the upstream may still have billed its input, but that number
 * never reached us, and inventing one would be dishonest (the log's
 * `speculationDiscarded: true` flag marks the turns where that can happen).
 */

/**
 * Structural slice of the OpenAI SDK's CompletionUsage — declared locally so
 * recorders are callable with plain objects in tests and immune to SDK
 * type-path churn.
 */
export interface ReportedUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

/** Aggregated token usage for one stage of a photo turn. */
export interface StageUsage {
  /** Completed upstream calls that reported usage (retries included). */
  calls: number;
  prompt: number;
  completion: number;
  /** Reasoning tokens are part of `completion`, broken out for cost math. */
  reasoning: number;
}

/** Passed down into a pipeline; called once per completed model call. */
export type UsageRecorder = (usage: ReportedUsage | undefined) => void;

export interface PhotoUsageLog {
  /** A recorder that adds every usage it is handed to `stage`'s totals. */
  recorder(stage: string): UsageRecorder;
  /** Copy of the per-stage totals so far; undefined when nothing recorded. */
  snapshot(): Record<string, StageUsage> | undefined;
}

export function createPhotoUsageLog(): PhotoUsageLog {
  const stages = new Map<string, StageUsage>();
  return {
    recorder(stage) {
      return (usage) => {
        // Mocked tests and exotic gateways may omit usage entirely; an
        // absent report must never break the turn it was accounting for.
        if (!usage) return;
        const entry = stages.get(stage) ?? { calls: 0, prompt: 0, completion: 0, reasoning: 0 };
        entry.calls += 1;
        entry.prompt += usage.prompt_tokens ?? 0;
        entry.completion += usage.completion_tokens ?? 0;
        entry.reasoning += usage.completion_tokens_details?.reasoning_tokens ?? 0;
        stages.set(stage, entry);
      };
    },
    snapshot() {
      if (stages.size === 0) return undefined;
      // Deep-enough copy: a straggling recorder (e.g. a discarded
      // speculative read settling late) must not mutate an already-logged
      // object out from under a log serializer.
      return Object.fromEntries([...stages].map(([stage, use]) => [stage, { ...use }]));
    },
  };
}
