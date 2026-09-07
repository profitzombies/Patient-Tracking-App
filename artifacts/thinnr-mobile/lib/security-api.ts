import { apiBase } from '@/lib/coach-api';
import { supabase } from '@/lib/supabase';

export type SignInMethod = 'email_code' | 'sms_code' | 'password_sms_code' | 'password_email_code' | 'signup' | 'claim';
export type SecurityPlatform = 'ios' | 'android' | 'web' | 'unknown';

export interface SignInDto {
  id: string;
  at: string;
  method: SignInMethod;
  methodLabel: string;
  platform: SecurityPlatform;
  device: string;
  region: string | null;
  newDevice: boolean;
  current: boolean;
  active: boolean;
  revokedAt: string | null;
  revokedReason: string | null;
  reportedAt: string | null;
}

export interface SessionDto {
  ref: string;
  createdAt: string;
  lastSeenAt: string;
  platform: SecurityPlatform;
  device: string;
  region: string | null;
  current: boolean;
  signInId: string | null;
}

export interface SecurityOverview {
  realm: 'patient' | 'staff';
  canChangePassword: boolean;
  contact: { phone: string | null; email: string | null };
  passwordChangedAt: string | null;
  currentSessionKnown: boolean;
  sessions: SessionDto[];
  signIns: SignInDto[];
}

export class SecurityApiError extends Error {
  constructor(message: string, readonly status: number, readonly field: string | null = null) {
    super(message);
    this.name = 'SecurityApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown, authenticated = true): Promise<T> {
  let base: string;
  try {
    base = apiBase();
  } catch {
    throw new SecurityApiError('This build isn’t configured to reach the server.', 0);
  }
  let token: string | undefined;
  if (authenticated) {
    token = (await supabase?.auth.getSession())?.data.session?.access_token ?? undefined;
    if (!token) throw new SecurityApiError('You’re signed out. Sign in again to manage account security.', 401);
  }
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new SecurityApiError('Couldn’t reach the server. Check your connection and try again.', 0);
  }
  let json: Record<string, unknown> | null = null;
  try {
    json = await response.json() as Record<string, unknown>;
  } catch {
    // The explicit malformed-response error below is more useful than a JSON exception.
  }
  if (!response.ok) {
    throw new SecurityApiError(
      typeof json?.error === 'string' ? json.error : 'The server couldn’t handle that. Please try again.',
      response.status,
      typeof json?.field === 'string' ? json.field : null,
    );
  }
  if (!json) throw new SecurityApiError('The server sent an unexpected response. Please try again.', response.status);
  return json as T;
}

export const fetchSecurityOverview = () => request<SecurityOverview>('GET', '/security/me');
export const attachSignIn = (signInId: string) =>
  request<{ ok: true; attached: boolean }>('POST', '/security/me/attach', { signInId });
export const signOutOtherSessions = () =>
  request<{ ok: true }>('POST', '/security/me/sign-out-others');
export const reportSignIn = (id: string) =>
  request<{ ok: true; signedOut: true; forcedReset: boolean }>('POST', `/security/me/sign-ins/${encodeURIComponent(id)}/report`);
export const reportSignInByToken = (token: string) =>
  request<{ ok: true; signedOut: true; realm: 'patient' | 'staff'; forcedReset: boolean }>('POST', '/security/report', { token }, false);
export const startPasswordChange = (currentPassword: string) =>
  request<{ ok: true; requestId: string; channel: 'sms' | 'email'; destination: string; devCode?: string }>(
    'POST', '/security/me/password/start', { currentPassword },
  );
export const completePasswordChange = (input: { requestId: string; code: string; newPassword: string }) =>
  request<{ ok: true; othersSignedOut: boolean }>('POST', '/security/me/password/complete', input);