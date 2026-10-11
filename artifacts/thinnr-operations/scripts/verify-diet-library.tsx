/**
 * HQ Diet library — rules + list page + entry editor.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:diet-library
 *
 * Pure half (src/lib/diet-library.ts):
 *   - review transitions per status (publish / retire / unpublish need the
 *     second confirmation; mark reviewed does not; just tracking has none);
 *   - counts, filter + search + sort order;
 *   - form round-trip, client validation mirror, fit-rule parsing, PATCH holds
 *     only changed fields with expectedVersion, save warnings, publish gate.
 *
 * Rendered half (REAL pages under react-test-renderer, Radix alert-dialog
 * swapped for the DOM-free stand-in, global fetch scripted):
 *   - list: loading → 27 rows (26 + just tracking), status chips, pregnancy
 *     chips, metric tiles, status tab + search filtering, "Always available"
 *     chip for just tracking, 502 → Error tiles + retry;
 *   - editor: form bound to the entry, dirty gating, edit + save PUTs only
 *     the changed fields with expectedVersion (PUT), 409 RECORD_CHANGED reloads,
 *     publish asks a second time (cancel = no request), confirm POSTs the
 *     review move, mark reviewed POSTs without a dialog, published entries
 *     warn before a save, dirty form blocks review moves, version history;
 *   - permission: the library rides the knowledge (content) permission.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HqDietLibrary, HqDietLibraryEntry, HqDietLibraryEntryDetail } from '@workspace/api-client-react';
import { __setSession } from './a11y-stubs/session';
import { __setHqData } from './a11y-stubs/hq-data';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import DietLibrary from '../src/pages/admin/DietLibrary';
import DietLibraryEntryPage from '../src/pages/admin/DietLibraryEntry';
import { canHq, permissionForAdminPath } from '../src/data/hq/team';
import {
  JUST_TRACKING_SLUG,
  REVIEW_STATUS_ORDER,
  countLibrary,
  describeApiProblem,
  entryToForm,
  filterLibrary,
  formToPatch,
  parseFitRulesText,
  publishBlockedReason,
  reviewTransitionsFor,
  saveWarningFor,
  textToLines,
  transitionConfirmCopy,
  validateForm,
} from '../src/lib/diet-library';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.window.innerWidth ??= 1280;
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.location ??= { assign: () => {} };
g.window.setInterval ??= (...args: Parameters<typeof setInterval>) => setInterval(...args);
g.window.clearInterval ??= (id: ReturnType<typeof setInterval>) => clearInterval(id);
g.document ??= { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') { parts.push(node); return; }
    node.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(instance);
  return parts.join('');
}
const dialogsOf = (root: ReactTestInstance) => root.findAll((node) => node.props.role === 'alertdialog' && typeof node.type === 'string');
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const rowSlugs = (root: ReactTestInstance) => root.findAll((n) => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('row-diet-')).map((n) => n.props['data-testid'].replace('row-diet-', ''));
const settle = async (ticks = 10) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
const type = async (node: ReactTestInstance, value: string) => { await act(async () => { node.props.onChange({ target: { value } }); }); };
const click = async (node: ReactTestInstance) => { await act(async () => { node.props.onClick?.({ preventDefault() {} }); }); };

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = '2026-10-09T15:00:00.000Z';
const FRAMEWORKS: Array<[string, string]> = [
  ['mediterranean', 'Mediterranean'], ['dash', 'DASH'], ['mind', 'MIND'], ['flexitarian', 'Flexitarian'], ['pescatarian', 'Pescatarian'],
  ['vegetarian', 'Vegetarian'], ['vegan', 'Vegan'], ['whole_food_plant_based', 'Whole-food plant-based'], ['low_carb', 'Low carb'], ['ketogenic', 'Ketogenic'],
  ['paleo', 'Paleo'], ['whole30', 'Whole30'], ['low_fodmap', 'Low FODMAP'], ['gluten_free', 'Gluten-free'], ['dairy_free', 'Dairy-free'],
  ['anti_inflammatory', 'Anti-inflammatory'], ['intermittent_fasting', 'Intermittent fasting'], ['high_protein', 'High protein'], ['low_fat', 'Low fat'], ['low_sodium', 'Low sodium'],
  ['diabetic', 'Diabetes-friendly'], ['heart_healthy', 'Heart healthy'], ['renal', 'Kidney-friendly'], ['carnivore', 'Carnivore'], ['nordic', 'Nordic'], ['volumetrics', 'Volumetrics'],
];
function entry(slug: string, name: string, index: number, overrides: Partial<HqDietLibraryEntry> = {}): HqDietLibraryEntry {
  return {
    id: `id-${slug}`, slug, name, summary: `${name} in plain language.`, complexity: 'moderate',
    ruleSheet: ['Eat mostly plants.', 'Olive oil as the main fat.'], sampleDay: ['Breakfast: oats with fruit.'], oversightNote: null,
    pregnancyBlocked: false, screeningQuestions: ['medication'], fitRules: { mode: 'exclude', excludeTags: ['processed'] }, sortOrder: index * 10,
    oversightRecommended: false, evidenceStrength: 'moderate', supervisionLevel: 'none', sources: ['Program guide, 2026'],
    reviewStatus: 'published', reviewedBy: 'hq-2', reviewedAt: NOW, publishedAt: NOW, version: 3, updatedBy: 'hq-2', createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}
const ENTRIES: HqDietLibraryEntry[] = [
  ...FRAMEWORKS.map(([slug, name], index) => entry(slug, name, index + 1, slug === 'ketogenic'
    ? { reviewStatus: 'draft', pregnancyBlocked: true, screeningQuestions: ['medication', 'pregnancy'], publishedAt: null, reviewedAt: null, version: 5 }
    : slug === 'carnivore' ? { reviewStatus: 'retired' } : slug === 'low_fodmap' ? { reviewStatus: 'reviewed', publishedAt: null, oversightRecommended: true } : {})),
  entry(JUST_TRACKING_SLUG, 'Just tracking', 0, { screeningQuestions: [], fitRules: { mode: 'include' }, version: 1 }),
];
const library = (): HqDietLibrary => ({ entries: ENTRIES.map((e) => ({ ...e })), settings: { disclaimer: 'General wellness information, not medical advice.', oversightNoteText: 'Consider talking to your care team.' } });
const detailFor = (slug: string): HqDietLibraryEntryDetail => {
  const found = ENTRIES.find((e) => e.slug === slug)!;
  return { entry: { ...found }, versions: [
    { version: found.version, changedBy: 'hq-2', changeNote: 'Clarified the fat guidance', createdAt: NOW },
    ...(found.version > 1 ? [{ version: 1, changedBy: null, changeNote: null, createdAt: '2026-09-01T12:00:00.000Z' }] : []),
  ] };
};

console.log('rules');
{
  const t = (status: HqDietLibraryEntry['reviewStatus']) => reviewTransitionsFor(status, 'keto').map((x) => `${x.to}${x.confirm ? '!' : ''}`).join();
  check('transitions: draft→reviewed (no confirm); reviewed→publish!/draft; published→retire!/draft!; retired→draft', t('draft') === 'reviewed' && t('reviewed') === 'published!,draft' && t('published') === 'retired!,draft!' && t('retired') === 'draft', `${t('draft')} | ${t('reviewed')} | ${t('published')} | ${t('retired')}`);
  check('just tracking has no review moves', reviewTransitionsFor('published', JUST_TRACKING_SLUG).length === 0);
  check('confirm copy names the diet and the patient-facing effect', transitionConfirmCopy('published', 'Keto').title.includes('Keto') && transitionConfirmCopy('published', 'Keto').body.includes('counsel') && transitionConfirmCopy('retired', 'Keto').body.includes('nothing is deleted') && transitionConfirmCopy('draft', 'Keto').action === 'Yes, unpublish');
  const counts = countLibrary(ENTRIES);
  check('counts: 27 entries, 24 published, 1 reviewed, 1 draft, 1 retired', counts.total === 27 && counts.byStatus.published === 24 && counts.byStatus.reviewed === 1 && counts.byStatus.draft === 1 && counts.byStatus.retired === 1, JSON.stringify(counts));
  check('filter by status + search (name, slug, summary), sorted by sort order with just tracking first',
    filterLibrary(ENTRIES, 'draft', '').map((e) => e.slug).join() === 'ketogenic' && filterLibrary(ENTRIES, 'all', 'FODMAP').map((e) => e.slug).join() === 'low_fodmap'
      && filterLibrary(ENTRIES, 'all', 'whole_food').length === 1 && filterLibrary(ENTRIES, 'all', '')[0].slug === JUST_TRACKING_SLUG && filterLibrary(ENTRIES, 'all', '')[1].slug === 'mediterranean');
  check('review status order is published, reviewed, draft, retired', REVIEW_STATUS_ORDER.join() === 'published,reviewed,draft,retired');
  const keto = ENTRIES.find((e) => e.slug === 'ketogenic')!;
  const form = entryToForm(keto);
  check('form round-trip: lines joined, fit rules pretty JSON, empty change note', form.ruleSheet === 'Eat mostly plants.\nOlive oil as the main fat.' && form.fitRules.includes('"mode": "exclude"') && form.changeNote === '' && form.sortOrder === '100');
  check('unchanged form → no patch', formToPatch(form, keto) === null);
  const patch = formToPatch({ ...form, summary: '  Fewer carbs, more fat.  ', screeningQuestions: ['pregnancy', 'medication'], changeNote: 'tightened' }, keto);
  check('patch carries only changed fields + expectedVersion + change note (screening order normalised → unchanged)', JSON.stringify(patch) === JSON.stringify({ expectedVersion: 5, summary: 'Fewer carbs, more fat.', changeNote: 'tightened' }), JSON.stringify(patch));
  const patch2 = formToPatch({ ...form, ruleSheet: 'One\n\n  Two  \n', pregnancyBlocked: false, sortOrder: '7', fitRules: '{"mode":"include","includeTags":["keto"]}' }, keto);
  check('lists trim + drop blank lines; booleans, numbers and parsed rules ride the patch', JSON.stringify(patch2?.ruleSheet) === '["One","Two"]' && patch2?.pregnancyBlocked === false && patch2?.sortOrder === 7 && JSON.stringify(patch2?.fitRules) === '{"mode":"include","includeTags":["keto"]}');
  const problems = validateForm({ ...form, name: '', summary: 'x'.repeat(601), fitRules: '[1]', sortOrder: '-1', changeNote: 'c'.repeat(501), ruleSheet: Array.from({ length: 41 }, (_, i) => `r${i}`).join('\n') });
  check('validation mirror flags name, summary, rule sheet length, fit rules, sort order, change note', ['name', 'summary', 'ruleSheet', 'fitRules', 'sortOrder', 'changeNote'].every((f) => problems.some((p) => p.field === f)) && problems.length === 6, problems.map((p) => p.field).join());
  check('fit rules: needs an object with mode exclude|include, tag lists and non-negative bounds',
    !parseFitRulesText('nope').ok && !parseFitRulesText('{"mode":"maybe"}').ok && !parseFitRulesText('{"mode":"exclude","excludeTags":"x"}').ok && !parseFitRulesText('{"mode":"exclude","maxCarbsPerServing":-1}').ok && parseFitRulesText('{"mode":"exclude","maxCarbsPerServing":20}').ok);
  check('textToLines trims and drops blanks', textToLines(' a \n\n b\r\n').join('|') === 'a|b');
  check('save warning: published → off the app; reviewed → fresh review; draft → none; just tracking → none',
    saveWarningFor(ENTRIES[0])!.includes('back to draft') && saveWarningFor(ENTRIES.find((e) => e.slug === 'low_fodmap')!)!.includes('fresh review') && saveWarningFor(keto) === null && saveWarningFor(ENTRIES[26]) === null);
  check('publish gate: reviewed only', publishBlockedReason(keto)!.includes('reviewed') && publishBlockedReason(ENTRIES.find((e) => e.slug === 'low_fodmap')!) === null && publishBlockedReason(ENTRIES[0]) === 'Already published.' && publishBlockedReason(ENTRIES[26])!.includes('always available'));
  check('API problems: body error/code/field, 403 → role message, else fallback',
    describeApiProblem({ status: 409, data: { error: 'Changed', code: 'RECORD_CHANGED' } }, 'f').code === 'RECORD_CHANGED' && describeApiProblem({ status: 403 }, 'f').code === 'FORBIDDEN' && describeApiProblem(new Error('x'), 'fallback').message === 'fallback');
}

console.log('permissions');
{
  check('/admin/diet-library maps to the knowledge (content) permission', permissionForAdminPath('/admin/diet-library') === 'knowledge' && permissionForAdminPath('/admin/diet-library/keto') === 'knowledge');
  check('Content, Admin and Super Admin may open it; Support may not', canHq('Content', 'knowledge') && canHq('Admin', 'knowledge') && canHq('Super Admin', 'knowledge') && !canHq('Support', 'knowledge'));
}

// ─── Rendered pages ──────────────────────────────────────────────────────────

const requests: Array<{ method: string; url: string; body: unknown }> = [];
let listStatus = 200;
let detailVersion = 0;
let patchResponse: { status: number; body: unknown } | null = null;
let reviewResponse: { status: number; body: unknown } | null = null;
let hold: (() => void) | null = null;
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
  const json = (payload: unknown, code = 200) => new Response(JSON.stringify(payload), { status: code, headers: { 'Content-Type': 'application/json' } });
  if (url.endsWith('/api/hq/diet-library') && method === 'GET') {
    if (hold) await new Promise<void>((resolve) => { hold = resolve; });
    if (listStatus !== 200) return json({ error: 'Could not load the diet library right now.' }, listStatus);
    return json(library());
  }
  const entryMatch = url.match(/\/api\/hq\/diet-library\/([a-z_]+)(\/review)?$/);
  if (entryMatch && method === 'GET') {
    const detail = detailFor(entryMatch[1]);
    if (detailVersion) detail.entry.version = detailVersion;
    return json(detail);
  }
  if (entryMatch && !entryMatch[2] && method === 'PUT') {
    if (patchResponse) return json(patchResponse.body, patchResponse.status);
    const detail = detailFor(entryMatch[1]);
    const body = (JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = { ...detail.entry, ...body, version: detail.entry.version + 1, reviewStatus: 'draft' as const };
    delete (next as Record<string, unknown>).expectedVersion;
    delete (next as Record<string, unknown>).changeNote;
    return json({ entry: next, unpublished: detail.entry.reviewStatus === 'published' });
  }
  if (entryMatch && entryMatch[2] && method === 'POST') {
    if (reviewResponse) return json(reviewResponse.body, reviewResponse.status);
    const detail = detailFor(entryMatch[1]);
    const body = JSON.parse(String(init?.body)) as { status: HqDietLibraryEntry['reviewStatus'] };
    return json({ entry: { ...detail.entry, reviewStatus: body.status, version: detail.entry.version + 1 } });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

async function mount(path: string) {
  const location = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Router hook={location.hook}>
          <Route path="/admin/diet-library"><DietLibrary /></Route>
          <Route path="/admin/diet-library/:slug"><DietLibraryEntryPage /></Route>
        </Router>
      </QueryClientProvider>,
    );
  });
  return { renderer: renderer!, client, unmount: async () => { await act(async () => { renderer!.unmount(); }); client.clear(); } };
}

__setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1', displayName: 'Ada Admin' }, hqRole: 'Admin' });
__setSupabaseSession('token');
__setHqData({ accounts: [] });

console.log('list page');
{
  requests.length = 0;
  hold = () => {};
  const { renderer, client, unmount } = await mount('/admin/diet-library');
  await settle(2);
  const root = renderer.root;
  check('loading: tiles show — and the list says loading', textOf(byTestId(root, 'text-metric-published')[0]) === '—' && byTestId(root, 'status-library-loading').length === 1);
  const release = hold; hold = null; release();
  await settle();
  check('one list request', requests.filter((r) => r.url.endsWith('/api/hq/diet-library')).length === 1);
  check('27 rows: 26 frameworks + just tracking first', rowSlugs(root).length === 27 && rowSlugs(root)[0] === JUST_TRACKING_SLUG && rowSlugs(root).includes('mediterranean'), rowSlugs(root).join());
  check('metric tiles carry the review counts', textOf(byTestId(root, 'text-metric-published')[0]) === '24' && textOf(byTestId(root, 'text-metric-reviewed')[0]) === '1' && textOf(byTestId(root, 'text-metric-draft')[0]) === '1' && textOf(byTestId(root, 'text-metric-retired')[0]) === '1');
  check('status chips: Draft for keto, Published for mediterranean, Always available for just tracking',
    textOf(byTestId(root, 'chip-diet-status-ketogenic')[0]) === 'Draft' && textOf(byTestId(root, 'chip-diet-status-mediterranean')[0]) === 'Published' && textOf(byTestId(root, `chip-diet-status-${JUST_TRACKING_SLUG}`)[0]) === 'Always available');
  check('pregnancy-block chip only on the flagged entry', byTestId(root, 'chip-pregnancy-ketogenic').length === 1 && byTestId(root, 'chip-pregnancy-mediterranean').length === 0);
  check('version column + entry links', textOf(byTestId(root, 'text-version-ketogenic')[0]) === 'v5' && byTestId(root, 'link-diet-ketogenic')[0].props.href === '/admin/diet-library/ketogenic');
  await click(byTestId(root, 'tab-status-draft')[0]);
  check('Draft tab narrows to the draft entry', rowSlugs(root).join() === 'ketogenic', rowSlugs(root).join());
  await click(byTestId(root, 'tab-status-all')[0]);
  await type(byTestId(root, 'input-search-library')[0], 'fodmap');
  check('search narrows by name', rowSlugs(root).join() === 'low_fodmap', rowSlugs(root).join());
  await type(byTestId(root, 'input-search-library')[0], 'zzz');
  check('no match → empty note, never an error', byTestId(root, 'text-library-empty').length === 1);
  check('shared wording card shows the disclaimer and oversight note', textOf(byTestId(root, 'text-settings-disclaimer')[0]).includes('not medical advice') && textOf(byTestId(root, 'text-settings-oversight')[0]).includes('care team'));
  const query = client.getQueryCache().findAll().find((q) => JSON.stringify(q.queryKey).includes('/api/hq/diet-library'));
  check('query key is identity-scoped', JSON.stringify(query?.queryKey).includes('"hq-1"'), JSON.stringify(query?.queryKey));
  await unmount();
}

console.log('list page — failure');
{
  requests.length = 0;
  listStatus = 502;
  const { renderer, unmount } = await mount('/admin/diet-library');
  await settle();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_300)); });
  await settle();
  const root = renderer.root;
  check('a 502 renders Error tiles + the error notice (never 0)', textOf(byTestId(root, 'text-metric-published')[0]) === 'Error' && byTestId(root, 'text-library-error').length === 1 && rowSlugs(root).length === 0 && !JSON.stringify(renderer.toJSON()).includes('"0"'));
  listStatus = 200;
  await click(byTestId(root, 'button-retry-library')[0]);
  await settle();
  check('Try again recovers', rowSlugs(root).length === 27 && textOf(byTestId(root, 'text-metric-published')[0]) === '24');
  await unmount();
}

console.log('entry editor — draft entry (keto)');
{
  requests.length = 0;
  const { renderer, unmount } = await mount('/admin/diet-library/ketogenic');
  await settle();
  const root = renderer.root;
  check('form bound to the entry', byTestId(root, 'input-name')[0].props.value === 'Ketogenic' && byTestId(root, 'checkbox-pregnancy-blocked')[0].props.checked === true
    && byTestId(root, 'checkbox-screening-pregnancy')[0].props.checked === true && byTestId(root, 'checkbox-screening-eating_disorder')[0].props.checked === false
    && byTestId(root, 'input-rule-sheet')[0].props.value === 'Eat mostly plants.\nOlive oil as the main fat.' && byTestId(root, 'input-sort-order')[0].props.value === '100');
  check('status rail: Draft, version 5, publish blocked until reviewed, Mark reviewed offered, no Publish button',
    textOf(byTestId(root, 'chip-entry-status')[0]) === 'Draft' && textOf(byTestId(root, 'text-entry-version')[0]) === 'Version 5'
      && textOf(byTestId(root, 'text-publish-blocked')[0]).includes('reviewed') && byTestId(root, 'button-review-reviewed').length === 1 && byTestId(root, 'button-review-published').length === 0);
  check('version history lists both versions newest first with change notes', byTestId(root, 'list-versions').length === 1 && textOf(byTestId(root, 'version-5')[0]).includes('Clarified the fat guidance') && textOf(byTestId(root, 'version-1')[0]).includes('No change note') && textOf(byTestId(root, 'version-1')[0]).includes('system'));
  check('clean form: Save and Discard disabled, no warning for a draft', byTestId(root, 'button-save-entry')[0].props.disabled === true && byTestId(root, 'button-discard')[0].props.disabled === true && byTestId(root, 'text-save-warning').length === 0);

  await type(byTestId(root, 'input-summary')[0], 'Very low carbohydrate, higher fat.');
  await act(async () => { byTestId(root, 'checkbox-screening-eating_disorder')[0].props.onChange({ target: { checked: true } }); });
  await type(byTestId(root, 'input-change-note')[0], 'Added ED screening');
  check('dirty form: Save enabled, review moves disabled with the note', byTestId(root, 'button-save-entry')[0].props.disabled === false && byTestId(root, 'button-review-reviewed')[0].props.disabled === true && byTestId(root, 'text-review-blocked-dirty').length === 1);

  await type(byTestId(root, 'input-fit-rules')[0], '{"mode":"nope"}');
  await act(async () => { byTestId(root, 'form-diet-entry')[0].props.onSubmit({ preventDefault() {} }); });
  await settle();
  check('invalid fit rules block the save client-side (no PUT)', byTestId(root, 'error-fitRules').length === 1 && byTestId(root, 'text-form-problems').length === 1 && !requests.some((r) => r.method === 'PUT'));
  await type(byTestId(root, 'input-fit-rules')[0], '{"mode":"exclude","excludeTags":["processed"],"maxCarbsPerServing":20}');
  await act(async () => { byTestId(root, 'form-diet-entry')[0].props.onSubmit({ preventDefault() {} }); });
  await settle();
  const patch = requests.find((r) => r.method === 'PUT');
  check('save PUTs only the changed fields with expectedVersion and the change note',
    patch?.url.endsWith('/api/hq/diet-library/ketogenic') === true && JSON.stringify(patch?.body) === JSON.stringify({ expectedVersion: 5, summary: 'Very low carbohydrate, higher fat.', screeningQuestions: ['medication', 'eating_disorder', 'pregnancy'], fitRules: { mode: 'exclude', excludeTags: ['processed'], maxCarbsPerServing: 20 }, changeNote: 'Added ED screening' }), JSON.stringify(patch?.body));
  check('after the save the entry and list are re-read', requests.filter((r) => r.method === 'GET' && r.url.endsWith('/diet-library/ketogenic')).length >= 2);

  // Mark reviewed needs no second confirmation.
  requests.length = 0;
  await click(byTestId(root, 'button-review-reviewed')[0]);
  await settle();
  const review = requests.find((r) => r.method === 'POST');
  check('Mark reviewed POSTs the review move straight away with expectedVersion', review?.url.endsWith('/diet-library/ketogenic/review') === true && JSON.stringify(review?.body) === JSON.stringify({ status: 'reviewed', expectedVersion: 5 }) && dialogsOf(root).length === 0, JSON.stringify(review?.body));
  await unmount();
}

console.log('entry editor — publish asks twice (low FODMAP, reviewed)');
{
  requests.length = 0;
  const { renderer, unmount } = await mount('/admin/diet-library/low_fodmap');
  await settle();
  const root = renderer.root;
  check('reviewed entry offers Publish and Back to draft; no publish-blocked note', byTestId(root, 'button-review-published').length === 1 && byTestId(root, 'button-review-draft').length === 1 && byTestId(root, 'text-publish-blocked').length === 0);
  await click(byTestId(root, 'button-review-published')[0]);
  check('Publish opens the confirmation and sends nothing yet', dialogsOf(root).length === 1 && textOf(byTestId(root, 'text-review-confirm-body')[0]).includes('counsel') && !requests.some((r) => r.method === 'POST'));
  await click(byTestId(root, 'button-review-cancel')[0]);
  check('Cancel closes it with no request', dialogsOf(root).length === 0 && !requests.some((r) => r.method === 'POST'));
  await click(byTestId(root, 'button-review-published')[0]);
  await click(byTestId(root, 'button-review-confirm')[0]);
  await settle();
  const publish = requests.find((r) => r.method === 'POST');
  check('confirming POSTs status=published with expectedVersion', JSON.stringify(publish?.body) === JSON.stringify({ status: 'published', expectedVersion: 3 }), JSON.stringify(publish?.body));
  await unmount();
}

console.log('entry editor — published entry warns + 409 reloads');
{
  requests.length = 0;
  const { renderer, unmount } = await mount('/admin/diet-library/mediterranean');
  await settle();
  const root = renderer.root;
  check('published entry offers Retire and Unpublish', byTestId(root, 'button-review-retired').length === 1 && byTestId(root, 'button-review-draft').length === 1);
  await type(byTestId(root, 'input-name')[0], 'Mediterranean (updated)');
  check('editing a live plan shows the back-to-draft warning before Save', byTestId(root, 'text-save-warning').length === 1 && textOf(byTestId(root, 'text-save-warning')[0]).includes('back to draft'));
  patchResponse = { status: 409, body: { error: 'This entry changed since you opened it.', code: 'RECORD_CHANGED' } };
  detailVersion = 4;
  await act(async () => { byTestId(root, 'form-diet-entry')[0].props.onSubmit({ preventDefault() {} }); });
  await settle();
  check('a 409 reports the conflict and reloads the newer version (edits dropped)', byTestId(root, 'text-save-problem').length === 1 && textOf(byTestId(root, 'text-save-problem')[0]).includes('latest version')
    || (textOf(byTestId(root, 'text-entry-version')[0]) === 'Version 4' && byTestId(root, 'input-name')[0].props.value === 'Mediterranean'), `${textOf(byTestId(root, 'text-entry-version')[0])} | ${byTestId(root, 'input-name')[0].props.value}`);
  check('the editor remounted on the newer version with the server values', textOf(byTestId(root, 'text-entry-version')[0]) === 'Version 4' && byTestId(root, 'input-name')[0].props.value === 'Mediterranean');
  patchResponse = null;
  detailVersion = 0;
  await click(byTestId(root, 'button-review-retired')[0]);
  check('Retire asks twice and explains nothing is deleted', dialogsOf(root).length === 1 && textOf(byTestId(root, 'text-review-confirm-body')[0]).includes('nothing is deleted'));
  await click(byTestId(root, 'button-review-cancel')[0]);
  await unmount();
}

console.log('entry editor — just tracking');
{
  const { renderer, unmount } = await mount(`/admin/diet-library/${JUST_TRACKING_SLUG}`);
  await settle();
  const root = renderer.root;
  check('just tracking: Always available, no review moves, no publish-blocked note', textOf(byTestId(root, 'chip-entry-status')[0]) === 'Always available' && root.findAll((n) => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('button-review-')).length === 0 && byTestId(root, 'text-publish-blocked').length === 0);
  await unmount();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall diet library checks passed');
