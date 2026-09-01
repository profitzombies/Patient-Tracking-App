/**
 * verify-provider-training.ts — Node suite for the mobile Training tab.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:provider-training
 * (tsx --tsconfig tsconfig.provider-training.json, which remaps native-only
 * modules to stubs — see that file's header.)
 *
 * Three sections:
 *   1. WEB PARITY — the mobile lib/training.ts is a deliberate copy of the
 *      web operations training rules. One shared fixture bundle (drafts,
 *      subgroups, position ties, jsonb junk, unknown enums) runs through
 *      BOTH copies; any drift in assembly, ordering, numbering, unlock
 *      math, roster stats, or formatting fails here. A few hand-computed
 *      expectations pin values so both copies can't be wrong together.
 *   2. SNAPSHOT FETCH — fetchTrainingSnapshot against a fake PostgREST
 *      client: assembly of table payloads and error propagation.
 *   3. SCREENS — the real Training screens under react-test-renderer:
 *      unconfigured / loading / error+retry / ready states, outline lock
 *      presentation, deep-link lock explanation, chapter stepping,
 *      metadata-only attachments, and prev/next navigation.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { QueryClient as QueryClientT } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';

// tsx compiles the app modules to CJS, so useTrainingData loads react-query's
// CJS build. Load the SAME build here — a plain ESM import would pull the ESM
// build, and the provider's context would never reach the hook.
const requireCjs = createRequire(import.meta.url);
const { QueryClient, QueryClientProvider } =
  requireCjs('@tanstack/react-query') as typeof import('@tanstack/react-query');

import * as mobile from '../lib/training';
import * as webT from '../../thinnr-operations/src/data/hq/training';
import * as webO from '../../thinnr-operations/src/data/office-training';
import { fetchTrainingSnapshot } from '../hooks/useTrainingData';
import { setStubSession, setSupabase } from './provider-training-stubs/supabase';
import { routerLog, setPathname, setSearchParams } from './provider-training-stubs/expo-router';
import TrainingScreenModule from '../app/(tabs)/training';
import TrainingCourseScreenModule from '../app/training-course/[id]';
import TrainingLessonScreenModule from '../app/training-lesson/[courseId]/[videoId]';
import TrainingTeammateScreenModule from '../app/training-teammate/[viewerId]';

/**
 * tsx loads the CJS-compiled app modules from this ESM entry as a namespace
 * object, so the default import needs one more unwrap.
 */
type AnyComponent = React.ComponentType<Record<string, never>>;
function asComponent(mod: unknown): AnyComponent {
  const maybe = mod as { default?: AnyComponent };
  return maybe && typeof maybe === 'object' && maybe.default ? maybe.default : (mod as AnyComponent);
}
const TrainingScreen = asComponent(TrainingScreenModule);
const TrainingCourseScreen = asComponent(TrainingCourseScreenModule);
const TrainingLessonScreen = asComponent(TrainingLessonScreenModule);
const TrainingTeammateScreen = asComponent(TrainingTeammateScreenModule);

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Shared fixture bundle
// ---------------------------------------------------------------------------
// Course c1 "Flagship Protocol" (live, sequential). Module positions sort to
// [m0 draft, m1, m2-free], so published numbering starts at module 2.
// Inside m1, vTie shares position 2 with subgroup sg1 → video-first
// tie-break. sg1 hides a draft video between two published ones, so
// numbering skips: v4 is "2.3.3". vFree is video-level free unlock; all of
// m2 is module-level free.
//
// Published order (7): v1 2.1 · vTie 2.2 · v2 2.3.1 · v4 2.3.3 · vFree 2.6
//                      · v5 3.1.1 · v6 3.2
// (numbering counts draft entries — sgDraft and vDraftRoot hold slots 2.4/2.5)
// Durations 600+300+450+750+120+900+240 = 3360s → "56m".

const courseRows: mobile.TrainingCourseRow[] = [
  {
    id: 'c2',
    slug: 'open-course',
    title: 'Open Enrollment Course',
    description: 'Free-order refresher.',
    status: 'live',
    sequential_unlock: false,
    created_at: '2026-02-01T00:00:00Z',
  },
  {
    id: 'c1',
    slug: 'flagship',
    title: 'Flagship Protocol',
    description: 'The core THINNR program training.',
    status: 'live',
    sequential_unlock: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'cDraft',
    slug: 'draft-course',
    title: 'Unreleased Course',
    description: 'Not published yet.',
    status: 'draft',
    sequential_unlock: true,
    created_at: '2026-03-01T00:00:00Z',
  },
];

const moduleRows: mobile.TrainingModuleRow[] = [
  { id: 'm1', course_id: 'c1', title: 'Core Protocol', published: 'published', unlock_mode: 'sequential', position: 1 },
  { id: 'm0', course_id: 'c1', title: 'Hidden Intro', published: 'draft', unlock_mode: 'sequential', position: 0 },
  { id: 'm2', course_id: 'c1', title: 'Front Desk Playbook', published: 'published', unlock_mode: 'free', position: 2 },
  { id: 'mA', course_id: 'c2', title: 'Refresher', published: 'published', unlock_mode: 'sequential', position: 1 },
  { id: 'mD', course_id: 'cDraft', title: 'Draft Module', published: 'published', unlock_mode: 'sequential', position: 1 },
];

const subgroupRows: mobile.TrainingSubgroupRow[] = [
  { id: 'sg1', module_id: 'm1', title: 'Consult Room', published: 'published', unlock_mode: 'sequential', position: 2 },
  { id: 'sgDraft', module_id: 'm1', title: 'Hidden Subgroup', published: 'draft', unlock_mode: 'free', position: 3 },
  { id: 'sgX', module_id: 'm2', title: 'Reception', published: 'published', unlock_mode: 'weird', position: 1 },
];

