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
 *   - the lapsed quick set keeps only the server-flagged patient (the unknown
 *     one is excluded even though it shows no logs), and the logging sort
 *     puts the unknown row last ascending AND descending;
 *   - the guided demo (signed-out) renders none of the live cells.
 *
 * Roster filters (Radix / cmdk / day-picker parts stubbed DOM-free): quick
 * sets switch exclusively and write the URL, the builder stacks two
 * conditions with AND, chips remove one condition, the URL round-trips into
 * the same view (legacy arriving links included), spend filters read the
 * roster's spend aggregate (unknown never matches), every control is a
 * button / combobox / input (keyboard operable, announced), phone width
 * hosts the builder in a bottom sheet, and the demo persona gets the same
 * quick sets over the seeded roster.
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
g.window.innerWidth ??= 1280;
g.window.localStorage ??= (() => { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } }; })();

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

function patient(id: string, name: string, operational: NonNullable<OfficePatient['operational']>, extra: Partial<OfficePatient> = {}): OfficePatient {
  return {
    id, name, email: `${id}@example.com`, phone: null, phoneDisplay: null, activationStatus: 'activated', verified: true,
    createdAt: '2026-07-01T00:00:00Z',
    program: { id: 'metabolic', day: 60, stage: 'protocol', week: 9, startDate: '2026-07-08', startingWeight: 210, currentWeight: 200, goalWeight: 170, weightChange: -10, lastLogDate: null },
    invitation: null,
    operational,
    spend: { paidCents: 0, refundedCents: 0, netCents: 0, lastPaidAt: null },
    activeSubscription: false,
    ...extra,
  } as OfficePatient;
}

const base = {
  asOfDate: AS_OF, latestActivityDate: AS_OF, latestWaterDate: null, latestWeightDate: null, latestPhotoDate: null, followUps: [],
};

