/**
 * Coach chat flags: what happens after the safety screen finds something.
 *
 * One call records the finding and tells the office:
 *
 *   1. A `coach_chat_flags` row — who, which conversation, the category, the
 *      model's one-line reason, and a short excerpt. This is the only place
 *      the substance lives, and it is read in-app behind sign-in only.
 *   2. Staff notifications on the existing outbox, one email and one push per
 *      alert recipient (the same people the daily digest reaches). Their
 *      snapshot carries ids, the office name and the recipient's first name —
 *      never the patient's name, the reason, or the words. The sender applies
 *      office state, per-person opt-outs and quiet hours exactly as it does
 *      for the digest.
 *
 * Rate shaping: a patient who keeps talking about the same concern produces
 * one flag per category per day, and the office hears about a patient at
 * most once a day per channel (dedupe key on the outbox). A NEW category on
 * the same day still creates a new flag so the in-app list is complete.
 */

import { supabaseAdmin } from "../lib/supabase-admin";
import { loadOfficeOverrides, loadOrgPolicy } from "../lib/org-policy";
import { officeIsActive } from "../lib/office-status";
import type { CoachSafetyCategory, CoachSafetyFinding } from "../coach/safety-screen";

type Row = Record<string, unknown>;
const enc = encodeURIComponent;

export const COACH_CHAT_FLAG_KIND = "coach_chat_flag";
/** Lock-screen copy: an instruction, never a name or a reason. */
export const COACH_CHAT_FLAG_PUSH_TITLE = "A patient's chat needs review";
export const COACH_CHAT_FLAG_PUSH_BODY = "A patient said something in their coach chat that needs your attention today. Open the app.";
/** Longest a flag alert may wait in the outbox (quiet hours can defer it). */
const FLAG_ALERT_TTL_MS = 36 * 60 * 60_000;
const SAME_CATEGORY_WINDOW_MS = 24 * 60 * 60_000;
export const COACH_CHAT_FLAG_EXCERPT_LIMIT = 1000;

