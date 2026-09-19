/**
 * Organization policy: the one authoritative, audited contract HQ sets and
 * the live systems obey (notification sender, staff inbox auto-close, coach
 * availability, retention jobs later). Backed by the hq_organization_settings
 * singleton plus per-office overrides in provider_policy_overrides
 * (supabase/migrations/20260928000000_organization_policies.sql).
 *
 * Consumers never read UI copy or env defaults for these values: they call
 * `loadOrgPolicy()` (cached briefly, last-known-good on outage) and, where an
 * office-local override applies, `effectivePolicyFor(...)`.
 */
import { supabaseAdmin } from "./supabase-admin";

export const POLICY_SECTIONS = ["organization", "coach", "notifications", "conversations", "retention", "security", "archive"] as const;

/** 6 years: HIPAA's minimum for compliance documentation and the audit trail. */
export const AUDIT_EVENT_RETENTION_FLOOR_DAYS = 2190;
/** 5 years: the shortest state medical-record window; default is 7 years. */
export const CLINICAL_RECORD_RETENTION_FLOOR_DAYS = 1825;
export type PolicySection = (typeof POLICY_SECTIONS)[number];

export interface QuietHoursWindow {
  start: string;
  end: string;
}

export interface CategoryDefaults {
  coachOutreach: boolean;
  checkInReminders: boolean;
  officeReminders: boolean;
}

export interface RetentionPolicy {
  chatTranscriptDays: number;
  progressPhotoDays: number;
  notificationHistoryDays: number;
  auditEventDays: number;
  /** System job run ledger (the latest 50 runs per job are always kept). */
  jobRunDays: number;
  /** Sign-in ledger rows (each account's latest active session is always kept). */
  signInDays: number;
  /** Processed Stripe webhook event rows (unprocessed or failed rows are always kept). */
  webhookEventDays: number;
  /**
   * How long a patient's clinical record is kept after the account is closed
   * or the office is offboarded. Nothing deletes on this timer here: the
   * closure and offboarding flows read it. Floor 5 years, ceiling 10.
   */
  clinicalRecordDays: number;
}

/**
 * Who must prove a phone (texted code) after the emailed sign-in code.
 * HQ users and office owners/admins default on; "all staff" extends the rule
 * to every office teammate. Any staff member may also opt in individually.
 */
export interface SecondFactorPolicy {
  hqUsers: boolean;
  officeManagers: boolean;
  allStaff: boolean;
}
export interface OrgPolicy {
  organizationName: string;

  supportEmail: string | null;

  supportPhone: string | null;

  defaultTimezone: string;
  /** App Store / Google Play listing links; offices render QR codes from these. */

  appStoreUrl: string | null;

  googlePlayUrl: string | null;

  coachAvailable: boolean;

  escalationEmail: string | null;

  defaultCategories: CategoryDefaults;

  defaultQuietHours: QuietHoursWindow | null;

  outreachCooldownDays: number;

  outreachDailyCap: number;

  conversationAutoCloseDays: number;

  retention: RetentionPolicy;

  exportLinkHours: number;
  /**
   * Minutes of no activity before the operations web app warns and then
   * signs a staffer out. Office owners may shorten the staff value for their
   * office (never lengthen); HQ members follow the HQ value.
   */

  staffIdleTimeoutMinutes: number;

  hqIdleTimeoutMinutes: number;
  /** Nightly cold archive of raw events and business rows to object storage (off by default; needs COLD_ARCHIVE_OBJECT_DIR). */

  coldArchiveEnabled: boolean;

  version: number;

  updatedAt: string;

  secondFactor: SecondFactorPolicy;
}

export interface SectionChange {
  changedAt: string;
  changedBy: string | null;
  changedByName: string | null;
}

export type SectionChanges = Record<PolicySection, SectionChange | null>;

/** Which policy field lives in which audited section. */
export const FIELD_SECTIONS = {
  organizationName: "organization",
  supportEmail: "organization",
  supportPhone: "organization",
  defaultTimezone: "organization",
  appStoreUrl: "organization",
  googlePlayUrl: "organization",
  coachAvailable: "coach",
  escalationEmail: "coach",
  defaultCategories: "notifications",
  defaultQuietHours: "notifications",
  outreachCooldownDays: "notifications",
  outreachDailyCap: "notifications",
  conversationAutoCloseDays: "conversations",
  retention: "retention",
  exportLinkHours: "retention",
  staffIdleTimeoutMinutes: "security",
  hqIdleTimeoutMinutes: "security",
  coldArchiveEnabled: "archive",
  secondFactor: "security",
} as const satisfies Record<Exclude<keyof OrgPolicy, "version" | "updatedAt">, PolicySection>;
export type PolicyField = keyof typeof FIELD_SECTIONS;

