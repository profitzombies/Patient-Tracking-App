/**
 * Live patient record — Diet & food preferences section.
 *
 * Renders the REAL LiveDiet component under react-test-renderer against a
 * scripted global fetch and checks the owner rules:
 *  - current diet, phase, lists with entered-by, screening answers, history,
 *  - set / change diet asks the entry's screening questions and tells staff
 *    the patient is notified; 202 pending lands as a block to review,
 *  - the override is TWO steps: step one only fetches the challenge and shows
 *    "Are you sure you want to do this?"; nothing is written until confirm,
 *  - restart protocol explains day one restarts and nothing is deleted,
 *  - list edits POST / DELETE with the list, key or custom label and severity,
 *  - read-only (no edit right) renders no write controls at all,
 *  - a failed read says unavailable rather than rendering empty lists.
 */
import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { LiveDiet, PATIENT_NOTIFIED_NOTE, RESTART_EXPLANATION } from '../src/components/office/LiveDiet';
import { AUDIT_ACTION_LABELS } from '../src/lib/audit-labels';
import type { OfficePatientDiet } from '../src/lib/office-diet';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
let failures = 0;
const check = (name: string, pass: boolean, detail = '') => {
  if (pass) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const one = (root: ReactTestInstance, id: string) => {
  const found = byTestId(root, id);
  if (found.length !== 1) throw new Error(`Expected one ${id}; found ${found.length}`);
  return found[0];
};
const textOf = (node: ReactTestInstance): string => node.children.map((child) => typeof child === 'string' ? child : textOf(child as ReactTestInstance)).join('');
const settle = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const entry = (slug: string, name: string, extra: Partial<OfficePatientDiet['library'][number]> = {}): OfficePatientDiet['library'][number] => ({
  id: `lib-${slug}`, slug, name, summary: `${name} summary.`, complexity: 'simple', ruleSheet: [], sampleDay: [], oversightNote: null,
  pregnancyBlocked: false, screeningQuestions: [], fitRules: {} as never, sortOrder: 1, oversightRecommended: false, evidenceStrength: 'moderate',
  supervisionLevel: 'none', sources: [], reviewStatus: 'published', reviewedBy: null, reviewedAt: null, publishedAt: '2026-09-01T00:00:00Z', version: 1,
  updatedBy: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', ...extra,
});
const library = [
  entry('just_tracking', 'Just tracking', { sortOrder: 0 }),
  entry('mediterranean', 'Mediterranean', { sortOrder: 2 }),
  entry('keto', 'Ketogenic', { sortOrder: 3, screeningQuestions: ['medication', 'eating_disorder'], pregnancyBlocked: true, oversightRecommended: true }),
  entry('draft_only', 'Draft diet', { sortOrder: 4, reviewStatus: 'draft' }),
];
const item = (id: string, list: OfficePatientDiet['preferences'][number]['list'], label: string, severity: 'mild' | 'severe' | null, role: 'patient' | 'staff' = 'patient', name: string | null = null): OfficePatientDiet['preferences'][number] => ({
  id, list, key: label.toLowerCase().replace(/\s+/g, '_'), label, isCustom: false, severity, enteredByRole: role, enteredByName: name, createdAt: '2026-10-01T15:00:00Z',
});
function baseState(): OfficePatientDiet {
  return {
    dateKey: '2026-10-10', programId: 'prog-1',
    phase: { programDay: 10, phase: 'protocol', phaseName: 'Low-calorie days', maintenanceDay: 0, dietPickerLocked: false, episodeId: 'ep-2', episodeNumber: 2, episodeStartedOn: '2026-10-01' },
    currentDiet: { id: 'sel-1', dietSlug: 'mediterranean', status: 'active', selectedByRole: 'patient', settings: {}, screeningSnapshot: {}, startedAt: '2026-09-20T12:00:00Z', endedAt: null },
    effectiveDietSlug: 'mediterranean', pendingSelection: null, pendingBlock: null, suggestedDefaultSlug: 'mediterranean',
    screening: { answers: { medication: 'no', pregnancy: 'no' }, pregnancyConflict: false },
    preferences: [
      item('it-1', 'allergy', 'Peanut', 'severe'),
      item('it-2', 'restriction', 'Vegetarian', null, 'staff', 'Dana Staff'),
    ],
    activityLevel: { level: 'moderate', source: 'diet_selection', recordedOn: '2026-09-20' },
    targets: {} as never,
    history: {
      selections: [{ id: 'sel-1', dietSlug: 'mediterranean', status: 'active', selectedByRole: 'patient', settings: {}, screeningSnapshot: {}, startedAt: '2026-09-20T12:00:00Z', endedAt: null }],
      blocks: [], episodes: [
        { id: 'ep-1', episodeNumber: 1, startedOn: '2026-08-01', endedOn: '2026-09-30', reason: 'enrollment', startedByRole: 'system', note: null, createdAt: '2026-08-01T00:00:00Z' },
        { id: 'ep-2', episodeNumber: 2, startedOn: '2026-10-01', endedOn: null, reason: 'staff_restart', startedByRole: 'staff', note: 'Back after travel', createdAt: '2026-10-01T00:00:00Z' },
      ],
      activity: [{ level: 'light', source: 'check_in', recordedOn: '2026-09-01' }, { level: 'moderate', source: 'diet_selection', recordedOn: '2026-09-20' }],
      targetSnapshots: [],
    },
    library,
  };
}
let state = baseState();
let failGet = false;
const requests: Array<{ method: string; url: string; body: any }> = [];
(globalThis as any).fetch = async (input: unknown, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ method, url, body });
  const path = url.split('?')[0];
  if (!path.startsWith('/api/office/patients/pt-1/')) throw new Error(`unexpected fetch ${method} ${url}`);
  if (path.endsWith('/diet') && method === 'GET') return failGet ? json({ error: 'Diet storage is offline' }, 503) : json(state);
  if (path.endsWith('/diet') && method === 'PUT') {
    if (body.dietSlug === 'keto' && !body.answers) return json({ error: 'Answer the screening questions first.', code: 'SCREENING_REQUIRED', questions: ['medication', 'eating_disorder', 'pregnancy'] }, 422);
    if (body.dietSlug === 'keto' && body.answers.medication === 'yes') {
      const block = { id: 'blk-1', selectionId: 'sel-2', dietSlug: 'keto', questions: ['medication'], status: 'pending', overrideStartedAt: null, reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: null, createdAt: '2026-10-10T16:00:00Z' } as const;
      const selection = { id: 'sel-2', dietSlug: 'keto', status: 'pending_review', selectedByRole: 'staff', settings: {}, screeningSnapshot: body.answers, startedAt: null, endedAt: null } as const;
      state = { ...state, pendingBlock: { ...block }, pendingSelection: { ...selection }, screening: { answers: { ...state.screening.answers, ...body.answers }, pregnancyConflict: false }, history: { ...state.history, blocks: [{ ...block }], selections: [{ ...selection }, ...state.history.selections] } };
      return json({ status: 'pending_review', reason: 'screening', questions: ['medication'], suggestedSlug: 'mediterranean', selection, block }, 202);
    }
    const selection = { id: 'sel-3', dietSlug: body.dietSlug, status: 'active', selectedByRole: 'staff', settings: {}, screeningSnapshot: body.answers ?? {}, startedAt: '2026-10-10T16:30:00Z', endedAt: null } as const;
    state = { ...state, currentDiet: { ...selection }, effectiveDietSlug: body.dietSlug, history: { ...state.history, selections: [{ ...selection }, ...state.history.selections] } };
    return json({ status: 'active', selection, previousDietSlug: 'mediterranean', state });
  }
  if (path.endsWith('/diet') && method === 'DELETE') {
    state = { ...state, currentDiet: null, effectiveDietSlug: null };
    return json({ status: 'cleared', previousDietSlug: 'mediterranean', state });
  }
  if (path.endsWith('/override') && method === 'POST') {
    return json({ challenge: 'chal-abc', confirmText: 'Are you sure you want to do this?', expiresAt: '2026-10-10T17:00:00Z', block: state.pendingBlock });
  }
  if (path.endsWith('/override/confirm') && method === 'POST') {
    if (body.challenge !== 'chal-abc') return json({ error: 'Start the override again.', code: 'CHALLENGE_MISMATCH' }, 409);
    const block = { ...state.pendingBlock!, status: 'overridden' as const, reviewedBy: 'staff-1', reviewedByName: 'Dana Staff', reviewedAt: '2026-10-10T16:45:00Z', reviewNote: body.note ?? null };
    const selection = { ...state.pendingSelection!, status: 'active' as const, startedAt: '2026-10-10T16:45:00Z' };
    state = { ...state, pendingBlock: null, pendingSelection: null, currentDiet: selection, effectiveDietSlug: 'keto', history: { ...state.history, blocks: [block], selections: [selection, ...state.history.selections.slice(1)] } };
    return json({ status: 'active', block, selection, previousDietSlug: 'mediterranean' });
  }
  if (path.endsWith('/reject') && method === 'POST') {
    const block = { ...state.pendingBlock!, status: 'rejected' as const, reviewedAt: '2026-10-10T16:50:00Z', reviewedByName: 'Dana Staff', reviewNote: body.note ?? null };
    state = { ...state, pendingBlock: null, pendingSelection: null, history: { ...state.history, blocks: [block] } };
    return json({ status: 'rejected', block });
  }
  if (path.endsWith('/protocol/restart') && method === 'POST') {
    const episode = { id: 'ep-3', episodeNumber: 3, startedOn: '2026-10-10', endedOn: null, reason: 'staff_restart', startedByRole: 'staff' as const, note: body.note ?? null, createdAt: '2026-10-10T17:00:00Z' };
    state = { ...state, phase: { ...state.phase, programDay: 1, episodeId: 'ep-3', episodeNumber: 3, episodeStartedOn: '2026-10-10' }, history: { ...state.history, episodes: [...state.history.episodes.map((e) => e.id === 'ep-2' ? { ...e, endedOn: '2026-10-09' } : e), episode] } };
    return json({ episode, state });
  }
  if (path.endsWith('/diet/preferences') && method === 'POST') {
    const added = { id: `it-${requests.length}`, list: body.list, key: body.key ?? `custom:${body.label}`, label: body.label ?? body.key, isCustom: !body.key, severity: body.severity ?? null, enteredByRole: 'staff' as const, enteredByName: 'Dana Staff', createdAt: '2026-10-10T17:10:00Z' };
    state = { ...state, preferences: [...state.preferences, added] };
    return json({ item: added }, 201);
  }
  if (path.includes('/diet/preferences/') && method === 'DELETE') {
    const id = path.split('/diet/preferences/')[1];
    state = { ...state, preferences: state.preferences.filter((p) => p.id !== id) };
    return json({ ok: true });
  }
  throw new Error(`Unexpected ${method} ${url}`);
};

