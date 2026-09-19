/**
 * Legal holds in the operations app.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:legal-holds
 *
 * Rendered against the REAL pages and components under react-test-renderer
 * (session / scope / HQ-directory contexts stubbed via
 * tsconfig.legal-holds.json, global fetch scripted):
 *
 *   HQ Legal holds page (/admin/audit/legal-holds)
 *     - Admin sees the active count, every active hold with its target name,
 *       office, reason, and who placed it; lifted holds sit behind the filter
 *       with the lift reason and actor;
 *     - Lift needs a reason of at least 3 characters, posts once, and the row
 *       leaves the active view;
 *     - the demo persona sees the unavailable note and makes no request.
 *
 *   Hold controls (office account page + drill-in patient record)
 *     - an office with no hold offers "Place legal hold"; the reason form
 *       gates on 3+ characters and posts targetKind/targetId/reason;
 *     - a held patient shows the badge with reason + actor and offers Lift;
 *     - a patient under an office-wide hold sees the office badge read-only
 *       and may still be held individually;
 *     - a viewer without the HQ Admin role renders nothing.
 *
 *   Office PatientDetail
 *     - office staff see the read-only "Legal hold" chip on a held patient,
 *       never a place/lift control, and never any hold request;
 *     - the HQ drill-in renders the controls instead of the bare chip.
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
import { __setHqData } from './a11y-stubs/hq-data';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import type { OfficePatientDetail } from '../src/lib/office-roster';
import { LegalHoldControls } from '../src/components/admin/LegalHold';
import LegalHolds from '../src/pages/admin/LegalHolds';
import PatientDetail from '../src/pages/PatientDetail';

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
const settle = async (ticks = 10) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

// ─── Fixture ─────────────────────────────────────────────────────────────────

const NOW = Date.now();
const iso = (offsetDays: number) => new Date(NOW + offsetDays * 86_400_000).toISOString();
const AS_OF = new Date(NOW).toISOString().slice(0, 10);
const HELD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const FREE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const HOLD_PATIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const HOLD_OFFICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const HOLD_LIFTED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';

interface Hold {
  id: string; targetKind: 'patient' | 'provider'; targetId: string; targetLabel: string | null; providerId: string | null; reason: string;
  placedBy: string | null; placedByName: string | null; placedAt: string; liftedAt: string | null; liftedBy: string | null; liftedByName: string | null; liftReason: string | null; active: boolean;
}
const baseHolds = (): Hold[] => [
  { id: HOLD_PATIENT, targetKind: 'patient', targetId: HELD_ID, targetLabel: 'Devon Held', providerId: 'office-1', reason: 'Litigation hold: Doe v. Beacon Hill', placedBy: 'hq-1', placedByName: 'Dana HQ', placedAt: iso(-3), liftedAt: null, liftedBy: null, liftedByName: null, liftReason: null, active: true },
  { id: HOLD_OFFICE, targetKind: 'provider', targetId: 'office-2', targetLabel: 'Lakeview', providerId: 'office-2', reason: 'State board inquiry', placedBy: 'hq-1', placedByName: 'Dana HQ', placedAt: iso(-10), liftedAt: null, liftedBy: null, liftedByName: null, liftReason: null, active: true },
  { id: HOLD_LIFTED, targetKind: 'patient', targetId: FREE_ID, targetLabel: 'Kara Cleared', providerId: 'office-1', reason: 'Complaint under review', placedBy: 'hq-1', placedByName: 'Dana HQ', placedAt: iso(-30), liftedAt: iso(-20), liftedBy: 'hq-2', liftedByName: 'Lee HQ', liftReason: 'Complaint dismissed', active: false },
];
let holds = baseHolds();
let seq = 0;

function detailFixture(id: string, name: string, legalHold: boolean): OfficePatientDetail {
  return {
    office: { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics', providerCode: '483920' },
    patient: {
      identity: { id, name, email: null, phone: null, phoneDisplay: null, activationStatus: 'activated', verified: true, dateOfBirth: null, height: null, timezone: 'America/New_York', createdAt: '2026-06-01T00:00:00Z', claimedAt: null, lastLoginAt: null },
      program: { id: 'metabolic', startDate: '2026-06-01', startingWeight: 210, currentWeight: 198, goalWeight: 180, weightChange: -12, lastLogDate: AS_OF },
      version: '2026-09-01T00:00:00.000Z',
      deletion: null,
      legalHold,
    },
    diary: { entries: [], nutritionTotals: { overall: { calories: 0, protein: 0, carbs: 0, fat: 0 }, byDate: [] } },
    water: [], checkIns: [], weights: [{ dateKey: '2026-06-01', weight: 210 }], providerNotes: [], staffWeights: [], bodyMeasurements: [], progressPhotos: [],
    account: { targets: { calories: null, protein: null, carbs: null, fat: null, waterOz: null }, favorites: [], recents: [], customFoods: [], savedRecipes: [], flags: {} },
  } as OfficePatientDetail;
}

const requests: Array<{ url: string; method: string; body: unknown }> = [];
let recordResponse: OfficePatientDetail = detailFixture(HELD_ID, 'Devon Held', true);
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  requests.push({ url, method, body });
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  const parsed = new URL(url, 'https://ops.test');
  if (url.includes('/notifications')) return json({ patientId: HELD_ID, outreach: { state: 'none' }, notifications: [] });
  if (url.includes('/sessions')) return json({ sessions: [], lastSignInAt: null });
  if (/\/api\/office\/patients\/[^/?]+(\?|$)/.test(url)) return json(recordResponse);
  const lift = /\/api\/hq\/legal-holds\/([^/]+)\/lift$/.exec(parsed.pathname);
  if (lift && method === 'POST') {
    const row = holds.find((h) => h.id === decodeURIComponent(lift[1]));
    if (!row) return json({ error: 'Legal hold not found.' }, 404);
    if (!row.active) return json({ error: 'That hold was already lifted.' }, 409);
    if (typeof body?.reason !== 'string' || body.reason.trim().length < 3) return json({ error: 'Give a reason of at least 3 characters.' }, 400);
    const updated: Hold = { ...row, active: false, liftedAt: iso(0), liftedBy: 'hq-1', liftedByName: 'Dana HQ', liftReason: body.reason };
    holds = holds.map((h) => (h.id === row.id ? updated : h));
    return json({ hold: updated });
  }
  if (parsed.pathname.endsWith('/api/hq/legal-holds') && method === 'POST') {
    if (typeof body?.reason !== 'string' || body.reason.trim().length < 3) return json({ error: 'Give a reason of at least 3 characters.' }, 400);
    const existing = holds.find((h) => h.active && h.targetKind === body.targetKind && h.targetId === body.targetId);
    if (existing) return json({ hold: existing });
    seq += 1;
    const created: Hold = {
      id: `new-hold-${seq}`, targetKind: body.targetKind, targetId: body.targetId, targetLabel: body.targetKind === 'provider' ? 'Beacon Hill Aesthetics' : 'Devon Held',
      providerId: body.targetKind === 'provider' ? body.targetId : 'office-1', reason: body.reason, placedBy: 'hq-1', placedByName: 'Dana HQ', placedAt: iso(0),
      liftedAt: null, liftedBy: null, liftedByName: null, liftReason: null, active: true,
    };
    holds = [created, ...holds];
    return json({ hold: created });
  }
  if (parsed.pathname.endsWith('/api/hq/legal-holds') && method === 'GET') {
    const status = parsed.searchParams.get('status') ?? 'active';
    const providerId = parsed.searchParams.get('providerId');
    let rows = holds.slice();
    if (status === 'active') rows = rows.filter((h) => h.active);
    if (status === 'lifted') rows = rows.filter((h) => !h.active);
    if (providerId) rows = rows.filter((h) => h.providerId === providerId);
    return json({ holds: rows, activeCount: holds.filter((h) => h.active).length });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

async function render(path: string, element: React.ReactElement) {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
  return { renderer: renderer!, root: renderer!.root, loc };
}

const typeReason = async (root: ReactTestInstance, testId: string, value: string) => {
  await act(async () => { byTestId(root, testId)[0].props.onChange({ target: { value } }); });
};
const submitForm = async (root: ReactTestInstance, testId: string) => {
  await act(async () => { byTestId(root, testId)[0].props.onSubmit({ preventDefault() {} }); });
  await settle();
};
const holdRequests = () => requests.filter((r) => r.url.includes('/api/hq/legal-holds'));
const asAdmin = () => {
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Admin' });
  __setHqData({ accounts: [{ id: 'office-1', officeName: 'Beacon Hill Aesthetics' }, { id: 'office-2', officeName: 'Lakeview Wellness' }] });
  __setSupabaseSession('hq-token');
};

// ─── HQ Legal holds page ─────────────────────────────────────────────────────

console.log('\nHQ legal holds page: admin view');
{
  asAdmin();
  const { root } = await render('/admin/audit/legal-holds', <LegalHolds />);
  check('active count shows both active holds', textOf(byTestId(root, 'metric-legal-holds-active')[0]) === '2');
  const patientRow = byTestId(root, `row-legal-hold-${HOLD_PATIENT}`);
  const officeRow = byTestId(root, `row-legal-hold-${HOLD_OFFICE}`);
  check('active view lists the patient hold and the office hold, not the lifted one', patientRow.length === 1 && officeRow.length === 1 && byTestId(root, `row-legal-hold-${HOLD_LIFTED}`).length === 0);
  const patientText = patientRow.length ? textOf(patientRow[0]) : '';
  check('patient row names the patient, office, reason, and who placed it', patientText.includes('Devon Held') && patientText.includes('Beacon Hill Aesthetics') && patientText.includes('Doe v. Beacon Hill') && patientText.includes('Dana HQ') && patientText.includes('Still active'));
  const officeText = officeRow.length ? textOf(officeRow[0]) : '';
  check('office row is marked as a whole-office hold with the directory name', officeText.includes('Whole office') && officeText.includes('Lakeview Wellness') && officeText.includes('State board inquiry'));
  check('patient target links into the office drill-in record', byTestId(root, `link-legal-hold-target-${HOLD_PATIENT}`)[0]?.props.href === `/admin/accounts/office-1/office/patients/${HELD_ID}`);
  check('office target links to the account page', byTestId(root, `link-legal-hold-target-${HOLD_OFFICE}`)[0]?.props.href === '/admin/accounts/office-2');

  // Lift needs a reason.
  await act(async () => { byTestId(root, `button-lift-legal-hold-${HOLD_PATIENT}`)[0].props.onClick(); });
  const submitId = `legal-hold-list-lift-${HOLD_PATIENT}-submit`;
  check('lift opens the reason form with the button disabled until a reason is typed', byTestId(root, `legal-hold-list-lift-${HOLD_PATIENT}-form`).length === 1 && byTestId(root, submitId)[0].props.disabled === true);
  await typeReason(root, `legal-hold-list-lift-${HOLD_PATIENT}-reason`, 'no');
  check('two characters keep the lift disabled', byTestId(root, submitId)[0].props.disabled === true);
  const before = holdRequests().filter((r) => r.method === 'POST').length;
  await submitForm(root, `legal-hold-list-lift-${HOLD_PATIENT}-form`);
  check('a too-short reason never reaches the API', holdRequests().filter((r) => r.method === 'POST').length === before);
  await typeReason(root, `legal-hold-list-lift-${HOLD_PATIENT}-reason`, 'Matter closed; counsel released the hold');
  check('a real reason enables the lift', byTestId(root, submitId)[0].props.disabled === false);
  await submitForm(root, `legal-hold-list-lift-${HOLD_PATIENT}-form`);
  const lifts = holdRequests().filter((r) => r.method === 'POST' && r.url.includes(`/legal-holds/${HOLD_PATIENT}/lift`));
  check('lift posts once with the reason', lifts.length === 1 && (lifts[0].body as { reason: string }).reason === 'Matter closed; counsel released the hold', `posts=${lifts.length}`);
  check('after lifting, the row leaves the active view and the count drops', byTestId(root, `row-legal-hold-${HOLD_PATIENT}`).length === 0 && textOf(byTestId(root, 'metric-legal-holds-active')[0]) === '1');

  await act(async () => { byTestId(root, 'select-legal-hold-status')[0].props.onChange({ target: { value: 'lifted' } }); });
  await settle();
  const liftedRow = byTestId(root, `row-legal-hold-${HOLD_LIFTED}`);
  const liftedText = liftedRow.length ? textOf(liftedRow[0]) : '';
  check('lifted view shows who lifted, when, and why, with no Lift button', liftedRow.length === 1 && liftedText.includes('Lee HQ') && liftedText.includes('Complaint dismissed') && byTestId(root, `button-lift-legal-hold-${HOLD_LIFTED}`).length === 0);
  check('the hold just lifted appears in the lifted view with its reason', byTestId(root, `row-legal-hold-${HOLD_PATIENT}`).length === 1 && textOf(byTestId(root, `row-legal-hold-${HOLD_PATIENT}`)[0]).includes('counsel released'));
}

console.log('\nHQ legal holds page: demo persona');
{
  const before = requests.length;
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });
  __setSupabaseSession(null);
  const { root } = await render('/admin/audit/legal-holds', <LegalHolds />);
  check('demo note shown, no table, no request', byTestId(root, 'text-legal-holds-demo-note').length === 1 && byTestId(root, 'legal-holds-summary').length === 0 && requests.length === before);
}

// ─── Hold controls ───────────────────────────────────────────────────────────

console.log('\nhold controls: office account page (no hold yet → place)');
{
  holds = baseHolds();
  asAdmin();
  const { root } = await render('/admin/accounts/office-1', <LegalHoldControls targetKind="provider" targetId="office-1" providerId="office-1" label="Beacon Hill Aesthetics" />);
  const listCalls = holdRequests().filter((r) => r.method === 'GET' && r.url.includes('providerId=office-1'));
  check('controls load the active holds scoped to the office', listCalls.length >= 1);
  check('an office with no hold offers Place and no badge', byTestId(root, 'legal-hold-provider-place').length === 1 && byTestId(root, 'legal-hold-provider-badge').length === 0 && byTestId(root, 'legal-hold-provider-lift').length === 0);
  await act(async () => { byTestId(root, 'legal-hold-provider-place')[0].props.onClick(); });
  check('place opens the reason form, disabled until a reason is typed', byTestId(root, 'legal-hold-provider-place-form').length === 1 && byTestId(root, 'legal-hold-provider-place-submit')[0].props.disabled === true);
  await typeReason(root, 'legal-hold-provider-place-reason', 'Regulator subpoena covering every patient of the office');
  await submitForm(root, 'legal-hold-provider-place-form');
  const places = holdRequests().filter((r) => r.method === 'POST' && r.url.endsWith('/api/hq/legal-holds'));
  check('place posts targetKind/targetId/reason once', places.length === 1 && JSON.stringify(places[0].body) === JSON.stringify({ targetKind: 'provider', targetId: 'office-1', reason: 'Regulator subpoena covering every patient of the office' }), JSON.stringify(places.map((p) => p.body)));
  check('after placing, the badge shows with the reason and Lift replaces Place', byTestId(root, 'legal-hold-provider-badge').length === 1 && textOf(byTestId(root, 'legal-hold-provider-active')[0]).includes('Regulator subpoena') && byTestId(root, 'legal-hold-provider-lift').length === 1 && byTestId(root, 'legal-hold-provider-place').length === 0);
}

console.log('\nhold controls: patient under an office-wide hold');
{
  holds = baseHolds();
  const { root } = await render('/admin/accounts/office-2/office/patients/x', <LegalHoldControls targetKind="patient" targetId={FREE_ID} providerId="office-2" label="Sam Free" />);
  check('office-wide hold shows read-only with a pointer to the account page', byTestId(root, 'legal-hold-patient-office-badge').length === 1 && textOf(byTestId(root, 'legal-hold-patient-office-active')[0]).includes('office account page'));
  check('the patient can still be held individually', byTestId(root, 'legal-hold-patient-place').length === 1 && byTestId(root, 'legal-hold-patient-lift').length === 0);
}

console.log('\nhold controls: viewer without the HQ Admin role');
{
  const before = requests.length;
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-3' }, hqRole: 'Viewer' });
  const { root } = await render('/admin/accounts/office-1', <LegalHoldControls targetKind="provider" targetId="office-1" providerId="office-1" label="Beacon Hill Aesthetics" />);
  check('renders nothing and requests nothing', byTestId(root, 'legal-hold-provider-controls').length === 0 && requests.length === before);
}

// ─── Office PatientDetail ────────────────────────────────────────────────────

console.log('\noffice record: held patient (office staff)');
{
  holds = baseHolds();
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' }, hqRole: null });
  __setScope(null);
  __setSupabaseSession('staff-token');
  recordResponse = detailFixture(HELD_ID, 'Devon Held', true);
  const before = holdRequests().length;
  const { root } = await render(`/patients/${HELD_ID}`, <Route path="/patients/:id"><PatientDetail /></Route>);
  check('read-only Legal hold chip renders on the record', byTestId(root, 'chip-legal-hold').length === 1 && textOf(byTestId(root, 'chip-legal-hold')[0]).includes('Legal hold'));
  check('no place/lift control and no hold request from an office', byTestId(root, 'legal-hold-patient-controls').length === 0 && byTestId(root, 'legal-hold-patient-place').length === 0 && holdRequests().length === before);
  check('record content still renders', byTestId(root, 'text-live-patient-name').length === 1);
}

console.log('\noffice record: patient not on hold (office staff)');
{
  recordResponse = detailFixture(FREE_ID, 'Kara Cleared', false);
  const { root } = await render(`/patients/${FREE_ID}`, <Route path="/patients/:id"><PatientDetail /></Route>);
  check('no chip when the patient is not held', byTestId(root, 'chip-legal-hold').length === 0);
}

console.log('\noffice record: HQ drill-in shows the controls');
{
  asAdmin();
  __setScope({ providerId: 'office-1', officeName: 'Beacon Hill Aesthetics' });
  recordResponse = detailFixture(HELD_ID, 'Devon Held', true);
  const { root } = await render(`/patients/${HELD_ID}`, <Route path="/patients/:id"><PatientDetail /></Route>);
  check('HQ sees the hold controls with the badge, reason, and Lift', byTestId(root, 'legal-hold-patient-controls').length === 1 && byTestId(root, 'legal-hold-patient-badge').length === 1 && textOf(byTestId(root, 'legal-hold-patient-active')[0]).includes('Doe v. Beacon Hill') && byTestId(root, 'legal-hold-patient-lift').length === 1);
  check('HQ does not also get the bare office chip', byTestId(root, 'chip-legal-hold').length === 0);
  const scoped = holdRequests().filter((r) => r.method === 'GET' && r.url.includes('providerId=office-1'));
  check('drill-in hold lookup is scoped to the office', scoped.length >= 1);
}

console.log(failures === 0 ? '\nall legal-hold checks passed' : `\n${failures} legal-hold check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
