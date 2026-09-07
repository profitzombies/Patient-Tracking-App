/**
 * Privacy worker — runs inside the API server process alongside the office
 * export and notification workers. Drains patient data exports and due
 * account purges on a short cadence; expires old archives on a longer one.
 */
import { logger } from "../lib/logger";
import { drainPatientExports, sweepExpiredPatientExports } from "./exports";
import { drainDuePurges } from "./purge";

let timers: { drain: NodeJS.Timeout; sweep: NodeJS.Timeout } | null = null;

export function startPrivacyWorker(input: { drainEveryMs?: number; sweepEveryMs?: number } = {}): void {
  if (timers) return;
  const drainEveryMs = input.drainEveryMs ?? 30_000;
  const sweepEveryMs = input.sweepEveryMs ?? 5 * 60_000;
  const tick = () => {
    void drainPatientExports();
    void drainDuePurges();
  };
  const drain = setInterval(tick, drainEveryMs);
  const sweep = setInterval(() => {
    sweepExpiredPatientExports().catch((error) => logger.error({ err: error }, "patient export sweep failed"));
  }, sweepEveryMs);
  drain.unref();
  sweep.unref();
  timers = { drain, sweep };
  tick();
  sweepExpiredPatientExports().catch((error) => logger.error({ err: error }, "patient export sweep failed"));
}

export function stopPrivacyWorker(): void {
  if (!timers) return;
  clearInterval(timers.drain);
  clearInterval(timers.sweep);
  timers = null;
}
