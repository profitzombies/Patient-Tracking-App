/**
 * HQ's alert when an office is restricted.
 *
 * The office has already been told by its own dunning notices; this is the
 * internal side: THINNR's administrators learn that an office reached the end
 * of its recovery window with nothing collected, so someone can call them.
 *
 * The rows are HQ-wide (provider_id null), which is what keeps them out of
 * office inboxes, office notification preferences and office quiet hours —
 * the staff sender routes them on that alone. One row per administrator per
 * office per day, deduped in the database.
 */
import { supabaseAdmin } from "../../lib/supabase-admin";
import { accessPriceCents } from "./state";
import { loadAccessBillingSettings } from "./settings";
import type { BillingOfficeAccessSubscriptionRow as Row } from "../store";

const DAY_MS = 86_400_000;
/** Kept in step with the staff sender's branch for these rows. */
export const OFFICE_ACCESS_RESTRICTED_KIND = "office_access_restricted";

export interface HqAlertRecipient {
  auth_user_id: string;
  email: string | null;
  display_name: string | null;
}

export function restrictionDedupeKey(providerId: string, day: string, authUserId: string): string {
  return `office_access_restricted:${providerId}:${day}:${authUserId}:email`;
}

export async function hqAlertRecipients(): Promise<HqAlertRecipient[]> {
  const result = await supabaseAdmin(
    "GET",
    "/rest/v1/hq_memberships?select=auth_user_id,email,display_name&status=eq.active&department_role=in.(super_admin,admin)&email=not.is.null",
  );
  if (result.status >= 300) throw new Error(`hq recipients read failed (${result.status})`);
  return Array.isArray(result.json) ? (result.json as HqAlertRecipient[]) : [];
}

async function officeName(providerId: string): Promise<string> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?select=office_name,provider_name&provider_id=eq.${encodeURIComponent(providerId)}&limit=1`,
  );
  const row = Array.isArray(result.json) ? (result.json[0] as { office_name?: string | null; provider_name?: string | null } | undefined) : undefined;
  return row?.office_name?.trim() || row?.provider_name?.trim() || "An office";
}

export function buildRestrictionNotifications(input: {
  providerId: string; officeName: string; amountCents: number | null;
  recipients: HqAlertRecipient[]; now: Date;
}): Record<string, unknown>[] {
  const day = input.now.toISOString().slice(0, 10);
  const expires = new Date(input.now.getTime() + 7 * DAY_MS).toISOString();
  return input.recipients.filter((recipient) => recipient.email).map((recipient) => ({
    provider_id: null,
    auth_user_id: recipient.auth_user_id,
    channel: "email",
    email: recipient.email,
    kind: OFFICE_ACCESS_RESTRICTED_KIND,
    category: "staff_alerts",
    title: `Restricted: ${input.officeName}`,
    body: `${input.officeName} was restricted on ${day} after its recovery window closed with nothing collected.`,
    data: {
      providerId: input.providerId,
      officeName: input.officeName,
      amountCents: input.amountCents,
      day,
      recipientName: recipient.display_name?.trim() || null,
    },
    dedupe_key: restrictionDedupeKey(input.providerId, day, recipient.auth_user_id),
    scheduled_at: input.now.toISOString(),
    next_attempt_at: input.now.toISOString(),
    expires_at: expires,
  }));
}

/**
 * Queue the alert. A failure here never rolls back the restriction itself —
 * the office's state is the fact, the email is the courtesy — so the caller
 * logs and moves on.
 */
export async function queueRestrictionAlert(row: Row, now: Date): Promise<number> {
  const [recipients, settings, name] = await Promise.all([
    hqAlertRecipients(),
    loadAccessBillingSettings(),
    officeName(row.provider_id),
  ]);
  const rows = buildRestrictionNotifications({
    providerId: row.provider_id, officeName: name,
    amountCents: accessPriceCents(row, settings), recipients, now,
  });
  if (!rows.length) return 0;
  const queued = await supabaseAdmin(
    "POST", "/rest/v1/staff_notifications?on_conflict=dedupe_key", rows, "resolution=ignore-duplicates,return=representation",
  );
  if (queued.status >= 300) throw new Error(`office access restriction alert enqueue failed (${queued.status})`);
  return Array.isArray(queued.json) ? queued.json.length : 0;
}
