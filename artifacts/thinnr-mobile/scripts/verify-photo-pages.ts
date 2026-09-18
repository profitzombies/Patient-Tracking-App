/**
 * One-call photo pages — verification suite.
 *
 * Proves the display path for stored account photos (lib/photo-page-urls.ts)
 * and the Progress screen that rides it:
 *   1. per-photo URLs: account paths take a `variant` at thumb/medium, the
 *      original never carries one, legacy anonymous-rail paths are untouched;
 *   2. the page fetch posts ONE request per ≤100 paths with the held media
 *      token and parses `{path,url,size}` rows, surfacing failures;
 *   3. the resolver hook: fallback before the page lands, page URLs after,
 *      unknown paths fall back, legacy paths are never sent, no token =
 *      no call (demo persona), a failed page keeps the fallback, a reorder
 *      does not re-sign, expiry drops back to per-photo URLs;
 *   4. the real Progress grid renders stored photos from thumbnail page URLs
 *      (falling back to `&variant=thumb` file routes first), and tapping a
 *      photo opens the viewer on a medium page signed only at that moment.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:photo-pages
 */
import React from 'react';
import { act } from 'react';

process.env.EXPO_PUBLIC_DOMAIN = 'photo-pages.internal';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ── localStorage polyfill (web-platform storage for contexts + prefs) ────
const localStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => (localStore.has(key) ? localStore.get(key)! : null),
  setItem: (key: string, value: string) => void localStore.set(key, String(value)),
  removeItem: (key: string) => void localStore.delete(key),
  clear: () => void localStore.clear(),
  key: (index: number) => [...localStore.keys()][index] ?? null,
  get length() {
    return localStore.size;
  },
};

const SWALLOWED_LOG_PREFIXES = ['Warning:', 'react-test-renderer is deprecated', 'The above error occurred'];
const realConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (SWALLOWED_LOG_PREFIXES.some(prefix => first.startsWith(prefix))) return;
  if (first.includes('act(')) return;
  realConsoleError(...args);
};
// The hook logs a warning when a page fails; that is the behaviour under
// test, so keep it out of the transcript.
const warnings: string[] = [];
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(' '));
};

import { Platform } from './guided-photo-stubs/react-native';
import { routerState } from './meal-photo-stubs/expo-router';
import AsyncStorageStub from './meal-photo-stubs/async-storage';
import { apiBase } from '../lib/coach-api';
import { setPatientMediaToken } from '../lib/media-token-holder';
import {
  chunkPaths,
  fetchPhotoPage,
  photoFileUrl,
  PHOTO_PAGE_MAX,
  usePhotoPageUrls,
  type PhotoSize,
  type PhotoUrlResolver,
} from '../lib/photo-page-urls';
import { progressPhotoDisplayUrl } from '../lib/progress-photo-upload';
import { patientMediaDisplayUrl } from '../lib/patient-data-api';
import { PatientProvider, usePatient } from '../context/PatientContext';
import { TODAY_KEY } from '../data/patient-data';
import * as ProgressModule from '../app/(patient)/progress';

const ProgressScreen = (ProgressModule as Record<string, unknown>)
  .default as React.ComponentType<Record<string, never>>;
const h = React.createElement;

// ── Tally ────────────────────────────────────────────────────────────────
let checks = 0;
let failures = 0;

function fail(label: string, detail?: unknown): void {
  failures += 1;
  console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${String(detail)}`}`);
}

function assert(condition: boolean, label: string, detail?: unknown): void {
  checks += 1;
  if (condition) return;
  fail(label, detail);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  checks += 1;
  if (Object.is(actual, expected)) return;
  fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title: string): void {
  console.log(`\n== ${title}`);
}

