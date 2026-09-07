/**
 * The outbox sender: one "tick" claims due notifications, applies the
 * patient's send policy, pushes through the Expo service, records tickets,
 * schedules retries, and (on later ticks) resolves receipts.
 *
 * State machine (patient_notifications.status):
 *
 *   queued ──claim──▶ sending ──tickets ok──▶ sent ──receipt ok──▶ delivered ──app opened──▶ opened
 *                       │                        │
 *                       │                        └─receipt error / all dead tokens──▶ failed
 *                       ├─transport failure / transient ticket error──▶ queued (backoff, attempts+1)
 *                       │                                             └─attempts exhausted──▶ failed
 *                       ├─category off / nudge opt-out──▶ opted_out   (suppression_reason)
 *                       ├─quiet hours──▶ queued at window end        (reason quiet_hours_deferred)
 *                       ├─quiet hours past expiry / no device──▶ suppressed (reason)
 *                       └─past expires_at──▶ expired
 *
 * Every write made while a row is being processed is guarded by the lease
 * owner: if another process re-claimed the row (lease expired mid-flight) the
 * late write is dropped rather than clobbering the newer state. Claims come
 * from a FOR UPDATE SKIP LOCKED RPC, so two processes never send one row.
 */
import {
  isTokenDeadError,
  isTransientPushError,
  PushTransportError,
  type ExpoPushClient,
  type PushMessage,
} from "./expo-push";
import { evaluateSendPolicy } from "./policy";
import { DEFAULT_TICK_POLICY, defaultsFor, type TickPolicy } from "./tick-policy";
import type { AttemptInsert, NotificationStore } from "./store";
import type { NotificationRow, NotificationStatus } from "./types";

/** Android channel the app creates for server-sent messages. */
export const PUSH_CHANNEL_ID = "thinnr-messages";

export interface SenderConfig {
  owner: string;
  claimLimit: number;
  leaseSeconds: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** How long after a send before receipts are asked for (Expo suggests ~15 min). */
  receiptDelayMs: number;
  /** After this long without a receipt the ticket is recorded as unresolved. */
  receiptGiveUpMs: number;
  receiptLimit: number;
}

export const DEFAULT_SENDER_CONFIG: Omit<SenderConfig, "owner"> = {
  claimLimit: 25,
  leaseSeconds: 120,
  maxAttempts: 5,
  baseBackoffMs: 30_000,
  maxBackoffMs: 60 * 60_000,
  receiptDelayMs: 15 * 60_000,
  receiptGiveUpMs: 24 * 60 * 60_000,
  receiptLimit: 100,
};

export interface TickSummary {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  suppressed: number;
  optedOut: number;
  deferred: number;
  expired: number;
  leaseLost: number;
  receiptsChecked: number;
  delivered: number;
  tokensDisabled: number;
}

export interface SenderDeps {
  store: NotificationStore;
  push: ExpoPushClient;
  now?: () => Date;
  config: Partial<SenderConfig> & { owner: string };
  log?: (event: string, detail: Record<string, unknown>) => void;
  /**
   * Organization policy for this tick (HQ defaults + office overrides). The
   * worker loads it once per tick; when omitted the built-in defaults apply
   * (default-on categories, no quiet hours) — unit tests exercise both.
   */
  policy?: TickPolicy | (() => Promise<TickPolicy>);
}

export function backoffMs(attempt: number, config: Pick<SenderConfig, "baseBackoffMs" | "maxBackoffMs">): number {
  return Math.min(config.maxBackoffMs, config.baseBackoffMs * 2 ** Math.max(0, attempt - 1));
}

function emptySummary(): TickSummary {
  return {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    suppressed: 0,
    optedOut: 0,
    deferred: 0,
    expired: 0,
    leaseLost: 0,
    receiptsChecked: 0,
    delivered: 0,
    tokensDisabled: 0,
  };
}

