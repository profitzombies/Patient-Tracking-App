/**
 * Accessibility invariants for the office Training click targets.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:training
 *   (chained after scripts/verify-training.ts)
 *
 * Renders the REAL OfficeTraining and OfficeTeammate pages with
 * react-test-renderer under Node (context modules remapped to stubs via
 * tsconfig.a11y.json) and asserts the semantics behind "clickable cards and
 * roster rows":
 *
 *   - every reachable navigation target is a NATIVE anchor with an href —
 *     link semantics for assistive tech and native Enter activation — never
 *     a focusable div/tr with key handlers;
 *   - exactly one tab stop per course card and per roster row (no duplicate
 *     stops, nothing removed from the tab order that AT would need);
 *   - containers stay semantically inert: no tabIndex/role/aria-label on the
 *     card div or the tr; the row's onClick is pointer-only convenience;
 *   - accessible names identify the destination (course title, "Open
 *     <name>'s training stats");
 *   - the teammate page is read-only: links only, zero buttons.
 *
 * Section 4 renders the REAL admin VideoEditor and pins the media card's
 * click-or-drop contract: click-to-browse and drop live on the same outer
 * surface (notice box included, both the no-file and video-on-file states),
 * the inner panel carries no second handler, and clicks bubbling from the
 * Browse button or the hidden input are skipped (no double chooser).
 */
// Namespace import: tsx compiles this script's JSX with the classic
// React.createElement transform, so React must be in scope.
import * as React from 'react';
import { act } from 'react';
import type { ReactElement } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { assembleCourses, buildCompletionIndex, findVideoInCourse } from '../src/data/hq/training';
import type { TrainingCompletion, TrainingCourse } from '../src/data/hq/training';
import { __setTrainingData } from './a11y-stubs/training-data';
import { __setSession } from './a11y-stubs/session';
import OfficeTraining from '../src/pages/OfficeTraining';
import OfficeTeammate from '../src/pages/OfficeTeammate';
import VideoEditor from '../src/pages/admin/training/VideoEditor';

// Tell React this process intends to use act() (silences the environment warning).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture: two live courses, a two-person office roster (self + teammate).
// ---------------------------------------------------------------------------

const videoRow = (id: string, moduleId: string, position: number): any => ({
  id,
  module_id: moduleId,
  subgroup_id: null,
  title: id.toUpperCase(),
  duration_seconds: 120,
  published: 'published',
  unlock_mode: 'sequential',
  add_staff: 'auto',
  description: [],
  chapters: [],
  thumbnail_chapter: 0,
  attachments: [],
  position,
  video_source: null,
});

const courseRows = [
  { id: 'axa', slug: 'axa', title: 'Anchor Course Alpha', description: 'First live course.', status: 'live', sequential_unlock: true, created_at: '2026-08-01T00:00:00Z' },
  { id: 'axb', slug: 'axb', title: 'Anchor Course Beta', description: 'Second live course.', status: 'live', sequential_unlock: false, created_at: '2026-08-02T00:00:00Z' },
] as any;
const moduleRows = [
  { id: 'axam', course_id: 'axa', title: 'A M1', published: 'published', unlock_mode: 'sequential', position: 0 },
  { id: 'axbm', course_id: 'axb', title: 'B M1', published: 'published', unlock_mode: 'sequential', position: 0 },
] as any;
const baseVideoRows = [videoRow('ax1', 'axam', 0), videoRow('ax2', 'axam', 1), videoRow('bx1', 'axbm', 0)];

const courses = assembleCourses({
  courses: courseRows,
  modules: moduleRows,
  subgroups: [],
  videos: baseVideoRows,
});

const viewer = (id: string, name: string): any => ({
  id,
  name,
  email: `${id}@office.test`,
  phone: '—',
  accountId: 'acct-p1',
  staffOfViewerId: null,
  authUserId: null,
  location: '—',
  firstSeenAt: '2026-08-01T00:00:00Z',
  lastSeenAt: '2026-08-20T00:00:00Z',
  sessions: 3,
});
const viewers = [viewer('selfv', 'Dana Reyes'), viewer('tmv', 'Maria Delgado')];

