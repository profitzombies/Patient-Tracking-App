/**
 * Diet notifications — PHI-free, deduplicated per patient per day per kind.
 *
 * Care team (staff outbox, push only — no email template exists for these):
 *   diet_change          a diet changed (patient- or provider-made), or an
 *                        "oversight recommended" pick
 *   diet_safety          a yes to the medication question, a pick parked
 *                        behind a safety block, or a pregnancy / breastfeeding
 *                        answer that conflicts with the current diet
 *   diet_allergy_severe  a severe allergy was added
 *
 * Patient (patient outbox):
 *   diet_changed_by_provider  (office_reminders) your care team changed your diet
 *   diet_pregnancy_warning    (account) your current plan is not recommended
 *                             while pregnant or breastfeeding
 *
 * Rows carry event-level copy and ids for the authenticated bell / in-app
 * list. The diet, the answer and the allergy stay on the patient's record
 * behind sign-in. What actually leaves for the push vendor (no BAA) is the
 * generic copy and kind in ./push-kinds, applied by each sender at the send
 * seam — see staffPushContent and the patient sender.
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import { loadOfficeOverrides, loadOrgPolicy } from "../lib/org-policy";
import { officeIsActive } from "../lib/office-status";
import { loadOfficeAlertRecipients } from "../alerts/coach-chat-flags";
import { supabaseNotificationStore, type NotificationStore } from "../notifications/store";

type Row = Record<string, unknown>;
const enc = encodeURIComponent;

export { DIET_PATIENT_KINDS, DIET_STAFF_KINDS, isDietPatientKind, isDietStaffKind, type DietPatientKind, type DietStaffKind } from "./push-kinds";
import { DIET_PATIENT_ROW_COPY, DIET_STAFF_ROW_COPY, type DietPatientKind, type DietStaffKind } from "./push-kinds";

const DIET_ALERT_TTL_MS = 36 * 60 * 60_000;

function ok(result: { status: number }, label: string) {
  if (result.status >= 300) throw new Error(`${label} failed (${result.status})`);
}
export function localDate(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface NotifyCareTeamInput {
  patientId: string;
  providerId: string | null | undefined;
  kind: DietStaffKind;
  /** Record ids the alert points at (selection, block, preference item). Ids only. */
  refs?: { selectionId?: string | null; blockId?: string | null; itemId?: string | null };
  now?: Date;
}
export type NotifyCareTeamResult =
  | { outcome: "skipped_no_office" }
  | { outcome: "skipped_office_inactive" }
  | { outcome: "queued"; deliveriesQueued: number };

/**
 * One push per recipient per office-local day per kind (dedupe key), so a
 * patient who changes their diet three times in an afternoon wakes the office
 * once. Later events of a different kind still land.
 */
export async function notifyCareTeam(input: NotifyCareTeamInput): Promise<NotifyCareTeamResult> {
  if (!input.providerId) return { outcome: "skipped_no_office" };
  const now = input.now ?? new Date();
  const providerResult = await supabaseAdmin("GET", `/rest/v1/providers?provider_id=eq.${enc(input.providerId)}&select=provider_id,provider_name,email,auth_user_id,access_disabled,offboarding_status&limit=1`);
  ok(providerResult, "diet alert provider read");
  const provider = (Array.isArray(providerResult.json) ? providerResult.json[0] : null) as Row | null;
  if (!provider || !officeIsActive(provider)) return { outcome: "skipped_office_inactive" };

  const [overrides, org] = await Promise.all([loadOfficeOverrides(input.providerId), loadOrgPolicy()]);
  const recipients = await loadOfficeAlertRecipients(input.providerId, provider, overrides);
  const zone = overrides.alertTimeZone ?? org.defaultTimezone;
  const day = localDate(now, zone);
  const expires = new Date(now.getTime() + DIET_ALERT_TTL_MS).toISOString();
  const officeName = String(provider.provider_name ?? "Your office");
  const copy = DIET_STAFF_ROW_COPY[input.kind];
  const rows = recipients.map((recipient) => ({
    provider_id: input.providerId, auth_user_id: recipient.authUserId, channel: "push", email: null,
    kind: input.kind, category: "staff_alerts", title: copy.title, body: copy.body,
    data: {
      patientId: input.patientId, providerId: input.providerId, officeName, recipientName: recipient.name, day,
      selectionId: input.refs?.selectionId ?? null, blockId: input.refs?.blockId ?? null, itemId: input.refs?.itemId ?? null,
    },
    dedupe_key: `${input.kind}:${input.providerId}:${input.patientId}:${day}:${recipient.authUserId}:push`,
    scheduled_at: now.toISOString(), next_attempt_at: now.toISOString(), expires_at: expires,
  }));
  if (!rows.length) return { outcome: "queued", deliveriesQueued: 0 };
  const queued = await supabaseAdmin("POST", "/rest/v1/staff_notifications?on_conflict=dedupe_key", rows, "resolution=ignore-duplicates,return=representation");
  ok(queued, "diet alert enqueue");
  return { outcome: "queued", deliveriesQueued: Array.isArray(queued.json) ? queued.json.length : 0 };
}

export interface NotifyPatientInput {
  patientId: string;
  kind: DietPatientKind;
  /** The patient-local day, for the dedupe key. */
  dayKey: string;
  now?: Date;
  store?: NotificationStore;
}

/** One patient notice per day per kind. Returns whether a new row was created. */
export async function notifyPatient(input: NotifyPatientInput): Promise<{ created: boolean }> {
  const now = input.now ?? new Date();
  const copy = DIET_PATIENT_ROW_COPY[input.kind];
  const store = input.store ?? supabaseNotificationStore;
  const result = await store.enqueue({
    patientId: input.patientId,
    kind: input.kind,
    category: copy.category,
    title: copy.title,
    body: copy.body,
    // Taps land on the app's Food preferences page (diet + lists + notices).
    data: { patientId: input.patientId, route: "/food-preferences", day: input.dayKey },
    dedupeKey: `${input.kind}:${input.patientId}:${input.dayKey}`,
    scheduledAt: now,
    expiresAt: new Date(now.getTime() + DIET_ALERT_TTL_MS),
  });
  return { created: result.created };
}
