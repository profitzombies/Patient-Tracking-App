/**
 * Shared audit-event read layer for the HQ and office Audit pages.
 *
 * Both pages list rows from admin_audit_events through the same fixed
 * allowlists — actions we know how to explain, and the handful of small
 * operational metadata keys that are safe to display. Anything outside the
 * lists is dropped at the API boundary (a future action that accidentally
 * logs something richer never reaches a browser), and the lists are covered
 * by tests. Metadata may never carry clinical text, message bodies, or file
 * contents; the writers only ever put ids, enum-like facts, and sizes there.
 *
 * Names are resolved at read time (actor → HQ member / provider / teammate,
 * office → provider, target → the row the id points at) so the pages show
 * people and offices, not raw identifiers. The office endpoint drops the raw
 * ids entirely; HQ keeps them alongside the names.
 */
import { supabaseAdmin } from "./supabase-admin";

export const AUDIT_ACTIONS = [
  "patient_invitation_created",
  "patient_invitation_resent",
  "patient_follow_up_open",
  "patient_follow_up_resolved",
  "patient_profile_updated",
  "patient_status_changed",
  "patient_note_added",
  "patient_note_deleted",
  "patient_weight_recorded",
  "patient_weight_updated",
  "patient_weight_removed",
  "patient_measurements_recorded",
  "patient_measurements_removed",
  "patient_medication_added",
  "patient_medication_updated",
  "patient_medication_stopped",
  "provider_account_created",
  "provider_account_updated",
  "office_policy_override_updated",
  "office_team_invited",
  "office_team_role_changed",
  "office_team_deactivated",
  "office_team_reactivated",
  "office_team_signed_out",
  "hq_team_invited",
  "hq_team_updated",
  "hq_team_revoked",
  "hq_settings_updated",
  "hq_file_uploaded",
  "hq_file_downloaded",
  "hq_file_previewed",
  "hq_file_deleted",
  "knowledge_document_uploaded",
  "knowledge_document_replaced",
  "knowledge_document_deleted",
  "training_published",
  "training_unpublished",
  "training_deleted",
  "training_media_deleted",
  "training_attachment_downloaded",
  "ai_support_used",
  "conversation_transcript_read",
  "conversation_replied",
  "conversation_assigned",
  "conversation_status_changed",
  "conversation_note_added",
  "conversation_escalated",
  "conversation_escalation_resolved",
  "data_export_requested",
  "data_export_downloaded",
  "data_export_cancelled",
  "patient_record_export_requested",
  "patient_record_export_downloaded",
  "patient_record_export_cancelled",
  "office_bundle_export_requested",
  "office_bundle_export_downloaded",
  "office_offboarding_started",
  "office_offboarding_bundle_requested",
  "office_offboarding_handover_recorded",
  "office_offboarding_seal_started",
  "office_offboarding_completed",
  "office_reactivated",
  "office_destruction_certificate_downloaded",
  "patient_consent_recorded",
  "patient_export_requested",
  "patient_export_ready",
  "patient_export_failed",
  "patient_export_downloaded",
  "patient_deletion_requested",
  "patient_deletion_cancelled",
  "patient_deletion_purged",
  "patient_deletion_failed",
  "patient_deletion_retried",
  "legal_hold_placed",
  "legal_hold_lifted",
  "security_password_changed",
  "security_sessions_signed_out",
  "security_sign_in_reported",
  "security_recovery_completed",
  "security_second_factor_enrolled",
  "security_second_factor_changed",
  "office_team_sessions_viewed",
  "office_team_phone_cleared",
  "hq_team_sessions_viewed",
  "hq_team_signed_out",
  "hq_team_phone_cleared",
  "patient_sessions_viewed",
  "patient_signed_out",
  "access_denied",
  "billing_refund_issued",
  "billing_subscription_cancelled",
  "billing_subscription_payment_retried",
  "billing_subscription_payment_email_sent",
  "billing_subscription_paused",
  "billing_subscription_resumed",
  "billing_subscription_changed",
  "billing_order_fulfillment_updated",
  "billing_customer_email_resent",
  "billing_customer_email_sent_to_other",
  "billing_notification_contact_added",
  "billing_notification_contact_removed",
  "billing_warehouse_retry",
  "billing_warehouse_auto_submit_changed",
  "billing_prices_updated",
  "billing_payment_link_created",
  "billing_payment_link_updated",
  "billing_connect_started",
  "billing_connect_completed",
  "billing_connect_disconnected",
  "billing_settings_updated",
  "billing_office_settings_updated",
  "billing_sandbox_reset",
  "billing_product_created",
  "billing_product_updated",
  "billing_product_archived",
  "billing_product_floor_updated",
  // Office access subscriptions (what an office pays THINNR) — HQ overrides
  "office_access_included_period_set",
  "office_access_trial_reset",
  "office_access_terms_set",
  "office_access_paid_through_recorded",
  "office_access_offline_payment_recorded",
  // Record access (reads, deduped per actor + target — see lib/record-access-audit.ts)
  "patient_record_viewed",
  "patient_photos_viewed",
  "patient_bloodwork_viewed",
  "bloodwork_report_opened",
  "patient_medications_viewed",
  "conversation_transcript_opened",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const allowedActions: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

/**
 * Metadata keys that may reach a browser. Every key is an operational fact
 * (an enum, a count, a size, an id of a record the reader already sees) —
 * free-text fields are deliberately absent.
 */
export const AUDIT_METADATA_KEYS = [
  "reason", "role", "status", "field", "fields", "from", "to", "size", "contentType",
  "thread", "kind", "office", "rows", "noteId", "weightId", "visitId", "medicationId", "areaCount", "dateKey",
  "route", "method", "turn", "attachmentId", "mediaKind", "version", "section",
  "policyVersion", "photoAnalysis", "attempt", "step", "objects", "tables", "purgeAfter", "exportId", "requestId",
  "page", "assigneeUserId", "previousAssigneeUserId", "self", "messageClientId", "length", "department", "escalationId", "hasNote",
  "order_id", "subscription_id", "link_id", "product_id", "amount_cents", "floor_price_cents",
  "at_period_end", "fulfillment_status", "has_tracking", "keys_changed", "products_changed", "active", "max_uses",
  "part", "parts", "enabled",
  "email_id", "parent_email_id", "payer_id", "contact_id", "template_id", "outcome",
  "holdId", "targetKind",
  "reportId", "conversationId", "photos",
  "choice", "patients", "sessions", "sealed", "held", "destroyed", "retainUntil",
  "lifetime", "endsAt", "restart", "plan", "priceCentsOverride", "paidThrough", "amountCents",
] as const;
export const allowedMetadata: ReadonlySet<string> = new Set(AUDIT_METADATA_KEYS);

/** Actions that only ever concern one office and therefore belong on its Audit page. */
export const OFFICE_VISIBLE_ACTIONS = [
  "patient_invitation_created",
  "patient_invitation_resent",
  "patient_follow_up_open",
  "patient_follow_up_resolved",
  "patient_profile_updated",
  "patient_status_changed",
  "patient_note_added",
  "patient_note_deleted",
  "patient_weight_recorded",
  "patient_weight_updated",
  "patient_weight_removed",
  "patient_measurements_recorded",
  "patient_measurements_removed",
  "patient_medication_added",
  "patient_medication_updated",
  "patient_medication_stopped",
  "provider_account_created",
  "provider_account_updated",
  "office_policy_override_updated",
  "office_team_invited",
  "office_team_role_changed",
  "office_team_deactivated",
  "office_team_reactivated",
  "office_team_signed_out",
  "office_team_phone_cleared",
  "conversation_transcript_read",
  "conversation_replied",
  "conversation_assigned",
  "conversation_status_changed",
  "conversation_note_added",
  "conversation_escalated",
  "conversation_escalation_resolved",
  "data_export_requested",
  "data_export_downloaded",
  "data_export_cancelled",
  "patient_record_export_requested",
  "patient_record_export_downloaded",
  "patient_record_export_cancelled",
  "patient_consent_recorded",
  "patient_export_requested",
  "patient_export_ready",
  "patient_export_failed",
  "patient_export_downloaded",
  "patient_deletion_requested",
  "patient_deletion_cancelled",
  "patient_deletion_purged",
  "patient_deletion_failed",
  "patient_deletion_retried",
  "security_password_changed",
  "security_sessions_signed_out",
  "security_sign_in_reported",
  "security_recovery_completed",
  "office_team_sessions_viewed",
  "patient_sessions_viewed",
  "patient_signed_out",
  "access_denied",
  "billing_refund_issued",
  "billing_subscription_cancelled",
  "billing_subscription_payment_retried",
  "billing_subscription_payment_email_sent",
  "billing_subscription_paused",
  "billing_subscription_resumed",
  "billing_subscription_changed",
  "billing_customer_email_resent",
  "billing_customer_email_sent_to_other",
  "billing_notification_contact_added",
  "billing_notification_contact_removed",
  "billing_prices_updated",
  "billing_payment_link_created",
  "billing_payment_link_updated",
  "billing_connect_started",
  "billing_connect_completed",
  "billing_connect_disconnected",
  "billing_settings_updated",
  "billing_office_settings_updated",
  "patient_record_viewed",
  "patient_photos_viewed",
  "patient_bloodwork_viewed",
  "bloodwork_report_opened",
  "patient_medications_viewed",
  "conversation_transcript_opened",
] as const satisfies readonly AuditAction[];
export const officeVisibleActions: ReadonlySet<string> = new Set(OFFICE_VISIBLE_ACTIONS);

export type AuditMetadataDto = Record<string, string | number | boolean | null>;

export interface AuditRow {
  id: number;
  occurred_at: string;
  action: string;
  actor_user_id: string | null;
  actor_kind: string;
  provider_id: string | null;
  target_kind: string | null;
  target_id: string | null;
  request_id: string | null;
  metadata: unknown;
}

export const AUDIT_SELECT =
  "select=id,occurred_at,action,actor_user_id,actor_kind,provider_id,target_kind,target_id,request_id,metadata";

export function utcDate(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

export function safeMetadata(source: unknown): AuditMetadataDto {
  const record = source && typeof source === "object" && !Array.isArray(source) ? (source as Record<string, unknown>) : {};
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) =>
        allowedMetadata.has(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null),
    ),
  ) as AuditMetadataDto;
}

