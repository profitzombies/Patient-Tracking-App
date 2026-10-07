/**
 * verify-patients-badge — the Patients menu badge, attention-first roster
 * ordering, and phone-number search in the operations web app.
 *
 * Renders the REAL office Shell and the REAL Patients page with
 * react-test-renderer under Node (tsconfig.patients-badge.json swaps in the
 * session / scope / supabase / popover stubs) against a scripted fetch.
 *
 * Covers:
 *   - phone digit normalization (typed and stored formatting, leading US 1,
 *     partial digit strings, digit-free queries never match phones)
 *   - badge model: loading → no number, 0 flagged → total, flagged → amber
 *     count with a label naming both numbers and an attention-first href
 *   - Shell (live): badge reads summary.totalPatients / summary.attention from
 *     the roster query; amber link carries ?attention=first; no second roster
 *     poll interval is introduced; header quick-search matches the live roster
 *     by phone and never says "synthetic"
 *   - Shell (demo): seeded total / seeded flagged count, same rules
 *   - Patients page: ?attention=first pins evaluator-flagged rows first while
 *     keeping the sort inside each group; the visible control clears the flag
 *     from the URL; phone search finds rows however the number is typed
 *
 * Run: pnpm --filter @workspace/thinnr-operations run test:patients-badge
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PatientSessionProvider } from '../src/contexts/patient-session';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import type { OfficePatient, OfficeRoster } from '../src/lib/office-roster';
import { matchesPhoneQuery, phoneDigits } from '../src/lib/phone-digits';
import { isAttentionFirst, patientsBadge, pinFlaggedFirst, withoutAttentionFirst } from '../src/lib/patients-badge';
import { buildDemoAttentionItems } from '../src/data/attention-demo';
import { MOCK_PATIENTS } from '../src/data/mock-data';
import { Shell } from '../src/components/layout/Shell';
import { useToast } from '../src/hooks/use-toast';
import Patients from '../src/pages/Patients';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Browser globals the Shell touches ───────────────────────────────────────
const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.dispatchEvent ??= () => true;
g.window.history ??= {};
g.window.requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
g.window.cancelAnimationFrame ??= (id: any) => clearTimeout(id);
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
};
g.window.localStorage ??= storage();
g.window.sessionStorage ??= storage();
g.document ??= { title: '', querySelector: () => null, activeElement: null };

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── Fixture ─────────────────────────────────────────────────────────────────
const AS_OF = '2026-09-06';
const OFFICE = { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics', providerCode: '483920' };

function patient(id: string, name: string, extra: Partial<OfficePatient> & { flagged?: boolean; startDate?: string }): OfficePatient {
  const { flagged = false, startDate = '2026-07-08', ...rest } = extra;
  return {
    id, name, email: `${id}@example.com`, phone: null, phoneDisplay: null, activationStatus: 'activated', verified: true,
    createdAt: '2026-07-01T00:00:00Z',
    program: { id: 'metabolic', day: 60, stage: 'protocol', week: 9, startDate, startingWeight: 210, currentWeight: 200, goalWeight: 170, weightChange: -10, lastLogDate: null },
    invitation: null,
    attention: flagged
      ? { flagged: true, reasons: [{ code: 'no_weight', label: 'No weight logged', days: 9 }], signature: 'no_weight' }
      : { flagged: false, reasons: [], signature: null },
    operational: {
      asOfDate: AS_OF, latestActivityDate: AS_OF, latestDiaryDate: AS_OF, latestCheckInDate: AS_OF, latestWaterDate: null, latestWeightDate: null, latestPhotoDate: null,
      loggedDays7: 4, checkIns7: 2, activity: null, status: flagged ? 'needs_attention' : 'on_track', reasons: [], followUps: [],
    },
    ...rest,
  } as OfficePatient;
}

// Start dates descend Ada → Bea → Cal → Dev → Eve under the default sort
// (newest first); Bea and Dev are the evaluator-flagged pair.
const PATIENTS: OfficePatient[] = [
  patient('pat-ada', 'Ada Aster', { startDate: '2026-08-20', phone: '+15551234567', phoneDisplay: '(555) 123-4567' }),
  patient('pat-bea', 'Bea Brook', { startDate: '2026-08-10', flagged: true, phone: '+15559876543', phoneDisplay: '(555) 987-6543' }),
  patient('pat-cal', 'Cal Cole', { startDate: '2026-07-30', phone: '(555) 246-8100', phoneDisplay: null }),
  patient('pat-dev', 'Dev Dunn', { startDate: '2026-07-20', flagged: true, phone: null, phoneDisplay: '555-135-7900' }),
  patient('pat-eve', 'Eve Ember', { startDate: '2026-07-10', phone: '15550001111', phoneDisplay: null }),
];

const summary = (attention: number): OfficeRoster['summary'] => ({
  totalPatients: PATIENTS.length, activePatients: PATIENTS.length, newEnrollments30d: 0, needsAttention: attention, attention,
  inactive: 0, invited: 0, checkInsOverdue: 0, loggingLapsed: 0, asOf: AS_OF,
});

const FLAGGED_ROSTER: OfficeRoster = { office: OFFICE, patients: PATIENTS, summary: summary(2) };
const CALM_ROSTER: OfficeRoster = {
  office: OFFICE,
  patients: PATIENTS.map((row) => ({ ...row, attention: { flagged: false, reasons: [], signature: null } })),
  summary: summary(0),
};
const EMPTY_ALERTS = { asOf: AS_OF, count: 0, total: 0, items: [] };

let roster: OfficeRoster | null = FLAGGED_ROSTER;
let rosterStatus = 200;
const requests: string[] = [];
g.fetch = async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push(url);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/api/office/roster')) return roster && rosterStatus === 200 ? json(200, roster) : json(rosterStatus, { error: 'unavailable' });
  if (url.includes('/api/office/alerts')) return json(200, EMPTY_ALERTS);
  throw new Error(`unexpected fetch ${url}`);
};

// ─── Render helpers ──────────────────────────────────────────────────────────
interface Rendered { renderer: ReactTestRenderer; root: ReactTestInstance; loc: ReturnType<typeof memoryLocation>; client: QueryClient }

async function settle() {
  for (let i = 0; i < 12; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function renderAt(node: React.ReactElement, path: string): Promise<Rendered> {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <PatientSessionProvider>
          <Router hook={loc.hook}>{node}</Router>
        </PatientSessionProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root, loc, client };
}

const renderShell = (path = '/overview') => renderAt(<Shell><div data-testid="page">page</div></Shell>, path);
const renderRoster = (path = '/patients') => renderAt(<Patients />, path);

function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') { parts.push(node); return; }
    node.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(instance);
  return parts.join('');
}

const byTestId = (root: ReactTestInstance, id: string) =>
  root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');

function menuCount(root: ReactTestInstance) {
  // The side menu renders the item list once per breakpoint layout; every copy must agree.
  const chips = byTestId(root, 'menu-count-patients');
  if (!chips.length) return null;
  const chip = chips[0];
  const visible = chip.children.find((child) => typeof child !== 'string' && child.props['aria-hidden'] === true) as ReactTestInstance | undefined;
  const srOnly = chip.children.find((child) => typeof child !== 'string' && child.props.className === 'sr-only') as ReactTestInstance | undefined;
  return {
    visible: visible ? textOf(visible) : textOf(chip),
    label: srOnly ? textOf(srOnly) : null,
    title: chip.props.title as string | undefined,
    tone: chip.props['data-tone'] as string,
    className: String(chip.props.className),
  };
}

/** The side-menu Patients rows (the ones carrying the badge chip); the phone tab bar has no badge. */
function patientsLinks(root: ReactTestInstance) {
  return root.findAll((node) => node.type === 'a' && typeof node.props.href === 'string' && /^\/patients(\?|$)/.test(node.props.href) && byTestId(node, 'menu-count-patients').length > 0);
}

