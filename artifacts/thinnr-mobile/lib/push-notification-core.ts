import type { AccountOperationEpoch } from './device-feature-core';

export type PushAvailability = 'web' | 'expo-go' | 'simulator' | 'unconfigured' | 'available';
export type PushPlatform = 'ios' | 'android';
export type PushPermission = 'granted' | 'denied' | 'undetermined';

export function pushAvailability(input: {
  platform: string;
  expoGo: boolean;
  isDevice: boolean;
  projectId: string | null | undefined;
}): PushAvailability {
  if (input.platform === 'web') return 'web';
  if (input.expoGo) return 'expo-go';
  if (!input.isDevice) return 'simulator';
  if (!input.projectId?.trim()) return 'unconfigured';
  return 'available';
}

const NOTIFICATION_ROUTES = new Set([
  '/care-team-chat',
  '/coach-chat',
  '/support-chat',
  '/(patient)/today',
  '/(patient)/progress',
  '/(patient)/diary',
  '/(patient)/plan',
  '/(patient)/recipes',
  '/today',
  '/progress',
  '/diary',
  '/plan',
  '/recipes',
  '/security',
  '/check-in',
  '/(tabs)/patients',
  '/orders',
  '/my-subscriptions',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Billing notices deep-link by kind + record id, never by the free-form
 * `route` string: a shipped order opens that order, a renewal reminder or a
 * failed renewal opens that subscription. Malformed ids fall through to the
 * static allow-list (which has no per-record routes), so a bad payload can
 * never steer the app to an arbitrary path.
 */
function billingRoute(value: Record<string, unknown>): string | null {
  if (!notificationPatientId(value)) return null;
  if (value.kind === 'order_shipped' && typeof value.orderId === 'string' && UUID.test(value.orderId)) {
    return `/orders/${value.orderId.toLowerCase()}`;
  }
  if (
    (value.kind === 'subscription_renewal_upcoming' || value.kind === 'subscription_payment_failed') &&
    typeof value.subscriptionId === 'string' && UUID.test(value.subscriptionId)
  ) {
    return `/my-subscriptions/${value.subscriptionId.toLowerCase()}`;
  }
  return null;
}

export function resolveNotificationRoute(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (value.kind === 'staff_attention_digest' || value.kind === 'coach_chat_flag') return '/(tabs)/patients';
  if (
    value.kind === 'care_team_reply' &&
    value.thread === 'care_team' &&
    notificationPatientId(value) &&
    typeof value.conversationId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value.conversationId)
  ) return `/care-team-chat?conversationId=${encodeURIComponent(value.conversationId)}`;
  const billing = billingRoute(value);
  if (billing) return billing;
  const route = value.route;
  return typeof route === 'string' && NOTIFICATION_ROUTES.has(route) ? route : null;
}

export function pushAccountIdFor(input: {
  mode: 'staff' | 'patient' | null;
  staffUserId: string | null;
  patientId: string | null;
}): string | null {
  if (input.mode === 'staff' && input.staffUserId) return `staff:${input.staffUserId}`;
  if (input.mode === 'patient' && input.patientId) return `patient:${input.patientId}`;
  return null;
}

/** Hidden notification ownership used before admitting account-scoped taps. */
export function notificationPatientId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const patientId = (data as Record<string, unknown>).patientId;
  return typeof patientId === 'string' && patientId.length > 0 ? patientId : null;
}

const PATIENT_OWNED_KINDS = new Set(['order_shipped', 'subscription_renewal_upcoming', 'subscription_payment_failed']);

/**
 * Care-team and billing notification actions fail closed unless the
 * outbox-bound patient is still the selected patient. Other historic
 * notification kinds retain their existing routing behavior.
 */
export function notificationAdmittedForPatient(data: unknown, activePatientId: string | null): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return true;
  const value = data as Record<string, unknown>;
  const careTeam = value.kind === 'care_team_reply' && value.thread === 'care_team';
  if (!careTeam && !(typeof value.kind === 'string' && PATIENT_OWNED_KINDS.has(value.kind))) return true;
  const owner = notificationPatientId(data);
  return owner !== null && activePatientId !== null && owner === activePatientId;
}

export interface PushRegistrationPayload {
  token: string;
  deviceId: string;
  platform: PushPlatform;
}

export interface PushRegistrationDriver {
  permission(): Promise<PushPermission>;
  requestPermission(): Promise<'granted' | 'denied'>;
  getToken(projectId: string): Promise<string>;
  register(payload: PushRegistrationPayload): Promise<unknown>;
  unregister(payload: { deviceId: string; reason: 'signed_out' | 'account_switch' }): Promise<unknown>;
}