/**
 * Inclusive server-side bounds; the schema carries the same CHECKs.
 *
 * Two of these are compliance floors, not tuning ranges: audit events must be
 * kept at least 6 years (HIPAA's documentation retention minimum, 45 CFR
 * 164.316(b)(2)) and the clinical record at least 5 years (the shortest state
 * medical-record window served). Stored values below a floor are raised on
 * read (`policyFromRow`) so a legacy row can never shorten the window.
 */
export const POLICY_BOUNDS = {
  outreachCooldownDays: { min: 1, max: 90 },
  outreachDailyCap: { min: 1, max: 10000 },
  conversationAutoCloseDays: { min: 1, max: 365 },
  chatTranscriptDays: { min: 30, max: 3650 },
  progressPhotoDays: { min: 30, max: 3650 },
  notificationHistoryDays: { min: 7, max: 3650 },
  auditEventDays: { min: AUDIT_EVENT_RETENTION_FLOOR_DAYS, max: 3650 },
  jobRunDays: { min: 7, max: 3650 },
  signInDays: { min: 30, max: 3650 },
  webhookEventDays: { min: 30, max: 3650 },
  clinicalRecordDays: { min: CLINICAL_RECORD_RETENTION_FLOOR_DAYS, max: 3650 },
  exportLinkHours: { min: 1, max: 168 },
  staffIdleTimeoutMinutes: { min: 5, max: 120 },
  hqIdleTimeoutMinutes: { min: 5, max: 120 },
} as const;

/** Idle-timeout bounds shared by both HQ values and the office override. */
export const IDLE_TIMEOUT_BOUNDS = POLICY_BOUNDS.staffIdleTimeoutMinutes;
export const DEFAULT_ORG_POLICY: OrgPolicy = {
  organizationName: "THINNR",
  supportEmail: null,
  supportPhone: null,
  defaultTimezone: "America/New_York",
  appStoreUrl: null,
  googlePlayUrl: null,
  coachAvailable: true,
  escalationEmail: null,
  defaultCategories: { coachOutreach: true, checkInReminders: true, officeReminders: true },
  defaultQuietHours: null,
  outreachCooldownDays: 14,
  outreachDailyCap: 500,
  conversationAutoCloseDays: 14,
  retention: {
    chatTranscriptDays: 730,
    progressPhotoDays: 730,
    notificationHistoryDays: 180,
    auditEventDays: 2555,
    jobRunDays: 90,
    signInDays: 180,
    webhookEventDays: 365,
    clinicalRecordDays: 2555,
  },
  exportLinkHours: 24,
  staffIdleTimeoutMinutes: 15,
  hqIdleTimeoutMinutes: 15,
  coldArchiveEnabled: false,
  secondFactor: { hqUsers: true, officeManagers: true, allStaff: false },
  version: 1,
  updatedAt: "1970-01-01T00:00:00.000Z",
};

export const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Store listing links must point at the real storefronts (the DB CHECKs
 * mirror these): App Store pages live under apps.apple.com (legacy
 * itunes.apple.com), Play listings under play.google.com/store/apps/details.
 */
export const APP_STORE_URL_RE = /^https:\/\/(apps|itunes)\.apple\.com\//;
export const SETTINGS_SELECT =
  "organization_name,support_email,support_phone,default_timezone,app_store_url,google_play_url,updated_at,version,coach_available,escalation_email," +
  "default_coach_outreach,default_check_in_reminders,default_office_reminders,default_quiet_start,default_quiet_end," +
  "outreach_cooldown_days,outreach_daily_cap,conversation_auto_close_days,retention_chat_days,retention_photo_days," +
  "retention_notification_days,retention_audit_days,retention_job_run_days,retention_sign_in_days,retention_webhook_event_days," +
  "retention_clinical_record_days,export_link_hours,staff_idle_timeout_minutes,hq_idle_timeout_minutes,cold_archive_enabled," +
  "second_factor_hq_users,second_factor_office_managers,second_factor_all_staff,section_changes";