function tableRowNames(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => node.type === 'tr' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('Open '))
    .map((row) => String(row.props['aria-label']).replace(/^Open /, '').replace(/[’']s patient record.*$/, ''));
}

/** Row ids in table order (each row's record link carries /patients/:id). */
function tableRowIds(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => node.type === 'tr' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('Open '))
    .map((row) => {
      const link = row.findAll((node) => node.type === 'a' && typeof node.props.href === 'string' && node.props.href.startsWith('/patients/'))[0];
      return link ? String(link.props.href).replace('/patients/', '') : '?';
    });
}

async function typeSearch(root: ReactTestInstance, value: string) {
  const input = root.find((node) => node.type === 'input' && node.props.id === 'patient-search');
  await act(async () => { input.props.onChange({ target: { value } }); });
  await settle();
}

const signInStaff = () => {
  __setScope(null);
  __setSupabaseSession('staff-token');
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1', displayName: 'Casey Staff' } });
};
const signOutDemo = () => {
  __setScope(null);
  __setSupabaseSession(null);
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null });
};

// ─── 1. Phone normalization ──────────────────────────────────────────────────
console.log('phone digits');
{
  check('strips formatting', phoneDigits('(555) 123-4567') === '5551234567');
  check('drops a leading US 1 from 11 digits', phoneDigits('+1 555 123 4567') === '5551234567' && phoneDigits('15551234567') === '5551234567');
  check('keeps 10 digits that start with 1', phoneDigits('1234567890') === '1234567890');
  check('keeps non-US 11-digit numbers', phoneDigits('+44 20 7946 095') === '44207946095');
  check('empty / null → empty string', phoneDigits(null) === '' && phoneDigits('') === '' && phoneDigits('ext') === '');

  const stored = '+15551234567';
  const display = '(555) 123-4567';
  for (const typed of ['5551234567', '555-123-4567', '(555) 123-4567', '+1 555 123 4567', '1 (555) 123-4567']) {
    check(`typed "${typed}" matches stored E.164`, matchesPhoneQuery(typed, stored, null));
    check(`typed "${typed}" matches formatted display`, matchesPhoneQuery(typed, null, display));
  }
  check('matches a stored value that carries a bare leading 1', matchesPhoneQuery('(555) 000-1111', '15550001111', null));
  check('matches a stored formatted value', matchesPhoneQuery('5552468100', '(555) 246-8100', null));
  check('partial digit string matches as a substring', matchesPhoneQuery('1234', stored, null) && matchesPhoneQuery('234-56', null, display));
  check('digits that are not in the number do not match', !matchesPhoneQuery('999', stored, display));
  check('a digit-free query never matches a phone', !matchesPhoneQuery('ada', stored, display) && !matchesPhoneQuery('', stored, display));
  check('missing phones never match', !matchesPhoneQuery('555', null, null) && !matchesPhoneQuery('555', undefined));
}

