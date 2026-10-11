/**
 * HQ Diet library — one entry's editor, review controls and version history.
 *
 * Saves ride the version the editor opened (409 → "reload" notice, never a
 * silent overwrite). Editing anything but a draft sends the entry back to
 * draft on the server, and the form says so above the Save button. Review
 * moves that change what patients see (publish, retire, unpublish) ask a
 * second time; marking reviewed does not.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, History, RotateCw } from 'lucide-react';
import {
  getGetHqDietLibraryEntryQueryKey,
  getListHqDietLibraryQueryKey,
  reviewHqDietLibraryEntry,
  updateHqDietLibraryEntry,
  useGetHqDietLibraryEntry,
  type DietReviewStatus,
  type HqDietLibraryEntry,
  type HqDietLibraryEntryDetail,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { useSession } from '@/contexts/session';
import { AdminPage, PageHeader } from '@/components/admin/primitives';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, INSET, SectionCard } from '@/components/patient/heritage';
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
import { formatLocalDate } from '@/lib/local-time';
import {
  COMPLEXITIES,
  COMPLEXITY_LABELS,
  DIET_LIBRARY_PATH,
  EVIDENCE_LABELS,
  EVIDENCE_STRENGTHS,
  JUST_TRACKING_SLUG,
  NEUTRAL_CHIP,
  REVIEW_STATUS_HELP,
  REVIEW_STATUS_LABELS,
  SCREENING_LABELS,
  SCREENING_QUESTIONS,
  SUPERVISION_LABELS,
  SUPERVISION_LEVELS,
  describeApiProblem,
  entryToForm,
  formToPatch,
  publishBlockedReason,
  reviewStatusChipClass,
  reviewTransitionsFor,
  saveWarningFor,
  transitionConfirmCopy,
  validateForm,
  type EntryForm,
  type ReviewTransition,
} from '@/lib/diet-library';

const BTN_DANGER = 'inline-flex items-center justify-center gap-1.5 rounded-md border border-[#d5a7a7] bg-[#fff0f0] text-xs font-semibold text-destructive transition hover:bg-[#ffe3e3] disabled:cursor-not-allowed disabled:opacity-50';

function formatInstant(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${formatLocalDate(value)} ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

function Field({ label, hint, error, children, testId }: { label: string; hint?: string; error?: string; children: ReactNode; testId?: string }) {
  return (
    <label className="block text-xs">
      <span className="font-semibold text-foreground">{label}</span>
      {hint && <span className="ml-1 text-muted-foreground">{hint}</span>}
      <div className="mt-1">{children}</div>
      {error && <p className="mt-1 text-[11px] text-destructive" role="alert" data-testid={testId ? `error-${testId}` : undefined}>{error}</p>}
    </label>
  );
}

interface EditorProps {
  detail: HqDietLibraryEntryDetail;
  onSaved: (entry: HqDietLibraryEntry) => Promise<void>;
  onConflict: () => Promise<void>;
}

function EntryEditor({ detail, onSaved, onConflict }: EditorProps) {
  const { entry } = detail;
  const { toast } = useToast();
  const [form, setForm] = useState<EntryForm>(() => entryToForm(entry));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverProblem, setServerProblem] = useState<{ message: string; field: string | null; code: string | null } | null>(null);
  const [pending, setPending] = useState<ReviewTransition | null>(null);

  const problems = useMemo(() => validateForm(form), [form]);
  const problemFor = (field: keyof EntryForm) => (attempted ? problems.find((problem) => problem.field === field)?.message : undefined) ?? (serverProblem?.field === field ? serverProblem.message : undefined);
  const patch = useMemo(() => (problems.length === 0 ? formToPatch(form, entry) : null), [form, entry, problems.length]);
  const dirty = patch !== null;
  const warning = dirty ? saveWarningFor(entry) : null;
  const update = <K extends keyof EntryForm>(key: K, value: EntryForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setAttempted(true);
    setServerProblem(null);
    if (problems.length > 0) return;
    if (!patch) return;
    setBusy(true);
    try {
      const result = await updateHqDietLibraryEntry(entry.slug, patch);
      toast({
        variant: 'success',
        title: `Saved as version ${result.entry.version}`,
        description: result.unpublished
          ? 'The plan is back in draft and off the patient app until it is reviewed and published again.'
          : entry.slug === JUST_TRACKING_SLUG ? 'Just tracking stays available to patients.' : `Review status: ${REVIEW_STATUS_LABELS[result.entry.reviewStatus]}.`,
      });
      await onSaved(result.entry);
    } catch (error) {
      const problem = describeApiProblem(error, 'The entry could not be saved. Try again.');
      if (problem.code === 'RECORD_CHANGED') {
        setServerProblem({ ...problem, field: null });
        await onConflict();
      } else {
        setServerProblem(problem);
      }
    } finally {
      setBusy(false);
    }
  };

  const runTransition = async (transition: ReviewTransition) => {
    setBusy(true);
    setServerProblem(null);
    try {
      const result = await reviewHqDietLibraryEntry(entry.slug, { status: transition.to, expectedVersion: entry.version });
      toast({
        variant: 'success',
        title: `${entry.name} is now ${REVIEW_STATUS_LABELS[result.entry.reviewStatus].toLowerCase()}`,
        description: REVIEW_STATUS_HELP[result.entry.reviewStatus],
      });
      await onSaved(result.entry);
    } catch (error) {
      const problem = describeApiProblem(error, 'The review status could not be changed. Try again.');
      setServerProblem({ ...problem, field: null });
      if (problem.code === 'RECORD_CHANGED') await onConflict();
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const transitions = reviewTransitionsFor(entry.reviewStatus, entry.slug);
  const publishReason = publishBlockedReason(entry);
  const toneClass = (tone: ReviewTransition['tone']) => (tone === 'primary' ? BTN_PRIMARY : tone === 'danger' ? BTN_DANGER : BTN_SECONDARY);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }} data-testid="form-diet-entry">
        <SectionCard title="Content" sub="What patients read when they open this plan.">
          <div className="space-y-4">
            <Field label="Name" error={problemFor('name')} testId="name">
              <input className={`${INPUT_CLASS} w-full`} value={form.name} onChange={(event) => update('name', event.target.value)} maxLength={80} data-testid="input-name" />
            </Field>
            <Field label="Summary" hint="plain language, up to 600 characters" error={problemFor('summary')} testId="summary">
              <textarea className={`${INPUT_CLASS} min-h-[80px] w-full`} value={form.summary} onChange={(event) => update('summary', event.target.value)} data-testid="input-summary" />
            </Field>
            <Field label="Rule sheet" hint="one rule per line" error={problemFor('ruleSheet')} testId="ruleSheet">
              <textarea className={`${INPUT_CLASS} min-h-[160px] w-full font-mono text-[11px]`} value={form.ruleSheet} onChange={(event) => update('ruleSheet', event.target.value)} data-testid="input-rule-sheet" />
            </Field>
            <Field label="Sample day" hint="one meal per line" error={problemFor('sampleDay')} testId="sampleDay">
              <textarea className={`${INPUT_CLASS} min-h-[100px] w-full font-mono text-[11px]`} value={form.sampleDay} onChange={(event) => update('sampleDay', event.target.value)} data-testid="input-sample-day" />
            </Field>
            <Field label="Sources" hint="one per line; shown to counsel, not patients" error={problemFor('sources')} testId="sources">
              <textarea className={`${INPUT_CLASS} min-h-[64px] w-full font-mono text-[11px]`} value={form.sources} onChange={(event) => update('sources', event.target.value)} data-testid="input-sources" />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title="Safety and screening" sub="Which questions the app asks before a patient can pick this plan.">
          <div className="space-y-4">
            <fieldset>
              <legend className="text-xs font-semibold text-foreground">Screening questions</legend>
              <div className="mt-1 flex flex-wrap gap-3">
                {SCREENING_QUESTIONS.map((question) => (
                  <label key={question} className="inline-flex items-center gap-1.5 text-xs text-foreground">
                    <input
                      type="checkbox"
                      checked={form.screeningQuestions.includes(question)}
                      onChange={(event) => update('screeningQuestions', event.target.checked ? [...form.screeningQuestions, question] : form.screeningQuestions.filter((item) => item !== question))}
                      data-testid={`checkbox-screening-${question}`}
                    />
                    {SCREENING_LABELS[question]}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">A “yes” to medication or eating-disorder history parks the pick for provider review. A pregnancy “yes” refuses the plan when the pregnancy block below is on.</p>
            </fieldset>
            <label className="inline-flex items-center gap-1.5 text-xs text-foreground">
              <input type="checkbox" checked={form.pregnancyBlocked} onChange={(event) => update('pregnancyBlocked', event.target.checked)} data-testid="checkbox-pregnancy-blocked" />
              Block during pregnancy or when trying to conceive (no provider override)
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs text-foreground">
              <input type="checkbox" checked={form.oversightRecommended} onChange={(event) => update('oversightRecommended', event.target.checked)} data-testid="checkbox-oversight" />
              Show the care-team oversight note
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Complexity">
                <select className={`${INPUT_CLASS} w-full`} value={form.complexity} onChange={(event) => update('complexity', event.target.value as EntryForm['complexity'])} data-testid="select-complexity">
                  {COMPLEXITIES.map((value) => <option key={value} value={value}>{COMPLEXITY_LABELS[value]}</option>)}
                </select>
              </Field>
              <Field label="Evidence">
                <select className={`${INPUT_CLASS} w-full`} value={form.evidenceStrength} onChange={(event) => update('evidenceStrength', event.target.value as EntryForm['evidenceStrength'])} data-testid="select-evidence">
                  {EVIDENCE_STRENGTHS.map((value) => <option key={value} value={value}>{EVIDENCE_LABELS[value]}</option>)}
                </select>
              </Field>
              <Field label="Supervision">
                <select className={`${INPUT_CLASS} w-full`} value={form.supervisionLevel} onChange={(event) => update('supervisionLevel', event.target.value as EntryForm['supervisionLevel'])} data-testid="select-supervision">
                  {SUPERVISION_LEVELS.map((value) => <option key={value} value={value}>{SUPERVISION_LABELS[value]}</option>)}
                </select>
              </Field>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Fit rules" sub="Machine-readable rules the food classifier uses to decide whether a logged food fits this plan.">
          <Field label="Rules (JSON)" hint='mode "exclude" or "include", tag lists, optional nutrient bounds' error={problemFor('fitRules')} testId="fitRules">
            <textarea className={`${INPUT_CLASS} min-h-[140px] w-full font-mono text-[11px]`} value={form.fitRules} onChange={(event) => update('fitRules', event.target.value)} spellCheck={false} data-testid="input-fit-rules" />
          </Field>
          <div className="mt-3 max-w-[200px]">
            <Field label="Sort order" hint="lower shows first" error={problemFor('sortOrder')} testId="sortOrder">
              <input className={`${INPUT_CLASS} w-full`} inputMode="numeric" value={form.sortOrder} onChange={(event) => update('sortOrder', event.target.value)} data-testid="input-sort-order" />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title="Save">
          <Field label="Change note" hint="optional, kept in the version history" error={problemFor('changeNote')} testId="changeNote">
            <input className={`${INPUT_CLASS} w-full`} value={form.changeNote} onChange={(event) => update('changeNote', event.target.value)} maxLength={500} data-testid="input-change-note" />
          </Field>
          {warning && <p className="mt-3 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-3 py-2 text-[11px] leading-snug text-[#b65c22]" data-testid="text-save-warning">{warning}</p>}
          {serverProblem && serverProblem.field === null && (
            <p className="mt-3 text-xs text-destructive" role="alert" data-testid="text-save-problem">
              {serverProblem.message}
              {serverProblem.code === 'RECORD_CHANGED' && ' The latest version has been loaded below; re-apply your change if it still applies.'}
            </p>
          )}
          {attempted && problems.length > 0 && <p className="mt-3 text-xs text-destructive" role="alert" data-testid="text-form-problems">Fix the highlighted fields before saving.</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className={`${BTN_SECONDARY} px-3 py-2`} onClick={() => { setForm(entryToForm(entry)); setAttempted(false); setServerProblem(null); }} disabled={!dirty || busy} data-testid="button-discard">Discard changes</button>
            <button type="submit" className={`${BTN_PRIMARY} px-4 py-2`} disabled={busy || !dirty} data-testid="button-save-entry">{busy ? 'Saving…' : 'Save changes'}</button>
          </div>
        </SectionCard>
      </form>

      <aside className="space-y-4">
        <SectionCard title="Review status">
          <div className="flex items-center gap-2">
            {entry.slug === JUST_TRACKING_SLUG
              ? <span className={NEUTRAL_CHIP} data-testid="chip-entry-status">Always available</span>
              : <span className={reviewStatusChipClass(entry.reviewStatus)} data-testid="chip-entry-status">{REVIEW_STATUS_LABELS[entry.reviewStatus]}</span>}
            <span className="text-[11px] text-muted-foreground" data-testid="text-entry-version">Version {entry.version}</span>
          </div>
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{entry.slug === JUST_TRACKING_SLUG ? 'Patients can always choose to just track; there is nothing to publish.' : REVIEW_STATUS_HELP[entry.reviewStatus]}</p>
          <dl className="mt-3 space-y-1 text-[11px] text-muted-foreground">
            <div className="flex justify-between gap-2"><dt>Reviewed</dt><dd data-testid="text-reviewed-at">{formatInstant(entry.reviewedAt)}</dd></div>
            <div className="flex justify-between gap-2"><dt>Published</dt><dd data-testid="text-published-at">{formatInstant(entry.publishedAt)}</dd></div>
            <div className="flex justify-between gap-2"><dt>Last edit</dt><dd>{formatInstant(entry.updatedAt)}</dd></div>
          </dl>
          {transitions.length > 0 && (
            <div className="mt-4 flex flex-col gap-2">
              {transitions.map((transition) => (
                <button
                  key={transition.to}
                  type="button"
                  className={`${toneClass(transition.tone)} px-3 py-2`}
                  disabled={busy || dirty}
                  onClick={() => (transition.confirm ? setPending(transition) : void runTransition(transition))}
                  data-testid={`button-review-${transition.to}`}
                >
                  {transition.label}
                </button>
              ))}
              {dirty && <p className="text-[11px] text-muted-foreground" data-testid="text-review-blocked-dirty">Save or discard your edits before changing the review status.</p>}
            </div>
          )}
          {entry.slug !== JUST_TRACKING_SLUG && entry.reviewStatus !== 'reviewed' && entry.reviewStatus !== 'published' && (
            <p className="mt-3 text-[11px] text-muted-foreground" data-testid="text-publish-blocked">{publishReason}</p>
          )}
        </SectionCard>

        <SectionCard title="Version history" sub="Every save and review move, newest first.">
          {detail.versions.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="text-versions-empty">No saved versions yet.</p>
          ) : (
            <ol className="space-y-2" data-testid="list-versions">
              {detail.versions.map((version) => (
                <li key={version.version} className={`${INSET} px-3 py-2 text-[11px]`} data-testid={`version-${version.version}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 font-semibold text-foreground"><History className="h-3 w-3" aria-hidden /> v{version.version}</span>
                    <span className="text-muted-foreground">{formatInstant(version.createdAt)}</span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{version.changeNote ?? 'No change note'}{version.changedBy ? '' : ' · system'}</p>
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      </aside>

      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <AlertDialogContent data-testid="dialog-review-confirm">
          {pending && (() => {
            const copy = transitionConfirmCopy(pending.to, entry.name);
            return (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-serif text-xl">{copy.title}</AlertDialogTitle>
                  <AlertDialogDescription data-testid="text-review-confirm-body">{copy.body}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="button-review-cancel">Cancel</AlertDialogCancel>
                  <AlertDialogAction className={pending.tone === 'danger' ? BTN_DANGER : undefined} onClick={() => void runTransition(pending)} disabled={busy} data-testid="button-review-confirm">{copy.action}</AlertDialogAction>
                </AlertDialogFooter>
              </>
            );
          })()}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function DietLibraryEntryPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug ?? '';
  const { authUser } = useSession();
  const queryClient = useQueryClient();
  const query = useGetHqDietLibraryEntry(slug, { query: { queryKey: [...getGetHqDietLibraryEntryQueryKey(slug), authUser?.id], retry: 1, enabled: slug !== '' } });
  // The editor remounts on every landed version so its working copy always
  // starts from the row the server holds (and a 409 reload wipes stale edits).
  const [editorKey, setEditorKey] = useState(0);
  const version = query.data?.entry.version;
  useEffect(() => { if (version !== undefined) setEditorKey((key) => key + 1); }, [version]);

  const { toast } = useToast();
  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: getGetHqDietLibraryEntryQueryKey(slug) });
    await queryClient.invalidateQueries({ queryKey: getListHqDietLibraryQueryKey() });
  };
  const conflict = async () => {
    toast({ variant: 'destructive', title: 'This entry changed since you opened it', description: 'The latest version is loaded below. Re-apply your change if it still applies.' });
    await reload();
  };

  const entry = query.data?.entry;
  const status: DietReviewStatus | null = entry?.reviewStatus ?? null;

  return (
    <AdminPage>
      <Link href={DIET_LIBRARY_PATH} className="mb-3 inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline" data-testid="link-back-library">
        <ArrowLeft className="h-3 w-3" aria-hidden /> Diet library
      </Link>
      <PageHeader
        kicker="Learning · Diet library"
        title={entry ? entry.name : query.isPending ? 'Loading…' : 'Diet entry'}
        sub={entry ? `${entry.slug} · ${COMPLEXITY_LABELS[entry.complexity]} · ${status ? REVIEW_STATUS_LABELS[status] : ''}` : undefined}
        action={(
          <button type="button" className={`${BTN_SECONDARY} px-3 py-2`} onClick={() => void query.refetch()} disabled={query.isFetching} data-testid="button-refresh-entry">
            <RotateCw className={`h-3.5 w-3.5 ${query.isFetching ? 'animate-spin' : ''}`} aria-hidden /> Refresh
          </button>
        )}
      />
      {query.isPending ? (
        <p className="py-6 text-center text-xs text-muted-foreground" data-testid="status-entry-loading">Loading the entry…</p>
      ) : query.isError || !query.data ? (
        <div className="py-6 text-center" role="alert" data-testid="text-entry-error">
          <p className="text-xs text-destructive">{describeApiProblem(query.error, 'The entry could not be loaded.').message}</p>
          <button type="button" className={`${BTN_SECONDARY} mt-3 px-3 py-2`} onClick={() => void query.refetch()} data-testid="button-retry-entry">Try again</button>
        </div>
      ) : (
        <EntryEditor key={editorKey} detail={query.data} onSaved={reload} onConflict={conflict} />
      )}
    </AdminPage>
  );
}
