/**
 * Client for patient password + MFA, recovery, signup, and staff OTP routes.
 *
 * Both realms sign in the same way: ask for a one-time code, type it back,
 * and trade the server's reply for a real Supabase session. The server keeps
 * every response neutral about whether an account exists — these helpers
 * just surface its words, they never invent their own account hints.
 *
 * In dev delivery mode the server returns the code inline (`devCode`) so
 * nothing ever texts or emails a real address from a test run.
 */
import { apiBase } from '@/lib/coach-api';
import { describeAuthError, supabase } from '@/lib/supabase';

const NOT_CONFIGURED = 'Real sign-in isn’t configured in this environment.';
const NETWORK_ERROR = 'Could not reach the sign-in service. Check your connection and try again.';

export type CodeRequestResult =
  | { ok: true; requestId: string; message: string | null; devCode: string | null }
  | { ok: false; error: string };

export type LoginVerifyResult =
  | { ok: true; realm: 'staff' | 'patient'; tokenHash: string }
  | { ok: false; error: string };

export type OfficeLookupResult =
  | { ok: true; officeName: string }
  | { ok: false; error: string };

export type SignupVerifyResult =
  | { ok: true; mode: 'enroll'; signupToken: string }
  | { ok: false; error: string };

export type SignupCompleteResult =
  | { ok: true; tokenHash: string }
  | { ok: false; error: string; field: 'password' | 'name' | 'email' | null };

export type ResetVerifyResult =
  | { ok: true; resetToken: string }
  | { ok: false; error: string };

async function postJson(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null } | { failed: string }> {
  let base: string;
  try {
    base = apiBase();
  } catch {
    return { failed: NOT_CONFIGURED };
  }
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json: Record<string, unknown> | null = null;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  } catch {
    return { failed: NETWORK_ERROR };
  }
}

function errorFrom(json: Record<string, unknown> | null, fallback: string): string {
  return typeof json?.error === 'string' && json.error ? json.error : fallback;
}

/** Ask the server to send a one-time login code (text or email). */
export async function requestStaffLoginCode(identifier: string): Promise<CodeRequestResult> {
  const result = await postJson('/auth/login/start', { realm: 'staff', identifier });
  if ('failed' in result) return { ok: false, error: result.failed };
  const { status, json } = result;
  if (status !== 200 || typeof json?.requestId !== 'string') {
    return { ok: false, error: errorFrom(json, 'Could not send a code right now. Try again in a moment.') };
  }
  return {
    ok: true,
    requestId: json.requestId,
    message: typeof json.message === 'string' ? json.message : null,
    devCode: typeof json.devCode === 'string' ? json.devCode : null,
  };
}

/** Patient passwords are verified before the neutral MFA code is delivered. */
export async function requestPatientPasswordLogin(input: {
  identifier: string;
  password: string;
}): Promise<CodeRequestResult> {
  const result = await postJson('/auth/patient/password/login', input);
  if ('failed' in result) return { ok: false, error: result.failed };
  const { status, json } = result;
  if (status !== 200 || json?.ok !== true || typeof json.requestId !== 'string') {
    return { ok: false, error: errorFrom(json, 'Could not sign in right now. Try again in a moment.') };
  }
  return {
    ok: true, requestId: json.requestId,
    message: typeof json.message === 'string' ? json.message : null,
    devCode: typeof json.devCode === 'string' ? json.devCode : null,
  };
}

export async function startRecovery(identifier: string): Promise<CodeRequestResult> {
  const result = await postJson('/auth/patient/recovery/start', { identifier });
  if ('failed' in result) return { ok: false, error: result.failed };
  const { status, json } = result;
  if (status !== 200 || json?.ok !== true || typeof json.requestId !== 'string') {
    return { ok: false, error: errorFrom(json, 'Could not start password recovery right now.') };
  }
  return { ok: true, requestId: json.requestId, message: typeof json.message === 'string' ? json.message : null, devCode: typeof json.devCode === 'string' ? json.devCode : null };
}

export async function verifyRecovery(input: { requestId: string; code: string }): Promise<ResetVerifyResult> {
  const result = await postJson('/auth/patient/recovery/verify', input);
  if ('failed' in result) return { ok: false, error: result.failed };
  if (result.status !== 200 || typeof result.json?.resetToken !== 'string') {
    return { ok: false, error: errorFrom(result.json, 'That code didn’t work. Request a fresh one and try again.') };
  }
  return { ok: true, resetToken: result.json.resetToken };
}