/**
 * Validate the shared date/action filter block. Returns null when the
 * filters are unusable (unknown action, malformed or inverted dates, a
 * window over a year).
 */
export function auditWindow(input: {
  action?: string;
  from?: string;
  to?: string;
  actions: ReadonlySet<string>;
}): { fromMs: number | null; toMs: number | null } | null {
  const fromMs = utcDate(input.from);
  const toMs = utcDate(input.to);
  if (input.action && !input.actions.has(input.action)) return null;
  if (input.from && fromMs === null) return null;
  if (input.to && toMs === null) return null;
  if (fromMs !== null && toMs !== null && (fromMs > toMs || (toMs - fromMs) / 86_400_000 + 1 > 366)) return null;
  return { fromMs, toMs };
}

const enc = encodeURIComponent;

export function auditFilters(input: {
  actions: readonly string[];
  action?: string;
  from?: string;
  toMs: number | null;
  provider?: string;
  limit: number;
  offset: number;
}): string[] {
  const filters = [
    AUDIT_SELECT,
    `action=in.(${input.actions.join(",")})`,
    "order=occurred_at.desc,id.desc",
    `limit=${input.limit}`,
    `offset=${input.offset}`,
  ];
  if (input.provider) filters.push(`provider_id=eq.${enc(input.provider)}`);
  if (input.action) filters.push(`action=eq.${enc(input.action)}`);
  if (input.from) filters.push(`occurred_at=gte.${enc(`${input.from}T00:00:00Z`)}`);
  if (input.toMs !== null) filters.push(`occurred_at=lt.${enc(new Date(input.toMs + 86_400_000).toISOString())}`);
  return filters;
}