// ─── 2. Badge model ──────────────────────────────────────────────────────────
console.log('badge model');
{
  const loading = patientsBadge({ total: null, flagged: null });
  check('loading shows no number (not 0)', loading.count === undefined && loading.label === undefined && loading.href === '/patients');
  const calm = patientsBadge({ total: 48, flagged: 0 });
  check('0 flagged → total in the default tone', calm.count === 48 && calm.tone === 'default' && calm.label === '48 patients' && calm.href === '/patients');
  const unknownFlagged = patientsBadge({ total: 48, flagged: null });
  check('unknown flagged count falls back to the total', unknownFlagged.count === 48 && unknownFlagged.tone === 'default');
  const hot = patientsBadge({ total: 48, flagged: 2 });
  check('flagged → amber flagged count', hot.count === 2 && hot.tone === 'attention');
  check('flagged label names both numbers', hot.label === '2 need attention · 48 patients', hot.label);
  check('flagged href opens attention-first', hot.href === '/patients?attention=first');
  check('singular label', patientsBadge({ total: 1, flagged: 1 }).label === '1 needs attention · 1 patient');

  check('isAttentionFirst reads the flag', isAttentionFirst('?attention=first') && isAttentionFirst('?status=active&attention=first') && !isAttentionFirst('?attention=last') && !isAttentionFirst(''));
  check('withoutAttentionFirst keeps the other params', withoutAttentionFirst('?status=active&attention=first') === '?status=active' && withoutAttentionFirst('?attention=first') === '');
  const pinned = pinFlaggedFirst([{ n: 1, f: false }, { n: 2, f: true }, { n: 3, f: false }, { n: 4, f: true }], (row) => row.f).map((row) => row.n);
  check('pinFlaggedFirst is a stable partition', pinned.join(',') === '2,4,1,3', pinned.join(','));
}

