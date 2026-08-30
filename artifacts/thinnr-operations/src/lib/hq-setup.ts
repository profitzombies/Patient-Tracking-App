export type HqSetupRole = 'Super Admin' | 'Admin' | 'Clinical' | 'Support' | 'Content';

export interface HqSetupInvitation {
  name: string;
  email: string;
  role: HqSetupRole;
}

export type HqSetupFailure = 'invalid' | 'expired' | 'used' | 'error';

function roleFrom(value: unknown): HqSetupRole | null {
  const role = String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (role === 'super admin') return 'Super Admin';
  if (role === 'admin') return 'Admin';
  if (role === 'clinical') return 'Clinical';
  if (role === 'support') return 'Support';
  if (role === 'content') return 'Content';
  return null;
}

async function setupRequest(path: string, init: RequestInit): Promise<{ response: Response; body: Record<string, unknown> | null }> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  return { response, body };
}

function failureFrom(status: number, body: Record<string, unknown> | null): HqSetupFailure {
  const code = String(body?.code ?? body?.reason ?? '').toLowerCase();
  if (body?.field === 'password' || body?.field === 'passwordConfirm') return 'error';
  if (code.includes('used') || code.includes('complete')) return 'used';
  if (code.includes('expir') || status === 410) return 'expired';
  if (status === 400 || status === 401 || status === 404) return 'invalid';
  return 'error';
}

function invitationFrom(body: Record<string, unknown> | null): HqSetupInvitation | null {
  const source = body?.invitation && typeof body.invitation === 'object'
    ? body.invitation as Record<string, unknown>
    : body;
  const name = typeof source?.name === 'string' ? source.name : null;
  const email = typeof source?.email === 'string' ? source.email : null;
  const role = roleFrom(source?.role);
  return name && email && role ? { name, email, role } : null;
}

export async function inspectHqSetup(token: string): Promise<HqSetupInvitation> {
  const { response, body } = await setupRequest(`/api/hq-team/setup?token=${encodeURIComponent(token)}`, {
    method: 'GET',
  });
  const invitation = invitationFrom(body);
  if (response.ok && invitation) return invitation;
  throw Object.assign(new Error(typeof body?.error === 'string' ? body.error : 'This setup link could not be verified.'), {
    failure: failureFrom(response.status, body),
  });
}

export async function completeHqSetup(token: string, password: string, passwordConfirm: string): Promise<void> {
  const { response, body } = await setupRequest('/api/hq-team/setup/complete', {
    method: 'POST',
    body: JSON.stringify({ token, password, passwordConfirm }),
  });
  if (response.ok) return;
  throw Object.assign(new Error(typeof body?.error === 'string' ? body.error : 'We could not finish setting up this account.'), {
    failure: failureFrom(response.status, body),
  });
}

export function meetsHqPasswordPolicy(password: string): boolean {
  return password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[^A-Za-z0-9]/.test(password);
}