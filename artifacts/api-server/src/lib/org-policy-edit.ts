/**
 * Editing helpers for the organization policy: merge a partial PUT body onto
 * the current policy with server-side validation, diff two policies into
 * field-level audit changes, and shape the settings DTO.
 */
import type { UpdateHqSettingsBody } from "@workspace/api-zod";
import type { z } from "zod";
import { COLD_ARCHIVE_NOT_CONFIGURED, coldArchiveConfigured } from "./cold-archive";
import { supabaseAdmin } from "./supabase-admin";
import {
  ACCESS_DISCLOSURE_BOUNDS,
  APP_STORE_URL_RE,
  CLOCK_RE,
  EMAIL_RE,
  FIELD_SECTIONS,
  GOOGLE_PLAY_URL_RE,
  POLICY_BOUNDS,
  STORE_URL_MAX,
  policyFromRow,
  sectionChangesFromRow,
  type OrgPolicy,
  type PolicyField,
  type PolicySection,
  type QuietHoursWindow,
} from "./org-policy";

export const INVALID_SETTINGS = "Check the organization settings.";
type SettingsInput = z.infer<typeof UpdateHqSettingsBody>;

export function validHqTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function cleanEmail(value: string | null | undefined): { ok: true; value: string | null } | { ok: false } {
  const trimmed = value?.trim().toLowerCase() || null;
  if (trimmed && (!EMAIL_RE.test(trimmed) || trimmed.length > 320)) return { ok: false };
  return { ok: true, value: trimmed };
}

export function cleanQuietHours(value: QuietHoursWindow | null | undefined): { ok: true; value: QuietHoursWindow | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  const start = value.start.trim();
  const end = value.end.trim();
  if (!CLOCK_RE.test(start) || !CLOCK_RE.test(end) || start === end) return { ok: false };
  return { ok: true, value: { start, end } };
}

/**
 * A store listing link: blank → null; otherwise it must parse as an https
 * URL on the matching storefront host. Trailing whitespace is trimmed, the
 * rest is kept verbatim (query strings carry the listing id on Play).
 */
export function cleanStoreUrl(
  value: string | null | undefined,
  store: "appStore" | "googlePlay",
): { ok: true; value: string | null } | { ok: false } {
  const trimmed = value?.trim() || null;
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > STORE_URL_MAX || /\s/.test(trimmed)) return { ok: false };
  try {
    new URL(trimmed);
  } catch {
    return { ok: false };
  }
  const pattern = store === "appStore" ? APP_STORE_URL_RE : GOOGLE_PLAY_URL_RE;
  return pattern.test(trimmed) ? { ok: true, value: trimmed } : { ok: false };
}

function boundedInt(value: number, bounds: { min: number; max: number }): number | null {
  return Number.isInteger(value) && value >= bounds.min && value <= bounds.max ? value : null;
}

/**
 * Applies a partial input to the current policy. Every provided field is
 * validated against the same bounds the schema enforces; integers must be
 * whole (the wire type is number). Returns the merged policy or the first
 * validation failure.
 */