const ROSTER: OfficeRoster = {
  office: { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics', providerCode: '483920' },
  patients: [
    // Spend: Kara $600 net (a $50 refund), Liam $120, Nolan a real $0, Uma unknown (aggregate unreadable).
    patient('pat-known', 'Kara Known', { ...base, latestDiaryDate: day(1), latestCheckInDate: AS_OF, loggedDays7: 4, checkIns7: 2, activity: KNOWN, status: 'on_track', reasons: [] }, { spend: { paidCents: 65000, refundedCents: 5000, netCents: 60000, lastPaidAt: '2026-09-01T15:00:00Z' }, activeSubscription: true }),
    patient('pat-empty', 'Nolan Nodata', { ...base, latestDiaryDate: null, latestCheckInDate: null, loggedDays7: null, checkIns7: null, activity: NO_DATA, status: 'needs_attention', reasons: ['logging_lapsed', 'check_in_overdue'] }),
    patient('pat-unknown', 'Uma Unknown', { ...base, latestActivityDate: null, latestDiaryDate: null, latestCheckInDate: null, loggedDays7: null, checkIns7: null, activity: null, status: 'unknown', reasons: [] }, { spend: null, activeSubscription: null }),
    patient('pat-lapsed', 'Liam Lapsed', { ...base, latestDiaryDate: day(6), latestCheckInDate: day(20), loggedDays7: 1, checkIns7: 0, activity: LAPSED, status: 'needs_attention', reasons: ['logging_lapsed', 'check_in_overdue'] }, { spend: { paidCents: 12000, refundedCents: 0, netCents: 12000, lastPaidAt: '2026-06-01T15:00:00Z' } }),
  ],
  summary: { totalPatients: 4, activePatients: 4, newEnrollments30d: 0, needsAttention: 2, attention: 2, inactive: 0, invited: 0, checkInsOverdue: 2, loggingLapsed: 2, asOf: AS_OF },
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
// Columns: patient, status, start date, logging, check-ins, meds, weight, action.
function activityText(row: ReactTestInstance): string {
  return row.findAll((node) => node.type === 'td').slice(3, 5).map(textOf).join(' | ');
}

// Host elements only: a stubbed SelectTrigger forwards data-testid to its
// button, so the composite instance would otherwise shadow the real props.
const allByTestId = (root: ReactTestInstance, id: string) => root.findAll((node) => typeof node.type === 'string' && node.props['data-testid'] === id);
const byTestId = (root: ReactTestInstance, id: string) => {
  const matches = allByTestId(root, id);
  if (matches.length !== 1) throw new Error(`expected one ${id}, found ${matches.length}`);
  return matches[0];
};
/** Nearest ancestor (within a few component layers) containing a matching node. */
function nearby(control: ReactTestInstance, predicate: (node: ReactTestInstance) => boolean): ReactTestInstance {
  let container: ReactTestInstance | null = control.parent;
  for (let depth = 0; container && depth < 6; depth += 1) {
    const hit = container.findAll((node) => typeof node.type === 'string' && predicate(node))[0];
    if (hit) return hit;
    container = container.parent;
  }
  throw new Error('no nearby match');
}
const rowNames = (root: ReactTestInstance) => tableRows(root).map((row) => String(row.props['aria-label']).replace(/^Open |’s patient record$/g, ''));

async function click(node: ReactTestInstance) {
  await act(async () => { node.props.onClick(); });
}

/** Pick an option on a stubbed Select / Command picker by the option's data-value. */
async function pickOption(root: ReactTestInstance, controlTestId: string, value: string) {
  // Select stub: the trigger and its listbox share the Select provider; the
  // option buttons are siblings rendered after the trigger. Command stub: the
  // option buttons live in the picker's PopoverContent next to the trigger.
  await click(nearby(byTestId(root, controlTestId), (node) => node.props.role === 'option' && node.props['data-value'] === value));
}

const builderForm = (root: ReactTestInstance) => byTestId(root, 'roster-filter-builder').find((node) => node.type === 'form');

async function type(node: ReactTestInstance, value: string) {
  await act(async () => { node.props.onChange({ target: { value } }); });
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
  await click(byTestId(root, 'quick-set-inactive-lapsed'));
  const lapsedNames = tableRows(root).map((row) => String(row.props['aria-label']));
  check('lapsed quick set keeps only server-flagged rows (unknown excluded)', lapsedNames.length === 2 && lapsedNames.some((n) => n.includes('Liam Lapsed')) && lapsedNames.some((n) => n.includes('Nolan Nodata')), lapsedNames.join(' | '));
  await click(byTestId(root, 'quick-set-all'));
  await click(byTestId(root, 'button-add-filter'));
  await pickOption(root, 'filter-value-0', 'unknown');
  check('status filter can isolate unknown rows', tableRows(root).length === 1 && String(tableRows(root)[0].props['aria-label']).includes('Uma Unknown'), rowNames(root).join(' | '));
  await click(byTestId(root, 'quick-set-all'));

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
  const { renderer, root, loc } = await renderRoster();
  const rows = tableRows(root);
  check('demo: no live requests, seeded rows render', rosterRequests === 0 && rows.length > 5, `requests=${rosterRequests} rows=${rows.length}`);
  check('demo: no live activity cells or wellbeing column', root.findAll((node) => node.props['data-state'] !== undefined).length === 0 && !root.findAll((node) => node.type === 'th').some((th) => textOf(th).includes('wellbeing')));
  check('demo: seeded logging bitmap still renders', rows.every((row) => row.findAll((node) => node.type === 'span' && typeof node.props.className === 'string' && /h-2\.5 w-2\.5/.test(node.props.className)).length === 7));
  // Demo parity: the same quick sets over the seeded roster, statuses mapped
  // to the live vocabulary (overdue → needs attention, graduated → maintenance).
  const demoSets = root.findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('quick-set-') && node.type === 'button').map((node) => textOf(node));
  check('demo: same built-in quick sets', demoSets.join(',') === 'All,Active,Needs attention,Inactive / lapsed,Invited,Paused,Archived (1),Maintenance phase,New this month,Active subscription,Top spenders', demoSets.join(','));
  await click(byTestId(root, 'quick-set-needs-attention'));
  const attentionRows = tableRows(root);
  check('demo: Needs attention = seeded overdue rows', attentionRows.length > 0 && attentionRows.every((row) => textOf(row).includes('overdue')), `${attentionRows.length}`);
  await click(byTestId(root, 'quick-set-maintenance'));
  const maintenanceRows = tableRows(root);
  check('demo: Maintenance phase = seeded maintenance rows', maintenanceRows.length > 0 && maintenanceRows.every((row) => textOf(row).includes('Maintenance')), `${maintenanceRows.length}`);
  await click(byTestId(root, 'quick-set-top-spenders'));
  check('demo: Top spenders applies the spend sort', loc.history.at(-1)?.includes('sort=spent.desc') === true && tableRows(root).length > 0, String(loc.history.at(-1)));
  await click(byTestId(root, 'quick-set-paused'));
  const pausedRows = tableRows(root);
  check('demo: Paused = seeded paused rows', pausedRows.length > 0 && pausedRows.every((row) => textOf(row).includes('paused')));
  check('demo: no native selects anywhere on the page', root.findAll((node) => node.type === 'select').length === 0);
  renderer.unmount();
}

console.log('\nroster filters: quick sets, builder, chips, URL');
{
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' } });
  __setSupabaseSession('staff-token');
  const { renderer, root, loc } = await renderRoster();
  const lastUrl = () => String(loc.history.at(-1));
  const pressed = () => root.findAll((node) => node.props['aria-pressed'] === true && typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('quick-set-')).map((node) => node.props['data-testid']);

  check('All is the active quick set on arrival', pressed().join(',') === 'quick-set-all');
  check('no count badge without filters', allByTestId(root, 'badge-filter-count').length === 0 && byTestId(root, 'button-filter').props['aria-label'] === 'Filter');

  // Quick sets are exclusive and write the URL.
  await click(byTestId(root, 'quick-set-needs-attention'));
  check('Needs attention: two rows, one pressed pill, URL carries the condition', rowNames(root).join(',') === 'Nolan Nodata,Liam Lapsed' && pressed().join(',') === 'quick-set-needs-attention' && lastUrl().includes('f=status%3Ais%3Aneeds_attention'), `${rowNames(root)} ${pressed()} ${lastUrl()}`);
  await click(byTestId(root, 'quick-set-active-subscription'));
  check('Active subscription: only the true flag matches (unknown excluded)', rowNames(root).join(',') === 'Kara Known' && pressed().join(',') === 'quick-set-active-subscription', rowNames(root).join(','));
  await click(byTestId(root, 'quick-set-top-spenders'));
  check('Top spenders: paid rows only, highest first; $0 and unknown drop out', rowNames(root).join(',') === 'Kara Known,Liam Lapsed' && lastUrl().includes('sort=spent.desc'), `${rowNames(root)} ${lastUrl()}`);
  check('filter count badge shows 1', byTestId(root, 'badge-filter-count').children.join('') === '1' && byTestId(root, 'button-filter').props['aria-label'] === 'Filter, 1 active');
  const chip0 = byTestId(root, 'filter-chip-0');
  check('chip describes the condition in words', textOf(chip0).includes('more than $0'), textOf(chip0));

  // Stack a second condition in the builder: spent > 0 AND program day ≥ 50.
  await click(byTestId(root, 'button-add-filter'));
  check('new row starts as Status is (incomplete, not applied)', byTestId(root, 'filter-field-1').props['data-value'] === 'status' && allByTestId(root, 'filter-chip-1').length === 0);
  await pickOption(root, 'filter-field-1', 'program_day');
  await pickOption(root, 'filter-operator-1', 'gte');
  await type(byTestId(root, 'filter-value-1'), '50');
  check('stacked: both conditions in the URL and two chips', (lastUrl().match(/f=/g) ?? []).length === 2 && lastUrl().includes('f=program_day%3Agte%3A50') && allByTestId(root, 'filter-chip-1').length === 1, lastUrl());
  check('stacked rows AND together', rowNames(root).join(',') === 'Kara Known,Liam Lapsed');
  check('no quick set is pressed once the stack is custom', pressed().length === 0);
  check('count badge shows 2', byTestId(root, 'badge-filter-count').children.join('') === '2');
  await type(byTestId(root, 'filter-value-1'), '61');
  check('program day ≥ 61 excludes everyone (fixture is day 60)', rowNames(root).length === 0 && root.findAll((node) => node.type === 'td' && node.props.colSpan === 7).length === 1, rowNames(root).join(','));
  await type(byTestId(root, 'filter-value-1'), '60');

  // Spend on the builder: between, and unknown never matches "less than".
  await click(byTestId(root, 'button-add-filter'));
  await pickOption(root, 'filter-field-2', 'spent');
  await pickOption(root, 'filter-operator-2', 'between');
  await type(byTestId(root, 'filter-value-2-min'), '100');
  check('half-filled between is not applied', (lastUrl().match(/f=/g) ?? []).length === 2 && allByTestId(root, 'filter-chip-2').length === 0);
  await type(byTestId(root, 'filter-value-2-max'), '200');
  check('spent between $100 and $200 keeps Liam only', rowNames(root).join(',') === 'Liam Lapsed' && textOf(byTestId(root, 'filter-chip-2')).includes('between $100 and $200'), `${rowNames(root)} ${textOf(byTestId(root, 'filter-chip-2'))}`);

  // Chip removal drops exactly one condition and re-syncs the builder.
  await click(byTestId(root, 'filter-chip-0').find((node) => node.type === 'button'));
  check('removing the first chip leaves day ≥ 60 and the spend range', allByTestId(root, 'filter-chip-2').length === 0 && textOf(byTestId(root, 'filter-chip-0')).includes('Program day at least 60') && allByTestId(root, 'filter-row-2').length === 0 && rowNames(root).join(',') === 'Liam Lapsed', lastUrl());
  check('chip remove button is announced', root.findAll((node) => node.type === 'button' && String(node.props['aria-label']).startsWith('Remove filter: ')).length === 2);

  // Unknown spend never matches, "no" included.
  await click(byTestId(root, 'button-clear-filters'));
  check('Clear all empties the URL and re-presses All', !lastUrl().includes('f=') && pressed().join(',') === 'quick-set-all' && rowNames(root).length === 4, lastUrl());
  await click(byTestId(root, 'button-add-filter'));
  await pickOption(root, 'filter-field-0', 'spent');
  await pickOption(root, 'filter-operator-0', 'lt');
  await type(byTestId(root, 'filter-value-0'), '1000');
  check('spent < $1000: real $0 matches, unknown spend does not (still in spend order)', rowNames(root).join(',') === 'Kara Known,Liam Lapsed,Nolan Nodata', rowNames(root).join(','));
  await pickOption(root, 'filter-field-0', 'active_subscription');
  check('changing the field resets operator and value (row incomplete again)', byTestId(root, 'filter-operator-0').props['data-value'] === 'is' && !lastUrl().includes('f='), lastUrl());
  await pickOption(root, 'filter-value-0', 'no');
  check('subscription "no": false matches, null does not', rowNames(root).sort().join(',') === 'Liam Lapsed,Nolan Nodata', rowNames(root).join(','));

  // Date fields: "in the last N days" and a calendar range via the picker.
  await pickOption(root, 'filter-field-0', 'last_purchase');
  await pickOption(root, 'filter-operator-0', 'in_last');
  await type(byTestId(root, 'filter-value-0'), '30');
  const recentBuyers = rowNames(root);
  check('last purchase in the last 30 days (device day) keeps at most recent payers, never Nolan/Uma', !recentBuyers.includes('Nolan Nodata') && !recentBuyers.includes('Uma Unknown'), recentBuyers.join(','));
  await pickOption(root, 'filter-field-0', 'join_date');
  await pickOption(root, 'filter-operator-0', 'between');
  const calendar = nearby(byTestId(root, 'filter-value-0'), (node) => node.props['data-calendar'] !== undefined);
  check('between opens the range calendar', calendar.props['data-mode'] === 'range');
  await act(async () => { calendar.props.pickerProps.onSelect({ from: new Date(2026, 5, 1), to: undefined }, new Date(2026, 5, 1)); });
  check('range half-picked: nothing applied yet', !lastUrl().includes('f='));
  await act(async () => { calendar.props.pickerProps.onSelect({ from: new Date(2026, 5, 1), to: new Date(2026, 6, 15) }, new Date(2026, 6, 15)); });
  check('join date between Jun 1 and Jul 15 applies and matches the fixture join day', lastUrl().includes('f=join_date%3Abetween%3A2026-06-01..2026-07-15') && rowNames(root).length === 4, lastUrl());
  check('chip formats the range', textOf(byTestId(root, 'filter-chip-0')).includes('Jun 1, 2026 – Jul 15, 2026'), textOf(byTestId(root, 'filter-chip-0')));

  // Sorting via the header persists in the URL; the mobile sort picker mirrors it.
  const nameHeader = root.find((node) => node.type === 'button' && textOf(node).trim().startsWith('Patient'));
  await click(nameHeader);
  check('header sort writes ?sort=', lastUrl().includes('sort=name.desc'), lastUrl());
  await pickOption(root, 'select-sort', 'name.asc');
  check('phone sort picker writes the same URL key', lastUrl().includes('sort=name.asc') && rowNames(root)[0] === 'Kara Known', lastUrl());

  // Save the stack as a custom quick set (browser storage) and remove it.
  check('save needs an applied filter', byTestId(root, 'button-save-quick-set-open').props.disabled === false);
  await click(byTestId(root, 'button-save-quick-set-open'));
  const nameForm = builderForm(root);
  await act(async () => { nameForm.props.onSubmit({ preventDefault() {} }); });
  check('blank name is rejected and announced', root.findAll((node) => node.props.role === 'alert' && textOf(node).includes('Give the quick set a name')).length === 1);
  await type(byTestId(root, 'input-quick-set-name'), 'Summer joiners');
  check('Save is the form submit button', byTestId(root, 'button-save-quick-set').props.type === 'submit');
  await act(async () => { builderForm(root).props.onSubmit({ preventDefault() {} }); });
  const customPill = root.find((node) => node.type === 'button' && textOf(node) === 'Summer joiners');
  check('custom quick set appears pressed and persisted', customPill.props['aria-pressed'] === true && String(g.window.localStorage.getItem('thinnr.roster.quick-sets')).includes('Summer joiners'));
  await click(byTestId(root, 'quick-set-all'));
  check('custom set releases when All is chosen', customPill.props['aria-pressed'] === false && rowNames(root).length === 4);
  await click(customPill);
  check('tapping the custom set re-applies its stack and sort', lastUrl().includes('join_date%3Abetween') && lastUrl().includes('sort=name.asc'), lastUrl());
  await click(root.find((node) => node.props['aria-label'] === 'Remove quick set Summer joiners'));
  check('custom set removed from the row and storage', root.findAll((node) => node.type === 'button' && textOf(node) === 'Summer joiners').length === 0 && !String(g.window.localStorage.getItem('thinnr.roster.quick-sets')).includes('Summer joiners'));

  // Keyboard / announcement contract: every control is a native button, input or combobox.
  const builder = byTestId(root, 'roster-filter-builder');
  const clickables = builder.findAll((node) => typeof node.type === 'string' && typeof node.props.onClick === 'function');
  check('builder click targets are buttons (keyboard operable)', clickables.length > 0 && clickables.every((node) => node.type === 'button'), clickables.map((node) => node.type).join(','));
  check('builder controls carry accessible names', builder.findAll((node) => node.type === 'button' || node.type === 'input' || node.props.role === 'combobox').every((node) => node.props['aria-label'] || node.props.id || textOf(node).trim().length > 0));
  check('Filter button announces state', byTestId(root, 'button-filter').props['aria-haspopup'] === 'dialog' && typeof byTestId(root, 'button-filter').props['aria-expanded'] === 'boolean');
  check('quick-set pills are toggle buttons', root.findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('quick-set-') && node.type === 'button').every((node) => typeof node.props['aria-pressed'] === 'boolean'));
  check('builder has a live match count', builder.findAll((node) => node.props['aria-live'] === 'polite' && /patients? shown/.test(textOf(node))).length === 1);
  renderer.unmount();
}

