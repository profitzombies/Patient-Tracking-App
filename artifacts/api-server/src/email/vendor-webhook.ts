import crypto from "node:crypto";
import { insertIgnore, update, type BillingCustomerEmailRow, type CustomerEmailEventType } from "../billing/store";
import { runWithBillingIdentity } from "../billing/stripe-environment";
import { supabaseAdmin } from "../lib/supabase-admin";

/**
 * Email vendor (Resend) delivery-event webhook: signature verification,
 * event normalisation, exactly-once storage in the identity-free inbox
 * (email_vendor_events), matching to the customer email ledger by vendor
 * message id, and the webhook health row the HQ System health page reads.
 *
 * Signatures follow the Svix scheme Resend uses: `svix-id`, `svix-timestamp`
 * and `svix-signature` headers, HMAC-SHA256 over `${id}.${timestamp}.${body}`
 * keyed with the base64 secret after the `whsec_` prefix, timestamps within a
 * short tolerance. The secret lives in RESEND_WEBHOOK_SECRET; while it is
 * unset the endpoint refuses everything (tracking is "not enabled") and the
 * page says so instead of showing zeros.
 *
 * Matched events are copied into billing_customer_email_events under the
 * ledger row's own billing identity so the scoped ledger reads (order pages,
 * outbox rows) see them. An event whose message id has no ledger row yet is
 * kept unmatched; the rematch job retries it because the vendor's own "sent"
 * event can arrive before our ledger update lands.
 */
export const EMAIL_VENDOR = "resend";
export const WEBHOOK_SECRET_ENV = "RESEND_WEBHOOK_SECRET";
/** How far a delivery's timestamp may drift from now before it is refused (replay protection). */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
/** Unmatched events older than this are dropped by the rematch job: the ledger row will never appear. */
export const UNMATCHED_RETENTION_DAYS = 30;

export const VENDOR_EVENT_TYPES: Record<string, CustomerEmailEventType> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delivery_delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.opened": "opened",
  "email.clicked": "clicked",
};

export function webhookSecret(): string | null {
  const raw = process.env[WEBHOOK_SECRET_ENV];
  return raw && raw.trim() ? raw.trim() : null;
}
/** Tracking is "enabled" once the signing secret is configured; the dashboard switches themselves are not observable from here. */
export const isWebhookConfigured = (): boolean => webhookSecret() !== null;

export interface SignatureHeaders { id: string | null; timestamp: string | null; signature: string | null }
export type SignatureVerdict = "ok" | "missing_headers" | "stale_timestamp" | "bad_signature" | "not_configured";