const row = (viewerId: string, videoId: string, completedAt: string | null): TrainingCompletion => ({
  viewerId,
  videoId,
  watchSeconds: 90,
  firstWatchedAt: '2026-08-01T00:00:00Z',
  completedAt,
});
const completionIndex = buildCompletionIndex([row('tmv', 'ax1', '2026-08-05T00:00:00Z'), row('selfv', 'ax1', null)]);

/** Full context snapshot for a given course set — the pages of sections 1-3
 * only read courses/completions, but the admin VideoEditor (section 4) also
 * calls locateVideo and destructures the write helpers. */
function trainingSnapshot(courseSet: TrainingCourse[]) {
  return {
    status: 'ready',
    courses: courseSet,
    viewers,
    completionIndex,
    completions: [] as TrainingCompletion[],
    myViewer: viewers[0],
    locateVideo: (courseId: string | undefined, videoId: string | undefined) => {
      const course = courseSet.find((c) => c.id === courseId);
      if (!course || !videoId) return null;
      return findVideoInCourse(course, videoId);
    },
    updateVideo: async () => false,
    moveVideoToContainer: async () => false,
    removeVideo: async () => false,
  };
}

__setTrainingData(trainingSnapshot(courses));
// Signed-in provider staff — exercises the scoped roster including the You row.
__setSession({ authStatus: 'signed-in', authRole: 'provider_staff', providerAccountCode: 'acct-p1' });

// ---------------------------------------------------------------------------
// Render helpers.
// ---------------------------------------------------------------------------

async function renderAt(
  path: string,
  element: ReactElement,
  createNodeMock?: (element: any) => any,
): Promise<ReactTestRenderer> {
  const { hook } = memoryLocation({ path, static: true });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<Router hook={hook}>{element}</Router>, createNodeMock ? { createNodeMock } : undefined);
  });
  return renderer!;
}

const isHost = (node: ReactTestInstance) => typeof node.type === 'string';
const byTestId = (root: ReactTestInstance, re: RegExp) =>
  root.findAll((n) => isHost(n) && typeof n.props['data-testid'] === 'string' && re.test(n.props['data-testid']));
const anchorsIn = (node: ReactTestInstance) => node.findAll((n) => n.type === 'a');
const tabStopsIn = (node: ReactTestInstance) => anchorsIn(node).filter((a) => a.props.tabIndex !== -1);
function textOf(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map((child) => textOf(child as ReactTestInstance | string)).join('');
}

