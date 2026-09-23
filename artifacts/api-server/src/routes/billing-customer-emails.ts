import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { EMAIL_TEMPLATE_IDS } from "@workspace/email-templates";
import { requireOfficeBillingScope } from "../billing/auth";
import {
  CustomerEmailError, normalizeEmailAddress, renderLedgerPreview, sendAgain,
} from "../billing/customer-email-ledger";
import {
  BillingStoreError, cursorFilter, encodeCursor, insertIgnore, pagination, selectMany, selectOne, update,
  type BillingCustomerEmailEventRow, type BillingCustomerEmailRow, type BillingNotificationContactRow, type BillingPayerRow,
} from "../billing/store";
import { recordAdminAuditEvent, requestIdOf, type AuditMetadata } from "../lib/admin-audit";
import { resolveAuditNames, type AuditNames } from "../lib/audit-events";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { EMAIL_VENDOR, isWebhookConfigured } from "../email/vendor-webhook";

/**
 * Customer email ledger for staff: what THINNR emailed a payer about an order
 * or subscription, per-attempt outcomes, a preview re-rendered from the
 * stored template + variables (bodies are never stored), explicit resends,
 * one-off sends to another address, and a payer's additional notification
 * contacts. Office routes are scoped to the office (owners/admins, HQ drill-in
 * via ?office=); HQ routes read with financial_read and act with provider_manage.
 */
const router: IRouter = Router();
const enc = encodeURIComponent;
const Uuid = z.string().uuid();
const SendToSchema = z.object({ email: z.string().min(3).max(320) });
const ContactSchema = z.object({ email: z.string().min(3).max(320), label: z.string().trim().max(80).optional().nullable() });
const STATUSES = new Set(["claimed", "retrying", "sent", "skipped", "failed"]);
/** Delivery outcomes the outbox can filter on, on top of the ledger statuses (a bounced email is a `sent` row the vendor could not deliver). */
const DELIVERY_FILTERS: Record<string, string> = {
  bounced: "bounced_at=not.is.null", complained: "complained_at=not.is.null", delivered: "delivered_at=not.is.null",
  opened: "opened_at=not.is.null", clicked: "clicked_at=not.is.null", delayed: "delayed_at=not.is.null",
};
const KINDS = new Set(["automatic", "resend", "send_to_other"]);

interface Actor { actorUserId: string; actorKind: "hq" | "team_member"; providerId: string | null }
function audit(req: Request, actor: Actor, action: string, targetKind: string, targetId: string, metadata: AuditMetadata) {
  return recordAdminAuditEvent({
    action, actorUserId: actor.actorUserId, actorKind: actor.actorKind, providerId: actor.providerId,
    targetKind, targetId, requestId: requestIdOf(req), metadata,
  }).catch((error) => req.log?.error({ err: error }, `${action} audit failed`));
}
function fail(req: Request, res: Response, error: unknown): void {
  req.log?.error({ err: error }, "customer email ledger request failed");
  if (error instanceof CustomerEmailError) { res.status(error.status).json({ error: error.message }); return; }
  if (error instanceof BillingStoreError && error.status === 400) { res.status(400).json({ error: error.message }); return; }
  res.status(503).json({ error: "Payments are temporarily unavailable." });
}