console.log('\nroster filters: arriving links round-trip');
{
  const cases: Array<[string, string, string]> = [
    ['/patients?logging=lapsed', 'Liam Lapsed,Nolan Nodata', 'legacy ?logging=lapsed pre-applies the lapsed filter, lowest known rate first'],
    ['/patients?status=needs_attention&reason=check_in_overdue', 'Nolan Nodata,Liam Lapsed', 'legacy status + reason stack'],
    ['/patients?status=unknown', 'Uma Unknown', 'legacy ?status= isolates the unknown row'],
    ['/patients?subscription=active', 'Kara Known', 'legacy ?subscription=active'],
    ['/patients?f=spent%3Agte%3A500&f=program_day%3Agt%3A50&sort=name.asc', 'Kara Known', 'shared link with two conditions and a sort'],
    ['/patients?f=weight_lost_lb%3Alt%3A5&f=program_day%3Agte%3A42', '', 'weight lost < 5 lb after 6 weeks (fixture lost 10 lb) → nobody'],
    ['/patients?f=status%3Ais%3Ainvited', '', 'invited (never joined) → nobody in this fixture'],
    ['/patients?f=bogus%3Ais%3Ax&f=status%3Ais%3Aon_track', 'Kara Known', 'unknown condition keys are ignored, valid ones apply'],
  ];
  for (const [path, expected, label] of cases) {
    const { renderer, root } = await renderRoster(path);
    check(label, rowNames(root).join(',') === expected, rowNames(root).join(','));
    renderer.unmount();
  }
  // Legacy keys are rewritten as conditions on the first change; the pin survives.
  const { renderer, root, loc } = await renderRoster('/patients?logging=lapsed&attention=first');
  check('lapsed arrival shows one chip and the Inactive / lapsed pill pressed', allByTestId(root, 'filter-chip-0').length === 1 && byTestId(root, 'quick-set-inactive-lapsed').props['aria-pressed'] === true);
  await click(byTestId(root, 'quick-set-all'));
  const rewritten = String(loc.history.at(-1));
  check('rewrite drops legacy keys and keeps ?attention=first', !rewritten.includes('logging=') && rewritten.includes('attention=first') && !rewritten.includes('f='), rewritten);
  renderer.unmount();
}

