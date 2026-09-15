/**
 * Org-level settings groups for the HQ settings page.
 *
 * Pure mock: the definitions below are the defaults; the HQ session context
 * holds the editable values (per demo session, no server). Field ids are
 * stable keys — the context stores values as `${groupId}.${fieldId}`.
 */

export type HqSettingValue = string | boolean;

export interface HqSettingFieldBase {
  id: string;
  label: string;
  help: string;
}

export type HqSettingField =
  | (HqSettingFieldBase & { kind: 'text'; defaultValue: string; placeholder?: string })
  | (HqSettingFieldBase & { kind: 'toggle'; defaultValue: boolean })
  | (HqSettingFieldBase & { kind: 'select'; defaultValue: string; options: (string | { value: string; label: string })[] });

export interface HqSettingsGroup {
  id: string;
  title: string;
  description: string;
  fields: HqSettingField[];
}

/**
 * Seeded store links for the guided demo. Placeholder listings that are
 * shaped like the real thing so the office QR panel and the HQ settings
 * demo look complete; signed-in users always read the live HQ value instead.
 */
export const DEMO_APP_STORE_URL = 'https://apps.apple.com/us/app/thinnr/id6740000000';
export const DEMO_GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=com.thinnr.app';

export const HQ_SETTINGS_GROUPS: HqSettingsGroup[] = [
  {
    id: 'organization',
    title: 'Organization profile',
    description: 'How THINNR appears across HQ tools and provider-facing emails.',
    fields: [
      {
        id: 'org-name', kind: 'text', label: 'Organization name',
        defaultValue: 'THINNR, Inc.',
        help: 'Shown in report headers and provider onboarding material.',
      },
      {
        id: 'support-email', kind: 'text', label: 'Support email',
        defaultValue: 'support@thinnr.example.com',
        help: 'Where provider offices reach HQ. Demo address — nothing sends.',
      },
      {
        id: 'app-store-link', kind: 'text', label: 'App Store link',
        defaultValue: DEMO_APP_STORE_URL,
        placeholder: 'https://apps.apple.com/us/app/…',
        help: 'The iPhone listing every office’s “Get the app” QR code points at. Demo placeholder — not a real listing.',
      },
      {
        id: 'google-play-link', kind: 'text', label: 'Google Play link',
        defaultValue: DEMO_GOOGLE_PLAY_URL,
        placeholder: 'https://play.google.com/store/apps/details?id=…',
        help: 'The Android listing behind the second QR code. Demo placeholder — not a real listing.',
      },
      {
        id: 'reporting-tz', kind: 'select', label: 'Reporting timezone',
        defaultValue: 'America/Los_Angeles', options: [
          { value: 'America/New_York', label: 'Eastern (ET)' },
          { value: 'America/Chicago', label: 'Central (CT)' },
          { value: 'America/Denver', label: 'Mountain (MT)' },
          { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
          { value: 'UTC', label: 'UTC' }
        ],
        help: 'Display label for rollup reports. Demo data stays anchored to its fixed date either way.',
      },
    ],
  },
  {
    id: 'provider-accounts',
    title: 'Provider account defaults',
    description: 'Applied when a new sub-account is created from the accounts page.',
    fields: [
      {
        id: 'default-plan', kind: 'select', label: 'Default plan',
        defaultValue: 'Plus', options: ['Core', 'Plus', 'Concierge'],
        help: 'Pre-selected plan in the add-account form.',
      },
      {
        id: 'auto-approve', kind: 'toggle', label: 'Auto-approve new accounts',
        defaultValue: false,
        help: 'Off means new accounts start as Pending until HQ reviews them.',
      },
      {
        id: 'code-kit', kind: 'select', label: 'Provider code delivery',
        defaultValue: 'Front desk kit + email', options: ['Front desk kit + email', 'Email only'],
        help: 'How a new office receives the six-digit code patients type during onboarding.',
      },
    ],
  },
  {
    id: 'coach',
    title: 'Coach & mobile app',
    description: 'Org-wide switches for the patient-facing coach experience.',
    fields: [
      {
        id: 'coach-enabled', kind: 'toggle', label: 'Coach available to patients',
        defaultValue: true,
        help: 'Master switch for the in-app coach across every account.',
      },
      {
        id: 'quick-replies', kind: 'toggle', label: 'One-tap quick replies',
        defaultValue: true,
        help: 'Offer tappable answer chips under coach replies.',
      },
      {
        id: 'escalation-email', kind: 'text', label: 'Care-team escalation email',
        defaultValue: 'careteam@thinnr.example.com',
        help: 'Where flagged conversations are routed. Demo address — nothing sends.',
      },
    ],
  },
  {
    id: 'notifications',
    title: 'HQ notifications',
    description: 'What the HQ team hears about, and when.',
    fields: [
      {
        id: 'weekly-digest', kind: 'toggle', label: 'Weekly metrics digest',
        defaultValue: true,
        help: 'One email summarizing every account\u2019s week.',
      },
      {
        id: 'digest-day', kind: 'select', label: 'Digest day',
        defaultValue: 'Monday', options: ['Monday', 'Friday'],
        help: 'Which morning the digest goes out.',
      },
      {
        id: 'delivery-alerts', kind: 'toggle', label: 'Delivery issue alerts',
        defaultValue: true,
        help: 'Alert HQ when an account\u2019s shipments report problems.',
      },
    ],
  },
];

/** Flat default map — the shape the session context stores. */
export function defaultSettingsValues(): Record<string, HqSettingValue> {
  const values: Record<string, HqSettingValue> = {};
  for (const group of HQ_SETTINGS_GROUPS) {
    for (const field of group.fields) values[`${group.id}.${field.id}`] = field.defaultValue;
  }
  return values;
}
