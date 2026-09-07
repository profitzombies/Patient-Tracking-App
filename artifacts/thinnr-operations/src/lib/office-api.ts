/**
 * Shared bearer-authenticated fetch for the office self-service endpoints
 * (team, audit). Mirrors the roster client's contract: the signed-in
 * office's scope is server-derived; an HQ drill-in names the office it is
 * viewing with `?office=`; a 401 is retried once after a session refresh.
 */
import { supabase } from '@/lib/supabase';

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

async function authToken(unconfigured: string, signedOut: string): Promise<string> {
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
  let token = await authToken(messages.unconfigured, messages.signedOut);
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
    response = await perform(token);
    if (response.status === 401 && supabase) {
      const { data } = await supabase.auth.refreshSession();
      const refreshed = data.session?.access_token;
      if (refreshed) {
        token = refreshed;
        response = await perform(token);
      }
    }
  } catch {
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