const videoRows: mobile.TrainingVideoRow[] = [
  {
    id: 'v1',
    module_id: 'm1',
    subgroup_id: null,
    title: 'Getting started',
    duration_seconds: 600,
    published: 'published',
    unlock_mode: 'sequential',
    add_staff: 'auto',
    description: ['First paragraph.', 'Second paragraph.'],
    chapters: [
      { id: 'ch1', at: 0, title: 'Welcome' },
      { id: 'ch2', at: 180, title: 'Protocol basics' },
      { id: 'ch3', at: 420, title: 'Wrap-up' },
    ],
    thumbnail_chapter: 0,
    attachments: [{ id: 'a1', name: 'Intake checklist.pdf', sizeLabel: '1.2 MB' }],
    position: 1,
    video_source: null,
  },
  {
    id: 'vTie',
    module_id: 'm1',
    subgroup_id: null,
    title: 'Room setup',
    duration_seconds: 300,
    published: 'published',
    unlock_mode: 'sequential',
    add_staff: 'weird',
    // jsonb junk: sanitizers must scrub all of this identically to the web.
    description: 'not-an-array',
    chapters: [
      { id: 'chA', at: 0, title: 'Setup' },
      { id: 'chB', at: -5, title: 'Negative time' },
      { bad: 'no-id' },
      { id: 'chC', at: 'nope', title: 123 },
    ],
    thumbnail_chapter: -3,
    attachments: [{ id: 'aJunk', name: 42, sizeLabel: null }, 'garbage'],
    position: 2,
    video_source: null,
  },
  {
    id: 'v2',
    module_id: 'm1',
    subgroup_id: 'sg1',
    title: 'Consult flow',
    duration_seconds: 450,
    published: 'published',
    unlock_mode: 'sequential',
    add_staff: 'show',
    description: [],
    chapters: [{ id: 'c2ch1', at: 0, title: 'Flow' }],
    thumbnail_chapter: 0,
    attachments: [],
    position: 1,
    video_source: null,
  },
  {
    id: 'v3',
    module_id: 'm1',
    subgroup_id: 'sg1',
    title: 'Draft consult drill',
    duration_seconds: 500,
    published: 'draft',
    unlock_mode: 'sequential',
    add_staff: 'auto',
    description: [],
    chapters: [],
    thumbnail_chapter: 0,
    attachments: [],
    position: 2,
    video_source: null,
  },
  {
    id: 'v4',
    module_id: 'm1',
    subgroup_id: 'sg1',
    title: 'Objection handling',
    duration_seconds: 750,
    published: 'published',
    unlock_mode: 'sequential',
    add_staff: 'auto',
    description: ['One paragraph.'],
    chapters: [{ id: 'c4ch1', at: 0, title: 'Objections' }],
    thumbnail_chapter: 0,
    attachments: [],
    position: 3,
    video_source: null,
  },
  {
    id: 'vDraftRoot',
    module_id: 'm1',
    subgroup_id: null,
    title: 'Draft root video',
    duration_seconds: 100,
    published: 'draft',
    unlock_mode: 'sequential',
    add_staff: 'auto',
    description: [],
    chapters: [],
    thumbnail_chapter: 0,
    attachments: [],
    position: 4,
    video_source: null,
  },
  {
    id: 'vFree',
    module_id: 'm1',
    subgroup_id: null,
    title: 'Optional tour',
    duration_seconds: 120,
    published: 'published',
    unlock_mode: 'free',
    add_staff: 'hidden',
    description: [],
    chapters: [{ id: 'cfch1', at: 0, title: 'Tour' }],
    thumbnail_chapter: 0,
    attachments: [],
    position: 5,
    video_source: null,
  },
  {
    id: 'v5',
    module_id: 'm2',
    subgroup_id: 'sgX',
    title: 'Front desk greeting',
    duration_seconds: 900,
    published: 'published',
    unlock_mode: 'sequential',
    add_staff: 'auto',
    description: [],
    chapters: [{ id: 'c5ch1', at: 0, title: 'Greeting' }],
    thumbnail_chapter: 0,
    attachments: [],
    position: 1,
    video_source: null,
  },
  {
    id: 'v6',
    module_id: 'm2',
    subgroup_id: null,
    title: 'Phone scripts',
    duration_seconds: 240,
    published: 'weird',
    unlock_mode: 'sequential',
    add_staff: 'auto',
    description: [7, 'Kept paragraph.'],
    chapters: [{ id: 'c6ch1', at: 0, title: 'Scripts' }],
    thumbnail_chapter: 1,
    attachments: [],
    position: 2,
    video_source: null,
  },
  {
    id: 'vHidden',
    module_id: 'm0',
    subgroup_id: null,
    title: 'Hidden intro video',
    duration_seconds: 60,
    published: 'published',
    unlock_mode: 'sequential',
    add_staff: 'auto',
    description: [],
    chapters: [],
    thumbnail_chapter: 0,
    attachments: [],
    position: 1,
    video_source: null,
  },
  {
    id: 'w1',
    module_id: 'mA',
    subgroup_id: null,
    title: 'Refresher part one',
    duration_seconds: 3600,
    published: 'published',
    unlock_mode: 'sequential',
    add_staff: 'auto',
    description: [],
    chapters: [{ id: 'w1ch1', at: 0, title: 'Part one' }],
    thumbnail_chapter: 0,
    attachments: [],
    position: 1,
    video_source: null,
  },
  {
    id: 'w2',
    module_id: 'mA',
    subgroup_id: null,
    title: 'Refresher part two',
    duration_seconds: 1800,
    published: 'published',
    unlock_mode: 'sequential',
    add_staff: 'auto',
    description: [],
    chapters: [{ id: 'w2ch1', at: 0, title: 'Part two' }],
    thumbnail_chapter: 0,
    attachments: [],
    position: 2,
    video_source: null,
  },
  {
    id: 'wD',
    module_id: 'mD',
    subgroup_id: null,
    title: 'Draft course video',
    duration_seconds: 300,
    published: 'published',
    unlock_mode: 'sequential',
    add_staff: 'auto',
    description: [],
    chapters: [],
    thumbnail_chapter: 0,
    attachments: [],
    position: 1,
    video_source: null,
  },
];

const viewerRows: mobile.TrainingViewerRow[] = [
  {
    id: 'viewA',
    name: 'Ada Lane',
    email: 'ada@office.demo',
    phone: '555-0101',
    account_id: 'acct-1',
    staff_of_viewer_id: null,
    auth_user_id: null,
    location: 'Austin, TX',
    first_seen_at: '2026-05-01T00:00:00Z',
    last_seen_at: '2026-08-20T10:00:00Z',
    sessions: 24,
  },
  {
    id: 'viewB',
    name: 'Bo Reyes',
    email: 'bo@office.demo',
    phone: '555-0102',
    account_id: 'acct-1',
    staff_of_viewer_id: 'viewA',
    auth_user_id: null,
    location: 'Austin, TX',
    first_seen_at: '2026-06-01T00:00:00Z',
    last_seen_at: '2026-08-22T10:00:00Z',
    sessions: 9,
  },
  {
    id: 'viewC',
    name: 'Cy Diaz',
    email: 'cy@office.demo',
    phone: '555-0103',
    account_id: 'acct-2',
    staff_of_viewer_id: null,
    auth_user_id: null,
    location: 'Dallas, TX',
    first_seen_at: '2026-07-01T00:00:00Z',
    last_seen_at: '2026-08-22T10:00:00Z',
    sessions: 3,
  },
  {
    id: 'viewNull',
    name: 'No Office',
    email: 'null@office.demo',
    phone: '555-0104',
    account_id: null,
    staff_of_viewer_id: null,
    auth_user_id: null,
    location: 'Nowhere',
    first_seen_at: '2026-07-15T00:00:00Z',
    last_seen_at: '2026-08-23T10:00:00Z',
    sessions: 1,
  },
];

