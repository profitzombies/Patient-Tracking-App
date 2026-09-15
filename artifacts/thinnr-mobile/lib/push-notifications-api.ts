import { apiBase } from '@/lib/coach-api';
import { getSessionAccessToken } from '@/lib/patient-data-api';

const TIMEOUT_MS = 15_000;

interface PushNotificationsApiDependencies {
  getToken: () => Promise<string | null>;
  getBase: () => string;
  fetch: typeof fetch;
}

export function createPushNotificationsApi(dependencies: PushNotificationsApiDependencies) {
  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const token = await dependencies.getToken();
    if (!token) throw new Error('You’re signed out. Sign in again to manage notifications.');
    let base: string;
    try {
      base = dependencies.getBase();
    } catch {
      throw new Error('This build isn’t configured to reach the server.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await dependencies.fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const json = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) {
        throw new Error(typeof json?.error === 'string' ? json.error : 'The server couldn’t update notifications.');
      }
      return json;
    } catch (cause) {
      if (cause instanceof Error) throw cause;
      throw new Error('Couldn’t reach the server. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    registerPushDevice: (payload: { token: string; deviceId: string; platform: 'ios' | 'android' }) =>
      request('PUT', '/patient-notifications/device', payload),
    unregisterPushDevice: (payload: { deviceId: string; reason: 'signed_out' | 'account_switch' }) =>
      request('DELETE', '/patient-notifications/device', payload),
    registerStaffPushDevice: (payload: { token: string; deviceId: string; platform: 'ios' | 'android' }) =>
      request('PUT', '/staff-notifications/device', payload),
    unregisterStaffPushDevice: (payload: { deviceId?: string; reason?: 'signed_out' | 'account_switch' }) =>
      request('DELETE', '/staff-notifications/device', payload),
    fetchPushStatus: (deviceId: string) =>
      request('GET', `/patient-notifications/status?deviceId=${encodeURIComponent(deviceId)}`),
    markNotificationOpened: (notificationId: string) =>
      request('POST', `/patient-notifications/${encodeURIComponent(notificationId)}/opened`),
  };
}

const api = createPushNotificationsApi({
  getToken: getSessionAccessToken,
  getBase: apiBase,
  fetch: (...args) => fetch(...args),
});

const apiWithToken = (accessToken: string) => createPushNotificationsApi({
  getToken: async () => accessToken,
  getBase: apiBase,
  fetch: (...args) => fetch(...args),
});

export function registerPushDevice(
  payload: { token: string; deviceId: string; platform: 'ios' | 'android' },
  accessToken?: string,
) {
  return (accessToken ? apiWithToken(accessToken) : api).registerPushDevice(payload);
}
export function unregisterPushDevice(
  payload: { deviceId: string; reason: 'signed_out' | 'account_switch' },
  accessToken?: string,
) {
  return (accessToken ? apiWithToken(accessToken) : api).unregisterPushDevice(payload);
}
export function registerStaffPushDevice(
  payload: { token: string; deviceId: string; platform: 'ios' | 'android' },
  accessToken?: string,
) {
  return (accessToken ? apiWithToken(accessToken) : api).registerStaffPushDevice(payload);
}
export function unregisterStaffPushDevice(
  payload: { deviceId?: string; reason?: 'signed_out' | 'account_switch' },
  accessToken?: string,
) {
  return (accessToken ? apiWithToken(accessToken) : api).unregisterStaffPushDevice(payload);
}
export const fetchPushStatus = api.fetchPushStatus;
export const markNotificationOpened = api.markNotificationOpened;