// Host nodes get a mock DOM node so the section's scrollIntoView can be observed.
const scrollCalls: string[] = [];
async function render(canEdit: boolean, office: string | null = null, path = '/patients/pt-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const location = memoryLocation({ path });
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}><Router hook={location.hook} searchHook={location.searchHook}><LiveDiet patientId="pt-1" office={office} canEdit={canEdit} /></Router></QueryClientProvider>,
      { createNodeMock: (element) => ({ scrollIntoView: () => { scrollCalls.push(String(element.props['data-testid'] ?? element.type)); } }) },
    );
  });
  await settle();
  return renderer!;
}
const press = async (root: ReactTestInstance, id: string) => { await act(async () => { one(root, id).props.onClick(); }); await settle(); };
const change = async (root: ReactTestInstance, id: string, value: string) => { await act(async () => { one(root, id).props.onChange({ target: { value } }); }); };
const choose = async (root: ReactTestInstance, id: string) => { await act(async () => { one(root, id).props.onChange(); }); };
const submit = async (root: ReactTestInstance, id: string) => { await act(async () => { await one(root, id).props.onSubmit({ preventDefault() {} }); }); await settle(); };

console.log('LiveDiet');
__setSupabaseSession('staff-token');
{
  requests.length = 0;
  const renderer = await render(true);
  const root = renderer.root;
  const all = textOf(root);
  check('GET renders the current diet by library name', textOf(one(root, 'diet-current-name')) === 'Mediterranean');
  check('phase line shows protocol day and phase name', textOf(one(root, 'diet-phase-line')) === 'Day 10 of 42 · Low-calorie days' && textOf(one(root, 'badge-diet-phase')) === 'Protocol · wk 2');
  check('activity level is spelled out', textOf(one(root, 'diet-activity-current')) === 'Moderate activity 3-5 days a week');
  check('severe allergy flag is called out', byTestId(root, 'diet-severe-allergy').length === 1 && textOf(one(root, 'chip-severity-it-1')) === 'Severe');
  check('every list item shows who entered it', textOf(one(root, 'entered-by-it-1')).startsWith('Entered by Patient') && textOf(one(root, 'entered-by-it-2')).includes('Entered by Staff · Dana Staff'));
  check('four lists render with counts', ['allergy', 'sensitivity', 'restriction', 'dislike'].every((list) => byTestId(root, `diet-list-${list}`).length === 1) && textOf(one(root, 'diet-list-sensitivity')).includes('None recorded'));
  check('screening answers show every question', textOf(one(root, 'screening-medication')).endsWith('No') && textOf(one(root, 'screening-eating_disorder')).endsWith('Not answered'));
  check('history lists runs and selections', textOf(one(root, 'diet-episode-ep-2')).includes('Run 2') && textOf(one(root, 'diet-episode-ep-2')).includes('Back after travel') && byTestId(root, 'diet-selection-sel-1').length === 1);
  check('activity history is listed oldest info included', textOf(one(root, 'diet-activity-history')).includes('Light activity 1-3 days a week'));
  check('no pending block panel without a block', byTestId(root, 'diet-pending-block').length === 0 && !all.includes('Draft diet'));

  // Set / change diet: published entries only, screening prompts, patient-notified note.
  await press(root, 'button-set-diet');
  const options = one(root, 'select-diet-slug').findAll((node) => node.type === 'option').map((node) => node.props.value);
  check('diet picker offers only published entries', JSON.stringify(options) === JSON.stringify(['just_tracking', 'mediterranean', 'keto']), JSON.stringify(options));
  check('form states the patient is notified', textOf(one(root, 'diet-form-notified')) === PATIENT_NOTIFIED_NOTE);
  check('no screening block for a plain entry', byTestId(root, 'diet-form-screening').length === 0);
  await change(root, 'select-diet-slug', 'keto');
  check('keto asks its screening questions plus pregnancy', ['medication', 'eating_disorder', 'pregnancy'].every((q) => byTestId(root, `radio-screening-${q}-yes`).length === 1));
  check('prior screening answers pre-fill the radios', one(root, 'radio-screening-medication-no').props.checked === true && one(root, 'radio-screening-eating_disorder-no').props.checked === false);
  const putsBefore = requests.filter((r) => r.method === 'PUT').length;
  await submit(root, 'diet-form');
  check('unanswered screening blocks the save locally', byTestId(root, 'diet-form-error').length === 1 && requests.filter((r) => r.method === 'PUT').length === putsBefore);
  await choose(root, 'radio-screening-eating_disorder-no');
  await choose(root, 'radio-screening-medication-yes');
  await submit(root, 'diet-form');
  const put = requests.filter((r) => r.method === 'PUT').at(-1);
  check('PUT carries slug and only the asked answers', put?.body.dietSlug === 'keto' && JSON.stringify(put?.body.answers) === JSON.stringify({ medication: 'yes', eating_disorder: 'no', pregnancy: 'no' }), JSON.stringify(put?.body));
  check('202 pending lands as a block to review', byTestId(root, 'diet-pending-block').length === 1 && textOf(one(root, 'diet-notice')).includes('parked for review') && textOf(one(root, 'diet-current-name')) === 'Mediterranean');
  check('block panel names the diet and the question', textOf(one(root, 'diet-pending-block')).includes('Ketogenic') && textOf(one(root, 'diet-pending-block')).includes('Diabetes medication'));

  // Two-step override.
  const writesBefore = requests.filter((r) => r.method !== 'GET').length;
  await press(root, 'button-override-block');
  const overrideCalls = requests.filter((r) => r.url.includes('/override'));
  check('step one only fetches the challenge', overrideCalls.length === 1 && overrideCalls[0].url.endsWith('/diet/blocks/blk-1/override') && state.pendingBlock !== null);
  check('step one shows the second confirmation prompt', textOf(one(root, 'diet-override-confirm-text')) === 'Are you sure you want to do this?');
  check('nothing else was written in step one', requests.filter((r) => r.method !== 'GET').length === writesBefore + 1);
  await press(root, 'button-cancel-override');
  check('cancelling the challenge writes nothing', byTestId(root, 'diet-override-challenge').length === 0 && state.pendingBlock !== null);
  await press(root, 'button-override-block');
  await change(root, 'input-override-note', 'Endocrinologist cleared the plan');
  await press(root, 'button-confirm-override');
  const confirm = requests.find((r) => r.url.endsWith('/override/confirm'));
  check('confirm echoes the challenge with the note', JSON.stringify(confirm?.body) === JSON.stringify({ challenge: 'chal-abc', note: 'Endocrinologist cleared the plan' }), JSON.stringify(confirm?.body));
  check('override activates the diet and clears the panel', byTestId(root, 'diet-pending-block').length === 0 && textOf(one(root, 'diet-current-name')) === 'Ketogenic');
  check('history shows the override with reviewer and note', textOf(one(root, 'diet-block-blk-1')).includes('Overridden') && textOf(one(root, 'diet-block-blk-1')).includes('Dana Staff') && textOf(one(root, 'diet-block-blk-1')).includes('Endocrinologist cleared the plan'));

  // Restart protocol: explanation, then one POST.
  await press(root, 'button-restart-protocol');
  check('restart confirmation explains day one and nothing deleted', textOf(one(root, 'diet-restart-confirm')).includes(RESTART_EXPLANATION) && requests.filter((r) => r.url.endsWith('/protocol/restart')).length === 0);
  await change(root, 'input-restart-note', 'Fresh start');
  await press(root, 'button-confirm-restart');
  const restart = requests.find((r) => r.url.endsWith('/protocol/restart'));
  check('restart POSTs the note only', JSON.stringify(restart?.body) === JSON.stringify({ note: 'Fresh start' }));
  check('restart lands on day one of run 3', textOf(one(root, 'diet-phase-line')).startsWith('Day 1 of 42') && textOf(one(root, 'diet-current')).includes('Protocol run 3') && byTestId(root, 'diet-episode-ep-1').length === 1);

  // Lists: catalog item with severity, custom item, remove.
  await press(root, 'button-add-list-item');
  await change(root, 'select-item-key', 'shellfish');
  await choose(root, 'radio-item-severity-severe');
  await submit(root, 'diet-item-form');
  const addCatalog = requests.filter((r) => r.url.endsWith('/diet/preferences') && r.method === 'POST').at(-1);
  check('catalog allergy POSTs key + severity', JSON.stringify(addCatalog?.body) === JSON.stringify({ list: 'allergy', key: 'shellfish', severity: 'severe' }), JSON.stringify(addCatalog?.body));
  check('added item appears with staff entered-by', textOf(one(root, 'diet-list-allergy')).includes('shellfish') && textOf(one(root, 'diet-list-allergy')).includes('Dana Staff'));
  await press(root, 'button-add-list-item');
  await change(root, 'select-item-list', 'dislike');
  check('dislikes have no catalog or severity', byTestId(root, 'select-item-key').length === 0 && byTestId(root, 'radio-item-severity-severe').length === 0);
  await submit(root, 'diet-item-form');
  check('empty custom label is rejected inline', byTestId(root, 'diet-item-error').length === 1);
  await change(root, 'input-item-label', 'Cilantro');
  await submit(root, 'diet-item-form');
  const addCustom = requests.filter((r) => r.url.endsWith('/diet/preferences') && r.method === 'POST').at(-1);
  check('custom dislike POSTs the label only', JSON.stringify(addCustom?.body) === JSON.stringify({ list: 'dislike', label: 'Cilantro' }), JSON.stringify(addCustom?.body));
  await press(root, 'button-remove-item-it-2');
  check('remove DELETEs the item and drops the row', requests.some((r) => r.method === 'DELETE' && r.url.endsWith('/diet/preferences/it-2')) && byTestId(root, 'diet-item-it-2').length === 0);

  // Take off diet needs a confirm.
  await press(root, 'button-clear-diet');
  check('clear asks before writing', byTestId(root, 'button-confirm-clear-diet').length === 1 && !requests.some((r) => r.method === 'DELETE' && r.url.endsWith('/diet')));
  await press(root, 'button-confirm-clear-diet');
  check('clear lands as no diet with history kept', textOf(one(root, 'diet-current-name')) === 'No diet' && byTestId(root, 'diet-selection-sel-1').length === 1);
  renderer.unmount();
}