export function mergePolicyInput(
  current: OrgPolicy,
  input: SettingsInput,
  options: { coldArchiveConfigured?: boolean } = {},
): { ok: true; policy: OrgPolicy } | { ok: false; error: string } {
  const next: OrgPolicy = {
    ...current,
    defaultCategories: { ...current.defaultCategories },
    retention: { ...current.retention },
    secondFactor: { ...current.secondFactor },
    accessBilling: { ...current.accessBilling },
  };
  const fail = (error = INVALID_SETTINGS) => ({ ok: false as const, error });

  if (input.organizationName !== undefined) {
    const name = input.organizationName.trim();
    if (!name || name.length > 160) return fail();
    next.organizationName = name;
  }
  if (input.supportEmail !== undefined) {
    const email = cleanEmail(input.supportEmail);
    if (!email.ok) return fail("Check the support email address.");
    next.supportEmail = email.value;
  }
  if (input.supportPhone !== undefined) {
    const phone = input.supportPhone?.trim() || null;
    if (phone && !/^[+()0-9 .-]{7,40}$/.test(phone)) return fail("Check the support phone number.");
    next.supportPhone = phone;
  }
  if (input.defaultTimezone !== undefined) {
    const tz = input.defaultTimezone.trim();
    if (!validHqTimezone(tz)) return fail("Check the default timezone.");
    next.defaultTimezone = tz;
  }
  if (input.appStoreUrl !== undefined) {
    const url = cleanStoreUrl(input.appStoreUrl, "appStore");
    if (!url.ok) return fail("The App Store link must be an https://apps.apple.com/… listing URL or an https://testflight.apple.com/join/… TestFlight link.");
    next.appStoreUrl = url.value;
  }
  if (input.googlePlayUrl !== undefined) {
    const url = cleanStoreUrl(input.googlePlayUrl, "googlePlay");
    if (!url.ok) return fail("The Google Play link must be an https://play.google.com/store/apps/details?id=… listing URL or a https://play.google.com/apps/internaltest/… or /apps/testing/… testing link.");
    next.googlePlayUrl = url.value;
  }
  if (input.coachAvailable !== undefined) next.coachAvailable = input.coachAvailable;
  if (input.secondFactor !== undefined) next.secondFactor = { ...input.secondFactor };
  if (input.escalationEmail !== undefined) {
    const email = cleanEmail(input.escalationEmail);
    if (!email.ok) return fail("Check the escalation email address.");
    next.escalationEmail = email.value;
  }
  if (input.defaultCategories !== undefined) next.defaultCategories = { ...input.defaultCategories };
  if (input.accessBilling?.disclosureText !== undefined) {
    const disclosure = input.accessBilling.disclosureText.trim();
    if (disclosure.length < ACCESS_DISCLOSURE_BOUNDS.min || disclosure.length > ACCESS_DISCLOSURE_BOUNDS.max) {
      return fail(`The access disclosure must be between ${ACCESS_DISCLOSURE_BOUNDS.min} and ${ACCESS_DISCLOSURE_BOUNDS.max} characters.`);
    }
    next.accessBilling.disclosureText = disclosure;
  }
  if (input.coldArchiveEnabled !== undefined) {
    // Turning the archive on needs somewhere to write: the storage prefix is
    // an environment knob, so the toggle refuses until it is set. Turning it
    // off is always allowed.
    const configured = options.coldArchiveConfigured ?? coldArchiveConfigured();
    if (input.coldArchiveEnabled && !configured) return fail(COLD_ARCHIVE_NOT_CONFIGURED);
    next.coldArchiveEnabled = input.coldArchiveEnabled;
  }
  if (input.defaultQuietHours !== undefined) {
    const quiet = cleanQuietHours(input.defaultQuietHours);
    if (!quiet.ok) return fail("Quiet hours need a start and end time (HH:MM) that differ.");
    next.defaultQuietHours = quiet.value;
  }
  const ints: Array<[keyof typeof POLICY_BOUNDS, number | undefined, (v: number) => void, string]> = [
    ["outreachCooldownDays", input.outreachCooldownDays, v => { next.outreachCooldownDays = v; }, "Outreach cooldown"],
    ["outreachDailyCap", input.outreachDailyCap, v => { next.outreachDailyCap = v; }, "Daily send cap"],
    ["conversationAutoCloseDays", input.conversationAutoCloseDays, v => { next.conversationAutoCloseDays = v; }, "Conversation auto-close"],
    ["exportLinkHours", input.exportLinkHours, v => { next.exportLinkHours = v; }, "Export link lifetime"],
    ["chatTranscriptDays", input.retention?.chatTranscriptDays, v => { next.retention.chatTranscriptDays = v; }, "Chat transcript retention"],
    ["progressPhotoDays", input.retention?.progressPhotoDays, v => { next.retention.progressPhotoDays = v; }, "Progress photo retention"],
    ["notificationHistoryDays", input.retention?.notificationHistoryDays, v => { next.retention.notificationHistoryDays = v; }, "Notification history retention"],
    ["auditEventDays", input.retention?.auditEventDays, v => { next.retention.auditEventDays = v; }, "Audit event retention"],
    ["jobRunDays", input.retention?.jobRunDays, v => { next.retention.jobRunDays = v; }, "Job run history retention"],
    ["signInDays", input.retention?.signInDays, v => { next.retention.signInDays = v; }, "Sign-in history retention"],
    ["webhookEventDays", input.retention?.webhookEventDays, v => { next.retention.webhookEventDays = v; }, "Webhook event retention"],
    ["clinicalRecordDays", input.retention?.clinicalRecordDays, v => { next.retention.clinicalRecordDays = v; }, "Clinical record retention"],
    ["staffIdleTimeoutMinutes", input.staffIdleTimeoutMinutes, v => { next.staffIdleTimeoutMinutes = v; }, "Staff idle timeout"],
    ["hqIdleTimeoutMinutes", input.hqIdleTimeoutMinutes, v => { next.hqIdleTimeoutMinutes = v; }, "HQ idle timeout"],
    ["accessMonthlyPriceCents", input.accessBilling?.monthlyPriceCents, v => { next.accessBilling.monthlyPriceCents = v; }, "Monthly access price"],
    ["accessYearlyPriceCents", input.accessBilling?.yearlyPriceCents, v => { next.accessBilling.yearlyPriceCents = v; }, "Yearly access price"],
    ["accessIncludedPeriodDays", input.accessBilling?.includedPeriodDays, v => { next.accessBilling.includedPeriodDays = v; }, "Included access period"],
    ["accessGracePeriodDays", input.accessBilling?.gracePeriodDays, v => { next.accessBilling.gracePeriodDays = v; }, "Access grace period"],
    ["accessNormalSharePercent", input.accessBilling?.normalSharePercent, v => { next.accessBilling.normalSharePercent = v; }, "Standard revenue share"],
    ["accessRestrictedSharePercent", input.accessBilling?.restrictedSharePercent, v => { next.accessBilling.restrictedSharePercent = v; }, "Restricted revenue share"],
  ];
  for (const [key, value, set, label] of ints) {
    if (value === undefined) continue;
    const bounds = POLICY_BOUNDS[key];
    const clean = boundedInt(value, bounds);
    if (clean === null) return fail(`${label} must be a whole number between ${bounds.min} and ${bounds.max}.`);
    set(clean);
  }
  return { ok: true, policy: next };
}

