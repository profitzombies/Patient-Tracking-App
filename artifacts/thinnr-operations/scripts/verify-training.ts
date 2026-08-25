/**
 * Training-portal invariants — live data model.
 *
 * The portal now reads flat Supabase rows and assembles them client-side;
 * progress is an intersection of completion rows with the CURRENT published
 * order. This suite pins the pure logic that keeps the numbers truthful,
 * entirely offline (synthetic rows, no database):
 *
 *   1. Row → course assembly is deterministic and defensive (jsonb sanitized).
 *   2. collectPlacements is the inverse of assembly, and structural
 *      transforms always leave contiguous per-container positions.
 *   3. Unlock resolves through the hierarchy (course → module → sub-group →
 *      video), so the editor's module/sub-group unlock controls are real.
 *   4. Completing a video credits exactly that video — never skipped ones;
 *      a started-not-finished row counts as started, not completed.
 *   5. Reordering and moving videos never change anyone's counts.
 *   6. Unpublish → republish is a perfect analytics round-trip.
 *   7. Deleting mid-course content never mints finishers.
 *   8. Analytics derive from real rows: drafts and other-course rows are
 *      excluded everywhere; watch time is summed watch metadata.
 *   9. An empty database yields zeros and empty lists — no demo numbers.
 *  10. New-entity defaults are honest metadata-only drafts.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:training
 */
import {
  assembleCourses,
  buildCompletionIndex,
  buildNewVideoDefaults,
  collectPlacements,
  completedCount,
  completionsFor,
  effectiveUnlock,
  frontierIndex,
  getCourseAnalytics,
  getMostWatched,
  getOrderedVideos,
  getRecentViewers,
  getTrainingTotals,
  getVideoEngagement,
  hasStartedVideo,
  isVideoCompleted,
  mapCompletionRow,
  mapVideoRow,
  mapViewerRow,
  moveVideoInCourse,
  moveVideoToContainerInCourse,
  nextFreeSlug,
  removeSubgroupKeepVideos,
  slugifyTitle,
  startedCount,
  stripVideoFromCourse,
  viewerWatchSeconds,
  type TrainingCompletion,
  type TrainingCourse,
  type TrainingCourseRow,
  type TrainingModuleRow,
  type TrainingSubgroupRow,
  type TrainingVideo,
  type TrainingVideoRow,
  type TrainingViewerRow,
} from '../src/data/hq/training';
import {
  officeCourseStats,
  officeRoster,
  selfCourseState,
  videoAvailability,
  videoTeamDone,
} from '../src/data/office-training';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- Synthetic row fixture ---------------------------------------------------
// One live sequential course (2 published modules + 1 draft module, one free
// sub-group, one draft video) plus one draft course. Positions are the same
// contiguous per-container scheme the seed and the context writer use.

const courseRows: TrainingCourseRow[] = [
  { id: 'c1', slug: 'office-onboarding-qa', title: 'Office Onboarding QA', description: 'd', status: 'live', sequential_unlock: true, created_at: '2026-07-01T12:00:00Z' },
  { id: 'c2', slug: 'reporting-draft-qa', title: 'Reporting Draft QA', description: 'd', status: 'draft', sequential_unlock: false, created_at: '2026-08-01T12:00:00Z' },
];

const moduleRows: TrainingModuleRow[] = [
  { id: 'm1', course_id: 'c1', title: 'M1', published: 'published', unlock_mode: 'sequential', position: 0 },
  { id: 'm2', course_id: 'c1', title: 'M2', published: 'published', unlock_mode: 'free', position: 1 },
  { id: 'm3', course_id: 'c1', title: 'M3 (draft)', published: 'draft', unlock_mode: 'sequential', position: 2 },
  { id: 'mc2', course_id: 'c2', title: 'C2 M1', published: 'published', unlock_mode: 'sequential', position: 0 },
];

const subgroupRows: TrainingSubgroupRow[] = [
  { id: 'sg1', module_id: 'm1', title: 'SG1', published: 'published', unlock_mode: 'free', position: 2 },
];

const videoRow = (
  over: Partial<TrainingVideoRow> & Pick<TrainingVideoRow, 'id' | 'module_id' | 'position'>,
): TrainingVideoRow => ({
  subgroup_id: null,
  title: over.id,
  duration_seconds: 300,
  published: 'published',
  unlock_mode: 'sequential',
  add_staff: 'auto',
  description: ['p1'],
  chapters: [
    { id: `${over.id}-ch1`, at: 0, title: 'Intro' },
    { id: `${over.id}-ch2`, at: 90, title: 'Body' },
  ],
  thumbnail_chapter: 0,
  attachments: [],
  video_source: null,
  ...over,
});

