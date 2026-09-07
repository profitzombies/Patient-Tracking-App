import { apiBase } from '@/lib/coach-api';
import { getSessionAccessToken } from '@/lib/patient-data-api';

const TIMEOUT_MS = 15_000;

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const token = await getSessionAccessToken();
  if (!token) throw new Error('You’re signed out. Sign in again to manage notifications.');
  let base: string;
  try {
    base = apiBase();
  } catch {
    throw new Error('This build isn’t configured to reach the server.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, {
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
}

export function registerPushDevice(payload: { token: string; deviceId: string; platform: 'ios' | 'android' }) {
  return request('PUT', '/patient-notifications/device', payload);
}
export function unregisterPushDevice(payload: { deviceId: string; reason: 'signed_out' | 'account_switch' }) {
  return request('DELETE', '/patient-notifications/device', payload);
}
export function fetchPushStatus(deviceId: string) {
  return request('GET', `/patient-notifications/status?deviceId=${encodeURIComponent(deviceId)}`);
}
export function markNotificationOpened(notificationId: string) {
  return request('POST', `/patient-notifications/${encodeURIComponent(notificationId)}/opened`);
}