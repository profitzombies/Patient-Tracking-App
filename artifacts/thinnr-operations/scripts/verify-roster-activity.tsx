/**
 * Live roster activity signals — zero-versus-unknown rendering, filters and
 * sorts, and roster/detail parity.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:roster-activity
 *
 * Pure half: the lib/roster-activity row model — unknown rows are never
 * lapsed, sort last in either direction, and label themselves as
 * unavailable; "no data yet" families stay distinct from real zeros.
 *
 * Rendered half: the REAL Patients page under react-test-renderer (session /
 * scope contexts stubbed via tsconfig.roster-activity.json, global fetch
 * scripted) with a four-patient live roster:
 *
 *   - a fully-known patient renders the true 7-day bitmap, n/7, streaks,
 *     30-day rate, averages, mood distribution and side-effect chips;
 *   - a patient with no diary/check-in data yet renders "No logs yet" /
 *     "No check-ins yet" — never 0/7 or 0%;
 *   - a patient missing from the aggregate renders dashed "Not available"
 *     cells, a neutral "activity unknown" chip, and no follow-up reason;
 *   - the lapsed filter keeps only the server-flagged patient (the unknown
 *     one is excluded even though it shows no logs), and the logging sort
 *     puts the unknown row last ascending AND descending;
 *   - the guided demo (signed-out) renders none of the live cells.
 *
 * Parity: EngagementSummary (patient detail) fed the same signals prints the
 * same figures the roster cell prints.
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
import type { OfficePatient, OfficeRoster, PatientActivitySignals } from '../src/lib/office-roster';
import {
  compareLiveLogging,
  isLiveLapsed,
  liveLastLogLabel,
  loggingRate7,
  rosterActivityFor,
} from '../src/lib/roster-activity';
import { EngagementSummary } from '../src/components/office/RosterActivity';
import Patients from '../src/pages/Patients';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

const AS_OF = '2026-09-06';
const day = (back: number) => new Date(Date.parse(`${AS_OF}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);

const KNOWN: PatientActivitySignals = {
  asOfDate: AS_OF,
  loggedLast7: [false, true, true, false, true, true, false],
  loggedDays7: 4,
  mealStreak: 0,
  avgCalories7: 1412,
  avgWater7: 58,
  checkInStreak: 2,
  checkInRate30: 13,
  latestCheckInDate: AS_OF,
  moodCounts: { '1': 0, '2': 1, '3': 2, '4': 1, '5': 0 },
  topSideEffects: [{ name: 'Nausea', count: 3 }, { name: 'Fatigue', count: 1 }],
};

const NO_DATA: PatientActivitySignals = {
  asOfDate: AS_OF,
  loggedLast7: null, loggedDays7: null, mealStreak: null, avgCalories7: null, avgWater7: 40,
  checkInStreak: null, checkInRate30: null, latestCheckInDate: null, moodCounts: null, topSideEffects: null,
};

const LAPSED: PatientActivitySignals = {
  asOfDate: AS_OF,
  loggedLast7: [true, false, false, false, false, false, false],
  loggedDays7: 1, mealStreak: 0, avgCalories7: 900, avgWater7: null,
  checkInStreak: 0, checkInRate30: 3, latestCheckInDate: day(20),
  moodCounts: { '1': 1, '2': 0, '3': 0, '4': 0, '5': 0 }, topSideEffects: [],
};

function patient(id: string, name: string, operational: NonNullable<OfficePatient['operational']>): OfficePatient {
  return {
    id, name, email: `${id}@example.com`, phone: null, phoneDisplay: null, activationStatus: 'activated', verified: true,
    createdAt: '2026-07-01T00:00:00Z',
    program: { id: 'metabolic', day: 60, stage: 'protocol', week: 9, startDate: '2026-07-08', startingWeight: 210, currentWeight: 200, goalWeight: 170, weightChange: -10, lastLogDate: null },
    invitation: null,
    operational,
  } as OfficePatient;
}

const base = {
  asOfDate: AS_OF, latestActivityDate: AS_OF, latestWaterDate: null, latestWeightDate: null, latestPhotoDate: null, followUps: [],
};

const ROSTER: OfficeRoster = {
  office: { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics', providerCode: '483920' },
  patients: [
    patient('pat-known', 'Kara Known', { ...base, latestDiaryDate: day(1), latestCheckInDate: AS_OF, loggedDays7: 4, checkIns7: 2, activity: KNOWN, status: 'on_track', reasons: [] }),
    patient('pat-empty', 'Nolan Nodata', { ...base, latestDiaryDate: null, latestCheckInDate: null, loggedDays7: null, checkIns7: null, activity: NO_DATA, status: 'needs_attention', reasons: ['logging_lapsed', 'check_in_overdue'] }),
    patient('pat-unknown', 'Uma Unknown', { ...base, latestActivityDate: null, latestDiaryDate: null, latestCheckInDate: null, loggedDays7: null, checkIns7: null, activity: null, status: 'unknown', reasons: [] }),
    patient('pat-lapsed', 'Liam Lapsed', { ...base, latestDiaryDate: day(6), latestCheckInDate: day(20), loggedDays7: 1, checkIns7: 0, activity: LAPSED, status: 'needs_attention', reasons: ['logging_lapsed', 'check_in_overdue'] }),
  ],
  summary: { totalPatients: 4, activePatients: 4, newEnrollments30d: 0, needsAttention: 2, inactive: 0, invited: 0, checkInsOverdue: 2, loggingLapsed: 2, asOf: AS_OF },
};

// ─── Pure half ───────────────────────────────────────────────────────────────

console.log('roster-activity row model');
{
  const known = rosterActivityFor(ROSTER.patients[0]);
  const noData = rosterActivityFor(ROSTER.patients[1]);
  const unknown = rosterActivityFor(ROSTER.patients[2]);
  const lapsed = rosterActivityFor(ROSTER.patients[3]);
  check('missing activity → unknown', unknown.kind === 'unknown');
  check('unknown is never lapsed', !isLiveLapsed(unknown));
  check('no-data patient lapsed only because the server said so', isLiveLapsed(noData) && noData.kind === 'known' && noData.daysSinceLastLog === null);
  check('known patient not lapsed', !isLiveLapsed(known) && known.kind === 'known' && known.daysSinceLastLog === 1);
  check('lapsed patient counts days on the patient-local calendar', lapsed.kind === 'known' && lapsed.daysSinceLastLog === 6 && isLiveLapsed(lapsed));
  check('rate: known 4/7', Math.round(loggingRate7(known) ?? -1) === 57);
  check('rate: no diary data → null (not 0)', loggingRate7(noData) === null);
  check('rate: unknown → null', loggingRate7(unknown) === null);
  check('labels', liveLastLogLabel(unknown) === 'Not available' && liveLastLogLabel(noData) === 'No logs yet' && liveLastLogLabel(known) === 'Logged yesterday' && liveLastLogLabel(lapsed) === 'Last log 6d ago');
  const asc = [known, unknown, lapsed, noData].sort((a, b) => compareLiveLogging(a, b, 'asc'));
  const desc = [known, unknown, lapsed, noData].sort((a, b) => compareLiveLogging(a, b, 'desc'));
  check('asc: lowest known rate first, unknown/no-data last', asc[0] === lapsed && asc[1] === known && asc.slice(2).every((row) => loggingRate7(row) === null), JSON.stringify(asc.map((row) => row.kind)));
  check('desc: highest known rate first, unknown/no-data still last', desc[0] === known && desc[1] === lapsed && desc.slice(2).every((row) => loggingRate7(row) === null));
  const zeroRate = rosterActivityFor(patient('z', 'Z', { ...base, latestDiaryDate: day(9), latestCheckInDate: null, loggedDays7: 0, checkIns7: null, activity: { ...LAPSED, loggedLast7: [false, false, false, false, false, false, false], loggedDays7: 0 }, status: 'needs_attention', reasons: ['logging_lapsed'] }));
  check('a real 0/7 sorts ABOVE unknown when ascending', compareLiveLogging(zeroRate, unknown, 'asc') < 0 && compareLiveLogging(zeroRate, unknown, 'desc') < 0);
}

// ─── Rendered half ───────────────────────────────────────────────────────────

let rosterRequests = 0;
g.fetch = async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/api/office/roster')) {
    rosterRequests += 1;
    return new Response(JSON.stringify(ROSTER), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`unexpected fetch ${url}`);
};

interface Rendered { renderer: ReactTestRenderer; root: ReactTestInstance; loc: ReturnType<typeof memoryLocation> }

async function renderRoster(path = '/patients'): Promise<Rendered> {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <PatientSessionProvider>
          <Router hook={loc.hook}>
            <Patients />
          </Router>
        </PatientSessionProvider>
      </QueryClientProvider>,
    );
  });
  // Let the roster query settle.
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  return { renderer: renderer!, root: renderer!.root, loc };
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

function tableRows(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((node) => node.type === 'tr' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('Open '));
}

function rowFor(root: ReactTestInstance, name: string): ReactTestInstance | undefined {
  return tableRows(root).find((row) => String(row.props['aria-label']).includes(name));
}

/** Text of a row's two activity cells only (weight-loss column excluded). */
function activityText(row: ReactTestInstance): string {
  return row.findAll((node) => node.type === 'td').slice(5, 7).map(textOf).join(' | ');
}

function selectByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find((node) => node.type === 'select' && node.props['aria-label'] === label);
}

async function choose(select: ReactTestInstance, value: string) {
  await act(async () => { select.props.onChange({ target: { value } }); });
}

console.log('\nlive roster rendering');
{
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' } });
  __setScope(null);
  __setSupabaseSession('staff-token');
  const { renderer, root } = await renderRoster();
  const rows = tableRows(root);
  check('one roster request, four rows', rosterRequests === 1 && rows.length === 4, `requests=${rosterRequests} rows=${rows.length}`);
  check('live table adds the wellbeing column', root.findAll((node) => node.type === 'th').some((th) => textOf(th).includes('Check-ins & wellbeing')));

  const known = rowFor(root, 'Kara Known')!;
  const knownText = textOf(known);
  const dots = known.findAll((node) => node.type === 'span' && typeof node.props.className === 'string' && /h-2\.5 w-2\.5/.test(node.props.className));
  const filled = dots.filter((dot) => /bg-primary/.test(dot.props.className));
  check('known: 7-dot bitmap with 4 logged days', dots.length === 7 && filled.length === 4, `dots=${dots.length} filled=${filled.length}`);
  check('known: 4/7, streak, last log', knownText.includes('4/7') && knownText.includes('0-day streak') && knownText.includes('Logged yesterday'), knownText);
  check('known: check-in streak, 30-day rate, latest check-in', knownText.includes('2-day') && knownText.includes('13%') && knownText.includes('Last check-in Sep 6'), knownText);
  check('known: 7-day averages', knownText.includes('1,412 cal avg') && knownText.includes('58 oz avg'), knownText);
  const mood = known.find((node) => node.props.role === 'img' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('Mood'));
  check('known: mood distribution announced', mood.props['aria-label'] === 'Mood over 4 check-ins: 1/5 ×0, 2/5 ×1, 3/5 ×2, 4/5 ×1, 5/5 ×0', mood.props['aria-label']);
  check('known: top side effects as chips', knownText.includes('Nausea×3') && knownText.includes('Fatigue×1'), knownText);
  check('known: a real zero streak reads as 0, not unavailable', !knownText.includes('Not available') && !knownText.includes('No data yet'));

  const empty = rowFor(root, 'Nolan Nodata')!;
  const emptyText = textOf(empty);
  check('no-data: diary family says "No logs yet", never 0/7', emptyText.includes('No logs yet') && !emptyText.includes('0/7'), emptyText);
  check('no-data: check-in family says "No check-ins yet", never 0%', emptyText.includes('No check-ins yet') && !/\d+%/.test(activityText(empty)), activityText(empty));
  check('no-data: water average is the only real figure', emptyText.includes('40 oz avg') && emptyText.includes('cal: no data'), emptyText);
  check('no-data: mood + side effects say no data yet', emptyText.includes('Mood: no data yet') && emptyText.includes('Side effects: no data yet'), emptyText);
  check('no-data: server-flagged lapse still shows its follow-up', emptyText.includes('Lapsed') && empty.findAll((node) => node.type === 'button' && /logging lapsed/.test(String(node.props['aria-label']))).length === 1);

  const unknown = rowFor(root, 'Uma Unknown')!;
  const unknownText = textOf(unknown);
  const unavailable = unknown.findAll((node) => node.props['data-state'] === 'unknown');
  check('unknown: both activity cells render the unavailable state', unavailable.length === 2 && unknownText.split('Not available').length === 3, `cells=${unavailable.length}`);
  check('unknown: no zero-looking figures in the activity cells', !/\d\/7|\d+%|streak|\d+ (cal|oz)/.test(activityText(unknown)), activityText(unknown));
  check('unknown: neutral status chip, no follow-up buttons', unknownText.includes('activity unknown') && unknown.findAll((node) => node.type === 'button' && /follow-up|reviewed/.test(String(node.props['aria-label']))).length === 0, unknownText);
  check('unknown: explains what did not load', unknownText.includes('Logging did not load') && unknownText.includes('Check-ins did not load'));

  const lapsed = rowFor(root, 'Liam Lapsed')!;
  const lapsedText = textOf(lapsed);
  check('lapsed: 1/7 with destructive last-log label', lapsedText.includes('1/7') && lapsedText.includes('Last log 6d ago') && lapsed.findAll((node) => typeof node.props.className === 'string' && /text-destructive/.test(node.props.className) && textOf(node).includes('Last log 6d ago')).length === 1, lapsedText);
  check('lapsed: real zero check-in streak and 3% rate shown as such', lapsedText.includes('0-day') && lapsedText.includes('3%') && lapsedText.includes('No side effects (30d)'), lapsedText);

  // Filters and sorts.
  await choose(selectByLabel(root, 'Filter by companion-app logging'), 'lapsed');
  const lapsedNames = tableRows(root).map((row) => String(row.props['aria-label']));
  check('lapsed filter keeps only server-flagged rows (unknown excluded)', lapsedNames.length === 2 && lapsedNames.some((n) => n.includes('Liam Lapsed')) && lapsedNames.some((n) => n.includes('Nolan Nodata')), lapsedNames.join(' | '));
  await choose(selectByLabel(root, 'Filter by companion-app logging'), 'all');
  await choose(selectByLabel(root, 'Filter by status'), 'unknown');
  check('status filter can isolate unknown rows', tableRows(root).length === 1 && String(tableRows(root)[0].props['aria-label']).includes('Uma Unknown'));
  await choose(selectByLabel(root, 'Filter by status'), 'all');

  const loggingHeader = root.find((node) => node.type === 'button' && textOf(node).trim().startsWith('Logging (7d)'));
  await act(async () => { loggingHeader.props.onClick(); });
  const ascOrder = tableRows(root).map((row) => String(row.props['aria-label']).replace(/^Open |’s patient record$/g, ''));
  check('logging sort ascending: lowest rate first, unknown last', ascOrder[0] === 'Liam Lapsed' && ascOrder[1] === 'Kara Known' && ascOrder[3] === 'Uma Unknown' || (ascOrder[0] === 'Liam Lapsed' && ascOrder[1] === 'Kara Known' && ascOrder[2] === 'Uma Unknown' && ascOrder[3] === 'Nolan Nodata'), ascOrder.join(' > '));
  check('logging sort ascending never leads with a rate-less row', ascOrder.indexOf('Uma Unknown') >= 2 && ascOrder.indexOf('Nolan Nodata') >= 2, ascOrder.join(' > '));
  await act(async () => { loggingHeader.props.onClick(); });
  const descOrder = tableRows(root).map((row) => String(row.props['aria-label']).replace(/^Open |’s patient record$/g, ''));
  check('logging sort descending: highest rate first, rate-less rows still last', descOrder[0] === 'Kara Known' && descOrder[1] === 'Liam Lapsed' && descOrder.indexOf('Uma Unknown') >= 2 && descOrder.indexOf('Nolan Nodata') >= 2, descOrder.join(' > '));

  // Mobile cards carry the same cells.
  const cards = root.findAll((node) => node.type === 'a' && typeof node.props.className === 'string' && node.props.className.includes('block p-4'));
  const unknownCard = cards.find((card) => textOf(card).includes('Uma Unknown'))!;
  check('mobile card: unknown renders both unavailable cells', unknownCard.findAll((node) => node.props['data-state'] === 'unknown').length === 2);
  const knownCard = cards.find((card) => textOf(card).includes('Kara Known'))!;
  check('mobile card: known renders bitmap + wellbeing', textOf(knownCard).includes('4/7') && textOf(knownCard).includes('13%'));

  renderer.unmount();
}

