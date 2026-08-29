import { supabase } from '@/lib/supabase';
import type {
  AccountPlan,
  ProviderAccount,
  ProviderAccountDetail,
} from '@/data/hq/accounts';

export interface NewProviderAccountInput {
  officeName: string;
  providerName: string;
  providerRole: string;
  city: string;
  state: string;
  plan: AccountPlan | null;
  email: string;
  phone: string;
}

export class ProviderAccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'ProviderAccountError';
  }
}

async function authToken(): Promise<string> {
  if (!supabase) throw new ProviderAccountError('Live provider accounts are not configured in this environment.', 503);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ProviderAccountError('Sign in with a THINNR HQ account to view live provider accounts.', 401);
  return token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await authToken();
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ProviderAccountError('Could not reach the account service. Check your connection and try again.', 0);
  }
  let body: { error?: unknown; field?: unknown } & Partial<T> = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Generic response below.
  }
  if (!response.ok) {
    throw new ProviderAccountError(
      typeof body.error === 'string' ? body.error : `The account request failed (${response.status}).`,
      response.status,
      typeof body.field === 'string' ? body.field : null,
    );
  }
  return body as T;
}

export async function fetchProviderAccounts(): Promise<ProviderAccount[]> {
  const body = await request<{ accounts: ProviderAccount[] }>('/api/provider-accounts');
  return body.accounts ?? [];
}

export async function fetchProviderAccountDetail(id: string): Promise<ProviderAccountDetail> {
  return request<ProviderAccountDetail>(`/api/provider-accounts/${encodeURIComponent(id)}`);
}

export async function createProviderAccount(input: NewProviderAccountInput): Promise<{
  account: ProviderAccount;
  invitation: 'sent' | 'not_configured' | 'failed';
}> {
  return request('/api/provider-accounts', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}