const publishedC1 = ['v1', 'vTie', 'v2', 'v4', 'vFree', 'v5', 'v6'];

const completionRows: mobile.TrainingCompletionRow[] = [
  // viewA finished all of c1 (plus the unpublished v3 — must not count).
  ...publishedC1.map((videoId, i) => ({
    viewer_id: 'viewA',
    video_id: videoId,
    watch_seconds: 100 + i,
    first_watched_at: `2026-07-0${(i % 7) + 1}T00:00:00Z`,
    completed_at: `2026-07-1${(i % 7) + 1}T00:00:00Z`,
  })),
  {
    viewer_id: 'viewA',
    video_id: 'v3',
    watch_seconds: 500,
    first_watched_at: '2026-07-20T00:00:00Z',
    completed_at: '2026-07-21T00:00:00Z',
  },
  // viewB: two finished, one watch-only.
  {
    viewer_id: 'viewB',
    video_id: 'v1',
    watch_seconds: 590,
    first_watched_at: '2026-08-01T00:00:00Z',
    completed_at: '2026-08-02T00:00:00Z',
  },
  {
    viewer_id: 'viewB',
    video_id: 'vTie',
    watch_seconds: 300,
    first_watched_at: '2026-08-03T00:00:00Z',
    completed_at: '2026-08-04T00:00:00Z',
  },
  {
    viewer_id: 'viewB',
    video_id: 'v2',
    watch_seconds: 200,
    first_watched_at: '2026-08-05T00:00:00Z',
    completed_at: null,
  },
  // Ghost viewer not in training_viewers — roster must ignore it.
  {
    viewer_id: 'ghost',
    video_id: 'v1',
    watch_seconds: 50,
    first_watched_at: '2026-08-06T00:00:00Z',
    completed_at: '2026-08-07T00:00:00Z',
  },
];

const bundle: mobile.TrainingRowBundle = {
  courses: courseRows,
  modules: moduleRows,
  subgroups: subgroupRows,
  videos: videoRows,
};

// ---------------------------------------------------------------------------
// Section 1 — web parity
// ---------------------------------------------------------------------------

console.log('\nSection 1 — web parity (mobile lib vs web operations modules)');

const mCourses = mobile.assembleCourses(bundle);
const wCourses = webT.assembleCourses(bundle as unknown as Parameters<typeof webT.assembleCourses>[0]);
const mViewers = viewerRows.map(mobile.mapViewerRow);
const wViewers = viewerRows.map(webT.mapViewerRow as (row: mobile.TrainingViewerRow) => ReturnType<typeof webT.mapViewerRow>);
const mCompletions = completionRows.map(mobile.mapCompletionRow);
const wCompletions = completionRows.map(webT.mapCompletionRow as (row: mobile.TrainingCompletionRow) => ReturnType<typeof webT.mapCompletionRow>);
const mIndex = mobile.buildCompletionIndex(mCompletions);
const wIndex = webT.buildCompletionIndex(wCompletions as Parameters<typeof webT.buildCompletionIndex>[0]);

const mC1 = mCourses.find(c => c.id === 'c1')!;
const wC1 = wCourses.find(c => c.id === 'c1')!;
const mC2 = mCourses.find(c => c.id === 'c2')!;

check('assembleCourses: byte-identical output', () => {
  assert.equal(JSON.stringify(mCourses), JSON.stringify(wCourses));
});

check('assembleCourses: course order + sanitized junk pinned', () => {
  assert.deepEqual(
    mCourses.map(c => c.id),
    ['c1', 'c2', 'cDraft'],
  );
  const vTie = mC1.modules
    .flatMap(m => m.entries)
    .find(e => e.kind === 'video' && e.video.id === 'vTie');
  assert.ok(vTie && vTie.kind === 'video');
  assert.deepEqual(vTie.video.description, []);
  assert.deepEqual(
    vTie.video.chapters.map(ch => ({ at: ch.at, title: ch.title })),
    [
      { at: 0, title: 'Setup' },
      { at: 0, title: 'Negative time' },
      { at: 0, title: 'Chapter' },
    ],
  );
  assert.equal(vTie.video.thumbnailChapter, 0);
  assert.equal(vTie.video.addStaff, 'auto');
  assert.equal(vTie.video.attachments.length, 1);
  assert.equal(vTie.video.attachments[0]!.name, 'Attachment');
  assert.equal(vTie.video.attachments[0]!.sizeLabel, '—');
});

check('getOrderedVideos: published order, numbering, positions (both copies)', () => {
  const project = (o: { video: { id: string }; numbering: string; position: number }) => ({
    id: o.video.id,
    numbering: o.numbering,
    position: o.position,
  });
  const mOrder = mobile.getOrderedVideos(mC1, true).map(project);
  const wOrder = webT.getOrderedVideos(wC1, true).map(project);
  assert.deepEqual(mOrder, wOrder);
  assert.deepEqual(mOrder, [
    { id: 'v1', numbering: '2.1', position: 1 },
    { id: 'vTie', numbering: '2.2', position: 2 },
    { id: 'v2', numbering: '2.3.1', position: 3 },
    { id: 'v4', numbering: '2.3.3', position: 4 },
    { id: 'vFree', numbering: '2.6', position: 5 },
    { id: 'v5', numbering: '3.1.1', position: 6 },
    { id: 'v6', numbering: '3.2', position: 7 },
  ]);
});

check('getOrderedVideos: admin view (publishedOnly=false) parity', () => {
  const mAll = mobile.getOrderedVideos(mC1, false).map(o => `${o.video.id}:${o.numbering}`);
  const wAll = webT.getOrderedVideos(wC1, false).map(o => `${o.video.id}:${o.numbering}`);
  assert.deepEqual(mAll, wAll);
  assert.ok(mAll.includes('vHidden:1.1'));
  assert.equal(mAll.length, 10);
});