function int(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : fallback;
}
/** A compliance floor: a stored value below it reads as the floor itself. */
function floored(value: unknown, fallback: number, bounds: { min: number }): number {
  return Math.max(int(value, fallback), bounds.min);
}
function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
function quiet(start: unknown, end: unknown): QuietHoursWindow | null {
  return typeof start === "string" && typeof end === "string" && CLOCK_RE.test(start) && CLOCK_RE.test(end) && start !== end
    ? { start, end }
    : null;
}

export function policyFromRow(row: Record<string, unknown>): OrgPolicy {
  const d = DEFAULT_ORG_POLICY;
  return {
    organizationName: text(row.organization_name) ?? d.organizationName,
    supportEmail: text(row.support_email),
    supportPhone: text(row.support_phone),
    defaultTimezone: text(row.default_timezone) ?? d.defaultTimezone,
    appStoreUrl: text(row.app_store_url),
    googlePlayUrl: text(row.google_play_url),
    coachAvailable: row.coach_available !== false,
    escalationEmail: text(row.escalation_email),
    defaultCategories: {
      coachOutreach: row.default_coach_outreach !== false,
      checkInReminders: row.default_check_in_reminders !== false,
      officeReminders: row.default_office_reminders !== false,
    },
    defaultQuietHours: quiet(row.default_quiet_start, row.default_quiet_end),
    outreachCooldownDays: int(row.outreach_cooldown_days, d.outreachCooldownDays),
    outreachDailyCap: int(row.outreach_daily_cap, d.outreachDailyCap),
    conversationAutoCloseDays: int(row.conversation_auto_close_days, d.conversationAutoCloseDays),
    retention: {
      chatTranscriptDays: int(row.retention_chat_days, d.retention.chatTranscriptDays),
      progressPhotoDays: int(row.retention_photo_days, d.retention.progressPhotoDays),
      notificationHistoryDays: int(row.retention_notification_days, d.retention.notificationHistoryDays),
      auditEventDays: floored(row.retention_audit_days, d.retention.auditEventDays, POLICY_BOUNDS.auditEventDays),
      jobRunDays: int(row.retention_job_run_days, d.retention.jobRunDays),
      signInDays: int(row.retention_sign_in_days, d.retention.signInDays),
      webhookEventDays: int(row.retention_webhook_event_days, d.retention.webhookEventDays),
      clinicalRecordDays: floored(row.retention_clinical_record_days, d.retention.clinicalRecordDays, POLICY_BOUNDS.clinicalRecordDays),
    },
    exportLinkHours: int(row.export_link_hours, d.exportLinkHours),
    staffIdleTimeoutMinutes: int(row.staff_idle_timeout_minutes, d.staffIdleTimeoutMinutes),
    hqIdleTimeoutMinutes: int(row.hq_idle_timeout_minutes, d.hqIdleTimeoutMinutes),
    coldArchiveEnabled: row.cold_archive_enabled === true,
    secondFactor: {
      hqUsers: row.second_factor_hq_users !== false,
      officeManagers: row.second_factor_office_managers !== false,
      allStaff: row.second_factor_all_staff === true,
    },
    version: int(row.version, 1),
    updatedAt: text(row.updated_at) ?? d.updatedAt,
  };
}

export function sectionChangesFromRow(row: Record<string, unknown>): SectionChanges {
  const raw = row.section_changes && typeof row.section_changes === "object" && !Array.isArray(row.section_changes)
    ? (row.section_changes as Record<string, unknown>)
    : {};
  const out = {} as SectionChanges;
  for (const section of POLICY_SECTIONS) {
    const entry = raw[section];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      out[section] = typeof e.at === "string"
        ? { changedAt: e.at, changedBy: text(e.by), changedByName: text(e.name) }
        : null;
    } else {
      out[section] = null;
    }
  }
  return out;
}

