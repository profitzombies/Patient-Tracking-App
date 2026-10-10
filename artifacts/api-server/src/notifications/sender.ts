/**
 * The outbox sender: one "tick" drains due notifications in successive
 * claimed batches until the outbox is empty or the tick's time budget is
 * spent, applies the patient's send policy, pushes through the Expo service
 * (100 messages per request, never splitting one row across requests),
 * records tickets, schedules retries, and (on later ticks) resolves receipts.
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
 * Throughput. A tick loops claim → prepare → send → record. The claim size
 * starts at `claimLimit` and doubles after a batch the push service accepted
 * cleanly, halves (down to `claimLimitMin`) after a transport failure, a rate
 * limit, or per-message provider errors, and never exceeds `claimLimitMax`
 * (the claim RPC's own ceiling). Policy contexts and device tokens are read
 * once per batch, attempts are inserted once per batch, and row status writes
 * run a few at a time. The loop stops claiming once `tickBudgetMs` has
 * elapsed; the batch in progress always finishes, and whatever is left waits
 * for the next tick.
 *
 * Every write made while a row is being processed is guarded by the lease
 * owner: if another process re-claimed the row (lease expired mid-flight) the
 * late write is dropped rather than clobbering the newer state. Claims come
 * from a FOR UPDATE SKIP LOCKED RPC, so two processes never send one row, and
 * a batch that runs long renews its leases at the half-life so a slow push
 * request cannot hand the same rows to a second sender.
 *
 * Dead devices: a DeviceNotRegistered ticket or receipt retires the token
 * (disabled_reason device_not_registered). Token reads only ever return
 * active rows, so a retired device is skipped from the very next batch while
 * the patient's other devices keep receiving.
 */
import {
  isTokenDeadError,
  isTransientPushError,
  MAX_MESSAGES_PER_REQUEST,
  PushTransportError,
  type ExpoPushClient,
  type PushMessage,
  type PushTicket,
} from "./expo-push";
import { evaluateSendPolicy } from "./policy";
import { sendGuarded } from "./push-guard";
import { DIET_PATIENT_PUSH, DIET_PATIENT_PUSH_KIND, isDietPatientKind } from "../diet/push-kinds";
import { DEFAULT_TICK_POLICY, defaultsFor, type TickPolicy } from "./tick-policy";
import type { AttemptInsert, NotificationStore } from "./store";
import type { NotificationRow, NotificationStatus, PolicyContext, PushTokenRow } from "./types";

/** Android channel the app creates for server-sent messages. */
export const PUSH_CHANNEL_ID = "thinnr-messages";
export const CARE_TEAM_PUSH_TITLE = "A message from your care team";
export const CARE_TEAM_PUSH_BODY = "You have a new care team message.";
/** Suggestions never name the product on the lock screen; the card inside the chat does. */
export const CARE_TEAM_SUGGESTION_PUSH_BODY = "Your care team suggested something for you. Open the app to see it.";

/** The claim RPC clamps p_limit to this many rows; asking for more is a no-op. */
export const CLAIM_LIMIT_CEILING = 200;
/** Row status writes in flight at once while a batch is recorded. */
export const RECORD_CONCURRENCY = 8;

export interface SenderConfig {
  owner: string;
  /** Rows asked for by the first claim of a tick; later claims adapt. */
  claimLimit: number;
  /** Floor the claim size shrinks to under provider pressure. */
  claimLimitMin: number;
  /** Ceiling the claim size grows to on clean batches (≤ CLAIM_LIMIT_CEILING). */
  claimLimitMax: number;
  leaseSeconds: number;
  /** Wall-clock budget for the claim loop; the batch in progress always finishes. */
  tickBudgetMs: number;
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
  claimLimitMin: 10,
  claimLimitMax: CLAIM_LIMIT_CEILING,
  leaseSeconds: 120,
  tickBudgetMs: 20_000,
  maxAttempts: 5,
  baseBackoffMs: 30_000,
  maxBackoffMs: 60 * 60_000,
  receiptDelayMs: 15 * 60_000,
  receiptGiveUpMs: 24 * 60 * 60_000,
  receiptLimit: 100,
};

