/**
 * The guided demo's view of the HQ policy from an office's side.
 *
 * The demo's "HQ" is the seeded settings store; the office Settings page and
 * the Patients page "Get the app" panel both read these defaults so the
 * office and HQ demo personas agree. Nothing here persists.
 */
import type { HqOrganizationSettings, OfficeOverrides, OfficeSettings as OfficeSettingsDto } from '@workspace/api-client-react';
import { previewEffective } from '@/lib/org-policy';
import { defaultSettingsValues } from './settings';

export function demoOfficeSettings(): OfficeSettingsDto {
  const seeded = defaultSettingsValues();
  const hq: HqOrganizationSettings = {
    organizationName: String(seeded['organization.org-name']),
    supportEmail: String(seeded['organization.support-email']),
    supportPhone: null,
    defaultTimezone: String(seeded['organization.reporting-tz']),
    appStoreUrl: String(seeded['organization.app-store-link']) || null,
    googlePlayUrl: String(seeded['organization.google-play-link']) || null,
    coachAvailable: Boolean(seeded['coach.coach-enabled']),
    escalationEmail: String(seeded['coach.escalation-email']),
    defaultCategories: { coachOutreach: true, checkInReminders: true, officeReminders: true },
    defaultQuietHours: { start: '21:00', end: '08:00' },
    outreachCooldownDays: 14,
    outreachDailyCap: 500,
    conversationAutoCloseDays: 14,
    retention: { chatTranscriptDays: 730, progressPhotoDays: 730, notificationHistoryDays: 180, auditEventDays: 2555, jobRunDays: 90, signInDays: 180, webhookEventDays: 365, clinicalRecordDays: 2555 },
    exportLinkHours: 24,
    staffIdleTimeoutMinutes: 15,
    hqIdleTimeoutMinutes: 15,
    version: 1,
    updatedAt: '2026-09-01T16:00:00.000Z',
    sections: { organization: null, coach: null, notifications: null, conversations: null, retention: null, security: null },
  };
  const overrides: OfficeOverrides = { quietHours: { mode: 'inherit' }, escalationEmail: null, idleTimeoutMinutes: null, version: 0, updatedAt: null, updatedBy: null, updatedByName: null };
  return {
    office: { providerId: 'demo', officeName: 'Demo office' },
    hq,
    overrides,
    effective: previewEffective(hq, overrides),
    canEdit: true,
  };
}
