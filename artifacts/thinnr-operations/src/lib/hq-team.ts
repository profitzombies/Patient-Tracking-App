import { supabase } from '@/lib/supabase';
import { ReauthRequiredError, withReauthRetry } from '@/lib/reauth';
import type { HqRole, HqTeamMember } from '@/data/hq/team';

export interface InviteHqTeamMemberInput {
  name: string;
  email: string;
  role: Exclude<HqRole, 'Super Admin'>;
  title: string;
}

/** The half-finished HQ row that an invite collided with, when re-sending can recover it. */
export interface HqResendableCollision {
  memberId: string;
  name: string;
  state: 'pending' | 'cancelled';
}

export class HqTeamError extends Error {
  /** Set when the only thing holding the email is a stalled HQ invitation. */
  readonly resendable: HqResendableCollision | null;
  /** True when the message is the database function's own refusal, not ours. */
  readonly fromDatabase: boolean;

  constructor(
    message: string,
    readonly status: number,
    options: { resendable?: HqResendableCollision | null; fromDatabase?: boolean } = {},
  ) {
    super(message);
    this.name = 'HqTeamError';
    this.resendable = options.resendable ?? null;
    this.fromDatabase = options.fromDatabase ?? false;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!supabase) throw new HqTeamError('Live HQ team access is not configured in this environment.', 503);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new HqTeamError('Your session has ended. Sign in again to continue.', 401);
  let response: Response;
  try {
    response = await withReauthRetry(() => fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    }));
  } catch (error) {
    if (error instanceof ReauthRequiredError) throw error;
    throw new HqTeamError('Could not reach the team service. Check your connection and try again.', 0);
  }
  const body = await response.json().catch(() => null) as (Record<string, unknown> & Partial<T>) | null;
  if (!response.ok) {
    const resendable = body?.resendable as HqResendableCollision | undefined;
    throw new HqTeamError(
      typeof body?.error === 'string' ? body.error : `The team request failed (${response.status}).`,
      response.status,
      {
        resendable: resendable && typeof resendable.memberId === 'string' ? resendable : null,
        fromDatabase: body?.source === 'database',
      },
    );
  }
  return body as T;
}

function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'TH';
}

function asRole(value: unknown): HqRole {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (normalized === 'super admin') return 'Super Admin';
  if (normalized === 'admin') return 'Admin';
  if (normalized === 'clinical') return 'Clinical';
  if (normalized === 'support') return 'Support';
  if (normalized === 'content') return 'Content';
  throw new HqTeamError('The team service returned an unknown department role.', 502);
}

function formatExpiry(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function formatJoined(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'Pending';
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? 'Unknown'
    : new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(date);
}

function mapMember(value: unknown): HqTeamMember {
  const row = value as Record<string, unknown>;
  const name = typeof row.name === 'string' ? row.name : typeof row.displayName === 'string' ? row.displayName : '';
  const email = typeof row.email === 'string' ? row.email : '';
  if (!row.id || !name || !email) throw new HqTeamError('The team service returned an incomplete teammate.', 502);
  const rawStatus = String(row.status ?? '').toLowerCase();
  const active = rawStatus === 'active' || rawStatus === 'accepted';
  return {
    id: String(row.id),
    authUserId: typeof row.authUserId === 'string' ? row.authUserId : null,
    name,
    initials: initialsOf(name),
    email,
    role: asRole(row.role ?? row.departmentRole ?? row.hqRole),
    title: typeof row.title === 'string' ? row.title : typeof row.jobTitle === 'string' ? row.jobTitle : null,
    status: active ? 'active' : 'pending',
    joinedLabel: active ? formatJoined(row.joinedAt ?? row.createdAt) : 'Pending',
    invitationExpiresAt: typeof row.invitationExpiresAt === 'string' ? row.invitationExpiresAt : null,
    invitationExpiresLabel: active ? null : formatExpiry(row.invitationExpiresAt),
    secondFactorPhone: typeof row.secondFactorPhone === 'string' ? row.secondFactorPhone : null,
  };
}

export async function fetchHqTeam(): Promise<HqTeamMember[]> {
  const body = await request<{ members: unknown[] }>('/api/hq-team');
  if (!Array.isArray(body.members)) throw new HqTeamError('The team service returned an invalid roster.', 502);
  return body.members.map(mapMember);
}

export async function clearHqTeamMemberSecondFactor(id: string): Promise<{ ok: true; cleared: boolean }> {
  return request(`/api/hq-team/${encodeURIComponent(id)}/second-factor/clear`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
/** How the emailed setup link fared. `no_link` means the member exists but has no usable link. */
export type InvitationDelivery = 'sent' | 'not_configured' | 'failed' | 'no_link';

export async function inviteHqTeamMember(input: InviteHqTeamMemberInput): Promise<{
  member: HqTeamMember;
  invitation: InvitationDelivery;
}> {
  const body = await request<{ member: unknown; invitation: InvitationDelivery }>('/api/hq-team', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return { member: mapMember(body.member), invitation: body.invitation };
}

export async function updateHqTeamMember(
  id: string,
  patch: { role: Exclude<HqRole, 'Super Admin'>; title: string },
): Promise<HqTeamMember> {
  const body = await request<{ member: unknown }>(`/api/hq-team/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return mapMember(body.member);
}

export async function resendHqTeamInvitation(id: string): Promise<{
  member: HqTeamMember;
  invitation: InvitationDelivery;
}> {
  const body = await request<{ member: unknown; invitation: InvitationDelivery }>(
    `/api/hq-team/${encodeURIComponent(id)}/invitations/resend`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return { member: mapMember(body.member), invitation: body.invitation };
}

export async function cancelHqTeamInvitation(id: string): Promise<void> {
  await request(`/api/hq-team/${encodeURIComponent(id)}/invitations/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** Removal reports whether the person's devices were actually signed out. */
export interface HqRemovalResult {
  revoked: true;
  sessionInvalidation: 'complete' | 'failed' | 'not_applicable';
}

export async function removeHqTeamMember(id: string): Promise<HqRemovalResult> {
  const body = await request<HqRemovalResult>(`/api/hq-team/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return {
    revoked: true,
    sessionInvalidation: body?.sessionInvalidation === 'failed'
      ? 'failed'
      : body?.sessionInvalidation === 'not_applicable' ? 'not_applicable' : 'complete',
  };
}

/** The invitation states the setup page can land in. Only a live one carries identity. */
export type HqInvitationLookup =
  | { state: 'pending'; name: string; email: string; role: HqRole; title: string | null; expiresAt: string | null }
  | { state: 'used' | 'cancelled' | 'expired' | 'unknown' | 'unavailable' };

/**
 * Exchange an emailed setup token for the invitee's details. Unauthenticated
 * by design — the token is the only credential, and a dead one is answered
 * without ever confirming whether it belonged to anybody.
 */
export async function lookupHqInvitation(token: string): Promise<HqInvitationLookup> {
  let response: Response;
  try {
    response = await fetch('/api/hq-team/invitation/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    return { state: 'unavailable' };
  }
  if (!response.ok) return { state: 'unavailable' };
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const state = String(body?.state ?? 'unknown');
  if (state !== 'pending') {
    return { state: state === 'used' || state === 'cancelled' || state === 'expired' ? state : 'unknown' };
  }
  return {
    state: 'pending',
    name: String(body?.name ?? ''),
    email: String(body?.email ?? ''),
    role: asRole(body?.role),
    title: typeof body?.title === 'string' ? body.title : null,
    expiresAt: typeof body?.expiresAt === 'string' ? body.expiresAt : null,
  };
}
