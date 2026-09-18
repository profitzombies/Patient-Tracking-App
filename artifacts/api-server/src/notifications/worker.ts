/**
 * Notification worker — the scheduler tick, runnable two ways:
 *
 *   * in-process: `startNotificationWorker()` from the API server's listen
 *     callback ticks every NOTIFICATIONS_TICK_MS (default 30 s) and evaluates
 *     coach outreach every NOTIFICATIONS_OUTREACH_EVERY_MS (default 15 min)
 *     and missed-dose backups every NOTIFICATIONS_MISSED_DOSE_EVERY_MS
 *     (default 10 min) and upcoming-renewal reminders every
 *     NOTIFICATIONS_RENEWAL_EVERY_MS (default 60 min);
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
import { runMissedDoseEvaluation, type MissedDoseRunSummary } from "./missed-dose";
import { runRenewalReminderEvaluation, type RenewalReminderSummary } from "../billing/patient-notices";
import { runNotificationTick, type TickSummary } from "./sender";
import { loadTickPolicy, type TickPolicy } from "./tick-policy";
import { supabaseNotificationStore, type NotificationStore } from "./store";
import { runStaffNotificationTick, type StaffSenderSummary } from "../alerts/staff-sender";
import { supabaseStaffNotificationStore } from "../alerts/store";

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
  missedDoses: MissedDoseRunSummary | null;
  renewals: RenewalReminderSummary | null;
  staffOutbox: StaffSenderSummary;
}

let inFlight: Promise<ScheduledTickResult> | null = null;
let lastOutreachAt = 0;
let lastMissedDoseAt = 0;
let lastRenewalAt = 0;

/**
 * One scheduler pass. `outreach: true` forces the coach evaluation; otherwise
 * it runs when its interval has elapsed since the last pass in this process.
 */
export function runScheduledTick(
  options: { outreach?: boolean; missedDoses?: boolean; renewals?: boolean; store?: NotificationStore; pushClient?: ExpoPushClient; now?: () => Date } = {},
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
    const missedDue =
      options.missedDoses === true ||
      (options.missedDoses !== false && nowMs - lastMissedDoseAt >= envMs("NOTIFICATIONS_MISSED_DOSE_EVERY_MS", 10 * 60_000));
    const renewalsDue =
      options.renewals === true ||
      (options.renewals !== false && nowMs - lastRenewalAt >= envMs("NOTIFICATIONS_RENEWAL_EVERY_MS", 60 * 60_000));
    let outreach: OutreachRunSummary | null = null;
    let missedDoses: MissedDoseRunSummary | null = null;
    let renewals: RenewalReminderSummary | null = null;
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
    if (missedDue) {
      lastMissedDoseAt = nowMs;
      try {
        missedDoses = await runMissedDoseEvaluation({
          store,
          now,
          log: (event, detail) => logger.warn(detail, event),
        });
      } catch (error) {
        logger.error({ err: error }, "missed-dose evaluation failed");
      }
    }
    if (renewalsDue) {
      lastRenewalAt = nowMs;
      try {
        renewals = await runRenewalReminderEvaluation({ store, now });
      } catch (error) {
        logger.error({ err: error }, "renewal reminder evaluation failed");
      }
    }
    const outbox = await runNotificationTick({
      store,
      push: client,
      now,
      // The drain keeps claiming until the outbox is empty or this budget is
      // spent; a scheduled tick every 30 s then picks up whatever is left.
      config: { owner: OWNER, tickBudgetMs: envMs("NOTIFICATIONS_TICK_BUDGET_MS", 20_000) },
      log: (event, detail) => (event === "notification_batch" ? logger.info(detail, event) : logger.warn(detail, event)),
      policy,
    });
    const staffOutbox = await runStaffNotificationTick({
      store: supabaseStaffNotificationStore,
      push: client,
      now,
      owner: `${OWNER}:staff`,
    });
    if (outbox.claimed > 0 || outbox.receiptsChecked > 0 || outbox.tokensRetired > 0 || (outreach && outreach.sent > 0) || (missedDoses && missedDoses.sent > 0) || (renewals && renewals.queued > 0)) {
      logger.info(
        {
          claimed: outbox.claimed,
          sent: outbox.sent,
          delivered: outbox.delivered,
          retired: outbox.tokensRetired,
          elapsedMs: outbox.elapsedMs,
          batches: outbox.batches,
          budgetExhausted: outbox.budgetExhausted,
          outbox,
          staffOutbox,
          outreach,
          missedDoses,
          renewals,
        },
        "notification tick",
      );
    }
    return { owner: OWNER, outbox, staffOutbox, outreach, missedDoses, renewals };
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
