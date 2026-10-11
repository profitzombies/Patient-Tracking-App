/**
 * Mobile training data model — the provider-facing slice of the web
 * operations training layer, ported for the Care Team persona.
 *
 * The provider tabs are otherwise seeded/local; Training is the first LIVE
 * data surface on mobile. It reads the same Supabase rows as the web portal
 * (training_courses/modules/subgroups/videos/viewers/completions) and must
 * derive the exact same numbers, so this module is a deliberate copy of the
 * web's pure helpers:
 *
 *   artifacts/thinnr-operations/src/data/hq/training.ts      (assembly)
 *   artifacts/thinnr-operations/src/data/office-training.ts  (office math)
 *   artifacts/thinnr-operations/src/components/admin/training/shared.tsx
 *                                                (slide palette selection)
 *
 * Metro cannot import across artifacts, so the rules live here verbatim —
 * scripts/verify-provider-training.ts feeds identical fixtures to BOTH
 * copies and fails on any drift. If you change a rule here, change the web
 * module too (or vice versa), then run that suite.
 *
 * Mobile has no authoring transforms. Signed-in provider staff may complete
 * their own lessons and add office teammates through protected RPCs. A
 * learner with an EMPTY personal completion map starts with the
 * sequential-unlock frontier at the first lesson; team numbers come from
 * the office's live viewer/completion rows.
 *
 * Web lessons can host a real video file (HQ admins upload them; the row
 * then carries video_source/thumbnail_source). Mobile deliberately keeps the
 * simulated workbook-slide player — it carries those fields for row parity
 * but never streams, so the training experience here stays unchanged.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PublishState = 'published' | 'draft';
export type UnlockMode = 'sequential' | 'free';
export type AddStaffMode = 'auto' | 'show' | 'hidden';

export interface TrainingChapter {
  id: string;
  /** Seconds from the start of the video. */
  at: number;
  title: string;
}

export interface TrainingAttachment {
  id: string;
  name: string;
  sizeLabel: string;
  /** App Storage object path when a real file is hosted (null = legacy name-only entry). */
  source: string | null;
  contentType: string | null;
  /** True stored size in bytes; null for legacy entries. */
  sizeBytes: number | null;
}

export interface TrainingVideo {
  id: string;
  title: string;
  /** Duration in seconds — authored by hand until the web app hosts a video
   * file for the lesson, then measured from the file itself. */
  duration: number;
  published: PublishState;
  unlock: UnlockMode;
  addStaff: AddStaffMode;
  /** Plain paragraphs. */
  description: string[];
  chapters: TrainingChapter[];
  /** Chapter index whose slide frame is the poster/thumbnail everywhere. */
  thumbnailChapter: number;
  /** App Storage object path of the hosted video file (null = simulated slides). */
  videoSource: string | null;
  /** App Storage object path of the captured thumbnail frame (null = slide poster). */
  thumbnailSource: string | null;
  attachments: TrainingAttachment[];
}

export interface TrainingSubgroup {
  id: string;
  title: string;
  published: PublishState;
  unlock: UnlockMode;
  videos: TrainingVideo[];
}

export type ModuleEntry =
  | { kind: 'video'; video: TrainingVideo }
  | { kind: 'subgroup'; subgroup: TrainingSubgroup };

export interface TrainingModule {
  id: string;
  title: string;
  published: PublishState;
  unlock: UnlockMode;
  entries: ModuleEntry[];
}

export interface TrainingCourse {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: 'live' | 'draft';
  sequentialUnlock: boolean;
  createdAt: string;
  modules: TrainingModule[];
}

export interface TrainingViewer {
  id: string;
  name: string;
  email: string;
  phone: string;
  /** Provider account this office learner belongs to; null = "No account". */
  accountId: string | null;
  staffOfViewerId: string | null;
  authUserId?: string | null;
  location: string;
  firstSeenAt: string;
  lastSeenAt: string;
  sessions: number;
}

export interface TrainingCompletion {
  viewerId: string;
  videoId: string;
  watchSeconds: number;
  firstWatchedAt: string;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Database row shapes (snake_case, straight from Supabase)
// ---------------------------------------------------------------------------

export interface TrainingCourseRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: string;
  sequential_unlock: boolean;
  created_at: string;
}

export interface TrainingModuleRow {
  id: string;
  course_id: string;
  title: string;
  published: string;
  unlock_mode: string;
  position: number;
}

export interface TrainingSubgroupRow {
  id: string;
  module_id: string;
  title: string;
  published: string;
  unlock_mode: string;
  position: number;
}