async function main() {
  console.log('Training a11y invariants: native link semantics on every click target\n');

  // -------------------------------------------------------------------------
  console.log('1. Course cards are stretched-link cards — one native anchor each');
  const training = await renderAt('/training', <OfficeTraining />);
  const trainingRoot = training.root;
  const cards = byTestId(trainingRoot, /^card-course-/);
  check('both live-course cards render', cards.length === 2, `got ${cards.length}`);
  for (const card of cards) {
    const id = String(card.props['data-testid']).replace('card-course-', '');
    const course = courses.find((c) => c.id === id)!;
    check(`card ${id}: container is a semantically inert div`,
      card.type === 'div' &&
        card.props.tabIndex === undefined &&
        card.props.role === undefined &&
        card.props['aria-label'] === undefined &&
        card.props.onClick === undefined &&
        card.props.onKeyDown === undefined);
    const anchors = anchorsIn(card);
    const stops = tabStopsIn(card);
    check(`card ${id}: exactly one anchor, in the tab order`, anchors.length === 1 && stops.length === 1,
      `anchors=${anchors.length} stops=${stops.length}`);
    const link = stops[0]!;
    check(`card ${id}: anchor has an href (native Enter/middle-click)`, link.props.href === `/training/${id}`,
      `href=${String(link.props.href)}`);
    check(`card ${id}: accessible name is the course title`, textOf(link).trim() === course.title,
      `name=${textOf(link).trim()}`);
    const openAffordance = card.findAll(
      (n) => n.type === 'span' && n.props['aria-hidden'] === 'true' && textOf(n).startsWith('Open'),
    );
    check(`card ${id}: "Open" affordance is decorative (aria-hidden, not an anchor)`, openAffordance.length === 1);
  }

  // -------------------------------------------------------------------------
  console.log('2. Roster rows expose one announced link each; the tr stays a tr');
  const rows = byTestId(trainingRoot, /^row-team-/);
  check('both roster rows render (self + teammate)', rows.length === 2, `got ${rows.length}`);
  for (const tr of rows) {
    const vid = String(tr.props['data-testid']).replace('row-team-', '');
    const person = viewers.find((v) => v.id === vid)!;
    check(`row ${vid}: tr carries no interactive fakery`,
      tr.type === 'tr' &&
        tr.props.tabIndex === undefined &&
        tr.props.role === undefined &&
        tr.props['aria-label'] === undefined &&
        tr.props.onKeyDown === undefined);
    check(`row ${vid}: row click is pointer-only convenience (handler present)`, typeof tr.props.onClick === 'function');
    const anchors = anchorsIn(tr);
    const stops = tabStopsIn(tr);
    check(`row ${vid}: exactly one anchor, in the tab order`, anchors.length === 1 && stops.length === 1,
      `anchors=${anchors.length} stops=${stops.length}`);
    const link = stops[0]!;
    check(`row ${vid}: anchor has the teammate href`, link.props.href === `/training/team/${vid}`,
      `href=${String(link.props.href)}`);
    const label = String(link.props['aria-label'] ?? '');
    check(`row ${vid}: anchor announces the destination by name`,
      label.includes(person.name) && label.includes('training stats'), `label=${label}`);
  }

  // -------------------------------------------------------------------------
  console.log('3. Teammate page: links only, read-only, back link in tab order');
  const teammate = await renderAt('/training/team/tmv', <OfficeTeammate params={{ viewerId: 'tmv' }} />);
  const teammateRoot = teammate.root;
  const name = byTestId(teammateRoot, /^text-teammate-name$/);
  check('teammate stats resolved (name rendered)', name.length === 1 && textOf(name[0]!).trim() === 'Maria Delgado');
  const back = byTestId(teammateRoot, /^link-back-to-training$/);
  check('back link is a native anchor in the tab order',
    back.length === 1 && back[0]!.type === 'a' && back[0]!.props.href === '/training' && back[0]!.props.tabIndex !== -1);
  const courseLinks = byTestId(teammateRoot, /^link-teammate-course-/);
  check('per-course rows are native anchors to the course outlines',
    courseLinks.length === 2 &&
      courseLinks.every(
        (a) => a.type === 'a' && a.props.tabIndex !== -1 &&
          String(a.props.href) === `/training/${String(a.props['data-testid']).replace('link-teammate-course-', '')}`,
      ));
  const buttons = teammateRoot.findAll((n) => n.type === 'button');
  check('teammate page adds no write actions (zero buttons)', buttons.length === 0, `buttons=${buttons.length}`);

  training.unmount();
  teammate.unmount();

  // -------------------------------------------------------------------------
  console.log('4. Video editor media card is one click-or-drop surface');

  // The editor touches window in mount effects (drag-swallow listeners) and
  // its media hook fetches signed playback URLs; neither exists under Node.
  // Give the render a minimal window and a fetch that never settles — these
  // checks pin wiring, not network behavior.
  const g = globalThis as any;
  g.window ??= {};
  g.window.addEventListener ??= () => {};
  g.window.removeEventListener ??= () => {};
  g.window.setInterval ??= (fn: any, ms?: any) => setInterval(fn, ms);
  g.window.clearInterval ??= (t: any) => clearInterval(t);
  g.window.setTimeout ??= (fn: any, ms?: any) => setTimeout(fn, ms);
  g.window.clearTimeout ??= (t: any) => clearTimeout(t);
  g.window.confirm ??= () => false;
  const realFetch = g.fetch;
  g.fetch = () => new Promise(() => {});

  let videoInputClicks = 0;
  const nodeMock = (element: any) => {
    if (element?.props?.['data-testid'] === 'input-video-file') {
      return { click: () => { videoInputClicks += 1; } };
    }
    return {
      click: () => {}, focus: () => {}, blur: () => {},
      play: () => Promise.resolve(), pause: () => {}, load: () => {},
      addEventListener: () => {}, removeEventListener: () => {},
      scrollIntoView: () => {},
    };
  };

  // Synthetic click origins: closest() is how the handler tells an inert
  // portion of the card from the Browse button / hidden input inside it.
  const clickFromCard = { target: { closest: () => null } } as any;
  const clickFromControl = { target: { closest: () => ({}) } } as any;

  async function checkMediaCard(label: string, path: string, noticeTestId: string) {
    const editor = await renderAt(path, <VideoEditor />, nodeMock);
    const area = byTestId(editor.root, /^area-video-dropzone$/);
    check(`${label}: media card renders its drop target`, area.length === 1, `got ${area.length}`);
    if (area.length !== 1) { editor.unmount(); return; }
    const card = area[0]!;
    check(`${label}: click-to-browse and drop live on the SAME outer surface`,
      typeof card.props.onClick === 'function' && typeof card.props.onDrop === 'function');
    check(`${label}: surface stays semantically inert (Browse button is the keyboard path)`,
      card.props.tabIndex === undefined && card.props.role === undefined && card.props.onKeyDown === undefined);
    check(`${label}: the ${noticeTestId} portion sits inside the click-or-drop surface`,
      byTestId(card, new RegExp(`^${noticeTestId}$`)).length === 1);
    const inner = byTestId(card, /^dropzone-video-upload$/);
    check(`${label}: inner upload panel carries no second click handler`,
      inner.length === 1 && inner[0]!.props.onClick === undefined);
    check(`${label}: hidden file input lives inside the surface`,
      byTestId(card, /^input-video-file$/).length === 1);
    const browse = byTestId(card, /^button-browse-video$/);
    check(`${label}: Browse button present for keyboard/AT`,
      browse.length === 1 && browse[0]!.type === 'button' && typeof browse[0]!.props.onClick === 'function');
    const before = videoInputClicks;
    await act(async () => { card.props.onClick(clickFromCard); });
    check(`${label}: clicking the card (notice included) opens the file chooser`,
      videoInputClicks === before + 1, `clicks ${before} -> ${videoInputClicks}`);
    await act(async () => { card.props.onClick(clickFromControl); });
    check(`${label}: clicks bubbling from the Browse button / hidden input are skipped`,
      videoInputClicks === before + 1, `clicks ended at ${videoInputClicks}`);
    editor.unmount();
  }

  await checkMediaCard('no file yet', '/admin/training/courses/axa/videos/ax1', 'notice-no-video-file');

  // Same card with a hosted file: the "Video on file" notice must be just as
  // clickable — this is the exact surface a replace flow starts from.
  const hostedVideos = baseVideoRows.map((v: any) =>
    v.id === 'bx1' ? { ...v, video_source: '/objects/training-videos/bx1/video.webm' } : v,
  );
  __setTrainingData(trainingSnapshot(
    assembleCourses({ courses: courseRows, modules: moduleRows, subgroups: [], videos: hostedVideos }),
  ));
  await checkMediaCard('video on file', '/admin/training/courses/axb/videos/bx1', 'notice-video-on-file');

  g.fetch = realFetch;

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll training a11y invariants hold.');
}

void main();
