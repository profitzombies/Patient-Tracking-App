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
 *   - the Patients page no longer shows the panel (owner request,
 *     2026-09-28) for the demo, provider staff, or HQ drill-ins, and makes
 *     no office settings request for it.
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
import { GetTheAppPanel, buildAppSheetHtml } from '../src/components/office/GetTheAppPanel';
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
const EXPO_GO = 'https://app.thinnr.test/thinnr-mobile/';

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
  check('storeLinksOf keeps display order and blanks to null', JSON.stringify(storeLinksOf({ appStoreUrl: ` ${APP_STORE} `, googlePlayUrl: '' })) === JSON.stringify([{ kind: 'appStore', url: APP_STORE, source: 'store' }, { kind: 'googlePlay', url: null, source: null }]));
  check('a blank store link falls back to the Expo Go page when the server reports one', JSON.stringify(storeLinksOf({ appStoreUrl: APP_STORE, googlePlayUrl: null }, EXPO_GO)) === JSON.stringify([{ kind: 'appStore', url: APP_STORE, source: 'store' }, { kind: 'googlePlay', url: EXPO_GO, source: 'expo_go' }]));
  check('TestFlight and Play testing links pass the shape check as interim store links', storeLinkProblem('appStore', 'https://testflight.apple.com/join/AbCdEf12') === null && storeLinkProblem('googlePlay', 'https://play.google.com/apps/internaltest/4700000000000000001') === null && storeLinkProblem('googlePlay', 'https://play.google.com/apps/testing/com.thinnr.app') === null);
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

console.log('panel — Expo Go fallback for a blank link');
{
  const { root } = await renderPanel(<GetTheAppPanel practiceName="Riverside Wellness" hq={{ appStoreUrl: APP_STORE, googlePlayUrl: null }} expoGoUrl={EXPO_GO} />);
  const svgs = qrSvgs(root);
  check('the Play code encodes the Expo Go page until HQ adds the store link', svgs.length === 2 && svgs[0].props['data-qr-value'] === APP_STORE && svgs[1].props['data-qr-value'] === EXPO_GO && byTestId(root, 'store-code-missing-googlePlay').length === 0);
  const sheet = buildAppSheetHtml('Riverside Wellness', storeLinksOf({ appStoreUrl: APP_STORE, googlePlayUrl: null }, EXPO_GO));
  check('the print sheet labels the fallback code', (sheet.match(/<svg /g) ?? []).length === 2 && sheet.includes('Expo Go page until HQ adds the store link') && !sheet.includes(STORE_LINK_MISSING));
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
const officeSettings: OfficeSettingsDto = { ...demoOfficeSettings(), office: { providerId: 'prov-1', officeName: 'Riverside Wellness' }, hq: { ...demoOfficeSettings().hq, appStoreUrl: APP_STORE, googlePlayUrl: PLAY } };
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

const rosterCases: Array<{ label: string; session: Parameters<typeof __setSession>[0]; token: string | null; scope: Parameters<typeof __setScope>[0] }> = [
  { label: 'guided demo persona', session: { authStatus: 'signed-out', authRole: null, hqRole: null, authUser: null }, token: null, scope: null },
  { label: 'signed-in provider staff', session: { authStatus: 'signed-in', authRole: 'provider_staff', hqRole: null, providerAccountCode: 'TEST', authUser: { id: 'u-staff' } }, token: 'staff-token', scope: null },
  { label: 'HQ drill-in', session: { authStatus: 'signed-in', authRole: 'hq_admin', hqRole: 'Admin', authUser: { id: 'u-admin' } }, token: 'hq-token', scope: { providerId: 'prov-1', officeName: 'Riverside Wellness', providerName: 'Dr. Test', providerRole: 'Owner' } },
];

console.log('Patients page — no Get the app panel for anyone');
for (const rosterCase of rosterCases) {
  __setSession(rosterCase.session);
  if (rosterCase.token) __setSupabaseSession(rosterCase.token);
  __setScope(rosterCase.scope);
  requests.length = 0;
  const { root } = await renderRoster();
  check(`${rosterCase.label}: no panel and no QR codes on the roster`, byTestId(root, 'panel-get-the-app').length === 0 && qrSvgs(root).length === 0);
  check(`${rosterCase.label}: the roster makes no office settings request`, !requests.some((url) => url.includes('/api/office/settings')), requests.join(','));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll app-store QR checks passed.');
