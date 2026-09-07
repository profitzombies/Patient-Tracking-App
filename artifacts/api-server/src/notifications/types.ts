/**
 * Shared shapes for the push-notification outbox.
 *
 * The rows mirror supabase/migrations/20260927000000_push_notifications.sql
 * one to one (snake_case, as PostgREST returns them). Everything the sender,
 * the routes and the staff timeline agree on lives here so the fake store used
 * in tests and the Supabase-backed store cannot drift apart.
 */

export const NOTIFICATION_CATEGORIES = [
  "coach_outreach",
  "check_in_reminders",
  "office_reminders",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === "string" && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

export const NOTIFICATION_STATUSES = [
  "queued",
  "sending",
  "sent",
  "delivered",
  "opened",
  "failed",
  "suppressed",
  "opted_out",
  "expired",
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Statuses the sender never touches again. */
export const TERMINAL_STATUSES: ReadonlySet<NotificationStatus> = new Set([
  "delivered",
  "opened",
  "failed",
  "suppressed",
  "opted_out",
  "expired",
]);

export type SuppressionReason =
  | "quiet_hours"
  | "quiet_hours_deferred"
  | "no_device"
  | "category_off"
  | "nudge_opt_out";

export type TokenDisableReason =
  | "signed_out"
  | "account_switch"
  | "replaced"
  | "device_not_registered"
  | "invalid_credentials";

export interface NotificationRow {
  id: string;
  patient_id: string;
  kind: string;
  category: NotificationCategory;
  title: string;
  body: string;
  data: Record<string, unknown>;
  dedupe_key: string | null;
  scheduled_at: string;
  expires_at: string;
  status: NotificationStatus;
  attempts: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_until: string | null;
  suppression_reason: string | null;
  last_error: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  engaged_at: string | null;
  finalized_at: string | null;
  receipts_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PushTokenRow {
  id: string;
  patient_id: string;
  token: string;
  device_id: string;
  platform: "ios" | "android";
  disabled_at: string | null;
  disabled_reason: string | null;
  last_registered_at: string;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  id: string;
  notification_id: string;
  patient_id: string;
  token_id: string | null;
  attempt: number;
  ticket_id: string | null;
  outcome: "ticket_ok" | "ticket_error" | "request_failed";
  error_code: string | null;
  error_message: string | null;
  receipt_outcome: "ok" | "error" | "missing" | null;
  receipt_error_code: string | null;
  receipt_checked_at: string | null;
  created_at: string;
}

export interface OutreachStateRow {
  patient_id: string;
  provider_id: string;
  evaluated_at: string;
  as_of_date: string;
  eligible: boolean;
  crossed_on_key: string | null;
  adherence: Record<string, unknown>;
  stall: Record<string, unknown>;
  decision: string;
  notification_id: string | null;
  updated_at: string;
}

/** What a caller hands the outbox to create a row. */
export interface EnqueueInput {
  patientId: string;
  kind: string;
  category: NotificationCategory;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  dedupeKey?: string | null;
  scheduledAt?: Date;
  expiresAt?: Date;
}

/** Organization-wide send cap a capped enqueue reserves against. */
export interface DailyCap {
  /** Maximum rows of this kind per cap window. */
  limit: number;
  /** Start of the cap window (rows created at or after it count). */
  since: Date;
}

/**
 * Result of a capped enqueue: `created` inserted a row (one cap slot taken),
 * `existing` found the dedupe key already queued (no slot taken), `capped`
 * means the window is full and nothing was inserted.
 */
export type CappedEnqueueResult =
  | { outcome: "created" | "existing"; row: NotificationRow }
  | { outcome: "capped"; row: null };

/** The per-patient facts the send policy reads. */
export interface PolicyContext {
  /** patient_flags.notification_prefs, as stored (opaque object or null). */
  prefs: Record<string, unknown> | null;
  /** IANA timezone from the patient profile, null when never recorded. */
  timezone: string | null;
  /** patient_flags.nudge_opt_out — the coach-outreach master switch. */
  nudgeOptOut: boolean;
  /** The patient's office, for office-local policy overrides (quiet hours). */
  providerId: string | null;
}