check('countVideos / courseDuration parity + pinned values', () => {
  for (const [mc, wc] of [[mC1, wC1] as const]) {
    assert.equal(mobile.countVideos(mc, true), webT.countVideos(wc, true));
    assert.equal(mobile.countVideos(mc, false), webT.countVideos(wc, false));
    assert.equal(mobile.courseDuration(mc, true), webT.courseDuration(wc, true));
  }
  assert.equal(mobile.countVideos(mC1, true), 7);
  assert.equal(mobile.countVideos(mC1, false), 10);
  assert.equal(mobile.courseDuration(mC1, true), 3360);
  assert.equal(mobile.formatHours(mobile.courseDuration(mC1, true)), '56m');
});

check('effectiveUnlock parity across the published order', () => {
  const mOrder = mobile.getOrderedVideos(mC1, true);
  const wOrder = webT.getOrderedVideos(wC1, true);
  const mModes = mOrder.map(o => mobile.effectiveUnlock(o));
  const wModes = wOrder.map(o => webT.effectiveUnlock(o));
  assert.deepEqual(mModes, wModes);
  assert.deepEqual(mModes, [
    'sequential',
    'sequential',
    'sequential',
    'sequential',
    'free',
    'free',
    'free',
  ]);
});

check('completion math parity (completedCount / frontier / watchSeconds)', () => {
  const mOrder = mobile.getOrderedVideos(mC1, true);
  const wOrder = webT.getOrderedVideos(wC1, true);
  for (const viewerId of ['viewA', 'viewB', 'viewC', 'ghost', 'nobody']) {
    const mMap = mobile.completionsFor(mIndex, viewerId);
    const wMap = webT.completionsFor(wIndex, viewerId);
    assert.equal(mobile.completedCount(mMap, mOrder), webT.completedCount(wMap, wOrder), `${viewerId} done`);
    assert.equal(mobile.frontierIndex(mMap, mOrder), webT.frontierIndex(wMap, wOrder), `${viewerId} frontier`);
    assert.equal(
      mobile.viewerWatchSeconds(mMap, mOrder),
      webT.viewerWatchSeconds(wMap, wOrder),
      `${viewerId} watch`,
    );
  }
  const mapA = mobile.completionsFor(mIndex, 'viewA');
  assert.equal(mobile.completedCount(mapA, mOrder), 7); // v3 row ignored
  assert.equal(mobile.frontierIndex(mapA, mOrder), 7); // everything done
  const mapB = mobile.completionsFor(mIndex, 'viewB');
  assert.equal(mobile.completedCount(mapB, mOrder), 2);
  assert.equal(mobile.frontierIndex(mapB, mOrder), 2); // v2 watch-only
  assert.equal(mobile.viewerWatchSeconds(mapB, mOrder), 590 + 300 + 200);
});

check('officeRoster parity: membership, sorting, pct', () => {
  const mOrder = mobile.getOrderedVideos(mC1, true);
  const wOrder = webT.getOrderedVideos(wC1, true);
  const project = (e: { viewer: { id: string }; done: number; total: number; pct: number; watchSeconds: number; isSelf: boolean }) => ({
    id: e.viewer.id,
    done: e.done,
    total: e.total,
    pct: e.pct,
    watch: e.watchSeconds,
    isSelf: e.isSelf,
  });
  const mRoster = mobile.officeRoster(mViewers, null, mOrder, mIndex, null).map(project);
  const wRoster = webO
    .officeRoster(
      wViewers as Parameters<typeof webO.officeRoster>[0],
      null,
      wOrder,
      wIndex as Parameters<typeof webO.officeRoster>[3],
      null,
    )
    .map(project);
  assert.deepEqual(mRoster, wRoster);
  // lastSeen desc, name tie-break (Bo/Cy share a timestamp), viewNull excluded.
  assert.deepEqual(
    mRoster.map(e => e.id),
    ['viewB', 'viewC', 'viewA'],
  );
  assert.deepEqual(
    mRoster.map(e => e.pct),
    [29, 0, 100],
  );
});

check('officeCourseStats + videoTeamDone parity + pinned values', () => {
  const mOrder = mobile.getOrderedVideos(mC1, true);
  const wOrder = webT.getOrderedVideos(wC1, true);
  const mRoster = mobile.officeRoster(mViewers, null, mOrder, mIndex, null);
  const wRoster = webO.officeRoster(
    wViewers as Parameters<typeof webO.officeRoster>[0],
    null,
    wOrder,
    wIndex as Parameters<typeof webO.officeRoster>[3],
    null,
  );
  const mStats = mobile.officeCourseStats(mRoster);
  const wStats = webO.officeCourseStats(wRoster);
  assert.deepEqual(mStats, wStats);
  assert.deepEqual(mStats, { avgPct: 43, finishers: 1 });
  for (const item of mOrder) {
    assert.equal(
      mobile.videoTeamDone(item.video.id, mRoster, mIndex),
      webO.videoTeamDone(item.video.id, wRoster, wIndex as Parameters<typeof webO.videoTeamDone>[2]),
      item.video.id,
    );
  }
  assert.equal(mobile.videoTeamDone('v1', mRoster, mIndex), 2);
  assert.equal(mobile.videoTeamDone('v6', mRoster, mIndex), 1);
});

check('office scope, self course, and teammate detail helpers match web exactly', () => {
  const mOrder = mobile.getOrderedVideos(mC1, true);
  assert.deepEqual(
    mViewers.map(viewer => mobile.isOfficeTeammate(viewer, 'acct-1', 'viewA')),
    wViewers.map(viewer => webO.isOfficeTeammate(viewer, 'acct-1', 'viewA')),
  );
  assert.deepEqual(
    mobile.officeRoster(mViewers, 'acct-1', mOrder, mIndex, 'viewA').map(row => row.viewer.id),
    ['viewA', 'viewB'],
    'a scoped office cannot include acct-2',
  );
  assert.equal(
    JSON.stringify(mobile.selfCourseState(mC1, mobile.completionsFor(mIndex, 'viewB'))),
    JSON.stringify(webO.selfCourseState(wC1, webT.completionsFor(wIndex, 'viewB'))),
  );
  const mStats = mobile.teammateStats(mViewers, 'acct-1', 'viewB', mCourses, mIndex, 'viewA');
  const wStats = webO.teammateStats(
    wViewers as Parameters<typeof webO.teammateStats>[0],
    'acct-1',
    'viewB',
    wCourses,
    wIndex as Parameters<typeof webO.teammateStats>[4],
    'viewA',
  );
  assert.equal(JSON.stringify(mStats), JSON.stringify(wStats));
  assert.equal(mobile.teammateStats(mViewers, 'acct-1', 'viewC', mCourses, mIndex, 'viewA'), null);
});

