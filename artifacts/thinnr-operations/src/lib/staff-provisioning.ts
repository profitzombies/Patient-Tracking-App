/**
 * Client for the API server's staff-provisioning route.
 *
 * Creating a real office sign-in is a privileged, service-role operation, so
 * it lives on the API server; the browser only sends the form fields over
 * the caller's existing Supabase HQ-admin session (bearer token). The path
 * is root-relative — the operations app is the ROOT artifact and the API
 * server is mounted at /api on the same domain, in dev and published alike.
 *
 * Sign-ins are passwordless: the server files the staff member under the
 * office and emails them an invitation; they sign in with a one-time email
 * code, so no credential ever rides this request.
 */
import { supabase } from '@/lib/supabase';

export type StaffFormField = 'accountId' | 'firstName' | 'lastName' | 'email';

const FIELDS: readonly StaffFormField[] = ['accountId', 'firstName', 'lastName', 'email'];

export class StaffProvisioningError extends Error {
  status: number;
  /** The form field the server blamed, when it named one. */
  field: StaffFormField | null;

  constructor(message: string, status: number, field: StaffFormField | null = null) {
    super(message);
    this.name = 'StaffProvisioningError';
    this.status = status;
    this.field = field;
  }
}

export interface NewStaffLogin {
  firstName: string;
  lastName: string;
  email: string;
}

export interface ProvisionedStaff {
  id: string;
  name: string;
  email: string;
  accountId: string;
  status: 'invited';
}

export async function provisionStaffLogin(
  accountId: string,
  input: NewStaffLogin,
): Promise<ProvisionedStaff> {
  if (!supabase) {
    throw new StaffProvisioningError('Real sign-ins aren\u2019t configured in this environment.', 401);
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new StaffProvisioningError('Sign in with a THINNR HQ account to create staff sign-ins.', 401);
  }

  let response: Response;
  try {
    response = await fetch('/api/staff-logins', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ accountId, ...input }),
    });
  } catch {
    throw new StaffProvisioningError(
      'Could not reach the server — check your connection and try again.',
      0,
    );
  }

  interface StaffLoginsResponse {
    error?: unknown;
    field?: unknown;
    staff?: ProvisionedStaff;
  }
  let body: StaffLoginsResponse | null = null;
  try {
    body = (await response.json()) as StaffLoginsResponse | null;
  } catch {
    /* non-JSON body — fall through to the generic message */
  }

  if (!response.ok) {
    const message =
      typeof body?.error === 'string' && body.error
        ? body.error
        : `The request failed (${response.status}) — try again.`;
    const field = FIELDS.includes(body?.field as StaffFormField)
      ? (body?.field as StaffFormField)
      : null;
    throw new StaffProvisioningError(message, response.status, field);
  }
  if (!body?.staff) {
    throw new StaffProvisioningError('The server returned an unexpected response.', 500);
  }
  return body.staff;
}
