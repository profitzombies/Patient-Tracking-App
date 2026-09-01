/**
 * Client for the office live roster + patient invitation endpoints
 * (/api/office/* on the API server). Staff accounts only — the demo persona
 * never touches these endpoints, and the office is ALWAYS derived from the
 * signed-in staff member's bearer token on the server; this client never
 * names one.
 *
 * Failures are explicit OfficeRosterErrors carrying the server's own words
 * (plus the field they belong to for form errors), never silent fallbacks.
 */
import { apiBase } from '@/lib/coach-api';
import { supabase } from '@/lib/supabase';

const NOT_CONFIGURED = 'Live rosters aren’t configured in this environment.';
const SIGNED_OUT = 'Sign in with your office account to manage patients.';
const NETWORK_ERROR = 'Couldn’t reach the roster service. Check your connection and try again.';

export class OfficeRosterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'OfficeRosterError';
  }
}

export interface OfficePatient {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  phoneDisplay: string | null;
  activationStatus: string | null;
  verified: boolean;
  createdAt: string | null;
  invitation: {
    state: 'pending' | 'verified';
    invitedAt: string;
    emailStatus: 'pending' | 'sent' | 'failed';
    emailUpdatedAt: string | null;
  } | null;
}

export interface OfficeRosterData {
  office: { providerId: string; officeName: string; providerCode: string };
  patients: OfficePatient[];
}

export interface InvitePatientInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export type InvitationEmailOutcome = 'sent' | 'failed' | 'not_configured';

async function bearerRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!supabase) throw new OfficeRosterError(NOT_CONFIGURED, 503);
  let base: string;
  try {
    base = apiBase();
  } catch {
    throw new OfficeRosterError(NOT_CONFIGURED, 503);
  }
  const { data } = await supabase.auth.getSession();
  let token = data.session?.access_token;
  if (!token) throw new OfficeRosterError(SIGNED_OUT, 401);

  const perform = async (accessToken: string) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let response: Response;
  try {
    response = await perform(token);
    if (response.status === 401) {
      const refreshed = await supabase.auth.refreshSession();
      const refreshedToken = refreshed.data.session?.access_token;
      if (refreshedToken) {
        token = refreshedToken;
        response = await perform(token);
      }
    }
  } catch {
    throw new OfficeRosterError(NETWORK_ERROR, 0);
  }
  let json: { error?: unknown; field?: unknown } & Partial<T> = {};
  try {
    json = (await response.json()) as typeof json;
  } catch {
    // Generic message below.
  }
  if (!response.ok) {
    throw new OfficeRosterError(
      typeof json.error === 'string' ? json.error : `The roster request failed (${response.status}).`,
      response.status,
      typeof json.field === 'string' ? json.field : null,
    );
  }
  return json as T;
}

export async function fetchOfficeRoster(): Promise<OfficeRosterData> {
  return bearerRequest<OfficeRosterData>('GET', '/office/roster');
}

export async function invitePatient(
  input: InvitePatientInput,
): Promise<{ patient: OfficePatient; invitation: InvitationEmailOutcome }> {
  return bearerRequest('POST', '/office/invitations', input);
}

export async function resendInvitation(
  patientId: string,
): Promise<{ ok: boolean; invitation: InvitationEmailOutcome; patient: OfficePatient }> {
  return bearerRequest('POST', `/office/invitations/${encodeURIComponent(patientId)}/resend`, {});
}

/**
 * Shared US phone formatting — the same 10-digit rule (optional leading 1)
 * the server enforces, rendered as (xxx) xxx-xxxx while typing. Mirrors the
 * desktop portal so both invite forms behave identically.
 */
export function formatUsPhoneInput(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (digits.length === 0) return '';
  if (digits.length < 4) return `(${digits}`;
  if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function usPhoneDigits(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Field-keyed validation shared with the desktop invite form; mirrors the API rules. */
export function validateInviteForm(
  input: InvitePatientInput,
): Partial<Record<keyof InvitePatientInput, string>> {
  const errors: Partial<Record<keyof InvitePatientInput, string>> = {};
  if (!input.firstName.trim()) errors.firstName = 'First name is required.';
  else if (input.firstName.trim().length > 80) errors.firstName = 'First name is too long.';
  if (!input.lastName.trim()) errors.lastName = 'Last name is required.';
  else if (input.lastName.trim().length > 80) errors.lastName = 'Last name is too long.';
  if (!input.email.trim()) errors.email = 'Email is required.';
  else if (!EMAIL_PATTERN.test(input.email.trim())) errors.email = 'Enter a valid email address.';
  if (!input.phone.trim()) errors.phone = 'Phone number is required.';
  else if (!usPhoneDigits(input.phone)) errors.phone = 'Enter a valid 10-digit US mobile number.';
  return errors;
}