export interface TrainingVideoRow {
  id: string;
  module_id: string;
  subgroup_id: string | null;
  title: string;
  duration_seconds: number;
  published: string;
  unlock_mode: string;
  add_staff: string;
  description: unknown;
  chapters: unknown;
  thumbnail_chapter: number;
  attachments: unknown;
  position: number;
  /** App Storage object path when a file is hosted (null = metadata only). */
  video_source: string | null;
  /** Captured poster frame's object path; optional so older fixtures compile. */
  thumbnail_source?: string | null;
}

export interface TrainingViewerRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  account_id: string | null;
  staff_of_viewer_id: string | null;
  auth_user_id?: string | null;
  location: string;
  first_seen_at: string;
  last_seen_at: string;
  sessions: number;
}

export interface TrainingCompletionRow {
  viewer_id: string;
  video_id: string;
  watch_seconds: number;
  first_watched_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Row → model assembly (defensive: jsonb columns are sanitized)
// ---------------------------------------------------------------------------

const asPublish = (value: unknown): PublishState => (value === 'draft' ? 'draft' : 'published');
const asUnlock = (value: unknown): UnlockMode => (value === 'free' ? 'free' : 'sequential');
const asAddStaff = (value: unknown): AddStaffMode =>
  value === 'show' || value === 'hidden' ? value : 'auto';

function sanitizeParagraphs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function sanitizeChapters(value: unknown): TrainingChapter[] {
  if (!Array.isArray(value)) return [];
  const chapters: TrainingChapter[] = [];
  for (const item of value) {
    if (item && typeof item === 'object' && typeof (item as TrainingChapter).id === 'string') {
      const chapter = item as { id: string; at?: unknown; title?: unknown };
      chapters.push({
        id: chapter.id,
        at: typeof chapter.at === 'number' && Number.isFinite(chapter.at) ? Math.max(0, chapter.at) : 0,
        title: typeof chapter.title === 'string' ? chapter.title : 'Chapter',
      });
    }
  }
  return chapters;
}

/** Human size for a stored byte count — matches the server's label format. */
export function formatSizeLabel(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function sanitizeAttachments(value: unknown): TrainingAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: TrainingAttachment[] = [];
  for (const item of value) {
    if (item && typeof item === 'object' && typeof (item as TrainingAttachment).id === 'string') {
      const attachment = item as {
        id: string;
        name?: unknown;
        sizeLabel?: unknown;
        source?: unknown;
        contentType?: unknown;
        sizeBytes?: unknown;
      };
      const sizeBytes =
        typeof attachment.sizeBytes === 'number' && Number.isFinite(attachment.sizeBytes) && attachment.sizeBytes > 0
          ? Math.round(attachment.sizeBytes)
          : null;
      attachments.push({
        id: attachment.id,
        name: typeof attachment.name === 'string' ? attachment.name : 'Attachment',
        sizeLabel:
          typeof attachment.sizeLabel === 'string'
            ? attachment.sizeLabel
            : sizeBytes !== null
              ? formatSizeLabel(sizeBytes)
              : '—',
        source: typeof attachment.source === 'string' && attachment.source ? attachment.source : null,
        contentType:
          typeof attachment.contentType === 'string' && attachment.contentType ? attachment.contentType : null,
        sizeBytes,
      });
    }
  }
  return attachments;
}

export function mapVideoRow(row: TrainingVideoRow): TrainingVideo {
  return {
    id: row.id,
    title: row.title,
    duration: Math.max(0, Math.round(row.duration_seconds ?? 0)),
    published: asPublish(row.published),
    unlock: asUnlock(row.unlock_mode),
    addStaff: asAddStaff(row.add_staff),
    description: sanitizeParagraphs(row.description),
    chapters: sanitizeChapters(row.chapters),
    thumbnailChapter: Math.max(0, row.thumbnail_chapter ?? 0),
    videoSource: row.video_source ?? null,
    thumbnailSource: row.thumbnail_source ?? null,
    attachments: sanitizeAttachments(row.attachments),
  };
}

export function mapViewerRow(row: TrainingViewerRow): TrainingViewer {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    accountId: row.account_id,
    staffOfViewerId: row.staff_of_viewer_id,
    authUserId: row.auth_user_id ?? null,
    location: row.location,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    sessions: row.sessions,
  };
}

