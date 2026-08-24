/**
 * Training-portal authoring + progress invariants.
 *
 * Viewer progress is a SET of completed video ids; every count is derived
 * against the CURRENT published order. This suite pins the properties that
 * keep the numbers truthful through every authoring mutation:
 *
 *   1. New courses/videos are built as PURE values before setState.
 *   2. Unlock resolves through the hierarchy (course → module → sub-group →
 *      video), so the editor's module/sub-group unlock controls are real.
 *   3. Completing a video credits exactly that video — never skipped ones.
 *   4. Reordering and moving videos never change anyone's counts.
 *   5. Unpublish→republish is a perfect analytics round-trip.
 *   6. Deleting mid-course content never mints finishers.
 *   7. The seeded demo reproduces the approved headline figures exactly.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:training
 */
import {
  SEEDED_COURSES,
  SEEDED_VIEWERS,
  FLAGSHIP_COURSE_ID,
  collectIds,
  buildNewCourse,
  buildNewModule,
  buildNewVideo,
  completedCount,
  frontierIndex,
  isVideoCompletedBy,
  viewerStartedVideo,
  effectiveUnlock,
  getOrderedVideos,
  getCourseAnalytics,
  getTrainingTotals,
  formatHours,
  type TrainingCourse,
  type TrainingViewer,
  type TrainingVideo,
} from '../src/data/hq/training';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const flagship = SEEDED_COURSES.find((course) => course.id === FLAGSHIP_COURSE_ID)!;
const order = getOrderedVideos(flagship, true);
const n = order.length;

// --- Structural mutation helpers (mirror the context's pure updates) --------
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const stripVideo = (course: TrainingCourse, videoId: string): TrainingCourse => ({
  ...course,
  modules: course.modules.map((module) => ({
    ...module,
    entries: module.entries
      .filter((entry) => !(entry.kind === 'video' && entry.video.id === videoId))
      .map((entry) =>
        entry.kind === 'subgroup'
          ? { kind: 'subgroup' as const, subgroup: { ...entry.subgroup, videos: entry.subgroup.videos.filter((v) => v.id !== videoId) } }
          : entry,
      ),
  })),
});
const mapVideos = (course: TrainingCourse, fn: (video: TrainingVideo) => TrainingVideo): TrainingCourse => ({
  ...course,
  modules: course.modules.map((module) => ({
    ...module,
    entries: module.entries.map((entry) =>
      entry.kind === 'video'
        ? { ...entry, video: fn(entry.video) }
        : { ...entry, subgroup: { ...entry.subgroup, videos: entry.subgroup.videos.map(fn) } },
    ),
  })),
});
const analyticsSignature = (course: TrainingCourse, viewers: TrainingViewer[]) => {
  const a = getCourseAnalytics(course, viewers);
  return JSON.stringify({
    population: a.population,
    avgCompletionPct: a.avgCompletionPct,
    finished: a.finished,
    totalWatchSeconds: a.totalWatchSeconds,
    perVideo: a.stats.map((s) => [s.video.id, s.completedCount, s.started]),
  });
};

