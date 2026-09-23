import crypto from "node:crypto";
import {
  EMAIL_TEMPLATE_IDS, renderEmailTemplate, type EmailTemplateId, type EmailVariables,
} from "@workspace/email-templates";
import { EmailPhiViolationError, recipientDigest, sendTemplatedEmail } from "../email/transport";
import { logger } from "../lib/logger";
import type { JobContext } from "../jobs/types";
import { liveBillingEffectsAllowed } from "./lifecycle-scopes";
import { orderIdFilter } from "./sandbox-verification";
import {
  insert, insertIgnore, selectMany, selectOne, update,
  type BillingCustomerEmailRow, type BillingNotificationContactRow, type CustomerEmailAttempt,
} from "./store";

/**
 * Delivery ledger for branded customer emails.
 *
 * A ledger row is one email to one address. `attemptDelivery` sends it through
 * the single transport seam (PHI lint included), appends an attempt record, and
 * either marks the row sent, schedules a retry with a short backoff, or gives
 * up once the row's attempt budget is spent. The retry job re-composes from
 * the stored template id + variables, so nothing here needs the original
 * order or subscription at retry time.
 *
 * Log lines carry only a recipient hash + domain; the row itself keeps the
 * address because it is the delivery record staff act on.
 */

const enc = encodeURIComponent;
const MINUTE_MS = 60_000;
/** Three tries per row: immediately, then 1 minute later, then 5 minutes after that. */
export const MAX_EMAIL_ATTEMPTS = 3;
const BACKOFF_MS = [1 * MINUTE_MS, 5 * MINUTE_MS];
export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(BACKOFF_MS.length, Math.max(1, attempts)) - 1];
}

/**
 * Transition emails a payer's additional contacts are copied on: the order
 * and shipment notices. Account and payment-method notices stay with the payer.
 */
export const CONTACT_COPY_TEMPLATES: ReadonlySet<EmailTemplateId> = new Set<EmailTemplateId>([
  "order-confirmation", "order-shipped", "order-delivered", "subscription-started",
  "subscription-shipment-moved", "subscription-shipment-skipped", "subscription-renewal-reminder",
]);

export type DeliveryOutcome = "sent" | "retrying" | "failed";

export interface AttemptDeps {
  now?: () => Date;
}

/** Delivers `row` once and records the attempt. Never throws for vendor answers; only store failures propagate. */
export async function attemptDelivery(row: BillingCustomerEmailRow, deps: AttemptDeps = {}): Promise<DeliveryOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const attempts = (row.attempts ?? 0) + 1;
  const maxAttempts = row.max_attempts ?? MAX_EMAIL_ATTEMPTS;
  const recipient = row.recipient ?? "";
  const digest = recipientDigest(recipient);
  const log = [...(row.attempt_log ?? [])];
  const refs = {
    dedupeKey: row.dedupe_key, claimId: row.id, attempt: String(attempts), kind: row.kind,
    orderId: row.order_id ?? null, subscriptionId: row.subscription_id ?? null,
  };
  let deterministic = false;
  try {
    // Rendering is deterministic: a missing variable fails the same way on
    // every attempt, so it never earns a retry. The transport lints PHI next.
    try { renderEmailTemplate(row.template_id as EmailTemplateId, (row.variables ?? {}) as EmailVariables); } catch (error) { deterministic = true; throw error; }
    const result = await sendTemplatedEmail({
      to: recipient, templateId: row.template_id as EmailTemplateId, variables: (row.variables ?? {}) as EmailVariables,
      sender: "branded", refs,
    });
    const entry: CustomerEmailAttempt = {
      at, outcome: "sent", error: null, vendor_message_id: result.messageId, recipient_hash: digest.recipientHash, recipient_domain: digest.recipientDomain,
    };
    await update("billing_customer_emails", `id=eq.${enc(row.id)}`, {
      status: "sent", error: null, attempts, last_attempt_at: at, next_attempt_at: null, sent_at: at,
      vendor_message_id: result.messageId, subject: result.subject, attempt_log: [...log, entry],
    });
    return "sent";
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
    // A PHI refusal is deterministic too: the same variables fail the same way every time.
    if (error instanceof EmailPhiViolationError) deterministic = true;
    const exhausted = attempts >= maxAttempts;
    const permanent = deterministic || exhausted;
    const entry: CustomerEmailAttempt = {
      at, outcome: "failed", error: message, vendor_message_id: null, recipient_hash: digest.recipientHash, recipient_domain: digest.recipientDomain,
    };
    logger.error({ err: error, templateId: row.template_id, dedupeKey: row.dedupe_key, claimId: row.id, attempt: attempts, permanent, ...digest }, "customer email attempt failed");
    await update("billing_customer_emails", `id=eq.${enc(row.id)}`, {
      status: permanent ? "failed" : "retrying",
      error: exhausted && !deterministic ? `${message} (gave up after ${attempts} attempts)` : message,
      attempts, last_attempt_at: at,
      next_attempt_at: permanent ? null : new Date(now.getTime() + backoffMs(attempts)).toISOString(),
      attempt_log: [...log, entry],
    });
    return permanent ? "failed" : "retrying";
  }
}

/** Active additional contacts of a payer, oldest first. */
export async function activeContacts(payerId: string | null | undefined): Promise<BillingNotificationContactRow[]> {
  if (!payerId) return [];
  return selectMany("billing_notification_contacts", `payer_id=eq.${enc(payerId)}&active=is.true&order=created_at.asc&limit=20`);
}

/**
 * Copies the primary email to each of the payer's active additional contacts
 * as its own ledger row (same template and variables, own retry budget).
 * Each copy is keyed on the transition AND the contact, so a replay that
 * somehow reaches this point still cannot double-send.
 */