export interface CustomerEmailAttemptDto {
  at: string; outcome: "sent" | "failed"; error: string | null; vendor_message_id: string | null; recipient_domain: string | null;
}
export interface CustomerEmailEventDto { id: string; event_type: string; occurred_at: string }
export interface CustomerEmailDto {
  id: string; kind: BillingCustomerEmailRow["kind"]; parent_id: string | null; contact_id: string | null;
  template_id: string; status: BillingCustomerEmailRow["status"]; recipient: string | null; subject: string | null;
  provider_id: string | null; office_name: string | null; payer_id: string | null; payer_name: string | null; patient_id: string | null;
  order_id: string | null; order_number: string | null; subscription_id: string | null;
  attempts: number; max_attempts: number; last_attempt_at: string | null; next_attempt_at: string | null; sent_at: string | null;
  vendor_message_id: string | null; error: string | null; requested_by: string | null; created_at: string;
  attempt_log: CustomerEmailAttemptDto[]; events: CustomerEmailEventDto[];
  /** Vendor delivery facts folded onto the row by webhook ingestion (first time each was seen). Opens are pixel-based and indicative. */
  delivery: CustomerEmailDeliveryDto;
}
export interface CustomerEmailDeliveryDto {
  delivered_at: string | null; delayed_at: string | null; bounced_at: string | null; complained_at: string | null;
  opened_at: string | null; clicked_at: string | null; last_event_type: string | null; last_event_at: string | null;
}
/** Counts over every row the active filter matches (not just the page); `truncated` when the tally hit its cap. */
export interface CustomerEmailSummaryDto {
  total: number; sent: number; failed: number; bounced: number; opened: number; clicked: number; truncated: boolean;
}
const SUMMARY_CAP = 5000;
export function summarizeEmails(rows: Array<Pick<BillingCustomerEmailRow, "status" | "bounced_at" | "opened_at" | "clicked_at">>, truncated: boolean): CustomerEmailSummaryDto {
  const summary: CustomerEmailSummaryDto = { total: rows.length, sent: 0, failed: 0, bounced: 0, opened: 0, clicked: 0, truncated };
  for (const row of rows) {
    if (row.status === "sent") summary.sent += 1;
    if (row.status === "failed") summary.failed += 1;
    if (row.bounced_at) summary.bounced += 1;
    if (row.opened_at) summary.opened += 1;
    if (row.clicked_at) summary.clicked += 1;
  }
  return summary;
}
export interface NotificationContactDto {
  id: string; payer_id: string; email: string; label: string | null; active: boolean; created_at: string; removed_at: string | null;
  /** Display name of the staff member who added the address, when still resolvable (HQ member, office account holder, or teammate). */
  added_by_name: string | null;
}

const inList = (ids: Iterable<string>): string => [...new Set(ids)].map((id) => enc(`"${id}"`)).join(",");
async function officeNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const result = await supabaseAdmin("GET", `/rest/v1/providers?provider_id=in.(${inList(ids)})&select=provider_id,office_name,provider_name`);
  const rows: Array<{ provider_id: string; office_name: string | null; provider_name: string | null }> = result.status < 300 && Array.isArray(result.json) ? result.json : [];
  return new Map(rows.map((row) => [row.provider_id, row.office_name || row.provider_name || "Office"]));
}

