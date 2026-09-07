/**
 * THINNR team management — HQ staff, distinct from office providers.
 *
 * The roster and every mutation are backed by the authenticated HQ API.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
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
import { HQ_ROLE_NOTES, INVITABLE_HQ_ROLES, type HqRole, type HqTeamMember } from '@/data/hq/team';

const NEUTRAL_CHIP =
  'inline-flex items-center gap-1.5 rounded-sm border border-border bg-secondary px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.06em] text-foreground';

function RoleChip({ role }: { role: HqRole }) {
  return <span className={role === 'Super Admin' ? CHIP_COBALT : NEUTRAL_CHIP}>{role}</span>;
}

export default function Team() {
  const { team, teamStatus, teamError, inviteTeamMember, updateTeamMember, removeTeamMember, teamMutationPending } = useHqData();
  const { toast } = useToast();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteTitle, setInviteTitle] = useState('');
  const [inviteRole, setInviteRole] = useState<HqRole>('Support');

  const [editing, setEditing] = useState<HqTeamMember | null>(null);
  const [editRole, setEditRole] = useState<HqRole>('Support');
  const [editTitle, setEditTitle] = useState('');

  const [removing, setRemoving] = useState<HqTeamMember | null>(null);
  const [sessionMember, setSessionMember] = useState<HqTeamMember | null>(null);
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

  const submitInvite = async () => {
    const name = inviteName.trim();
    const email = inviteEmail.trim();
    if (!name || !email.includes('@')) {
      toast({ variant: 'destructive', title: 'Name and a valid email are required', description: 'Both fields are needed to send the secure invitation.' });
      return;
    }
    try {
      const result = await inviteTeamMember({ name, email, role: inviteRole as Exclude<HqRole, 'Super Admin'>, title: inviteTitle.trim() });
      if (result.invitation === 'sent') {
        toast({ variant: 'success', title: `Invite sent to ${name}`, description: `They sign in with a one-time email code and join as ${inviteRole}.` });
      } else {
        toast({
          variant: 'destructive',
          title: `${name} was added, but the email was not sent`,
          description: result.invitation === 'not_configured'
            ? 'Invitation delivery is not configured. Their account remains pending.'
            : 'Invitation delivery failed. Their account remains pending; contact an administrator before retrying.',
        });
      }
      setInviteOpen(false);
      setInviteName('');
      setInviteEmail('');
      setInviteTitle('');
      setInviteRole('Support');
    } catch (error) {
      toast({ variant: 'destructive', title: 'Invitation not sent', description: error instanceof Error ? error.message : 'Try again.' });
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
    if (!removing || removing.role === 'Super Admin') return;
    try {
      await removeTeamMember(removing.id);
      toast({ variant: 'success', title: `${removing.name} removed`, description: 'Their THINNR HQ access has been revoked.' });
      setRemoving(null);
    } catch (error) {
      toast({ variant: 'destructive', title: 'Access not removed', description: error instanceof Error ? error.message : 'Try again.' });
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
                <th className="px-3 py-3 font-bold">Joined</th>
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
                  <td className="px-3 py-3 text-muted-foreground">{member.joinedLabel}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-2">
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
                      {member.role === 'Super Admin' ? (
                        <span className="text-[10px] text-muted-foreground" title="Super Admin access is protected.">
                          Protected
                        </span>
                      ) : (
                        <button
                          type="button"
                          className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px] text-destructive`}
                          data-testid={`button-remove-${member.id}`}
                          onClick={() => setRemoving(member)}
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

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
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
          </div>
          <DialogFooter>
            <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => setInviteOpen(false)}>
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
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-navy">Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Their live THINNR HQ access will be revoked. They will need a new invitation to regain access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-xs text-destructive-foreground hover:bg-destructive/90" data-testid="button-remove-confirm" onClick={() => void confirmRemove()} disabled={teamMutationPending}>
              {teamMutationPending ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminPage>
  );
}