const videoRows: TrainingVideoRow[] = [
  videoRow({ id: 'v1', module_id: 'm1', position: 0, duration_seconds: 300 }),
  videoRow({ id: 'v2', module_id: 'm1', position: 1, duration_seconds: 240, unlock_mode: 'free' }),
  videoRow({ id: 'v3', module_id: 'm1', subgroup_id: 'sg1', position: 0, duration_seconds: 200 }),
  videoRow({ id: 'v4', module_id: 'm1', position: 3, duration_seconds: 500, published: 'draft' }),
  videoRow({ id: 'v5', module_id: 'm2', position: 0, duration_seconds: 400 }),
  videoRow({ id: 'v6', module_id: 'm3', position: 0, duration_seconds: 150 }),
  videoRow({ id: 'vc2', module_id: 'mc2', position: 0, duration_seconds: 100 }),
];

const viewerRow = (
  over: Partial<TrainingViewerRow> & Pick<TrainingViewerRow, 'id' | 'first_seen_at' | 'last_seen_at' | 'sessions'>,
): TrainingViewerRow => ({
  name: over.id,
  email: `${over.id}@example.test`,
  phone: '(555) 010-0000',
  account_id: null,
  staff_of_viewer_id: null,
  location: 'QA',
  ...over,
});

const viewers = [
  viewerRow({ id: 'va', first_seen_at: '2026-08-01T10:00:00Z', last_seen_at: '2026-08-21T15:00:00Z', sessions: 5 }),
  viewerRow({ id: 'vb', first_seen_at: '2026-08-05T10:00:00Z', last_seen_at: '2026-08-23T09:00:00Z', sessions: 3 }),
  viewerRow({ id: 'vc', first_seen_at: '2026-08-20T09:00:00Z', last_seen_at: '2026-08-20T09:05:00Z', sessions: 1 }),
  viewerRow({ id: 'vd', first_seen_at: '2026-08-10T10:00:00Z', last_seen_at: '2026-08-22T11:00:00Z', sessions: 2 }),
].map(mapViewerRow);

const completion = (viewerId: string, videoId: string, watch: number, completedAt: string | null): TrainingCompletion =>
  mapCompletionRow({
    viewer_id: viewerId,
    video_id: videoId,
    watch_seconds: watch,
    first_watched_at: '2026-08-02T10:00:00Z',
    completed_at: completedAt,
  });

// va finishes everything (plus the draft-course video); vb finishes v1,
// stalls mid-v2, and "completed" the DRAFT v4 (must count nowhere); vd
// completed only the free-module video v5, out of order.
const completions: TrainingCompletion[] = [
  completion('va', 'v1', 320, '2026-08-03T10:00:00Z'),
  completion('va', 'v2', 250, '2026-08-04T10:00:00Z'),
  completion('va', 'v3', 210, '2026-08-05T10:00:00Z'),
  completion('va', 'v5', 410, '2026-08-06T10:00:00Z'),
  completion('va', 'vc2', 90, '2026-08-07T10:00:00Z'),
  completion('vb', 'v1', 305, '2026-08-06T09:00:00Z'),
  completion('vb', 'v2', 60, null),
  completion('vb', 'v4', 100, '2026-08-07T09:00:00Z'),
  completion('vd', 'v5', 395, '2026-08-12T10:00:00Z'),
];

const NOW = new Date('2026-08-24T12:00:00Z');
const bundle = { courses: courseRows, modules: moduleRows, subgroups: subgroupRows, videos: videoRows };
const courses = assembleCourses(bundle);
const c1 = courses.find((course) => course.id === 'c1')!;
const order = getOrderedVideos(c1, true);
const n = order.length;
const index = buildCompletionIndex(completions);

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
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
const analyticsSignature = (course: TrainingCourse) => {
  const a = getCourseAnalytics(course, viewers, completions);
  return JSON.stringify({
    population: a.population,
    avgCompletionPct: a.avgCompletionPct,
    finished: a.finished,
    totalWatchSeconds: a.totalWatchSeconds,
    perVideo: a.stats.map((s) => [s.video.id, s.completedCount, s.started]),
  });
};
const baselineSignature = analyticsSignature(c1);