/** Joins order numbers, payer names, office names, and (for details) delivery events onto ledger rows. */
export async function toCustomerEmailDtos(rows: BillingCustomerEmailRow[], options: { events?: boolean } = {}): Promise<CustomerEmailDto[]> {
  if (!rows.length) return [];
  const orderIds = rows.map((row) => row.order_id).filter((id): id is string => Boolean(id));
  const payerIds = rows.map((row) => row.payer_id).filter((id): id is string => Boolean(id));
  const providerIds = rows.map((row) => row.provider_id).filter((id): id is string => Boolean(id));
  const [orders, payers, offices, events] = await Promise.all([
    orderIds.length ? selectMany("billing_orders", `id=in.(${inList(orderIds)})&select=id,order_number`) : Promise.resolve([]),
    payerIds.length ? selectMany("billing_payers", `id=in.(${inList(payerIds)})&select=id,name,patient_id`) : Promise.resolve([]),
    officeNames(providerIds),
    options.events ? selectMany("billing_customer_email_events", `email_id=in.(${inList(rows.map((row) => row.id))})&order=occurred_at.asc&limit=500`) : Promise.resolve([] as BillingCustomerEmailEventRow[]),
  ]);
  const orderNumbers = new Map(orders.map((row) => [row.id, row.order_number]));
  const payerRows = new Map(payers.map((row) => [row.id, row]));
  const eventsByEmail = new Map<string, CustomerEmailEventDto[]>();
  for (const event of events) {
    if (!event.email_id) continue;
    const list = eventsByEmail.get(event.email_id) ?? [];
    list.push({ id: event.id, event_type: event.event_type, occurred_at: event.occurred_at });
    eventsByEmail.set(event.email_id, list);
  }
  return rows.map((row) => {
    const payer = row.payer_id ? payerRows.get(row.payer_id) : undefined;
    return {
      id: row.id, kind: row.kind ?? "automatic", parent_id: row.parent_id ?? null, contact_id: row.contact_id ?? null,
      template_id: row.template_id, status: row.status, recipient: row.recipient ?? null, subject: row.subject ?? null,
      provider_id: row.provider_id, office_name: row.provider_id ? offices.get(row.provider_id) ?? null : null,
      payer_id: row.payer_id ?? null, payer_name: payer?.name ?? null, patient_id: payer?.patient_id ?? null,
      order_id: row.order_id, order_number: row.order_id ? orderNumbers.get(row.order_id) ?? null : null,
      subscription_id: row.subscription_id,
      attempts: row.attempts ?? 0, max_attempts: row.max_attempts ?? 3, last_attempt_at: row.last_attempt_at ?? null,
      next_attempt_at: row.next_attempt_at ?? null, sent_at: row.sent_at ?? null, vendor_message_id: row.vendor_message_id ?? null,
      error: row.error, requested_by: row.requested_by ?? null, created_at: row.created_at,
      attempt_log: (row.attempt_log ?? []).map((attempt) => ({
        at: attempt.at, outcome: attempt.outcome, error: attempt.error, vendor_message_id: attempt.vendor_message_id, recipient_domain: attempt.recipient_domain,
      })),
      events: eventsByEmail.get(row.id) ?? [],
      delivery: {
        delivered_at: row.delivered_at ?? null, delayed_at: row.delayed_at ?? null, bounced_at: row.bounced_at ?? null, complained_at: row.complained_at ?? null,
        opened_at: row.opened_at ?? null, clicked_at: row.clicked_at ?? null, last_event_type: row.last_event_type ?? null, last_event_at: row.last_event_at ?? null,
      },
    };
  });
}
const toContactDto = (row: BillingNotificationContactRow, names?: AuditNames): NotificationContactDto => ({
  id: row.id, payer_id: row.payer_id, email: row.email, label: row.label, active: row.active, created_at: row.created_at, removed_at: row.removed_at,
  added_by_name: row.created_by ? names?.actors.get(row.created_by) ?? null : null,
});
/** Contact DTOs with the adding staff member named; lookups are best-effort and never fail the request. */
async function toContactDtos(rows: BillingNotificationContactRow[]): Promise<NotificationContactDto[]> {
  if (!rows.length) return [];
  const names = await resolveAuditNames(rows.map((row) => ({
    id: 0, occurred_at: row.created_at, action: "billing_notification_contact_added", actor_user_id: row.created_by,
    actor_kind: "unknown", provider_id: null, target_kind: null, target_id: null, request_id: null, metadata: null,
  })));
  return rows.map((row) => toContactDto(row, names));
}

/** Payers of one patient within an office (a patient can only have one payer per office, but legacy data may differ). */
async function payersForPatient(providerId: string | null, patientId: string): Promise<BillingPayerRow[]> {
  const scope = providerId ? `provider_id=eq.${enc(providerId)}&` : "";
  return selectMany("billing_payers", `${scope}patient_id=eq.${enc(patientId)}&order=created_at.asc&limit=20`);
}

