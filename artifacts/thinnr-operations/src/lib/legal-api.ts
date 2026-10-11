/**
 * Public (no session) legal + account-deletion calls behind /privacy, /terms,
 * /support and /delete-account. Root-relative paths: the operations site is
 * the root artifact, so `/api/...` reaches the API server in every environment.
 */

export interface SupportContact {
  organizationName: string;
  email: string;
  phone: string | null;
}

export interface DeletionStartResponse {
  ok: boolean;
  requestId: string;
  /** Present only in development delivery mode. */
  devCode?: string | null;
}

export interface DeletionVerifyResponse {
  ok: boolean;
  alreadyPending: boolean;
  deletion: { requestedAt: string; purgeAfter: string; status: 'pending' | 'held' } | null;
}

export class PublicLegalError extends Error {
  constructor(message: string, readonly status: number, readonly retryable = false) {
    super(message);
    this.name = 'PublicLegalError';
  }
}

async function publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new PublicLegalError('Could not reach THINNR. Check your connection and try again.', 0, true);
  }
  let body: { error?: unknown; retryable?: unknown } & Partial<T> = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Generic message below.
  }
  if (!response.ok) {
    throw new PublicLegalError(
      typeof body.error === 'string' ? body.error : `The request failed (${response.status}).`,
      response.status,
      body.retryable === true,
    );
  }
  return body as T;
}

export const publicLegal = {
  supportContact: () => publicRequest<SupportContact>('/api/legal/support'),
  startDeletion: (identifier: string) =>
    publicRequest<DeletionStartResponse>('/api/account-deletion/start', {
      method: 'POST',
      body: JSON.stringify({ identifier }),
    }),
  verifyDeletion: (requestId: string, code: string) =>
    publicRequest<DeletionVerifyResponse>('/api/account-deletion/verify', {
      method: 'POST',
      body: JSON.stringify({ requestId, code }),
    }),
};