console.log('1. Course/video builders are pure, unique, immediately usable');
{
  const courseA = buildNewCourse(SEEDED_COURSES, { title: 'QA — Front Desk Refresher!', description: 'd' });
  check('new course id unused', !collectIds(SEEDED_COURSES).has(courseA.id), courseA.id);
  check('new course usable', courseA.title === 'QA — Front Desk Refresher!' && courseA.modules.length === 1 && courseA.modules[0]!.entries.length === 0);
  check('new course slug clean', /^[a-z0-9-]+$/.test(courseA.slug), courseA.slug);
  const courseB = buildNewCourse([...SEEDED_COURSES, courseA], { title: 'Another', description: 'd' });
  check('second course id differs', courseB.id !== courseA.id, `${courseA.id} vs ${courseB.id}`);

  const videoA = buildNewVideo(SEEDED_COURSES, 'Greeting walk-ins');
  check('new video id unused', !collectIds(SEEDED_COURSES).has(videoA.id), videoA.id);
  check('new video usable', videoA.title === 'Greeting walk-ins' && videoA.duration >= 180 && videoA.duration < 480 && videoA.published === 'draft');
  check(
    'new video chapters well-formed',
    videoA.chapters.length === 4 &&
      videoA.chapters.every((ch, i) => ch.at >= 0 && ch.at < videoA.duration && (i === 0 || ch.at > videoA.chapters[i - 1]!.at)),
  );
  const withVideo = SEEDED_COURSES.map((course) =>
    course.id !== flagship.id
      ? course
      : { ...course, modules: course.modules.map((m, i) => (i !== 0 ? m : { ...m, entries: [...m.entries, { kind: 'video' as const, video: videoA }] })) },
  );
  const videoB = buildNewVideo(withVideo, 'Greeting walk-ins');
  check('second video id differs', videoB.id !== videoA.id, `${videoA.id} vs ${videoB.id}`);

  const moduleA = buildNewModule(SEEDED_COURSES, 'Advanced Reporting');
  check('new module id unused', !collectIds(SEEDED_COURSES).has(moduleA.id), moduleA.id);
  check(
    'new module usable',
    moduleA.title === 'Advanced Reporting' && moduleA.published === 'published' &&
      moduleA.unlock === 'sequential' && moduleA.entries.length === 0,
    JSON.stringify(moduleA),
  );
  const modHost = SEEDED_COURSES.find((c) => c.id === FLAGSHIP_COURSE_ID)!;
  const withModule = { ...modHost, modules: [...modHost.modules, moduleA] };
  check(
    'empty module publishes nothing new',
    getOrderedVideos(withModule).length === getOrderedVideos(modHost).length,
    `${getOrderedVideos(withModule).length} vs ${getOrderedVideos(modHost).length}`,
  );
  const moduleB = buildNewModule(
    [...SEEDED_COURSES.filter((c) => c.id !== modHost.id), withModule],
    'Second module',
  );
  check('second module id differs', moduleB.id !== moduleA.id, `${moduleA.id} vs ${moduleB.id}`);
}

console.log('2. Unlock resolves through the hierarchy (module/sub-group controls are real)');
{
  const mk = (id: string, unlock: 'sequential' | 'free'): TrainingVideo => ({
    id,
    title: id,
    duration: 200,
    published: 'published',
    unlock,
    addStaff: 'hide',
    description: [],
    chapters: [],
    thumbnailChapter: 0,
    attachments: [],
  });
  const course: TrainingCourse = {
    id: 'qa-unlock',
    slug: 'qa-unlock',
    title: 'Unlock QA',
    description: '',
    status: 'published',
    sequentialUnlock: true,
    createdKey: '2026-08-22',
    modules: [
      {
        id: 'qa-m1',
        title: 'M1',
        published: 'published',
        unlock: 'sequential',
        entries: [
          { kind: 'video', video: mk('qa-v-seq', 'sequential') },
          { kind: 'video', video: mk('qa-v-free', 'free') },
          { kind: 'subgroup', subgroup: { id: 'qa-sg', title: 'SG', published: 'published', unlock: 'free', videos: [mk('qa-v-in-free-sg', 'sequential')] } },
        ],
      },
      {
        id: 'qa-m2',
        title: 'M2',
        published: 'published',
        unlock: 'free',
        entries: [{ kind: 'video', video: mk('qa-v-in-free-module', 'sequential') }],
      },
    ],
  };
  const ordered = getOrderedVideos(course, true);
  const modeOf = (id: string) => effectiveUnlock(ordered.find((item) => item.video.id === id)!);
  check('plain sequential video stays sequential', modeOf('qa-v-seq') === 'sequential');
  check('video-level free wins', modeOf('qa-v-free') === 'free');
  check('free sub-group frees its videos', modeOf('qa-v-in-free-sg') === 'free');
  check('free module frees its videos', modeOf('qa-v-in-free-module') === 'free');
}

