/**
 * "Get the app" QR panel — office Patients page.
 *
 *   TZ=UTC tsx --tsconfig tsconfig.roster-activity.json scripts/verify-app-store-qr.tsx
 *
 * Covers:
 *   - lib/qr encodes locally: the matrix matches the encoder's own modules,
 *     the SVG path covers exactly the dark modules, and the standalone SVG
 *     markup is self-contained (no external service, no script).
 *   - the panel renders one code per store from EXACTLY the HQ links, with
 *     short labels; a blank link shows "HQ hasn't added this link yet" in
 *     place of a code; loading/error never fall back to demo links.
 *   - the print sheet carries the practice name, both codes (or the notice),
 *     and nothing else that could leak; the button is disabled when there is
 *     no code to print.
 *   - the Patients page wiring: signed-in provider staff see no panel and
 *     make no settings request; HQ drill-ins read the live HQ value scoped
 *     by office; the guided demo shows the seeded placeholder links without
 *     any request; signed-in HQ without an office scope sees no panel.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import QRCode from 'qrcode';
import type { OfficeSettings as OfficeSettingsDto } from '@workspace/api-client-react';
import { PatientSessionProvider } from '../src/contexts/patient-session';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { qrMatrix, qrPath, qrSvgMarkup } from '../src/lib/qr';
import { STORE_LINK_MISSING, storeLinkProblem, storeLinksOf } from '../src/lib/org-policy';
import { demoOfficeSettings } from '../src/data/hq/demo-office-settings';
import { DEMO_APP_STORE_URL, DEMO_GOOGLE_PLAY_URL } from '../src/data/hq/settings';
import { GetTheAppPanel, OfficeGetTheAppPanel, buildAppSheetHtml } from '../src/components/office/GetTheAppPanel';
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

function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') { parts.push(node); return; }
    for (const child of node.children) walk(child as ReactTestInstance | string);
  };
  walk(instance);
  return parts.join('');
}
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const oneByTestId = (root: ReactTestInstance, id: string) => {
  const matches = byTestId(root, id);
  if (matches.length !== 1) throw new Error(`expected exactly one [data-testid="${id}"], found ${matches.length}`);
  return matches[0];
};
const qrSvgs = (root: ReactTestInstance) => root.findAll((node) => node.type === 'svg' && typeof node.props['data-qr-value'] === 'string');
const settle = async (ticks = 10) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

const APP_STORE = 'https://apps.apple.com/us/app/thinnr/id6740000001';
const PLAY = 'https://play.google.com/store/apps/details?id=com.thinnr.app';
const PLAY_V2 = 'https://play.google.com/store/apps/details?id=com.thinnr.app&hl=en_US';

// ─── lib/qr ──────────────────────────────────────────────────────────────────

console.log('lib/qr — local encoding');
{
  const matrix = qrMatrix(APP_STORE);
  const reference = QRCode.create(APP_STORE, { errorCorrectionLevel: 'M' });
  const referenceDark = Array.from(reference.modules.data as ArrayLike<number | boolean>, Boolean);
  check('matrix is square and matches the encoder\'s modules', matrix.size === reference.modules.size && matrix.dark.length === matrix.size * matrix.size && matrix.dark.every((v, i) => v === referenceDark[i]));
  check('a different link yields a different matrix', JSON.stringify(qrMatrix(PLAY).dark) !== JSON.stringify(matrix.dark));
  // The path is a set of 1-module-tall rectangles; rasterise it back and compare.
  const path = qrPath(matrix);
  const painted = new Array<boolean>(matrix.size * matrix.size).fill(false);
  for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [, x, y, w] = m.map(Number);
    for (let dx = 0; dx < w; dx += 1) painted[y * matrix.size + x + dx] = true;
  }
  check('SVG path covers exactly the dark modules', painted.every((v, i) => v === matrix.dark[i]) && path.length > 0);
  const markup = qrSvgMarkup(PLAY, 240, 'Google Play QR code');
  check('standalone SVG is self-contained', markup.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && markup.includes('aria-label="Google Play QR code"') && !/<script|href=|http/.test(markup.replace('http://www.w3.org/2000/svg', '')));
  check('store-link shape check accepts real listings and blank, rejects other hosts',
    storeLinkProblem('appStore', APP_STORE) === null && storeLinkProblem('googlePlay', PLAY) === null && storeLinkProblem('appStore', '  ') === null
    && storeLinkProblem('appStore', 'https://example.com/app') !== null && storeLinkProblem('googlePlay', 'https://play.google.com/') !== null && storeLinkProblem('appStore', PLAY) !== null);
  check('storeLinksOf keeps display order and blanks to null', JSON.stringify(storeLinksOf({ appStoreUrl: ` ${APP_STORE} `, googlePlayUrl: '' })) === JSON.stringify([{ kind: 'appStore', url: APP_STORE }, { kind: 'googlePlay', url: null }]));
}

// ─── Panel in isolation ──────────────────────────────────────────────────────

async function renderPanel(element: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root };
}

console.log('panel — both links');
{
  const { root } = await renderPanel(<GetTheAppPanel practiceName="Riverside Wellness" hq={{ appStoreUrl: APP_STORE, googlePlayUrl: PLAY }} />);
  const svgs = qrSvgs(root);
  check('two codes render, encoding exactly the HQ links in store order', svgs.length === 2 && svgs[0].props['data-qr-value'] === APP_STORE && svgs[1].props['data-qr-value'] === PLAY);
  check('each code is an accessible image with a store label', svgs.every((svg) => svg.props.role === 'img') && svgs[0].props['aria-label'].startsWith('App Store QR code') && svgs[1].props['aria-label'].startsWith('Google Play QR code'));
  check('module count on the element matches the local matrix', Number(svgs[0].props['data-qr-size']) === qrMatrix(APP_STORE).size);
  const text = textOf(root);
  check('short labels under the codes', text.includes('App Store') && text.includes('iPhone') && text.includes('Google Play') && text.includes('Android'));
  check('no missing-link notice when both are set', byTestId(root, 'store-code-missing-appStore').length === 0 && byTestId(root, 'store-code-missing-googlePlay').length === 0);
  check('print button is enabled', oneByTestId(root, 'button-print-app-sheet').props.disabled === false);
}

console.log('panel — one blank link');
{
  const { root } = await renderPanel(<GetTheAppPanel practiceName="Riverside Wellness" hq={{ appStoreUrl: APP_STORE, googlePlayUrl: null }} />);
  const svgs = qrSvgs(root);
  check('only the App Store code renders', svgs.length === 1 && svgs[0].props['data-qr-value'] === APP_STORE);
  check('Google Play shows the not-added notice in place of a code', textOf(oneByTestId(root, 'store-code-missing-googlePlay')) === STORE_LINK_MISSING && byTestId(root, 'store-code-missing-appStore').length === 0);
  check('print stays available for the one code', oneByTestId(root, 'button-print-app-sheet').props.disabled === false);
}

console.log('panel — both blank, loading, error');
{
  const blank = await renderPanel(<GetTheAppPanel practiceName="Riverside Wellness" hq={{ appStoreUrl: null, googlePlayUrl: null }} />);
  check('both notices, no codes, print disabled', qrSvgs(blank.root).length === 0 && byTestId(blank.root, 'store-code-missing-appStore').length === 1 && byTestId(blank.root, 'store-code-missing-googlePlay').length === 1 && oneByTestId(blank.root, 'button-print-app-sheet').props.disabled === true);
  const loading = await renderPanel(<GetTheAppPanel practiceName="Your practice" hq={null} status="loading" />);
  check('loading shows a status line and no demo codes', qrSvgs(loading.root).length === 0 && textOf(oneByTestId(loading.root, 'text-get-the-app-status')) === 'Loading store links…');
  const failed = await renderPanel(<GetTheAppPanel practiceName="Your practice" hq={null} status="error" />);
  check('a failed load says so instead of showing placeholder codes', qrSvgs(failed.root).length === 0 && textOf(oneByTestId(failed.root, 'text-get-the-app-status')).startsWith('Couldn’t load'));
}

console.log('print sheet');
{
  const html = buildAppSheetHtml('Riverside <Wellness> & Co', storeLinksOf({ appStoreUrl: APP_STORE, googlePlayUrl: null }));
  check('sheet names the practice (escaped)', html.includes('Riverside &lt;Wellness&gt; &amp; Co') && !html.includes('<Wellness>'));
  check('sheet carries the App Store code and the Play notice', (html.match(/<svg /g) ?? []).length === 1 && html.includes('App Store') && html.includes(STORE_LINK_MISSING) && html.includes('Google Play'));
  check('sheet is a standalone page with no scripts or remote images', html.startsWith('<!doctype html>') && !html.includes('<script') && !html.includes('<img'));
  const both = buildAppSheetHtml('Riverside Wellness', storeLinksOf({ appStoreUrl: APP_STORE, googlePlayUrl: PLAY }));
  check('with both links the sheet holds two codes and no notice', (both.match(/<svg /g) ?? []).length === 2 && !both.includes(STORE_LINK_MISSING));
  check('the sheet encodes the same matrices the panel shows', both.includes(qrPath(qrMatrix(APP_STORE))) && both.includes(qrPath(qrMatrix(PLAY))));
}

// ─── Patients page wiring ────────────────────────────────────────────────────

const requests: string[] = [];
let officeSettings: OfficeSettingsDto = { ...demoOfficeSettings(), office: { providerId: 'prov-1', officeName: 'Riverside Wellness' }, hq: { ...demoOfficeSettings().hq, appStoreUrl: APP_STORE, googlePlayUrl: PLAY } };
const ROSTER = { office: { providerId: 'prov-1', officeName: 'Riverside Wellness', providerCode: '483920' }, patients: [], asOfDate: '2026-09-06', latestActivityDate: null, deleted: [] };

g.fetch = async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push(url);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/api/office/settings')) return json(officeSettings);
  if (url.includes('/api/office/roster')) return json(ROSTER);
  throw new Error(`unexpected fetch ${url}`);
};

async function renderRoster(element: React.ReactElement = <Patients />, path = '/patients') {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <PatientSessionProvider>
          <Router hook={loc.hook}>{element}</Router>
        </PatientSessionProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root };
}

console.log('Patients page — guided demo persona');
{
  __setSession({ authStatus: 'signed-out', authRole: null, hqRole: null, authUser: null });
  __setScope(null);
  requests.length = 0;
  const { root } = await renderRoster();
  const svgs = qrSvgs(root);
  check('the panel sits on the roster page with the seeded placeholder links', byTestId(root, 'panel-get-the-app').length === 1 && svgs.length === 2 && svgs[0].props['data-qr-value'] === DEMO_APP_STORE_URL && svgs[1].props['data-qr-value'] === DEMO_GOOGLE_PLAY_URL);
  check('demo makes no request', requests.length === 0);
  check('demo placeholders look like real listings', DEMO_APP_STORE_URL.startsWith('https://apps.apple.com/') && DEMO_GOOGLE_PLAY_URL.startsWith('https://play.google.com/store/apps/details?id='));
}

console.log('Patients page — signed-in provider staff');
{
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', hqRole: null, providerAccountCode: 'TEST', authUser: { id: 'u-staff' } });
  __setSupabaseSession('staff-token');
  __setScope(null);
  requests.length = 0;
  const { root } = await renderRoster();
  const settingsGets = requests.filter((url) => url.includes('/api/office/settings'));
  check('signed-in provider staff see no Get the app panel on their roster', byTestId(root, 'panel-get-the-app').length === 0 && qrSvgs(root).length === 0);
  check('the Invite action is still there', byTestId(root, 'button-invite-patient').length === 1);
  check('the hidden panel makes no office settings request', settingsGets.length === 0, settingsGets.join(','));
}

console.log('Patients page — HQ drill-in and HQ without scope');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', hqRole: 'Admin', authUser: { id: 'u-admin' } });
  __setSupabaseSession('hq-token');
  __setScope({ providerId: 'prov-1', officeName: 'Riverside Wellness', providerName: 'Dr. Test', providerRole: 'Owner' });
  officeSettings = { ...officeSettings, hq: { ...officeSettings.hq, googlePlayUrl: PLAY_V2, appStoreUrl: null } };
  requests.length = 0;
  const { root } = await renderRoster(<OfficeGetTheAppPanel liveEnabled liveOffice="prov-1" />);
  const get = requests.find((url) => url.includes('/api/office/settings'));
  check('HQ drill-in scopes the settings read by office', get !== undefined && get.includes('office=prov-1'), get);
  check('drill-in shows the office\'s live codes', qrSvgs(root).length === 1 && qrSvgs(root)[0].props['data-qr-value'] === PLAY_V2);

  __setScope(null);
  requests.length = 0;
  const bare = await renderRoster(<OfficeGetTheAppPanel liveEnabled={false} liveOffice={null} />);
  check('signed-in HQ without an office scope sees no panel and no demo links', byTestId(bare.root, 'panel-get-the-app').length === 0 && requests.length === 0);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll app-store QR checks passed.');