// ─── 3. Shell badge — live office ────────────────────────────────────────────
console.log('shell badge: live, flagged');
{
  signInStaff();
  roster = FLAGGED_ROSTER; rosterStatus = 200; requests.length = 0;
  const { renderer, root, client } = await renderShell();
  const chip = menuCount(root);
  check('badge shows the flagged count', chip?.visible === '2', JSON.stringify(chip));
  check('badge is amber', chip?.tone === 'attention' && chip.className.includes('#fff4e6'));
  check('badge label names both numbers', chip?.label === '2 need attention · 5 patients' && chip.title === '2 need attention · 5 patients', JSON.stringify(chip));
  const links = patientsLinks(root);
  check('Patients link carries the attention-first flag', links.length > 0 && links.every((link) => link.props.href === '/patients?attention=first'), links.map((l) => l.props.href).join(' '));
  const rosterFetches = requests.filter((url) => url.includes('/api/office/roster')).length;
  check('one roster fetch feeds the badge', rosterFetches === 1, `${rosterFetches} fetches`);
  // The shell's query shares the roster cache key (no second poller): the
  // Patients page's own observer would attach to this same entry.
  const rosterQueries = client.getQueryCache().findAll().filter((query) => JSON.stringify(query.queryKey).includes('office-roster') || JSON.stringify(query.queryKey).includes('roster'));
  check('exactly one roster query lives in the cache', rosterQueries.length === 1, rosterQueries.map((query) => JSON.stringify(query.queryKey)).join(' | '));
  const intervals = rosterQueries.map((query) => (query.observers[0]?.options as { refetchInterval?: unknown })?.refetchInterval);
  check('the shell reuses the roster hook\'s existing interval (no new one)', intervals.length === 1 && intervals[0] === 30_000, JSON.stringify(intervals));

  renderer.unmount();
}

console.log('shell badge: live, nobody flagged');
{
  signInStaff();
  roster = CALM_ROSTER; rosterStatus = 200; requests.length = 0;
  const { renderer, root } = await renderShell();
  const chip = menuCount(root);
  check('badge shows the total', chip?.visible === '5' && chip.tone === 'default', JSON.stringify(chip));
  check('label is the plain total', chip?.label === '5 patients');
  const links = patientsLinks(root);
  check('Patients link is plain', links.length > 0 && links.every((link) => link.props.href === '/patients'));
  renderer.unmount();
}

console.log('shell badge: live, roster failed / loading');
{
  signInStaff();
  roster = null; rosterStatus = 503; requests.length = 0;
  const { renderer, root } = await renderShell();
  check('no number while the roster is unavailable (never 0)', menuCount(root) === null);
  renderer.unmount();
  rosterStatus = 200;
}

// ─── 4. Shell badge — demo persona ───────────────────────────────────────────
console.log('shell badge: demo');
{
  signOutDemo();
  requests.length = 0;
  const { renderer, root } = await renderShell();
  const seededFlagged = buildDemoAttentionItems(MOCK_PATIENTS).length;
  const chip = menuCount(root);
  check('demo makes no live requests', requests.length === 0, requests.join(' '));
  check('demo has seeded flagged patients to show', seededFlagged > 0, String(seededFlagged));
  check('demo badge shows the seeded flagged count in amber', chip?.visible === String(seededFlagged) && chip.tone === 'attention', JSON.stringify(chip));
  check('demo label names both numbers', chip?.label === `${seededFlagged} need${seededFlagged === 1 ? 's' : ''} attention · ${MOCK_PATIENTS.length} patients`, chip?.label ?? '');
  renderer.unmount();
}

// ─── 5. Header quick-search ──────────────────────────────────────────────────
async function quickSearch(root: ReactTestInstance, query: string) {
  const searchButton = root.find((node) => node.type === 'button' && node.props['aria-label'] === 'Search');
  await act(async () => { searchButton.props.onClick(); });
  const input = byTestId(root, 'input-quick-search')[0];
  await act(async () => { input.props.onChange({ target: { value: query } }); });
  await act(async () => { input.props.onKeyDown({ key: 'Enter' }); });
  await settle();
}

