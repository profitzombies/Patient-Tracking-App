/**
 * Client for the HQ testing override that permanently erases an office or a
 * patient. Temporary by design — remove together with the server routes in
 * api-server/src/routes/hq-testing-delete.ts and the TestingHardDelete panel.
 */
import { supabase } from '@/lib/supabase';
import { ReauthRequiredError, withReauthRetry } from '@/lib/reauth';

export type HardDeleteKind = 'provider' | 'patient';

export interface StripeAccountSummary {
  accountId: string;
  origin: 'created' | 'oauth' | 'unknown';
  mode: 'test' | 'live' | null;
  archived: boolean;
}

export interface ProviderDeletePreview {
  kind: 'provider';
  id: string;
  name: string;
  providerName: string | null;
  staffLogins: number;
  hqMembersKept: number;
  patients: number;
  patientLogins: number;
  stripeAccounts: StripeAccountSummary[];
  accessPlan: { state: string; savedPaymentMethods: number } | null;
}

export interface PatientDeletePreview {
  kind: 'patient';
  id: string;
  name: string;
  providerId: string | null;
  officeName: string | null;
  hasLogin: boolean;
  hqMemberKept: boolean;
  activeSubscriptions: number;
}

export type HardDeletePreview = ProviderDeletePreview | PatientDeletePreview;

export type StripeOutcome =
  | { kind: 'connected_account'; accountId: string; origin: StripeAccountSummary['origin']; archived: boolean;
      result: 'deleted' | 'disconnected' | 'already_gone' | 'refused'; message?: string }
  | { kind: 'access_payment_method'; paymentMethodId: string; result: 'removed' | 'already_gone' | 'failed'; message?: string }
  | { kind: 'access_customer'; customerId: string; result: 'deleted' | 'already_gone' | 'failed'; message?: string }
  | { kind: 'access_plan'; result: 'cancelled'; state: string }
  | { kind: 'patient_subscriptions'; result: 'cancelled' | 'not_reachable'; count: number; message?: string }
  | { kind: 'patient_customers'; result: 'deleted' | 'failed'; count: number; message?: string };

export interface HardDeleteResult {
  kind: HardDeleteKind;
  id: string;
  name: string;
  stripe: StripeOutcome[];
  logins: { deleted: number; alreadyGone: number; keptHqMembers: number; failed: string[] };
  files: { deleted: number; failed: string[] };
  rows: Record<string, number>;
}

export class HardDeleteRequestError extends Error {
  constructor(message: string, readonly status: number, readonly stripe: StripeOutcome[] = []) {
    super(message);
    this.name = 'HardDeleteRequestError';
  }
}

const pathFor = (kind: HardDeleteKind, id: string) =>
  `/api/hq/testing-delete/${kind === 'provider' ? 'providers' : 'patients'}/${encodeURIComponent(id)}`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!supabase) throw new HardDeleteRequestError('Live HQ access is not configured in this environment.', 503);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new HardDeleteRequestError('Your session has ended. Sign in again to continue.', 401);
  let response: Response;
  try {
    response = await withReauthRetry(() => fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    }));
  } catch (error) {
    if (error instanceof ReauthRequiredError) throw error;
    throw new HardDeleteRequestError('Could not reach THINNR. Check your connection and try again.', 0);
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new HardDeleteRequestError(
      typeof body?.error === 'string' ? body.error : `The request failed (${response.status}).`,
      response.status,
      Array.isArray(body?.stripe) ? body.stripe as StripeOutcome[] : [],
    );
  }
  return body as T;
}

export function fetchHardDeletePreview(kind: HardDeleteKind, id: string): Promise<HardDeletePreview> {
  return request<HardDeletePreview>(pathFor(kind, id));
}

export function performHardDelete(kind: HardDeleteKind, id: string, confirmName: string): Promise<HardDeleteResult> {
  return request<HardDeleteResult>(pathFor(kind, id), { method: 'POST', body: JSON.stringify({ confirmName }) });
}

/** Mirrors the server rule: case- and spacing-insensitive. */
export function namesMatch(typed: string, expected: string): boolean {
  const norm = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(typed).length > 0 && norm(typed) === norm(expected);
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** One plain sentence per Stripe outcome, for the result summary. */
export function describeStripeOutcome(outcome: StripeOutcome): string {
  switch (outcome.kind) {
    case 'connected_account': {
      const suffix = outcome.message ? ` (${outcome.message})` : '';
      if (outcome.result === 'deleted') return `Stripe account ${outcome.accountId} was deleted in Stripe.`;
      if (outcome.result === 'disconnected') return `Stripe account ${outcome.accountId} belongs to the office, so it was disconnected from THINNR.`;
      if (outcome.result === 'already_gone') return `Stripe account ${outcome.accountId} was already gone or unreachable.`;
      return `Stripe refused to remove account ${outcome.accountId}${suffix}. THINNR's records of it were still erased.`;
    }
    case 'access_payment_method':
      if (outcome.result === 'removed') return `Saved payment method ${outcome.paymentMethodId} was removed.`;
      if (outcome.result === 'already_gone') return `Saved payment method ${outcome.paymentMethodId} was already gone.`;
      return `Saved payment method ${outcome.paymentMethodId} could not be removed${outcome.message ? ` (${outcome.message})` : ''}.`;
    case 'access_customer':
      if (outcome.result === 'deleted') return `THINNR billing customer ${outcome.customerId} was deleted.`;
      if (outcome.result === 'already_gone') return `THINNR billing customer ${outcome.customerId} was already gone.`;
      return `THINNR billing customer ${outcome.customerId} could not be deleted${outcome.message ? ` (${outcome.message})` : ''}.`;
    case 'access_plan':
      return `The THINNR plan (${outcome.state}) was cancelled; no further charges will run.`;
    case 'patient_subscriptions':
      if (outcome.result === 'cancelled') return `${plural(outcome.count, 'patient subscription')} cancelled in Stripe.`;
      return `${plural(outcome.count, 'patient subscription')} could not be reached in Stripe (the connected account is gone or disconnected).`;
    case 'patient_customers':
      if (outcome.result === 'deleted') return `${plural(outcome.count, 'patient payer')} deleted in Stripe.`;
      return `${plural(outcome.count, 'patient payer')} could not be deleted in Stripe${outcome.message ? ` (${outcome.message})` : ''}.`;
  }
}
