/**
 * Notification worker — the scheduler tick, runnable two ways:
 *
 *   * in-process: `startNotificationWorker()` from the API server's listen
 *     callback ticks every NOTIFICATIONS_TICK_MS (default 30 s) and evaluates
 *     coach outreach every NOTIFICATIONS_OUTREACH_EVERY_MS (default 15 min);
 *   * externally: POST /api/internal/notifications/tick with the
 *     NOTIFICATIONS_INTERNAL_TOKEN bearer runs one tick synchronously, so a
 *     scheduled deployment can drive the outbox without a long-lived process.
 *
 * Both paths call `runScheduledTick`, which serializes within the process
 * (one tick at a time) while the database lease keeps separate processes
 * from double-sending. NOTIFICATIONS_DISABLED=1 turns the in-process loop
 * off (a single external scheduler is then the only sender).
 */
import { randomUUID } from "crypto";
import { hostname } from "os";
import { logger } from "../lib/logger";
import { createExpoPushClient, type ExpoPushClient } from "./expo-push";
import { runOutreachEvaluation, type OutreachRunSummary } from "./stall-outreach";
import { runNotificationTick, type TickSummary } from "./sender";
import { loadTickPolicy, type TickPolicy } from "./tick-policy";
import { supabaseNotificationStore, type NotificationStore } from "./store";

/** Blank-safe env knob: unset or blank means the fallback, never zero. */
export function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function notificationsDisabled(): boolean {
  const raw = process.env.NOTIFICATIONS_DISABLED;
  return raw === "1" || raw === "true";
}

const OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

let pushClient: ExpoPushClient | null = null;
function push(): ExpoPushClient {
  if (!pushClient) {
    const token = process.env.EXPO_ACCESS_TOKEN;
    pushClient = createExpoPushClient({ accessToken: token && token.trim() ? token.trim() : null });
  }
  return pushClient;
}

export interface ScheduledTickResult {
  owner: string;
  outbox: TickSummary;
  outreach: OutreachRunSummary | null;
}

let inFlight: Promise<ScheduledTickResult> | null = null;
let lastOutreachAt = 0;

/**
 * One scheduler pass. `outreach: true` forces the coach evaluation; otherwise
 * it runs when its interval has elapsed since the last pass in this process.
 */
export function runScheduledTick(
  options: { outreach?: boolean; store?: NotificationStore; pushClient?: ExpoPushClient; now?: () => Date } = {},
): Promise<ScheduledTickResult> {
  if (inFlight) return inFlight;
  const store = options.store ?? supabaseNotificationStore;
  const client = options.pushClient ?? push();
  const now = options.now ?? (() => new Date());
  const run = (async (): Promise<ScheduledTickResult> => {
    const nowMs = now().getTime();
    const outreachDue =
      options.outreach === true ||
      (options.outreach !== false && nowMs - lastOutreachAt >= envMs("NOTIFICATIONS_OUTREACH_EVERY_MS", 15 * 60_000));
    let outreach: OutreachRunSummary | null = null;
    // One policy read per tick: HQ settings + office overrides, shared by the
    // outreach evaluation (cooldown, cap) and the sender (defaults, quiet hours).
    const policyLog = (event: string, detail: Record<string, unknown>) => logger.warn(detail, event);
    let tickPolicy: Promise<TickPolicy> | null = null;
    const policy = () => (tickPolicy ??= loadTickPolicy(policyLog));
    if (outreachDue) {
      lastOutreachAt = nowMs;
      try {
        outreach = await runOutreachEvaluation({
          store,
          now,
          log: (event, detail) => logger.warn(detail, event),
          policy,
        });
      } catch (error) {
        // The outbox still drains when the evaluation's reads fail.
        logger.error({ err: error }, "coach outreach evaluation failed");
      }
    }
    const outbox = await runNotificationTick({
      store,
      push: client,
      now,
      config: { owner: OWNER },
      log: (event, detail) => logger.warn(detail, event),
      policy,
    });
    if (outbox.claimed > 0 || outbox.receiptsChecked > 0 || (outreach && outreach.sent > 0)) {
      logger.info({ outbox, outreach }, "notification tick");
    }
    return { owner: OWNER, outbox, outreach };
  })();
  inFlight = run.finally(() => {
    inFlight = null;
  });
  return inFlight;
}

let timer: NodeJS.Timeout | null = null;

export function startNotificationWorker(input: { tickEveryMs?: number } = {}): void {
  if (timer || notificationsDisabled()) return;
  const every = input.tickEveryMs ?? envMs("NOTIFICATIONS_TICK_MS", 30_000);
  const tick = () => {
    runScheduledTick().catch((error) => logger.error({ err: error }, "notification tick failed"));
  };
  timer = setInterval(tick, every);
  timer.unref();
  tick();
}

export function stopNotificationWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