console.log('3. Completion credits exactly the watched video');
{
  const partial = SEEDED_VIEWERS.find((viewer) => viewer.startedExtra === 1)!;
  const done = completedCount(partial, order);
  check('frontier sits at the first gap', frontierIndex(partial, order) === done, `${frontierIndex(partial, order)} vs ${done}`);
  check('startedExtra marks only the frontier video', viewerStartedVideo(partial, order, done) && !viewerStartedVideo(partial, order, done + 1));

  // Complete a free-style video far ahead of the frontier.
  const aheadId = order[done + 5]!.video.id;
  const after: TrainingViewer = { ...partial, completedVideoIds: [...partial.completedVideoIds, aheadId] };
  check('count grows by exactly one', completedCount(after, order) === done + 1);
  check('frontier does not move (skipped videos uncredited)', frontierIndex(after, order) === done);
  check('skipped video stays uncompleted', !isVideoCompletedBy(after, order[done + 1]!.video.id));
  check('idempotent re-completion', completedCount({ ...after, completedVideoIds: [...after.completedVideoIds] }, order) === done + 1);
}

console.log('4. Reordering / moving videos never changes progress');
{
  const before = analyticsSignature(flagship, SEEDED_VIEWERS);
  const perViewerBefore = SEEDED_VIEWERS.map((viewer) => completedCount(viewer, order));

  // Swap the first two plain-video entries of module 1.
  const swapped = clone(flagship);
  const m1 = swapped.modules[0]!;
  const vi = m1.entries.map((entry, i) => (entry.kind === 'video' ? i : -1)).filter((i) => i >= 0);
  check('module 1 has two swappable videos', vi.length >= 2);
  [m1.entries[vi[0]!], m1.entries[vi[1]!]] = [m1.entries[vi[1]!]!, m1.entries[vi[0]!]!];
  const swappedOrder = getOrderedVideos(swapped, true);
  check('swap changed the order', swappedOrder[vi[0]!]!.video.id !== order[vi[0]!]!.video.id);
  check(
    'per-viewer counts unchanged by reorder',
    SEEDED_VIEWERS.every((viewer, i) => completedCount(viewer, swappedOrder) === perViewerBefore[i]),
  );
  const swappedAnalytics = getCourseAnalytics(swapped, SEEDED_VIEWERS);
  const baseAnalytics = getCourseAnalytics(flagship, SEEDED_VIEWERS);
  check('population/finished unchanged by reorder', swappedAnalytics.population === baseAnalytics.population && swappedAnalytics.finished === baseAnalytics.finished);
  const statFor = (course: TrainingCourse, id: string) => getCourseAnalytics(course, SEEDED_VIEWERS).stats.find((s) => s.video.id === id)!;
  const movedId = order[vi[0]!]!.video.id;
  check('per-video completion follows the video, not the slot', statFor(swapped, movedId).completedCount === statFor(flagship, movedId).completedCount);

  // Move a module-1 video into module 2 (cross-container move).
  const moved = clone(flagship);
  const src = moved.modules[0]!;
  const idx = src.entries.findIndex((entry) => entry.kind === 'video');
  const [entry] = src.entries.splice(idx, 1);
  moved.modules[1]!.entries.push(entry!);
  const movedOrder = getOrderedVideos(moved, true);
  check('move preserved the published set', movedOrder.length === n);
  check(
    'per-viewer counts unchanged by cross-container move',
    SEEDED_VIEWERS.every((viewer, i) => completedCount(viewer, movedOrder) === perViewerBefore[i]),
  );
  check('flagship untouched by simulations', analyticsSignature(flagship, SEEDED_VIEWERS) === before);
}

