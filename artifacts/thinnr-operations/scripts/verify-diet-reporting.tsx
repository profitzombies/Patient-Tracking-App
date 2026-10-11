/**
 * HQ Diets & restrictions — rules + page states.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:diet-reporting
 *
 * Pure half (src/lib/diet-reporting.ts):
 *   - shares: null when nothing to divide by (never 0%), whole percents;
 *   - framework rows: by patients desc, "No diet chosen" always last, bar
 *     widths relative to the largest row;
 *   - list rows in the fixed four-list order; top items flag severity;
 *   - screening rows: yes share among answered, null when nobody answered;
 *   - office sort: numeric desc/asc with name tie-break; totals row mirrors
 *     the scope counts; definitions name every figure.
 *
 * Rendered half (REAL page under react-test-renderer; session / HQ directory
 * / supabase contexts stubbed via tsconfig.system-health.json, global fetch
 * scripted):
 *   - signed-out: a sign-in note and NO request (no seeded preview);
 *   - signed-in HQ: loading first (dashes), then live tiles, framework and
 *     list bars, screening, the per-practice table with the total row, office=
 *     on the narrowed request and the URL, the identity-scoped query key;
 *   - "Export CSV" posts the diet_restrictions kind with the range (and the
 *     narrowed office) through the export jobs and refreshes the job list;
 *   - a scope with no activated patient reads unavailable, never 0;
 *   - a 502 renders Error tiles + notices; Try again refetches;
 *   - permission: the page rides the overview (analytics) permission.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DietReportCounts, DietReportOfficeRow, DietRestrictionsResult } from '@workspace/api-client-react';
import { __setSession } from './a11y-stubs/session';
import { __setHqData } from './a11y-stubs/hq-data';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { DateRangeProvider } from '../src/contexts/date-range';
import DietReporting from '../src/pages/admin/DietReporting';
import { canHq, permissionForAdminPath } from '../src/data/hq/team';
import {
  DIET_REPORT_DEFINITIONS,
  DIET_RESTRICTIONS_EXPORT_KIND,
  LIST_TITLES,
  OFFICE_COLUMNS,
  frameworkRows,
  listRows,
  officeTotals,
  screeningRows,
  shareLabel,
  sharePct,
  sortOfficeRows,
  topItemRows,
} from '../src/lib/diet-reporting';

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
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const rowIds = (root: ReactTestInstance) => root.findAll((n) => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('row-diet-report-office-') && n.props['data-testid'] !== 'row-diet-report-office-total').map((n) => n.props['data-testid'].replace('row-diet-report-office-', ''));
const settle = async (ticks = 10) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

// ─── Fixtures ────────────────────────────────────────────────────────────────

const counts = (partial: Partial<DietReportCounts> = {}): DietReportCounts => ({
  patients: 200,
  onDiet: 140,
  justTracking: 15,
  noDiet: 45,
  byFramework: [
    { slug: 'none', name: 'No diet chosen', patients: 45 },
    { slug: 'just_tracking', name: 'Just tracking', patients: 15 },
    { slug: 'mediterranean', name: 'Mediterranean', patients: 80 },
    { slug: 'keto', name: 'Ketogenic', patients: 40 },
    { slug: 'dash', name: 'DASH', patients: 20 },
  ],
  phases: { protocol: 150, maintenance: 50 },
  lists: { allergy: 30, sensitivity: 12, restriction: 45, dislike: 90 },
  severeAllergyPatients: 9,
  topItems: [
    { list: 'dislike', key: 'cilantro', label: 'Cilantro', severity: null, patients: 40 },
    { list: 'allergy', key: 'peanut', label: 'Peanuts', severity: 'severe', patients: 7 },
    { list: 'allergy', key: 'shellfish', label: 'Shellfish', severity: 'mild', patients: 5 },
  ],
  changes: { total: 31, byPatient: 20, byStaff: 9, bySystem: 2 },
  blocks: { opened: 6, pending: 3, overridden: 2, rejected: 1 },
  pregnancyConflicts: 1,
  screening: [
    { question: 'medication', yes: 50, no: 150 },
    { question: 'eating_disorder', yes: 4, no: 196 },
    { question: 'pregnancy', yes: 0, no: 0 },
  ],
  ...partial,
});
const office = (id: string, name: string, patients: number, extra: Partial<DietReportOfficeRow> = {}): DietReportOfficeRow => ({
  providerId: id, name, patients, onDiet: Math.round(patients * 0.7), protocol: Math.round(patients * 0.75), maintenance: patients - Math.round(patients * 0.75),
  severeAllergy: 2, pendingBlocks: 1, pregnancyConflicts: 0, ...extra,
});
const OFFICES: DietReportOfficeRow[] = [
  office('office-a', 'Harbor Clinic', 120, { severeAllergy: 6, pendingBlocks: 2, pregnancyConflicts: 1 }),
  office('office-b', 'Summit Health', 80, { severeAllergy: 3, pendingBlocks: 1 }),
];

console.log('rules');
{
  check('sharePct: null when nothing to divide by, whole percents otherwise', sharePct(1, 0) === null && sharePct(0, 0) === null && sharePct(1, 3) === 33 && sharePct(2, 3) === 67);
  check('shareLabel copy', shareLabel(140, 200) === '70% of patients' && shareLabel(0, 0) === '—');
  const fw = frameworkRows(counts());
  check('framework rows: by patients desc, "No diet chosen" last, widths relative to the largest',
    fw.map((r) => r.key).join() === 'mediterranean,keto,dash,just_tracking,none' && fw[0].widthPct === 100 && fw[1].widthPct === 50 && fw[0].sharePct === 40 && fw[4].sharePct === 23, fw.map((r) => `${r.key}:${r.widthPct}`).join());
  check('framework rows on null counts are empty', frameworkRows(null).length === 0);
  const lists = listRows(counts());
  check('list rows keep the four-list order with the record titles', lists.map((r) => `${r.key}:${r.label}:${r.value}`).join() === 'allergy:Allergies:30,sensitivity:Sensitivities:12,restriction:Restrictions:45,dislike:Dislikes:90'
    && LIST_TITLES.allergy === 'Allergies');
  const items = topItemRows(counts());
  check('top items keep server order, carry the list name and severity tone', items[0].label === 'Cilantro · dislikes' && items[1].tone === 'severe' && items[2].tone === 'mild' && items[0].tone === null && items[1].sharePct === 4, items.map((i) => i.label).join('|'));
  check('top items honour the limit', topItemRows(counts(), 2).length === 2);
  const screening = screeningRows(counts());
  check('screening rows: yes share among answered, null when nobody answered', screening[0].label === 'Takes medication' && screening[0].yesPct === 25 && screening[1].yesPct === 2 && screening[2].yesPct === null);
  const asc = sortOfficeRows(OFFICES, 'patients', 'asc').map((r) => r.providerId).join();
  const desc = sortOfficeRows(OFFICES, 'severeAllergy', 'desc').map((r) => r.providerId).join();
  const byName = sortOfficeRows(OFFICES, 'name', 'desc').map((r) => r.providerId).join();
  check('office sort: numeric asc/desc, name desc', asc === 'office-b,office-a' && desc === 'office-a,office-b' && byName === 'office-b,office-a', `${asc} | ${desc} | ${byName}`);
  const tie = sortOfficeRows([office('z', 'Zulu', 10), office('a', 'Alpha', 10)], 'patients', 'desc').map((r) => r.providerId).join();
  check('ties break on practice name', tie === 'a,z', tie);
  check('office columns: practice then seven counts', OFFICE_COLUMNS.map((c) => c.key).join() === 'name,patients,onDiet,protocol,maintenance,severeAllergy,pendingBlocks,pregnancyConflicts');
  const totals = officeTotals({ range: { start: '2026-09-01', end: '2026-09-30' }, asOf: '2026-09-30T00:00:00Z', todayKey: '2026-09-30', office: null, available: true, counts: counts(), offices: OFFICES });
  check('totals row mirrors the scope counts under "All practices"', totals?.name === 'All practices' && totals.patients === 200 && totals.protocol === 150 && totals.maintenance === 50 && totals.severeAllergy === 9 && totals.pendingBlocks === 3 && totals.pregnancyConflicts === 1);
  check('totals row is absent when the scope is unavailable', officeTotals({ range: { start: '2026-09-01', end: '2026-09-30' }, asOf: '', todayKey: '', office: null, available: false, counts: null, offices: [] }) === null && officeTotals(undefined) === null);
  check('definitions name every figure and the unavailable rule', ['Patients', 'Protocol / Maintenance', 'Severe allergy', 'Diet changes', 'Safety blocks', 'Pregnancy conflicts', 'Screening answers', 'Unavailable'].every((term) => DIET_REPORT_DEFINITIONS.some((d) => d.term === term))
    && DIET_REPORT_DEFINITIONS.find((d) => d.term === 'Unavailable')!.text.includes('rather than zero'));
  check('export kind is the server\'s diet_restrictions', DIET_RESTRICTIONS_EXPORT_KIND === 'diet_restrictions');
}

console.log('permissions');
{
  check('/admin/diet-reporting maps to the overview (analytics) permission', permissionForAdminPath('/admin/diet-reporting') === 'overview');
  check('Admin and Super Admin may open it', canHq('Admin', 'overview') && canHq('Super Admin', 'overview'));
  check('Support, Content and Clinical may not', !canHq('Support', 'overview') && !canHq('Content', 'overview') && !canHq('Clinical', 'overview'));
}

// ─── Rendered page ───────────────────────────────────────────────────────────

function liveResult(start: string, end: string, officeId: string | null): DietRestrictionsResult {
  if (officeId) {
    const row = OFFICES.find((o) => o.providerId === officeId);
    if (!row) return { range: { start, end }, asOf: new Date().toISOString(), todayKey: end, office: { id: officeId, name: 'Unknown' }, available: false, counts: null, offices: [] };
    return {
      range: { start, end }, asOf: new Date().toISOString(), todayKey: end, office: { id: row.providerId, name: row.name }, available: true,
      counts: counts({ patients: row.patients, onDiet: row.onDiet, justTracking: 0, noDiet: row.patients - row.onDiet, phases: { protocol: row.protocol, maintenance: row.maintenance }, severeAllergyPatients: row.severeAllergy, blocks: { opened: 2, pending: row.pendingBlocks, overridden: 1, rejected: 0 }, pregnancyConflicts: row.pregnancyConflicts }),
      offices: [row],
    };
  }
  return { range: { start, end }, asOf: new Date().toISOString(), todayKey: end, office: null, available: true, counts: counts(), offices: OFFICES };
}

const requests: string[] = [];
const bodies: unknown[] = [];
const reportRequests = () => requests.filter((r) => r.includes('/api/hq/diet-restrictions?'));
let status = 200;
let unavailable = false;
let hold: (() => void) | null = null;
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push(`${method} ${url}`);
  const json = (payload: unknown, code = 200) => new Response(JSON.stringify(payload), { status: code, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/api/hq/diet-restrictions')) {
    if (hold) await new Promise<void>((resolve) => { hold = resolve; });
    if (status !== 200) return json({ error: 'Could not load the diet report right now.' }, status);
    const params = new URL(url, 'http://test.local').searchParams;
    const result = liveResult(params.get('start') ?? '', params.get('end') ?? '', params.get('office'));
    return json(unavailable ? { ...result, available: false, counts: null, offices: [] } : result);
  }
  if (url.endsWith('/api/exports') && method === 'GET') {
    return json({ jobs: [], available: [{ kind: 'diet_restrictions', label: 'Diets & restrictions', ranged: true, needsOffice: false, needsPatient: false }], ttlHours: 24 });
  }
  if (url.endsWith('/api/exports') && method === 'POST') {
    bodies.push(JSON.parse(String(init?.body)));
    return json({ job: { id: 'exp-1', kind: 'diet_restrictions', label: 'Diets & restrictions', status: 'queued', scope: { providerId: null, officeName: null, patientId: null, patientName: null }, range: null, fileName: null, sizeBytes: null, rowCount: null, error: null, createdAt: new Date().toISOString(), completedAt: null, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), downloadCount: 0, downloadable: false, parts: null, progress: null, omittedFiles: null, cancelRequested: false, includeTombstones: null } }, 202);
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

async function mount(path: string) {
  const location = memoryLocation({ path, record: true });
  const currentUrl = () => location.history[location.history.length - 1];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <DateRangeProvider>
          <Router hook={location.hook}>
            <Route path="/admin/diet-reporting"><DietReporting /></Route>
          </Router>
        </DateRangeProvider>
      </QueryClientProvider>,
    );
  });
  return { renderer: renderer!, client, currentUrl, unmount: async () => { await act(async () => { renderer!.unmount(); }); client.clear(); } };
}

console.log('signed out');
{
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });
  __setHqData({ accounts: [] });
  requests.length = 0;
  const { renderer, unmount } = await mount('/admin/diet-reporting');
  await settle();
  check('signed-out shows the sign-in note, no tiles and NO request', byTestId(renderer.root, 'text-diet-report-signed-out').length === 1 && byTestId(renderer.root, 'text-diet-report-patients').length === 0 && requests.length === 0, requests.join('\n'));
  await unmount();
}

console.log('live page');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1', displayName: 'Ada Admin' }, hqRole: 'Admin' });
  __setSupabaseSession('token');
  requests.length = 0;
  hold = () => {};
  const { renderer, client, currentUrl, unmount } = await mount('/admin/diet-reporting');
  await settle(2);
  const root = renderer.root;
  check('loading: tiles show — and the sections show loading copy (no numbers)',
    textOf(byTestId(root, 'text-diet-report-patients')[0]) === '—' && byTestId(root, 'text-diet-report-framework-loading').length === 1
      && byTestId(root, 'text-diet-report-table-loading').length === 1 && byTestId(root, 'text-diet-report-screening-loading').length === 1
      && byTestId(root, 'table-diet-report-offices').length === 0 && byTestId(root, 'text-diet-report-updated').length === 0);
  const release = hold; hold = null; release();
  await settle();
  check('one live request with the shared range and no office', reportRequests().length === 1 && /GET \/api\/hq\/diet-restrictions\?start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}$/.test(reportRequests()[0]), requests.join('\n'));
  check('ready: headline tiles carry the live counts',
    textOf(byTestId(root, 'text-diet-report-patients')[0]) === '200' && textOf(byTestId(root, 'text-diet-report-on-diet')[0]) === '140'
      && textOf(byTestId(root, 'text-diet-report-protocol')[0]) === '150' && textOf(byTestId(root, 'text-diet-report-severe')[0]) === '9'
      && textOf(byTestId(root, 'text-diet-report-pending')[0]) === '3' && textOf(byTestId(root, 'text-diet-report-pregnancy')[0]) === '1'
      && textOf(byTestId(root, 'text-diet-report-changes')[0]) === '31' && textOf(byTestId(root, 'text-diet-report-overrides')[0]) === '2');
  const json = JSON.stringify(renderer.toJSON());
  check('tile details carry shares and breakdowns', json.includes('70% of patients') && json.includes('15 just tracking') && json.includes('45 not chosen') && json.includes('9 by office staff') && json.includes('50 in maintenance') && json.includes('20 by patients') && json.includes('6 blocks opened'));
  check('header shows the scope and when the data landed', textOf(byTestId(root, 'text-diet-report-scope')[0]) === 'All practices' && /^Updated \d{1,2}:\d{2}:\d{2} (AM|PM)$/.test(textOf(byTestId(root, 'text-diet-report-updated')[0])));
  check('framework bars: Mediterranean first, No diet chosen last, values shown',
    byTestId(root, 'list-diet-report-framework').length === 1 && textOf(byTestId(root, 'diet-report-framework-value-mediterranean')[0]) === '80' && textOf(byTestId(root, 'diet-report-framework-value-none')[0]) === '45'
      && byTestId(root, 'list-diet-report-framework')[0].children.map((c) => (c as ReactTestInstance).props['data-testid']).join() === 'diet-report-framework-mediterranean,diet-report-framework-keto,diet-report-framework-dash,diet-report-framework-just_tracking,diet-report-framework-none');
  check('list bars and top items with the severe flag', textOf(byTestId(root, 'diet-report-list-value-dislike')[0]) === '90' && textOf(byTestId(root, 'diet-report-list-value-allergy')[0]) === '30'
    && byTestId(root, 'list-diet-report-item').length === 1 && textOf(byTestId(root, 'diet-report-item-allergy:peanut:severe')[0]).includes('Severe') && textOf(byTestId(root, 'diet-report-item-value-dislike:cilantro:none')[0]) === '40');
  check('screening: yes counts with the share, nobody-answered row without a share', textOf(byTestId(root, 'diet-report-screening-yes-medication')[0]) === '50' && textOf(byTestId(root, 'diet-report-screening-medication')[0]).includes('(25% yes)')
    && !textOf(byTestId(root, 'diet-report-screening-pregnancy')[0]).includes('% yes'));
  check('office table: rows by patients desc, total row equals the scope counts',
    rowIds(root).join() === 'office-a,office-b' && textOf(byTestId(root, 'row-diet-report-office-total')[0]).includes('All practices') && textOf(byTestId(root, 'row-diet-report-office-total')[0]).includes('200'), rowIds(root).join());
  await act(async () => { byTestId(root, 'button-diet-report-sort-patients')[0].props.onClick(); });
  check('clicking the active column flips the direction', rowIds(root).join() === 'office-b,office-a', rowIds(root).join());
  check('definitions on the page', byTestId(root, 'text-diet-report-definitions').length === 1 && textOf(byTestId(root, 'text-diet-report-definitions')[0]).includes('rather than zero'));
  const query = client.getQueryCache().findAll().find((q) => JSON.stringify(q.queryKey).includes('/api/hq/diet-restrictions'));
  check('query key is identity-scoped', JSON.stringify(query?.queryKey).includes('"hq-1"'), JSON.stringify(query?.queryKey));
  check('export panel lists diet_restrictions jobs only (list requested once)', requests.filter((r) => r === 'GET /api/exports').length >= 1 && byTestId(root, 'button-diet-report-export')[0].props.disabled === false);

  // Export CSV posts the kind with the shared range.
  await act(async () => { byTestId(root, 'button-diet-report-export')[0].props.onClick(); });
  await settle();
  const posted = bodies[0] as { kind: string; office: string | null; start: string; end: string } | undefined;
  check('Export CSV requests the diet_restrictions kind with the range and no office', posted?.kind === 'diet_restrictions' && posted.office === null && /^\d{4}-\d{2}-\d{2}$/.test(posted.start) && /^\d{4}-\d{2}-\d{2}$/.test(posted.end), JSON.stringify(posted));
  check('the export list is refreshed after the request', requests.filter((r) => r === 'GET /api/exports').length >= 2, requests.join('\n'));

  // Narrowing to an office issues a new request with office= and the tiles follow.
  await act(async () => { byTestId(root, 'button-diet-report-office-office-b')[0].props.onClick(); });
  await settle();
  check('choosing a practice requests office= and narrows the page', currentUrl().includes('office=office-b')
    && reportRequests().some((r) => r.includes('office=office-b')) && textOf(byTestId(root, 'text-diet-report-patients')[0]) === '80'
    && textOf(byTestId(root, 'text-diet-report-office-name')[0]) === 'Summit Health' && textOf(byTestId(root, 'text-diet-report-scope')[0]) === 'Summit Health' && rowIds(root).join() === 'office-b', `${currentUrl()} | ${requests.join('\n')}`);
  await act(async () => { byTestId(root, 'button-diet-report-export')[0].props.onClick(); });
  await settle();
  const narrowedPost = bodies[1] as { office: string | null } | undefined;
  check('a narrowed export carries the office', narrowedPost?.office === 'office-b', JSON.stringify(narrowedPost));
  await act(async () => { byTestId(root, 'button-diet-report-all-practices')[0].props.onClick(); });
  await settle();
  check('"Show all practices" clears the office and restores both rows', !currentUrl().includes('office=') && rowIds(root).length === 2 && byTestId(root, 'banner-diet-report-office').length === 0);
  await unmount();
}

console.log('live page — no activated patient in scope');
{
  requests.length = 0;
  unavailable = true;
  const { renderer, unmount } = await mount('/admin/diet-reporting');
  await settle();
  const root = renderer.root;
  const json = JSON.stringify(renderer.toJSON());
  check('tiles read — with "Unavailable for this scope"; sections say unavailable, not zero',
    textOf(byTestId(root, 'text-diet-report-patients')[0]) === '—' && json.includes('Unavailable for this scope')
      && byTestId(root, 'text-diet-report-framework-unavailable').length === 1 && byTestId(root, 'text-diet-report-table-unavailable').length === 1
      && byTestId(root, 'text-diet-report-screening-unavailable').length === 1 && !json.includes('"0"'));
  unavailable = false;
  await unmount();
}

console.log('live page — failure');
{
  requests.length = 0;
  status = 502;
  const { renderer, unmount } = await mount('/admin/diet-reporting');
  await settle();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_300)); });
  await settle();
  const root = renderer.root;
  check('the failed read was retried exactly once before reporting', reportRequests().length === 2, String(reportRequests().length));
  check('a 502 renders Error tiles and the error notices (never zeros)',
    textOf(byTestId(root, 'text-diet-report-patients')[0]) === 'Error' && textOf(byTestId(root, 'text-diet-report-pending')[0]) === 'Error'
      && byTestId(root, 'text-diet-report-framework-error').length === 1 && byTestId(root, 'text-diet-report-table-error').length === 1 && byTestId(root, 'text-diet-report-screening-error').length === 1
      && byTestId(root, 'table-diet-report-offices').length === 0 && !JSON.stringify(renderer.toJSON()).includes('"0"'));
  const before = reportRequests().length;
  status = 200;
  const retry = byTestId(root, 'text-diet-report-framework-error')[0].findAll((n) => n.type === 'button')[0];
  await act(async () => { retry.props.onClick(); });
  await settle();
  check('Try again refetches and recovers', reportRequests().length > before && textOf(byTestId(root, 'text-diet-report-patients')[0]) === '200');
  await unmount();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall diet reporting checks passed');
