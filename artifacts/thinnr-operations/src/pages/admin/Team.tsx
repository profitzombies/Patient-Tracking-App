/**
 * THINNR team management — HQ staff, distinct from office providers.
 *
 * The roster and every mutation are backed by the authenticated HQ API.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { ManagedSessionsState } from '@/components/team/ManagedSessions';
import { fetchHqTeamMemberSessions, signOutHqTeamMember, type SecurityReason } from '@/lib/office-api';
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
import { BTN_PRIMARY, BTN_SECONDARY, CHIP_COBALT, INPUT_CLASS, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { AdminPage, PageHeader, TeamStatusChip } from '@/components/admin/primitives';
import { useHqData } from '@/contexts/hq-data';
import { HQ_TEAM_QUERY_KEY } from '@/contexts/hq-data';
import { useSession } from '@/contexts/session';
import { clearHqTeamMemberSecondFactor, HqTeamError, type HqResendableCollision, type InvitationDelivery } from '@/lib/hq-team';
import { HQ_ROLE_NOTES, INVITABLE_HQ_ROLES, type HqRole, type HqTeamMember } from '@/data/hq/team';

const NEUTRAL_CHIP =
  'inline-flex items-center gap-1.5 rounded-sm border border-border bg-secondary px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.06em] text-foreground';

function RoleChip({ role }: { role: HqRole }) {
  return <span className={role === 'Super Admin' ? CHIP_COBALT : NEUTRAL_CHIP}>{role}</span>;
}

/** Why an emailed setup link did not go out, in words an administrator can act on. */
function deliveryProblem(outcome: Exclude<InvitationDelivery, 'sent'>): string {
  if (outcome === 'not_configured') {
    return 'Email delivery is not configured in this environment, so no setup link was sent. Their invitation is waiting — re-send it once delivery is set up.';
  }
  if (outcome === 'no_link') {
    return 'The setup link could not be built, so the email was not sent. Re-send the invitation to issue a new link.';
  }
  return 'The email provider refused the message, so the setup link did not arrive. Their invitation is waiting — use Resend invitation to try again.';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function Team() {
  const {
    team, teamStatus, teamError, inviteTeamMember, updateTeamMember, removeTeamMember,
    resendTeamInvitation, cancelTeamInvitation, teamMutationPending,
  } = useHqData();
  const { toast } = useToast();
  const { authUser } = useSession();
  const queryClient = useQueryClient();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteTitle, setInviteTitle] = useState('');
  const [inviteRole, setInviteRole] = useState<HqRole>('Support');
  // The dialog keeps the failure in view: a toast disappears before an
  // administrator can read which record is holding the email.
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteResendable, setInviteResendable] = useState<HqResendableCollision | null>(null);

  const [cancelling, setCancelling] = useState<HqTeamMember | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [editing, setEditing] = useState<HqTeamMember | null>(null);
  const [editRole, setEditRole] = useState<HqRole>('Support');
  const [editTitle, setEditTitle] = useState('');

  const [removing, setRemoving] = useState<HqTeamMember | null>(null);
  const [sessionMember, setSessionMember] = useState<HqTeamMember | null>(null);
  const [profileMember, setProfileMember] = useState<HqTeamMember | null>(null);
  const [clearingPhone, setClearingPhone] = useState<HqTeamMember | null>(null);

  // Deep link from audit trails (?member=<roster id>): open that teammate's
  // profile once the live roster is in, then drop the param so a refresh or
  // back-navigation does not reopen it.
  const search = useSearch();
  const [, navigate] = useLocation();
  const handledMember = useRef<string | null>(null);
  const requestedMember = new URLSearchParams(search).get('member');
  useEffect(() => {
    if (!requestedMember || teamStatus !== 'ready' || handledMember.current === requestedMember) return;
    handledMember.current = requestedMember;
    const member = team.find((candidate) => candidate.id === requestedMember);
    if (member) setProfileMember(member);
    else toast({ variant: 'destructive', title: 'Teammate not found', description: 'They may have been removed from the HQ team.' });
    navigate('/admin/team', { replace: true });
  }, [requestedMember, teamStatus, team, navigate, toast]);
  const [signOutReason, setSignOutReason] = useState<Exclude<SecurityReason, 'patient_request'>>('staff_request');
  const sessionsQuery = useQuery({
    queryKey: ['hq-team-sessions', sessionMember?.id],
    queryFn: () => fetchHqTeamMemberSessions(sessionMember!.id),
    enabled: Boolean(sessionMember),
    retry: false,
  });
  const forceSignOut = useMutation({
    mutationFn: () => signOutHqTeamMember(sessionMember!.id, signOutReason),
    onSuccess: async () => {
      toast({ variant: 'success', title: `${sessionMember?.name} signed out everywhere`, description: 'They will need to sign in again on every device. Their access stays on.' });
      await sessionsQuery.refetch();
    },
    onError: (error) => toast({ variant: 'destructive', title: 'Could not force sign-out', description: error instanceof Error ? error.message : 'Try again.' }),
  });
  const clearPhone = useMutation({
    mutationFn: () => clearHqTeamMemberSecondFactor(clearingPhone!.id),
    onSuccess: async () => {
      toast({ variant: 'success', title: 'Sign-in phone cleared', description: 'They’ll add a phone at their next sign-in.' });
      setClearingPhone(null);
      await queryClient.invalidateQueries({ queryKey: HQ_TEAM_QUERY_KEY });
    },
    onError: (error) => toast({ variant: 'destructive', title: 'Could not clear sign-in phone', description: error instanceof Error ? error.message : 'Try again.' }),
  });

  const closeInvite = () => {
    setInviteOpen(false);
    setInviteName('');
    setInviteEmail('');
    setInviteTitle('');
    setInviteRole('Support');
    setInviteError(null);
    setInviteResendable(null);
  };

  const submitInvite = async () => {
    const name = inviteName.trim();
    const email = inviteEmail.trim();
    setInviteError(null);
    setInviteResendable(null);
    if (!name || !email.includes('@')) {
      setInviteError('Enter a full name and a valid work email — both are needed to send the setup link.');
      return;
    }
    try {
      const result = await inviteTeamMember({ name, email, role: inviteRole as Exclude<HqRole, 'Super Admin'>, title: inviteTitle.trim() });
      if (result.invitation === 'sent') {
        toast({ variant: 'success', title: `Invite sent to ${name}`, description: `Their email has a setup link; they join as ${inviteRole} once they use it.` });
        closeInvite();
        return;
      }
      // The teammate exists but has no usable link: keep the dialog open so
      // the administrator sees exactly what to do next.
      setInviteError(`${name} was added, but the setup email did not go out. ${deliveryProblem(result.invitation)}`);
    } catch (error) {
      if (error instanceof HqTeamError && error.resendable) {
        setInviteResendable(error.resendable);
        setInviteError(error.message);
        return;
      }
      setInviteError(errorMessage(
        error,
        'The invitation could not be sent. Try again, and tell another administrator if it keeps failing.',
      ));
    }
  };

  const sendAgain = async (member: { id: string; name: string }, options: { fromDialog?: boolean } = {}) => {
    try {
      const result = await resendTeamInvitation(member.id);
      if (result.invitation === 'sent') {
        toast({ variant: 'success', title: `New invitation sent to ${member.name}`, description: 'The previous setup link no longer works.' });
        if (options.fromDialog) closeInvite();
        return;
      }
      const problem = `${member.name}'s invitation was renewed, but the email did not go out. ${deliveryProblem(result.invitation)}`;
      if (options.fromDialog) setInviteError(problem);
      else toast({ variant: 'destructive', title: 'Setup email not sent', description: problem });
    } catch (error) {
      const message = errorMessage(error, 'The invitation could not be re-sent. Try again in a moment.');
      if (options.fromDialog) setInviteError(message);
      else toast({ variant: 'destructive', title: 'Invitation not re-sent', description: message });
    }
  };

  const confirmCancelInvitation = async () => {
    if (!cancelling) return;
    try {
      await cancelTeamInvitation(cancelling.id);
      toast({ variant: 'success', title: `${cancelling.name}'s invitation cancelled`, description: 'Their setup link no longer works.' });
      setCancelling(null);
    } catch (error) {
      toast({ variant: 'destructive', title: 'Invitation not cancelled', description: errorMessage(error, 'Try again.') });
    }
  };

  const openEdit = (member: HqTeamMember) => {
    setEditing(member);
    setEditRole(member.role);
    setEditTitle(member.title ?? '');
  };

  const submitEdit = async () => {
    if (!editing || editing.role === 'Super Admin') return;
    try {
      await updateTeamMember(editing.id, { role: editRole as Exclude<HqRole, 'Super Admin'>, title: editTitle.trim() });
      toast({ variant: 'success', title: `${editing.name} updated`, description: 'Their live access has been updated.' });
      setEditing(null);
    } catch (error) {
      toast({ variant: 'destructive', title: 'Changes not saved', description: error instanceof Error ? error.message : 'Try again.' });
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    setRemoveError(null);
    if (removing.role === 'Super Admin') {
      setRemoveError('The Super Admin is protected and cannot be removed here.');
      return;
    }
    try {
      const result = await removeTeamMember(removing.id);
      if (result.sessionInvalidation === 'failed') {
        // Access is already gone server-side; only the device sessions lingered.
        toast({
          variant: 'destructive',
          title: `${removing.name}'s access was revoked, but their devices were not signed out`,
          description: 'They can no longer reach HQ, but their open sessions could not be ended. Use Sessions → Sign out everywhere, or try again shortly.',
        });
      } else {
        toast({ variant: 'success', title: `${removing.name} removed`, description: 'Their THINNR HQ access has been revoked and their sessions ended.' });
      }
      setRemoving(null);
    } catch (error) {
      // The reauth sheet throws its own error after prompting; a refusal
      // (your own account, the last administrator, a protected Super Admin)
      // belongs in the dialog where the administrator is still looking.
      setRemoveError(errorMessage(error, 'The removal did not go through. Try again in a moment.'));
    }
  };

  return (
    <AdminPage>
      <PageHeader
        kicker="THINNR team"
        title="People at headquarters"
        sub="The staff running the umbrella — separate from the provider offices they support. Invitations and access changes apply to live THINNR accounts."
        action={
          <button type="button" className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-invite" onClick={() => setInviteOpen(true)} disabled={teamMutationPending}>
            <UserPlus size={14} aria-hidden="true" />
            Invite teammate
          </button>
        }
      />

      <SectionCard title="Team roster" sub={teamStatus === 'ready' ? `${team.length} ${team.length === 1 ? 'person' : 'people'} · protected Super Admin` : 'Live THINNR HQ accounts'}>
        {teamStatus === 'loading' && <p className="px-5 py-8 text-xs text-muted-foreground" data-testid="status-team-loading">Loading the live roster…</p>}
        {teamStatus === 'error' && <p className="px-5 py-8 text-xs text-destructive" role="alert" data-testid="status-team-error">{teamError ?? 'The live roster could not be loaded.'}</p>}
        {teamStatus === 'unauthorized' && <p className="px-5 py-8 text-xs text-muted-foreground" role="alert" data-testid="status-team-unauthorized">You do not have permission to manage the HQ team.</p>}
        {teamStatus === 'ready' && team.length === 0 && <p className="px-5 py-8 text-xs text-muted-foreground" data-testid="status-team-empty">No HQ teammates were returned.</p>}
        {teamStatus === 'ready' && team.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                <th className="px-5 py-3 font-bold">Member</th>
                <th className="px-3 py-3 font-bold">Title</th>
                <th className="px-3 py-3 font-bold">Role</th>
                <th className="px-3 py-3 font-bold">Status</th>
                <th className="px-3 py-3 font-bold">Sign-in phone</th>
                <th className="px-3 py-3 font-bold">Joined / invited</th>
                <th className="px-5 py-3 text-right font-bold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {team.map((member) => (
                <tr key={member.id} className="border-b border-border last:border-b-0" data-testid={`row-team-${member.id}`}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-navy text-[10px] font-bold text-brand-foreground shadow-xs">
                        {member.initials}
                      </span>
                      <span className="min-w-0">
                        <b className="block truncate text-xs font-semibold text-navy">{member.name}</b>
                        <small className="block truncate text-[10px] text-muted-foreground">{member.email}</small>
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-foreground">{member.title || '—'}</td>
                  <td className="px-3 py-3"><RoleChip role={member.role} /></td>
                  <td className="px-3 py-3"><TeamStatusChip status={member.status} /></td>
                  <td className="px-3 py-3 text-muted-foreground">{member.secondFactorPhone ?? 'No phone'}</td>
                  <td className="px-3 py-3 text-muted-foreground" data-testid={`text-joined-${member.id}`}>
                    {member.status === 'pending' ? (
                      <span className="block">
                        Invitation pending
                        <small className="block text-[10px]">
                          {member.invitationExpiresLabel
                            ? `Link expires ${member.invitationExpiresLabel}`
                            : 'No live setup link — re-send the invitation'}
                        </small>
                      </span>
                    ) : member.joinedLabel}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}
                        data-testid={`button-profile-${member.id}`}
                        onClick={() => setProfileMember(member)}
                      >
                        Profile
                      </button>
                      <button
                        type="button"
                        className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}
                        data-testid={`button-edit-${member.id}`}
                        onClick={() => openEdit(member)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}
                        data-testid={`button-sessions-${member.id}`}
                        onClick={() => { setSignOutReason('staff_request'); setSessionMember(member); }}
                      >
                        Sessions
                      </button>
                      <button
                        type="button"
                        className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px] text-destructive`}
                        data-testid={`button-clear-phone-${member.id}`}
                        disabled={!member.secondFactorPhone || member.authUserId === authUser?.id}
                        onClick={() => setClearingPhone(member)}
                      >
                        Clear sign-in phone
                      </button>
                      {member.status === 'pending' && member.role !== 'Super Admin' && (
                        <>
                          <button
                            type="button"
                            className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}
                            data-testid={`button-resend-${member.id}`}
                            disabled={teamMutationPending}
                            onClick={() => void sendAgain(member)}
                          >
                            Resend invitation
                          </button>
                          <button
                            type="button"
                            className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px] text-destructive`}
                            data-testid={`button-cancel-invite-${member.id}`}
                            onClick={() => setCancelling(member)}
                          >
                            Cancel invitation
                          </button>
                        </>
                      )}
                      {member.role === 'Super Admin' ? (
                        <span className="text-[10px] text-muted-foreground" title="Super Admin access is protected.">
                          Protected
                        </span>
                      ) : member.status === 'active' && (
                        <button
                          type="button"
                          className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px] text-destructive`}
                          data-testid={`button-remove-${member.id}`}
                          onClick={() => { setRemoveError(null); setRemoving(member); }}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </SectionCard>

      {/* Profile dialog (also the ?member= deep-link target) */}
      <Dialog open={profileMember !== null} onOpenChange={(open) => !open && setProfileMember(null)}>
        <DialogContent className="max-w-md" data-testid="dialog-team-profile">
          {profileMember && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-navy text-xs font-bold text-brand-foreground shadow-xs">
                    {profileMember.initials}
                  </span>
                  <div className="min-w-0">
                    <DialogTitle className="truncate">{profileMember.name}</DialogTitle>
                    <DialogDescription className="truncate">{profileMember.email}</DialogDescription>
                  </div>
                </div>
              </DialogHeader>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                <div>
                  <dt className={PANEL_LABEL}>Role</dt>
                  <dd className="mt-1"><RoleChip role={profileMember.role} /></dd>
                </div>
                <div>
                  <dt className={PANEL_LABEL}>Status</dt>
                  <dd className="mt-1"><TeamStatusChip status={profileMember.status} /></dd>
                </div>
                <div>
                  <dt className={PANEL_LABEL}>Title</dt>
                  <dd className="mt-1 text-foreground">{profileMember.title || '—'}</dd>
                </div>
                <div>
                  <dt className={PANEL_LABEL}>Joined</dt>
                  <dd className="mt-1 text-foreground">{profileMember.joinedLabel}</dd>
                </div>
              </dl>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{HQ_ROLE_NOTES[profileMember.role]}</p>
              <DialogFooter className="gap-2">
                <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => setProfileMember(null)}>Close</button>
                <button
                  type="button"
                  className={`${BTN_SECONDARY} h-9 px-3.5`}
                  data-testid="button-profile-sessions"
                  onClick={() => { const member = profileMember; setProfileMember(null); setSignOutReason('staff_request'); setSessionMember(member); }}
                >
                  Sessions
                </button>
                <button
                  type="button"
                  className={`${BTN_PRIMARY} h-9 px-3.5`}
                  data-testid="button-profile-edit"
                  onClick={() => { const member = profileMember; setProfileMember(null); openEdit(member); }}
                >
                  Edit access
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={(open) => (open ? setInviteOpen(true) : closeInvite())}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Invite a teammate</DialogTitle>
            <DialogDescription>The teammate signs in with a one-time code sent to their email — no password to set up.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="block">
              <span className={PANEL_LABEL}>Full name</span>
              <input
                className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                value={inviteName}
                onChange={(event) => setInviteName(event.target.value)}
                placeholder="e.g. Dana Whitfield"
                data-testid="input-invite-name"
              />
            </label>
            <label className="block">
              <span className={PANEL_LABEL}>Work email</span>
              <input
                className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="name@thinnr.example.com"
                data-testid="input-invite-email"
              />
            </label>
            <label className="block">
              <span className={PANEL_LABEL}>Title (optional)</span>
              <input
                className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                value={inviteTitle}
                onChange={(event) => setInviteTitle(event.target.value)}
                placeholder="e.g. Provider Success Manager"
                data-testid="input-invite-title"
              />
            </label>
            <div>
              <span className={PANEL_LABEL}>Role</span>
              <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as HqRole)}>
                <SelectTrigger className="mt-1 h-9 text-xs" data-testid="select-invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INVITABLE_HQ_ROLES.map((role) => (
                    <SelectItem key={role} value={role} className="text-xs">{role}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{HQ_ROLE_NOTES[inviteRole]}</p>
            </div>
            {inviteError && (
              <p
                role="alert"
                data-testid="text-invite-error"
                className="rounded-md border border-destructive-border bg-destructive/10 px-3 py-2 text-[11px] font-medium leading-relaxed text-destructive"
              >
                {inviteError}
              </p>
            )}
            {inviteResendable && (
              <button
                type="button"
                className={`${BTN_SECONDARY} h-9 w-full px-3.5`}
                data-testid="button-invite-resend"
                disabled={teamMutationPending}
                onClick={() => void sendAgain({ id: inviteResendable.memberId, name: inviteResendable.name || inviteEmail.trim() }, { fromDialog: true })}
              >
                {teamMutationPending ? 'Re-sending…' : 'Re-send that invitation instead'}
              </button>
            )}
          </div>
          <DialogFooter>
            <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={closeInvite}>
              Cancel
            </button>
            <button type="button" className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-invite-submit" onClick={() => void submitInvite()} disabled={teamMutationPending}>
              {teamMutationPending ? 'Sending…' : 'Send invite'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Edit {editing?.name}</DialogTitle>
            <DialogDescription>Update the teammate’s department access and job title.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="block">
              <span className={PANEL_LABEL}>Title</span>
              <input
                className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
                data-testid="input-edit-title"
              />
            </label>
            <div>
              <span className={PANEL_LABEL}>Role</span>
              <Select value={editRole} onValueChange={(value) => setEditRole(value as HqRole)} disabled={editing?.role === 'Super Admin'}>
                <SelectTrigger className="mt-1 h-9 text-xs" data-testid="select-edit-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(editing?.role === 'Super Admin' ? ['Super Admin'] as HqRole[] : INVITABLE_HQ_ROLES).map((role) => (
                    <SelectItem key={role} value={role} className="text-xs">{role}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                 {editing?.role === 'Super Admin' ? 'The Super Admin role cannot be changed here.' : HQ_ROLE_NOTES[editRole]}
              </p>
            </div>
          </div>
          <DialogFooter>
            <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="button" className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-edit-submit" onClick={() => void submitEdit()} disabled={teamMutationPending || editing?.role === 'Super Admin'}>
              {teamMutationPending ? 'Saving…' : 'Save changes'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Sessions + force sign-out */}
      <Dialog open={sessionMember !== null} onOpenChange={(open) => !open && setSessionMember(null)}>
        <DialogContent className="sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">{sessionMember?.name}&apos;s sessions</DialogTitle>
            <DialogDescription>Recent sign-ins and devices that can still reach THINNR HQ. Forcing a sign-out keeps their access; they simply sign in again.</DialogDescription>
          </DialogHeader>
          <ManagedSessionsState data={sessionsQuery.data} loading={sessionsQuery.isPending} error={sessionsQuery.error} />
          {sessionsQuery.data?.linked && (
            <div>
              <span className={PANEL_LABEL}>Reason</span>
              <Select value={signOutReason} onValueChange={(value) => setSignOutReason(value as Exclude<SecurityReason, 'patient_request'>)}>
                <SelectTrigger className="mt-1 h-9 text-xs" data-testid="select-hq-sign-out-reason" aria-label="Reason"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="staff_request" className="text-xs">Staff request</SelectItem>
                  <SelectItem value="lost_device" className="text-xs">Lost device</SelectItem>
                  <SelectItem value="suspicious_activity" className="text-xs">Suspicious activity</SelectItem>
                  <SelectItem value="other" className="text-xs">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter>
            <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => setSessionMember(null)}>Close</button>
            <button
              type="button"
              className={`${BTN_SECONDARY} h-9 px-3.5 text-destructive`}
              data-testid="button-hq-force-sign-out"
              disabled={!sessionsQuery.data?.linked || forceSignOut.isPending}
              onClick={() => forceSignOut.mutate()}
            >
              {forceSignOut.isPending ? 'Signing out…' : 'Sign out everywhere'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirmation */}
      <AlertDialog open={clearingPhone !== null} onOpenChange={(open) => !open && setClearingPhone(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-navy">Clear {clearingPhone?.name}’s sign-in phone?</AlertDialogTitle>
            <AlertDialogDescription>They’ll need to add and verify a mobile number at their next sign-in.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-clear-phone-confirm"
              onClick={(event) => { event.preventDefault(); clearPhone.mutate(); }}
              disabled={clearPhone.isPending}
            >
              {clearPhone.isPending ? 'Clearing…' : 'Clear sign-in phone'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cancelling !== null} onOpenChange={(open) => !open && setCancelling(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-navy">Cancel {cancelling?.name}’s invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              Their setup link will stop working and they will leave the roster. You can invite them again with the same email.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-xs text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-cancel-invite-confirm"
              onClick={(event) => { event.preventDefault(); void confirmCancelInvitation(); }}
              disabled={teamMutationPending}
            >
              {teamMutationPending ? 'Cancelling…' : 'Cancel invitation'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-navy">Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Their live THINNR HQ access will be revoked and their devices signed out. They will need a new invitation to regain access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError && (
            <p
              role="alert"
              data-testid="text-remove-error"
              className="rounded-md border border-destructive-border bg-destructive/10 px-3 py-2 text-[11px] font-medium leading-relaxed text-destructive"
            >
              {removeError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-xs text-destructive-foreground hover:bg-destructive/90" data-testid="button-remove-confirm" onClick={(event) => { event.preventDefault(); void confirmRemove(); }} disabled={teamMutationPending}>
              {teamMutationPending ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminPage>
  );
}