/** The column payload for a policy (used by the PUT upsert). */
export function policyToColumns(policy: OrgPolicy): Record<string, unknown> {
  return {
    organization_name: policy.organizationName,
    support_email: policy.supportEmail,
    support_phone: policy.supportPhone,
    default_timezone: policy.defaultTimezone,
    app_store_url: policy.appStoreUrl,
    google_play_url: policy.googlePlayUrl,
    coach_available: policy.coachAvailable,
    escalation_email: policy.escalationEmail,
    default_coach_outreach: policy.defaultCategories.coachOutreach,
    default_check_in_reminders: policy.defaultCategories.checkInReminders,
    default_office_reminders: policy.defaultCategories.officeReminders,
    default_quiet_start: policy.defaultQuietHours?.start ?? null,
    default_quiet_end: policy.defaultQuietHours?.end ?? null,
    outreach_cooldown_days: policy.outreachCooldownDays,
    outreach_daily_cap: policy.outreachDailyCap,
    conversation_auto_close_days: policy.conversationAutoCloseDays,
    retention_chat_days: policy.retention.chatTranscriptDays,
    retention_photo_days: policy.retention.progressPhotoDays,
    retention_notification_days: policy.retention.notificationHistoryDays,
    retention_audit_days: policy.retention.auditEventDays,
    retention_job_run_days: policy.retention.jobRunDays,
    retention_sign_in_days: policy.retention.signInDays,
    retention_webhook_event_days: policy.retention.webhookEventDays,
    retention_clinical_record_days: policy.retention.clinicalRecordDays,
    export_link_hours: policy.exportLinkHours,
    staff_idle_timeout_minutes: policy.staffIdleTimeoutMinutes,
    hq_idle_timeout_minutes: policy.hqIdleTimeoutMinutes,
    cold_archive_enabled: policy.coldArchiveEnabled,
    second_factor_hq_users: policy.secondFactor.hqUsers,
    second_factor_office_managers: policy.secondFactor.officeManagers,
    second_factor_all_staff: policy.secondFactor.allStaff,
  };
}

// ── Office overrides ────────────────────────────────────────────────────────

export type QuietHoursOverride =
  | { mode: "inherit" }
  | { mode: "none" }
  | { mode: "custom"; start: string; end: string };

export interface OfficeOverrides {
  providerId: string;
  quietHours: QuietHoursOverride;
  escalationEmail: string | null;
  /** Office-shortened idle timeout in minutes; null = inherit the HQ staff value. */
  idleTimeoutMinutes: number | null;
  alertRecipientMode: "all" | "owners_admins" | "selected";
  alertRecipientMemberIds: string[];
  alertSendTime: string;
  alertTimeZone: string | null;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
}

export const NO_OVERRIDES = (providerId: string): OfficeOverrides => ({
  providerId,
  quietHours: { mode: "inherit" },
  escalationEmail: null,
  idleTimeoutMinutes: null,
  alertRecipientMode: "all",
  alertRecipientMemberIds: [],
  alertSendTime: "08:00",
  alertTimeZone: null,
  version: 0,
  updatedAt: null,
  updatedBy: null,
  updatedByName: null,
});

export const OVERRIDES_SELECT =
  "provider_id,version,quiet_hours_set,quiet_start,quiet_end,escalation_email,idle_timeout_minutes,alert_recipient_mode,alert_recipient_member_ids,alert_send_time,alert_time_zone,updated_at,updated_by,updated_by_name";

export function overridesFromRow(row: Record<string, unknown>): OfficeOverrides {
  const window = quiet(row.quiet_start, row.quiet_end);
  const quietHours: QuietHoursOverride =
    row.quiet_hours_set !== true ? { mode: "inherit" } : window ? { mode: "custom", ...window } : { mode: "none" };
  return {
    providerId: String(row.provider_id),
    quietHours,
    escalationEmail: text(row.escalation_email),
    idleTimeoutMinutes: Number.isInteger(row.idle_timeout_minutes) ? (row.idle_timeout_minutes as number) : null,
    alertRecipientMode:
      row.alert_recipient_mode === "owners_admins" || row.alert_recipient_mode === "selected"
        ? row.alert_recipient_mode
        : "all",
    alertRecipientMemberIds: Array.isArray(row.alert_recipient_member_ids)
      ? row.alert_recipient_member_ids.filter((id): id is string => typeof id === "string")
      : [],
    alertSendTime: typeof row.alert_send_time === "string" && CLOCK_RE.test(row.alert_send_time)
      ? row.alert_send_time
      : "08:00",
    alertTimeZone: text(row.alert_time_zone),
    version: int(row.version, 1),
    updatedAt: text(row.updated_at),
    updatedBy: text(row.updated_by),
    updatedByName: text(row.updated_by_name),
  };
}