export type PushRegistrationResult =
  | { status: 'registered'; token: string }
  | { status: 'denied' }
  | { status: 'unavailable'; reason: Exclude<PushAvailability, 'available'> }
  | { status: 'stale' };

export async function registerForPush(input: {
  accountId: string;
  epoch: AccountOperationEpoch;
  availability: PushAvailability;
  projectId: string | null | undefined;
  deviceId: string;
  platform: PushPlatform;
  driver: PushRegistrationDriver;
}): Promise<PushRegistrationResult> {
  if (input.availability !== 'available') {
    return { status: 'unavailable', reason: input.availability };
  }
  const operation = input.epoch.capture(input.accountId);
  let permission = await input.driver.permission();
  if (!input.epoch.isCurrent(operation)) return { status: 'stale' };
  if (permission !== 'granted') {
    permission = await input.driver.requestPermission();
    if (!input.epoch.isCurrent(operation)) return { status: 'stale' };
  }
  if (permission !== 'granted') return { status: 'denied' };
  const token = await input.driver.getToken(input.projectId!);
  if (!input.epoch.isCurrent(operation)) return { status: 'stale' };
  await input.driver.register({
    token,
    deviceId: input.deviceId,
    platform: input.platform,
  });
  if (!input.epoch.isCurrent(operation)) return { status: 'stale' };
  return { status: 'registered', token };
}

export async function unregisterPush(
  driver: PushRegistrationDriver,
  payload: { deviceId: string; reason: 'signed_out' | 'account_switch' },
): Promise<void> {
  await driver.unregister(payload);
}

export interface DeviceIdStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const DEVICE_ID_KEY = 'thinnr_push_install_id_v1';

export async function getOrCreateDeviceId(store: DeviceIdStore): Promise<string> {
  const existing = await store.get(DEVICE_ID_KEY);
  if (existing && /^[A-Za-z0-9._:-]{8,128}$/.test(existing)) return existing;
  let hex = '';
  while (hex.length < 24) hex += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  const generated = `inst-${hex.slice(0, 24)}`;
  await store.set(DEVICE_ID_KEY, generated);
  return generated;
}

export interface NotificationCategories {
  coachOutreach: boolean;
  checkInReminders: boolean;
  officeReminders: boolean;
}
export interface NotificationPreferences {
  categories: NotificationCategories;
  quietHours: { start: string; end: string } | null;
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function isValidQuietTime(value: string): boolean {
  return HH_MM.test(value);
}

export function parseNotificationPrefs(raw: unknown): NotificationPreferences {
  const prefs = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const categories = prefs.categories && typeof prefs.categories === 'object' && !Array.isArray(prefs.categories)
    ? prefs.categories as Record<string, unknown>
    : {};
  const quiet = prefs.quietHours && typeof prefs.quietHours === 'object' && !Array.isArray(prefs.quietHours)
    ? prefs.quietHours as Record<string, unknown>
    : null;
  const start = quiet?.start;
  const end = quiet?.end;
  return {
    categories: {
      coachOutreach: categories.coachOutreach !== false,
      checkInReminders: categories.checkInReminders !== false,
      officeReminders: categories.officeReminders !== false,
    },
    quietHours: typeof start === 'string' && typeof end === 'string' &&
      isValidQuietTime(start) && isValidQuietTime(end) && start !== end
      ? { start, end }
      : null,
  };
}

export function buildNotificationPrefsPatch(
  existingPrefs: unknown,
  changes: {
    categories?: Partial<NotificationCategories>;
    quietHours?: { start: string; end: string } | null;
  },
): Record<string, unknown> {
  const existing = existingPrefs && typeof existingPrefs === 'object' && !Array.isArray(existingPrefs)
    ? existingPrefs as Record<string, unknown>
    : {};
  const parsed = parseNotificationPrefs(existing);
  const categories = { ...parsed.categories, ...(changes.categories ?? {}) };
  const quietHours = changes.quietHours === undefined ? parsed.quietHours : changes.quietHours;
  if (quietHours && (
    !isValidQuietTime(quietHours.start) ||
    !isValidQuietTime(quietHours.end) ||
    quietHours.start === quietHours.end
  )) throw new Error('Quiet hours must use different 24-hour times in HH:MM format.');
  return { ...existing, categories, quietHours };
}