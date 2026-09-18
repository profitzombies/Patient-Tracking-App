/**
 * Per-request dependency flags.
 *
 * The request log and the latency metrics say whether a request touched the
 * database or an AI model. Rather than threading a flag through every
 * handler, the database helper and the OpenAI client mark the current
 * request through AsyncLocalStorage; code running outside a request (jobs,
 * workers) finds no store and the mark is a no-op.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type RequestDependency = "db" | "ai";

export interface RequestDependencyFlags {
  db: boolean;
  ai: boolean;
}

const storage = new AsyncLocalStorage<RequestDependencyFlags>();

/** Run `fn` with a fresh flag set bound to the current async chain. */
export function runWithRequestFlags<T>(flags: RequestDependencyFlags, fn: () => T): T {
  return storage.run(flags, fn);
}

/** Mark the current request as having used a dependency; no-op outside a request. */
export function markRequestDependency(dependency: RequestDependency): void {
  const flags = storage.getStore();
  if (flags) flags[dependency] = true;
}

/** The current request's flags, or null when not inside a request. */
export function currentRequestFlags(): RequestDependencyFlags | null {
  return storage.getStore() ?? null;
}
