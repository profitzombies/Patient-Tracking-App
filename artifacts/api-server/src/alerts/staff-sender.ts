import { isTokenDeadError, type ExpoPushClient, type PushMessage } from "../notifications/expo-push";
import { inQuietWindow, localClock, parseQuietHours, quietWindowEnd } from "../notifications/policy";
import { sendGuarded } from "../notifications/push-guard";
import { effectivePolicyFor, loadOfficeOverrides, loadOrgPolicy } from "../lib/org-policy";
import type { StaffNotificationRow, StaffNotificationStore } from "./store";
import { publicOrigin } from "../billing/app-origin";
import { sendTemplatedEmail } from "../email/transport";
import { renderEmailTemplate, type EmailTemplateId, type EmailVariables, type RenderedEmail } from "@workspace/email-templates";

/** Lock-screen copy for the staff digest: a count and an instruction, never a name or a reason. */
export const STAFF_DIGEST_PUSH_TITLE = "Patients need attention";
export function staffDigestPushBody(flaggedCount: number): string {
  return `${flaggedCount === 1 ? "1 patient needs" : `${flaggedCount} patients need`} attention. Open the app.`;
}

export interface StaffSenderSummary {
  claimed: number; sent: number; failed: number; suppressed: number; optedOut: number; deferred: number; leaseLost: number;
}
const empty = (): StaffSenderSummary => ({ claimed: 0, sent: 0, failed: 0, suppressed: 0, optedOut: 0, deferred: 0, leaseLost: 0 });
async function patch(store: StaffNotificationStore, row: StaffNotificationRow, owner: string, values: Record<string, unknown>, summary: StaffSenderSummary) {
  const landed = await store.update(row.id, values, owner); if (!landed) summary.leaseLost += 1; return landed;
}
async function finish(store: StaffNotificationStore, row: StaffNotificationRow, owner: string, status: string, now: Date, reason: string | null, summary: StaffSenderSummary) {
  return patch(store, row, owner, { status, suppression_reason: reason, finalized_at: now.toISOString(), lease_owner: null, lease_until: null }, summary);
}
/** One line of the digest email: how many patients share a reason. */
export interface DigestReasonCount { label: string; count: number }
function digestDateLabel(digestDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(digestDate);
  if (!match) return digestDate;
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
}
function reasonCountText(reason: DigestReasonCount): string {
  return `${reason.label} · ${reason.count} patient${reason.count === 1 ? "" : "s"}`;
}
function formatThresholdValue(metric: string, value: number): string {
  if (metric === "p95_latency") return `p95 ${Math.round(value).toLocaleString("en-US")} ms`;
  const mb = value / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB per day` : `${mb.toFixed(1)} MB per day`;
}
interface StaffEmail { templateId: EmailTemplateId; variables: EmailVariables }
/**
 * HQ threshold alert: metric names, the numbers, and a link. Everything it
 * needs was snapshotted on the row when the job queued it; nothing on that
 * row identifies a patient (route families are labelled, never raw paths).
 */
export function systemThresholdEmail(row: StaffNotificationRow): StaffEmail {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const metric = String(data.metric ?? "");
  const family = typeof data.family === "string" ? data.family : null;
  const metricLabel = metric === "p95_latency" ? `Slow route ${family ?? ""}`.trim() : metric === "db_growth" ? "Database growing fast" : metric === "storage_growth" ? "Storage growing fast" : row.title;
  return { templateId: "system-threshold-alert", variables: {
    name: typeof data.recipientName === "string" ? data.recipientName : "",
    level: String(data.level ?? "amber"),
    metricLabel,
    finding: typeof data.message === "string" && data.message ? data.message : row.body,
    observed: formatThresholdValue(metric, Number(data.value ?? 0)),
    limit: formatThresholdValue(metric, Number(data.limit ?? 0)),
    day: digestDateLabel(String(data.day ?? "")),
    healthLink: `${publicOrigin()}/admin/system-health`,
  } };
}
export function renderSystemThresholdEmail(row: StaffNotificationRow): RenderedEmail {
  const email = systemThresholdEmail(row);
  return renderEmailTemplate(email.templateId, email.variables);
}
export function isSystemThresholdRow(row: StaffNotificationRow): boolean {
  return row.kind === "system_threshold" || (row.provider_id === null && row.kind !== "staff_attention_digest" && !isWeeklyCustomerHealthRow(row));
}
/** The kind the Monday Customer health summary rides on (HQ-addressed, opt-in per member). */
export const WEEKLY_CUSTOMER_HEALTH_ROW_KIND = "weekly_customer_health";
/** The hq_member_notification_preferences kind the sender re-checks before sending it. */
export const WEEKLY_CUSTOMER_HEALTH_PREFERENCE = "weekly_customer_health_email";
export function isWeeklyCustomerHealthRow(row: StaffNotificationRow): boolean {
  return row.kind === WEEKLY_CUSTOMER_HEALTH_ROW_KIND;
}
function weeklyChangeLabel(change: unknown): string {
  if (typeof change !== "number" || !Number.isFinite(change)) return "—";
  if (change === 0) return "no change";
  return `${change > 0 ? "+" : "−"}${Math.abs(change)} vs last week`;
}
/**
 * The weekly summary email: every number was snapshotted on the row by the
 * job, so the email reads exactly what that Monday's run saw. Office names
 * and counts only; " · " inside an office name is flattened because the
 * template splits lines on it.
 */
export function weeklyCustomerHealthEmail(row: StaffNotificationRow): StaffEmail {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const flat = (value: unknown) => String(value ?? "").replace(/ · /g, " - ").replace(/\n/g, " ").trim();
  const buckets = Array.isArray(data.bucketCounts) ? data.bucketCounts as Array<Record<string, unknown>> : [];
  const attention = Array.isArray(data.attention) ? data.attention as Array<Record<string, unknown>> : [];
  return { templateId: "weekly-customer-health-summary", variables: {
    name: typeof data.recipientName === "string" ? data.recipientName : "",
    weekLabel: typeof data.weekLabel === "string" && data.weekLabel ? data.weekLabel : row.title,
    officeCount: String(Number(data.officeCount ?? 0)),
    bucketCounts: buckets.map((bucket) => `${flat(bucket.label)} · ${Number(bucket.count ?? 0)}`).join("\n"),
    attentionCount: String(Number(data.attentionCount ?? attention.length)),
    attention: attention.map((item) => {
      const reasons = Array.isArray(item.reasons) ? item.reasons.map(flat).filter(Boolean).join("; ") : flat(item.reason);
      return [flat(item.officeName), String(Number(item.score ?? 0)), flat(item.band), weeklyChangeLabel(item.change), reasons || "Flagged on the Customer health page"].join(" · ");
    }).join("\n"),
    healthLink: `${publicOrigin()}/admin/customer-health`,
  } };
}
export function renderWeeklyCustomerHealthEmail(row: StaffNotificationRow): RenderedEmail {
  const email = weeklyCustomerHealthEmail(row);
  return renderEmailTemplate(email.templateId, email.variables);
}
/** The kind HQ office-access restriction alerts carry. */
export const OFFICE_ACCESS_RESTRICTED_KIND = "office_access_restricted";
export function isOfficeAccessRestrictedRow(row: StaffNotificationRow): boolean {
  return row.kind === OFFICE_ACCESS_RESTRICTED_KIND;
}
/**
 * HQ's restriction notice for one office. Like the threshold alert it belongs
 * to no office inbox (provider_id is null), so it carries its own snapshot:
 * the office name, the day, and what is outstanding.
 */
export function officeAccessRestrictedEmail(row: StaffNotificationRow): StaffEmail {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const amountCents = Number(data.amountCents ?? Number.NaN);
  return { templateId: "office-access-restricted", variables: {
    name: typeof data.recipientName === "string" ? data.recipientName : "",
    officeName: typeof data.officeName === "string" && data.officeName ? data.officeName : "An office",
    restrictedOn: digestDateLabel(String(data.day ?? "")),
    amountDue: Number.isFinite(amountCents) ? `$${(amountCents / 100).toFixed(2)}` : "",
    billingLink: `${publicOrigin()}/admin/payments/office-access`,
  } };
}
export function renderOfficeAccessRestrictedEmail(row: StaffNotificationRow): RenderedEmail {
  const email = officeAccessRestrictedEmail(row);
  return renderEmailTemplate(email.templateId, email.variables);
}
/**
 * The digest email from the snapshot stored on the row at enqueue time:
 * counts per reason and a link to the Needs attention page. Names never
 * appear; the row itself carries none (older rows that still do are ignored).
 */
export function staffDigestEmail(row: StaffNotificationRow): StaffEmail {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const origin = publicOrigin();
  const flaggedCount = Number(data.flaggedCount ?? 0);
  const reasons = Array.isArray(data.reasonCounts)
    ? (data.reasonCounts as unknown[]).filter((item): item is DigestReasonCount =>
      !!item && typeof item === "object" && typeof (item as DigestReasonCount).label === "string" && typeof (item as DigestReasonCount).count === "number")
    : [];
  const lines = reasons.map(reasonCountText);
  if (!lines.length) lines.push("Open the portal · The full list is on the Needs attention page");
  return { templateId: "staff-attention-digest", variables: {
    name: typeof data.recipientName === "string" ? data.recipientName : "",
    officeName: typeof data.officeName === "string" && data.officeName ? data.officeName : "Your office",
    digestDate: digestDateLabel(String(data.digestDate ?? "")),
    flaggedCount: String(flaggedCount),
    reasons: lines.join("\n"),
    alertsLink: `${origin}/alerts`,
    settingsLink: `${origin}/settings`,
  } };
}
export function renderStaffDigestEmail(row: StaffNotificationRow): RenderedEmail {
  const email = staffDigestEmail(row);
  return renderEmailTemplate(email.templateId, email.variables);
}
/** The kind a coach chat safety flag alert carries. */
export const COACH_CHAT_FLAG_ROW_KIND = "coach_chat_flag";
export function isCoachChatFlagRow(row: StaffNotificationRow): boolean {
  return row.kind === COACH_CHAT_FLAG_ROW_KIND;
}
/**
 * The coach chat flag email: the office, the day, and a sign-in link that
 * lands on the flag. Deliberately says nothing about the patient or what was
 * said — that lives behind sign-in. The link carries the flag id only.
 */
export function coachChatFlagEmail(row: StaffNotificationRow): StaffEmail {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const origin = publicOrigin();
  const flagId = typeof data.flagId === "string" ? data.flagId : "";
  return { templateId: "coach-chat-flag", variables: {
    name: typeof data.recipientName === "string" ? data.recipientName : "",
    officeName: typeof data.officeName === "string" && data.officeName ? data.officeName : "Your office",
    day: digestDateLabel(String(data.day ?? "")),
    reviewLink: flagId ? `${origin}/alerts?chat=${encodeURIComponent(flagId)}` : `${origin}/alerts`,
    settingsLink: `${origin}/settings`,
  } };
}
export function renderCoachChatFlagEmail(row: StaffNotificationRow): RenderedEmail {
  const email = coachChatFlagEmail(row);
  return renderEmailTemplate(email.templateId, email.variables);
}
/** Push payload per kind: ids and a route only; the row snapshot stays server-side. */
export function staffPushContent(row: StaffNotificationRow): { title: string; body: string; data: Record<string, unknown> } {
  const data = (row.data ?? {}) as Record<string, unknown>;
  if (isCoachChatFlagRow(row)) {
    return {
      title: row.title, body: row.body,
      data: {
        route: "/(tabs)/patients", kind: COACH_CHAT_FLAG_ROW_KIND, category: "staff_alerts", notificationId: row.id,
        providerId: row.provider_id, flagId: typeof data.flagId === "string" ? data.flagId : null,
      },
    };
  }
  const flaggedCount = Number(data.flaggedCount ?? 0);
  return {
    title: STAFF_DIGEST_PUSH_TITLE, body: staffDigestPushBody(flaggedCount),
    data: {
      route: "/(tabs)/patients", kind: "staff_attention_digest", category: "staff_alerts", notificationId: row.id,
      providerId: row.provider_id, digestDate: typeof data.digestDate === "string" ? data.digestDate : null, flaggedCount,
    },
  };
}
async function sendEmail(row: StaffNotificationRow): Promise<void> {
  if (!row.email) throw new Error("staff email delivery is not configured");
  const email = isOfficeAccessRestrictedRow(row)
    ? officeAccessRestrictedEmail(row)
    : isWeeklyCustomerHealthRow(row) ? weeklyCustomerHealthEmail(row)
    : isSystemThresholdRow(row) ? systemThresholdEmail(row)
      : isCoachChatFlagRow(row) ? coachChatFlagEmail(row) : staffDigestEmail(row);
  await sendTemplatedEmail({
    to: row.email, templateId: email.templateId, variables: email.variables, sender: "branded",
    refs: { notificationId: row.id, kind: row.kind ?? null, providerId: row.provider_id },
  });
}

export async function runStaffNotificationTick(input: {
  store: StaffNotificationStore; push: ExpoPushClient; owner: string; now?: () => Date; claimLimit?: number; leaseSeconds?: number;
  maxAttempts?: number; baseBackoffMs?: number;
}): Promise<StaffSenderSummary> {
  const now = input.now?.() ?? new Date(); const summary = empty();
  const claimed = await input.store.claimDue(input.owner, input.claimLimit ?? 25, input.leaseSeconds ?? 120);
  summary.claimed = claimed.length;
  const org = claimed.length ? await loadOrgPolicy() : null;
  for (const row of claimed) {
    try {
      if (new Date(row.expires_at) <= now) { if (await finish(input.store, row, input.owner, "expired", now, null, summary)) summary.suppressed += 1; continue; }
      // HQ system alerts belong to no office: no office state, per-office
      // preference, or quiet hours apply. They are email-only by construction
      // (the threshold job never queues a push row).
      if (isSystemThresholdRow(row) || row.provider_id === null) {
        if (row.channel !== "email") {
          if (await finish(input.store, row, input.owner, "suppressed", now, "channel_unsupported", summary)) summary.suppressed += 1;
          continue;
        }
        // The weekly summary is opt-in per HQ member: re-check the toggle (and
        // that the membership is still active) at send time, so turning it
        // off between the Monday run and the send is honoured and recorded.
        if (isWeeklyCustomerHealthRow(row) && !(await input.store.hqSubscribed(row.auth_user_id, WEEKLY_CUSTOMER_HEALTH_PREFERENCE))) {
          if (await finish(input.store, row, input.owner, "suppressed", now, "unsubscribed", summary)) { summary.suppressed += 1; summary.optedOut += 1; }
          continue;
        }
        try {
          await sendEmail(row);
          if (await patch(input.store, row, input.owner, { status: "sent", sent_at: now.toISOString(), finalized_at: now.toISOString(), attempts: row.attempts + 1, lease_owner: null, lease_until: null }, summary)) summary.sent += 1;
        } catch (error) {
          if (await patch(input.store, row, input.owner, { status: "failed", attempts: row.attempts + 1, last_error: error instanceof Error ? error.message : String(error), finalized_at: now.toISOString(), lease_owner: null, lease_until: null }, summary)) summary.failed += 1;
        }
        continue;
      }
      const office = await input.store.officeState(row.provider_id);
      if (!office.available || office.locked) {
        if (await finish(input.store, row, input.owner, "suppressed", now, office.locked ? "office_locked" : "office_unavailable", summary)) summary.suppressed += 1;
        continue;
      }
      const pref = await input.store.preference(row.provider_id, row.auth_user_id);
      if ((row.channel === "email" && !pref.emailEnabled) || (row.channel === "push" && !pref.pushEnabled)) {
        if (await finish(input.store, row, input.owner, "opted_out", now, "channel_off", summary)) summary.optedOut += 1;
        continue;
      }
      const overrides = await loadOfficeOverrides(row.provider_id);
      const effective = effectivePolicyFor(org!, overrides);
      const zone = overrides.alertTimeZone ?? org!.defaultTimezone;
      const quiet = parseQuietHours(effective.quietHours);
      if (quiet && inQuietWindow(localClock(now, zone).minutes, quiet)) {
        const until = quietWindowEnd(now, zone, quiet);
        if (until >= new Date(row.expires_at)) {
          if (await finish(input.store, row, input.owner, "suppressed", now, "quiet_hours", summary)) summary.suppressed += 1;
        } else if (await patch(input.store, row, input.owner, { status: "queued", next_attempt_at: until.toISOString(), suppression_reason: "quiet_hours_deferred", lease_owner: null, lease_until: null }, summary)) summary.deferred += 1;
        continue;
      }
      if (row.channel === "email") {
        try {
          await sendEmail(row);
          if (await patch(input.store, row, input.owner, { status: "sent", sent_at: now.toISOString(), finalized_at: now.toISOString(), attempts: row.attempts + 1, lease_owner: null, lease_until: null }, summary)) summary.sent += 1;
        } catch (error) {
          if (await patch(input.store, row, input.owner, { status: "failed", attempts: row.attempts + 1, last_error: error instanceof Error ? error.message : String(error), finalized_at: now.toISOString(), lease_owner: null, lease_until: null }, summary)) summary.failed += 1;
        }
        continue;
      }
      const tokens = await input.store.activeTokens(row.auth_user_id);
      if (!tokens.length) { if (await finish(input.store, row, input.owner, "suppressed", now, "no_device", summary)) summary.suppressed += 1; continue; }
      // Only ids and a route ride along: the row snapshot (office name,
      // recipient name, per-reason counts) stays server-side.
      const content = staffPushContent(row);
      const messages: PushMessage[] = tokens.map((token) => ({
        to: token.token, title: content.title, body: content.body, sound: "default", channelId: "thinnr-messages", priority: "high",
        data: content.data,
      }));
      let tickets;
      try {
        tickets = await sendGuarded(input.push, messages);
      } catch (error) {
        const attempt = row.attempts + 1;
        const failed = attempt >= (input.maxAttempts ?? 5);
        if (await patch(input.store, row, input.owner, {
          status: failed ? "failed" : "queued", attempts: attempt,
          next_attempt_at: failed ? undefined : new Date(now.getTime() + (input.baseBackoffMs ?? 30_000) * 2 ** Math.max(0, attempt - 1)).toISOString(),
          last_error: error instanceof Error ? error.message : String(error),
          finalized_at: failed ? now.toISOString() : null, lease_owner: null, lease_until: null,
        }, summary)) failed ? summary.failed += 1 : undefined;
        continue;
      }
      let success = false;
      const attempts: Record<string, unknown>[] = [];
      for (let index = 0; index < tokens.length; index += 1) {
        const ticket = tickets[index]; const token = tokens[index]; if (!ticket || !token) continue;
        success ||= ticket.status === "ok";
        attempts.push({ notification_id: row.id, auth_user_id: row.auth_user_id, token_id: token.id, attempt: row.attempts + 1, ticket_id: ticket.status === "ok" ? ticket.id : null, outcome: ticket.status === "ok" ? "ticket_ok" : "ticket_error", error_code: ticket.status === "error" ? ticket.details?.error ?? "UNKNOWN" : null, error_message: ticket.status === "error" ? ticket.message ?? null : null });
        if (ticket.status === "error" && isTokenDeadError(ticket.details?.error)) await input.store.disableToken(token.id, "device_not_registered");
      }
      await input.store.insertAttempts(attempts);
      if (await patch(input.store, row, input.owner, { status: success ? "sent" : "failed", attempts: row.attempts + 1, sent_at: success ? now.toISOString() : null, finalized_at: success ? null : now.toISOString(), lease_owner: null, lease_until: null }, summary)) success ? summary.sent += 1 : summary.failed += 1;
    } catch (error) {
      if (await patch(input.store, row, input.owner, { status: "failed", last_error: error instanceof Error ? error.message : String(error), finalized_at: now.toISOString(), lease_owner: null, lease_until: null }, summary)) summary.failed += 1;
    }
  }
  return summary;
}