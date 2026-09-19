/**
 * Office Team — self-service staff administration for one provider office.
 *
 * Owners and admins see every teammate with role and status, invite by
 * email, change roles, deactivate/reactivate, and force a sign-out. The
 * server owns every rule (last-owner guard, owner-only owner changes, no
 * self-edits, deactivated staff fail closed); this page shapes the requests,
 * keeps the list fresh, and explains refusals in plain words.
 *
 * States are explicit: resolving session, demo persona (no live office),
 * loading, error, staff-role permission notice, empty, ready.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { UserPlus, ShieldCheck } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CHIP_COBALT,
  CHIP_RISK,
  CHIP_WARM,
  INPUT_CLASS,
  PANEL_LABEL,
  SectionCard,
} from '@/components/patient/heritage';
import { PageHeader } from '@/components/admin/primitives';
import { initialsOf } from '@/components/layout/nav-config';
import { useLiveOfficeScope } from '@/hooks/use-live-office-scope';
import {
  OFFICE_ROLE_HELP,
  OFFICE_ROLE_LABELS,
  OfficeTeamError,
  changeTeammateRole,
  clearAccountOwnerSecondFactor,
  clearTeammateSecondFactor,
  fetchOfficeTeam,
  inviteTeammate,
  officeTeamQueryKey,
  setTeammateActive,
  signOutTeammate,
  validateInviteTeammate,
  type InviteTeammateInput,
  type OfficeRole,
  type OfficeTeam,
  type OfficeTeamMember,
} from '@/lib/office-team';
import { ManagedSessionsState } from '@/components/team/ManagedSessions';
import {
  fetchOfficeTeamMemberSessions,
  type SecurityReason,
} from '@/lib/office-api';

const NEUTRAL_CHIP =
  'inline-flex items-center gap-1.5 rounded-sm border border-border bg-secondary px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.06em] text-foreground';

export function OfficeRoleChip({ role }: { role: OfficeRole }) {
  return (
    <span className={role === 'owner' ? CHIP_COBALT : NEUTRAL_CHIP} data-testid={`chip-role-${role}`}>
      {OFFICE_ROLE_LABELS[role]}
    </span>
  );
}

export function MemberStatusChip({ status }: { status: OfficeTeamMember['status'] }) {
  if (status === 'active') return <span className={CHIP_COBALT}>Active</span>;
  if (status === 'invited') return <span className={CHIP_WARM}>Invited</span>;
  return <span className={CHIP_RISK}>Deactivated</span>;
}

const ROLES: OfficeRole[] = ['owner', 'admin', 'staff'];

function formatDay(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const EMPTY_INVITE: InviteTeammateInput = { firstName: '', lastName: '', email: '', role: 'staff' };

export default function OfficeTeam() {
  const { liveEnabled, liveOffice, isDemo, isResolving, authUserId } = useLiveOfficeScope();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const queryKey = [...officeTeamQueryKey(liveOffice), authUserId];

  const query = useQuery({
    queryKey,
    queryFn: () => fetchOfficeTeam(liveOffice),
    enabled: liveEnabled,
    retry: (count, error) => !(error instanceof OfficeTeamError && (error.status === 403 || error.status === 401)) && count < 2,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: officeTeamQueryKey(liveOffice) });

  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState<InviteTeammateInput>(EMPTY_INVITE);
  const [inviteErrors, setInviteErrors] = useState<Partial<Record<keyof InviteTeammateInput, string>>>({});
  const [editing, setEditing] = useState<OfficeTeamMember | null>(null);
  const [editRole, setEditRole] = useState<OfficeRole>('staff');
  const [confirming, setConfirming] = useState<{
    member?: OfficeTeamMember;
    action: 'deactivate' | 'reactivate' | 'sign-out' | 'clear-phone' | 'clear-owner-phone';
  } | null>(null);
  const [sessionMember, setSessionMember] = useState<OfficeTeamMember | null>(null);
  const [signOutReason, setSignOutReason] = useState<Exclude<SecurityReason, 'patient_request'>>('staff_request');
  const sessionsQuery = useQuery({
    queryKey: ['office-team-sessions', sessionMember?.id],
    queryFn: () => fetchOfficeTeamMemberSessions(sessionMember!.id),
    enabled: Boolean(sessionMember),
    retry: false,
  });

  const failure = (title: string, error: unknown) =>
    toast({ variant: 'destructive', title, description: error instanceof Error ? error.message : 'Try again.' });

  const inviteMutation = useMutation({
    mutationFn: (input: InviteTeammateInput) => inviteTeammate(input, liveOffice),
    onSuccess: (result) => {
      toast({ variant: 'success', title: `Invite sent to ${result.member.name}`, description: `They sign in with a one-time email code and join as ${OFFICE_ROLE_LABELS[result.member.role]}.` });
      setInviteOpen(false);
      setInvite(EMPTY_INVITE);
      setInviteErrors({});
      void refresh();
    },
    onError: (error) => {
      if (error instanceof OfficeTeamError && error.field) setInviteErrors({ [error.field]: error.message });
      else failure('Invitation not sent', error);
    },
  });

  const roleMutation = useMutation({
    mutationFn: ({ member, role }: { member: OfficeTeamMember; role: OfficeRole }) => changeTeammateRole(member.id, role, liveOffice),
    onSuccess: (result) => {
      toast({ variant: 'success', title: `${result.member.name} is now ${OFFICE_ROLE_LABELS[result.member.role]}`, description: 'Their access changes on their next request.' });
      setEditing(null);
      void refresh();
    },
    onError: (error) => failure('Role not changed', error),
  });

  const statusMutation = useMutation<unknown, Error, NonNullable<typeof confirming>>({
    mutationFn: ({ member, action }: NonNullable<typeof confirming>) => {
      if (action === 'clear-owner-phone') return clearAccountOwnerSecondFactor(liveOffice!);
      if (!member) throw new Error('Choose a teammate first.');
      if (action === 'clear-phone') return clearTeammateSecondFactor(member.id, liveOffice);
      return action === 'sign-out'
        ? signOutTeammate(member.id, liveOffice, signOutReason)
        : setTeammateActive(member.id, action === 'reactivate', liveOffice);
    },
    onSuccess: (result, variables) => {
      if (variables.action === 'clear-phone' || variables.action === 'clear-owner-phone') {
        toast({ variant: 'success', title: 'Sign-in phone cleared', description: 'They’ll add a phone at their next sign-in.' });
        setConfirming(null);
        void refresh();
        return;
      }
      const memberResult = result as { member: OfficeTeamMember; sessionInvalidation: string };
      const name = memberResult.member.name;
      const signedOut = memberResult.sessionInvalidation === 'complete';
      if (variables.action === 'deactivate') {
        toast({ variant: 'success', title: `${name} deactivated`, description: signedOut ? 'Their access is off and every signed-in device was signed out.' : 'Their access is off. Any open session ends on its next request.' });
      } else if (variables.action === 'reactivate') {
        toast({ variant: 'success', title: `${name} reactivated`, description: 'They can sign in again with their existing login.' });
      } else {
        toast({ variant: signedOut ? 'success' : 'destructive', title: signedOut ? `${name} signed out everywhere` : `Could not confirm the sign-out for ${name}`, description: signedOut ? 'They will need to sign in again on every device.' : 'The sign-in service did not confirm. Try again in a moment.' });
      }
      setConfirming(null);
      void refresh();
    },
    onError: (error) => failure('Change not saved', error),
  });

  const busy = inviteMutation.isPending || roleMutation.isPending || statusMutation.isPending;
  const team: OfficeTeam | undefined = query.data;
  const me = team?.me;
  const canEditOwners = me?.role === 'owner';

  const submitInvite = () => {
    const errors = validateInviteTeammate(invite);
    setInviteErrors(errors);
    if (Object.keys(errors).length) return;
    inviteMutation.mutate({ ...invite, firstName: invite.firstName.trim(), lastName: invite.lastName.trim(), email: invite.email.trim() });
  };

  const openEdit = (member: OfficeTeamMember) => {
    setEditing(member);
    setEditRole(member.role);
  };

  const permissionError = query.error instanceof OfficeTeamError && query.error.isForbidden ? query.error : null;
  const rosterSub = team
    ? `${team.members.length + 1} ${team.members.length + 1 === 1 ? 'person' : 'people'} · ${team.office.name}`
    : 'Everyone who can sign in to this office';

  return (
    <div className="mx-auto max-w-[1320px] space-y-6 px-4 py-6 sm:px-5 sm:py-7 md:px-8">
      <PageHeader
        kicker="Office"
        title="Team"
        sub="Who can sign in to this office, what they can do, and whether their access is on. Changes apply immediately to live logins."
        action={
          liveEnabled && team && !permissionError ? (
            <button type="button" className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-invite" onClick={() => setInviteOpen(true)} disabled={busy}>
              <UserPlus size={14} aria-hidden="true" />
              Invite teammate
            </button>
          ) : undefined
        }
      />

      <SectionCard title="Team roster" sub={rosterSub}>
        {isResolving && <p className="px-5 py-8 text-xs text-muted-foreground" data-testid="status-team-loading">Checking your sign-in…</p>}
        {isDemo && (
          <div className="px-5 py-8" data-testid="status-team-demo">
            <p className="text-xs text-muted-foreground">Team management works on live office accounts. The guided demo doesn’t have a real team to manage — sign in with your office login to invite teammates, change roles, or turn access off.</p>
          </div>
        )}
        {!isDemo && !isResolving && !liveEnabled && (
          <p className="px-5 py-8 text-xs text-muted-foreground" role="alert" data-testid="status-team-unauthorized">Open a provider account to manage its team.</p>
        )}
        {liveEnabled && query.isPending && <p className="px-5 py-8 text-xs text-muted-foreground" data-testid="status-team-loading">Loading the team…</p>}
        {liveEnabled && permissionError && (
          <div className="flex items-start gap-3 px-5 py-8" role="alert" data-testid="status-team-unauthorized">
            <ShieldCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">{permissionError.message}</p>
          </div>
        )}
        {liveEnabled && query.isError && !permissionError && (
          <div className="flex flex-wrap items-center gap-3 px-5 py-8" role="alert" data-testid="status-team-error">
            <p className="text-xs text-destructive">{query.error instanceof Error ? query.error.message : 'The team could not be loaded.'}</p>
            <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`} onClick={() => void query.refetch()}>Try again</button>
          </div>
        )}
        {liveEnabled && team && !permissionError && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                  <th className="px-5 py-3 font-bold">Member</th>
                  <th className="px-3 py-3 font-bold">Role</th>
                  <th className="px-3 py-3 font-bold">Status</th>
                  <th className="px-3 py-3 font-bold">Sign-in phone</th>
                  <th className="px-3 py-3 font-bold">Invited</th>
                  <th className="px-3 py-3 font-bold">Joined</th>
                  <th className="px-5 py-3 text-right font-bold">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border" data-testid="row-team-account-owner">
                  <td className="px-5 py-3">
                    <MemberIdentity name={team.accountOwner.name} email={team.accountOwner.email} suffix={me?.kind === 'provider' ? ' (you)' : ''} />
                  </td>
                  <td className="px-3 py-3"><OfficeRoleChip role="owner" /></td>
                  <td className="px-3 py-3"><MemberStatusChip status={team.accountOwner.status} /></td>
                   <td className="px-3 py-3 text-muted-foreground">{team.accountOwner.secondFactorPhone ?? 'No phone'}</td>
                  <td className="px-3 py-3 text-muted-foreground">—</td>
                  <td className="px-3 py-3 text-muted-foreground">—</td>
                  <td className="px-5 py-3 text-right text-[10px] text-muted-foreground" title="The account holder always owns the office.">
                    {me?.kind === 'hq' ? (
                      <button
                        type="button"
                        className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px] text-destructive`}
                        data-testid="button-clear-phone-account-owner"
                        disabled={!team.accountOwner.secondFactorPhone || busy}
                        onClick={() => setConfirming({ action: 'clear-owner-phone' })}
                      >
                        Clear sign-in phone
                      </button>
                    ) : 'Account holder'}
                  </td>
                </tr>
                {team.members.map((member) => {
                  const locked = member.isSelf || (member.role === 'owner' && !canEditOwners);
                  return (
                    <tr key={member.id} className="border-b border-border last:border-b-0" data-testid={`row-team-${member.id}`}>
                      <td className="px-5 py-3">
                        <MemberIdentity name={member.name} email={member.email} suffix={member.isSelf ? ' (you)' : ''} />
                      </td>
                      <td className="px-3 py-3"><OfficeRoleChip role={member.role} /></td>
                      <td className="px-3 py-3"><MemberStatusChip status={member.status} /></td>
                       <td className="px-3 py-3 text-muted-foreground">{member.secondFactorPhone ?? 'No phone'}</td>
                      <td className="px-3 py-3 text-muted-foreground">{formatDay(member.invitedAt)}</td>
                      <td className="px-3 py-3 text-muted-foreground">{formatDay(member.claimedAt)}</td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {locked ? (
                            <>
                              <span className="text-[10px] text-muted-foreground" title={member.isSelf ? 'Ask another owner or admin to change your access.' : 'Only an owner can change another owner.'}>
                                {member.isSelf ? 'Your login' : 'Owner'}
                              </span>
                              {member.isSelf && (
                                <button
                                  type="button"
                                  className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px] text-destructive`}
                                  data-testid={`button-clear-phone-${member.id}`}
                                  disabled
                                >
                                  Clear sign-in phone
                                </button>
                              )}
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px] text-destructive`}
                                data-testid={`button-clear-phone-${member.id}`}
                                onClick={() => setConfirming({ member, action: 'clear-phone' })}
                                disabled={!member.secondFactorPhone || busy}
                              >
                                Clear sign-in phone
                              </button>
                              <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`} data-testid={`button-edit-${member.id}`} onClick={() => openEdit(member)} disabled={busy}>
                                Change role
                              </button>
                              {member.status === 'disabled' ? (
                                <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`} data-testid={`button-reactivate-${member.id}`} onClick={() => setConfirming({ member, action: 'reactivate' })} disabled={busy}>
                                  Reactivate
                                </button>
                              ) : (
                                <>
                                  {member.status === 'active' && (
                                     <>
                                       <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`} data-testid={`button-sessions-${member.id}`} onClick={() => setSessionMember(member)} disabled={busy}>Sessions</button>
                                       <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`} data-testid={`button-sign-out-${member.id}`} onClick={() => { setSignOutReason('staff_request'); setConfirming({ member, action: 'sign-out' }); }} disabled={busy}>
                                         Sign out
                                       </button>
                                     </>
                                  )}
                                  <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px] text-destructive`} data-testid={`button-deactivate-${member.id}`} onClick={() => setConfirming({ member, action: 'deactivate' })} disabled={busy}>
                                    Deactivate
                                  </button>
                                </>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {team.members.length === 0 && (
              <p className="px-5 py-6 text-xs text-muted-foreground" data-testid="status-team-empty">No teammates yet. Invite the first one to give them their own login.</p>
            )}
          </div>
        )}
      </SectionCard>

      {liveEnabled && team && !permissionError && (
        <p className="text-[11px] text-muted-foreground">
          Every change here is recorded in the office’s <Link href="/audit" className="font-semibold text-primary underline-offset-2 hover:underline">audit trail</Link>.
        </p>
      )}

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={(open) => { setInviteOpen(open); if (!open) setInviteErrors({}); }}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Invite a teammate</DialogTitle>
            <DialogDescription>They receive a one-time email code to sign in — no password to share.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); submitInvite(); }} noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className={PANEL_LABEL}>First name</span>
                <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={invite.firstName} onChange={(event) => setInvite({ ...invite, firstName: event.target.value })} data-testid="input-invite-first-name" aria-invalid={Boolean(inviteErrors.firstName)} aria-describedby={inviteErrors.firstName ? 'invite-first-name-error' : undefined} autoComplete="given-name" />
                {inviteErrors.firstName && <span id="invite-first-name-error" className="mt-1 block text-[11px] text-destructive">{inviteErrors.firstName}</span>}
              </label>
              <label className="block">
                <span className={PANEL_LABEL}>Last name</span>
                <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={invite.lastName} onChange={(event) => setInvite({ ...invite, lastName: event.target.value })} data-testid="input-invite-last-name" aria-invalid={Boolean(inviteErrors.lastName)} aria-describedby={inviteErrors.lastName ? 'invite-last-name-error' : undefined} autoComplete="family-name" />
                {inviteErrors.lastName && <span id="invite-last-name-error" className="mt-1 block text-[11px] text-destructive">{inviteErrors.lastName}</span>}
              </label>
            </div>
            <label className="block">
              <span className={PANEL_LABEL}>Work email</span>
              <input type="email" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} data-testid="input-invite-email" aria-invalid={Boolean(inviteErrors.email)} aria-describedby={inviteErrors.email ? 'invite-email-error' : undefined} autoComplete="email" />
              {inviteErrors.email && <span id="invite-email-error" className="mt-1 block text-[11px] text-destructive">{inviteErrors.email}</span>}
            </label>
            <div>
              <span className={PANEL_LABEL}>Role</span>
              <Select value={invite.role} onValueChange={(value) => setInvite({ ...invite, role: value as OfficeRole })}>
                <SelectTrigger className="mt-1 h-9 text-xs" data-testid="select-invite-role" aria-label="Role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.filter((role) => role !== 'owner' || canEditOwners).map((role) => (
                    <SelectItem key={role} value={role} className="text-xs">{OFFICE_ROLE_LABELS[role]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{OFFICE_ROLE_HELP[invite.role]}</p>
            </div>
            <DialogFooter>
              <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => setInviteOpen(false)}>Cancel</button>
              <button type="submit" className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-invite-submit" disabled={inviteMutation.isPending}>
                {inviteMutation.isPending ? 'Sending…' : 'Send invite'}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={sessionMember !== null} onOpenChange={(open) => !open && setSessionMember(null)}>
        <DialogContent className="sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">{sessionMember?.name}&apos;s sessions</DialogTitle>
            <DialogDescription>Recent sign-ins and devices that can still access this office.</DialogDescription>
          </DialogHeader>
          <ManagedSessionsState data={sessionsQuery.data} loading={sessionsQuery.isPending} error={sessionsQuery.error} />
          <DialogFooter><button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => setSessionMember(null)}>Close</button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change role dialog */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Change {editing?.name}’s role</DialogTitle>
            <DialogDescription>Their permissions change on their next request — no sign-out needed.</DialogDescription>
          </DialogHeader>
          <div>
            <span className={PANEL_LABEL}>Role</span>
            <Select value={editRole} onValueChange={(value) => setEditRole(value as OfficeRole)}>
              <SelectTrigger className="mt-1 h-9 text-xs" data-testid="select-edit-role" aria-label="Role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.filter((role) => role !== 'owner' || canEditOwners).map((role) => (
                  <SelectItem key={role} value={role} className="text-xs">{OFFICE_ROLE_LABELS[role]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{OFFICE_ROLE_HELP[editRole]}</p>
          </div>
          <DialogFooter>
            <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-edit-submit" onClick={() => editing && roleMutation.mutate({ member: editing, role: editRole })} disabled={roleMutation.isPending || !editing || editing.role === editRole}>
              {roleMutation.isPending ? 'Saving…' : 'Save role'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Status / sign-out confirmation */}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-navy">
              {confirming?.action === 'deactivate' && `Deactivate ${confirming.member?.name}?`}
              {confirming?.action === 'reactivate' && `Reactivate ${confirming.member?.name}?`}
              {confirming?.action === 'sign-out' && `Sign ${confirming.member?.name} out everywhere?`}
              {confirming?.action === 'clear-phone' && `Clear ${confirming.member?.name}’s sign-in phone?`}
              {confirming?.action === 'clear-owner-phone' && 'Clear the account owner’s sign-in phone?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.action === 'deactivate' && 'Their login stops working immediately on every device and the dashboard. You can reactivate them later without a new invitation.'}
              {confirming?.action === 'reactivate' && 'Their existing login works again with the same email code sign-in. Nothing needs to be re-sent.'}
              {confirming?.action === 'sign-out' && 'Every signed-in device is signed out now. Their access stays on — they simply sign in again.'}
              {(confirming?.action === 'clear-phone' || confirming?.action === 'clear-owner-phone') && 'They’ll need to add and verify a mobile number at their next sign-in.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
           {confirming?.action === 'sign-out' && (
             <div>
               <span className={PANEL_LABEL}>Reason</span>
               <Select value={signOutReason} onValueChange={(value) => setSignOutReason(value as Exclude<SecurityReason, 'patient_request'>)}>
                 <SelectTrigger className="mt-1 h-9 text-xs" data-testid="select-sign-out-reason" aria-label="Reason"><SelectValue /></SelectTrigger>
                 <SelectContent>
                   <SelectItem value="lost_device">Lost device</SelectItem>
                   <SelectItem value="suspicious_activity">Suspicious activity</SelectItem>
                   <SelectItem value="staff_request">Staff request</SelectItem>
                   <SelectItem value="other">Other</SelectItem>
                 </SelectContent>
               </Select>
             </div>
           )}
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={`text-xs ${confirming?.action === 'deactivate' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}`}
              data-testid="button-status-confirm"
              onClick={(event) => { event.preventDefault(); if (confirming) statusMutation.mutate(confirming); }}
              disabled={statusMutation.isPending}
            >
               {statusMutation.isPending
                 ? 'Working…'
                 : confirming?.action === 'deactivate'
                   ? 'Deactivate'
                   : confirming?.action === 'reactivate'
                     ? 'Reactivate'
                     : confirming?.action === 'clear-phone' || confirming?.action === 'clear-owner-phone'
                       ? 'Clear sign-in phone'
                       : 'Sign out'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MemberIdentity({ name, email, suffix }: { name: string; email: string; suffix: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-navy text-[10px] font-bold text-brand-foreground shadow-xs" aria-hidden="true">
        {initialsOf(name)}
      </span>
      <span className="min-w-0">
        <b className="block truncate text-xs font-semibold text-navy">{name}{suffix}</b>
        <small className="block truncate text-[10px] text-muted-foreground">{email || '—'}</small>
      </span>
    </div>
  );
}
