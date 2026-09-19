/**
 * Patient record edit history (HIPAA amendments append, never overwrite).
 *
 *   pnpm --filter @workspace/thinnr-operations run test:patient-edit-history
 *
 * Renders the REAL patient record page under react-test-renderer with a
 * scripted global fetch (session / provider scope / Radix parts stubbed via
 * tsconfig.patient-record-export.json). Covers:
 *   - the page offers a Record | History tablist; Record is selected by
 *     default and the History tab fetches nothing until chosen;
 *   - choosing History loads /api/office/patients/:id/history newest first,
 *     each change showing field "was → now", the actor's display name
 *     ("Patient" for patient-made edits), and the change kind;
 *   - a weight corrected twice lists BOTH prior values;
 *   - the family filter re-queries with ?family= and shows a family-specific
 *     empty state; HQ drill-in adds ?office=;
 *   - paging: "Show older changes" requests the server's nextOffset and
 *     appends; a failed load surfaces an alert instead of an empty list.
 *
 * Pure half: value / actor / field labels.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PatientSessionProvider } from '../src/contexts/patient-session';
import { DateRangeProvider } from '../src/contexts/date-range';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import type { OfficePatientDetail, PatientEditHistoryChange } from '../src/lib/office-roster';
import { actorLabel, fieldLabel, formatHistoryValue, EDIT_HISTORY_PAGE_SIZE } from '../src/components/office/PatientEditHistory';
import PatientDetail from '../src/pages/PatientDetail';

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
const settle = async (ticks = 10) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
const press = async (node: ReactTestInstance) => { await act(async () => { node.props.onClick?.({ preventDefault() {} }); }); await settle(); };

// ─── Fixture ─────────────────────────────────────────────────────────────────

const AS_OF = '2026-09-17';
const PATIENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const OFFICE = { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics', providerCode: '483920' };
const DETAIL: OfficePatientDetail = {
  office: OFFICE,
  patient: {
    identity: { id: PATIENT_ID, name: 'Devon Records', email: null, phone: null, phoneDisplay: null, activationStatus: 'activated', verified: true, dateOfBirth: null, height: null, timezone: 'America/New_York', createdAt: '2026-06-01T00:00:00Z', claimedAt: null, lastLoginAt: null },
    program: { id: 'metabolic', startDate: '2026-06-01', startingWeight: 210, currentWeight: 198, goalWeight: 180, weightChange: -12, lastLogDate: AS_OF },
    version: '2026-09-01T00:00:00.000Z',
    deletion: null,
  },
  diary: { entries: [], nutritionTotals: { overall: { calories: 0, protein: 0, carbs: 0, fat: 0 }, byDate: [] } },
  water: [], checkIns: [], weights: [{ dateKey: '2026-06-01', weight: 210 }], providerNotes: [], staffWeights: [], bodyMeasurements: [], progressPhotos: [],
  account: { targets: { calories: null, protein: null, carbs: null, fat: null, waterOz: null }, favorites: [], recents: [], customFoods: [], savedRecipes: [], flags: {} },
} as OfficePatientDetail;

const WEIGHT_ID = 'weight-row-1';
const change = (partial: Partial<PatientEditHistoryChange> & Pick<PatientEditHistoryChange, 'changeId' | 'family' | 'createdAt' | 'fields'>): PatientEditHistoryChange => ({
  recordId: WEIGHT_ID, changeKind: 'update', actorKind: 'team_member', actorUserId: 'staff-1', actorName: 'Maya Chen', auditEventId: 1001, ...partial,
});
// Newest first, as the server returns them. The weigh-in was corrected
// twice: 198 → 196.5 (Maya), then 196.5 → 197 (Dr. Beacon).
const CHANGES: PatientEditHistoryChange[] = [
  change({ changeId: 'c4', family: 'weight', createdAt: '2026-09-17T15:20:00Z', actorKind: 'provider', actorName: 'Dr. Beacon', fields: [{ field: 'weight', old: 196.5, new: 197 }] }),
  change({ changeId: 'c3', family: 'medication', recordId: 'med-1', changeKind: 'delete', actorKind: 'hq', actorName: 'Riley HQ', createdAt: '2026-09-16T12:00:00Z', fields: [{ field: 'name', old: 'Semaglutide', new: null }, { field: 'dose', old: '0.5 mg', new: null }] }),
  change({ changeId: 'c2', family: 'weight', createdAt: '2026-09-15T09:00:00Z', fields: [{ field: 'weight', old: 198, new: 196.5 }] }),
  change({ changeId: 'c1', family: 'medication', recordId: 'med-2', changeKind: 'create', actorKind: 'patient', actorUserId: 'patient-1', actorName: null, auditEventId: null, createdAt: '2026-09-14T08:00:00Z', fields: [{ field: 'name', old: null, new: 'Metformin' }, { field: 'times', old: null, new: ['08:00', '20:00'] }] }),
];
const OLDER: PatientEditHistoryChange[] = [
  change({ changeId: 'c0', family: 'profile', recordId: PATIENT_ID, createdAt: '2026-09-01T08:00:00Z', fields: [{ field: 'goalWeight', old: 185, new: 180 }] }),
];

let historyMode: 'ok' | 'error' = 'ok';
const requests: Array<{ url: string; method: string }> = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push({ url, method });
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  const parsed = new URL(url, 'https://ops.test');
  if (parsed.pathname.endsWith('/history')) {
    if (historyMode === 'error') return json({ error: 'History storage is unavailable.' }, 502);
    const family = parsed.searchParams.get('family');
    const offset = Number(parsed.searchParams.get('offset') ?? '0');
    const all = [...CHANGES, ...OLDER].filter((row) => !family || row.family === family);
    // First page holds everything but the oldest row so paging is exercised.
    const pageSize = family ? EDIT_HISTORY_PAGE_SIZE : CHANGES.length;
    const changes = all.slice(offset, offset + pageSize);
    const next = offset + changes.length;
    return json({ changes, total: all.length, nextOffset: next < all.length ? next : null });
  }
  if (parsed.pathname.endsWith('/api/exports')) return json({ jobs: [], available: [], ttlHours: 24 });
  if (url.includes('/notifications')) return json({ patientId: PATIENT_ID, outreach: { state: 'none' }, notifications: [] });
  if (url.includes('/medications')) return json({ medications: [], doseLogs: [], adherence: null, timeZone: 'UTC', today: AS_OF });
  if (url.includes('/coach-conversations') || url.includes('/coach-memories')) return json({ conversations: [], memories: [], total: 0 });
  if (url.includes('/api/office/patients/')) return json(DETAIL);
  throw new Error(`not under test: ${method} ${url}`);
};

const renderers: ReactTestRenderer[] = [];
async function render(path: string, element: React.ReactElement) {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <DateRangeProvider>
          <PatientSessionProvider>
            <Router hook={loc.hook}>{element}</Router>
          </PatientSessionProvider>
        </DateRangeProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  renderers.push(renderer!);
  return { root: renderer!.root, loc };
}
const staff = () => {
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' }, hqRole: null, providerAccountCode: '483920' });
  __setScope(null);
  __setSupabaseSession('staff-token');
};
const record = () => <Route path="/patients/:id"><PatientDetail /></Route>;
const historyCalls = () => requests.filter((r) => new URL(r.url, 'https://ops.test').pathname.endsWith('/history')).map((r) => new URL(r.url, 'https://ops.test'));

// ─── Pure half ───────────────────────────────────────────────────────────────

console.log('pure: labels');
{
  check('weights carry lbs, empties read "empty"', formatHistoryValue('weight', 'weight', 196.5) === '196.5 lbs' && formatHistoryValue('weight', 'weight', null) === 'empty' && formatHistoryValue('note', 'body', '') === 'empty');
  check('measurements carry inches, dates do not', formatHistoryValue('measurement', 'waist', 34) === '34 in' && formatHistoryValue('measurement', 'dateKey', '2026-09-01') === '2026-09-01');
  check('arrays join, weekdays name the day, booleans read Yes/No', formatHistoryValue('medication', 'times', ['08:00', '20:00']) === '08:00, 20:00' && formatHistoryValue('medication', 'weekday', 1) === 'Monday' && formatHistoryValue('profile', 'x', true) === 'Yes');
  check('patient edits are attributed to "Patient", HQ is marked', actorLabel({ actorKind: 'patient', actorName: null }) === 'Patient' && actorLabel({ actorKind: 'hq', actorName: 'Riley HQ' }) === 'Riley HQ (HQ)' && actorLabel({ actorKind: 'team_member', actorName: 'Maya Chen' }) === 'Maya Chen' && actorLabel({ actorKind: 'team_member', actorName: null }) === 'Staff');
  check('field labels read as words', fieldLabel('goalWeight') === 'Goal weight' && fieldLabel('someNewField') === 'Some new field');
}

// ─── Record page: office staff ───────────────────────────────────────────────

console.log('\nrecord page: History tab lists every correction with prior values');
{
  staff();
  requests.length = 0;
  historyMode = 'ok';
  const { root } = await render(`/patients/${PATIENT_ID}`, record());
  const recordTab = one(root, 'tab-patient-record');
  const historyTab = one(root, 'tab-patient-history');
  check('tablist offers Record and History, Record selected', recordTab.props.role === 'tab' && historyTab.props.role === 'tab' && recordTab.props['aria-selected'] === true && historyTab.props['aria-selected'] === false && textOf(historyTab) === 'History');
  check('history is not fetched until the tab is chosen', historyCalls().length === 0 && byTestId(root, 'panel-patient-history').length === 0);
  await press(historyTab);
  check('History tab becomes selected and its panel is labelled by it', historyTab.props['aria-selected'] === true && one(root, 'panel-patient-history').props['aria-labelledby'] === 'patient-tab-history');
  const first = historyCalls();
  check('choosing History fetches the patient\'s history page (no office for office staff)', first.length === 1 && !first[0].searchParams.has('office') && !first[0].searchParams.has('family') && first[0].searchParams.get('limit') === String(EDIT_HISTORY_PAGE_SIZE), first.map((u) => u.href).join('|'));
  check('total counts every change on file', textOf(one(root, 'text-history-total')) === '5 changes');
  const items = one(root, 'list-history').findAll((node) => node.type === 'li');
  check('changes render newest first', items.map((node) => node.props['data-testid']).join(',') === 'history-change-c4,history-change-c3,history-change-c2,history-change-c1', items.map((node) => node.props['data-testid']).join(','));
  const latest = textOf(one(root, 'history-change-c4'));
  check('latest weigh-in correction shows was → now with the actor', latest.includes('196.5 lbs') && latest.includes('197.0 lbs') && latest.includes('Dr. Beacon') && latest.includes('Changed') && latest.includes('Weigh-ins'), latest);
  const earlier = textOf(one(root, 'history-change-c2'));
  check('the earlier correction keeps the ORIGINAL value (198) recoverable', earlier.includes('198.0 lbs') && earlier.includes('196.5 lbs') && earlier.includes('Maya Chen'), earlier);
  const removed = textOf(one(root, 'history-change-c3'));
  check('a delete records the removed values and names the HQ actor', removed.includes('Removed') && removed.includes('Semaglutide') && removed.includes('0.5 mg') && removed.includes('Riley HQ (HQ)'), removed);
  const patientMade = textOf(one(root, 'history-change-c1'));
  check('a patient-made edit is attributed to "Patient" with joined times', patientMade.includes('Added') && patientMade.includes('Patient') && patientMade.includes('Metformin') && patientMade.includes('08:00, 20:00'), patientMade);
  check('timestamps render in the viewer\'s zone (UTC here)', latest.includes('Sep 17, 2026') && latest.includes('3:20 PM'), latest);

  // Paging: the server said there is one older change.
  const more = one(root, 'button-history-more');
  check('older changes are offered with the remaining count', textOf(more) === 'Show older changes (1 more)', textOf(more));
  await press(more);
  const paged = historyCalls();
  check('load more requests the server\'s nextOffset', paged.length === 2 && paged[1].searchParams.get('offset') === '4', paged.map((u) => u.search).join('|'));
  const afterMore = one(root, 'list-history').findAll((node) => node.type === 'li');
  check('older change appends after the first page and the button goes away', afterMore.length === 5 && afterMore[4].props['data-testid'] === 'history-change-c0' && byTestId(root, 'button-history-more').length === 0);
  check('profile change reads goal weight in lbs', textOf(one(root, 'history-change-c0')).includes('185.0 lbs') && textOf(one(root, 'history-change-c0')).includes('180.0 lbs'));

  // Family filter.
  await press(one(root, 'filter-history-weight'));
  const filtered = historyCalls();
  check('family filter re-queries with ?family=weight from the top', filtered.length === 3 && filtered[2].searchParams.get('family') === 'weight' && !filtered[2].searchParams.has('offset') && one(root, 'filter-history-weight').props['aria-pressed'] === true, filtered.map((u) => u.search).join('|'));
  const weightsOnly = one(root, 'list-history').findAll((node) => node.type === 'li').map((node) => node.props['data-testid']);
  check('only weigh-in changes remain, both corrections present', weightsOnly.join(',') === 'history-change-c4,history-change-c2', weightsOnly.join(','));
  await press(one(root, 'filter-history-note'));
  check('a family with no changes shows a family-specific empty state', textOf(one(root, 'text-history-empty')) === 'No staff notes changes have been recorded.' && byTestId(root, 'list-history').length === 0);

  // Back to the record.
  await press(recordTab);
  check('Record tab restores the record panel and hides history', recordTab.props['aria-selected'] === true && byTestId(root, 'panel-patient-history').length === 0 && one(root, 'text-live-patient-name') !== undefined);
}

console.log('\nrecord page: HQ drill-in sends the scoped office');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Admin', providerAccountCode: null });
  __setScope({ providerId: 'office-1', officeName: OFFICE.officeName, providerName: 'Dr. Beacon', providerRole: 'Owner' });
  __setSupabaseSession('hq-token');
  requests.length = 0;
  historyMode = 'ok';
  const { root } = await render(`/patients/${PATIENT_ID}`, record());
  await press(one(root, 'tab-patient-history'));
  const calls = historyCalls();
  check('HQ history request names the drilled-in office', calls.length === 1 && calls[0].searchParams.get('office') === 'office-1', calls.map((u) => u.href).join('|'));
  check('HQ sees the same list', one(root, 'list-history').findAll((node) => node.type === 'li').length === 4);
}

console.log('\nrecord page: a failed history load is announced, not blank');
{
  staff();
  requests.length = 0;
  historyMode = 'error';
  const { root } = await render(`/patients/${PATIENT_ID}`, record());
  await press(one(root, 'tab-patient-history'));
  const alert = one(root, 'text-history-error');
  check('server error shows as an alert with the message', alert.props.role === 'alert' && textOf(alert).includes('History storage is unavailable'), textOf(alert));
  check('no empty-state claim while errored', byTestId(root, 'text-history-empty').length === 0);
}

for (const renderer of renderers) await act(async () => { renderer.unmount(); });
if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll patient edit history checks passed.');