console.log('LiveDiet — reject path, HQ scope and read-only');
{
  state = baseState();
  state.pendingBlock = { id: 'blk-9', selectionId: 'sel-9', dietSlug: 'keto', questions: ['medication', 'pregnancy'], status: 'pending', overrideStartedAt: null, reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: null, createdAt: '2026-10-09T10:00:00Z' };
  state.pendingSelection = { id: 'sel-9', dietSlug: 'keto', status: 'pending_review', selectedByRole: 'patient', settings: {}, screeningSnapshot: { medication: 'yes' }, startedAt: null, endedAt: null };
  state.screening = { answers: { medication: 'yes', pregnancy: 'yes' }, pregnancyConflict: true };
  requests.length = 0;
  const renderer = await render(true, 'off-77');
  const root = renderer.root;
  check('HQ drill-in sends ?office= on the read', requests[0]?.url.endsWith('/diet?office=off-77') === true, requests[0]?.url);
  check('pregnancy conflict warning renders', byTestId(root, 'diet-pregnancy-conflict').length === 1);
  await press(root, 'button-reject-block');
  await change(root, 'input-reject-note', 'Keep Mediterranean for now');
  await press(root, 'button-confirm-reject');
  const reject = requests.find((r) => r.url.includes('/reject'));
  check('reject POSTs under the office scope with the note', reject?.url === '/api/office/patients/pt-1/diet/blocks/blk-9/reject?office=off-77' && reject?.body.note === 'Keep Mediterranean for now', reject?.url);
  check('rejected block leaves the current diet alone', byTestId(root, 'diet-pending-block').length === 0 && textOf(one(root, 'diet-current-name')) === 'Mediterranean' && textOf(one(root, 'diet-block-blk-9')).includes('Rejected'));
  renderer.unmount();

  state = baseState();
  state.pendingBlock = { id: 'blk-9', selectionId: 'sel-9', dietSlug: 'keto', questions: ['medication'], status: 'pending', overrideStartedAt: null, reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: null, createdAt: '2026-10-09T10:00:00Z' };
  const readOnly = await render(false);
  check('read-only still shows the pending block', byTestId(readOnly.root, 'diet-pending-block').length === 1);
  check('read-only renders no write controls', readOnly.root.findAll((node) => node.type === 'button').length === 0);
  readOnly.unmount();

  failGet = true;
  const broken = await render(true);
  check('a failed read says unavailable, never empty lists', byTestId(broken.root, 'diet-unavailable').length === 1 && byTestId(broken.root, 'diet-list-allergy').length === 0 && textOf(one(broken.root, 'diet-unavailable')).includes('Diet storage is offline'));
  broken.unmount();
  failGet = false;
}