console.log('quick-search: live office');
{
  signInStaff();
  roster = FLAGGED_ROSTER; requests.length = 0;
  const { renderer, root, loc } = await renderShell();
  await quickSearch(root, '(555) 987-6543');
  check('phone query routes to the live patient', loc.history.at(-1) === '/patients/pat-bea', loc.history.join(' → '));
  await quickSearch(root, 'pat-cal@example.com');
  check('email query routes to the live patient', loc.history.at(-1) === '/patients/pat-cal', loc.history.join(' → '));
  await quickSearch(root, 'eve em');
  check('name query routes to the live patient', loc.history.at(-1) === '/patients/pat-eve');
  await quickSearch(root, 'Sarah');
  check('no live match falls back to the roster, not a demo record', loc.history.at(-1) === '/patients', loc.history.join(' → '));
  renderer.unmount();
}

// Toast copy: render the Toaster-free store directly through the hook module.
console.log('quick-search: toast copy');
{
  const seen: string[] = [];
  // Observe the toast store the way the Toaster does (no DOM needed).
  const Probe = () => {
    const { toasts } = useToast();
    React.useEffect(() => { toasts.forEach((item) => { const line = `${item.title ?? ''} — ${item.description ?? ''}`; if (!seen.includes(line)) seen.push(line); }); }, [toasts]);
    return null;
  };
  signInStaff();
  roster = FLAGGED_ROSTER;
  const { renderer, root } = await renderAt(<><Shell><div /></Shell><Probe /></>, '/overview');
  await quickSearch(root, '5551234567');
  await quickSearch(root, 'zzz');
  check('live match copy names the office roster', seen.some((line) => line.startsWith('Ada Aster opened') && line.includes('your patient roster')), seen.join(' | '));
  check('live copy never says "synthetic"', seen.length >= 2 && seen.every((line) => !/synthetic/i.test(line)), seen.join(' | '));
  renderer.unmount();

  seen.length = 0;
  signOutDemo();
  const demo = await renderAt(<><Shell><div /></Shell><Probe /></>, '/overview');
  const demoPatient = MOCK_PATIENTS[0];
  await quickSearch(demo.root, demoPatient.phone);
  check('demo persona still matches the seeded roster by phone', demo.loc.history.at(-1) === `/patients/${demoPatient.id}`, demo.loc.history.join(' → '));
  check('demo copy keeps the synthetic wording', seen.some((line) => line.includes('synthetic patient roster')), seen.join(' | '));
  demo.renderer.unmount();
}

// ─── 6. Patients page: attention-first + phone search (live) ─────────────────
console.log('roster: attention-first ordering');
{
  signInStaff();
  roster = FLAGGED_ROSTER; requests.length = 0;
  const plain = await renderRoster('/patients');
  check('default order is the roster sort (newest start first)', tableRowNames(plain.root).join(',') === 'Ada Aster,Bea Brook,Cal Cole,Dev Dunn,Eve Ember', tableRowNames(plain.root).join(','));
  check('no pin control without the URL flag', byTestId(plain.root, 'button-clear-attention-first').length === 0);
  plain.renderer.unmount();

  const pinned = await renderRoster('/patients?attention=first');
  check('?attention=first lifts flagged rows to the top, sort kept inside each group', tableRowNames(pinned.root).join(',') === 'Bea Brook,Dev Dunn,Ada Aster,Cal Cole,Eve Ember', tableRowNames(pinned.root).join(','));
  const control = byTestId(pinned.root, 'button-clear-attention-first')[0];
  check('visible control announces the pinned count', Boolean(control) && String(control.props['aria-label']).includes('2 flagged patients'), control?.props['aria-label']);
  // Sorting by name keeps the pin: flagged A→Z first, then the rest A→Z.
  const nameHeader = pinned.root.find((node) => node.type === 'button' && textOf(node).trim().startsWith('Patient'));
  await act(async () => { nameHeader.props.onClick(); });
  await act(async () => { nameHeader.props.onClick(); });
  await settle();
  const afterSort = tableRowNames(pinned.root).join(',');
  check('changing the sort re-orders inside the groups only', afterSort === 'Bea Brook,Dev Dunn,Ada Aster,Cal Cole,Eve Ember' || afterSort === 'Dev Dunn,Bea Brook,Eve Ember,Cal Cole,Ada Aster', afterSort);
  await act(async () => { control.props.onClick(); });
  await settle();
  check('clearing the pin rewrites the URL (replace) without the flag; the header sort stays in the URL', pinned.loc.history.at(-1) === '/patients?sort=name.asc' && pinned.loc.history.length === 1, pinned.loc.history.join(' → '));
  check('control disappears once the flag is gone', byTestId(pinned.root, 'button-clear-attention-first').length === 0);
  pinned.renderer.unmount();

  const withFilter = await renderRoster('/patients?status=needs_attention&attention=first');
  const filterControl = byTestId(withFilter.root, 'button-clear-attention-first')[0];
  await act(async () => { filterControl.props.onClick(); });
  await settle();
  check('clearing the pin keeps the other query params', withFilter.loc.history.at(-1) === '/patients?status=needs_attention', withFilter.loc.history.join(' → '));
  withFilter.renderer.unmount();
}