console.log('1. Row → course assembly is deterministic and defensive');
{
  check('courses ordered by created_at', courses.map((c) => c.id).join(',') === 'c1,c2');
  check('course status maps live/draft', c1.status === 'live' && courses[1]!.status === 'draft');
  check('modules ordered by position', c1.modules.map((m) => m.id).join(',') === 'm1,m2,m3');
  const m1 = c1.modules[0]!;
  check(
    'root videos and sub-groups share one entry-order space',
    m1.entries.map((e) => (e.kind === 'video' ? e.video.id : e.subgroup.id)).join(',') === 'v1,v2,sg1,v4',
    m1.entries.map((e) => (e.kind === 'video' ? e.video.id : e.subgroup.id)).join(','),
  );
  const sg = m1.entries.find((e) => e.kind === 'subgroup');
  check('sub-group videos assembled inside it', sg?.kind === 'subgroup' && sg.subgroup.videos.map((v) => v.id).join(',') === 'v3');
  check('published order intersects draft flags', order.map((item) => item.video.id).join(',') === 'v1,v2,v3,v5', order.map((i) => i.video.id).join(','));
  check('numbering matches the editor', order.map((item) => item.numbering).join(' ') === '1.1 1.2 1.3.1 2.1');
  check(
    'admin order still shows drafts',
    getOrderedVideos(c1, false).map((i) => i.video.id).join(',') === 'v1,v2,v3,v4,v5,v6',
    getOrderedVideos(c1, false).map((i) => i.video.id).join(','),
  );

  const dirty = mapVideoRow(
    videoRow({
      id: 'vx',
      module_id: 'm1',
      position: 9,
      duration_seconds: -10,
      description: 'not-an-array' as unknown,
      chapters: [{ id: 'ok', at: 'bad', title: 7 }, { nope: true }, { id: 'neg', at: -5 }] as unknown,
      attachments: { a: 1 } as unknown,
      thumbnail_chapter: null as unknown as number,
    }),
  );
  check('jsonb sanitized: paragraphs', dirty.description.length === 0);
  check(
    'jsonb sanitized: chapters keep only well-formed entries',
    dirty.chapters.length === 2 && dirty.chapters.every((ch) => ch.at === 0 && typeof ch.title === 'string'),
    JSON.stringify(dirty.chapters),
  );
  check('jsonb sanitized: attachments + numbers clamped', dirty.attachments.length === 0 && dirty.duration === 0 && dirty.thumbnailChapter === 0);
}

console.log('2. Placements invert assembly; transforms keep positions contiguous');
{
  const inputPlacement = new Map(videoRows.map((row) => [row.id, `${row.module_id}/${row.subgroup_id ?? ''}/${row.position}`]));
  const collected = courses.flatMap((course) => collectPlacements(course).videos);
  check(
    'collectPlacements(assembleCourses(rows)) reproduces every video row placement',
    collected.length === videoRows.length &&
      collected.every((v) => inputPlacement.get(v.id) === `${v.moduleId}/${v.subgroupId ?? ''}/${v.position}`),
  );
  const subgroupPlacement = collectPlacements(c1).subgroups[0]!;
  check('sub-group placement matches its entry slot', subgroupPlacement.id === 'sg1' && subgroupPlacement.moduleId === 'm1' && subgroupPlacement.position === 2);

  const contiguous = (course: TrainingCourse): boolean => {
    const p = collectPlacements(course);
    const moduleSlots = p.modules.map((m) => m.position).sort((a, b) => a - b);
    if (!moduleSlots.every((slot, i) => slot === i)) return false;
    return course.modules.every((module) => {
      const entrySlots = [
        ...p.videos.filter((v) => v.moduleId === module.id && v.subgroupId === null).map((v) => v.position),
        ...p.subgroups.filter((s) => s.moduleId === module.id).map((s) => s.position),
      ].sort((a, b) => a - b);
      if (!entrySlots.every((slot, i) => slot === i)) return false;
      return module.entries.every((entry) => {
        if (entry.kind !== 'subgroup') return true;
        const videoSlots = p.videos.filter((v) => v.subgroupId === entry.subgroup.id).map((v) => v.position).sort((a, b) => a - b);
        return videoSlots.every((slot, i) => slot === i);
      });
    });
  };
  check('fixture placements are contiguous per container', contiguous(c1));
  check('move keeps placements contiguous', contiguous(moveVideoInCourse(c1, 'v2', 'down')));
  check('cross-container move keeps placements contiguous', contiguous(moveVideoToContainerInCourse(c1, 'v1', { moduleId: 'm2', subgroupId: null })));
  check('ungroup keeps placements contiguous', contiguous(removeSubgroupKeepVideos(c1, 'sg1')));
  check('delete keeps placements contiguous', contiguous(stripVideoFromCourse(c1, 'v2')));
}