interface ListFilters { providerId: string | null; query: Request["query"] }
interface ListResult {
  items: CustomerEmailDto[]; next_cursor: string | null; payers: Array<{ id: string; name: string; email: string | null }>;
  /** Present when the caller asked for `summary=1`: counts over the whole filter, independent of the page cursor. */
  summary?: CustomerEmailSummaryDto;
  /** With `summary=1`: whether vendor delivery events can reach us at all, so the outbox says "Tracking not enabled" instead of showing zeros. */
  tracking?: EmailTrackingDto;
}
export interface EmailTrackingDto { vendor: string; configured: boolean; last_event_at: string | null }
async function readTracking(): Promise<EmailTrackingDto> {
  const result = await supabaseAdmin("GET", `/rest/v1/email_webhook_health?vendor=eq.${EMAIL_VENDOR}&select=last_event_at&limit=1`);
  const row = result.status < 300 && Array.isArray(result.json) ? (result.json[0] as { last_event_at: string | null } | undefined) : undefined;
  return { vendor: EMAIL_VENDOR, configured: isWebhookConfigured(), last_event_at: row?.last_event_at ?? null };
}
/** Shared list: office calls pin providerId; HQ passes null and may filter by provider_id itself. */
async function listEmails({ providerId, query }: ListFilters): Promise<ListResult> {
  const page = pagination(query);
  const filters: string[] = [];
  let payers: BillingPayerRow[] = [];
  if (providerId) filters.push(`provider_id=eq.${enc(providerId)}`);
  else if (typeof query.provider_id === "string" && query.provider_id) filters.push(`provider_id=eq.${enc(query.provider_id)}`);
  for (const key of ["order_id", "payer_id", "subscription_id"] as const) {
    if (typeof query[key] !== "string" || !query[key]) continue;
    if (!Uuid.safeParse(query[key]).success) throw new CustomerEmailError(`Invalid ${key}.`, 400);
    filters.push(`${key}=eq.${enc(query[key] as string)}`);
  }
  if (typeof query.patient_id === "string" && query.patient_id) {
    if (!Uuid.safeParse(query.patient_id).success) throw new CustomerEmailError("Invalid patient_id.", 400);
    payers = await payersForPatient(providerId, query.patient_id);
    if (!payers.length) return { items: [], next_cursor: null, payers: [] };
    filters.push(`payer_id=in.(${inList(payers.map((row) => row.id))})`);
  }
  if (typeof query.template === "string" && query.template) {
    if (!(EMAIL_TEMPLATE_IDS as readonly string[]).includes(query.template)) throw new CustomerEmailError("Unknown template.", 400);
    filters.push(`template_id=eq.${enc(query.template)}`);
  }
  if (typeof query.status === "string" && query.status) {
    if (DELIVERY_FILTERS[query.status]) filters.push(DELIVERY_FILTERS[query.status]);
    else if (STATUSES.has(query.status)) filters.push(`status=eq.${enc(query.status)}`);
    else throw new CustomerEmailError("Unknown status.", 400);
  }
  if (typeof query.kind === "string" && query.kind) {
    if (!KINDS.has(query.kind)) throw new CustomerEmailError("Unknown kind.", 400);
    filters.push(`kind=eq.${enc(query.kind)}`);
  }
  if (typeof query.from === "string" && query.from) filters.push(`created_at=gte.${enc(/^\d{4}-\d{2}-\d{2}$/.test(query.from) ? `${query.from}T00:00:00Z` : query.from)}`);
  if (typeof query.to === "string" && query.to) filters.push(`created_at=lte.${enc(/^\d{4}-\d{2}-\d{2}$/.test(query.to) ? `${query.to}T23:59:59.999Z` : query.to)}`);
  if (typeof query.q === "string" && query.q.trim()) {
    const term = query.q.trim().replace(/[%(),*"\\]/g, "").slice(0, 80);
    if (term) {
      const like = `ilike.*${enc(term)}*`;
      const [matchedPayers, matchedOrders, providersResult] = await Promise.all([
        selectMany("billing_payers", `or=(name.${like},email.${like},phone.${like})&select=id&limit=200`),
        selectMany("billing_orders", `order_number=${like}&select=id&limit=200`),
        providerId ? Promise.resolve(null) : supabaseAdmin("GET", `/rest/v1/providers?or=(office_name.${like},provider_name.${like})&select=provider_id&limit=200`),
      ]);
      const providers: Array<{ provider_id: string }> = providersResult && providersResult.status < 300 && Array.isArray(providersResult.json) ? providersResult.json : [];
      const clauses = [`recipient.${like}`];
      if (matchedPayers.length) clauses.push(`payer_id.in.(${inList(matchedPayers.map((row) => row.id))})`);
      if (matchedOrders.length) clauses.push(`order_id.in.(${inList(matchedOrders.map((row) => row.id))})`);
      if (providers.length) clauses.push(`provider_id.in.(${inList(providers.map((row) => row.provider_id))})`);
      filters.push(`or=(${clauses.join(",")})`);
    }
  }
  const wantSummary = query.summary === "1" || query.summary === "true";
  const filterQuery = `${filters.join("&")}${filters.length ? "&" : ""}`;
  const summaryRead = wantSummary
    ? selectMany("billing_customer_emails", `${filterQuery}select=id,status,bounced_at,opened_at,clicked_at&order=created_at.desc&limit=${SUMMARY_CAP + 1}`)
    : Promise.resolve(null);
  if (page.cursor) filters.push(cursorFilter(page.cursor));
  const [rows, summaryRows, tracking] = await Promise.all([
    selectMany("billing_customer_emails", `${filters.join("&")}${filters.length ? "&" : ""}order=created_at.desc,id.desc&limit=${page.limit + 1}`),
    summaryRead,
    wantSummary ? readTracking() : Promise.resolve(null),
  ]);
  const visible = rows.slice(0, page.limit);
  return {
    items: await toCustomerEmailDtos(visible),
    next_cursor: rows.length > page.limit ? encodeCursor(visible.at(-1) ?? null) : null,
    payers: payers.map((row) => ({ id: row.id, name: row.name, email: row.email })),
    ...(summaryRows ? { summary: summarizeEmails(summaryRows.slice(0, SUMMARY_CAP), summaryRows.length > SUMMARY_CAP) } : {}),
    ...(tracking ? { tracking } : {}),
  };
}

async function loadEmail(emailId: string, providerId: string | null): Promise<BillingCustomerEmailRow> {
  if (!Uuid.safeParse(emailId).success) throw new CustomerEmailError("Email not found.", 404);
  const row = await selectOne("billing_customer_emails", `id=eq.${enc(emailId)}${providerId ? `&provider_id=eq.${enc(providerId)}` : ""}`);
  if (!row) throw new CustomerEmailError("Email not found.", 404);
  return row;
}
async function loadPayer(payerId: string, providerId: string | null): Promise<BillingPayerRow> {
  if (!Uuid.safeParse(payerId).success) throw new CustomerEmailError("Payer not found.", 404);
  const row = await selectOne("billing_payers", `id=eq.${enc(payerId)}${providerId ? `&provider_id=eq.${enc(providerId)}` : ""}`);
  if (!row) throw new CustomerEmailError("Payer not found.", 404);
  return row;
}
async function listContacts(payer: BillingPayerRow): Promise<NotificationContactDto[]> {
  const rows = await selectMany("billing_notification_contacts", `payer_id=eq.${enc(payer.id)}&active=is.true&order=created_at.asc&limit=50`);
  return toContactDtos(rows);
}
const emailIdOf = (req: Request) => String(req.params.email_id);

/* ---------- shared actions (office + HQ) ---------- */

async function resendAction(req: Request, res: Response, actor: Actor, row: BillingCustomerEmailRow): Promise<void> {
  const result = await sendAgain(row, { kind: "resend", requestedBy: actor.actorUserId });
  await audit(req, { ...actor, providerId: row.provider_id ?? actor.providerId }, "billing_customer_email_resent", "billing_customer_email", result.row.id, {
    parent_email_id: row.id, template_id: row.template_id, order_id: row.order_id, outcome: result.outcome,
  });
  const [dto] = await toCustomerEmailDtos([result.row], { events: true });
  res.status(result.outcome === "failed" ? 502 : 200).json({ email: dto, outcome: result.outcome });
}
async function sendToAction(req: Request, res: Response, actor: Actor, row: BillingCustomerEmailRow): Promise<void> {
  const parsed = SendToSchema.safeParse(req.body ?? {});
  const to = parsed.success ? normalizeEmailAddress(parsed.data.email) : null;
  if (!to) { res.status(400).json({ error: "Enter a valid email address.", field: "email" }); return; }
  const result = await sendAgain(row, { kind: "send_to_other", to, requestedBy: actor.actorUserId });
  await audit(req, { ...actor, providerId: row.provider_id ?? actor.providerId }, "billing_customer_email_sent_to_other", "billing_customer_email", result.row.id, {
    parent_email_id: row.id, template_id: row.template_id, order_id: row.order_id, outcome: result.outcome,
  });
  const [dto] = await toCustomerEmailDtos([result.row], { events: true });
  res.status(result.outcome === "failed" ? 502 : 200).json({ email: dto, outcome: result.outcome });
}
async function addContactAction(req: Request, res: Response, actor: Actor, payer: BillingPayerRow): Promise<void> {
  const parsed = ContactSchema.safeParse(req.body ?? {});
  const email = parsed.success ? normalizeEmailAddress(parsed.data.email) : null;
  if (!email) { res.status(400).json({ error: "Enter a valid email address.", field: "email" }); return; }
  if (payer.email && payer.email.trim().toLowerCase() === email) { res.status(400).json({ error: "That is already the payer's own email address.", field: "email" }); return; }
  const label = parsed.success ? parsed.data.label?.trim() || null : null;
  const inserted = await insertIgnore("billing_notification_contacts", {
    payer_id: payer.id, provider_id: payer.provider_id, email, label, active: true, created_by: actor.actorUserId,
  }, "billing_notification_contacts_active_unique");
  if (!inserted) { res.status(409).json({ error: "That address is already on this payer's notification list.", field: "email" }); return; }
  await audit(req, { ...actor, providerId: payer.provider_id }, "billing_notification_contact_added", "billing_notification_contact", inserted.id, { payer_id: payer.id });
  const contacts = await listContacts(payer);
  res.status(201).json({ contact: contacts.find((row) => row.id === inserted.id) ?? toContactDto(inserted), contacts });
}
async function removeContactAction(req: Request, res: Response, actor: Actor, payer: BillingPayerRow): Promise<void> {
  const contactId = String(req.params.contact_id);
  if (!Uuid.safeParse(contactId).success) { res.status(404).json({ error: "Contact not found." }); return; }
  const updated = await update("billing_notification_contacts", `id=eq.${enc(contactId)}&payer_id=eq.${enc(payer.id)}&active=is.true`, {
    active: false, removed_at: new Date().toISOString(), removed_by: actor.actorUserId,
  });
  if (!updated) { res.status(404).json({ error: "Contact not found." }); return; }
  await audit(req, { ...actor, providerId: payer.provider_id }, "billing_notification_contact_removed", "billing_notification_contact", updated.id, { payer_id: payer.id });
  res.json({ contact: toContactDto(updated), contacts: await listContacts(payer) });
}

/* ---------- office ---------- */

const officeActor = (scope: { actorUserId: string; providerId: string; isHq: boolean }): Actor =>
  ({ actorUserId: scope.actorUserId, actorKind: scope.isHq ? "hq" : "team_member", providerId: scope.providerId });

router.get("/billing/office/emails", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    if (!["order_id", "payer_id", "patient_id", "subscription_id"].some((key) => typeof req.query[key] === "string" && req.query[key])) {
      res.status(400).json({ error: "Filter by order_id, payer_id, patient_id, or subscription_id." }); return;
    }
    res.json(await listEmails({ providerId: scope.providerId, query: req.query }));
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/office/emails/:email_id", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    const [email] = await toCustomerEmailDtos([await loadEmail(emailIdOf(req), scope.providerId)], { events: true });
    res.json({ email });
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/office/emails/:email_id/preview", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    res.json(renderLedgerPreview(await loadEmail(emailIdOf(req), scope.providerId)));
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/office/emails/:email_id/resend", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: true }); if (!scope) return;
    await resendAction(req, res, officeActor(scope), await loadEmail(emailIdOf(req), scope.providerId));
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/office/emails/:email_id/send-to", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: true }); if (!scope) return;
    await sendToAction(req, res, officeActor(scope), await loadEmail(emailIdOf(req), scope.providerId));
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/office/payers/:payer_id/contacts", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    const payer = await loadPayer(String(req.params.payer_id), scope.providerId);
    res.json({ payer: { id: payer.id, name: payer.name, email: payer.email }, contacts: await listContacts(payer) });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/office/payers/:payer_id/contacts", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: true }); if (!scope) return;
    await addContactAction(req, res, officeActor(scope), await loadPayer(String(req.params.payer_id), scope.providerId));
  } catch (error) { fail(req, res, error); }
});
router.delete("/billing/office/payers/:payer_id/contacts/:contact_id", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: true }); if (!scope) return;
    await removeContactAction(req, res, officeActor(scope), await loadPayer(String(req.params.payer_id), scope.providerId));
  } catch (error) { fail(req, res, error); }
});