export interface EffectiveOfficePolicy {
  quietHours: QuietHoursWindow | null;
  escalationEmail: string | null;
  /** Minutes before the idle warning for this office's staff (the shorter of HQ and office). */
  idleTimeoutMinutes: number;
  /** Whether each effective value came from the office override or HQ. */
  source: { quietHours: "office" | "hq"; escalationEmail: "office" | "hq"; idleTimeoutMinutes: "office" | "hq" };
}

/**
 * An office override can only ever shorten the HQ staff idle timeout. The
 * write path refuses longer values, and this read-side min() keeps that
 * true even after HQ lowers its value under an existing override.
 */
export function effectiveIdleTimeoutMinutes(org: OrgPolicy, overrides: OfficeOverrides | null): { minutes: number; source: "office" | "hq" } {
  const override = overrides?.idleTimeoutMinutes ?? null;
  if (override !== null && override < org.staffIdleTimeoutMinutes) return { minutes: override, source: "office" };
  return { minutes: org.staffIdleTimeoutMinutes, source: "hq" };
}
export function effectivePolicyFor(org: OrgPolicy, overrides: OfficeOverrides | null): EffectiveOfficePolicy {
  const q = overrides?.quietHours ?? { mode: "inherit" as const };
  const idle = effectiveIdleTimeoutMinutes(org, overrides);
  return {
    quietHours: q.mode === "inherit" ? org.defaultQuietHours : q.mode === "none" ? null : { start: q.start, end: q.end },
    escalationEmail: overrides?.escalationEmail ?? org.escalationEmail,
    idleTimeoutMinutes: idle.minutes,
    source: {
      quietHours: q.mode === "inherit" ? "hq" : "office",
      escalationEmail: overrides?.escalationEmail ? "office" : "hq",
      idleTimeoutMinutes: idle.source,
    },
  };
}

// ── Loading ─────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;
let cached: { policy: OrgPolicy; at: number } | null = null;

export function invalidateOrgPolicyCache(): void {
  cached = null;
}

/** Test seam: pre-fill the cache (also used by the PUT route after saving). */
export function primeOrgPolicyCache(policy: OrgPolicy): void {
  cached = { policy, at: Date.now() };
}

export async function readOrgSettingsRow(): Promise<Record<string, unknown>> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/hq_organization_settings?singleton=eq.true&select=${SETTINGS_SELECT}&limit=1`,
  );
  if (result.status >= 300 || !Array.isArray(result.json) || !result.json[0]) {
    throw new Error(`organization settings read failed (${result.status})`);
  }
  return result.json[0] as Record<string, unknown>;
}

/**
 * The current organization policy. Cached for a short window so hot paths
 * (every coach turn, every sender tick) do not each hit the database; a read
 * failure serves the last-known-good policy when there is one and throws
 * otherwise — callers decide whether that is fatal for them.
 */
export async function loadOrgPolicy(options: { fresh?: boolean } = {}): Promise<OrgPolicy> {
  const now = Date.now();
  if (!options.fresh && cached && now - cached.at < CACHE_TTL_MS) return cached.policy;
  try {
    const policy = policyFromRow(await readOrgSettingsRow());
    cached = { policy, at: now };
    return policy;
  } catch (error) {
    if (cached) return cached.policy;
    throw error;
  }
}

export async function loadOfficeOverrides(providerId: string): Promise<OfficeOverrides> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/provider_policy_overrides?provider_id=eq.${encodeURIComponent(providerId)}&select=${OVERRIDES_SELECT}&limit=1`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`office policy overrides read failed (${result.status})`);
  }
  const row = result.json[0] as Record<string, unknown> | undefined;
  return row ? overridesFromRow(row) : NO_OVERRIDES(providerId);
}

/** Every office override at once (the sender tick applies them per patient). */
export async function loadAllOfficeOverrides(): Promise<Map<string, OfficeOverrides>> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/provider_policy_overrides?select=${OVERRIDES_SELECT}&limit=5000`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`office policy overrides read failed (${result.status})`);
  }
  const map = new Map<string, OfficeOverrides>();
  for (const row of result.json as Record<string, unknown>[]) {
    const parsed = overridesFromRow(row);
    map.set(parsed.providerId, parsed);
  }
  return map;
}

export const GOOGLE_PLAY_URL_RE = /^https:\/\/play\.google\.com\/store\/apps\/details\?/;

export const STORE_URL_MAX = 500;