console.log('3. Unlock resolves through the hierarchy');
{
  const modeOf = (id: string) => effectiveUnlock(order.find((item) => item.video.id === id)!);
  check('plain sequential video stays sequential', modeOf('v1') === 'sequential');
  check('video-level free wins', modeOf('v2') === 'free');
  check('free sub-group frees its videos', modeOf('v3') === 'free');
  check('free module frees its videos', modeOf('v5') === 'free');
}

console.log('4. Completion credits exactly the watched video (row ∩ published order)');
{
  check('unknown viewer gets an empty map', completionsFor(index, 'nobody').size === 0 && completedCount(completionsFor(index, 'nobody'), order) === 0);
  const vb = completionsFor(index, 'vb');
  check('started-not-finished counts as started, not completed', hasStartedVideo(vb, 'v2') && !isVideoCompleted(vb, 'v2'));
  check('vb completed/started/frontier', completedCount(vb, order) === 1 && startedCount(vb, order) === 2 && frontierIndex(vb, order) === 1);
  check('draft-video row counts nowhere', !order.some((item) => item.video.id === 'v4') && viewerWatchSeconds(vb, order) === 365, String(viewerWatchSeconds(vb, order)));

  const vd = completionsFor(index, 'vd');
  check('out-of-order completion never moves the frontier', completedCount(vd, order) === 1 && frontierIndex(vd, order) === 0);

  // Simulate the mark-complete RPC upsert: vb finishes v2 (their frontier).
  const afterIndex = buildCompletionIndex([...completions, completion('vb', 'v2', 240, '2026-08-23T10:00:00Z')]);
  const vbAfter = completionsFor(afterIndex, 'vb');
  check('completing the frontier advances it by one', completedCount(vbAfter, order) === 2 && frontierIndex(vbAfter, order) === 2);
  const dupIndex = buildCompletionIndex([...completions, completion('vb', 'v2', 240, '2026-08-23T10:00:00Z'), completion('vb', 'v2', 240, '2026-08-23T10:00:00Z')]);
  check('idempotent re-completion (upsert semantics)', completedCount(completionsFor(dupIndex, 'vb'), order) === 2);

  // Completing far ahead (free unlock) credits only that video.
  const aheadIndex = buildCompletionIndex([...completions, completion('vb', 'v5', 400, '2026-08-23T11:00:00Z')]);
  const vbAhead = completionsFor(aheadIndex, 'vb');
  check('skipped videos stay uncredited', completedCount(vbAhead, order) === 2 && frontierIndex(vbAhead, order) === 1 && !isVideoCompleted(vbAhead, 'v3'));
}

console.log('5. Reordering / moving videos never changes progress');
{
  const perViewerBefore = viewers.map((viewer) => completedCount(completionsFor(index, viewer.id), order));

  const swapped = moveVideoInCourse(clone(c1), 'v2', 'down');
  const swappedOrder = getOrderedVideos(swapped, true);
  check('move changed the order', swappedOrder.map((i) => i.video.id).join(',') !== order.map((i) => i.video.id).join(','));
  check('move preserved the published set', new Set(swappedOrder.map((i) => i.video.id)).size === n && swappedOrder.length === n);
  check(
    'per-viewer counts unchanged by reorder',
    viewers.every((viewer, i) => completedCount(completionsFor(index, viewer.id), swappedOrder) === perViewerBefore[i]),
  );
  const statFor = (course: TrainingCourse, id: string) =>
    getCourseAnalytics(course, viewers, completions).stats.find((s) => s.video.id === id)!;
  check('per-video completion follows the video, not the slot', statFor(swapped, 'v2').completedCount === statFor(c1, 'v2').completedCount);

  const moved = moveVideoToContainerInCourse(clone(c1), 'v1', { moduleId: 'm2', subgroupId: null });
  const movedOrder = getOrderedVideos(moved, true);
  check('cross-container move preserves the published set', movedOrder.length === n && new Set(movedOrder.map((i) => i.video.id)).size === n);
  check(
    'per-viewer counts unchanged by cross-container move',
    viewers.every((viewer, i) => completedCount(completionsFor(index, viewer.id), movedOrder) === perViewerBefore[i]),
  );

  const ungrouped = removeSubgroupKeepVideos(clone(c1), 'sg1');
  const ungroupedOrder = getOrderedVideos(ungrouped, true);
  check('ungroup keeps the videos', ungroupedOrder.length === n && ungroupedOrder.some((i) => i.video.id === 'v3' && i.subgroup === null));
  check(
    'per-viewer counts unchanged by ungroup',
    viewers.every((viewer, i) => completedCount(completionsFor(index, viewer.id), ungroupedOrder) === perViewerBefore[i]),
  );
  check('fixture untouched by simulations', analyticsSignature(c1) === baselineSignature);
}