function ok(result: { status: number }, label: string) {
  if (result.status >= 300) throw new Error(`${label} failed (${result.status})`);
}
function localDate(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface OfficeAlertRecipient { authUserId: string; email: string | null; name: string | null }

/**
 * The office's alert recipients under its current delivery settings: the
 * owner plus enabled, signed-up teammates, narrowed by the office's recipient
 * mode. Shared shape with the daily digest's selection.
 */
export async function loadOfficeAlertRecipients(providerId: string, provider: Row, overrides: { alertRecipientMode: string; alertRecipientMemberIds: string[] }): Promise<OfficeAlertRecipient[]> {
  const membersResult = await supabaseAdmin("GET", `/rest/v1/team_members?provider_id=eq.${enc(providerId)}&activation_status=neq.disabled&auth_user_id=not.is.null&select=id,name,email,office_role,auth_user_id&limit=500`);
  ok(membersResult, "alert recipient scan");
  const candidates: Row[] = [
    ...(provider.auth_user_id ? [{ id: "owner", name: null, email: provider.email, office_role: "owner", auth_user_id: provider.auth_user_id }] : []),
    ...(Array.isArray(membersResult.json) ? membersResult.json as Row[] : []),
  ];
  return candidates
    .filter((row) =>
      overrides.alertRecipientMode === "all" ||
      (overrides.alertRecipientMode === "owners_admins" && (row.office_role === "owner" || row.office_role === "admin")) ||
      (overrides.alertRecipientMode === "selected" && overrides.alertRecipientMemberIds.includes(String(row.id))))
    .map((row) => ({
      authUserId: String(row.auth_user_id),
      email: typeof row.email === "string" && row.email ? row.email : null,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : null,
    }));
}

export interface RecordCoachChatFlagInput {
  patientId: string;
  providerId: string;
  conversationId: string | null;
  finding: CoachSafetyFinding;
  /** The patient's message; truncated before storage. */
  messageText: string;
  now?: Date;
}
export type RecordCoachChatFlagResult =
  | { outcome: "skipped_duplicate" }
  | { outcome: "skipped_office_inactive" }
  | { outcome: "recorded"; flagId: string; deliveriesQueued: number };

export async function recordCoachChatFlag(input: RecordCoachChatFlagInput): Promise<RecordCoachChatFlagResult> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - SAME_CATEGORY_WINDOW_MS).toISOString();
  const [providerResult, recent] = await Promise.all([
    supabaseAdmin("GET", `/rest/v1/providers?provider_id=eq.${enc(input.providerId)}&select=provider_id,provider_name,email,auth_user_id,access_disabled,offboarding_status&limit=1`),
    supabaseAdmin("GET", `/rest/v1/coach_chat_flags?patient_id=eq.${enc(input.patientId)}&category=eq.${enc(input.finding.category)}&status=eq.open&created_at=gte.${enc(since)}&select=id&limit=1`),
  ]);
  ok(providerResult, "coach flag provider read"); ok(recent, "coach flag duplicate read");
  const provider = (Array.isArray(providerResult.json) ? providerResult.json[0] : null) as Row | null;
  // An office leaving THINNR has nobody who can sign in to act on the flag.
  if (!provider || !officeIsActive(provider)) return { outcome: "skipped_office_inactive" };
  if (Array.isArray(recent.json) && recent.json[0]) return { outcome: "skipped_duplicate" };

  const excerpt = input.messageText.replace(/\s+/g, " ").trim().slice(0, COACH_CHAT_FLAG_EXCERPT_LIMIT) || "(empty message)";
  const inserted = await supabaseAdmin("POST", "/rest/v1/coach_chat_flags", [{
    patient_id: input.patientId, provider_id: input.providerId, conversation_id: input.conversationId,
    category: input.finding.category, reason: input.finding.reason.slice(0, 300), message_excerpt: excerpt,
    status: "open", created_at: now.toISOString(),
  }], "return=representation");
  ok(inserted, "coach flag insert");
  const flagId = Array.isArray(inserted.json) && inserted.json[0] ? String((inserted.json[0] as Row).id) : null;
  if (!flagId) throw new Error("coach flag insert returned no row");

  const [overrides, org] = await Promise.all([loadOfficeOverrides(input.providerId), loadOrgPolicy()]);
  const recipients = await loadOfficeAlertRecipients(input.providerId, provider, overrides);
  const zone = overrides.alertTimeZone ?? org.defaultTimezone;
  const day = localDate(now, zone);
  const expires = new Date(now.getTime() + FLAG_ALERT_TTL_MS).toISOString();
  const officeName = String(provider.provider_name ?? "Your office");
  const notifications = recipients.flatMap((recipient) => (["email", "push"] as const).map((channel) => ({
    provider_id: input.providerId, auth_user_id: recipient.authUserId, channel,
    email: channel === "email" ? recipient.email : null,
    kind: COACH_CHAT_FLAG_KIND, category: "staff_alerts",
    title: COACH_CHAT_FLAG_PUSH_TITLE, body: COACH_CHAT_FLAG_PUSH_BODY,
    // Ids and the office/recipient names only. The patient, category, reason
    // and excerpt stay on the flag row; email and push leave through vendors
    // without a BAA.
    data: { flagId, providerId: input.providerId, officeName, recipientName: recipient.name, day },
    // One alert per patient per office-local day per person and channel.
    dedupe_key: `coach_chat_flag:${input.providerId}:${input.patientId}:${day}:${recipient.authUserId}:${channel}`,
    scheduled_at: now.toISOString(), next_attempt_at: now.toISOString(), expires_at: expires,
  })));
  let deliveriesQueued = 0;
  if (notifications.length) {
    const queued = await supabaseAdmin("POST", "/rest/v1/staff_notifications?on_conflict=dedupe_key", notifications, "resolution=ignore-duplicates,return=representation");
    ok(queued, "coach flag enqueue");
    deliveriesQueued = Array.isArray(queued.json) ? queued.json.length : 0;
  }
  return { outcome: "recorded", flagId, deliveriesQueued };
}

export function isCoachSafetyCategory(value: unknown): value is CoachSafetyCategory {
  return value === "severe_symptoms" || value === "medication_problem" || value === "pregnancy" || value === "self_harm" || value === "eating_disorder";
}