function truncate(text: string, max = 480): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function runNotificationTick(deps: SenderDeps): Promise<TickSummary> {
  const config: SenderConfig = { ...DEFAULT_SENDER_CONFIG, ...deps.config, owner: deps.config.owner };
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const summary = emptySummary();

  const claimed = await deps.store.claimDue(config.owner, config.claimLimit, config.leaseSeconds);
  summary.claimed = claimed.length;
  const policy = claimed.length
    ? typeof deps.policy === "function" ? await deps.policy() : deps.policy ?? DEFAULT_TICK_POLICY
    : DEFAULT_TICK_POLICY;
  for (const row of claimed) {
    try {
      await processClaimed(row, { ...deps, config, now, log, summary, policy });
    } catch (error) {
      // Unexpected store failure: leave the row leased; the lease expires and
      // another tick re-claims it. Never let one row abort the batch.
      log("notification_process_error", { id: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  try {
    await processReceipts({ ...deps, config, now, log, summary, policy });
  } catch (error) {
    log("notification_receipts_error", { error: error instanceof Error ? error.message : String(error) });
  }
  return summary;
}

interface Ctx {
  store: NotificationStore;
  push: ExpoPushClient;
  config: SenderConfig;
  now: () => Date;
  log: (event: string, detail: Record<string, unknown>) => void;
  summary: TickSummary;
  policy: TickPolicy;
}

async function finalize(
  ctx: Ctx,
  row: NotificationRow,
  status: NotificationStatus,
  extra: { suppression_reason?: string | null; last_error?: string | null; attempts?: number } = {},
): Promise<boolean> {
  const updated = await ctx.store.updateNotification(
    row.id,
    {
      status,
      finalized_at: ctx.now().toISOString(),
      lease_owner: null,
      lease_until: null,
      ...extra,
    },
    { leaseOwner: ctx.config.owner },
  );
  if (!updated) ctx.summary.leaseLost += 1;
  return updated !== null;
}

async function requeue(
  ctx: Ctx,
  row: NotificationRow,
  at: Date,
  extra: { suppression_reason?: string | null; last_error?: string | null; attempts?: number },
): Promise<boolean> {
  const updated = await ctx.store.updateNotification(
    row.id,
    {
      status: "queued",
      next_attempt_at: at.toISOString(),
      lease_owner: null,
      lease_until: null,
      ...extra,
    },
    { leaseOwner: ctx.config.owner },
  );
  if (!updated) ctx.summary.leaseLost += 1;
  return updated !== null;
}

async function retryOrFail(ctx: Ctx, row: NotificationRow, attempt: number, error: string): Promise<void> {
  const message = truncate(error);
  if (attempt >= ctx.config.maxAttempts) {
    if (await finalize(ctx, row, "failed", { last_error: message, attempts: attempt })) ctx.summary.failed += 1;
    return;
  }
  const nextAt = new Date(ctx.now().getTime() + backoffMs(attempt, ctx.config));
  if (nextAt.getTime() >= new Date(row.expires_at).getTime()) {
    if (await finalize(ctx, row, "failed", { last_error: message, attempts: attempt })) ctx.summary.failed += 1;
    return;
  }
  if (await requeue(ctx, row, nextAt, { last_error: message, attempts: attempt })) ctx.summary.retried += 1;
}

async function processClaimed(row: NotificationRow, ctx: Ctx): Promise<void> {
  const now = ctx.now();
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    if (await finalize(ctx, row, "expired")) ctx.summary.expired += 1;
    return;
  }

  const context = await ctx.store.policyContext(row.patient_id);
  const decision = evaluateSendPolicy({
    category: row.category,
    context,
    now,
    expiresAt: new Date(row.expires_at),
    defaults: defaultsFor(ctx.policy, context.providerId),
  });
  if (decision.action === "opt_out") {
    if (await finalize(ctx, row, "opted_out", { suppression_reason: decision.reason })) ctx.summary.optedOut += 1;
    return;
  }
  if (decision.action === "suppress") {
    if (await finalize(ctx, row, "suppressed", { suppression_reason: decision.reason })) ctx.summary.suppressed += 1;
    return;
  }
  if (decision.action === "defer") {
    if (await requeue(ctx, row, decision.until, { suppression_reason: decision.reason })) ctx.summary.deferred += 1;
    return;
  }

  const tokens = await ctx.store.activeTokens(row.patient_id);
  if (!tokens.length) {
    if (await finalize(ctx, row, "suppressed", { suppression_reason: "no_device" })) ctx.summary.suppressed += 1;
    return;
  }

  const attempt = row.attempts + 1;
  const messages: PushMessage[] = tokens.map((token) => ({
    to: token.token,
    title: row.title,
    body: row.body,
    data: { ...row.data, notificationId: row.id, kind: row.kind, category: row.category },
    sound: "default",
    channelId: PUSH_CHANNEL_ID,
    priority: "high",
  }));

  let tickets;
  try {
    tickets = await ctx.push.send(messages);
  } catch (error) {
    const message = error instanceof PushTransportError ? error.message : `push send failed: ${String(error)}`;
    await ctx.store.insertAttempts([
      {
        notification_id: row.id,
        patient_id: row.patient_id,
        token_id: null,
        attempt,
        ticket_id: null,
        outcome: "request_failed",
        error_code: error instanceof PushTransportError && error.status ? `HTTP_${error.status}` : "TRANSPORT",
        error_message: truncate(message),
      },
    ]);
    await retryOrFail(ctx, row, attempt, message);
    return;
  }

  const attempts: AttemptInsert[] = [];
  let anyOk = false;
  let anyTransient = false;
  let firstError: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const ticket = tickets[i];
    if (!ticket) continue;
    if (ticket.status === "ok") {
      anyOk = true;
      attempts.push({
        notification_id: row.id,
        patient_id: row.patient_id,
        token_id: token.id,
        attempt,
        ticket_id: ticket.id,
        outcome: "ticket_ok",
        error_code: null,
        error_message: null,
      });
      continue;
    }
    const code = ticket.details?.error;
    attempts.push({
      notification_id: row.id,
      patient_id: row.patient_id,
      token_id: token.id,
      attempt,
      ticket_id: null,
      outcome: "ticket_error",
      error_code: code ?? "UNKNOWN",
      error_message: truncate(ticket.message ?? ""),
    });
    if (isTokenDeadError(code)) {
      await ctx.store.disableToken(token.id, "device_not_registered");
      ctx.summary.tokensDisabled += 1;
    } else if (code === "InvalidCredentials") {
      firstError ??= "InvalidCredentials";
    } else if (isTransientPushError(code)) {
      anyTransient = true;
    }
    firstError ??= code ?? ticket.message ?? "push ticket error";
  }
  await ctx.store.insertAttempts(attempts);

  if (anyOk) {
    const updated = await ctx.store.updateNotification(
      row.id,
      {
        status: "sent",
        sent_at: ctx.now().toISOString(),
        attempts: attempt,
        last_error: null,
        suppression_reason: row.suppression_reason,
        lease_owner: null,
        lease_until: null,
      },
      { leaseOwner: ctx.config.owner },
    );
    if (updated) ctx.summary.sent += 1;
    else ctx.summary.leaseLost += 1;
    return;
  }
  if (anyTransient) {
    await retryOrFail(ctx, row, attempt, firstError ?? "transient push error");
    return;
  }
  if (await finalize(ctx, row, "failed", { last_error: truncate(firstError ?? "push rejected"), attempts: attempt })) {
    ctx.summary.failed += 1;
  }
}

async function processReceipts(ctx: Ctx): Promise<void> {
  const now = ctx.now();
  const candidates = await ctx.store.receiptCandidates(
    new Date(now.getTime() - ctx.config.receiptDelayMs),
    ctx.config.receiptLimit,
  );
  if (!candidates.length) return;
  const ticketIds = candidates.flatMap((c) => c.attempts.map((a) => a.ticket_id).filter((id): id is string => !!id));
  let receipts: Awaited<ReturnType<ExpoPushClient["getReceipts"]>> = {};
  if (ticketIds.length) {
    try {
      receipts = await ctx.push.getReceipts(ticketIds);
    } catch (error) {
      ctx.log("notification_receipts_unavailable", { error: error instanceof Error ? error.message : String(error) });
      return;
    }
  }
  for (const candidate of candidates) {
    const sentAt = candidate.notification.sent_at ? new Date(candidate.notification.sent_at).getTime() : now.getTime();
    const giveUp = now.getTime() - sentAt >= ctx.config.receiptGiveUpMs;
    let pending = 0;
    let anyOk = false;
    let firstError: string | null = null;
    for (const attempt of candidate.attempts) {
      const receipt = attempt.ticket_id ? receipts[attempt.ticket_id] : undefined;
      if (!receipt) {
        if (giveUp) {
          await ctx.store.updateAttempt(attempt.id, { receipt_outcome: "missing", receipt_checked_at: now.toISOString() });
        } else {
          pending += 1;
        }
        continue;
      }
      if (receipt.status === "ok") {
        anyOk = true;
        await ctx.store.updateAttempt(attempt.id, { receipt_outcome: "ok", receipt_checked_at: now.toISOString() });
        continue;
      }
      const code = receipt.details?.error ?? "UNKNOWN";
      firstError ??= code;
      await ctx.store.updateAttempt(attempt.id, {
        receipt_outcome: "error",
        receipt_error_code: code,
        receipt_checked_at: now.toISOString(),
      });
      if (isTokenDeadError(code) && attempt.token_id) {
        await ctx.store.disableToken(attempt.token_id, "device_not_registered");
        ctx.summary.tokensDisabled += 1;
      }
    }
    if (pending > 0) continue;
    ctx.summary.receiptsChecked += 1;
    if (anyOk) {
      const updated = await ctx.store.updateNotification(
        candidate.notification.id,
        { status: "delivered", delivered_at: now.toISOString(), receipts_checked_at: now.toISOString() },
        { statuses: ["sent"] },
      );
      if (updated) ctx.summary.delivered += 1;
      else {
        // The patient already opened it: just close the receipt bookkeeping.
        await ctx.store.updateNotification(candidate.notification.id, { receipts_checked_at: now.toISOString() });
      }
      continue;
    }
    if (firstError) {
      const updated = await ctx.store.updateNotification(
        candidate.notification.id,
        {
          status: "failed",
          last_error: truncate(`receipt: ${firstError}`),
          finalized_at: now.toISOString(),
          receipts_checked_at: now.toISOString(),
        },
        { statuses: ["sent"] },
      );
      if (updated) ctx.summary.failed += 1;
      else await ctx.store.updateNotification(candidate.notification.id, { receipts_checked_at: now.toISOString() });
      continue;
    }
    // Every ticket went unresolved past the give-up window: the push left
    // our hands but delivery was never confirmed. Stays "sent".
    await ctx.store.updateNotification(candidate.notification.id, { receipts_checked_at: now.toISOString() });
  }
}