/** Constant-time check of the Svix signature set; any listed `v1,` signature may match (secret rotation sends two). */
export function verifySignature(rawBody: Buffer, headers: SignatureHeaders, secret: string | null, now: Date = new Date()): SignatureVerdict {
  if (!secret) return "not_configured";
  if (!headers.id || !headers.timestamp || !headers.signature) return "missing_headers";
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(now.getTime() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return "stale_timestamp";
  let key: Buffer;
  try {
    key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  } catch {
    return "bad_signature";
  }
  if (!key.length) return "bad_signature";
  const expected = crypto.createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.`).update(rawBody).digest();
  for (const part of headers.signature.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    let candidate: Buffer;
    try { candidate = Buffer.from(value, "base64"); } catch { continue; }
    if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) return "ok";
  }
  return "bad_signature";
}

export interface NormalizedEvent {
  vendorEventId: string;
  vendorMessageId: string;
  eventType: CustomerEmailEventType;
  occurredAt: string;
  detail: Record<string, unknown>;
}
export type NormalizeResult = { kind: "event"; event: NormalizedEvent } | { kind: "ignored"; type: string | null } | { kind: "invalid"; reason: string };

/** Keeps only what the outbox needs to explain an event; never the recipient, subject, or IP address. */
export function normalizeEvent(payload: unknown, vendorEventId: string): NormalizeResult {
  if (!payload || typeof payload !== "object") return { kind: "invalid", reason: "not_an_object" };
  const body = payload as { type?: unknown; created_at?: unknown; data?: unknown };
  const type = typeof body.type === "string" ? body.type : null;
  const eventType = type ? VENDOR_EVENT_TYPES[type] : undefined;
  if (!eventType) return { kind: "ignored", type };
  const data = body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : null;
  const messageId = data && typeof data.email_id === "string" ? data.email_id.trim() : "";
  if (!messageId) return { kind: "invalid", reason: "missing_email_id" };
  const created = typeof body.created_at === "string" ? Date.parse(body.created_at) : NaN;
  const occurredAt = new Date(Number.isFinite(created) ? created : Date.now()).toISOString();
  const detail: Record<string, unknown> = {};
  const click = data?.click && typeof data.click === "object" ? data.click as Record<string, unknown> : null;
  if (click && typeof click.link === "string") detail.link = click.link.slice(0, 2048);
  const bounce = data?.bounce && typeof data.bounce === "object" ? data.bounce as Record<string, unknown> : null;
  if (bounce) {
    for (const key of ["type", "subType", "message"] as const) {
      if (typeof bounce[key] === "string") detail[key === "subType" ? "sub_type" : key] = (bounce[key] as string).slice(0, 500);
    }
  }
  return { kind: "event", event: { vendorEventId, vendorMessageId: messageId, eventType, occurredAt, detail } };
}

export interface VendorEventRow {
  id: string; vendor: string; vendor_event_id: string; vendor_message_id: string; event_type: CustomerEmailEventType;
  occurred_at: string; detail: Record<string, unknown>; email_id: string | null; matched_at: string | null; received_at: string;
}
interface LedgerLookup { id: string; stripe_mode: "test" | "live" | null; stripe_platform_account_id: string | null }

class VendorWebhookStoreError extends Error {
  constructor(what: string, status: number) { super(`${what} failed (${status})`); this.name = "VendorWebhookStoreError"; }
}
const ok = (result: { status: number }, what: string) => { if (result.status >= 300) throw new VendorWebhookStoreError(what, result.status); };
const enc = encodeURIComponent;

/** Unscoped ledger lookup: vendor message ids are unique across identities, and the match decides which identity the copy is written under. */
async function findLedgerRow(vendorMessageId: string): Promise<LedgerLookup | null> {
  const result = await supabaseAdmin("GET", `/rest/v1/billing_customer_emails?vendor_message_id=eq.${enc(vendorMessageId)}&select=id,stripe_mode,stripe_platform_account_id&limit=1`);
  ok(result, "ledger lookup");
  return Array.isArray(result.json) && result.json[0] ? result.json[0] as LedgerLookup : null;
}

/** Ledger column that records the first time each event type was seen. */
const FIRST_SEEN_COLUMN: Record<CustomerEmailEventType, keyof BillingCustomerEmailRow | null> = {
  sent: null, delivered: "delivered_at", delivery_delayed: "delayed_at", bounced: "bounced_at", complained: "complained_at", opened: "opened_at", clicked: "clicked_at",
};

/** Folds one new event onto the ledger row: first-seen stamp (only while unset) and the latest event (only when newer). Conditional PATCHes, so replays and out-of-order arrivals are harmless. */
async function applyEventToLedger(emailId: string, row: VendorEventRow): Promise<void> {
  const column = FIRST_SEEN_COLUMN[row.event_type];
  const at = enc(row.occurred_at);
  if (column) await update("billing_customer_emails", `id=eq.${enc(emailId)}&${column}=is.null`, { [column]: row.occurred_at } as Partial<BillingCustomerEmailRow>);
  await update("billing_customer_emails", `id=eq.${enc(emailId)}&or=(last_event_at.is.null,last_event_at.lt.${at})`, { last_event_type: row.event_type, last_event_at: row.occurred_at });
}

/** Links one inbox row to its ledger row and mirrors it into the scoped events table and ledger columns. Returns false when the ledger row is still missing. */
async function matchInboxRow(row: VendorEventRow, now: Date): Promise<boolean> {
  const ledger = await findLedgerRow(row.vendor_message_id);
  if (!ledger) return false;
  if (ledger.stripe_mode && ledger.stripe_platform_account_id) {
    await runWithBillingIdentity({ mode: ledger.stripe_mode, platformAccountId: ledger.stripe_platform_account_id }, async () => {
      const copied = await insertIgnore(
        "billing_customer_email_events",
        { email_id: ledger.id, vendor_message_id: row.vendor_message_id, vendor_event_id: row.vendor_event_id, event_type: row.event_type, occurred_at: row.occurred_at, detail: row.detail },
        "billing_customer_email_events_vendor_event_unique",
      );
      // Only a first copy touches the ledger columns; a replayed event was already folded in.
      if (copied) await applyEventToLedger(ledger.id, row);
    });
  }
  const patched = await supabaseAdmin("PATCH", `/rest/v1/email_vendor_events?id=eq.${enc(row.id)}&email_id=is.null`, { email_id: ledger.id, matched_at: now.toISOString() }, "return=minimal");
  ok(patched, "inbox match");
  return true;
}

export type IngestOutcome = "stored" | "duplicate";
export interface IngestResult { outcome: IngestOutcome; matched: boolean }

/** Stores one verified event exactly once (by vendor event id) and tries to match it straight away. */
export async function ingestVendorEvent(event: NormalizedEvent, now: Date = new Date()): Promise<IngestResult> {
  const inserted = await supabaseAdmin("POST", "/rest/v1/email_vendor_events", {
    vendor: EMAIL_VENDOR, vendor_event_id: event.vendorEventId, vendor_message_id: event.vendorMessageId,
    event_type: event.eventType, occurred_at: event.occurredAt, detail: event.detail, received_at: now.toISOString(),
  }, "resolution=ignore-duplicates,return=representation");
  const code = inserted.json && typeof inserted.json === "object" && "code" in inserted.json ? String((inserted.json as { code?: unknown }).code) : "";
  const row: VendorEventRow | null = inserted.status < 300 && Array.isArray(inserted.json) ? inserted.json[0] ?? null : null;
  if (inserted.status >= 300 && !(inserted.status === 409 && code === "23505")) throw new VendorWebhookStoreError("inbox insert", inserted.status);
  await noteEvent(event.eventType, now).catch(() => undefined);
  if (!row) return { outcome: "duplicate", matched: false };
  const matched = await matchInboxRow(row, now);
  return { outcome: "stored", matched };
}

/** Health bookkeeping: last accepted event (any type) and refused deliveries. Best-effort; never fails a webhook. */
export async function noteEvent(eventType: CustomerEmailEventType, at: Date): Promise<void> {
  ok(await supabaseAdmin("POST", "/rest/v1/rpc/email_webhook_note_event", { p_vendor: EMAIL_VENDOR, p_event_type: eventType, p_at: at.toISOString() }), "health note");
}
export async function noteRejection(): Promise<void> {
  ok(await supabaseAdmin("POST", "/rest/v1/rpc/email_webhook_note_rejection", { p_vendor: EMAIL_VENDOR }), "rejection note");
}

export interface RematchCounts { scanned: number; matched: number; pruned: number }
/** Job body: re-tries unmatched inbox rows (newest first) and drops the ones past retention. Dry runs count only. */
export async function rematchUnmatchedEvents(options: { now: Date; dryRun: boolean; limit?: number }): Promise<RematchCounts> {
  const limit = options.limit ?? 200;
  const cutoff = new Date(options.now.getTime() - UNMATCHED_RETENTION_DAYS * 86_400_000).toISOString();
  const pending = await supabaseAdmin("GET", `/rest/v1/email_vendor_events?email_id=is.null&received_at=gte.${enc(cutoff)}&order=received_at.desc&limit=${limit}`);
  ok(pending, "unmatched read");
  const rows: VendorEventRow[] = Array.isArray(pending.json) ? pending.json as VendorEventRow[] : [];
  const counts: RematchCounts = { scanned: rows.length, matched: 0, pruned: 0 };
  for (const row of rows) {
    if (options.dryRun) { if (await findLedgerRow(row.vendor_message_id)) counts.matched += 1; continue; }
    if (await matchInboxRow(row, options.now)) counts.matched += 1;
  }
  const stale = await supabaseAdmin("GET", `/rest/v1/email_vendor_events?email_id=is.null&received_at=lt.${enc(cutoff)}&select=id&limit=${limit}`);
  ok(stale, "stale read");
  const staleIds: string[] = Array.isArray(stale.json) ? (stale.json as Array<{ id: string }>).map((row) => row.id) : [];
  counts.pruned = staleIds.length;
  if (staleIds.length && !options.dryRun) {
    ok(await supabaseAdmin("DELETE", `/rest/v1/email_vendor_events?id=in.(${staleIds.map((id) => enc(`"${id}"`)).join(",")})`), "stale prune");
  }
  return counts;
}

export interface EmailWebhookHealth {
  vendor: string;
  /** Signing secret present; the vendor dashboard switches cannot be observed from here. */
  configured: boolean;
  last_event_at: string | null;
  last_event_type: string | null;
  events_24h: number;
  unmatched_count: number;
  oldest_unmatched_at: string | null;
  last_rejected_at: string | null;
  rejected_today: number;
  rejected_total: number;
  /** Most recent vendor-confirmed send in the ledger; a stall means events lag behind this. */
  last_email_sent_at: string | null;
}

interface HealthRow { last_event_at: string | null; last_event_type: string | null; last_rejected_at: string | null; rejected_total: number; rejected_day_count: number; rejected_day: string | null }
const COUNT_CAP = 5000;

export async function readEmailWebhookHealth(now: Date = new Date()): Promise<EmailWebhookHealth> {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const [health, recent, unmatched, lastSent] = await Promise.all([
    supabaseAdmin("GET", `/rest/v1/email_webhook_health?vendor=eq.${EMAIL_VENDOR}&limit=1`),
    supabaseAdmin("GET", `/rest/v1/email_vendor_events?received_at=gte.${enc(since)}&select=id&limit=${COUNT_CAP}`),
    supabaseAdmin("GET", `/rest/v1/email_vendor_events?email_id=is.null&select=id,received_at&order=received_at.asc&limit=${COUNT_CAP}`),
    supabaseAdmin("GET", "/rest/v1/billing_customer_emails?status=eq.sent&vendor_message_id=not.is.null&select=sent_at&order=sent_at.desc&limit=1"),
  ]);
  ok(health, "health read"); ok(recent, "recent events read"); ok(unmatched, "unmatched read"); ok(lastSent, "last send read");
  const row: HealthRow | null = Array.isArray(health.json) && health.json[0] ? health.json[0] as HealthRow : null;
  const today = now.toISOString().slice(0, 10);
  const unmatchedRows = Array.isArray(unmatched.json) ? unmatched.json as Array<{ received_at: string }> : [];
  const sentRows = Array.isArray(lastSent.json) ? lastSent.json as Array<{ sent_at: string | null }> : [];
  return {
    vendor: EMAIL_VENDOR,
    configured: isWebhookConfigured(),
    last_event_at: row?.last_event_at ?? null,
    last_event_type: row?.last_event_type ?? null,
    events_24h: Array.isArray(recent.json) ? recent.json.length : 0,
    unmatched_count: unmatchedRows.length,
    oldest_unmatched_at: unmatchedRows[0]?.received_at ?? null,
    last_rejected_at: row?.last_rejected_at ?? null,
    rejected_today: row && row.rejected_day === today ? row.rejected_day_count : 0,
    rejected_total: row?.rejected_total ?? 0,
    last_email_sent_at: sentRows[0]?.sent_at ?? null,
  };
}
