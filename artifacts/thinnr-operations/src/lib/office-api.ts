/**
 * Shared bearer-authenticated fetch for the office self-service endpoints
 * (team, audit). Mirrors the roster client's contract: the signed-in
 * office's scope is server-derived; an HQ drill-in names the office it is
 * viewing with `?office=`; a 401 is retried once after a session refresh.
 */
import { supabase } from '@/lib/supabase';
import { ReauthRequiredError, withReauthRetry } from '@/lib/reauth';

export class OfficeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'OfficeApiError';
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }
}

export async function officeAuthToken(unconfigured: string, signedOut: string): Promise<string> {
  if (!supabase) throw new OfficeApiError(unconfigured, 503);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new OfficeApiError(signedOut, 401);
  return token;
}

export interface OfficeRequestMessages {
  unconfigured: string;
  signedOut: string;
  unreachable: string;
  failed: string;
}

export async function officeRequest<T>(path: string, messages: OfficeRequestMessages, init?: RequestInit): Promise<T> {
  let token = await officeAuthToken(messages.unconfigured, messages.signedOut);
  let response: Response;
  const perform = (accessToken: string) => fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });
  try {
    response = await withReauthRetry(() => perform(token));
    if (response.status === 401 && supabase) {
      const { data } = await supabase.auth.refreshSession();
      const refreshed = data.session?.access_token;
      if (refreshed) {
        token = refreshed;
        response = await withReauthRetry(() => perform(token));
      }
    }
  } catch (error) {
    if (error instanceof ReauthRequiredError) throw error;
    throw new OfficeApiError(messages.unreachable, 0);
  }
  let body: { error?: unknown; field?: unknown } & Partial<T> = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Generic message below.
  }
  if (!response.ok) {
    throw new OfficeApiError(
      typeof body.error === 'string' ? body.error : `${messages.failed} (${response.status}).`,
      response.status,
      typeof body.field === 'string' ? body.field : null,
    );
  }
  return body as T;
}

export function officeQuery(office?: string | null, extra?: URLSearchParams): string {
  const params = new URLSearchParams(extra);
  if (office) params.set('office', office);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export type SignInMethod = 'email_code' | 'email_sms_code' | 'sms_code' | 'password_sms_code' | 'password_email_code' | 'signup' | 'claim';
export type SecurityPlatform = 'ios' | 'android' | 'web' | 'unknown';
export type SecurityReason = 'lost_device' | 'suspicious_activity' | 'staff_request' | 'patient_request' | 'other';

export interface SecuritySignIn {
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

export interface SecuritySession {
  ref: string;
  createdAt: string;
  lastSeenAt: string;
  platform: SecurityPlatform;
  device: string;
  region: string | null;
  current: boolean;
  signInId: string | null;
}

export interface MySecurity {
  realm: 'patient' | 'staff';
  canChangePassword: boolean;
  contact: { phone: string | null; email: string | null };
  passwordChangedAt: string | null;
  currentSessionKnown: boolean;
  sessions: SecuritySession[];
  signIns: SecuritySignIn[];
  secondFactor: {
    policyRequired: boolean;
    enabled: boolean;
    phone: string | null;
    verifiedAt: string | null;
  } | null;
}

export interface ManagedSecurity {
  linked: boolean;
  sessions: SecuritySession[];
  signIns: SecuritySignIn[];
}

const SECURITY_MESSAGES: OfficeRequestMessages = {
  unconfigured: 'Account security is not configured in this environment.',
  signedOut: 'Your session has ended. Sign in again to continue.',
  unreachable: 'Could not reach account security. Check your connection and try again.',
  failed: 'The security request failed',
};

export const fetchMySecurity = () => officeRequest<MySecurity>('/api/security/me', SECURITY_MESSAGES);
export const signOutMyOtherSessions = () => officeRequest<{ ok: true }>('/api/security/me/sign-out-others', SECURITY_MESSAGES, { method: 'POST' });
export const reportMySignIn = (id: string) => officeRequest<{ ok: true; signedOut: true; forcedReset: boolean }>(
  `/api/security/me/sign-ins/${encodeURIComponent(id)}/report`,
  SECURITY_MESSAGES,
  { method: 'POST' },
);

export const startMySecondFactorPhone = (phone: string) => officeRequest<{
  ok: true; requestId: string; destination: string; devCode?: string | null;
}>('/api/security/me/second-factor/phone/start', SECURITY_MESSAGES, {
  method: 'POST',
  body: JSON.stringify({ phone }),
});
export const fetchOfficeTeamMemberSessions = (memberId: string) => officeRequest<ManagedSecurity & { member: unknown }>(
  `/api/office/team/${encodeURIComponent(memberId)}/sessions`,
  SECURITY_MESSAGES,
);
export const fetchHqTeamMemberSessions = (id: string) => officeRequest<ManagedSecurity>(
  `/api/hq-team/${encodeURIComponent(id)}/sessions`,
  SECURITY_MESSAGES,
);
export const signOutHqTeamMember = (id: string, reason?: Exclude<SecurityReason, 'patient_request'>) => officeRequest<{ ok: true; sessionInvalidation: string }>(
  `/api/hq-team/${encodeURIComponent(id)}/sign-out`,
  SECURITY_MESSAGES,
  { method: 'POST', body: JSON.stringify({ ...(reason ? { reason } : {}) }) },
);
export const fetchPatientSessions = (id: string, office: string) => officeRequest<ManagedSecurity>(
  `/api/office/patients/${encodeURIComponent(id)}/sessions${officeQuery(office)}`,
  SECURITY_MESSAGES,
);
export const signOutPatientSessions = (id: string, office: string, reason: Exclude<SecurityReason, 'staff_request'>) => officeRequest<{ ok: true; sessionInvalidation: string }>(
  `/api/office/patients/${encodeURIComponent(id)}/sign-out${officeQuery(office)}`,
  SECURITY_MESSAGES,
  { method: 'POST', body: JSON.stringify({ reason }) },
);

export async function submitSecurityReport(token: string): Promise<{ ok: true; signedOut: true; realm: 'patient' | 'staff'; forcedReset: boolean }> {
  let response: Response;
  try {
    response = await fetch('/api/security/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    throw new OfficeApiError('Could not reach account security. Check your connection and try again.', 0);
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) throw new OfficeApiError(typeof body?.error === 'string' ? body.error : `The security report failed (${response.status}).`, response.status);
  return body as unknown as { ok: true; signedOut: true; realm: 'patient' | 'staff'; forcedReset: boolean };
}

export const setMySecondFactorEnabled = (enabled: boolean) => officeRequest<{
  ok: true; secondFactor: NonNullable<MySecurity['secondFactor']>;
}>('/api/security/me/second-factor', SECURITY_MESSAGES, {
  method: 'POST',
  body: JSON.stringify({ enabled }),
});

export const completeMySecondFactorPhone = (requestId: string, code: string) => officeRequest<{
  ok: true; secondFactor: NonNullable<MySecurity['secondFactor']>;
}>('/api/security/me/second-factor/phone/complete', SECURITY_MESSAGES, {
  method: 'POST',
  body: JSON.stringify({ requestId, code }),
});