/* ---------- HQ ---------- */

const hqActor = (res: Response): Actor => ({ actorUserId: (res.locals.staff as StaffIdentity).userId, actorKind: "hq", providerId: null });

router.get("/billing/hq/emails", requireHqPermission("financial_read"), async (req, res) => {
  try { res.json(await listEmails({ providerId: null, query: req.query })); } catch (error) { fail(req, res, error); }
});
router.get("/billing/hq/emails/:email_id", requireHqPermission("financial_read"), async (req, res) => {
  try {
    const [email] = await toCustomerEmailDtos([await loadEmail(emailIdOf(req), null)], { events: true });
    res.json({ email });
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/hq/emails/:email_id/preview", requireHqPermission("financial_read"), async (req, res) => {
  try { res.json(renderLedgerPreview(await loadEmail(emailIdOf(req), null))); } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/emails/:email_id/resend", requireHqPermission("provider_manage"), async (req, res) => {
  try { await resendAction(req, res, hqActor(res), await loadEmail(emailIdOf(req), null)); } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/emails/:email_id/send-to", requireHqPermission("provider_manage"), async (req, res) => {
  try { await sendToAction(req, res, hqActor(res), await loadEmail(emailIdOf(req), null)); } catch (error) { fail(req, res, error); }
});
router.get("/billing/hq/payers/:payer_id/contacts", requireHqPermission("financial_read"), async (req, res) => {
  try {
    const payer = await loadPayer(String(req.params.payer_id), null);
    res.json({ payer: { id: payer.id, name: payer.name, email: payer.email }, contacts: await listContacts(payer) });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/payers/:payer_id/contacts", requireHqPermission("provider_manage"), async (req, res) => {
  try { await addContactAction(req, res, hqActor(res), await loadPayer(String(req.params.payer_id), null)); } catch (error) { fail(req, res, error); }
});
router.delete("/billing/hq/payers/:payer_id/contacts/:contact_id", requireHqPermission("provider_manage"), async (req, res) => {
  try { await removeContactAction(req, res, hqActor(res), await loadPayer(String(req.params.payer_id), null)); } catch (error) { fail(req, res, error); }
});

export default router;