export interface PolicyChange {
  field: PolicyField;
  section: PolicySection;
  from: string | number | boolean | null;
  to: string | number | boolean | null;
}

function auditValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

/** Field-level changes between two policies, in FIELD_SECTIONS order. */
export function diffPolicy(before: OrgPolicy, after: OrgPolicy): PolicyChange[] {
  const changes: PolicyChange[] = [];
  for (const field of Object.keys(FIELD_SECTIONS) as PolicyField[]) {
    const a = before[field];
    const b = after[field];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    changes.push({ field, section: FIELD_SECTIONS[field], from: auditValue(a), to: auditValue(b) });
  }
  return changes;
}

export function settingsDto(row: Record<string, unknown>) {
  return { ...policyFromRow(row), sections: sectionChangesFromRow(row) };
}

/** Display name for the HQ actor stamped onto section metadata (best effort). */
export async function hqActorName(userId: string): Promise<string | null> {
  try {
    const result = await supabaseAdmin(
      "GET",
      `/rest/v1/hq_memberships?auth_user_id=eq.${encodeURIComponent(userId)}&status=eq.active&select=display_name&limit=1`,
    );
    const row = Array.isArray(result.json) ? (result.json[0] as Record<string, unknown> | undefined) : undefined;
    return typeof row?.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : null;
  } catch {
    return null;
  }
}