function finish(): never {
  console.log(`\n${checks} checks, ${failures} failure${failures === 1 ? '' : 's'}`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── React test helpers ───────────────────────────────────────────────────
interface TInstance {
  type: unknown;
  props: Record<string, any>;
  children: Array<TInstance | string>;
}
interface TRenderer {
  root: TInstance & { findAll(fn: (node: TInstance) => boolean): TInstance[] };
  unmount(): void;
}
let TestRendererCreate: (el: React.ReactElement) => TRenderer;

async function actSettle(mutate?: () => unknown): Promise<void> {
  await act(async () => {
    await mutate?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function actSleep(ms: number): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      assert(true, label);
      return true;
    }
    if (Date.now() > deadline) {
      assert(false, label, 'timed out waiting');
      return false;
    }
    await actSleep(10);
  }
}

function allByTestID(renderer: TRenderer, testID: string): TInstance[] {
  return renderer.root.findAll(node => typeof node.type === 'string' && node.props?.testID === testID);
}

function byTestID(renderer: TRenderer, testID: string): TInstance | null {
  return allByTestID(renderer, testID)[0] ?? null;
}

function imageUris(renderer: TRenderer): string[] {
  return renderer.root
    .findAll(node => typeof node.type === 'string' && typeof node.props?.source?.uri === 'string')
    .map(node => node.props.source.uri as string);
}

async function tap(renderer: TRenderer, testID: string, label: string): Promise<void> {
  const node = byTestID(renderer, testID);
  if (!node || typeof node.props.onPress !== 'function') {
    assert(false, label, `no pressable node with testID ${testID}`);
    return;
  }
  await actSettle(() => node.props.onPress());
  assert(true, label);
}

// ── Fetch double: the page endpoint and nothing else ─────────────────────
interface PageCall {
  paths: string[];
  variant: PhotoSize;
  mt: string;
}
const pageCalls: PageCall[] = [];
const otherFetches: string[] = [];
/** Scenario knobs for the page endpoint. */
const pageServer = {
  /** HTTP status; anything but 200 is a failed page. */
  status: 200,
  /** Server-side "variant exists yet" answer per path (default: yes). */
  missingVariant: new Set<string>(),
  /** Paths the server refuses to sign (not this patient's). */
  reject: new Set<string>(),
  ttlMs: 30 * 60 * 1000,
  /** Network latency, so "before the page lands" is observable. */
  delayMs: 20,
  reset(): void {
    this.status = 200;
    this.delayMs = 20;
    this.missingVariant.clear();
    this.reject.clear();
    this.ttlMs = 30 * 60 * 1000;
    pageCalls.length = 0;
    otherFetches.length = 0;
  },
};

const signedUrl = (path: string, size: PhotoSize) =>
  `https://signed.example/${size}${path}?sig=${pageCalls.length}`;

globalThis.fetch = (async (input: unknown, init?: Record<string, any>) => {
  const url = typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? input);
  const method = String(init?.method ?? 'GET').toUpperCase();
  if (method === 'POST' && url.endsWith('/patient-media/urls')) {
    const body = JSON.parse(String(init?.body ?? '{}')) as PageCall;
    pageCalls.push(body);
    await new Promise(resolve => setTimeout(resolve, pageServer.delayMs));
    if (pageServer.status !== 200) {
      return new Response(JSON.stringify({ error: 'nope' }), { status: pageServer.status });
    }
    const urls = body.paths
      .filter(path => !pageServer.reject.has(path))
      .map(path => {
        const size: PhotoSize = pageServer.missingVariant.has(path) ? 'original' : body.variant;
        return { path, url: signedUrl(path, size), size };
      });
    return new Response(
      JSON.stringify({ urls, expiresAt: new Date(Date.now() + pageServer.ttlMs).toISOString() }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  otherFetches.push(`${method} ${url}`);
  throw new Error(`Unexpected fetch in photo-pages suite: ${method} ${url}`);
}) as typeof fetch;

// ── Hook harness ─────────────────────────────────────────────────────────
let lastResolver: PhotoUrlResolver | null = null;
let hookRenders = 0;
function HookProbe({ paths, size }: { paths: string[]; size: PhotoSize }): null {
  lastResolver = usePhotoPageUrls(paths, size);
  hookRenders += 1;
  return null;
}

async function mountHook(paths: string[], size: PhotoSize): Promise<TRenderer & { update(el: React.ReactElement): void }> {
  let renderer!: TRenderer & { update(el: React.ReactElement): void };
  await actSettle(() => {
    renderer = TestRendererCreate(h(HookProbe, { paths, size })) as typeof renderer;
  });
  return renderer;
}

let patientCtx: ReturnType<typeof usePatient> | null = null;
function PatientProbe(): null {
  patientCtx = usePatient();
  return null;
}

const ACCOUNT_A = '/objects/patient-media/pt-1/progress/aaa.jpg';
const ACCOUNT_B = '/objects/patient-media/pt-1/progress/bbb.jpg';
const ACCOUNT_C = '/objects/patient-media/pt-1/chat/ccc.jpg';
const LEGACY = '/objects/progress-photos/legacy-1';
const TOKEN = 'mt-test-token';

async function main(): Promise<void> {
  const trModule = (await import('react-test-renderer')) as Record<string, any>;
  const TestRenderer = trModule.default ?? trModule;
  TestRendererCreate = (element: React.ReactElement) => TestRenderer.create(element);
  (Platform as { OS: string }).OS = 'web';

  // ── 1. Per-photo URLs ──────────────────────────────────────────────────
  section('1. Per-photo file URLs carry the size');
  {
    setPatientMediaToken(TOKEN);
    const base = apiBase();
    const enc = encodeURIComponent(ACCOUNT_A);
    assertEqual(
      photoFileUrl(ACCOUNT_A, 'thumb'),
      `${base}/patient-media/file?path=${enc}&variant=thumb&mt=${TOKEN}`,
      'thumb asks the file route for the variant, token last',
    );
    assertEqual(
      photoFileUrl(ACCOUNT_A, 'medium'),
      `${base}/patient-media/file?path=${enc}&variant=medium&mt=${TOKEN}`,
      'medium asks the file route for the variant',
    );
    assertEqual(photoFileUrl(ACCOUNT_A), `${base}/patient-media/file?path=${enc}&mt=${TOKEN}`, 'no size = original, no variant param');
    assertEqual(photoFileUrl(ACCOUNT_A, 'original'), photoFileUrl(ACCOUNT_A), "'original' is byte-identical to no size");
    const legacy = `${base}/progress-photos/file?path=${encodeURIComponent(LEGACY)}`;
    assertEqual(photoFileUrl(LEGACY, 'thumb'), legacy, 'legacy rail ignores the size (no variants there)');
    assertEqual(photoFileUrl(LEGACY), legacy, 'legacy rail carries no token');
    assertEqual(progressPhotoDisplayUrl(ACCOUNT_A, 'thumb'), photoFileUrl(ACCOUNT_A, 'thumb'), 'progressPhotoDisplayUrl delegates');
    assertEqual(patientMediaDisplayUrl(ACCOUNT_C, 'thumb'), photoFileUrl(ACCOUNT_C, 'thumb'), 'patientMediaDisplayUrl delegates');
    assertEqual(progressPhotoDisplayUrl(LEGACY), legacy, 'legacy display URL unchanged for old grids');
    setPatientMediaToken(null);
    assert(!photoFileUrl(ACCOUNT_A, 'thumb').includes('mt='), 'no token held = no token on the URL');
  }

  // ── 2. Page fetch contract ─────────────────────────────────────────────
  section('2. One page request per ≤100 paths');
  {
    pageServer.reset();
    setPatientMediaToken(null);
    let threw = false;
    try {
      await fetchPhotoPage([ACCOUNT_A], 'thumb');
    } catch {
      threw = true;
    }
    assert(threw, 'no media token = the page call is refused client-side');
    assertEqual(pageCalls.length, 0, 'and nothing was sent');

    setPatientMediaToken(TOKEN);
    pageServer.missingVariant.add(ACCOUNT_B);
    const page = await fetchPhotoPage([ACCOUNT_A, ACCOUNT_B], 'thumb');
    assertEqual(pageCalls.length, 1, 'one POST for two paths');
    assertEqual(JSON.stringify(pageCalls[0]), JSON.stringify({ paths: [ACCOUNT_A, ACCOUNT_B], variant: 'thumb', mt: TOKEN }), 'body = paths + variant + token');
    assertEqual(page.urls.get(ACCOUNT_A)?.size, 'thumb', 'a generated variant reports thumb');
    assertEqual(page.urls.get(ACCOUNT_B)?.size, 'original', 'a not-yet-backfilled photo reports original');
    assert(page.expiresAt > Date.now() + 29 * 60 * 1000, 'expiry parsed from the server');

    pageServer.status = 500;
    threw = false;
    try {
      await fetchPhotoPage([ACCOUNT_A], 'thumb');
    } catch (error) {
      threw = /500/.test(String(error));
    }
    assert(threw, 'a failed page throws with the status, never resolves empty');
    pageServer.status = 200;

    const many = Array.from({ length: 250 }, (_, i) => `/objects/patient-media/pt-1/progress/${i}.jpg`);
    const chunks = chunkPaths(many);
    assertEqual(chunks.length, 3, '250 paths = 3 pages');
    assertEqual(chunks[0].length, PHOTO_PAGE_MAX, 'first page is full');
    assertEqual(chunks[2].length, 50, 'last page holds the remainder');
    assertEqual(chunks.flat().join(), many.join(), 'order preserved');
  }

  // ── 3. Resolver hook ───────────────────────────────────────────────────
  section('3. Resolver: fallback first, page URLs once landed');
  {
    pageServer.reset();
    setPatientMediaToken(TOKEN);
    const paths = [ACCOUNT_A, LEGACY, ACCOUNT_B];
    const renderer = await mountHook(paths, 'thumb');
    // Same tick as mount: nothing has landed, the grid must still resolve.
    assertEqual(lastResolver!(ACCOUNT_A), photoFileUrl(ACCOUNT_A, 'thumb'), 'before the page lands: per-photo route at the same size');
    await waitUntil('page landed', () => lastResolver!(ACCOUNT_A).startsWith('https://signed.example/thumb'));
    assertEqual(pageCalls.length, 1, 'exactly one page call for the screen');
    assertEqual(JSON.stringify(pageCalls[0].paths), JSON.stringify([ACCOUNT_A, ACCOUNT_B]), 'legacy paths never join the page (sorted account set)');
    assertEqual(lastResolver!(LEGACY), photoFileUrl(LEGACY), 'legacy path resolves to its own route');
    assertEqual(lastResolver!('/objects/patient-media/pt-1/progress/unknown.jpg'), photoFileUrl('/objects/patient-media/pt-1/progress/unknown.jpg', 'thumb'), 'a path missing from the page falls back');

    // Reorder + duplicate = same set: no second call.
    await actSettle(() => renderer.update(h(HookProbe, { paths: [ACCOUNT_B, ACCOUNT_A, ACCOUNT_A, LEGACY], size: 'thumb' })));
    await actSleep(30);
    assertEqual(pageCalls.length, 1, 'reordering the same photos does not re-sign');

    // A new photo re-signs once and keeps serving the old page meanwhile.
    await actSettle(() => renderer.update(h(HookProbe, { paths: [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C], size: 'thumb' })));
    assert(lastResolver!(ACCOUNT_A).startsWith('https://signed.example/thumb'), 'previous page keeps serving while the new one signs');
    await waitUntil('new photo signed', () => lastResolver!(ACCOUNT_C).startsWith('https://signed.example/thumb'));
    assertEqual(pageCalls.length, 2, 'one more call for the new set');
    assertEqual(pageCalls[1].paths.length, 3, 'the new page covers all three');

    // Size change = a different page at that size.
    await actSettle(() => renderer.update(h(HookProbe, { paths: [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C], size: 'medium' })));
    assertEqual(lastResolver!(ACCOUNT_A), photoFileUrl(ACCOUNT_A, 'medium'), 'a thumb page never serves a medium request');
    await waitUntil('medium page landed', () => lastResolver!(ACCOUNT_A).startsWith('https://signed.example/medium'));
    assertEqual(pageCalls[2].variant, 'medium', 'medium page asked for medium');
    await actSettle(() => renderer.unmount());
  }

  section('3b. Resolver: no token, failed page, expiry');
  {
    pageServer.reset();
    setPatientMediaToken(null);
    const demo = await mountHook([ACCOUNT_A], 'thumb');
    await actSleep(30);
    assertEqual(pageCalls.length, 0, 'demo persona (no token) never calls the page endpoint');
    assertEqual(lastResolver!(ACCOUNT_A), photoFileUrl(ACCOUNT_A, 'thumb'), 'and still resolves a URL');
    await actSettle(() => demo.unmount());

    setPatientMediaToken(TOKEN);
    pageServer.status = 503;
    warnings.length = 0;
    const failing = await mountHook([ACCOUNT_A], 'thumb');
    await waitUntil('failed page logged', () => warnings.some(line => line.includes('falling back to per-photo loads')));
    assertEqual(pageCalls.length, 1, 'one attempt');
    assertEqual(lastResolver!(ACCOUNT_A), photoFileUrl(ACCOUNT_A, 'thumb'), 'a failed page leaves the per-photo fallback in place');
    await actSettle(() => failing.unmount());

    pageServer.status = 200;
    pageServer.ttlMs = 1000;
    const realNow = Date.now;
    const expiring = await mountHook([ACCOUNT_A], 'thumb');
    await waitUntil('short-lived page landed', () => lastResolver!(ACCOUNT_A).startsWith('https://signed.example/thumb'));
    const landedAt = realNow();
    Date.now = () => landedAt + 5000;
    try {
      assertEqual(lastResolver!(ACCOUNT_A), photoFileUrl(ACCOUNT_A, 'thumb'), 'an expired page is never served — back to the per-photo route');
    } finally {
      Date.now = realNow;
    }
    await actSettle(() => expiring.unmount());
    assertEqual(otherFetches.length, 0, 'no other network traffic across the hook scenarios');
  }

  // ── 4. Real Progress grid ──────────────────────────────────────────────
  section('4. Progress grid: thumbnail page, medium viewer on tap');
  {
    pageServer.reset();
    setPatientMediaToken(TOKEN);
    localStore.clear();
    const seeded = JSON.stringify({ nudgeOptOut: true });
    localStore.set('thinnr_patient_state_v1', seeded);
    await AsyncStorageStub.setItem('thinnr_patient_state_v1', seeded);
    localStore.set('thinnr_app_mode_v1', 'patient');
    routerState.pathname = '/progress';
    pageServer.missingVariant.add(ACCOUNT_B); // older photo, thumb not backfilled yet

    let renderer!: TRenderer;
    await actSettle(() => {
      renderer = TestRendererCreate(h(PatientProvider, null, h(PatientProbe), h(ProgressScreen)));
    });
    await waitUntil('Progress rendered', () => byTestID(renderer, 'progress-guided-session') !== null);
    assertEqual(pageCalls.length, 0, 'seed-only grid signs nothing');
    // The provider clears any previous account's media token while it
    // hydrates; a real account's own token lands with its hydration, before
    // its stored photos do. Stand in for that here.
    setPatientMediaToken(TOKEN);

    await actSettle(() =>
      patientCtx!.addPhotos([
        { dateKey: TODAY_KEY, label: 'Week 12 Front', angle: 'front', objectPath: ACCOUNT_A },
        { dateKey: TODAY_KEY, label: 'Week 12 Side', angle: 'side', objectPath: ACCOUNT_B },
      ]),
    );
    // First paint after the add: per-photo thumbs, then the page takes over.
    const fallbackSeen = imageUris(renderer).includes(photoFileUrl(ACCOUNT_A, 'thumb'));
    await waitUntil('grid switched to page-signed thumbnails', () =>
      imageUris(renderer).includes(`https://signed.example/thumb${ACCOUNT_A}?sig=1`),
    );
    assert(fallbackSeen || pageCalls.length === 1, 'grid rendered a URL before the page landed (or the page landed within the same settle)');
    assertEqual(pageCalls.length, 1, 'one thumbnail page for the grid');
    assertEqual(pageCalls[0].variant, 'thumb', 'grid asks for thumbnails');
    assertEqual(JSON.stringify(pageCalls[0].paths), JSON.stringify([ACCOUNT_A, ACCOUNT_B]), 'page lists exactly the stored photos');
    assert(imageUris(renderer).includes(`https://signed.example/original${ACCOUNT_B}?sig=1`), 'a photo without a thumb yet shows the original the server signed');
    assert(!imageUris(renderer).some(uri => uri.includes('/patient-media/file?')), 'no per-photo file requests remain once the page landed');

    const stored = patientCtx!.photos.filter(photo => photo.objectPath === ACCOUNT_A);
    assertEqual(stored.length, 1, 'stored photo is in the grid');
    const openId = `photo-open-${stored[0].id}`;
    assert(byTestID(renderer, openId)?.props.accessibilityRole === 'button', 'each photo is a tap-in button');
    assertEqual(pageCalls.filter(call => call.variant === 'medium').length, 0, 'medium is not signed until the viewer opens');

    await tap(renderer, openId, 'tap a stored photo');
    await waitUntil('viewer opens on the tapped photo', () =>
      byTestID(renderer, `photo-lightbox-page-${stored[0].id}`) !== null,
    );
    await waitUntil('viewer image upgrades to the medium page URL', () =>
      imageUris(renderer).includes(`https://signed.example/medium${ACCOUNT_A}?sig=2`),
    );
    const mediumCalls = pageCalls.filter(call => call.variant === 'medium');
    assertEqual(mediumCalls.length, 1, 'one medium page for the viewer');
    assertEqual(JSON.stringify(mediumCalls[0].paths), JSON.stringify([ACCOUNT_A, ACCOUNT_B]), 'medium page covers the whole grid (swipe-ready)');
    assert(imageUris(renderer).includes(`https://signed.example/thumb${ACCOUNT_A}?sig=1`), 'grid keeps its thumbnails behind the viewer');

    await tap(renderer, 'photo-lightbox-close', 'close the viewer');
    await waitUntil('viewer closed', () => byTestID(renderer, 'photo-lightbox-close') === null);
    assertEqual(pageCalls.length, 2, 'closing signs nothing new');

    // A removed photo shrinks the set: the grid re-signs once, without it.
    await actSettle(() => patientCtx!.removePhoto(stored[0].id));
    await waitUntil('grid re-signed without the removed photo', () =>
      pageCalls.filter(call => call.variant === 'thumb').length === 2,
    );
    assertEqual(JSON.stringify(pageCalls.at(-1)!.paths), JSON.stringify([ACCOUNT_B]), 'the removed photo left the page');
    assertEqual(otherFetches.length, 0, 'no other network traffic from the Progress screen');
    await actSettle(() => renderer.unmount());
  }

  finish();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