// ── Name resolution ──────────────────────────────────────────────────────────

export interface AuditNames {
  actors: Map<string, string>;
  offices: Map<string, string>;
  /** keyed by `${targetKind}:${targetId}` */
  targets: Map<string, string>;
}

function uniq(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function lookup(path: string): Promise<Array<Record<string, unknown>>> {
  const result = await supabaseAdmin("GET", path);
  if (result.status >= 300 || !Array.isArray(result.json)) return [];
  return result.json as Array<Record<string, unknown>>;
}

function inList(values: string[]): string {
  return `in.(${values.map((value) => `"${value.replace(/"/g, "")}"`).join(",")})`;
}

function personName(row: Record<string, unknown>): string {
  const full = [row.first_name, row.last_name].filter((part) => typeof part === "string" && part.trim()).join(" ").trim();
  return full || String(row.name ?? row.display_name ?? row.provider_name ?? row.title ?? "").trim();
}

const TARGET_SOURCES: Record<string, { table: string; select: string }> = {
  patient: { table: "patients", select: "id,first_name,last_name,name" },
  patient_follow_up: { table: "patients", select: "id,first_name,last_name,name" },
  patient_chat_conversation: { table: "patients", select: "id,first_name,last_name,name" },
  team_member: { table: "team_members", select: "id,name" },
  hq_member: { table: "hq_memberships", select: "id,display_name" },
  provider_account: { table: "providers", select: "provider_id,provider_name,office_name" },
  hq_file: { table: "hq_private_files", select: "id,name" },
  knowledge_document: { table: "knowledge_documents", select: "id,title" },
  training_course: { table: "training_courses", select: "id,title" },
  training_module: { table: "training_modules", select: "id,title" },
  training_subgroup: { table: "training_subgroups", select: "id,title" },
  training_video: { table: "training_videos", select: "id,title" },
};

