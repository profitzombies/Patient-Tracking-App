import { isTokenDeadError, type ExpoPushClient, type PushMessage } from "../notifications/expo-push";
import { inQuietWindow, localClock, parseQuietHours, quietWindowEnd } from "../notifications/policy";
import { effectivePolicyFor, loadOfficeOverrides, loadOrgPolicy } from "../lib/org-policy";
import type { StaffNotificationRow, StaffNotificationStore } from "./store";
import { publicOrigin } from "../billing/app-origin";
import { renderEmailTemplate, type RenderedEmail } from "@workspace/email-templates";

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
function fromAddress(): string | null {
  const configured = process.env.CLAIM_EMAIL_FROM;
  if (!configured) return null;
  const match = configured.match(/<([^>]+)>/);
  return `THINNR Weight Loss <${(match?.[1] ?? configured).trim()}>`;
}
interface DigestEmailPatient { name: string; reasons: Array<{ label: string; days: number | null }> }
function digestDateLabel(digestDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(digestDate);
  if (!match) return digestDate;
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
}
function reasonText(reason: { label: string; days: number | null }): string {
  if (reason.days === null) return `${reason.label} (never)`;
  return `${reason.label} (${reason.days} day${reason.days === 1 ? "" : "s"})`;
}
/** Builds the branded digest email from the snapshot stored on the row at enqueue time. */
export function renderStaffDigestEmail(row: StaffNotificationRow): RenderedEmail {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const origin = publicOrigin();
  const flaggedCount = Number(data.flaggedCount ?? 0);
  const patients = Array.isArray(data.patients) ? data.patients as DigestEmailPatient[] : [];
  const lines = patients.map((patient) => `${patient.name} · ${patient.reasons.map(reasonText).join(", ")}`);
  if (flaggedCount > patients.length) {
    const more = flaggedCount - patients.length;
    lines.push(`${more} more patient${more === 1 ? "" : "s"} · See the full list in the portal`);
  }
  if (!lines.length) lines.push("Open the portal · The full list is on the Needs attention page");
  return renderEmailTemplate("staff-attention-digest", {
    name: typeof data.recipientName === "string" ? data.recipientName : "",
    officeName: typeof data.officeName === "string" && data.officeName ? data.officeName : "Your office",
    digestDate: digestDateLabel(String(data.digestDate ?? "")),
    flaggedCount: String(flaggedCount),
    patients: lines.join("\n"),
    alertsLink: `${origin}/alerts`,
    settingsLink: `${origin}/settings`,
  });
}
async function sendEmail(row: StaffNotificationRow): Promise<void> {
  const key = process.env.RESEND_API_KEY; const from = fromAddress();
  if (!key || !from || !row.email) throw new Error("staff email delivery is not configured");
  const rendered = renderStaffDigestEmail(row);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [row.email], subject: rendered.subject, text: rendered.text, html: rendered.html }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Resend send failed (${response.status})`);
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
      const messages: PushMessage[] = tokens.map((token) => ({
        to: token.token, title: "Patients need attention", body: row.body, sound: "default", channelId: "thinnr-messages", priority: "high",
        data: { route: "/(tabs)/patients", kind: "staff_attention_digest", category: "staff_alerts", ...row.data, notificationId: row.id },
      }));
      let tickets;
      try {
        tickets = await input.push.send(messages);
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