console.log('LiveDiet — alert deep link');
{
  // Bell and alerts-page links land on ?section=diet: the section scrolls
  // itself into view once its data is in, and only once per visit.
  state = baseState();
  scrollCalls.length = 0;
  const renderer = await render(true, null, '/patients/pt-1?section=diet');
  check('section carries the diet anchor id', one(renderer.root, 'live-diet').props.id === 'diet');
  check('deep link scrolls the diet section into view exactly once', scrollCalls.length === 1 && scrollCalls[0] === 'live-diet', scrollCalls.join(','));
  await press(renderer.root, 'button-set-diet');
  await settle();
  check('later renders do not scroll again', scrollCalls.length === 1, String(scrollCalls.length));
  renderer.unmount();
  scrollCalls.length = 0;
  const plain = await render(true);
  check('without the query nothing scrolls', scrollCalls.length === 0 && one(plain.root, 'live-diet').props.id === 'diet');
  plain.unmount();
}

console.log('Audit labels');
{
  const actions = ['patient_diet_set', 'patient_diet_cleared', 'patient_diet_block_override_started', 'patient_diet_block_overridden', 'patient_diet_block_rejected', 'patient_protocol_restarted', 'patient_preference_item_added', 'patient_preference_item_removed', 'patient_diet_viewed'];
  check('every diet audit action has a readable label', actions.every((action) => typeof AUDIT_ACTION_LABELS[action] === 'string' && !/_/.test(AUDIT_ACTION_LABELS[action])), actions.filter((a) => !AUDIT_ACTION_LABELS[a]).join(','));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll live diet checks passed');
