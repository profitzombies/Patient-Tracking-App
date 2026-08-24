/**
 * THINNR team management — HQ staff, distinct from office providers.
 *
 * All actions are simulated: invites, role changes, and removals mutate the
 * session-only HQ store (sessionStorage), so the page demos the workflow
 * without accounts or email. The Owner seat is intentionally immovable — a
 * demo shouldn't let you orphan the org.
 */
import { useState } from 'react';
import { UserPlus } from 'lucide-react';
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
import { HQ_ROLE_NOTES, type HqRole, type HqTeamMember } from '@/data/hq/team';

const ROLES: HqRole[] = ['Owner', 'Admin', 'Clinical', 'Support', 'Content'];
/** Roles offered on invite — a demo org has exactly one Owner. */
const INVITE_ROLES: HqRole[] = ['Admin', 'Clinical', 'Support', 'Content'];

const NEUTRAL_CHIP =
  'inline-flex items-center gap-1.5 rounded-sm border border-border bg-secondary px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.06em] text-foreground';

function RoleChip({ role }: { role: HqRole }) {
  return <span className={role === 'Owner' ? CHIP_COBALT : NEUTRAL_CHIP}>{role}</span>;
}

export default function Team() {
  const { team, inviteTeamMember, updateTeamMember, removeTeamMember } = useHqData();
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

  const submitInvite = () => {
    const name = inviteName.trim();
    const email = inviteEmail.trim();
    if (!name || !email.includes('@')) {
      toast({ title: 'Name and a valid email are required', description: 'Both fields are needed to send the (simulated) invite.' });
      return;
    }
    inviteTeamMember({ name, email, role: inviteRole, title: inviteTitle.trim() || inviteRole });
    toast({ title: `Invite sent to ${name}`, description: `Simulated — they join as ${inviteRole} for this demo session.` });
    setInviteOpen(false);
    setInviteName('');
    setInviteEmail('');
    setInviteTitle('');
    setInviteRole('Support');
  };

  const openEdit = (member: HqTeamMember) => {
    setEditing(member);
    setEditRole(member.role);
    setEditTitle(member.title);
  };

  const submitEdit = () => {
    if (!editing) return;
    updateTeamMember(editing.id, { role: editRole, title: editTitle.trim() || editing.title });
    toast({ title: `${editing.name} updated`, description: 'Changes apply to this demo session.' });
    setEditing(null);
  };

  const confirmRemove = () => {
    if (!removing) return;
    removeTeamMember(removing.id);
    toast({ title: `${removing.name} removed`, description: 'Simulated — the seat frees up for this demo session.' });
    setRemoving(null);
  };

  return (
    <AdminPage>
      <PageHeader
        kicker="THINNR team"
        title="People at headquarters"
        sub="The staff running the umbrella — separate from the provider offices they support. Invites, edits, and removals are simulated and last for this demo session."
        action={
          <button type="button" className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-invite" onClick={() => setInviteOpen(true)}>
            <UserPlus size={14} aria-hidden="true" />
            Invite teammate
          </button>
        }
      />

      <SectionCard title="Team roster" sub={`${team.length} people · one Owner seat`}>
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
                  <td className="px-3 py-3 text-foreground">{member.title}</td>
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
                      {member.role === 'Owner' ? (
                        <span className="text-[10px] text-muted-foreground" title="The Owner seat can't be removed in this demo.">
                          Owner seat
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
      </SectionCard>

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Invite a teammate</DialogTitle>
            <DialogDescription>Simulated invite — no email is sent; they appear in the roster immediately.</DialogDescription>
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
                  {INVITE_ROLES.map((role) => (
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
            <button type="button" className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-invite-submit" onClick={submitInvite}>
              Send invite
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Edit {editing?.name}</DialogTitle>
            <DialogDescription>Role and title only — identity fields stay fixed in the demo.</DialogDescription>
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
              <Select value={editRole} onValueChange={(value) => setEditRole(value as HqRole)} disabled={editing?.role === 'Owner'}>
                <SelectTrigger className="mt-1 h-9 text-xs" data-testid="select-edit-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(editing?.role === 'Owner' ? ROLES : INVITE_ROLES).map((role) => (
                    <SelectItem key={role} value={role} className="text-xs">{role}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {editing?.role === 'Owner' ? 'The Owner role is fixed in this demo.' : HQ_ROLE_NOTES[editRole]}
              </p>
            </div>
          </div>
          <DialogFooter>
            <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="button" className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-edit-submit" onClick={submitEdit}>
              Save changes
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
              They lose access to THINNR HQ (simulated). This only affects the current demo session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-xs text-destructive-foreground hover:bg-destructive/90" data-testid="button-remove-confirm" onClick={confirmRemove}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminPage>
  );
}