/**
 * Resolve display names for the actors, offices, and targets in a page of
 * events. Every lookup is best-effort: an unresolvable id simply has no
 * name, and the caller falls back to a kind label.
 */
export async function resolveAuditNames(rows: AuditRow[]): Promise<AuditNames> {
  const names: AuditNames = { actors: new Map(), offices: new Map(), targets: new Map() };
  const actorIds = uniq(rows.map((row) => row.actor_user_id));
  const officeIds = uniq([
    ...rows.map((row) => row.provider_id),
    ...rows.filter((row) => row.target_kind === "provider_account").map((row) => row.target_id),
  ]);
  const targetsByKind = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.target_kind || !row.target_id || !TARGET_SOURCES[row.target_kind]) continue;
    const list = targetsByKind.get(row.target_kind) ?? [];
    if (!list.includes(row.target_id)) list.push(row.target_id);
    targetsByKind.set(row.target_kind, list);
  }

  const jobs: Promise<void>[] = [];
  if (actorIds.length) {
    const list = inList(actorIds);
    jobs.push(
      lookup(`/rest/v1/hq_memberships?auth_user_id=${list}&select=auth_user_id,display_name`).then((found) => {
        for (const row of found) if (row.auth_user_id) names.actors.set(String(row.auth_user_id), personName(row));
      }),
      lookup(`/rest/v1/providers?auth_user_id=${list}&select=auth_user_id,provider_name`).then((found) => {
        for (const row of found) if (row.auth_user_id && !names.actors.has(String(row.auth_user_id))) names.actors.set(String(row.auth_user_id), personName(row));
      }),
      lookup(`/rest/v1/team_members?auth_user_id=${list}&select=auth_user_id,name`).then((found) => {
        for (const row of found) if (row.auth_user_id && !names.actors.has(String(row.auth_user_id))) names.actors.set(String(row.auth_user_id), personName(row));
      }),
    );
  }
  if (officeIds.length) {
    jobs.push(
      lookup(`/rest/v1/providers?provider_id=${inList(officeIds)}&select=provider_id,provider_name,office_name`).then((found) => {
        for (const row of found) {
          names.offices.set(String(row.provider_id), String(row.office_name ?? row.provider_name ?? "").trim());
          names.targets.set(`provider_account:${String(row.provider_id)}`, String(row.office_name ?? row.provider_name ?? "").trim());
        }
      }),
    );
  }
  for (const [kind, ids] of targetsByKind) {
    if (kind === "provider_account") continue;
    const source = TARGET_SOURCES[kind];
    const keyColumn = source.select.split(",")[0];
    const safeIds = ids.filter((id) => /^[0-9a-zA-Z_-]{1,64}$/.test(id));
    if (!safeIds.length) continue;
    jobs.push(
      lookup(`/rest/v1/${source.table}?${keyColumn}=${inList(safeIds)}&select=${source.select}`).then((found) => {
        for (const row of found) {
          const name = personName(row);
          if (name) names.targets.set(`${kind}:${String(row[keyColumn])}`, name);
        }
      }),
    );
  }
  // The HQ member the actor id points at may have been revoked, the team row
  // deleted, etc. — those simply stay unnamed. Lookups never fail the page.
  await Promise.all(jobs.map((job) => job.catch(() => undefined)));
  return names;
}