console.log('roster: phone search');
{
  signInStaff();
  roster = FLAGGED_ROSTER;
  const { renderer, root } = await renderRoster('/patients');
  const label = root.find((node) => node.type === 'label' && node.props.htmlFor === 'patient-search');
  check('search label names phone', textOf(label) === 'Search patients by name, email, or phone');
  for (const [typed, expected] of [
    ['5551234567', 'Ada Aster'],
    ['555-123-4567', 'Ada Aster'],
    ['(555) 123-4567', 'Ada Aster'],
    ['+1 555 123 4567', 'Ada Aster'],
    ['987-6543', 'Bea Brook'],
    ['2468100', 'Cal Cole'],
    ['(555) 135-7900', 'Dev Dunn'],
    ['555 000 1111', 'Eve Ember'],
  ] as const) {
    await typeSearch(root, typed);
    check(`"${typed}" finds ${expected}`, tableRowNames(root).join(',') === expected, tableRowNames(root).join(','));
  }
  await typeSearch(root, '555');
  check('a partial digit string matches every row that carries it', tableRowNames(root).length === 5, tableRowNames(root).join(','));
  await typeSearch(root, 'bea');
  check('name matching is unchanged', tableRowNames(root).join(',') === 'Bea Brook');
  await typeSearch(root, 'pat-dev@');
  check('email matching is unchanged', tableRowNames(root).join(',') === 'Dev Dunn');
  await typeSearch(root, '0000000');
  check('empty state hints at phone search', tableRowNames(root).length === 0 && textOf(root).includes('Search by name, email, or phone.'));
  renderer.unmount();
}

console.log('roster: demo attention-first');
{
  signOutDemo();
  const seededFlagged = new Set(buildDemoAttentionItems(MOCK_PATIENTS).map((item) => item.patientId));
  const plain = await renderRoster('/patients');
  const plainIds = tableRowIds(plain.root);
  // The default view excludes sealed (closed) charts; those live under Archived.
  const openDemoPatients = MOCK_PATIENTS.filter((patient) => patient.closure == null).length;
  check('demo rows expose their record links', plainIds.length === openDemoPatients && !plainIds.includes('?'), `${plainIds.length} rows`);
  plain.renderer.unmount();
  const pinned = await renderRoster('/patients?attention=first');
  const pinnedIds = tableRowIds(pinned.root);
  const flaggedIds = plainIds.filter((id) => seededFlagged.has(id));
  const restIds = plainIds.filter((id) => !seededFlagged.has(id));
  check('demo pin lifts the seeded attention set, stable within groups', pinnedIds.join(',') === [...flaggedIds, ...restIds].join(','), `${pinnedIds.slice(0, 4).join(',')} …`);
  check('demo pin control shows the seeded flagged count', String(byTestId(pinned.root, 'button-clear-attention-first')[0]?.props['aria-label']).includes(`${flaggedIds.length} flagged`));
  pinned.renderer.unmount();
  const demoPhone = MOCK_PATIENTS[3].phone;
  const search = await renderRoster('/patients');
  await typeSearch(search.root, demoPhone.replace(/\D/g, ''));
  check('demo rows search by phone digits', tableRowNames(search.root).includes(MOCK_PATIENTS[3].name), tableRowNames(search.root).join(','));
  search.renderer.unmount();
}

console.log(failures ? `\n${failures} patients-badge check(s) failed` : '\nall patients-badge checks passed');
process.exit(failures ? 1 : 0);
