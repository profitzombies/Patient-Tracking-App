/**
 * Privacy worker — runs inside the API server process alongside the office
 * export and notification workers. Drains patient data exports and due
 * account purges on a short cadence.
 */
import { drainPatientExports } from "./exports";
import { drainDuePurges } from "./purge";

let timers: { drain: NodeJS.Timeout } | null = null;

/**
 * Drains patient exports and due purges on a timer. Expiry of finished
 * archives moved to the `retention-exports` job (src/jobs), which runs
 * `sweepExpiredPatientExports` under a lease.
 */
export function startPrivacyWorker(input: { drainEveryMs?: number } = {}): void {
  if (timers) return;
  const drainEveryMs = input.drainEveryMs ?? 30_000;
  const tick = () => {
    void drainPatientExports();
    void drainDuePurges();
  };
  const drain = setInterval(tick, drainEveryMs);
  drain.unref();
  timers = { drain };
  tick();
}

export function stopPrivacyWorker(): void {
  if (!timers) return;
  clearInterval(timers.drain);
  timers = null;
}