console.log('\nroster filters: phone width uses a bottom sheet');
{
  g.window.innerWidth = 390;
  const { renderer, root } = await renderRoster();
  check('closed: no builder rendered at phone width', allByTestId(root, 'roster-filter-builder').length === 0 && allByTestId(root, 'roster-filter-sheet').length === 0);
  await click(byTestId(root, 'button-filter'));
  const sheet = byTestId(root, 'roster-filter-sheet');
  check('open: builder lives in the bottom sheet', sheet.props['data-side'] === 'bottom' && sheet.props.role === 'dialog' && sheet.findAll((node) => node.props['data-testid'] === 'roster-filter-builder').length === 1);
  check('sheet is titled', sheet.findAll((node) => node.type === 'h2' && textOf(node) === 'Filters').length === 1);
  await click(byTestId(root, 'button-add-filter'));
  await pickOption(root, 'filter-value-0', 'invited');
  check('sheet builder applies to the roster underneath', rowNames(root).length === 0);
  await click(byTestId(root, 'button-filters-done'));
  check('Done closes the sheet; filter stays applied', allByTestId(root, 'roster-filter-sheet').length === 0 && byTestId(root, 'badge-filter-count').children.join('') === '1');
  renderer.unmount();
  g.window.innerWidth = 1280;
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
