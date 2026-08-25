/**
 * Office-side training math — pure helpers shared by the office Training
 * pages and the invariant suite.
 *
 * The office area reads the same live snapshot as the HQ portal, but through
 * a provider-account lens: a scoped office sees its own roster, while the
 * unscoped demo office shows every office-assigned learner so the guided
 * demo stays lively. Everything funnels through the shared course helpers,
 * so a number shown here always agrees with the HQ portal's number for the
 * same person.
 */
import {
  completedCount,
  completionsFor,
  effectiveUnlock,
  frontierIndex,
  getOrderedVideos,
  isVideoCompleted,
  viewerWatchSeconds,
  type CompletionIndex,
  type OrderedVideo,
  type TrainingCourse,
  type TrainingViewer,
} from './hq/training'; // relative so the tsx invariant suite can import this module too

type CompletionMap = ReturnType<typeof completionsFor>;

export interface OfficeRosterEntry {
  viewer: TrainingViewer;
  /** Finished videos out of `total` for the course order supplied. */
  done: number;
  total: number;
  /** 0–100, rounded. */
  pct: number;
  watchSeconds: number;
  /** True for the signed-in staffer's own linked row (pinned to the top). */
  isSelf: boolean;
}

/**
 * The one membership rule for the office lens: the signed-in staffer's own
 * row always belongs (even if HQ has not filed it under an office yet, so
 * "My training" and the roster never disagree); otherwise the unscoped demo
 * office (`accountId === null`) sees every office-assigned learner, and a
 * scoped office sees exactly its own people. The roster and the teammate
 * page share this predicate, so a deep link can never widen the lens.
 */
export function isOfficeTeammate(
  viewer: TrainingViewer,
  accountId: string | null,
  selfViewerId: string | null,
): boolean {
  if (selfViewerId !== null && viewer.id === selfViewerId) return true;
  return accountId === null ? viewer.accountId !== null : viewer.accountId === accountId;
}

/**
 * The office's team roster with per-person progress against one course
 * order. Membership comes from `isOfficeTeammate` (demo lens = every
 * office-assigned learner; scoped = own office plus self).
 */
export function officeRoster(
  viewers: TrainingViewer[],
  accountId: string | null,
  order: OrderedVideo[],
  completionIndex: CompletionIndex,
  selfViewerId: string | null = null,
): OfficeRosterEntry[] {
  const members = viewers.filter((viewer) => isOfficeTeammate(viewer, accountId, selfViewerId));
  const total = order.length;
  return members
    .map((viewer) => {
      const map = completionsFor(completionIndex, viewer.id);
      const done = completedCount(map, order);
      return {
        viewer,
        done,
        total,
        pct: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
        watchSeconds: viewerWatchSeconds(map, order),
        isSelf: selfViewerId !== null && viewer.id === selfViewerId,
      };
    })
    .sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      const recency = Date.parse(b.viewer.lastSeenAt) - Date.parse(a.viewer.lastSeenAt);
      return recency !== 0 ? recency : a.viewer.name.localeCompare(b.viewer.name);
    });
}

export type VideoAvailability = 'done' | 'available' | 'locked';

/**
 * Mirrors the learner preview's unlock gate exactly: finished rows stay
 * open, free-unlock videos skip the line, and sequential courses wait for
 * the viewer's frontier (first unfinished video).
 */
export function videoAvailability(
  course: TrainingCourse,
  item: OrderedVideo,
  index: number,
  map: CompletionMap,
  frontier: number,
): VideoAvailability {
  if (isVideoCompleted(map, item.video.id)) return 'done';
  if (!course.sequentialUnlock || effectiveUnlock(item) === 'free') return 'available';
  return index <= frontier ? 'available' : 'locked';
}

export interface SelfCourseState {
  order: OrderedVideo[];
  done: number;
  total: number;
  /** 0–100, rounded. */
  pct: number;
  /** The next video to take (the frontier); null when finished or empty. */
  next: OrderedVideo | null;
}

/** The signed-in staffer's own position in one course. */
export function selfCourseState(course: TrainingCourse, map: CompletionMap): SelfCourseState {
  const order = getOrderedVideos(course, true);
  const done = completedCount(map, order);
  const frontier = frontierIndex(map, order);
  return {
    order,
    done,
    total: order.length,
    pct: order.length > 0 ? Math.min(100, Math.round((done / order.length) * 100)) : 0,
    next: frontier < order.length ? (order[frontier] ?? null) : null,
  };
}

/** How many people on the roster finished this specific video. */
export function videoTeamDone(
  videoId: string,
  roster: OfficeRosterEntry[],
  completionIndex: CompletionIndex,
): number {
  let count = 0;
  for (const entry of roster) {
    if (isVideoCompleted(completionsFor(completionIndex, entry.viewer.id), videoId)) count += 1;
  }
  return count;
}

export interface OfficeCourseStats {
  /** Average of roster completion percentages, rounded. */
  avgPct: number;
  /** Roster members who finished every published video. */
  finishers: number;
}

export function officeCourseStats(roster: OfficeRosterEntry[]): OfficeCourseStats {
  if (roster.length === 0) return { avgPct: 0, finishers: 0 };
  const avgPct = Math.round(roster.reduce((sum, entry) => sum + entry.pct, 0) / roster.length);
  const finishers = roster.filter((entry) => entry.total > 0 && entry.done >= entry.total).length;
  return { avgPct, finishers };
}