console.log('\nguided demo untouched');
{
  rosterRequests = 0;
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null });
  __setSupabaseSession(null);
  const { renderer, root } = await renderRoster();
  const rows = tableRows(root);
  check('demo: no live requests, seeded rows render', rosterRequests === 0 && rows.length > 5, `requests=${rosterRequests} rows=${rows.length}`);
  check('demo: no live activity cells or wellbeing column', root.findAll((node) => node.props['data-state'] !== undefined).length === 0 && !root.findAll((node) => node.type === 'th').some((th) => textOf(th).includes('wellbeing')));
  check('demo: seeded logging bitmap still renders', rows.every((row) => row.findAll((node) => node.type === 'span' && typeof node.props.className === 'string' && /h-2\.5 w-2\.5/.test(node.props.className)).length === 7));
  check('demo: status filter keeps the demo options', selectByLabel(root, 'Filter by status').findAll((node) => node.type === 'option').map((option) => option.props.value).join(',') === 'all,active,paused,overdue,graduated');
  renderer.unmount();
}

console.log('\nroster ↔ detail parity');
{
  let renderer: ReactTestRenderer | undefined;
  await act(async () => { renderer = create(<EngagementSummary signals={KNOWN} />); });
  const text = textOf(renderer!.root);
  check('detail summary prints the roster figures', ['4/7', '0 days', '2 days', '13%', '1,412 cal', '58 oz', 'Sep 6', 'Nausea×3'].every((token) => text.includes(token)), text);
  const dots = renderer!.root.findAll((node) => node.type === 'span' && typeof node.props.className === 'string' && /h-2\.5 w-2\.5/.test(node.props.className));
  check('detail summary shares the 7-day bitmap', dots.length === 7 && dots.filter((dot) => /bg-primary/.test(dot.props.className)).length === 4);
  check('detail summary is stamped with the same as-of day', renderer!.root.findByProps({ 'data-testid': 'engagement-summary' }).props['data-as-of'] === AS_OF);
  renderer!.unmount();
  await act(async () => { renderer = create(<EngagementSummary signals={NO_DATA} />); });
  const noDataText = textOf(renderer!.root);
  check('detail summary keeps no-data families explicit', noDataText.includes('No logs yet') && noDataText.split('No data yet').length >= 6 && noDataText.includes('40 oz') && !noDataText.includes('0/7'), noDataText);
  renderer!.unmount();
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall roster-activity checks passed');