check('videoAvailability parity: demo (empty) map and partial viewer', () => {
  const mOrder = mobile.getOrderedVideos(mC1, true);
  const wOrder = webT.getOrderedVideos(wC1, true);
  const cases: [mobile.ViewerCompletionMap, ReturnType<typeof webT.completionsFor>][] = [
    [mobile.EMPTY_COMPLETION_MAP, webT.completionsFor(wIndex, 'nobody')],
    [mobile.completionsFor(mIndex, 'viewB'), webT.completionsFor(wIndex, 'viewB')],
  ];
  for (const [mMap, wMap] of cases) {
    const mFrontier = mobile.frontierIndex(mMap, mOrder);
    const wFrontier = webT.frontierIndex(wMap, wOrder);
    const mAvail = mOrder.map((item, i) => mobile.videoAvailability(mC1, item, i, mMap, mFrontier));
    const wAvail = wOrder.map((item, i) => webO.videoAvailability(wC1, item, i, wMap, wFrontier));
    assert.deepEqual(mAvail, wAvail);
  }
  // Demo persona: first sequential lesson open, free ones open, rest locked.
  const demoFrontier = mobile.frontierIndex(mobile.EMPTY_COMPLETION_MAP, mOrder);
  assert.equal(demoFrontier, 0);
  assert.deepEqual(
    mOrder.map((item, i) => mobile.videoAvailability(mC1, item, i, mobile.EMPTY_COMPLETION_MAP, demoFrontier)),
    ['available', 'locked', 'locked', 'locked', 'available', 'available', 'available'],
  );
  // Non-sequential course: everything available with an empty map.
  const mOrder2 = mobile.getOrderedVideos(mC2, true);
  const f2 = mobile.frontierIndex(mobile.EMPTY_COMPLETION_MAP, mOrder2);
  assert.deepEqual(
    mOrder2.map((item, i) => mobile.videoAvailability(mC2, item, i, mobile.EMPTY_COMPLETION_MAP, f2)),
    ['available', 'available'],
  );
});

check('lessonState parity: locked deep link, blocker, edges', () => {
  const project = (s: {
    item: { video: { id: string } } | null;
    index: number;
    availability: string;
    prev: { video: { id: string } } | null;
    next: { video: { id: string } } | null;
    prevAvailability: string | null;
    nextAvailability: string | null;
    blocker: { video: { id: string } } | null;
  }) => ({
    item: s.item?.video.id ?? null,
    index: s.index,
    availability: s.availability,
    prev: s.prev?.video.id ?? null,
    next: s.next?.video.id ?? null,
    prevAvailability: s.prevAvailability,
    nextAvailability: s.nextAvailability,
    blocker: s.blocker?.video.id ?? null,
  });
  const emptyW = webT.completionsFor(wIndex, 'nobody');
  for (const videoId of ['v1', 'vTie', 'v4', 'vFree', 'v6', 'nope']) {
    const m = project(mobile.lessonState(mC1, videoId, mobile.EMPTY_COMPLETION_MAP));
    const w = project(webO.lessonState(wC1, videoId, emptyW));
    assert.deepEqual(m, w, videoId);
  }
  const locked = mobile.lessonState(mC1, 'vTie', mobile.EMPTY_COMPLETION_MAP);
  assert.equal(locked.availability, 'locked');
  assert.equal(locked.blocker?.video.id, 'v1');
  assert.equal(locked.prev?.video.id, 'v1');
  assert.equal(locked.next?.video.id, 'v2');
  const last = mobile.lessonState(mC1, 'v6', mobile.EMPTY_COMPLETION_MAP);
  assert.equal(last.next, null);
  assert.equal(last.availability, 'available');
  const missing = mobile.lessonState(mC1, 'nope', mobile.EMPTY_COMPLETION_MAP);
  assert.equal(missing.item, null);
});

check('formatClock / formatHours / hashId parity + pinned values', () => {
  for (const s of [0, 1, 59, 60, 61, 89.6, 3599, 3600, 3661, 148500]) {
    assert.equal(mobile.formatClock(s), webT.formatClock(s), `clock ${s}`);
    assert.equal(mobile.formatHours(s), webT.formatHours(s), `hours ${s}`);
  }
  assert.equal(mobile.formatClock(0), '0:00');
  assert.equal(mobile.formatClock(89.6), '1:30');
  assert.equal(mobile.formatClock(3661), '1:01:01');
  assert.equal(mobile.formatHours(148500), '41h 15m');
  assert.equal(mobile.formatHours(5400), '1h 30m');
  assert.equal(mobile.formatHours(3540), '59m');
  for (const id of ['v1', 'vTie', 'w2', 'some-long-video-id']) {
    assert.equal(mobile.hashId(id), webT.hashId(id), `hash ${id}`);
  }
});

check('slidePaletteFor follows web hashId rotation; chapterIndexAt boundaries', () => {
  const palettes = ['cream', 'navy', 'cobalt'] as const;
  for (const id of ['v1', 'vTie', 'v5', 'w1']) {
    for (let i = 0; i < 4; i++) {
      assert.equal(mobile.slidePaletteFor(id, i), palettes[(webT.hashId(id) + i) % 3], `${id}#${i}`);
    }
  }
  const video = { chapters: [
    { id: 'a', at: 0, title: 'A' },
    { id: 'b', at: 180, title: 'B' },
    { id: 'c', at: 420, title: 'C' },
  ] };
  assert.equal(mobile.chapterIndexAt(video, 0), 0);
  assert.equal(mobile.chapterIndexAt(video, 179), 0);
  assert.equal(mobile.chapterIndexAt(video, 180), 1);
  assert.equal(mobile.chapterIndexAt(video, 420), 2);
  assert.equal(mobile.chapterIndexAt(video, 99999), 2);
  assert.equal(mobile.chapterIndexAt({ chapters: [] }, 50), 0);
});

// ---------------------------------------------------------------------------
// Section 2 — snapshot fetch against a fake PostgREST client
// ---------------------------------------------------------------------------