const ACTOR_KIND_LABEL: Record<string, string> = {
  hq: "HQ staff",
  provider: "Office account holder",
  team_member: "Office teammate",
  anonymous: "Anonymous visitor",
  learner: "Training learner",
  unknown: "Signed-in user",
  patient: "Patient",
  system: "System",
};

const TARGET_KIND_LABEL: Record<string, string> = {
  patient: "Patient",
  patient_follow_up: "Patient follow-up",
  patient_chat_conversation: "Patient conversation",
  team_member: "Teammate",
  hq_member: "HQ member",
  provider_account: "Office",
  hq_file: "File",
  knowledge_document: "Knowledge document",
  training_course: "Training course",
  training_module: "Training module",
  training_subgroup: "Training section",
  training_video: "Training video",
  training_media: "Training media",
  training_attachment: "Training attachment",
  billing_subscription: "Subscription",
  billing_customer_email: "Customer email",
  billing_notification_contact: "Notification contact",
  organization_settings: "Organization settings",
  data_export: "Data export",
  support_chat: "AI support chat",
  route: "Protected route",
};

export function actorLabel(row: Pick<AuditRow, "actor_user_id" | "actor_kind">, names: AuditNames): string {
  const name = row.actor_user_id ? names.actors.get(row.actor_user_id) : undefined;
  if (name) return name;
  return ACTOR_KIND_LABEL[row.actor_kind] ?? "Unknown";
}

export function targetLabel(row: Pick<AuditRow, "target_kind" | "target_id">, names: AuditNames): string | null {
  if (!row.target_kind) return null;
  const name = row.target_id ? names.targets.get(`${row.target_kind}:${row.target_id}`) : undefined;
  const kind = TARGET_KIND_LABEL[row.target_kind] ?? row.target_kind.replace(/_/g, " ");
  if (name) return `${kind}: ${name}`;
  if (row.target_kind === "route" && row.target_id) return `${kind}: ${row.target_id}`;
  return kind;
}

export function officeLabel(row: Pick<AuditRow, "provider_id">, names: AuditNames): string | null {
  if (!row.provider_id) return null;
  return names.offices.get(row.provider_id) || null;
}