export interface TickSummary {
  claimed: number;
  /** Claim → send → record rounds this tick ran. */
  batches: number;
  sent: number;
  retried: number;
  failed: number;
  suppressed: number;
  optedOut: number;
  deferred: number;
  expired: number;
  leaseLost: number;
  leasesRenewed: number;
  receiptsChecked: number;
  delivered: number;
  /** Device tokens retired this tick (DeviceNotRegistered tickets or receipts). */
  tokensRetired: number;
  /** Wall-clock time the outbox drain took, receipts excluded. */
  elapsedMs: number;
  /** True when due rows were left for the next tick because the budget ran out. */
  budgetExhausted: boolean;
  /** Claim size the adaptive loop ended on. */
  lastClaimLimit: number;
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

/** What a batch told us about the push service, which steers the next claim size. */
export interface BatchOutcome {
  /** A push request failed outright (network, 5xx, 429). */
  transportFailed: boolean;
  /** HTTP 429 or MessageRateExceeded tickets. */
  rateLimited: boolean;
  /** Per-message error tickets other than dead devices (ExpoError, InvalidCredentials, …). */
  providerErrors: boolean;
}

/**
 * Next claim size: halve under pressure, double after a clean batch, always
 * inside [min, max]. Dead-device tickets are device state, not provider
 * pressure, so they never shrink the batch.
 */
export function nextClaimLimit(
  current: number,
  outcome: BatchOutcome,
  bounds: Pick<SenderConfig, "claimLimitMin" | "claimLimitMax">,
): number {
  const max = Math.max(1, Math.min(CLAIM_LIMIT_CEILING, bounds.claimLimitMax));
  const min = Math.max(1, Math.min(max, bounds.claimLimitMin));
  if (outcome.transportFailed || outcome.rateLimited || outcome.providerErrors) {
    return Math.max(min, Math.floor(current / 2));
  }
  return Math.min(max, current * 2);
}

function clampClaimLimit(value: number, bounds: Pick<SenderConfig, "claimLimitMin" | "claimLimitMax">): number {
  const max = Math.max(1, Math.min(CLAIM_LIMIT_CEILING, bounds.claimLimitMax));
  const min = Math.max(1, Math.min(max, bounds.claimLimitMin));
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function emptySummary(claimLimit: number): TickSummary {
  return {
    claimed: 0,
    batches: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    suppressed: 0,
    optedOut: 0,
    deferred: 0,
    expired: 0,
    leaseLost: 0,
    leasesRenewed: 0,
    receiptsChecked: 0,
    delivered: 0,
    tokensRetired: 0,
    elapsedMs: 0,
    budgetExhausted: false,
    lastClaimLimit: claimLimit,
  };
}

function truncate(text: string, max = 480): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs async tasks with at most `limit` in flight; every task settles (errors are returned, not thrown). */
async function runPooled(tasks: Array<() => Promise<void>>, limit: number): Promise<unknown[]> {
  const errors: unknown[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      try {
        await task();
      } catch (error) {
        errors.push(error);
      }
    }
  });
  await Promise.all(workers);
  return errors;
}

