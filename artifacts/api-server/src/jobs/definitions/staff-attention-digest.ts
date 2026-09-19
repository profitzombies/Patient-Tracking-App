import { loadOfficeAttention } from "../../lib/office-attention";
import { loadOfficeOverrides, loadOrgPolicy } from "../../lib/org-policy";
import { localClock, parseClockMinutes } from "../../notifications/policy";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { staffDigestPushBody, type DigestReasonCount } from "../../alerts/staff-sender";
import type { JobContext, JobDefinition } from "../types";

/** Counts patients per reason label in first-seen order; this is all the email and push ever learn. */
export function digestReasonCounts(items: ReadonlyArray<{ reasons: ReadonlyArray<{ label: string }> }>): DigestReasonCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const label of new Set(item.reasons.map((reason) => reason.label))) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count }));
}

type Row = Record<string, unknown>;
const enc = encodeURIComponent;

function localDate(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
/** First instant of the next office-local day plus twelve hours (DST-safe). */
export function digestExpiry(at: Date, zone: string): Date {
  const today = localDate(at, zone);
  let low = at.getTime();
  let high = low + 60 * 60_000;
  while (localDate(new Date(high), zone) === today) high += 60 * 60_000;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDate(new Date(middle), zone) === today) low = middle;
    else high = middle;
  }
  return new Date(high + 12 * 60 * 60_000);
}
function ok(result: { status: number }, label: string) {
  if (result.status >= 300) throw new Error(`${label} failed (${result.status})`);
}

export async function runStaffAttentionDigest(ctx: JobContext): Promise<void> {
  const [providersResult, activeResult, org] = await Promise.all([
    supabaseAdmin("GET", "/rest/v1/providers?access_disabled=eq.false&select=provider_id,provider_name,email,auth_user_id&limit=5000"),
    supabaseAdmin("GET", "/rest/v1/patients?activation_status=eq.activated&archived_at=is.null&select=provider_id&limit=10000"),
    loadOrgPolicy({ fresh: true }),
  ]);
  ok(providersResult, "staff digest provider scan"); ok(activeResult, "staff digest patient scan");
  const active = new Set((Array.isArray(activeResult.json) ? activeResult.json as Row[] : []).map((row) => String(row.provider_id)));
  for (const provider of (Array.isArray(providersResult.json) ? providersResult.json as Row[] : [])) {
    ctx.checkpoint();
    const providerId = String(provider.provider_id);
    if (!active.has(providerId)) continue;
    try {
      const overrides = await loadOfficeOverrides(providerId);
      const zone = overrides.alertTimeZone ?? org.defaultTimezone;
      const sendMinutes = parseClockMinutes(overrides.alertSendTime) ?? 480;
      const clock = localClock(ctx.now, zone);
      if (clock.minutes < sendMinutes) { ctx.tally("beforeSendTime"); continue; }
      const digestDate = localDate(ctx.now, zone);
      const existing = await supabaseAdmin("GET", `/rest/v1/office_attention_digests?provider_id=eq.${enc(providerId)}&digest_date=eq.${digestDate}&select=id&limit=1`);
      ok(existing, "staff digest idempotence read");
      if (Array.isArray(existing.json) && existing.json[0]) { ctx.tally("alreadyGenerated"); continue; }
      const attention = await loadOfficeAttention(providerId, ctx.now);
      ctx.tally("officesDue");
      ctx.tally("patientsFlagged", attention.items.length);
      if (ctx.dryRun) continue;
      const inserted = await supabaseAdmin("POST", "/rest/v1/office_attention_digests?on_conflict=provider_id,digest_date", [{
        provider_id: providerId, digest_date: digestDate, generated_at: ctx.now.toISOString(),
        time_zone: zone, flagged_count: attention.items.length, items: attention.items,
      }], "resolution=ignore-duplicates,return=representation");
      ok(inserted, "staff digest insert");
      if (!Array.isArray(inserted.json) || !inserted.json[0]) { ctx.tally("alreadyGenerated"); continue; }
      ctx.tally("digestsGenerated");
      if (!attention.items.length) continue;
      const membersResult = await supabaseAdmin("GET", `/rest/v1/team_members?provider_id=eq.${enc(providerId)}&activation_status=neq.disabled&auth_user_id=not.is.null&select=id,name,email,office_role,auth_user_id&limit=500`);
      ok(membersResult, "staff digest recipient scan");
      const candidates = [
        ...(provider.auth_user_id ? [{ id: "owner", name: null, email: provider.email, office_role: "owner", auth_user_id: provider.auth_user_id }] : []),
        ...(Array.isArray(membersResult.json) ? membersResult.json as Row[] : []),
      ];
      const recipients = candidates.filter((row) =>
        overrides.alertRecipientMode === "all" ||
        (overrides.alertRecipientMode === "owners_admins" && (row.office_role === "owner" || row.office_role === "admin")) ||
        (overrides.alertRecipientMode === "selected" && overrides.alertRecipientMemberIds.includes(String(row.id))),
      );
      const body = staffDigestPushBody(attention.items.length);
      // The email renders from this snapshot so the message matches the digest
      // exactly as it was generated, even if the roster moves on later. Only
      // counts per reason are stored: email and push leave through vendors
      // without a BAA, so no patient name or per-patient finding may ride
      // along. The names live in office_attention_digests for the in-app page.
      const reasonCounts = digestReasonCounts(attention.items);
      const expires = digestExpiry(ctx.now, zone).toISOString();
      const notifications = recipients.flatMap((recipient) => (["email", "push"] as const).map((channel) => ({
        provider_id: providerId, auth_user_id: recipient.auth_user_id, channel,
        email: channel === "email" ? recipient.email ?? null : null,
        kind: "staff_attention_digest", category: "staff_alerts", title: "Patients need attention", body,
        data: {
          digestDate, flaggedCount: attention.items.length, providerId,
          officeName: String(provider.provider_name ?? "Your office"),
          recipientName: typeof recipient.name === "string" && recipient.name.trim() ? recipient.name.trim() : null,
          reasonCounts,
        },
        dedupe_key: `staff_attention:${providerId}:${digestDate}:${recipient.auth_user_id}:${channel}`,
        scheduled_at: ctx.now.toISOString(), next_attempt_at: ctx.now.toISOString(), expires_at: expires,
      })));
      if (notifications.length) {
        const queued = await supabaseAdmin("POST", "/rest/v1/staff_notifications?on_conflict=dedupe_key", notifications, "resolution=ignore-duplicates,return=representation");
        ok(queued, "staff digest enqueue");
        ctx.tally("deliveriesQueued", Array.isArray(queued.json) ? queued.json.length : 0);
      }
    } catch (error) { ctx.failItem(providerId, error); }
  }
}

export const staffAttentionDigestJob: JobDefinition = {
  name: "staff-attention-digest",
  title: "Staff attention digest",
  description: "Creates each office's daily patient-attention snapshot and queues staff email and push delivery.",
  intervalMs: 15 * 60_000,
  leaseSeconds: 10 * 60,
  run: runStaffAttentionDigest,
};