console.log('6. Unpublish → republish is a perfect analytics round-trip');
{
  const target = 'v2';
  const unpublished = mapVideos(c1, (video) => (video.id === target ? { ...video, published: 'draft' } : video));
  const shrunkOrder = getOrderedVideos(unpublished, true);
  check('published order shrank by one', shrunkOrder.length === n - 1);
  const dropPerViewer = viewers.every((viewer) => {
    const map = completionsFor(index, viewer.id);
    return completedCount(map, shrunkOrder) === completedCount(map, order) - (isVideoCompleted(map, target) ? 1 : 0);
  });
  check('counts drop exactly for viewers who completed it', dropPerViewer);
  check('nobody exceeds the shrunken course', viewers.every((viewer) => completedCount(completionsFor(index, viewer.id), shrunkOrder) <= n - 1));
  const republished = mapVideos(unpublished, (video) => (video.id === target ? { ...video, published: 'published' } : video));
  check('republish restores analytics exactly', analyticsSignature(republished) === baselineSignature);
}

console.log('7. Deleting mid-course content never mints finishers');
{
  const baseFinished = getCourseAnalytics(c1, viewers, completions).finished;
  check('baseline has exactly one finisher', baseFinished === 1, String(baseFinished));

  const afterMid = getCourseAnalytics(stripVideoFromCourse(c1, 'v3'), viewers, completions);
  check('mid deletion keeps finisher count', afterMid.finished === baseFinished, `${baseFinished} -> ${afterMid.finished}`);
  check('mid deletion keeps the population', afterMid.population === 3, String(afterMid.population));

  const afterTail = getCourseAnalytics(stripVideoFromCourse(c1, 'v5'), viewers, completions);
  check('tail deletion keeps the finisher finished', afterTail.finished === baseFinished, `${baseFinished} -> ${afterTail.finished}`);
  check('tail deletion drops vd out of the population', afterTail.population === 2, String(afterTail.population));

  const emptied = { ...c1, modules: [] };
  check('deleting everything leaves zero full completions', getTrainingTotals([emptied], viewers, completions, NOW).fullCourseCompletions === 0);
}

