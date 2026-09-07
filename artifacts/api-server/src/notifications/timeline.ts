/**
 * Staff-facing projections of the outbox: the per-patient notification
 * timeline and the roster's outreach chip state.
 *
 * Events are derived from row timestamps plus attempt rows — there is no
 * separate events table, so the timeline can never disagree with the state
 * the sender actually wrote.
 */
import type { AttemptRow, NotificationRow } from "./types";

export type TimelineEventKind =
  | "queued"
  | "attempt_failed"
  | "sent"
  | "delivered"
  | "opened"
  | "engaged"
  | "failed"
  | "suppressed"
  | "opted_out"
  | "expired";

export interface TimelineEvent {
  at: string;
  kind: TimelineEventKind;
  /** Human-readable reason/error for failed, suppressed and opted-out events. */
  detail: string | null;
}

export interface TimelineNotification {
  id: string;
  kind: string;
  category: NotificationRow["category"];
  title: string;
  body: string;
  status: NotificationRow["status"];
  suppressionReason: string | null;
  lastError: string | null;
  attempts: number;
  scheduledAt: string;
  expiresAt: string;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  engagedAt: string | null;
  finalizedAt: string | null;
  nextAttemptAt: string | null;
  events: TimelineEvent[];
}

export const SUPPRESSION_LABELS: Record<string, string> = {
  quiet_hours: "Quiet hours covered the whole send window",
  quiet_hours_deferred: "Held for quiet hours",
  no_device: "No registered device",
  category_off: "Patient turned this category off",
  nudge_opt_out: "Patient paused coach nudges",
};

export function describeSuppression(reason: string | null): string | null {
  if (!reason) return null;
  return SUPPRESSION_LABELS[reason] ?? reason;
}

function pushEvent(events: TimelineEvent[], at: string | null, kind: TimelineEventKind, detail: string | null = null) {
  if (!at) return;
  events.push({ at, kind, detail });
}

export function buildTimelineNotification(row: NotificationRow, attempts: AttemptRow[]): TimelineNotification {
  const events: TimelineEvent[] = [];
  pushEvent(events, row.created_at, "queued");
  for (const attempt of attempts) {
    if (attempt.outcome === "ticket_ok") continue;
    pushEvent(
      events,
      attempt.created_at,
      "attempt_failed",
      [attempt.error_code, attempt.error_message].filter(Boolean).join(": ") || "Send attempt failed",
    );
  }
  pushEvent(events, row.sent_at, "sent");
  pushEvent(events, row.delivered_at, "delivered");
  pushEvent(events, row.opened_at, "opened");
  pushEvent(events, row.engaged_at, "engaged");
  if (row.status === "failed") pushEvent(events, row.finalized_at ?? row.updated_at, "failed", row.last_error);
  if (row.status === "suppressed") {
    pushEvent(events, row.finalized_at ?? row.updated_at, "suppressed", describeSuppression(row.suppression_reason));
  }
  if (row.status === "opted_out") {
    pushEvent(events, row.finalized_at ?? row.updated_at, "opted_out", describeSuppression(row.suppression_reason));
  }
  if (row.status === "expired") pushEvent(events, row.finalized_at ?? row.updated_at, "expired");
  events.sort((a, b) => a.at.localeCompare(b.at));
  const active = row.status === "queued" || row.status === "sending";
  return {
    id: row.id,
    kind: row.kind,
    category: row.category,
    title: row.title,
    body: row.body,
    status: row.status,
    suppressionReason: row.suppression_reason,
    lastError: row.last_error,
    attempts: row.attempts,
    scheduledAt: row.scheduled_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    openedAt: row.opened_at,
    engagedAt: row.engaged_at,
    finalizedAt: row.finalized_at,
    nextAttemptAt: active ? row.next_attempt_at : null,
    events,
  };
}

export function buildTimeline(rows: NotificationRow[], attempts: AttemptRow[]): TimelineNotification[] {
  const byNotification = new Map<string, AttemptRow[]>();
  for (const attempt of attempts) {
    const list = byNotification.get(attempt.notification_id) ?? [];
    list.push(attempt);
    byNotification.set(attempt.notification_id, list);
  }
  return rows
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((row) => buildTimelineNotification(row, byNotification.get(row.id) ?? []));
}

// ── Roster chip ────────────────────────────────────────────────────────────

export type OutreachRosterState = "none" | "eligible" | "sent_awaiting" | "engaged" | "opted_out";

export interface OutreachRosterDto {
  state: OutreachRosterState;
  /** Whether the shared trigger currently holds for this patient. */
  eligible: boolean;
  crossedOnKey: string | null;
  evaluatedAt: string | null;
  lastSentKey: string | null;
  /** Outbox status of the newest coach-outreach notification, if any. */
  delivery: NotificationRow["status"] | null;
  deliveryDetail: string | null;
  notificationId: string | null;
}

export interface OutreachStateRpcRow {
  patient_id: string;
  eligible: boolean | null;
  crossed_on_key: string | null;
  evaluated_at: string | null;
  decision: string | null;
  nudge_opt_out: boolean | null;
  nudge_engaged: boolean | null;
  nudge_last_sent_key: string | null;
  nudge_last_crossing_key: string | null;
  notification_id: string | null;
  notification_status: string | null;
  notification_updated_at: string | null;
  notification_suppression_reason: string | null;
}

export const NO_OUTREACH: OutreachRosterDto = {
  state: "none",
  eligible: false,
  crossedOnKey: null,
  evaluatedAt: null,
  lastSentKey: null,
  delivery: null,
  deliveryDetail: null,
  notificationId: null,
};

/**
 * The chip semantics: an opted-out patient never shows outreach; an active
 * episode whose message was sent (crossing stamped) is "sent, awaiting
 * engagement" until the patient replies ("engaged"); an active episode that
 * has not been sent yet (cooldown, or the evaluator has not run) is
 * "eligible". Inactive patients show nothing.
 */
export function outreachRosterDto(row: OutreachStateRpcRow | undefined): OutreachRosterDto {
  if (!row) return NO_OUTREACH;
  const eligible = row.eligible === true;
  const crossing = row.crossed_on_key;
  const stamped = crossing !== null && row.nudge_last_crossing_key === crossing;
  const delivery = (row.notification_status as NotificationRow["status"] | null) ?? null;
  const deliveryDetail = describeSuppression(row.notification_suppression_reason);
  const base = {
    eligible,
    crossedOnKey: crossing,
    evaluatedAt: row.evaluated_at,
    lastSentKey: row.nudge_last_sent_key,
    delivery: stamped ? delivery : null,
    deliveryDetail: stamped ? deliveryDetail : null,
    notificationId: stamped ? row.notification_id : null,
  };
  if (row.nudge_opt_out === true) return { ...base, state: eligible ? "opted_out" : "none" };
  if (!eligible) return { ...base, state: "none" };
  if (stamped) return { ...base, state: row.nudge_engaged === true ? "engaged" : "sent_awaiting" };
  return { ...base, state: "eligible" };
}
