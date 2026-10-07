/**
 * Office patient groups UI: the Groups manager on the Patients page, the
 * Groups control in a patient record's header, and the compact tags on
 * roster rows.
 *
 * Everything reads one `PatientGroupsApi` (hooks/use-patient-groups.ts), so
 * the signed-in office, the HQ drill-in (read-only: tags and lists, never a
 * create / rename / delete / add / remove control) and the guided demo render
 * the same components over different data paths. Membership is never
 * fetched per row: the manager derives a group's members from the roster
 * rows' own `groupIds`, and the detail control from the record's.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Pencil, Plus, Search, Tags, Trash2, X } from 'lucide-react';
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { useToast } from '@/hooks/use-toast';
import type { PatientGroupsApi } from '@/hooks/use-patient-groups';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, LINK_ACTION, PANEL_LABEL } from '@/components/patient/heritage';
import type { PatientGroup } from '@/lib/office-roster';
import { cn } from '@/lib/utils';

export const GROUPS_EMPTY_COPY = 'No groups yet — create one to organize your roster.';
const NAME_MAX = 60;
const DESCRIPTION_MAX = 200;

/** The slice of a roster row the manager needs. */
export interface GroupRosterEntry {
  id: string;
  name: string;
  email: string | null;
  groupIds: readonly string[];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong. Try again.');

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Compact group tags for a roster row: up to `max` names, then "+N". */
export function PatientGroupTags({ groupIds, groups, max = 2, className }: {
  groupIds: readonly string[];
  groups: readonly PatientGroup[];
  max?: number;
  className?: string;
}) {
  // Office order (the list is name-sorted), not membership order, so the same
  // patient reads the same way on every row and screen.
  const names = useMemo(() => groups.filter((group) => groupIds.includes(group.id)).map((group) => group.name), [groupIds, groups]);
  if (names.length === 0) return null;
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return (
    <span className={cn('flex flex-wrap items-center gap-1', className)} aria-label={`Groups: ${names.join(', ')}`} data-testid="patient-group-tags">
      {shown.map((name) => (
        <span key={name} className="inline-flex h-5 max-w-[9rem] items-center truncate rounded-full border border-accent-border bg-accent px-2 text-[10px] font-semibold text-primary" title={name}>
          {name}
        </span>
      ))}
      {rest > 0 && (
        <span className="inline-flex h-5 items-center rounded-full border border-border bg-paper-alt px-1.5 text-[10px] font-semibold text-muted-foreground" title={names.slice(max).join(', ')} data-testid="patient-group-tags-more">
          +{rest}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Group form (create / rename)
// ---------------------------------------------------------------------------

function GroupForm({ initial, submitLabel, onSubmit, onCancel, testId }: {
  initial?: Pick<PatientGroup, 'name' | 'description'>;
  submitLabel: string;
  onSubmit: (input: { name: string; description: string | null }) => Promise<void>;
  onCancel?: () => void;
  testId: string;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError('Enter a group name.'); return; }
    if (trimmed.length > NAME_MAX) { setError(`Keep the name under ${NAME_MAX} characters.`); return; }
    setPending(true);
    setError(null);
    try {
      await onSubmit({ name: trimmed, description: description.trim() ? description.trim() : null });
      if (!initial) { setName(''); setDescription(''); }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-2" data-testid={testId}>
      <label className="block">
        <span className={PANEL_LABEL}>Group name</span>
        <input
          className={`${INPUT_CLASS} mt-1 h-9 w-full`}
          value={name}
          maxLength={NAME_MAX}
          onChange={(event) => { setName(event.target.value); if (error) setError(null); }}
          placeholder="e.g. MJH"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${testId}-error` : undefined}
          data-testid={`${testId}-name`}
        />
      </label>
      <label className="block">
        <span className={PANEL_LABEL}>Description <span className="font-normal normal-case tracking-normal">(optional)</span></span>
        <input
          className={`${INPUT_CLASS} mt-1 h-9 w-full`}
          value={description}
          maxLength={DESCRIPTION_MAX}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="e.g. MJH employer wellness cohort"
          data-testid={`${testId}-description`}
        />
      </label>
      {error && <p id={`${testId}-error`} role="alert" className="text-[11px] font-medium text-destructive">{error}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        {onCancel && <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} onClick={onCancel}>Cancel</button>}
        <button type="submit" className={`${BTN_PRIMARY} h-8 px-3`} disabled={pending} data-testid={`${testId}-submit`}>
          {pending ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

function DeleteGroupButton({ group, onDelete }: { group: PatientGroup; onDelete: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = group.memberCount;
  return (
    <>
      <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5 text-destructive hover:bg-destructive/10`} onClick={() => setOpen(true)} data-testid="button-delete-group">
        <Trash2 size={13} aria-hidden="true" /> Delete
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-navy">Delete “{group.name}”?</AlertDialogTitle>
            <AlertDialogDescription data-testid="delete-group-description">
              {count === 0
                ? 'This group has no patients. '
                : `This group contains ${count} patient${count === 1 ? '' : 's'}; they stay on your roster and only lose this tag. `}
              Saved filters that use this group stop applying.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p role="alert" className="text-[11px] font-medium text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel className={`${BTN_SECONDARY} h-9 px-3.5`}>Keep group</AlertDialogCancel>
            <AlertDialogAction
              className={`${BTN_PRIMARY} h-9 bg-destructive px-3.5 text-white hover:bg-destructive/90`}
              disabled={pending}
              data-testid="button-confirm-delete-group"
              onClick={(event) => {
                event.preventDefault();
                setPending(true);
                setError(null);
                onDelete().then(() => setOpen(false)).catch((caught: unknown) => setError(errorText(caught))).finally(() => setPending(false));
              }}
            >
              {pending ? 'Deleting…' : 'Delete group'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function matchesQuery(entry: GroupRosterEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return entry.name.toLowerCase().includes(q) || (entry.email ?? '').toLowerCase().includes(q);
}

export function PatientGroupsManager({ api, roster }: { api: PatientGroupsApi; roster: readonly GroupRosterEntry[] }) {
  const { toast } = useToast();
  const { groups, canEdit } = api;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  const selected = groups.find((group) => group.id === selectedId) ?? null;
  // Default to the first group; follow deletions back to the list.
  useEffect(() => {
    if (groups.length === 0) { if (selectedId !== null) setSelectedId(null); return; }
    if (!groups.some((group) => group.id === selectedId)) setSelectedId(groups[0].id);
  }, [groups, selectedId]);
  useEffect(() => { setRenaming(false); setQuery(''); setMemberError(null); }, [selectedId]);

  const members = useMemo(() => (selected ? roster.filter((entry) => entry.groupIds.includes(selected.id)) : []), [roster, selected]);
  const candidates = useMemo(() => {
    if (!selected || !query.trim()) return [];
    return roster.filter((entry) => !entry.groupIds.includes(selected.id) && matchesQuery(entry, query)).slice(0, 8);
  }, [roster, selected, query]);

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setMemberError(null);
    try { await work(); } catch (caught) { setMemberError(errorText(caught)); } finally { setBusy(null); }
  };

  if (api.isLoading) return <p className="py-6 text-center text-xs text-muted-foreground" data-testid="groups-loading">Loading groups…</p>;
  if (api.error) {
    return (
      <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive" data-testid="groups-error">
        <p>Groups could not be loaded: {api.error.message}</p>
        <button type="button" className={`${LINK_ACTION} mt-1`} onClick={api.refetch}>Try again</button>
      </div>
    );
  }

  const createForm = creating && canEdit && (
    <div className="rounded-md border border-border bg-paper-alt p-3">
      <GroupForm
        submitLabel="Create group"
        testId="form-create-group"
        onCancel={() => setCreating(false)}
        onSubmit={async (input) => {
          const group = await api.create(input);
          setCreating(false);
          setSelectedId(group.id);
          toast({ variant: 'success', title: `Group “${group.name}” created` });
        }}
      />
    </div>
  );

  if (groups.length === 0) {
    return (
      <div className="space-y-3" data-testid="groups-empty">
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">{GROUPS_EMPTY_COPY}</p>
        {canEdit && !creating && (
          <button type="button" className={`${BTN_PRIMARY} h-9 w-full px-3.5`} onClick={() => setCreating(true)} data-testid="button-new-group">
            <Plus size={14} aria-hidden="true" /> New group
          </button>
        )}
        {createForm}
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]" data-testid="groups-manager">
      <div className="space-y-2">
        <ul aria-label="Groups" className="divide-y divide-border overflow-hidden rounded-md border border-border" data-testid="groups-list">
          {groups.map((group) => (
            <li key={group.id}>
              <button
                type="button"
                aria-pressed={group.id === selectedId}
                onClick={() => setSelectedId(group.id)}
                data-testid={`group-item-${group.id}`}
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  group.id === selectedId ? 'bg-accent text-primary' : 'text-foreground',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{group.name}</span>
                  {group.description && <span className="block truncate text-[10px] text-muted-foreground">{group.description}</span>}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground" aria-label={`${group.memberCount} patients`}>{group.memberCount}</span>
              </button>
            </li>
          ))}
        </ul>
        {canEdit && !creating && (
          <button type="button" className={`${BTN_SECONDARY} h-8 w-full px-3`} onClick={() => setCreating(true)} data-testid="button-new-group">
            <Plus size={13} aria-hidden="true" /> New group
          </button>
        )}
        {createForm}
      </div>

      {selected && (
        <section aria-label={`Group ${selected.name}`} className="min-w-0 space-y-3" data-testid="group-detail">
          {renaming && canEdit ? (
            <div className="rounded-md border border-border bg-paper-alt p-3">
              <GroupForm
                initial={selected}
                submitLabel="Save"
                testId="form-rename-group"
                onCancel={() => setRenaming(false)}
                onSubmit={async (input) => {
                  await api.rename(selected.id, input);
                  setRenaming(false);
                }}
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate font-serif text-base font-semibold text-navy" data-testid="group-detail-name">{selected.name}</h3>
                <p className="text-[11px] text-muted-foreground">
                  {selected.description ? `${selected.description} · ` : ''}
                  {selected.memberCount} patient{selected.memberCount === 1 ? '' : 's'}
                </p>
              </div>
              {canEdit && (
                <div className="flex shrink-0 items-center gap-2">
                  <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5`} onClick={() => setRenaming(true)} data-testid="button-rename-group">
                    <Pencil size={13} aria-hidden="true" /> Rename
                  </button>
                  <DeleteGroupButton
                    group={selected}
                    onDelete={async () => {
                      const result = await api.remove(selected.id);
                      toast({ title: `Group “${selected.name}” deleted`, description: result.memberCount > 0 ? `${result.memberCount} patient${result.memberCount === 1 ? '' : 's'} untagged.` : undefined });
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {canEdit && (
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <label htmlFor="group-add-search" className="sr-only">Search the roster to add patients to {selected.name}</label>
              <input
                id="group-add-search"
                className={`${INPUT_CLASS} h-9 w-full pl-9`}
                placeholder="Add a patient by name or email…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                data-testid="input-group-add-search"
              />
              {query.trim() && (
                <ul aria-label="Patients to add" className="mt-1 divide-y divide-border overflow-hidden rounded-md border border-border bg-card" data-testid="group-add-results">
                  {candidates.length === 0 && <li className="px-3 py-2 text-[11px] text-muted-foreground">No matching patients outside this group.</li>}
                  {candidates.map((entry) => (
                    <li key={entry.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-navy">{entry.name}</span>
                        {entry.email && <span className="block truncate text-[10px] text-muted-foreground">{entry.email}</span>}
                      </span>
                      <button
                        type="button"
                        className={`${BTN_PRIMARY} h-7 shrink-0 px-2.5`}
                        disabled={busy === `add:${entry.id}`}
                        onClick={() => void run(`add:${entry.id}`, () => api.addMember(selected.id, entry.id))}
                        data-testid={`button-group-add-${entry.id}`}
                      >
                        <Plus size={12} aria-hidden="true" /> Add
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {memberError && <p role="alert" className="text-[11px] font-medium text-destructive" data-testid="group-member-error">{memberError}</p>}

          <div>
            <p className={PANEL_LABEL}>Members</p>
            {members.length === 0 ? (
              <p className="mt-1 rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground" data-testid="group-members-empty">
                {canEdit ? 'No patients in this group yet. Search above to add some.' : 'No patients in this group.'}
              </p>
            ) : (
              <ul aria-label={`Members of ${selected.name}`} className="mt-1 max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border" data-testid="group-members">
                {members.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs" data-testid={`group-member-${entry.id}`}>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-navy">{entry.name}</span>
                      {entry.email && <span className="block truncate text-[10px] text-muted-foreground">{entry.email}</span>}
                    </span>
                    {canEdit && (
                      <button
                        type="button"
                        aria-label={`Remove ${entry.name} from ${selected.name}`}
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        disabled={busy === `remove:${entry.id}`}
                        onClick={() => void run(`remove:${entry.id}`, () => api.removeMember(selected.id, entry.id))}
                        data-testid={`button-group-remove-${entry.id}`}
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/** Toolbar button on the Patients page that hosts the manager (dialog on desktop, bottom sheet on phones). */
export function PatientGroupsButton({ api, roster }: { api: PatientGroupsApi; roster: readonly GroupRosterEntry[] }) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const count = api.groups.length;
  const trigger = (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(true)}
      data-testid="button-groups"
      className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-2.5 text-xs font-semibold text-navy shadow-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Tags size={14} aria-hidden="true" />
      Groups
      {count > 0 && <span className="rounded-full bg-accent px-1.5 font-mono text-[10px] text-primary" aria-label={`${count} groups`}>{count}</span>}
    </button>
  );
  const description = api.canEdit
    ? 'Organize your roster into named groups, then filter by them.'
    : 'Groups this office uses to organize its roster (view only).';
  const body = <PatientGroupsManager api={api} roster={roster} />;
  if (isMobile) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto rounded-t-lg" data-testid="groups-sheet">
            <SheetHeader className="text-left">
              <SheetTitle className="font-serif text-navy">Patient groups</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </SheetHeader>
            <div className="mt-4">{body}</div>
          </SheetContent>
        </Sheet>
      </>
    );
  }
  return (
    <>
      {trigger}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[680px]" data-testid="groups-dialog">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Patient groups</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Patient record control
// ---------------------------------------------------------------------------

/**
 * Header control on a patient record: the patient's groups as removable
 * tags, plus "Add to group" over the office's groups (or a new one inline).
 * Read-only callers (HQ drill-in, sealed charts) get the tags alone.
 */
export function PatientGroupsControl({ api, patientId, patientName, groupIds, readOnly = false }: {
  api: PatientGroupsApi;
  patientId: string;
  patientName: string;
  groupIds: readonly string[];
  readOnly?: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = api.canEdit && !readOnly;
  const current = api.groups.filter((group) => groupIds.includes(group.id));
  const available = api.groups.filter((group) => !groupIds.includes(group.id));

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try { await work(); } catch (caught) { setError(errorText(caught)); } finally { setBusy(null); }
  };

  const tags = current.length > 0
    ? (
      <ul aria-label={`${patientName}’s groups`} className="flex flex-wrap items-center gap-1.5" data-testid="patient-detail-groups">
        {current.map((group) => (
          <li key={group.id} className="inline-flex h-6 items-center gap-1 rounded-full border border-accent-border bg-accent pl-2.5 pr-1 text-[11px] font-semibold text-primary" data-testid={`patient-group-tag-${group.id}`}>
            <span className="max-w-[10rem] truncate">{group.name}</span>
            {canEdit ? (
              <button
                type="button"
                aria-label={`Remove from ${group.name}`}
                disabled={busy === `remove:${group.id}`}
                onClick={() => void run(`remove:${group.id}`, () => api.removeMember(group.id, patientId))}
                className="grid h-4 w-4 place-items-center rounded-full transition-colors hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                data-testid={`button-patient-group-remove-${group.id}`}
              >
                <X size={10} aria-hidden="true" />
              </button>
            ) : <span className="w-1.5" aria-hidden="true" />}
          </li>
        ))}
      </ul>
    )
    : <span className="text-[11px] text-muted-foreground" data-testid="patient-detail-groups-empty">{api.isLoading ? 'Loading groups…' : 'Not in any group'}</span>;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="patient-groups-control">
      {tags}
      {api.error && <span role="alert" className="text-[11px] text-destructive">Groups unavailable: {api.error.message}</span>}
      {canEdit && (
        <>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className={`${BTN_SECONDARY} h-8 px-2.5`}
            data-testid="button-patient-groups"
          >
            <Tags size={13} aria-hidden="true" /> Groups
          </button>
          <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setCreating(false); setError(null); } }}>
            <DialogContent className="sm:max-w-[420px]" data-testid="patient-groups-dialog">
              <DialogHeader>
                <DialogTitle className="font-serif text-navy">Groups for {patientName}</DialogTitle>
                <DialogDescription>Add this patient to any of the office’s groups, or start a new one.</DialogDescription>
              </DialogHeader>
              {error && <p role="alert" className="text-[11px] font-medium text-destructive" data-testid="patient-groups-error">{error}</p>}
              {api.groups.length === 0 && !creating && (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{GROUPS_EMPTY_COPY}</p>
              )}
              {api.groups.length > 0 && (
                <ul aria-label="Office groups" className="divide-y divide-border overflow-hidden rounded-md border border-border" data-testid="patient-groups-options">
                  {api.groups.map((group) => {
                    const member = groupIds.includes(group.id);
                    const key = `${member ? 'remove' : 'add'}:${group.id}`;
                    return (
                      <li key={group.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-navy">{group.name}</span>
                          {group.description && <span className="block truncate text-[10px] text-muted-foreground">{group.description}</span>}
                        </span>
                        <button
                          type="button"
                          aria-pressed={member}
                          disabled={busy === key}
                          onClick={() => void run(key, () => (member ? api.removeMember(group.id, patientId) : api.addMember(group.id, patientId)))}
                          className={`${member ? BTN_PRIMARY : BTN_SECONDARY} h-7 shrink-0 px-2.5`}
                          data-testid={`button-patient-group-toggle-${group.id}`}
                        >
                          {member ? <><Check size={12} aria-hidden="true" /> Member</> : <><Plus size={12} aria-hidden="true" /> Add</>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {creating ? (
                <div className="rounded-md border border-border bg-paper-alt p-3">
                  <GroupForm
                    submitLabel="Create and add"
                    testId="form-create-group-inline"
                    onCancel={() => setCreating(false)}
                    onSubmit={async (input) => {
                      const group = await api.create(input);
                      await api.addMember(group.id, patientId);
                      setCreating(false);
                      toast({ variant: 'success', title: `Added to new group “${group.name}”` });
                    }}
                  />
                </div>
              ) : (
                <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} onClick={() => setCreating(true)} data-testid="button-patient-groups-new">
                  <Plus size={13} aria-hidden="true" /> New group
                </button>
              )}
              {available.length === 0 && api.groups.length > 0 && !creating && (
                <p className="text-[11px] text-muted-foreground">{patientName} is in every group.</p>
              )}
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
