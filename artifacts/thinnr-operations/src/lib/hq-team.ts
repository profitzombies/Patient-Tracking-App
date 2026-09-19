import { supabase } from '@/lib/supabase';
import { ReauthRequiredError, withReauthRetry } from '@/lib/reauth';
import type { HqRole, HqTeamMember } from '@/data/hq/team';

export interface InviteHqTeamMemberInput {
  name: string;
  email: string;
  role: Exclude<HqRole, 'Super Admin'>;
  title: string;
}

export class HqTeamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HqTeamError';
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
    throw new HqTeamError(
      typeof body?.error === 'string' ? body.error : `The team request failed (${response.status}).`,
      response.status,
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
    name,
    initials: initialsOf(name),
    email,
    role: asRole(row.role ?? row.departmentRole ?? row.hqRole),
    title: typeof row.title === 'string' ? row.title : typeof row.jobTitle === 'string' ? row.jobTitle : null,
    status: active ? 'active' : 'pending',
    joinedLabel: active ? formatJoined(row.joinedAt ?? row.createdAt) : 'Pending',
  };
}

export async function fetchHqTeam(): Promise<HqTeamMember[]> {
  const body = await request<{ members: unknown[] }>('/api/hq-team');
  if (!Array.isArray(body.members)) throw new HqTeamError('The team service returned an invalid roster.', 502);
  return body.members.map(mapMember);
}

export async function inviteHqTeamMember(input: InviteHqTeamMemberInput): Promise<{
  member: HqTeamMember;
  invitation: 'sent' | 'not_configured' | 'failed';
}> {
  const body = await request<{ member: unknown; invitation: 'sent' | 'not_configured' | 'failed' }>('/api/hq-team', {
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

export async function removeHqTeamMember(id: string): Promise<void> {
  await request(`/api/hq-team/${encodeURIComponent(id)}`, { method: 'DELETE' });
}