console.log('5. Unpublish → republish is a perfect analytics round-trip');
{
  const target = order[3]!.video.id;
  const before = analyticsSignature(flagship, SEEDED_VIEWERS);
  const unpublished = mapVideos(flagship, (video) => (video.id === target ? { ...video, published: 'draft' } : video));
  const shrunkOrder = getOrderedVideos(unpublished, true);
  check('published order shrank by one', shrunkOrder.length === n - 1);
  const completersOfTarget = SEEDED_VIEWERS.filter((viewer) => isVideoCompletedBy(viewer, target)).length;
  const dropPerViewer = SEEDED_VIEWERS.every(
    (viewer) => completedCount(viewer, shrunkOrder) === completedCount(viewer, order) - (isVideoCompletedBy(viewer, target) ? 1 : 0),
  );
  check('counts drop exactly for viewers who completed it', dropPerViewer, `${completersOfTarget} completers`);
  check('nobody exceeds the shrunken course', SEEDED_VIEWERS.every((viewer) => completedCount(viewer, shrunkOrder) <= n - 1));
  const republished = mapVideos(unpublished, (video) => (video.id === target ? { ...video, published: 'published' } : video));
  check('republish restores analytics exactly', analyticsSignature(republished, SEEDED_VIEWERS) === before);
}

console.log('6. Deleting mid-course content never mints finishers');
{
  const baseFinished = getCourseAnalytics(flagship, SEEDED_VIEWERS).finished;
  const midId = order[5]!.video.id; // the biggest-drop video
  const afterDelete = stripVideo(flagship, midId);
  const a = getCourseAnalytics(afterDelete, SEEDED_VIEWERS);
  check('mid deletion keeps finisher count', a.finished === baseFinished, `${baseFinished} -> ${a.finished}`);
  check('mid deletion preserves population', a.population === getCourseAnalytics(flagship, SEEDED_VIEWERS).population);

  const tailId = order[n - 1]!.video.id;
  const afterTail = getCourseAnalytics(stripVideo(flagship, tailId), SEEDED_VIEWERS);
  check('tail deletion keeps the two seeded finishers finished', afterTail.finished === baseFinished, `${baseFinished} -> ${afterTail.finished}`);

  const emptied = { ...flagship, modules: [] };
  check('deleting everything leaves zero finishers', getTrainingTotals([emptied], SEEDED_VIEWERS).fullCourseCompletions === 0);
}

console.log('7. Seeded demo reproduces the approved headline figures');
{
  const totals = getTrainingTotals(SEEDED_COURSES, SEEDED_VIEWERS);
  check('flagship publishes 36 videos', n === 36, String(n));
  check('28 viewers', totals.totalViewers === 28, String(totals.totalViewers));
  check('378 video completions', totals.videoCompletions === 378, String(totals.videoCompletions));
  check('2 full-course completions', totals.fullCourseCompletions === 2, String(totals.fullCourseCompletions));
  check('42h 21m total watch time', formatHours(totals.totalWatchSeconds) === '42h 21m', formatHours(totals.totalWatchSeconds));
  const analytics = getCourseAnalytics(flagship, SEEDED_VIEWERS);
  check('population of 27 active viewers', analytics.population === 27, String(analytics.population));
  check('average completion 38.9%', analytics.avgCompletionPct === 38.9, String(analytics.avgCompletionPct));
  check('biggest drop at video 6', analytics.biggestDrop !== null && analytics.biggestDrop.stat.position === 6, String(analytics.biggestDrop?.stat.position));
  check('biggest drop is 14.8 pts', analytics.biggestDrop !== null && analytics.biggestDrop.pts === 14.8, String(analytics.biggestDrop?.pts));
  check('every seeded completion id is a published flagship video', SEEDED_VIEWERS.every((viewer) => viewer.completedVideoIds.every((id) => order.some((item) => item.video.id === id))));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll training-portal invariants hold.');