export async function completeRecovery(input: { resetToken: string; password: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await postJson('/auth/patient/recovery/complete', input);
  if ('failed' in result) return { ok: false, error: result.failed };
  return result.status === 200 && result.json?.ok === true
    ? { ok: true }
    : { ok: false, error: errorFrom(result.json, 'Could not reset your password right now.') };
}

/** Trade a correct login code for a session token hash. */
export async function verifyLoginCode(input: {
  requestId: string;
  code: string;
}): Promise<LoginVerifyResult> {
  const result = await postJson('/auth/login/verify', input);
  if ('failed' in result) return { ok: false, error: result.failed };
  const { status, json } = result;
  if (status !== 200 || typeof json?.tokenHash !== 'string') {
    return {
      ok: false,
      error: errorFrom(json, 'That code didn’t work. Request a fresh one and try again.'),
    };
  }
  return {
    ok: true,
    realm: json.realm === 'staff' ? 'staff' : 'patient',
    tokenHash: json.tokenHash,
  };
}

/** Look up which office a provider code belongs to (codes are semi-public). */
export async function lookupSignupOffice(code: string): Promise<OfficeLookupResult> {
  const result = await postJson('/auth/signup/office', { code });
  if ('failed' in result) return { ok: false, error: result.failed };
  const { status, json } = result;
  if (status !== 200 || typeof json?.officeName !== 'string') {
    return {
      ok: false,
      error: errorFrom(json, 'That provider code didn’t match an active office. Double-check it with your provider.'),
    };
  }
  return { ok: true, officeName: json.officeName };
}

/** Start signup: sends a text code to the phone being claimed. */
export async function startSignup(input:
  | { flow: 'invited'; identifier: string }
  | { flow: 'new'; phone: string; email: string; code?: string }
): Promise<CodeRequestResult> {
  const result = await postJson('/auth/signup/start', input);
  if ('failed' in result) return { ok: false, error: result.failed };
  const { status, json } = result;
  if (status !== 200 || json?.ok !== true || typeof json?.requestId !== 'string') {
    return { ok: false, error: errorFrom(json, 'Could not send a code right now. Try again in a moment.') };
  }
  return {
    ok: true,
    requestId: json.requestId,
    message: typeof json.message === 'string' ? json.message : null,
    devCode: typeof json.devCode === 'string' ? json.devCode : null,
  };
}

/** Verify the signup code and receive the short-lived enrollment token. */
export async function verifySignupCode(input: {
  requestId: string;
  code: string;
}): Promise<SignupVerifyResult> {
  const result = await postJson('/auth/signup/verify', input);
  if ('failed' in result) return { ok: false, error: result.failed };
  const { status, json } = result;
  if (status === 200 && json?.mode === 'enroll' && typeof json.signupToken === 'string') {
    return { ok: true, mode: 'enroll', signupToken: json.signupToken };
  }
  return {
    ok: false,
    error: errorFrom(json, 'That code didn’t work. Request a fresh one and try again.'),
  };
}

/** Finish signup with a password; creates the real patient account. */
export async function completeSignup(input: {
  signupToken: string;
  password: string;
  name?: string;
  email?: string;
}): Promise<SignupCompleteResult> {
  const result = await postJson('/auth/signup/complete', input);
  if ('failed' in result) return { ok: false, error: result.failed, field: null };
  const { status, json } = result;
  if (status !== 200 || typeof json?.tokenHash !== 'string') {
    const field = json?.field === 'password' || json?.field === 'name' || json?.field === 'email'
      ? json.field
      : null;
    return {
      ok: false,
      error: errorFrom(json, 'Could not finish creating the account. Try again in a moment.'),
      field,
    };
  }
  return { ok: true, tokenHash: json.tokenHash };
}

/**
 * Turn a server-minted token hash into a live Supabase session on this
 * device. Mobile sessions persist in AsyncStorage until sign-out.
 */
export async function signInWithTokenHash(tokenHash: string): Promise<string | null> {
  if (!supabase) return NOT_CONFIGURED;
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
  return error ? describeAuthError(error) : null;
}
