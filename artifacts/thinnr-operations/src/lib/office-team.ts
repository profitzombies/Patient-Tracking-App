/**
 * Client for the office Team page — GET/POST/PATCH /api/office/team.
 *
 * Roles: owner (full control, including who else owns the office), admin
 * (manages staff and admins), staff (no team access). The server enforces
 * every rule; the client only shapes requests and surfaces the messages.
 */
import { officeQuery, officeRequest, OfficeApiError } from '@/lib/office-api';

export { OfficeApiError as OfficeTeamError };

export type OfficeRole = 'owner' | 'admin' | 'staff';
export type OfficeTeamMemberStatus = 'invited' | 'active' | 'disabled';

export const OFFICE_ROLE_LABELS: Record<OfficeRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  staff: 'Staff',
};

export const OFFICE_ROLE_HELP: Record<OfficeRole, string> = {
  owner: 'Runs the office: manages every teammate, including other owners.',
  admin: 'Manages staff and the audit trail, but cannot change owners.',
  staff: 'Works the roster and patient records; no team administration.',
};

export interface OfficeTeamMember {
  id: string;
  name: string;
  email: string;
  role: OfficeRole;
  status: OfficeTeamMemberStatus;
  invitedAt: string | null;
  claimedAt: string | null;
  isSelf: boolean;
}

export interface OfficeTeam {
  office: { id: string; name: string };
  me: { role: OfficeRole; kind: 'provider' | 'team_member' | 'hq'; teamMemberId: string | null };
  accountOwner: { name: string; email: string; status: 'active' | 'invited' };
  members: OfficeTeamMember[];
}

export interface InviteTeammateInput {
  firstName: string;
  lastName: string;
  email: string;
  role: OfficeRole;
}

export type SessionInvalidation = 'complete' | 'failed' | 'not_applicable';

const MESSAGES = {
  unconfigured: 'Team management is not configured in this environment.',
  signedOut: 'Sign in to manage this office’s team.',
  unreachable: 'Could not reach the team service. Check your connection and try again.',
  failed: 'The team request failed',
};

const base = '/api/office/team';

export function officeTeamQueryKey(office: string | null): readonly unknown[] {
  return ['office-team', office ?? 'self'];
}

export async function fetchOfficeTeam(office?: string | null): Promise<OfficeTeam> {
  return officeRequest<OfficeTeam>(`${base}${officeQuery(office)}`, MESSAGES);
}

export async function inviteTeammate(input: InviteTeammateInput, office?: string | null): Promise<{ member: OfficeTeamMember }> {
  return officeRequest(`${base}/invitations${officeQuery(office)}`, MESSAGES, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function changeTeammateRole(memberId: string, role: OfficeRole, office?: string | null): Promise<{ member: OfficeTeamMember }> {
  return officeRequest(`${base}/${encodeURIComponent(memberId)}${officeQuery(office)}`, MESSAGES, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

export async function setTeammateActive(
  memberId: string,
  active: boolean,
  office?: string | null,
): Promise<{ member: OfficeTeamMember; sessionInvalidation: SessionInvalidation }> {
  return officeRequest(`${base}/${encodeURIComponent(memberId)}/${active ? 'reactivate' : 'deactivate'}${officeQuery(office)}`, MESSAGES, {
    method: 'POST',
  });
}

export async function signOutTeammate(
  memberId: string,
  office?: string | null,
): Promise<{ member: OfficeTeamMember; sessionInvalidation: SessionInvalidation }> {
  return officeRequest(`${base}/${encodeURIComponent(memberId)}/sign-out${officeQuery(office)}`, MESSAGES, {
    method: 'POST',
  });
}

export function validateInviteTeammate(input: InviteTeammateInput): Partial<Record<keyof InviteTeammateInput, string>> {
  const errors: Partial<Record<keyof InviteTeammateInput, string>> = {};
  if (!input.firstName.trim()) errors.firstName = 'First name is required.';
  if (!input.lastName.trim()) errors.lastName = 'Last name is required.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) errors.email = 'Enter a valid email address.';
  return errors;
}