export async function fanOutToContacts(primary: BillingCustomerEmailRow, deps: AttemptDeps = {}): Promise<void> {
  if (!CONTACT_COPY_TEMPLATES.has(primary.template_id as EmailTemplateId)) return;
  const contacts = await activeContacts(primary.payer_id);
  for (const contact of contacts) {
    if (primary.recipient && contact.email === primary.recipient.trim().toLowerCase()) continue;
    const copy = await insertIgnore("billing_customer_emails", {
      dedupe_key: `${primary.dedupe_key}:contact:${contact.id}`, template_id: primary.template_id, kind: "automatic",
      parent_id: primary.id, contact_id: contact.id, payer_id: primary.payer_id, provider_id: primary.provider_id,
      order_id: primary.order_id, subscription_id: primary.subscription_id, status: "claimed",
      recipient: contact.email, variables: primary.variables, attempts: 0, max_attempts: MAX_EMAIL_ATTEMPTS, attempt_log: [],
    } as Partial<BillingCustomerEmailRow>, "billing_customer_emails_dedupe_key_unique");
    if (copy) await attemptDelivery(copy, deps).catch((error) => logger.error({ err: error, claimId: copy.id }, "customer email contact copy failed"));
  }
}

export class CustomerEmailError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const isTemplateId = (value: string): value is EmailTemplateId => (EMAIL_TEMPLATE_IDS as readonly string[]).includes(value);

/** HTML + text preview re-rendered from the stored template and variables; never a stored body. */
export function renderLedgerPreview(row: BillingCustomerEmailRow): { subject: string; html: string; text: string } {
  if (!isTemplateId(row.template_id)) throw new CustomerEmailError("That email's template is no longer available.", 409);
  if (!row.variables) throw new CustomerEmailError("That email was never composed, so there is nothing to preview.", 409);
  const rendered = renderEmailTemplate(row.template_id, row.variables as EmailVariables);
  return { subject: rendered.subject, html: rendered.html, text: rendered.text };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmailAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 320 && EMAIL_RE.test(email) ? email : null;
}

/**
 * Explicit staff send: a new ledger row linked to `parent`, either to the
 * recipient on record (`resend`) or to a one-off address (`send_to_other`).
 * Never a second automatic send: the new row has its own dedupe key.
 */
export async function sendAgain(
  parent: BillingCustomerEmailRow, input: { kind: "resend" | "send_to_other"; to?: string | null; requestedBy: string | null }, deps: AttemptDeps = {},
): Promise<{ row: BillingCustomerEmailRow; outcome: DeliveryOutcome }> {
  if (!liveBillingEffectsAllowed()) throw new CustomerEmailError("Customer emails only send in Live mode.", 409);
  if (!isTemplateId(parent.template_id)) throw new CustomerEmailError("That email's template is no longer available.", 409);
  if (!parent.variables) throw new CustomerEmailError("That email was never composed, so it cannot be sent again.", 409);
  const recipient = input.kind === "resend" ? normalizeEmailAddress(parent.recipient) : normalizeEmailAddress(input.to);
  if (!recipient) throw new CustomerEmailError(input.kind === "resend" ? "That email has no recipient on record." : "Enter a valid email address.", 400);
  const row = await insert("billing_customer_emails", {
    dedupe_key: `${parent.dedupe_key}:${input.kind}:${crypto.randomUUID()}`, template_id: parent.template_id, kind: input.kind,
    parent_id: parent.id, payer_id: parent.payer_id, provider_id: parent.provider_id, order_id: parent.order_id,
    subscription_id: parent.subscription_id, status: "claimed", recipient, variables: parent.variables,
    attempts: 0, max_attempts: MAX_EMAIL_ATTEMPTS, attempt_log: [], requested_by: input.requestedBy,
  } as Partial<BillingCustomerEmailRow>);
  const outcome = await attemptDelivery(row, deps);
  const fresh = await selectOne("billing_customer_emails", `id=eq.${enc(row.id)}`);
  return { row: fresh ?? row, outcome };
}

export const RETRY_BATCH_SIZE = 25;
export const RETRY_MAX_BATCHES = 4;

/**
 * Job body: delivers every row whose retry is due, oldest first, in bounded
 * batches under the job lease. Dry runs count what is due and send nothing.
 * Runs inside a pinned billing scope (forEachBillingScope) so the store reads
 * are scoped like every other billing query.
 */
export async function drainDueRetries(ctx: JobContext, deps: AttemptDeps & { onlyOrderIds?: readonly string[] } = {}): Promise<void> {
  // Outside the live scope only the sandbox-verification pass may drain, and
  // only the rows of the explicitly flagged orders.
  if (!liveBillingEffectsAllowed() && !deps.onlyOrderIds?.length) return;
  const onlyFilter = orderIdFilter("order_id", deps.onlyOrderIds);
  const nowIso = ctx.now.toISOString();
  for (let batch = 0; batch < RETRY_MAX_BATCHES; batch += 1) {
    ctx.checkpoint();
    const due = await selectMany("billing_customer_emails",
      `status=eq.retrying&next_attempt_at=lte.${enc(nowIso)}${onlyFilter}&order=next_attempt_at.asc,created_at.asc&limit=${RETRY_BATCH_SIZE}`);
    if (!due.length) break;
    ctx.tally("due", due.length);
    if (ctx.dryRun) { ctx.tally("wouldRetry", due.length); break; }
    for (const row of due) {
      ctx.checkpoint();
      try {
        ctx.tally(await attemptDelivery(row, { now: () => ctx.now, ...deps }));
      } catch (error) {
        ctx.failItem(`customer_email:${row.id}`, error);
      }
    }
    if (due.length < RETRY_BATCH_SIZE) break;
  }
}