console.log('\nSection 2 — snapshot fetch');

type TableRows = Record<string, unknown[]>;

const tableRows: TableRows = {
  training_courses: courseRows,
  training_modules: moduleRows,
  training_subgroups: subgroupRows,
  training_videos: videoRows,
  training_viewers: viewerRows,
  training_completions: completionRows,
};

function fakeClient(rows: TableRows, failTable?: string): SupabaseClient {
  const client = {
    from(table: string) {
      return {
        select(_columns: string) {
          return {
            order(_column: string, _opts?: unknown) {
              return {
                limit(_n: number) {
                  return Promise.resolve(
                    failTable === table
                      ? { data: null, error: { message: `boom ${table}` } }
                      : { data: rows[table] ?? [], error: null },
                  );
                },
              };
            },
            eq(column: string, value: unknown) {
              return {
                maybeSingle() {
                  const row = (rows[table] ?? []).find(
                    candidate => (candidate as Record<string, unknown>)[column] === value,
                  ) ?? null;
                  return Promise.resolve({ data: row, error: failTable === table ? { message: `boom ${table}` } : null });
                },
              };
            },
          };
        },
      };
    },
  };
  return client as unknown as SupabaseClient;
}

function staffClient(rows: TableRows, calls: { name: string; args: Record<string, unknown> }[]): SupabaseClient {
  const client = fakeClient(rows) as unknown as {
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null }>;
  };
  client.rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === 'training_add_staff') {
      const viewer = {
        id: 'added-viewer',
        name: args.p_name,
        email: args.p_email,
        phone: '',
        account_id: args.p_account_id,
        staff_of_viewer_id: null,
        auth_user_id: null,
        location: '',
        first_seen_at: '2026-09-01T00:00:00Z',
        last_seen_at: '2026-09-01T00:00:00Z',
        sessions: 0,
      };
      (rows.training_viewers ??= []).push(viewer);
      return { data: { viewer }, error: null };
    }
    if (name === 'training_mark_video_complete_self') {
      const existing = (rows.training_completions ?? []).find(
        row => (row as { viewer_id: string; video_id: string }).viewer_id === 'viewA'
          && (row as { video_id: string }).video_id === args.p_video_id,
      );
      const completion = existing ?? {
        viewer_id: 'viewA', video_id: args.p_video_id, watch_seconds: 600,
        first_watched_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:00:00Z',
      };
      if (!existing) (rows.training_completions ??= []).push(completion);
      return { data: completion, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  };
  return client as unknown as SupabaseClient;
}

await checkAsync('fetchTrainingSnapshot assembles all six tables', async () => {
  const snapshot = await fetchTrainingSnapshot(fakeClient(tableRows));
  assert.equal(JSON.stringify(snapshot.courses), JSON.stringify(mCourses));
  assert.equal(snapshot.viewers.length, 4);
  assert.equal(snapshot.viewers[0]!.accountId, 'acct-1');
  assert.equal(snapshot.completions.length, completionRows.length);
  assert.equal(snapshot.completions[0]!.viewerId, 'viewA');
});

await checkAsync('fetchTrainingSnapshot surfaces a failed table as an error', async () => {
  await assert.rejects(
    () => fetchTrainingSnapshot(fakeClient(tableRows, 'training_videos')),
    /boom training_videos/,
  );
});

// ---------------------------------------------------------------------------
// Section 3 — screens under react-test-renderer
// ---------------------------------------------------------------------------

console.log('\nSection 3 — screens');

function renderWithQuery(element: React.ReactElement): { renderer: ReactTestRenderer; client: QueryClientT } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(QueryClientProvider, { client }, element));
  });
  return { renderer, client };
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  }
}

function hostsByTestID(renderer: ReactTestRenderer, testID: string): ReactTestInstance[] {
  return renderer.root.findAll(node => typeof node.type === 'string' && node.props?.testID === testID);
}

function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string): void => {
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(instance);
  // Join with '' so interpolated Text children ("Team avg ", "43", "%")
  // read back exactly as they render on screen.
  return parts.join('');
}

function press(instance: ReactTestInstance): void {
  act(() => {
    (instance.props as { onPress: () => void }).onPress();
  });
}

function cleanup(renderer: ReactTestRenderer, client: QueryClientT): void {
  act(() => renderer.unmount());
  client.clear();
  setStubSession(null);
}

await checkAsync('Training home: unconfigured state explains missing setup', async () => {
  setSupabase(null);
  const { renderer, client } = renderWithQuery(React.createElement(TrainingScreen));
  await flush(2);
  assert.equal(hostsByTestID(renderer, 'training-unconfigured').length, 1);
  assert.match(textOf(renderer.root as unknown as ReactTestInstance), /Training needs configuration/);
  assert.equal(hostsByTestID(renderer, 'training-retry').length, 0);
  cleanup(renderer, client);
});

await checkAsync('Training home: error state offers retry; retry recovers to live cards', async () => {
  setSupabase(fakeClient(tableRows, 'training_courses'));
  const { renderer, client } = renderWithQuery(React.createElement(TrainingScreen));
  await flush();
  assert.equal(hostsByTestID(renderer, 'training-error').length, 1);
  assert.match(textOf(renderer.root as unknown as ReactTestInstance), /boom training_courses/);

  setSupabase(fakeClient(tableRows));
  press(hostsByTestID(renderer, 'training-retry')[0]!);
  await flush();
  assert.equal(hostsByTestID(renderer, 'training-home-scroll').length, 1);
  assert.equal(hostsByTestID(renderer, 'training-course-card-c1').length, 1);
  assert.equal(hostsByTestID(renderer, 'training-course-card-c2').length, 1);
  assert.equal(hostsByTestID(renderer, 'training-course-card-cDraft').length, 0, 'draft hidden');
  cleanup(renderer, client);
});

await checkAsync('Training home: stats + course meta agree with web math', async () => {
  setSupabase(fakeClient(tableRows));
  const { renderer, client } = renderWithQuery(React.createElement(TrainingScreen));
  await flush();
  assert.match(textOf(hostsByTestID(renderer, 'training-stat-live')[0]!), /LIVE COURSES\s*2/);
  assert.match(textOf(hostsByTestID(renderer, 'training-stat-team')[0]!), /TEAM LEARNERS\s*3/);
  assert.match(textOf(hostsByTestID(renderer, 'training-stat-avg')[0]!), /TEAM AVG\s*43%/);
  const card = hostsByTestID(renderer, 'training-course-card-c1')[0]!;
  assert.match(textOf(card), /7 videos · 56m · Team avg 43%/);

  routerLog.length = 0;
  press(card);
  assert.deepEqual(routerLog.at(-1), { method: 'push', target: '/training-course/c1' });
  routerLog.length = 0;
  press(hostsByTestID(renderer, 'training-teammate-viewB')[0]!);
  assert.deepEqual(routerLog.at(-1), { method: 'push', target: '/training-teammate/viewB' });
  cleanup(renderer, client);
});