export async function runNotificationTick(deps: SenderDeps): Promise<TickSummary> {
  const config: SenderConfig = { ...DEFAULT_SENDER_CONFIG, ...deps.config, owner: deps.config.owner };
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  let claimLimit = clampClaimLimit(config.claimLimit, config);
  const summary = emptySummary(claimLimit);
  const startedMs = now().getTime();
  const elapsed = () => now().getTime() - startedMs;

  let policy: TickPolicy | null = null;
  const loadPolicy = async (): Promise<TickPolicy> => {
    policy ??= typeof deps.policy === "function" ? await deps.policy() : deps.policy ?? DEFAULT_TICK_POLICY;
    return policy;
  };

  while (true) {
    if (summary.batches > 0 && elapsed() >= config.tickBudgetMs) {
      summary.budgetExhausted = true;
      break;
    }
    const requested = claimLimit;
    const claimed = await deps.store.claimDue(config.owner, requested, config.leaseSeconds);
    if (!claimed.length) break;
    summary.batches += 1;
    summary.claimed += claimed.length;
    const ctx: Ctx = { ...deps, config, now, log, summary, policy: await loadPolicy() };
    let outcome: BatchOutcome;
    try {
      outcome = await processBatch(claimed, ctx);
    } catch (error) {
      // A batch-level store failure (policy read, token read, attempt insert):
      // the rows stay leased and another tick re-claims them once the lease
      // lapses. Stop claiming — the store is the problem, not the batch size.
      log("notification_batch_error", { batch: summary.batches, rows: claimed.length, error: errorText(error) });
      break;
    }
    claimLimit = nextClaimLimit(requested, outcome, config);
    summary.lastClaimLimit = claimLimit;
    log("notification_batch", {
      batch: summary.batches,
      requested,
      claimed: claimed.length,
      nextClaimLimit: claimLimit,
      elapsedMs: elapsed(),
      ...outcome,
    });
    // Fewer rows than asked for means nothing else is due right now.
    if (claimed.length < requested) break;
  }
  summary.elapsedMs = elapsed();

  try {
    await processReceipts({ ...deps, config, now, log, summary, policy: policy ?? DEFAULT_TICK_POLICY });
  } catch (error) {
    log("notification_receipts_error", { error: errorText(error) });
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

/** A row that passed policy and is ready to push: its devices and the messages for them. */
interface PendingSend {
  row: NotificationRow;
  attempt: number;
  tokens: PushTokenRow[];
  messages: PushMessage[];
}

/**
 * Policy pass for one claimed row. Rows that stop here are finalized or
 * requeued immediately; rows that should be pushed come back as PendingSend.
 */
async function prepareRow(
  row: NotificationRow,
  context: PolicyContext,
  tokens: PushTokenRow[],
  ctx: Ctx,
): Promise<PendingSend | null> {
  const now = ctx.now();
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    if (await finalize(ctx, row, "expired")) ctx.summary.expired += 1;
    return null;
  }

  if (row.kind === "care_team_reply") {
    const expectedProviderId =
      typeof row.data.providerId === "string"
        ? row.data.providerId
        : typeof row.data.businessId === "string"
          ? row.data.businessId
          : null;
    const unavailable =
      context.patientAvailable === false
        ? "patient_unavailable"
        : !expectedProviderId || expectedProviderId !== context.providerId
          ? "office_transferred"
          : context.officeLocked
            ? "office_locked"
            : context.officeAvailable === false
              ? "office_unavailable"
              : null;
    if (unavailable) {
      if (await finalize(ctx, row, "suppressed", { suppression_reason: unavailable })) ctx.summary.suppressed += 1;
      return null;
    }
  }
  const decision = evaluateSendPolicy({
    category: row.category,
    context,
    now,
    expiresAt: new Date(row.expires_at),
    defaults: defaultsFor(ctx.policy, context.providerId),
  });
  if (decision.action === "opt_out") {
    if (await finalize(ctx, row, "opted_out", { suppression_reason: decision.reason })) ctx.summary.optedOut += 1;
    return null;
  }
  if (decision.action === "suppress") {
    if (await finalize(ctx, row, "suppressed", { suppression_reason: decision.reason })) ctx.summary.suppressed += 1;
    return null;
  }
  if (decision.action === "defer") {
    if (await requeue(ctx, row, decision.until, { suppression_reason: decision.reason })) ctx.summary.deferred += 1;
    return null;
  }

  if (!tokens.length) {
    if (await finalize(ctx, row, "suppressed", { suppression_reason: "no_device" })) ctx.summary.suppressed += 1;
    return null;
  }

  const isSuggestion = row.kind === "care_team_reply"
    && (row.data.suggestion === true || typeof row.data.suggestion === "string");
  const careTeamData =
    row.kind === "care_team_reply"
      ? {
          patientId: row.patient_id,
          thread: "care_team",
          ...(typeof row.data.conversationId === "string" ? { conversationId: row.data.conversationId } : {}),
        }
      : row.data;
  // Diet rows keep their specific kind and copy for the authenticated in-app
  // list; the vendor sees one generic kind, generic copy, and a route only.
  const diet = isDietPatientKind(row.kind);
  const external = diet
    ? {
        title: DIET_PATIENT_PUSH.title,
        body: DIET_PATIENT_PUSH.body,
        data: { route: typeof row.data.route === "string" ? row.data.route : "/(tabs)/account", notificationId: row.id, kind: DIET_PATIENT_PUSH_KIND, category: row.category },
      }
    : {
        title: row.kind === "care_team_reply" ? CARE_TEAM_PUSH_TITLE : row.title,
        body: row.kind === "care_team_reply" ? (isSuggestion ? CARE_TEAM_SUGGESTION_PUSH_BODY : CARE_TEAM_PUSH_BODY) : row.body,
        data: { ...careTeamData, notificationId: row.id, kind: row.kind, category: row.category },
      };
  const messages: PushMessage[] = tokens.map((token) => ({
    to: token.token,
    ...external,
    sound: "default",
    channelId: PUSH_CHANNEL_ID,
    priority: "high",
  }));
  return { row, attempt: row.attempts + 1, tokens, messages };
}

/** Packs rows into push requests of at most `size` messages without splitting one row across requests. */
export function packSendChunks<T extends { messages: unknown[] }>(pending: T[], size: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let count = 0;
  for (const item of pending) {
    if (current.length && count + item.messages.length > size) {
      chunks.push(current);
      current = [];
      count = 0;
    }
    current.push(item);
    count += item.messages.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Renews the batch's leases once half the lease has gone by, so a slow push request cannot lapse them. */
async function renewIfNeeded(ctx: Ctx, clock: { leasedAt: number }, ids: string[]): Promise<void> {
  const halfLife = (ctx.config.leaseSeconds * 1000) / 2;
  if (ctx.now().getTime() - clock.leasedAt < halfLife || !ids.length) return;
  const renewed = await ctx.store.renewLeases(ctx.config.owner, ids, ctx.config.leaseSeconds);
  ctx.summary.leasesRenewed += renewed;
  clock.leasedAt = ctx.now().getTime();
}

interface SendResult {
  pending: PendingSend;
  /** One ticket per message, or null when the whole request failed. */
  tickets: PushTicket[] | null;
  transportError: string | null;
  transportStatus: number | null;
}

/**
 * One claimed batch: policy for every row (two batched reads), one push
 * request per 100 messages, one attempt insert, then guarded status writes.
 * Throws only on batch-level store failures; per-row problems are recorded
 * on the row and never abort the batch.
 */
async function processBatch(rows: NotificationRow[], ctx: Ctx): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { transportFailed: false, rateLimited: false, providerErrors: false };
  const clock = { leasedAt: ctx.now().getTime() };
  const patientIds = [...new Set(rows.map((row) => row.patient_id))];
  const [contexts, tokensByPatient] = await Promise.all([
    ctx.store.policyContexts(patientIds),
    ctx.store.activeTokensFor(patientIds),
  ]);

  const pending: PendingSend[] = [];
  for (const row of rows) {
    try {
      const context = contexts.get(row.patient_id);
      if (!context) throw new Error("policy context missing for patient");
      const prepared = await prepareRow(row, context, tokensByPatient.get(row.patient_id) ?? [], ctx);
      if (prepared) pending.push(prepared);
    } catch (error) {
      // Leave the row leased; the lease expires and another tick re-claims it.
      ctx.log("notification_process_error", { id: row.id, error: errorText(error) });
    }
  }
  if (!pending.length) return outcome;
  const pendingIds = pending.map((p) => p.row.id);

  await renewIfNeeded(ctx, clock, pendingIds);
  const results: SendResult[] = [];
  for (const chunk of packSendChunks(pending, MAX_MESSAGES_PER_REQUEST)) {
    const messages = chunk.flatMap((p) => p.messages);
    try {
      const tickets = await sendGuarded(ctx.push, messages);
      let offset = 0;
      for (const p of chunk) {
        results.push({ pending: p, tickets: tickets.slice(offset, offset + p.messages.length), transportError: null, transportStatus: null });
        offset += p.messages.length;
      }
    } catch (error) {
      outcome.transportFailed = true;
      const status = error instanceof PushTransportError ? error.status : null;
      if (status === 429) outcome.rateLimited = true;
      const message = error instanceof PushTransportError ? error.message : `push send failed: ${String(error)}`;
      for (const p of chunk) results.push({ pending: p, tickets: null, transportError: message, transportStatus: status });
    }
  }
  await renewIfNeeded(ctx, clock, pendingIds);

  const attempts: AttemptInsert[] = [];
  const deadTokenIds = new Set<string>();
  const writes: Array<() => Promise<void>> = [];
  for (const result of results) {
    const { row, attempt, tokens } = result.pending;
    if (result.tickets === null) {
      const message = result.transportError ?? "push send failed";
      attempts.push({
        notification_id: row.id,
        patient_id: row.patient_id,
        token_id: null,
        attempt,
        ticket_id: null,
        outcome: "request_failed",
        error_code: result.transportStatus ? `HTTP_${result.transportStatus}` : "TRANSPORT",
        error_message: truncate(message),
      });
      writes.push(() => retryOrFail(ctx, row, attempt, message));
      continue;
    }
    let anyOk = false;
    let anyTransient = false;
    let firstError: string | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const ticket = result.tickets[i];
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
        deadTokenIds.add(token.id);
      } else {
        outcome.providerErrors = true;
        if (code === "MessageRateExceeded") outcome.rateLimited = true;
        if (code === "InvalidCredentials") firstError ??= "InvalidCredentials";
        else if (isTransientPushError(code)) anyTransient = true;
      }
      firstError ??= code ?? ticket.message ?? "push ticket error";
    }
    if (anyOk) {
      writes.push(async () => {
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
      });
    } else if (anyTransient) {
      writes.push(() => retryOrFail(ctx, row, attempt, firstError ?? "transient push error"));
    } else {
      writes.push(async () => {
        if (await finalize(ctx, row, "failed", { last_error: truncate(firstError ?? "push rejected"), attempts: attempt })) {
          ctx.summary.failed += 1;
        }
      });
    }
  }

  await ctx.store.insertAttempts(attempts);
  for (const tokenId of deadTokenIds) {
    await ctx.store.disableToken(tokenId, "device_not_registered");
    ctx.summary.tokensRetired += 1;
  }
  const errors = await runPooled(writes, RECORD_CONCURRENCY);
  for (const error of errors) ctx.log("notification_process_error", { error: errorText(error) });
  return outcome;
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
      ctx.log("notification_receipts_unavailable", { error: errorText(error) });
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
        // The device is gone: retire it so no later send is attempted to it.
        await ctx.store.disableToken(attempt.token_id, "device_not_registered");
        ctx.summary.tokensRetired += 1;
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
