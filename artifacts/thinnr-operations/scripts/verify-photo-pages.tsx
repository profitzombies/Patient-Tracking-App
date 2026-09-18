/**
 * Progress-photo pages on the live patient record.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:photo-pages
 *
 * Renders the REAL patient record page under react-test-renderer with a
 * scripted global fetch (session / provider scope / dialog stubbed via
 * tsconfig.photo-pages.json). Covers:
 *   - the grid signs ONE thumbnail page for all photos (ids, variant=thumb)
 *     and renders from it; until it lands, each photo shows the record's own
 *     original URL, so a slow or failed page never blanks the grid;
 *   - a photo the server has not backfilled yet renders the original it
 *     signed, marked as such;
 *   - the medium page is signed only when a photo is opened, the viewer shows
 *     the medium URL, moves between photos, and the download link is always
 *     the untouched original;
 *   - a failed page keeps originals in place (no error surfaced);
 *   - HQ drill-in: the page requests carry ?office=;
 *   - lib: paths and body of fetchOfficePatientPhotoPage, >100 ids split.
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
import { fetchOfficePatientPhotoPage, OFFICE_PHOTO_PAGE_MAX, type OfficePatientDetail, type OfficeProgressPhoto } from '../src/lib/office-roster';
import PatientDetail from '../src/pages/PatientDetail';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

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
const imgs = (node: ReactTestInstance) => node.findAll((n) => n.type === 'img').map((n) => ({ src: n.props.src as string, size: n.props['data-photo-size'] as string | undefined }));
const dialog = (root: ReactTestInstance) => root.findAll((n) => n.type === 'div' && n.props.role === 'dialog');

// ─── Fixture ─────────────────────────────────────────────────────────────────

const PATIENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const AS_OF = '2026-09-17';
const original = (id: string) => `https://api.example/office/patients/${PATIENT_ID}/photos/${id}/file?token=orig`;
const PHOTOS: OfficeProgressPhoto[] = [
  { id: 'ph-1', dateKey: '2026-06-01', label: 'Baseline', angle: 'front', url: original('ph-1') },
  { id: 'ph-2', dateKey: '2026-07-01', label: 'Week 4', angle: 'side', url: original('ph-2') },
  { id: 'ph-3', dateKey: '2026-08-01', label: 'Week 8', angle: null, url: original('ph-3') },
  { id: 'ph-4', dateKey: '2026-09-01', label: 'Week 12', angle: 'back', url: null },
];
const DETAIL: OfficePatientDetail = {
  office: { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics', providerCode: '483920' },
  patient: {
    identity: { id: PATIENT_ID, name: 'Devon Photos', email: null, phone: null, phoneDisplay: null, activationStatus: 'activated', verified: true, dateOfBirth: null, height: null, timezone: 'America/New_York', createdAt: '2026-06-01T00:00:00Z', claimedAt: null, lastLoginAt: null },
    program: { id: 'metabolic', startDate: '2026-06-01', startingWeight: 210, currentWeight: 198, goalWeight: 180, weightChange: -12, lastLogDate: AS_OF },
    version: '2026-09-01T00:00:00.000Z',
    deletion: null,
  },
  diary: { entries: [], nutritionTotals: { overall: { calories: 0, protein: 0, carbs: 0, fat: 0 }, byDate: [] } },
  water: [], checkIns: [], weights: [{ dateKey: '2026-06-01', weight: 210 }], providerNotes: [], staffWeights: [], bodyMeasurements: [], progressPhotos: PHOTOS,
  account: { targets: { calories: null, protein: null, carbs: null, fat: null, waterOz: null }, favorites: [], recents: [], customFoods: [], savedRecipes: [], flags: {} },
} as OfficePatientDetail;

interface PageCall { url: string; ids: string[]; variant: string }
const pageCalls: PageCall[] = [];
const page = {
  status: 200,
  /** Ids whose asked variant is not generated yet (server signs the original). */
  missing: new Set<string>(),
  hold: null as Promise<void> | null,
  reset() { this.status = 200; this.missing.clear(); this.hold = null; pageCalls.length = 0; },
};
const signed = (id: string, size: string) => `https://signed.example/${size}/${id}?sig=${pageCalls.length}`;

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (method === 'POST' && url.includes('/photos/urls')) {
    const body = JSON.parse(String(init?.body)) as { ids: string[]; variant: string };
    pageCalls.push({ url, ids: body.ids, variant: body.variant });
    if (page.hold) await page.hold;
    if (page.status !== 200) return json({ error: 'nope' }, page.status);
    const urls = body.ids.map((id) => {
      const size = page.missing.has(id) ? 'original' : body.variant;
      return { id, url: signed(id, size), size };
    });
    return json({ urls, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
  }
  if (url.includes('/notifications')) return json({ patientId: PATIENT_ID, outreach: { state: 'none' }, notifications: [] });
  if (url.includes('/medications')) return json({ medications: [], doseLogs: [], adherence: null, timeZone: 'UTC', today: AS_OF });
  if (url.includes('/coach-conversations') || url.includes('/coach-memories')) return json({ conversations: [], memories: [], total: 0 });
  if (url.includes('/api/billing/office/patients/') && url.includes('/summary')) return json({ error: 'not under test' }, 500);
  if (url.includes(`/api/office/patients/${PATIENT_ID}`) && method === 'GET') return json(DETAIL);
  throw new Error(`not under test: ${method} ${url}`);
};

const renderers: ReactTestRenderer[] = [];
async function render(path: string) {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <DateRangeProvider>
          <PatientSessionProvider>
            <Router hook={loc.hook}><Route path="/patients/:id"><PatientDetail /></Route></Router>
          </PatientSessionProvider>
        </DateRangeProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  renderers.push(renderer!);
  return renderer!.root;
}
const staff = () => {
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' }, hqRole: null, providerAccountCode: '483920' });
  __setScope(null);
  __setSupabaseSession('staff-token');
};
const click = async (node: ReactTestInstance) => { await act(async () => { node.props.onClick(); }); await settle(); };

// ─── Grid: one thumbnail page, fallback first ────────────────────────────────

console.log('grid: thumbnails come from one page; originals until it lands');
{
  staff();
  page.reset();
  let release!: () => void;
  page.hold = new Promise<void>((resolve) => { release = resolve; });
  const root = await render(`/patients/${PATIENT_ID}`);
  const grid = one(root, 'live-progress-photos');
  const before = imgs(grid);
  check('one thumbnail page requested for the grid', pageCalls.length === 1 && pageCalls[0].variant === 'thumb', JSON.stringify(pageCalls));
  check('page lists exactly the photos that have a file (no url = no id)', JSON.stringify(pageCalls[0].ids) === JSON.stringify(['ph-1', 'ph-2', 'ph-3']), JSON.stringify(pageCalls[0].ids));
  check('page request carries no ?office= for office staff', !/[?&]office=/.test(pageCalls[0].url), pageCalls[0].url);
  check('while the page is pending every photo shows its original', before.length === 3 && before.every((img) => img.src.includes('token=orig') && img.size === 'original'), JSON.stringify(before));
  check('a photo without a file shows the placeholder, not a broken image', textOf(grid).includes('Photo preview unavailable.') && byTestId(grid, 'live-progress-photo-ph-4').length === 0);
  release();
  await settle();
  const after = imgs(grid);
  check('page landed: grid renders the signed thumbnails', after.length === 3 && after.every((img) => img.src.startsWith('https://signed.example/thumb/') && img.size === 'thumb'), JSON.stringify(after));
  check('captions keep label, date, and angle', textOf(one(grid, 'live-progress-photo-ph-1').parent as ReactTestInstance).includes('Baseline') && textOf(grid).includes('front'));
  check('no medium page yet (nothing opened)', pageCalls.every((call) => call.variant === 'thumb'));
  check('grid buttons name the photo for assistive tech', one(grid, 'live-progress-photo-ph-2').props['aria-label'] === 'View Week 4 photo for Devon Photos');

  // Open the viewer: medium page signed now, viewer shows it, download = original.
  await click(one(grid, 'live-progress-photo-ph-2'));
  const mediumCalls = pageCalls.filter((call) => call.variant === 'medium');
  check('opening a photo signs ONE medium page for the whole grid', mediumCalls.length === 1 && JSON.stringify(mediumCalls[0].ids) === JSON.stringify(['ph-1', 'ph-2', 'ph-3']), JSON.stringify(mediumCalls));
  const viewer = dialog(root)[0];
  check('viewer opened on the tapped photo', Boolean(viewer) && textOf(viewer).includes('Week 4') && textOf(viewer).includes('Photo 2 of 3'), viewer ? textOf(viewer) : 'no dialog');
  const shown = imgs(viewer);
  check('viewer image is the medium page URL', shown.length === 1 && shown[0].src.startsWith('https://signed.example/medium/ph-2') && shown[0].size === 'medium', JSON.stringify(shown));
  const download = one(viewer, 'live-progress-photo-download');
  check('download link is the untouched original', download.props.href === original('ph-2') && download.props.download !== undefined, download.props.href);
  const next = viewer.findAll((n) => n.type === 'button' && n.props['aria-label'] === 'Next photo')[0];
  await click(next);
  const viewer2 = dialog(root)[0];
  check('next moves to the following photo without a new page', textOf(viewer2).includes('Week 8') && imgs(viewer2)[0].src.startsWith('https://signed.example/medium/ph-3') && pageCalls.length === 2, textOf(viewer2));
  check('grid thumbnails unchanged behind the viewer', imgs(one(root, 'live-progress-photos')).every((img) => img.size === 'thumb'));
  const next2 = viewer2.findAll((n) => n.type === 'button' && n.props['aria-label'] === 'Next photo')[0];
  check('last photo disables Next', next2.props.disabled === true);
}

console.log('\ngrid: photos not yet backfilled render the original the server signed');
{
  staff();
  page.reset();
  page.missing.add('ph-3');
  const root = await render(`/patients/${PATIENT_ID}`);
  const grid = one(root, 'live-progress-photos');
  const shown = imgs(grid);
  const ph3 = shown.find((img) => img.src.includes('/ph-3'));
  check('backfill-pending photo shows the signed original (server says so)', ph3?.src.startsWith('https://signed.example/original/ph-3') === true && ph3?.size === 'original', JSON.stringify(ph3));
  check('the others are thumbnails', shown.filter((img) => img.src.startsWith('https://signed.example/thumb/')).length === 2);
}

console.log('\ngrid: a failed page keeps originals, surfaces no error');
{
  staff();
  page.reset();
  page.status = 503;
  const root = await render(`/patients/${PATIENT_ID}`);
  const grid = one(root, 'live-progress-photos');
  const shown = imgs(grid);
  check('failed page: every photo still shows its original', shown.length === 3 && shown.every((img) => img.src.includes('token=orig') && img.size === 'original'), JSON.stringify(shown));
  check('failed page is not retried in a loop', pageCalls.filter((call) => call.variant === 'thumb').length === 1, String(pageCalls.length));
  check('no alert inside the photo card', grid.findAll((n) => n.props.role === 'alert').length === 0);
  await click(one(grid, 'live-progress-photo-ph-1'));
  const viewer = dialog(root)[0];
  check('viewer still opens on the original when medium also fails', Boolean(viewer) && imgs(viewer)[0]?.src === original('ph-1'), viewer ? JSON.stringify(imgs(viewer)) : 'no dialog');
}

console.log('\nHQ drill-in scopes the page request');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Support', providerAccountCode: null });
  __setScope({ providerId: 'office-1' });
  __setSupabaseSession('hq-token');
  page.reset();
  await render(`/patients/${PATIENT_ID}`);
  check('thumbnail page carries ?office=<providerId>', pageCalls.length === 1 && /[?&]office=office-1/.test(pageCalls[0].url), pageCalls.map((c) => c.url).join('|'));
}

