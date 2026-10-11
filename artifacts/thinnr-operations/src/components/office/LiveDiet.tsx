/**
 * Diet & food preferences on the live patient record.
 *
 * Reads the foundation's office diet DTO (state + pending block + lists +
 * screening + activity + history) and wires the staff actions:
 *  - set / change diet (same screening and lock rules as the patient; the
 *    foundation notifies the patient),
 *  - review a pending safety block: reject, or the TWO-step override (step
 *    one fetches a challenge and the "Are you sure you want to do this?"
 *    prompt; step two echoes the challenge — nothing is written until then),
 *  - restart the protocol (day one restarts, nothing is deleted),
 *  - edit the four lists (every item shows who entered it).
 * Every write is audited server-side; this component only decides what to
 * show. Unavailable data renders as unavailable, never as empty lists.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import {
  ACTIVITY_LABELS,
  ALLERGEN_KEYS,
  ALLERGEN_LABELS,
  PREFERENCE_LISTS,
  RESTRICTIONS,
  SCREENING_PROMPTS,
  SCREENING_QUESTIONS,
  SENSITIVITIES,
  type ActivityLevel,
  type PreferenceList,
  type ScreeningQuestion,
} from '@workspace/diet-programs';
import { BTN_PRIMARY, BTN_SECONDARY, CHIP_COBALT, CHIP_RISK, CHIP_WARM, INPUT_CLASS, MICRO_LABEL, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { livePatientQueryKey } from '@/components/office/LivePatientEdits';
import { officeRosterQueryKey } from '@/components/office/LiveRoster';
import { PhaseBadge } from '@/components/office/RosterDiet';
import { dietLabel } from '@/lib/roster-filters';
import {
  OfficeDietError,
  addOfficePatientPreference,
  clearOfficePatientDiet,
  confirmDietBlockOverride,
  fetchOfficePatientDiet,
  officeDietQueryKey,
  rejectDietBlock,
  removeOfficePatientPreference,
  restartOfficePatientProtocol,
  setOfficePatientDiet,
  startDietBlockOverride,
  type DietBlock,
  type DietOverrideChallenge,
  type DietPreferenceItem,
  type DietScreeningAnswers,
  type OfficePatientDiet,
} from '@/lib/office-diet';

export const LIST_TITLES: Record<PreferenceList, string> = {
  allergy: 'Allergies',
  sensitivity: 'Sensitivities',
  restriction: 'Restrictions',
  dislike: 'Dislikes',
};
const QUESTION_SHORT: Record<ScreeningQuestion, string> = {
  medication: 'Diabetes medication',
  eating_disorder: 'Eating disorder history',
  pregnancy: 'Pregnancy',
};
const ROLE_LABEL: Record<string, string> = { patient: 'Patient', staff: 'Staff', system: 'System', migration: 'Imported' };
const SELECTION_STATUS: Record<string, string> = { active: 'Active', pending_review: 'Pending review', superseded: 'Superseded', rejected: 'Rejected', withdrawn: 'Withdrawn' };
const BLOCK_STATUS: Record<string, string> = { pending: 'Pending', overridden: 'Overridden', rejected: 'Rejected', withdrawn: 'Withdrawn' };
const ANSWER_LABEL: Record<string, string> = { yes: 'Yes', no: 'No', skipped: 'Skipped' };
export const RESTART_EXPLANATION = 'The protocol calendar restarts from day one today. Nothing is deleted: every weigh-in, diary entry, diet selection and prior protocol run stays on the record.';
export const PATIENT_NOTIFIED_NOTE = 'The patient is notified in the app when their diet is set or changed.';

const formatStamp = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '—';
const formatDay = (dateKey: string | null | undefined) => dateKey
  ? new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  : '—';
const errorMessage = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

function catalogFor(list: PreferenceList): Array<{ key: string; label: string }> {
  if (list === 'allergy') return ALLERGEN_KEYS.map((key) => ({ key, label: ALLERGEN_LABELS[key] }));
  if (list === 'sensitivity') return SENSITIVITIES.map((item) => ({ key: item.key, label: item.label }));
  if (list === 'restriction') return RESTRICTIONS.map((item) => ({ key: item.key, label: item.label }));
  return [];
}

function Notice({ tone, children, testId }: { tone: 'warn' | 'error' | 'ok'; children: React.ReactNode; testId?: string }) {
  const cls = tone === 'error'
    ? 'border-[#d5a7a7] bg-[#fff0f0] text-destructive'
    : tone === 'warn' ? 'border-warn-border bg-warn-bg text-warn' : 'border-accent-border bg-accent text-primary';
  return <p role={tone === 'error' ? 'alert' : 'status'} className={`rounded-md border p-3 text-xs ${cls}`} data-testid={testId}>{children}</p>;
}

// ── Set / change diet ────────────────────────────────────────────────────────

function SetDietForm({ data, dietName, busy, onCancel, onSubmit }: {
  data: OfficePatientDiet;
  dietName: (slug: string) => string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { dietSlug: string; answers?: DietScreeningAnswers }) => Promise<string | null>;
}) {
  const selectable = data.library.filter((entry) => entry.reviewStatus === 'published').sort((a, b) => a.sortOrder - b.sortOrder);
  const [slug, setSlug] = useState(data.currentDiet?.dietSlug ?? data.suggestedDefaultSlug ?? selectable[0]?.slug ?? '');
  const [answers, setAnswers] = useState<DietScreeningAnswers>({ ...data.screening.answers });
  const [error, setError] = useState<string | null>(null);
  const entry = selectable.find((item) => item.slug === slug) ?? null;
  const questions = useMemo(() => {
    const set = new Set<ScreeningQuestion>(entry?.screeningQuestions ?? []);
    if (entry?.pregnancyBlocked) set.add('pregnancy');
    return SCREENING_QUESTIONS.filter((question) => set.has(question));
  }, [entry]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!slug) { setError('Choose an eating plan.'); return; }
    const missing = questions.filter((question) => !answers[question]);
    if (missing.length) { setError(`Answer the screening question${missing.length > 1 ? 's' : ''} before saving.`); return; }
    const picked: DietScreeningAnswers = {};
    for (const question of questions) picked[question] = answers[question];
    const failure = await onSubmit({ dietSlug: slug, ...(questions.length ? { answers: picked } : {}) });
    setError(failure);
  };
  return (
    <form className="mb-5 space-y-4 rounded-md border border-border bg-secondary p-4" data-testid="diet-form" onSubmit={submit}>
      {error && <Notice tone="error" testId="diet-form-error">{error}</Notice>}
      <label className={PANEL_LABEL} htmlFor="diet-slug">Eating plan
        <select id="diet-slug" data-testid="select-diet-slug" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={slug} onChange={(e) => { setSlug(e.target.value); setError(null); }}>
          {!slug && <option value="">Choose…</option>}
          {selectable.map((item) => <option key={item.slug} value={item.slug}>{dietName(item.slug)}</option>)}
        </select>
      </label>
      {entry && <p className="text-xs leading-5 text-muted-foreground" data-testid="diet-form-summary">{entry.summary}{entry.oversightRecommended ? ' Care-team oversight is recommended for this plan.' : ''}</p>}
      {questions.length > 0 && (
        <fieldset data-testid="diet-form-screening">
          <legend className={PANEL_LABEL}>Screening (answers on the patient’s behalf)</legend>
          <div className="mt-2 space-y-3">
            {questions.map((question) => (
              <div key={question} className="text-xs">
                <p className="text-foreground">{SCREENING_PROMPTS[question]}</p>
                <div className="mt-1 flex gap-4">
                  {(['yes', 'no'] as const).map((value) => (
                    <label key={value} htmlFor={`screening-${question}-${value}`} className="flex items-center gap-1">
                      <input id={`screening-${question}-${value}`} type="radio" name={`screening-${question}`} data-testid={`radio-screening-${question}-${value}`} checked={answers[question] === value} onChange={() => { setAnswers((current) => ({ ...current, [question]: value })); setError(null); }} />
                      {ANSWER_LABEL[value]}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
      )}
      <p className="text-[11px] text-muted-foreground" data-testid="diet-form-notified">{PATIENT_NOTIFIED_NOTE}</p>
      <div className="flex justify-end gap-2">
        <button type="button" className={`${BTN_SECONDARY} h-9 px-4`} onClick={onCancel}>Cancel</button>
        <button type="submit" className={`${BTN_PRIMARY} h-9 px-4`} disabled={busy} data-testid="button-save-diet">{busy ? 'Saving…' : data.currentDiet ? 'Change diet' : 'Set diet'}</button>
      </div>
    </form>
  );
}

// ── Pending block review (two-step override) ─────────────────────────────────

function PendingBlockPanel({ block, dietName, canEdit, patientId, office, onDone }: {
  block: DietBlock;
  dietName: (slug: string) => string;
  canEdit: boolean;
  patientId: string;
  office: string | null;
  onDone: (message: string) => Promise<void>;
}) {
  const [challenge, setChallenge] = useState<DietOverrideChallenge | null>(null);
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => startDietBlockOverride(patientId, office, block.id),
    onSuccess: (issued) => { setChallenge(issued); setError(null); },
    onError: (failure) => setError(errorMessage(failure, 'The override could not be started.')),
  });
  const confirm = useMutation({
    mutationFn: () => confirmDietBlockOverride(patientId, office, block.id, { challenge: challenge!.challenge, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: () => onDone(`Override recorded — ${dietName(block.dietSlug)} is now active.`),
    onError: (failure) => {
      setError(errorMessage(failure, 'The override could not be confirmed.'));
      if (failure instanceof OfficeDietError && (failure.code === 'CHALLENGE_EXPIRED' || failure.code === 'CHALLENGE_MISMATCH' || failure.code === 'NOT_OVERRIDABLE')) setChallenge(null);
    },
  });
  const reject = useMutation({
    mutationFn: () => rejectDietBlock(patientId, office, block.id, note.trim() || undefined),
    onSuccess: () => onDone('The blocked pick was declined; the patient keeps their current plan.'),
    onError: (failure) => setError(errorMessage(failure, 'The block could not be rejected.')),
  });
  const busy = start.isPending || confirm.isPending || reject.isPending;
  return (
    <div className="mb-5 rounded-md border border-[#e8b47c] bg-[#fff4e6] p-4" data-testid="diet-pending-block">
      <div className="flex items-start gap-2">
        <ShieldAlert size={16} className="mt-0.5 shrink-0 text-[#b65c22]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="font-serif text-sm font-bold text-navy">Safety block waiting for review</h3>
          <p className="mt-1 text-xs text-foreground">
            <b>{dietName(block.dietSlug)}</b> was requested on {formatStamp(block.createdAt)} and parked because the screening answered yes to{' '}
            {block.questions.map((question) => QUESTION_SHORT[question as ScreeningQuestion] ?? question).join(' and ')}.
          </p>
          {error && <div className="mt-3"><Notice tone="error" testId="diet-block-error">{error}</Notice></div>}
          {canEdit && !challenge && !rejecting && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className={`${BTN_PRIMARY} h-8 px-3`} disabled={busy} data-testid="button-override-block" onClick={() => start.mutate()}>{start.isPending ? 'Checking…' : 'Override and start this diet'}</button>
              <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} disabled={busy} data-testid="button-reject-block" onClick={() => { setRejecting(true); setError(null); }}>Decline this pick</button>
            </div>
          )}
          {canEdit && challenge && (
            <div className="mt-3 space-y-3 rounded-md border border-[#d5a7a7] bg-[#fff0f0] p-3" data-testid="diet-override-challenge">
              <p className="text-sm font-bold text-destructive" data-testid="diet-override-confirm-text">{challenge.confirmText}</p>
              <p className="text-xs text-foreground">The override is recorded with your name and the time. The patient’s screening answers stay on file.</p>
              <label className={PANEL_LABEL} htmlFor="override-note">Reason (kept on the record)
                <textarea id="override-note" data-testid="input-override-note" className={`${INPUT_CLASS} mt-1 min-h-16 w-full py-2`} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={`${BTN_PRIMARY} h-8 px-3`} disabled={busy} data-testid="button-confirm-override" onClick={() => confirm.mutate()}>{confirm.isPending ? 'Recording…' : 'Yes, override the block'}</button>
                <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} disabled={busy} data-testid="button-cancel-override" onClick={() => { setChallenge(null); setError(null); }}>Cancel</button>
              </div>
            </div>
          )}
          {canEdit && rejecting && (
            <div className="mt-3 space-y-3" data-testid="diet-reject-form">
              <label className={PANEL_LABEL} htmlFor="reject-note">Note (optional)
                <textarea id="reject-note" data-testid="input-reject-note" className={`${INPUT_CLASS} mt-1 min-h-16 w-full py-2`} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={`${BTN_PRIMARY} h-8 px-3`} disabled={busy} data-testid="button-confirm-reject" onClick={() => reject.mutate()}>{reject.isPending ? 'Saving…' : 'Decline the pick'}</button>
                <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} disabled={busy} onClick={() => setRejecting(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Lists ────────────────────────────────────────────────────────────────────

function AddListItemForm({ busy, onCancel, onSubmit }: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { list: PreferenceList; key?: string; label?: string; severity?: 'mild' | 'severe' }) => Promise<string | null>;
}) {
  const [list, setList] = useState<PreferenceList>('allergy');
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [severity, setSeverity] = useState<'mild' | 'severe'>('mild');
  const [error, setError] = useState<string | null>(null);
  const catalog = catalogFor(list);
  const custom = key === '' || key === '__custom';
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (custom && !label.trim()) { setError('Pick an item or type one in.'); return; }
    const failure = await onSubmit({
      list,
      ...(custom ? { label: label.trim() } : { key }),
      ...(list === 'allergy' ? { severity } : {}),
    });
    setError(failure);
  };
  return (
    <form className="mb-4 grid gap-3 rounded-md border border-border bg-secondary p-4 sm:grid-cols-2" data-testid="diet-item-form" onSubmit={submit}>
      {error && <div className="sm:col-span-2"><Notice tone="error" testId="diet-item-error">{error}</Notice></div>}
      <label className={PANEL_LABEL} htmlFor="item-list">List
        <select id="item-list" data-testid="select-item-list" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={list} onChange={(e) => { setList(e.target.value as PreferenceList); setKey(''); setError(null); }}>
          {PREFERENCE_LISTS.map((name) => <option key={name} value={name}>{LIST_TITLES[name]}</option>)}
        </select>
      </label>
      {catalog.length > 0 ? (
        <label className={PANEL_LABEL} htmlFor="item-key">Item
          <select id="item-key" data-testid="select-item-key" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={key} onChange={(e) => { setKey(e.target.value); setError(null); }}>
            <option value="">Choose…</option>
            {catalog.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            <option value="__custom">Something else…</option>
          </select>
        </label>
      ) : <span />}
      {custom && (
        <label className={`${PANEL_LABEL} sm:col-span-2`} htmlFor="item-label">{catalog.length ? 'Describe it' : 'Item'}
          <input id="item-label" data-testid="input-item-label" className={`${INPUT_CLASS} mt-1 h-9 w-full`} maxLength={80} value={label} onChange={(e) => { setLabel(e.target.value); setError(null); }} />
        </label>
      )}
      {list === 'allergy' && (
        <fieldset>
          <legend className={PANEL_LABEL}>Severity</legend>
          <div className="mt-2 flex gap-4 text-xs">
            {(['mild', 'severe'] as const).map((value) => (
              <label key={value} htmlFor={`item-severity-${value}`} className="flex items-center gap-1">
                <input id={`item-severity-${value}`} type="radio" name="item-severity" data-testid={`radio-item-severity-${value}`} checked={severity === value} onChange={() => setSeverity(value)} />
                {value === 'mild' ? 'Mild' : 'Severe'}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex items-end justify-end gap-2 sm:col-span-2">
        <button type="button" className={`${BTN_SECONDARY} h-9 px-4`} onClick={onCancel}>Cancel</button>
        <button type="submit" className={`${BTN_PRIMARY} h-9 px-4`} disabled={busy} data-testid="button-save-item">{busy ? 'Saving…' : 'Add to list'}</button>
      </div>
    </form>
  );
}

function ListItemRow({ item, canEdit, busy, onRemove }: { item: DietPreferenceItem; canEdit: boolean; busy: boolean; onRemove: () => void }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-xs" data-testid={`diet-item-${item.id}`}>
      <span className="flex items-center gap-2">
        <b className="text-navy">{item.label}</b>
        {item.severity && <span className={item.severity === 'severe' ? CHIP_RISK : CHIP_WARM} data-testid={`chip-severity-${item.id}`}>{item.severity === 'severe' ? 'Severe' : 'Mild'}</span>}
        {item.isCustom && <span className="text-[10px] text-muted-foreground">custom</span>}
      </span>
      <span className="flex items-center gap-3">
        <span className="text-[10px] text-muted-foreground" data-testid={`entered-by-${item.id}`}>
          Entered by {ROLE_LABEL[item.enteredByRole] ?? item.enteredByRole}{item.enteredByName ? ` · ${item.enteredByName}` : ''} · {formatStamp(item.createdAt)}
        </span>
        {canEdit && <button type="button" className={`${BTN_SECONDARY} h-7 px-2 text-destructive`} disabled={busy} data-testid={`button-remove-item-${item.id}`} onClick={onRemove}>Remove</button>}
      </span>
    </li>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

export function LiveDiet({ patientId, office, canEdit }: { patientId: string; office: string | null; canEdit: boolean }) {
  const client = useQueryClient();
  const queryKey = officeDietQueryKey(office, patientId);
  const query = useQuery({ queryKey, queryFn: () => fetchOfficePatientDiet(patientId, office) });
  const [editing, setEditing] = useState<'diet' | 'item' | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [restartNote, setRestartNote] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  // Alert deep links land on /patients/:id?section=diet: once the section has
  // its data, bring it into view (once per visit, never on later refetches).
  const linkedSection = new URLSearchParams(useSearch()).get('section');
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    if (linkedSection !== 'diet' || scrolled.current || !query.data) return;
    scrolled.current = true;
    sectionRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [linkedSection, query.data]);

  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey }),
      client.invalidateQueries({ queryKey: livePatientQueryKey(office, patientId) }),
      client.invalidateQueries({ queryKey: officeRosterQueryKey(office) }),
    ]);
  };
  const done = async (text: string, tone: 'ok' | 'warn' = 'ok') => {
    setNotice({ tone, text });
    setEditing(null);
    setConfirmingClear(false);
    setConfirmingRestart(false);
    setRestartNote('');
    await refresh();
  };

  const setDiet = useMutation({ mutationFn: (input: { dietSlug: string; answers?: DietScreeningAnswers }) => setOfficePatientDiet(patientId, office, input) });
  const clearDiet = useMutation({ mutationFn: () => clearOfficePatientDiet(patientId, office) });
  const restart = useMutation({ mutationFn: () => restartOfficePatientProtocol(patientId, office, restartNote.trim() ? { note: restartNote.trim() } : {}) });
  const addItem = useMutation({ mutationFn: (input: Parameters<typeof addOfficePatientPreference>[2]) => addOfficePatientPreference(patientId, office, input) });
  const removeItem = useMutation({ mutationFn: (itemId: string) => removeOfficePatientPreference(patientId, office, itemId) });

  const data = query.data;
  const names = useMemo(() => new Map((data?.library ?? []).map((entry) => [entry.slug, entry.name])), [data]);
  const dietName = (slug: string | null | undefined) => (slug ? names.get(slug) ?? dietLabel(slug) : 'No diet');

  const submitDiet = async (input: { dietSlug: string; answers?: DietScreeningAnswers }): Promise<string | null> => {
    try {
      const result = await setDiet.mutateAsync(input);
      if (result.status === 'pending_review') await done(`${dietName(input.dietSlug)} was parked for review: the screening answered yes to ${result.questions.map((q) => QUESTION_SHORT[q as ScreeningQuestion] ?? q).join(' and ')}. Review the block below.`, 'warn');
      else await done(`${dietName(input.dietSlug)} is now active. ${PATIENT_NOTIFIED_NOTE}`);
      return null;
    } catch (error) {
      if (error instanceof OfficeDietError && error.code === 'SCREENING_REQUIRED') return `${error.message} (${error.questions.map((q) => QUESTION_SHORT[q as ScreeningQuestion] ?? q).join(', ')})`;
      return errorMessage(error, 'The diet was not saved.');
    }
  };
  const submitItem = async (input: Parameters<typeof addOfficePatientPreference>[2]): Promise<string | null> => {
    try {
      await addItem.mutateAsync(input);
      await done(`Added to ${LIST_TITLES[input.list as PreferenceList].toLowerCase()}.`);
      return null;
    } catch (error) {
      return errorMessage(error, 'The item was not added.');
    }
  };
  const act = async (run: () => Promise<unknown>, success: string, failure: string) => {
    try { await run(); await done(success); } catch (error) { setNotice({ tone: 'error', text: errorMessage(error, failure) }); }
  };

  const phase = data?.phase;
  const episodes = data ? [...data.history.episodes].sort((a, b) => b.episodeNumber - a.episodeNumber) : [];
  const selections = data ? [...data.history.selections].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')) : [];
  const blocks = data ? [...data.history.blocks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  const activity = data ? [...data.history.activity].sort((a, b) => b.recordedOn.localeCompare(a.recordedOn)) : [];
  const severe = data?.preferences.some((item) => item.list === 'allergy' && item.severity === 'severe') ?? false;
  const writing = setDiet.isPending || clearDiet.isPending || restart.isPending || addItem.isPending || removeItem.isPending;

  return (
    <div data-testid="live-diet" id="diet" ref={sectionRef}>
      <SectionCard
        title="Diet & food preferences"
        sub="Eating plan, protocol phase, safety screening and the patient’s lists. Allergies, restrictions and screening answers are PHI."
        action={canEdit && data ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} data-testid="button-set-diet" onClick={() => { setEditing((current) => current === 'diet' ? null : 'diet'); setNotice(null); }}>
              {editing === 'diet' ? 'Cancel' : data.currentDiet ? 'Change diet' : 'Set diet'}
            </button>
            <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} data-testid="button-restart-protocol" onClick={() => { setConfirmingRestart((open) => !open); setNotice(null); }}>
              {confirmingRestart ? 'Cancel' : 'Restart protocol'}
            </button>
          </div>
        ) : undefined}
      >
        <div className="p-5">
          {query.isLoading && <p className="text-xs text-muted-foreground">Loading diet record…</p>}
          {query.isError && <Notice tone="error" testId="diet-unavailable">Diet record unavailable: {errorMessage(query.error, 'Try again.')}</Notice>}
          {notice && <div className="mb-4"><Notice tone={notice.tone} testId="diet-notice">{notice.text}</Notice></div>}
          {data && phase && <>
            {editing === 'diet' && <SetDietForm data={data} dietName={dietName} busy={setDiet.isPending} onCancel={() => setEditing(null)} onSubmit={submitDiet} />}
            {confirmingRestart && (
              <div className="mb-5 space-y-3 rounded-md border border-warn-border bg-warn-bg p-4" data-testid="diet-restart-confirm">
                <p className="text-xs font-semibold text-warn">Put this patient back on the protocol?</p>
                <p className="text-xs text-foreground">{RESTART_EXPLANATION}</p>
                <label className={PANEL_LABEL} htmlFor="restart-note">Note (optional)
                  <textarea id="restart-note" data-testid="input-restart-note" className={`${INPUT_CLASS} mt-1 min-h-16 w-full py-2`} maxLength={500} value={restartNote} onChange={(e) => setRestartNote(e.target.value)} />
                </label>
                <div className="flex gap-2">
                  <button type="button" className={`${BTN_PRIMARY} h-8 px-3`} disabled={writing} data-testid="button-confirm-restart" onClick={() => void act(() => restart.mutateAsync(), 'Protocol restarted from day one. Prior data is kept.', 'The protocol was not restarted.')}>Restart from day one</button>
                  <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} onClick={() => setConfirmingRestart(false)}>Keep the current calendar</button>
                </div>
              </div>
            )}
            {data.pendingBlock && <PendingBlockPanel key={data.pendingBlock.id} block={data.pendingBlock} dietName={dietName} canEdit={canEdit} patientId={patientId} office={office} onDone={done} />}

            <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3" data-testid="diet-current">
              <div className="bg-card p-4">
                <p className={MICRO_LABEL}>Current diet</p>
                <p className="mt-1 font-serif text-base font-bold text-navy" data-testid="diet-current-name">{dietName(data.currentDiet?.dietSlug)}</p>
                {data.currentDiet && <p className="mt-1 text-[10px] text-muted-foreground">Since {formatStamp(data.currentDiet.startedAt)} · chosen by {ROLE_LABEL[data.currentDiet.selectedByRole] ?? data.currentDiet.selectedByRole}</p>}
                {phase.dietPickerLocked && <p className="mt-1 text-[10px] text-[#b65c22]" data-testid="diet-locked-note">Protocol locks the picker; the plan in force is {dietName(data.effectiveDietSlug)}.</p>}
                {canEdit && data.currentDiet && !confirmingClear && <button type="button" className="mt-2 text-[11px] font-semibold text-destructive hover:underline" data-testid="button-clear-diet" onClick={() => setConfirmingClear(true)}>Take off this diet</button>}
                {canEdit && confirmingClear && <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]"><span>Take the patient off {dietName(data.currentDiet?.dietSlug)}?</span><button type="button" className={`${BTN_SECONDARY} h-7 px-2`} disabled={writing} data-testid="button-confirm-clear-diet" onClick={() => void act(() => clearDiet.mutateAsync(), 'The patient is off their diet. The history is kept.', 'The diet was not cleared.')}>Confirm</button><button type="button" className="font-semibold text-muted-foreground hover:underline" onClick={() => setConfirmingClear(false)}>Cancel</button></div>}
              </div>
              <div className="bg-card p-4">
                <p className={MICRO_LABEL}>Phase</p>
                <div className="mt-1 flex items-center gap-2"><PhaseBadge stage={phase.phase} week={phase.phase === 'protocol' ? Math.ceil(phase.programDay / 7) : null} /></div>
                <p className="mt-1 text-xs text-navy" data-testid="diet-phase-line">{phase.phase === 'protocol' ? `Day ${phase.programDay} of 42 · ${phase.phaseName}` : `Maintenance day ${phase.maintenanceDay}`}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">{phase.episodeNumber ? `Protocol run ${phase.episodeNumber} · started ${formatDay(phase.episodeStartedOn)}` : 'No protocol start recorded'}</p>
              </div>
              <div className="bg-card p-4">
                <p className={MICRO_LABEL}>Activity level</p>
                <p className="mt-1 text-xs text-navy" data-testid="diet-activity-current">{data.activityLevel ? ACTIVITY_LABELS[data.activityLevel.level as ActivityLevel] ?? data.activityLevel.level : 'Not recorded'}</p>
                {data.activityLevel && <p className="mt-1 text-[10px] text-muted-foreground">Recorded {formatDay(data.activityLevel.recordedOn)} · {data.activityLevel.source.replace(/_/g, ' ')}</p>}
                {severe && <p className="mt-2 flex items-center gap-1 text-[10px] font-bold uppercase tracking-[.05em] text-destructive" data-testid="diet-severe-allergy"><AlertTriangle size={11} aria-hidden="true" />Severe allergy on file</p>}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-serif text-sm font-bold text-navy">Lists</h3>
              {canEdit && <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} data-testid="button-add-list-item" onClick={() => { setEditing((current) => current === 'item' ? null : 'item'); setNotice(null); }}>{editing === 'item' ? 'Cancel' : 'Add to a list'}</button>}
            </div>
            <div className="mt-2">
              {editing === 'item' && <AddListItemForm busy={addItem.isPending} onCancel={() => setEditing(null)} onSubmit={submitItem} />}
              <div className="grid gap-3 sm:grid-cols-2">
                {PREFERENCE_LISTS.map((list) => {
                  const items = data.preferences.filter((item) => item.list === list);
                  return (
                    <div key={list} className="rounded-md border border-border" data-testid={`diet-list-${list}`}>
                      <p className={`${PANEL_LABEL} border-b border-border bg-secondary px-3 py-2`}>{LIST_TITLES[list]} · {items.length}</p>
                      {items.length ? <ul className="divide-y divide-border">{items.map((item) => <ListItemRow key={item.id} item={item} canEdit={canEdit} busy={writing} onRemove={() => void act(() => removeItem.mutateAsync(item.id), `${item.label} removed from ${LIST_TITLES[list].toLowerCase()}.`, 'The item was not removed.')} />)}</ul> : <p className="px-3 py-3 text-xs text-muted-foreground">None recorded.</p>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="mt-5 rounded-md border border-border" data-testid="diet-screening">
              <p className={`${PANEL_LABEL} border-b border-border bg-secondary px-3 py-2`}>Screening answers</p>
              <ul className="divide-y divide-border">
                {SCREENING_QUESTIONS.map((question) => {
                  const answer = data.screening.answers[question];
                  return <li key={question} className="flex items-center justify-between gap-4 px-3 py-2 text-xs" data-testid={`screening-${question}`}><span className="text-foreground">{SCREENING_PROMPTS[question]}</span><b className={answer === 'yes' ? 'text-[#b65c22]' : 'text-navy'}>{answer ? ANSWER_LABEL[answer] ?? answer : 'Not answered'}</b></li>;
                })}
              </ul>
              {data.screening.pregnancyConflict && <p className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs font-semibold text-destructive" data-testid="diet-pregnancy-conflict"><AlertTriangle size={13} aria-hidden="true" />Pregnancy conflict: the current plan is not recommended while pregnant, trying to conceive or breastfeeding.</p>}
            </div>

            <details className="mt-5 rounded-md border border-border" data-testid="diet-history">
              <summary className={`${PANEL_LABEL} cursor-pointer bg-secondary px-3 py-2`}>History · {selections.length} diet {selections.length === 1 ? 'selection' : 'selections'} · {episodes.length} protocol {episodes.length === 1 ? 'run' : 'runs'} · {blocks.length} {blocks.length === 1 ? 'block' : 'blocks'}</summary>
              <div className="space-y-4 p-3">
                <div>
                  <p className={MICRO_LABEL}>Diet selections</p>
                  {selections.length ? <ul className="mt-1 divide-y divide-border rounded-md border border-border">{selections.map((selection) => <li key={selection.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-xs" data-testid={`diet-selection-${selection.id}`}><span><b className="text-navy">{dietName(selection.dietSlug)}</b> <span className={selection.status === 'active' ? CHIP_COBALT : 'text-[10px] text-muted-foreground'}>{SELECTION_STATUS[selection.status] ?? selection.status}</span></span><span className="text-[10px] text-muted-foreground">{ROLE_LABEL[selection.selectedByRole] ?? selection.selectedByRole} · {formatStamp(selection.startedAt)}{selection.endedAt ? ` → ${formatStamp(selection.endedAt)}` : ''}</span></li>)}</ul> : <p className="mt-1 text-xs text-muted-foreground">No diet has been chosen yet.</p>}
                </div>
                <div>
                  <p className={MICRO_LABEL}>Protocol runs</p>
                  {episodes.length ? <ul className="mt-1 divide-y divide-border rounded-md border border-border">{episodes.map((episode) => <li key={episode.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-xs" data-testid={`diet-episode-${episode.id}`}><span><b className="text-navy">Run {episode.episodeNumber}</b> · {formatDay(episode.startedOn)}{episode.endedOn ? ` → ${formatDay(episode.endedOn)}` : ' → ongoing'}</span><span className="text-[10px] text-muted-foreground">{episode.reason.replace(/_/g, ' ')} · {ROLE_LABEL[episode.startedByRole] ?? episode.startedByRole}{episode.note ? ` · ${episode.note}` : ''}</span></li>)}</ul> : <p className="mt-1 text-xs text-muted-foreground">No protocol start recorded.</p>}
                </div>
                <div>
                  <p className={MICRO_LABEL}>Safety blocks and overrides</p>
                  {blocks.length ? <ul className="mt-1 divide-y divide-border rounded-md border border-border">{blocks.map((block) => <li key={block.id} className="px-3 py-2 text-xs" data-testid={`diet-block-${block.id}`}><div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"><span><b className="text-navy">{dietName(block.dietSlug)}</b> · {block.questions.map((q) => QUESTION_SHORT[q as ScreeningQuestion] ?? q).join(', ')}</span><span className={block.status === 'overridden' ? CHIP_RISK : block.status === 'pending' ? CHIP_WARM : 'text-[10px] text-muted-foreground'}>{BLOCK_STATUS[block.status] ?? block.status}</span></div><p className="mt-0.5 text-[10px] text-muted-foreground">Raised {formatStamp(block.createdAt)}{block.reviewedAt ? ` · ${BLOCK_STATUS[block.status] ?? 'Reviewed'} by ${block.reviewedByName ?? 'staff'} on ${formatStamp(block.reviewedAt)}` : ''}{block.reviewNote ? ` · “${block.reviewNote}”` : ''}</p></li>)}</ul> : <p className="mt-1 text-xs text-muted-foreground">No safety blocks have been raised.</p>}
                </div>
                <div data-testid="diet-activity-history">
                  <p className={MICRO_LABEL}>Activity level over time</p>
                  {activity.length ? <ul className="mt-1 divide-y divide-border rounded-md border border-border">{activity.map((record, index) => <li key={`${record.recordedOn}-${record.source}-${index}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-xs"><span className="text-navy">{ACTIVITY_LABELS[record.level as ActivityLevel] ?? record.level}</span><span className="text-[10px] text-muted-foreground">{formatDay(record.recordedOn)} · {record.source.replace(/_/g, ' ')}</span></li>)}</ul> : <p className="mt-1 text-xs text-muted-foreground">No activity level recorded.</p>}
                </div>
              </div>
            </details>
          </>}
        </div>
      </SectionCard>
    </div>
  );
}
