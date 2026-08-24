/**
 * Reliability guards for the coach's upstream model calls.
 *
 * Why this module exists: every coach pipeline used to wait on the model
 * with no bound at all — a hung upstream held the SSE connection open (and,
 * for dish images, pinned one of only two limiter slots) indefinitely, while
 * long recipe/cravings/menu turns wrote zero bytes for the whole call, which
 * is exactly the idle connection proxies kill. Both surfaced as the mystery
 * red "coach is unavailable" bubble. The guards here give every upstream
 * call an idle deadline and give the SSE route a keepalive cadence, so a
 * hung upstream becomes a prompt, explainable, retryable error instead of a
 * silent hang — and logs can say which pipeline failed and after how long.
 */

const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
const DEFAULT_KEEPALIVE_MS = 10_000;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Idle budget for one upstream model call (chat stream, recipe/vision JSON
 * turns, dish images). Read per call so tests and break/heal staging can
 * shrink it via COACH_UPSTREAM_TIMEOUT_MS (set on the workflow restart, like
 * the limiter knobs in limits.ts). Streaming calls restart the budget on
 * every chunk via touch(), so this bounds SILENCE, not total reply time.
 */
export function upstreamTimeoutMs(): number {
  return envPositiveInt("COACH_UPSTREAM_TIMEOUT_MS", DEFAULT_UPSTREAM_TIMEOUT_MS);
}

/**
 * Cadence of SSE comment keepalives (`: keepalive`) on the chat stream.
 * Comment lines are invisible to SSE consumers (the app parses only `data:`
 * lines) but keep bytes moving so idle-connection proxies never drop the
 * stream during long silent model calls. COACH_KEEPALIVE_MS overrides it in
 * tests; production has no reason to change it.
 */
export function keepaliveIntervalMs(): number {
  return envPositiveInt("COACH_KEEPALIVE_MS", DEFAULT_KEEPALIVE_MS);
}

/** A model call sat silent past its idle budget and was aborted as hung. */
export class UpstreamTimeoutError extends Error {
  /** The idle budget that expired, in milliseconds. */
  readonly idleMs: number;

  constructor(call: string, idleMs: number, options?: { cause?: unknown }) {
    super(`${call} produced nothing for ${idleMs}ms; treating the upstream as hung`, options);
    this.name = "UpstreamTimeoutError";
    this.idleMs = idleMs;
  }
}

export interface UpstreamDeadline {
  /** Pass as the model request's signal; fires on parent abort OR expiry. */
  signal: AbortSignal;
  /** True once the idle budget expired (vs. a caller/client abort). */
  readonly expired: boolean;
  /** The idle budget in ms, for error construction and logs. */
  idleMs: number;
  /** Restarts the idle budget — call on every streamed chunk. */
  touch(): void;
  /** Stops the timer and detaches from the parent. Always call (finally). */
  finish(): void;
}

/**
 * An idle deadline linked to a parent abort signal.
 *
 * The returned signal aborts when the parent aborts or when idleMs passes
 * without a touch(). It is a linked CHILD controller rather than a timer on
 * the parent itself because the routes' silence contracts key off the parent
 * signal ("client gone → say nothing"): a deadline expiry must abort the
 * upstream call without looking like a client disconnect. After an abort,
 * `expired` tells the caller which of the two happened, so it can map the
 * SDK's abort error to UpstreamTimeoutError (and retry ladders can decline
 * to burn a retry on a wait that just consumed the whole budget).
 */
export function createUpstreamDeadline(
  parent: AbortSignal,
  idleMs: number = upstreamTimeoutMs(),
): UpstreamDeadline {
  const controller = new AbortController();
  let expired = false;
  let finished = false;
  let timer: NodeJS.Timeout | null = null;

  const expire = () => {
    timer = null;
    expired = true;
    controller.abort();
  };
  const onParentAbort = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    controller.abort();
  };

  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
    timer = setTimeout(expire, idleMs);
  }

  return {
    signal: controller.signal,
    get expired() {
      return expired;
    },
    idleMs,
    touch() {
      if (finished || expired || controller.signal.aborted || timer === null) return;
      clearTimeout(timer);
      timer = setTimeout(expire, idleMs);
    },
    finish() {
      finished = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}