await checkAsync('Teammate deep link shows catalog progress and recent activity', async () => {
  setSupabase(fakeClient(tableRows));
  setSearchParams({ viewerId: 'viewB' });
  setPathname('/training-teammate/viewB');
  const { renderer, client } = renderWithQuery(React.createElement(TrainingTeammateScreen));
  await flush();
  assert.match(textOf(hostsByTestID(renderer, 'teammate-name')[0]!), /Bo Reyes/);
  const text = textOf(renderer.root as unknown as ReactTestInstance);
  assert.match(text, /22%/);
  assert.match(text, /2\/9/);
  assert.match(text, /Getting started/);
  cleanup(renderer, client);
});

await checkAsync('Provider session uses profile/lock scope, RPCs, and a separate signed-out cache', async () => {
  const rows = structuredClone(tableRows) as TableRows;
  rows.training_viewers = rows.training_viewers!.filter(row => ['viewA', 'viewB'].includes((row as { id: string }).id));
  (rows.training_viewers!.find(row => (row as { id: string }).id === 'viewA') as { auth_user_id: string }).auth_user_id = 'staff-a';
  rows.training_completions = rows.training_completions!.filter(row => (row as { viewer_id: string }).viewer_id === 'viewB');
  rows.profiles = [{ id: 'staff-a', role: 'provider_staff', provider_account_code: 'acct-1' }];
  rows.provider_account_locks = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  setStubSession('staff-a');
  setSupabase(staffClient(rows, calls));
  const { renderer, client } = renderWithQuery(React.createElement(TrainingScreen));
  await flush();
  assert.match(textOf(renderer.root as unknown as ReactTestInstance), /0% complete/);
  assert.equal(hostsByTestID(renderer, 'training-teammate-viewC').length, 0, 'RLS-shaped data stays office scoped');
  press(hostsByTestID(renderer, 'training-add-teammate')[0]!);
  const nameInput = hostsByTestID(renderer, 'training-add-name')[0]!;
  const emailInput = hostsByTestID(renderer, 'training-add-email')[0]!;
  act(() => {
    nameInput.props.onChangeText('New Teammate');
    emailInput.props.onChangeText('NEW@OFFICE.TEST');
  });
  await act(async () => {
    hostsByTestID(renderer, 'training-add-submit')[0]!.props.onPress();
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  assert.deepEqual(calls[0], {
    name: 'training_add_staff',
    args: { p_account_id: 'acct-1', p_name: 'New Teammate', p_email: 'new@office.test' },
  });
  assert.match(textOf(renderer.root as unknown as ReactTestInstance), /pre-approved.*No invite email/i);

  setSearchParams({ courseId: 'c1', videoId: 'v1' });
  setPathname('/training-lesson/c1/v1');
  const lesson = renderWithQuery(React.createElement(TrainingLessonScreen));
  await flush();
  await act(async () => {
    hostsByTestID(lesson.renderer, 'lesson-mark-complete')[0]!.props.onPress();
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  assert.deepEqual(calls[1], { name: 'training_mark_video_complete_self', args: { p_video_id: 'v1' } });
  assert.equal(
    (rows.training_completions ?? []).filter(row => (row as { viewer_id: string; video_id: string }).viewer_id === 'viewA' && (row as { video_id: string }).video_id === 'v1').length,
    1,
    'completion persists idempotently in the backing snapshot',
  );
  cleanup(lesson.renderer, lesson.client);

  const staffKeys = client.getQueryCache().getAll().map(query => JSON.stringify(query.queryKey));
  assert.ok(staffKeys.some(key => key.includes('staff-a:provider_staff:acct-1:locked=false')));
  setStubSession(null);
  act(() => renderer.update(React.createElement(QueryClientProvider, { client }, React.createElement(TrainingScreen))));
  await flush();
  const keys = client.getQueryCache().getAll().map(query => JSON.stringify(query.queryKey));
  assert.ok(keys.some(key => key.includes('anon:none::locked=false')));
  cleanup(renderer, client);
});

await checkAsync('Patient and locked provider sessions are denied before private snapshots', async () => {
  for (const [userId, profile, locked, expected] of [
    ['patient-1', { id: 'patient-1', role: 'patient', provider_account_code: null }, [], /private to signed-in provider staff/i],
    ['staff-locked', { id: 'staff-locked', role: 'provider_staff', provider_account_code: 'acct-1' }, [{ account_id: 'acct-1' }], /office is locked/i],
  ] as const) {
    const rows = structuredClone(tableRows) as TableRows;
    rows.profiles = [profile];
    rows.provider_account_locks = locked;
    setStubSession(userId);
    setSupabase(staffClient(rows, []));
    const { renderer, client } = renderWithQuery(React.createElement(TrainingScreen));
    await flush();
    assert.equal(hostsByTestID(renderer, 'training-error').length, 1, userId);
    assert.match(textOf(renderer.root as unknown as ReactTestInstance), expected);
    assert.equal(
      client.getQueryCache().getAll().filter(query => String(query.queryKey[0]) === 'mobile-training-data').length,
      1,
      'the disabled scoped query is registered but never fetched',
    );
    cleanup(renderer, client);
  }
});

await checkAsync('Course outline: rows, module headers, lock presentation, team counts', async () => {
  setSupabase(fakeClient(tableRows));
  setSearchParams({ id: 'c1' });
  setPathname('/training-course/c1');
  const { renderer, client } = renderWithQuery(React.createElement(TrainingCourseScreen));
  await flush();

  const rows = publishedC1.map(id => hostsByTestID(renderer, `course-row-${id}`));
  for (const found of rows) assert.equal(found.length, 1);
  assert.equal(hostsByTestID(renderer, 'course-row-v3').length, 0, 'draft lesson hidden');
  assert.equal(hostsByTestID(renderer, 'course-row-vHidden').length, 0, 'draft module hidden');

  const outlineText = textOf(hostsByTestID(renderer, 'course-outline-scroll')[0]!);
  assert.match(outlineText, /CORE PROTOCOL/);
  assert.match(outlineText, /FRONT DESK PLAYBOOK/);
  assert.match(outlineText, /2\.3\.1/);
  assert.match(outlineText, /3\.1\.1/);
  assert.match(outlineText, /Consult Room ·/); // subgroup tag on its lessons
  assert.match(outlineText, /2\/3 on your team finished/); // v1 team count
  assert.match(outlineText, /7 videos/);
  assert.match(outlineText, /56m/);
  assert.match(outlineText, /Team avg 43%/);

  const lockedRow = hostsByTestID(renderer, 'course-row-vTie')[0]!;
  assert.match(String(lockedRow.props.accessibilityLabel), /locked/);
  const openRow = hostsByTestID(renderer, 'course-row-v1')[0]!;
  assert.doesNotMatch(String(openRow.props.accessibilityLabel), /locked/);
  const freeRow = hostsByTestID(renderer, 'course-row-vFree')[0]!;
  assert.doesNotMatch(String(freeRow.props.accessibilityLabel), /locked/);

  routerLog.length = 0;
  press(lockedRow);
  assert.deepEqual(routerLog.at(-1), { method: 'push', target: '/training-lesson/c1/vTie' });
  cleanup(renderer, client);
});

await checkAsync('Course outline: draft/unknown course shows the unavailable card', async () => {
  setSupabase(fakeClient(tableRows));
  for (const id of ['cDraft', 'missing-course']) {
    setSearchParams({ id });
    setPathname(`/training-course/${id}`);
    const { renderer, client } = renderWithQuery(React.createElement(TrainingCourseScreen));
    await flush();
    assert.equal(hostsByTestID(renderer, 'course-unavailable').length, 1, id);
    assert.match(textOf(renderer.root as unknown as ReactTestInstance), /This course isn't available/);
    cleanup(renderer, client);
  }
});

await checkAsync('Lesson page: slide frame, chapter stepping, attachments, locked next', async () => {
  setSupabase(fakeClient(tableRows));
  setSearchParams({ courseId: 'c1', videoId: 'v1' });
  setPathname('/training-lesson/c1/v1');
  const { renderer, client } = renderWithQuery(React.createElement(TrainingLessonScreen));
  await flush();

  assert.equal(hostsByTestID(renderer, 'lesson-scroll').length, 1);
  const pageText = textOf(hostsByTestID(renderer, 'lesson-scroll')[0]!);
  assert.match(pageText, /2\.1 Getting started/);
  assert.match(pageText, /Lesson 1 of 7/);
  assert.match(pageText, /10:00/); // 600s duration chip
  assert.match(pageText, /First paragraph\./);
  assert.match(pageText, /Second paragraph\./);
  assert.match(pageText, /Intake checklist\.pdf/);
  assert.match(pageText, /NO FILE YET/);
  assert.match(pageText, /Simulated player/);
  assert.match(pageText, /Start of course/); // no previous lesson

  const frameBefore = textOf(hostsByTestID(renderer, 'slide-frame')[0]!);
  assert.match(frameBefore, /Welcome/);
  assert.match(frameBefore, /01 \/ 03/);

  press(hostsByTestID(renderer, 'chapter-row-1')[0]!);
  const frameAfter = textOf(hostsByTestID(renderer, 'slide-frame')[0]!);
  assert.match(frameAfter, /Protocol basics/);
  assert.match(frameAfter, /02 \/ 03/);

  const lockedNext = hostsByTestID(renderer, 'lesson-next-locked');
  assert.equal(lockedNext.length, 1);
  assert.match(textOf(lockedNext[0]!), /Locked until the lessons before it are complete/);
  assert.equal(hostsByTestID(renderer, 'lesson-next').length, 0, 'locked next is not pressable');
  cleanup(renderer, client);
});

await checkAsync('Lesson page: free lesson navigates prev/next among unlocked lessons', async () => {
  setSupabase(fakeClient(tableRows));
  setSearchParams({ courseId: 'c1', videoId: 'v5' });
  setPathname('/training-lesson/c1/v5');
  const { renderer, client } = renderWithQuery(React.createElement(TrainingLessonScreen));
  await flush();
  // v5 (3.1.1) — prev vFree is free/available, next v6 free/available.
  const prev = hostsByTestID(renderer, 'lesson-prev');
  const next = hostsByTestID(renderer, 'lesson-next');
  assert.equal(prev.length, 1);
  assert.equal(next.length, 1);
  routerLog.length = 0;
  press(next[0]!);
  assert.deepEqual(routerLog.at(-1), { method: 'replace', target: '/training-lesson/c1/v6' });
  cleanup(renderer, client);
});

await checkAsync('Lesson page: locked deep link explains the blocker instead of opening', async () => {
  setSupabase(fakeClient(tableRows));
  setSearchParams({ courseId: 'c1', videoId: 'v4' });
  setPathname('/training-lesson/c1/v4');
  const { renderer, client } = renderWithQuery(React.createElement(TrainingLessonScreen));
  await flush();
  assert.equal(hostsByTestID(renderer, 'lesson-locked').length, 1);
  assert.equal(hostsByTestID(renderer, 'lesson-scroll').length, 0, 'content not rendered');
  const text = textOf(renderer.root as unknown as ReactTestInstance);
  assert.match(text, /unlock in order/);
  assert.match(text, /Getting started/); // blocker title (frontier lesson)
  assert.match(text, /\(2\.1\)/); // blocker numbering
  routerLog.length = 0;
  press(hostsByTestID(renderer, 'lesson-open-blocker')[0]!);
  assert.deepEqual(routerLog.at(-1), { method: 'replace', target: '/training-lesson/c1/v1' });
  cleanup(renderer, client);
});

await checkAsync('Lesson page: unknown/unpublished lesson shows unavailable card', async () => {
  setSupabase(fakeClient(tableRows));
  for (const videoId of ['nope', 'v3']) {
    setSearchParams({ courseId: 'c1', videoId });
    setPathname(`/training-lesson/c1/${videoId}`);
    const { renderer, client } = renderWithQuery(React.createElement(TrainingLessonScreen));
    await flush();
    assert.equal(hostsByTestID(renderer, 'lesson-unavailable').length, 1, videoId);
    cleanup(renderer, client);
  }
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error('Failed checks:');
  for (const name of failures) console.error(`  - ${name}`);
  process.exit(1);
}
process.exit(0);