export interface LessonState {
  /** The course's full published order (for "Lesson n of m" and adjacency). */
  order: OrderedVideo[];
  /** The requested lesson, or null when it isn't in the published order. */
  item: OrderedVideo | null;
  /** Index of `item` in `order`; -1 when item is null. */
  index: number;
  /** Unlock state for the supplied completion map (meaningless when item is null). */
  availability: VideoAvailability;
  prev: OrderedVideo | null;
  next: OrderedVideo | null;
  prevAvailability: VideoAvailability | null;
  nextAvailability: VideoAvailability | null;
  /** When locked: the first unfinished lesson standing in the way (the frontier). */
  blocker: OrderedVideo | null;
}

/**
 * Everything the office lesson page needs to render one lesson, derived with
 * the same availability rules as the course outline — so a deep link can
 * never bypass sequential unlock: a lesson the outline shows locked resolves
 * locked here too, and unpublished or unknown ids resolve to `item: null`.
 */
export function lessonState(course: TrainingCourse, videoId: string, map: CompletionMap): LessonState {
  const order = getOrderedVideos(course, true);
  const frontier = frontierIndex(map, order);
  const index = order.findIndex((entry) => entry.video.id === videoId);
  if (index === -1) {
    return {
      order,
      item: null,
      index,
      availability: 'locked',
      prev: null,
      next: null,
      prevAvailability: null,
      nextAvailability: null,
      blocker: null,
    };
  }
  const availabilityAt = (i: number) => videoAvailability(course, order[i]!, i, map, frontier);
  const availability = availabilityAt(index);
  const prev = index > 0 ? (order[index - 1] ?? null) : null;
  const next = index + 1 < order.length ? (order[index + 1] ?? null) : null;
  return {
    order,
    item: order[index] ?? null,
    index,
    availability,
    prev,
    next,
    prevAvailability: prev ? availabilityAt(index - 1) : null,
    nextAvailability: next ? availabilityAt(index + 1) : null,
    // Locked implies index > frontier, so the frontier lesson always exists.
    blocker: availability === 'locked' && frontier < index ? (order[frontier] ?? null) : null,
  };
}

export interface TeammateCourseProgress {
  course: TrainingCourse;
  /** Finished videos out of `total` in this course's published order. */
  done: number;
  total: number;
  /** 0–100, rounded. */
  pct: number;
  watchSeconds: number;
}

export interface TeammateCompletedLesson {
  courseId: string;
  courseTitle: string;
  item: OrderedVideo;
  /** ISO timestamp of the finishing watch. */
  completedAt: string;
}

export interface TeammateStats {
  viewer: TrainingViewer;
  isSelf: boolean;
  /** Finished videos out of `total` across the whole live catalog. */
  done: number;
  total: number;
  /** 0–100, rounded. */
  pct: number;
  watchSeconds: number;
  /** Live courses where every published video is finished. */
  coursesFinished: number;
  courses: TeammateCourseProgress[];
  /** Newest finish first. */
  completedLessons: TeammateCompletedLesson[];
}

/**
 * One teammate's training stats across the live catalog — the data behind
 * the office teammate page (the read-only office cousin of the HQ viewer
 * profile). Resolves null when the viewer doesn't exist or falls outside
 * this office's lens (`isOfficeTeammate`), so deep links can never show a
 * person the roster wouldn't. Draft courses never count, mirroring how the
 * catalog and roster only surface live material.
 */
export function teammateStats(
  viewers: TrainingViewer[],
  accountId: string | null,
  viewerId: string,
  courses: TrainingCourse[],
  completionIndex: CompletionIndex,
  selfViewerId: string | null = null,
): TeammateStats | null {
  const viewer = viewers.find((candidate) => candidate.id === viewerId) ?? null;
  if (!viewer || !isOfficeTeammate(viewer, accountId, selfViewerId)) return null;
  const map = completionsFor(completionIndex, viewer.id);
  const perCourse: TeammateCourseProgress[] = [];
  const completedLessons: TeammateCompletedLesson[] = [];
  let done = 0;
  let total = 0;
  let watchSeconds = 0;
  let coursesFinished = 0;
  for (const course of courses) {
    if (course.status !== 'live') continue;
    const order = getOrderedVideos(course, true);
    const courseDone = completedCount(map, order);
    const courseWatch = viewerWatchSeconds(map, order);
    perCourse.push({
      course,
      done: courseDone,
      total: order.length,
      pct: order.length > 0 ? Math.min(100, Math.round((courseDone / order.length) * 100)) : 0,
      watchSeconds: courseWatch,
    });
    done += courseDone;
    total += order.length;
    watchSeconds += courseWatch;
    if (order.length > 0 && courseDone >= order.length) coursesFinished += 1;
    for (const item of order) {
      const row = map.get(item.video.id);
      if (row?.completedAt) {
        completedLessons.push({ courseId: course.id, courseTitle: course.title, item, completedAt: row.completedAt });
      }
    }
  }
  completedLessons.sort(
    (a, b) =>
      Date.parse(b.completedAt) - Date.parse(a.completedAt) ||
      a.courseTitle.localeCompare(b.courseTitle) ||
      a.item.numbering.localeCompare(b.item.numbering),
  );
  return {
    viewer,
    isSelf: selfViewerId !== null && viewer.id === selfViewerId,
    done,
    total,
    pct: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
    watchSeconds,
    coursesFinished,
    courses: perCourse,
    completedLessons,
  };
}
