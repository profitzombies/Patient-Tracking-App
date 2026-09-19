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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { getOrCreateDeviceId } from '@/lib/push-notification-core';

const NOT_CONFIGURED = 'Real sign-in isn’t configured in this environment.';
const NETWORK_ERROR = 'Could not reach the sign-in service. Check your connection and try again.';

export type CodeRequestResult =
  | { ok: true; requestId: string; message: string | null; devCode: string | null }
  | { ok: false; error: string; code?: string };

export type LoginVerifyResult =
  | { ok: true; realm: 'patient'; tokenHash: string; signInId: string | null }
  | { ok: true; realm: 'staff'; tokenHash: string; signInId: string | null }
  | {
      ok: true;
      realm: 'staff';
      secondFactor: {
        stepToken: string;
        mode: 'sms' | 'enroll';
        destination: string | null;
      };
    }
  | { ok: false; error: string; code?: string };

export type StaffPhoneStartResult =
  | {
      ok: true;
      mode: 'sms' | 'enroll';
      requestId: string;
      destination: string;
      devCode: string | null;
    }
  | { ok: false; error: string; expired?: true; retryable?: true };

export type StaffPhoneVerifyResult =
  | { ok: true; realm: 'staff'; tokenHash: string; signInId: string | null }
  | { ok: false; error: string; expired?: true };

export type OfficeLookupResult =
  | { ok: true; officeName: string }
  | { ok: false; error: string };

export type SignupVerifyResult =
  | { ok: true; mode: 'enroll'; signupToken: string }
  | { ok: false; error: string };

export type SignupCompleteResult =
  | { ok: true; tokenHash: string; signInId: string | null }
  | { ok: false; error: string; field: 'password' | 'name' | 'email' | null };

export type ResetVerifyResult =
  | { ok: true; resetToken: string }
  | { ok: false; error: string };

async function postJson(
  path: string,
  body: unknown,
  deviceHeaders = false,
): Promise<{ status: number; json: Record<string, unknown> | null } | { failed: string }> {
  let base: string;
  try {
    base = apiBase();
  } catch {
    return { failed: NOT_CONFIGURED };
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (deviceHeaders) {
      headers['x-thinnr-device'] = await getOrCreateDeviceId({
        get: key => AsyncStorage.getItem(key),
        set: (key, value) => AsyncStorage.setItem(key, value),
      });
      headers['x-thinnr-platform'] = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
    }
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
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
  const result = await postJson('/auth/patient/password/login', input, true);
  if ('failed' in result) return { ok: false, error: result.failed };
  const { status, json } = result;
  if (status !== 200 || json?.ok !== true || typeof json.requestId !== 'string') {
    return { ok: false, error: errorFrom(json, 'Could not sign in right now. Try again in a moment.'), ...(typeof json?.code === 'string' ? { code: json.code } : {}) };
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
  const result = await postJson('/auth/login/verify', input, true);
  if ('failed' in result) return { ok: false, error: result.failed };
  const { status, json } = result;
  const secondFactor = json?.secondFactor;
  if (
    status === 200
    && json?.realm === 'staff'
    && secondFactor
    && typeof secondFactor === 'object'
    && typeof (secondFactor as Record<string, unknown>).stepToken === 'string'
    && ((secondFactor as Record<string, unknown>).mode === 'sms'
      || (secondFactor as Record<string, unknown>).mode === 'enroll')
  ) {
    const factor = secondFactor as Record<string, unknown>;
    return {
      ok: true,
      realm: 'staff',
      secondFactor: {
        stepToken: factor.stepToken as string,
        mode: factor.mode as 'sms' | 'enroll',
        destination: typeof factor.destination === 'string' ? factor.destination : null,
      },
    };
  }
  if (status !== 200 || typeof json?.tokenHash !== 'string') {
    return {
      ok: false,
      error: errorFrom(json, 'That code didn’t work. Request a fresh one and try again.'),
      ...(typeof json?.code === 'string' ? { code: json.code } : {}),
    };
  }
  const signInId = typeof json.signInId === 'string' ? json.signInId : null;
  return json.realm === 'staff'
    ? { ok: true, realm: 'staff', tokenHash: json.tokenHash, signInId }
    : { ok: true, realm: 'patient', tokenHash: json.tokenHash, signInId };
}

export async function startStaffPhoneStep(input: {
  stepToken: string;
  phone?: string;
}): Promise<StaffPhoneStartResult> {
  const result = await postJson('/auth/login/phone/start', input, true);
  if ('failed' in result) return { ok: false, error: result.failed };
  const { status, json } = result;
  if (status === 400 && json?.code === 'STEP_EXPIRED') {
    return { ok: false, expired: true, error: errorFrom(json, 'That sign-in step expired.') };
  }
  if (status !== 200 || typeof json?.requestId !== 'string' || typeof json.destination !== 'string') {
    return {
      ok: false,
      error: errorFrom(json, status === 429
        ? 'Too many text codes were requested. Try again later.'
        : 'Could not send a text code right now. Try again in a moment.'),
      ...(status === 429 || json?.retryable === true ? { retryable: true as const } : {}),
    };
  }
  return {
    ok: true,
    mode: json.mode === 'enroll' ? 'enroll' : 'sms',
    requestId: json.requestId,
    destination: json.destination,
    devCode: typeof json.devCode === 'string' ? json.devCode : null,
  };
}

export async function verifyStaffPhoneCode(input: {
  stepToken: string;
  requestId: string;
  code: string;
}): Promise<StaffPhoneVerifyResult> {
  const result = await postJson('/auth/login/phone/verify', input, true);
  if ('failed' in result) return { ok: false, error: result.failed };
  const { status, json } = result;
  if ((status === 400 && json?.code === 'STEP_EXPIRED') || status === 409) {
    return { ok: false, expired: true, error: errorFrom(json, 'That sign-in step expired.') };
  }
  if (status !== 200 || typeof json?.tokenHash !== 'string') {
    return { ok: false, error: errorFrom(json, 'That code didn’t work. Request a fresh one and try again.') };
  }
  return {
    ok: true,
    realm: 'staff',
    tokenHash: json.tokenHash,
    signInId: typeof json.signInId === 'string' ? json.signInId : null,
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
  const result = await postJson('/auth/signup/complete', input, true);
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
  return { ok: true, tokenHash: json.tokenHash, signInId: typeof json.signInId === 'string' ? json.signInId : null };
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
