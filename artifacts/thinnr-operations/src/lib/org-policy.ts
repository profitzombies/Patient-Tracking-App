/**
 * Organization policy helpers shared by the HQ settings page and the office
 * Settings page.
 *
 * The server owns validation (bounds live in the API); this module only
 * carries the display vocabulary — how a quiet-hours window, a retention
 * period, or a "last changed" stamp reads on screen — plus the tiny bit of
 * client-side shaping the forms need (draft ↔ API payload). Bounds are
 * mirrored here for input `min`/`max` hints ONLY; a value outside them is
 * still sent and the server's error is what the user sees.
 */
import type {
  HqOrganizationSettings,
  OfficeEffectivePolicy,
  OfficeQuietHoursOverride,
  PolicySectionChange,
  QuietHoursWindow,
} from '@workspace/api-client-react';

export const POLICY_BOUNDS = {
  outreachCooldownDays: { min: 1, max: 90 },
  outreachDailyCap: { min: 1, max: 10000 },
  conversationAutoCloseDays: { min: 1, max: 365 },
  chatTranscriptDays: { min: 30, max: 3650 },
  progressPhotoDays: { min: 30, max: 3650 },
  notificationHistoryDays: { min: 7, max: 3650 },
  auditEventDays: { min: 365, max: 3650 },
  exportLinkHours: { min: 1, max: 168 },
} as const;

export type PolicySectionKey = keyof HqOrganizationSettings['sections'];

/** HH:MM (24h) → "9:00 PM" style label. */
export function formatClock(value: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return value;
  const hours = Number(match[1]);
  const minutes = match[2];
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${minutes} ${suffix}`;
}

/** "9:00 PM to 8:00 AM" or "No quiet hours". */
export function describeQuietHours(window: QuietHoursWindow | null | undefined): string {
  if (!window) return 'No quiet hours';
  return `${formatClock(window.start)} to ${formatClock(window.end)}`;
}

/** "730 days (2 years)" — whole-year rounding only when it is exact-ish. */
export function describeDays(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return `${days} days (${years} year${years === 1 ? '' : 's'})`;
  }
  if (days % 30 === 0 && days >= 60) {
    const months = days / 30;
    return `${days} days (about ${months} months)`;
  }
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function describeHours(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${hours} hours (${days} day${days === 1 ? '' : 's'})`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

const STAMP_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * "Last changed by Avery Admin · Sep 7, 2026, 3:40 PM". A section nobody has
 * touched since the policy contract shipped reads "Never changed"; a change
 * whose actor is unknown (service migration) still shows when.
 */
export function describeSectionChange(change: PolicySectionChange | null | undefined): string {
  if (!change) return 'Never changed';
  const when = STAMP_FORMAT.format(new Date(change.changedAt));
  return change.changedByName ? `Last changed by ${change.changedByName} · ${when}` : `Last changed ${when}`;
}

/** "Set by Nurse Kim · Sep 7, 2026, 3:40 PM" for the office override card. */
export function describeOverrideStamp(updatedAt: string | null, updatedByName: string | null): string | null {
  if (!updatedAt) return null;
  const when = STAMP_FORMAT.format(new Date(updatedAt));
  return updatedByName ? `Set by ${updatedByName} · ${when}` : `Set ${when}`;
}

/** Office-facing wording for where an effective value came from. */
export function describeSource(source: 'office' | 'hq'): string {
  return source === 'office' ? 'Office override' : 'HQ default';
}

/**
 * The office override control is a tri-state: follow HQ, no quiet hours, or
 * an office-specific window. The API speaks the same shape; this just fills
 * a sensible window when the user switches to "custom" so the time inputs
 * are never blank.
 */
export function quietHoursOverrideFor(
  mode: OfficeQuietHoursOverride['mode'],
  current: OfficeQuietHoursOverride,
  hqDefault: QuietHoursWindow | null,
): OfficeQuietHoursOverride {
  if (mode !== 'custom') return { mode };
  return {
    mode: 'custom',
    start: current.start ?? hqDefault?.start ?? '21:00',
    end: current.end ?? hqDefault?.end ?? '08:00',
  };
}

/** Same rule the server applies, so the page can preview before saving. */
export function previewEffective(
  hq: Pick<HqOrganizationSettings, 'defaultQuietHours' | 'escalationEmail'>,
  overrides: { quietHours: OfficeQuietHoursOverride; escalationEmail: string | null },
): OfficeEffectivePolicy {
  const quiet = overrides.quietHours;
  const quietHours =
    quiet.mode === 'inherit'
      ? hq.defaultQuietHours
      : quiet.mode === 'none'
        ? null
        : quiet.start && quiet.end
          ? { start: quiet.start, end: quiet.end }
          : hq.defaultQuietHours;
  const escalation = overrides.escalationEmail?.trim() || null;
  return {
    quietHours,
    escalationEmail: escalation ?? hq.escalationEmail,
    source: {
      quietHours: quiet.mode === 'inherit' ? 'hq' : 'office',
      escalationEmail: escalation ? 'office' : 'hq',
    },
  };
}

/** Message pulled out of an API error body, or a generic fallback. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
  return fallback;
}

export function apiErrorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}