console.log('\nlib: fetchOfficePatientPhotoPage');
{
  staff();
  page.reset();
  const map = await fetchOfficePatientPhotoPage(PATIENT_ID, ['a', 'b'], 'thumb', null);
  check('posts to /photos/urls under the patient with ids + variant', pageCalls.length === 1 && pageCalls[0].url === `/api/office/patients/${PATIENT_ID}/photos/urls` && JSON.stringify(pageCalls[0].ids) === JSON.stringify(['a', 'b']) && pageCalls[0].variant === 'thumb', JSON.stringify(pageCalls));
  check('returns an id → {url,size} map', map.size === 2 && map.get('a')?.url.startsWith('https://signed.example/thumb/a') === true && map.get('a')?.size === 'thumb');
  page.reset();
  const many = Array.from({ length: OFFICE_PHOTO_PAGE_MAX + 5 }, (_, i) => `id-${i}`);
  const big = await fetchOfficePatientPhotoPage(PATIENT_ID, many, 'medium', 'office-9');
  check('more than one page of ids is split at the server ceiling', pageCalls.length === 2 && pageCalls[0].ids.length === OFFICE_PHOTO_PAGE_MAX && pageCalls[1].ids.length === 5 && big.size === many.length, `${pageCalls.length} calls`);
  check('office scope rides every split request', pageCalls.every((call) => /[?&]office=office-9/.test(call.url)));
  page.reset();
  page.status = 500;
  let threw = false;
  try { await fetchOfficePatientPhotoPage(PATIENT_ID, ['a'], 'thumb', null); } catch { threw = true; }
  check('a failed page throws (callers decide the fallback)', threw);
}

for (const renderer of renderers) await act(async () => { renderer.unmount(); });
if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nphoto pages on the live patient record: all checks passed');
