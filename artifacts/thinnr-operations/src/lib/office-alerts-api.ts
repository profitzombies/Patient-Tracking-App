import { officeQuery, officeRequest, type OfficeRequestMessages } from '@/lib/office-api';

export type AttentionReasonCode =
  | 'no_weight'
  | 'no_meals'
  | 'no_water'
  | 'no_medication_doses'
  | 'weight_stalled'
  | 'check_in_overdue'
  | 'no_activity_14d';

export interface AttentionReason {
  code: AttentionReasonCode;
  label: string;
  days: number | null;
}

export interface AttentionItem {
  patientId: string;
  name: string;
  reasons: AttentionReason[];
  signature: string;
  seen?: boolean;
}

export interface OfficeAlerts {
  asOf: string;
  count: number;
  total: number;
  items: Array<AttentionItem & { seen: boolean }>;
}

export interface AttentionDigest {
  digestDate: string;
  generatedAt: string;
  timeZone: string;
  flaggedCount: number;
  items: AttentionItem[];
}

export interface OfficeAlertDigests {
  dates: string[];
  digest: AttentionDigest | null;
  latestDate: string | null;
}

export type AlertRecipientMode = 'all' | 'owners_admins' | 'selected';
export interface OfficeAlertSettings {
  recipientMode: AlertRecipientMode;
  recipientMemberIds: string[];
  sendTime: string;
  timeZone: string;
  timeZoneSource: 'office' | 'hq';
  version: number;
  canEdit: boolean;
  me: { emailEnabled: boolean; pushEnabled: boolean; email: string | null };
  team: Array<{ id: string; name: string; role: string; status: string }>;
}

export type ChatFlagCategory = 'severe_symptoms' | 'medication_problem' | 'pregnancy' | 'self_harm' | 'eating_disorder';
export interface OfficeChatFlag {
  id: string;
  patientId: string;
  patientName: string;
  conversationId: string | null;
  category: ChatFlagCategory;
  categoryLabel: string;
  reason: string;
  messageExcerpt: string;
  status: 'open' | 'reviewed';
  createdAt: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
}
export interface OfficeChatFlags {
  openCount: number;
  items: OfficeChatFlag[];
}

export interface StaffAlertDelivery {
  id: string;
  providerId: string;
  officeName: string;
  channel: string;
  recipientEmail: string | null;
  status: string;
  suppressionReason: string | null;
  suppressionDetail: string | null;
  lastError: string | null;
  digestDate: string;
  flaggedCount: number;
  scheduledAt: string;
  sentAt: string | null;
  finalizedAt: string | null;
}

const MESSAGES: OfficeRequestMessages = {
  unconfigured: 'Patient alerts are not configured in this environment.',
  signedOut: 'Your session has ended. Sign in again to continue.',
  unreachable: 'Could not reach patient alerts. Check your connection and try again.',
  failed: 'The patient alerts request failed',
};

export const officeAlertsQueryKey = (office?: string | null) => ['office-alerts', office ?? 'own-office'] as const;
export const officeAlertDigestsQueryKey = (office?: string | null) => ['office-alert-digests', office ?? 'own-office'] as const;
export const officeAlertSettingsQueryKey = (office?: string | null) => ['office-alert-settings', office ?? 'own-office'] as const;
export const officeChatFlagsQueryKey = (office?: string | null) => ['office-chat-flags', office ?? 'own-office'] as const;

export const fetchOfficeAlerts = (office?: string | null) =>
  officeRequest<OfficeAlerts>(`/api/office/alerts${officeQuery(office)}`, MESSAGES);

export const markOfficeAlertSeen = (patientId: string, signature: string, office?: string | null) =>
  officeRequest<{ ok: true; count: number }>(
    `/api/office/alerts/${encodeURIComponent(patientId)}/seen${officeQuery(office)}`,
    MESSAGES,
    { method: 'POST', body: JSON.stringify({ signature }) },
  );

export const fetchOfficeAlertDigests = (date?: string | null, office?: string | null) => {
  const extra = new URLSearchParams();
  if (date) extra.set('date', date);
  return officeRequest<OfficeAlertDigests>(`/api/office/alerts/digests${officeQuery(office, extra)}`, MESSAGES);
};

export const fetchOfficeAlertSettings = (office?: string | null) =>
  officeRequest<OfficeAlertSettings>(`/api/office/alerts/settings${officeQuery(office)}`, MESSAGES);

export const updateOfficeAlertSettings = (
  body: Pick<OfficeAlertSettings, 'recipientMode' | 'recipientMemberIds' | 'sendTime'> & { expectedVersion: number; timeZone: string | null },
  office?: string | null,
) => officeRequest<OfficeAlertSettings>(`/api/office/alerts/settings${officeQuery(office)}`, MESSAGES, {
  method: 'PUT',
  body: JSON.stringify(body),
});

export const updateOfficeAlertPreferences = (body: { emailEnabled: boolean; pushEnabled: boolean }, office?: string | null) =>
  officeRequest<{ emailEnabled: boolean; pushEnabled: boolean }>(
    `/api/office/alerts/preferences${officeQuery(office)}`,
    MESSAGES,
    { method: 'PUT', body: JSON.stringify(body) },
  );

export const fetchOfficeChatFlags = (office?: string | null) => {
  const extra = new URLSearchParams({ status: 'all' });
  return officeRequest<OfficeChatFlags>(`/api/office/alerts/chat-flags${officeQuery(office, extra)}`, MESSAGES);
};

export const markOfficeChatFlagReviewed = (flagId: string, office?: string | null) =>
  officeRequest<OfficeChatFlag>(
    `/api/office/alerts/chat-flags/${encodeURIComponent(flagId)}/reviewed${officeQuery(office)}`,
    MESSAGES,
    { method: 'POST' },
  );

export const fetchStaffAlertDeliveries = (limit = 50) =>
  officeRequest<{ items: StaffAlertDelivery[] }>(`/api/hq/staff-alerts/deliveries?limit=${limit}`, MESSAGES);