export function mapCompletionRow(row: TrainingCompletionRow): TrainingCompletion {
  return {
    viewerId: row.viewer_id,
    videoId: row.video_id,
    watchSeconds: Math.max(0, row.watch_seconds ?? 0),
    firstWatchedAt: row.first_watched_at,
    completedAt: row.completed_at,
  };
}

export interface TrainingRowBundle {
  courses: TrainingCourseRow[];
  modules: TrainingModuleRow[];
  subgroups: TrainingSubgroupRow[];
  videos: TrainingVideoRow[];
}

/**
 * Assemble flat rows into the nested course model. Ordering rules (identical
 * to the web): courses by created_at (oldest first), modules by position,
 * module entries by position across root videos AND sub-groups (one shared
 * entry-order space), videos inside a sub-group by position. Ties break
 * deterministically by kind then id.
 */
export function assembleCourses(bundle: TrainingRowBundle): TrainingCourse[] {
  const modulesByCourse = new Map<string, TrainingModuleRow[]>();
  for (const row of bundle.modules) {
    const list = modulesByCourse.get(row.course_id) ?? [];
    list.push(row);
    modulesByCourse.set(row.course_id, list);
  }
  const subgroupsByModule = new Map<string, TrainingSubgroupRow[]>();
  for (const row of bundle.subgroups) {
    const list = subgroupsByModule.get(row.module_id) ?? [];
    list.push(row);
    subgroupsByModule.set(row.module_id, list);
  }
  const videosByModule = new Map<string, TrainingVideoRow[]>();
  const videosBySubgroup = new Map<string, TrainingVideoRow[]>();
  for (const row of bundle.videos) {
    if (row.subgroup_id) {
      const list = videosBySubgroup.get(row.subgroup_id) ?? [];
      list.push(row);
      videosBySubgroup.set(row.subgroup_id, list);
    } else {
      const list = videosByModule.get(row.module_id) ?? [];
      list.push(row);
      videosByModule.set(row.module_id, list);
    }
  }

  const byPosition = <T extends { position: number; id: string }>(a: T, b: T) =>
    a.position - b.position || (a.id < b.id ? -1 : 1);

  return [...bundle.courses]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : 1))
    .map(courseRow => ({
      id: courseRow.id,
      slug: courseRow.slug,
      title: courseRow.title,
      description: courseRow.description,
      status: courseRow.status === 'live' ? ('live' as const) : ('draft' as const),
      sequentialUnlock: Boolean(courseRow.sequential_unlock),
      createdAt: courseRow.created_at,
      modules: (modulesByCourse.get(courseRow.id) ?? [])
        .sort(byPosition)
        .map(moduleRow => {
          const entryItems: {
            position: number;
            id: string;
            kind: 'video' | 'subgroup';
            entry: ModuleEntry;
          }[] = [];
          for (const videoRow of videosByModule.get(moduleRow.id) ?? []) {
            entryItems.push({
              position: videoRow.position,
              id: videoRow.id,
              kind: 'video',
              entry: { kind: 'video', video: mapVideoRow(videoRow) },
            });
          }
          for (const subgroupRow of subgroupsByModule.get(moduleRow.id) ?? []) {
            entryItems.push({
              position: subgroupRow.position,
              id: subgroupRow.id,
              kind: 'subgroup',
              entry: {
                kind: 'subgroup',
                subgroup: {
                  id: subgroupRow.id,
                  title: subgroupRow.title,
                  published: asPublish(subgroupRow.published),
                  unlock: asUnlock(subgroupRow.unlock_mode),
                  videos: (videosBySubgroup.get(subgroupRow.id) ?? []).sort(byPosition).map(mapVideoRow),
                },
              },
            });
          }
          entryItems.sort(
            (a, b) =>
              a.position - b.position ||
              (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind === 'video' ? -1 : 1),
          );
          return {
            id: moduleRow.id,
            title: moduleRow.title,
            published: asPublish(moduleRow.published),
            unlock: asUnlock(moduleRow.unlock_mode),
            entries: entryItems.map(item => item.entry),
          };
        }),
    }));
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** djb2 — stable tiny hash for slide palette variation. */
export function hashId(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h;
}

export const formatClock = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return `${m}:${String(rest).padStart(2, '0')}`;
};

/** 148500s → "41h 15m"; under an hour → "38m". */
export const formatHours = (seconds: number): string => {
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
};

// ---------------------------------------------------------------------------
// Course structure helpers
// ---------------------------------------------------------------------------

export interface OrderedVideo {
  video: TrainingVideo;
  module: TrainingModule;
  subgroup: TrainingSubgroup | null;
  /** 1-based order among the course's published videos. */
  position: number;
  /** Display numbering: "1.2" or "2.4.1". */
  numbering: string;
}