console.log('8. Analytics derive from real rows (drafts and other courses excluded)');
{
  const a = getCourseAnalytics(c1, viewers, completions);
  check('population = viewers with ≥1 row on the published order', a.population === 3, String(a.population));
  check('finished / finishedPct', a.finished === 1 && a.finishedPct === 33.3, `${a.finished} ${a.finishedPct}`);
  check('per-video: completed ≤ started ≤ population', a.stats.every((s) => s.completedCount <= s.started && s.started <= a.population));
  check('watch time is summed watch metadata', a.totalWatchSeconds === 1950, String(a.totalWatchSeconds));
  check('avg watch across active viewers', a.avgWatchSecondsPerViewer === 650, String(a.avgWatchSecondsPerViewer));
  check('avg completion pct', a.avgCompletionPct === 50, String(a.avgCompletionPct));
  check('biggest drop lands after the first video', a.biggestDrop !== null && a.biggestDrop.stat.video.id === 'v2' && a.biggestDrop.pts > 0, JSON.stringify(a.biggestDrop?.pts));
  check(
    'buckets partition the population',
    a.buckets.reduce((sum, b) => sum + b.count, 0) === a.population &&
      a.buckets.find((b) => b.label === '100%')!.count === 1 &&
      a.buckets.find((b) => b.label === '1-25%')!.count === 2,
    JSON.stringify(a.buckets),
  );
  check('finisher wall-clock span is real (5 days)', a.avgCompletionSeconds === 5 * 86_400, String(a.avgCompletionSeconds));

  const engagement = getVideoEngagement('v2', completions);
  check('video engagement from rows', engagement.started === 2 && engagement.completed === 1 && engagement.totalWatchSeconds === 310 && engagement.completionPct === 50);
  check('most watched sorts by real watch time', getMostWatched(c1, viewers, completions, 2).map((s) => s.video.id).join(',') === 'v5,v1');
  check('recent viewers sort by last seen', getRecentViewers(viewers, 2).map((v) => v.id).join(',') === 'vb,vd');

  const totals = getTrainingTotals(courses, viewers, completions, NOW);
  check('total viewers counts the roster', totals.totalViewers === 4);
  check('new this week uses first_seen', totals.newViewersThisWeek === 1, String(totals.newViewersThisWeek));
  check('video completions exclude drafts + draft courses', totals.videoCompletions === 6, String(totals.videoCompletions));
  check('watch time excludes drafts + draft courses', totals.totalWatchSeconds === 1950, String(totals.totalWatchSeconds));
  check('full-course completions ignore the draft course', totals.fullCourseCompletions === 1, String(totals.fullCourseCompletions));
  check('sessions summed', totals.totalSessions === 11, String(totals.totalSessions));
  check('library counts include drafts', totals.libraryVideoCount === 7 && totals.libraryDuration === 1890, `${totals.libraryVideoCount} ${totals.libraryDuration}`);
}

console.log('9. An empty database yields zeros — no demo numbers');
{
  check('no rows → no courses', assembleCourses({ courses: [], modules: [], subgroups: [], videos: [] }).length === 0);
  const totals = getTrainingTotals([], [], [], NOW);
  check(
    'totals are all zero',
    totals.totalViewers === 0 && totals.videoCompletions === 0 && totals.fullCourseCompletions === 0 &&
      totals.totalWatchSeconds === 0 && totals.libraryVideoCount === 0 && totals.totalSessions === 0,
  );
  const a = getCourseAnalytics(c1, [], []);
  check(
    'course analytics with no viewers are honest zeros',
    a.population === 0 && a.finished === 0 && a.totalWatchSeconds === 0 && a.avgCompletionPct === 0 &&
      a.buckets.every((b) => b.count === 0),
  );
  const engagement = getVideoEngagement('v1', []);
  check('engagement with no rows', engagement.started === 0 && engagement.completionPct === null);
}

console.log('10. New-entity defaults are honest metadata-only drafts');
{
  const defaults = buildNewVideoDefaults('Greeting walk-ins', 'qa');
  check('new video is a draft with the default runtime', defaults.published === 'draft' && defaults.duration === 300 && defaults.attachments.length === 0);
  check(
    'chapters are well-formed and prefixed',
    defaults.chapters.length === 4 &&
      defaults.chapters.every((ch, i) => ch.id.startsWith('qa-ch') && ch.at >= 0 && ch.at < defaults.duration && (i === 0 || ch.at > defaults.chapters[i - 1]!.at)),
  );
  check('copy admits there is no hosted file', defaults.description[0]!.includes("hosting isn't set up"));
  check('slugify produces clean slugs', /^[a-z0-9-]+$/.test(slugifyTitle('QA — Front Desk Refresher!')), slugifyTitle('QA — Front Desk Refresher!'));
  const taken = new Set(['front-desk']);
  const slug = nextFreeSlug('Front Desk', taken);
  check('nextFreeSlug avoids collisions', !taken.has(slug) && /^front-desk/.test(slug) && /^[a-z0-9-]+$/.test(slug), slug);
  check('nextFreeSlug is identity when free', nextFreeSlug('Front Desk', new Set()) === 'front-desk');
}