/**
 * Flattened course order. `publishedOnly` (the learner view — always true on
 * mobile) skips draft modules, subgroups, and videos. Numbering counts every
 * entry the admin editor sees so it matches the web everywhere.
 */
export function getOrderedVideos(course: TrainingCourse, publishedOnly = true): OrderedVideo[] {
  const out: OrderedVideo[] = [];
  let position = 0;
  course.modules.forEach((module, moduleIndex) => {
    if (publishedOnly && module.published !== 'published') return;
    module.entries.forEach((entry, entryIndex) => {
      const base = `${moduleIndex + 1}.${entryIndex + 1}`;
      if (entry.kind === 'video') {
        if (publishedOnly && entry.video.published !== 'published') return;
        position += 1;
        out.push({ video: entry.video, module, subgroup: null, position, numbering: base });
      } else {
        if (publishedOnly && entry.subgroup.published !== 'published') return;
        entry.subgroup.videos.forEach((videoItem, videoIndex) => {
          if (publishedOnly && videoItem.published !== 'published') return;
          position += 1;
          out.push({
            video: videoItem,
            module,
            subgroup: entry.subgroup,
            position,
            numbering: `${base}.${videoIndex + 1}`,
          });
        });
      }
    });
  });
  return out;
}

export function countVideos(course: TrainingCourse, publishedOnly = false): number {
  return getOrderedVideos(course, publishedOnly).length;
}

export function courseDuration(course: TrainingCourse, publishedOnly = false): number {
  return getOrderedVideos(course, publishedOnly).reduce((sum, item) => sum + item.video.duration, 0);
}

/**
 * Unlock resolution across the hierarchy: marking a module or sub-group
 * "free" frees every video inside it; otherwise the video's own mode wins.
 */
export function effectiveUnlock(item: OrderedVideo): UnlockMode {
  if (item.video.unlock === 'free') return 'free';
  if (item.subgroup && item.subgroup.unlock === 'free') return 'free';
  if (item.module.unlock === 'free') return 'free';
  return 'sequential';
}

// ---------------------------------------------------------------------------
// Completion index + per-viewer derivations
//
// Every statistic intersects completion rows with the CURRENT published
// order, so HQ reordering/unpublishing stays truthful with no reconciliation.
// ---------------------------------------------------------------------------

/** viewerId → (videoId → completion row). */
export type CompletionIndex = Map<string, Map<string, TrainingCompletion>>;

export type ViewerCompletionMap = ReadonlyMap<string, TrainingCompletion>;

export const EMPTY_COMPLETION_MAP: ViewerCompletionMap = new Map();

export function buildCompletionIndex(completions: TrainingCompletion[]): CompletionIndex {
  const index: CompletionIndex = new Map();
  for (const row of completions) {
    const forViewer = index.get(row.viewerId) ?? new Map<string, TrainingCompletion>();
    forViewer.set(row.videoId, row);
    index.set(row.viewerId, forViewer);
  }
  return index;
}

export function completionsFor(index: CompletionIndex, viewerId: string): ViewerCompletionMap {
  return index.get(viewerId) ?? EMPTY_COMPLETION_MAP;
}

/** Videos from `order` this viewer has FINISHED (completed_at set). */
export function completedCount(map: ViewerCompletionMap, order: OrderedVideo[]): number {
  let count = 0;
  for (const item of order) {
    const row = map.get(item.video.id);
    if (row?.completedAt) count += 1;
  }
  return count;
}

export function isVideoCompleted(map: ViewerCompletionMap, videoId: string): boolean {
  return Boolean(map.get(videoId)?.completedAt);
}

/** Index of the first not-yet-finished video in `order`; order.length when done. */
export function frontierIndex(map: ViewerCompletionMap, order: OrderedVideo[]): number {
  for (let i = 0; i < order.length; i++) {
    if (!isVideoCompleted(map, order[i]!.video.id)) return i;
  }
  return order.length;
}

/** Real seconds watched across `order`, straight from watch metadata. */
export function viewerWatchSeconds(map: ViewerCompletionMap, order: OrderedVideo[]): number {
  let total = 0;
  for (const item of order) {
    const row = map.get(item.video.id);
    if (row) total += row.watchSeconds;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Office math — identical to the web's office-training.ts
// ---------------------------------------------------------------------------

export interface OfficeRosterEntry {
  viewer: TrainingViewer;
  done: number;
  total: number;
  /** 0–100, rounded. */
  pct: number;
  watchSeconds: number;
  isSelf: boolean;
}

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
 * order. With `accountId === null` the roster is unscoped: every
 * office-assigned learner, like the web portal.
 */
export function officeRoster(
  viewers: TrainingViewer[],
  accountId: string | null,
  order: OrderedVideo[],
  completionIndex: CompletionIndex,
  selfViewerId: string | null = null,
): OfficeRosterEntry[] {
  const members = viewers.filter(viewer => isOfficeTeammate(viewer, accountId, selfViewerId));
  const total = order.length;
  return members
    .map(viewer => {
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

export interface SelfCourseState {
  order: OrderedVideo[];
  done: number;
  total: number;
  pct: number;
  next: OrderedVideo | null;
}

export function selfCourseState(course: TrainingCourse, map: ViewerCompletionMap): SelfCourseState {
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

export type VideoAvailability = 'done' | 'available' | 'locked';

/**
 * Mirrors the web learner gate exactly: finished rows stay open, free-unlock
 * videos skip the line, and sequential courses wait for the viewer's
 * frontier (first unfinished video).
 */
export function videoAvailability(
  course: TrainingCourse,
  item: OrderedVideo,
  index: number,
  map: ViewerCompletionMap,
  frontier: number,
): VideoAvailability {
  if (isVideoCompleted(map, item.video.id)) return 'done';
  if (!course.sequentialUnlock || effectiveUnlock(item) === 'free') return 'available';
  return index <= frontier ? 'available' : 'locked';
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
  const finishers = roster.filter(entry => entry.total > 0 && entry.done >= entry.total).length;
  return { avgPct, finishers };
}

export interface TeammateCourseProgress {
  course: TrainingCourse;
  done: number;
  total: number;
  pct: number;
  watchSeconds: number;
}

export interface TeammateCompletedLesson {
  courseId: string;
  courseTitle: string;
  item: OrderedVideo;
  completedAt: string;
}

export interface TeammateStats {
  viewer: TrainingViewer;
  isSelf: boolean;
  done: number;
  total: number;
  pct: number;
  watchSeconds: number;
  coursesFinished: number;
  courses: TeammateCourseProgress[];
  completedLessons: TeammateCompletedLesson[];
}

export function teammateStats(
  viewers: TrainingViewer[],
  accountId: string | null,
  viewerId: string,
  courses: TrainingCourse[],
  completionIndex: CompletionIndex,
  selfViewerId: string | null = null,
): TeammateStats | null {
  const viewer = viewers.find(candidate => candidate.id === viewerId) ?? null;
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

export interface LessonState {
  order: OrderedVideo[];
  /** The requested lesson, or null when it isn't in the published order. */
  item: OrderedVideo | null;
  index: number;
  availability: VideoAvailability;
  prev: OrderedVideo | null;
  next: OrderedVideo | null;
  prevAvailability: VideoAvailability | null;
  nextAvailability: VideoAvailability | null;
  /** When locked: the first unfinished lesson standing in the way. */
  blocker: OrderedVideo | null;
}

/**
 * Everything the lesson page needs, derived with the same availability rules
 * as the course outline — so a deep link can never bypass sequential unlock:
 * a lesson the outline shows locked resolves locked here too, and
 * unpublished or unknown ids resolve to `item: null`.
 */
export function lessonState(
  course: TrainingCourse,
  videoId: string,
  map: ViewerCompletionMap,
): LessonState {
  const order = getOrderedVideos(course, true);
  const frontier = frontierIndex(map, order);
  const index = order.findIndex(entry => entry.video.id === videoId);
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
    blocker: availability === 'locked' && frontier < index ? (order[frontier] ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Slide frames — palette + chapter lookup for the native "workbook slide"
// rendition (mirrors the web SlideFrame's deterministic palette).
// ---------------------------------------------------------------------------

export type SlidePalette = 'cream' | 'navy' | 'cobalt';

export function slidePaletteFor(videoId: string, chapterIndex: number): SlidePalette {
  const order: SlidePalette[] = ['cream', 'navy', 'cobalt'];
  return order[(hashId(videoId) + chapterIndex) % order.length]!;
}

/** Chapter index whose slide should represent the video at time `seconds`. */
export function chapterIndexAt(video: Pick<TrainingVideo, 'chapters'>, seconds: number): number {
  let index = 0;
  video.chapters.forEach((chapter, i) => {
    if (chapter.at <= seconds) index = i;
  });
  return index;
}