console.log('11. The office training lens agrees with HQ math');
{
  const videoRow = (id: string, position: number, unlock: 'sequential' | 'free'): any => ({
    id,
    module_id: 'om1',
    subgroup_id: null,
    title: id.toUpperCase(),
    duration_seconds: 100,
    published: 'published',
    unlock_mode: unlock,
    add_staff: 'auto',
    description: [],
    chapters: [],
    thumbnail_chapter: 0,
    attachments: [],
    position,
    video_source: null,
  });
  const [course] = assembleCourses({
    courses: [
      { id: 'oc', slug: 'oc', title: 'Office Course', description: '', status: 'live', sequential_unlock: true, created_at: '2026-08-01T00:00:00Z' },
    ] as any,
    modules: [
      { id: 'om1', course_id: 'oc', title: 'Module One', published: 'published', unlock_mode: 'sequential', position: 0 },
    ] as any,
    subgroups: [],
    videos: [videoRow('va', 0, 'sequential'), videoRow('vb', 1, 'sequential'), videoRow('vc', 2, 'sequential'), videoRow('vd', 3, 'free')],
  });
  const officeViewer = (id: string, accountId: string | null, lastSeenAt: string, authUserId: string | null = null) => ({
    id,
    name: id.toUpperCase(),
    email: `${id}@office.test`,
    phone: '—',
    accountId,
    staffOfViewerId: null,
    authUserId,
    location: '—',
    firstSeenAt: '2026-08-01T00:00:00Z',
    lastSeenAt,
    sessions: 1,
  });
  const self = officeViewer('self', 'acct-p1', '2026-08-10T00:00:00Z', 'user-1');
  const teammate = officeViewer('tm', 'acct-p1', '2026-08-20T00:00:00Z');
  const otherOffice = officeViewer('other', 'acct-p2', '2026-08-21T00:00:00Z');
  const unassigned = officeViewer('una', null, '2026-08-22T00:00:00Z');
  const allViewers = [self, teammate, otherOffice, unassigned];
  const done = (viewerId: string, videoId: string): TrainingCompletion => ({
    viewerId,
    videoId,
    watchSeconds: 100,
    firstWatchedAt: '2026-08-05T00:00:00Z',
    completedAt: '2026-08-05T00:10:00Z',
  });
  const index = buildCompletionIndex([
    done('self', 'va'),
    done('tm', 'va'), done('tm', 'vb'), done('tm', 'vc'), done('tm', 'vd'),
    done('other', 'va'),
  ]);
  const order = getOrderedVideos(course!, true);

  const scoped = officeRoster(allViewers, 'acct-p1', order, index, 'self');
  check('scoped roster is the office plus self, self pinned first',
    scoped.length === 2 && scoped[0]!.viewer.id === 'self' && scoped[1]!.viewer.id === 'tm');
  check('roster math matches HQ helpers',
    scoped[0]!.done === 1 && scoped[0]!.pct === 25 && scoped[1]!.done === 4 && scoped[1]!.pct === 100 &&
      scoped[1]!.watchSeconds === 400);
  const unscoped = officeRoster(allViewers, null, order, index, null);
  check('unscoped demo roster lists office-assigned learners only',
    unscoped.length === 3 && !unscoped.some((entry) => entry.viewer.id === 'una'));
  const crossScope = officeRoster(allViewers, 'acct-p2', order, index, 'self');
  check('self stays on the roster even when filed under another office',
    crossScope.some((entry) => entry.viewer.id === 'self') && crossScope.some((entry) => entry.viewer.id === 'other'));

  const stats = officeCourseStats(scoped);
  check('team stats: average rounds, finishers require every video', stats.avgPct === 63 && stats.finishers === 1);
  check('empty roster yields honest zeros', officeCourseStats([]).avgPct === 0 && officeCourseStats([]).finishers === 0);

  const selfState = selfCourseState(course!, completionsFor(index, 'self'));
  check('self state points at the frontier video',
    selfState.done === 1 && selfState.total === 4 && selfState.pct === 25 && selfState.next?.video.id === 'vb');
  const finishedState = selfCourseState(course!, completionsFor(index, 'tm'));
  check('finished course has no next video', finishedState.next === null && finishedState.pct === 100);

  const selfMap = completionsFor(index, 'self');
  const frontier = frontierIndex(selfMap, order);
  const availability = order.map((item, i) => videoAvailability(course!, item, i, selfMap, frontier));
  check('availability: done, frontier open, later locked, free skips the line',
    availability[0] === 'done' && availability[1] === 'available' && availability[2] === 'locked' && availability[3] === 'available');
  const freeCourse = { ...course!, sequentialUnlock: false };
  check('non-sequential course opens everything',
    order.every((item, i) => videoAvailability(freeCourse, item, i, selfMap, frontier) !== 'locked'));

  check('per-video team counts', videoTeamDone('va', scoped, index) === 2 && videoTeamDone('vc', scoped, index) === 1 && videoTeamDone('vd', unscoped, index) === 1);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll training-portal invariants hold.');
