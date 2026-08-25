/**
 * Training portal data model — types, row assembly, and derived statistics.
 *
 * The portal runs on LIVE Supabase rows (training_courses, training_modules,
 * training_subgroups, training_videos, training_viewers, training_invites,
 * training_completions). This module is the pure layer between those rows and
 * the pages: it assembles flat rows into the nested course model, derives
 * every number shown anywhere in the portal from real completion rows, and
 * hosts the structural transforms (move/reorder/remove) the authoring UI
 * applies before syncing positions back to the database.
 *
 * Everything here is side-effect free and browser/Node agnostic so
 * scripts/verify-training.ts can exercise it directly. The React layer lives
 * in contexts/training-data.tsx.
 *
 * Videos are METADATA ONLY — no video files exist anywhere. The database
 * keeps a nullable `video_source` slot for a future storage provider; nothing
 * reads or writes it today.
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
}

export interface TrainingVideo {
  id: string;
  title: string;
  /** Duration in seconds — editable metadata; no file is hosted anywhere. */
  duration: number;
  published: PublishState;
  unlock: UnlockMode;
  addStaff: AddStaffMode;
  /** Plain paragraphs; the editor renders them as rich text. */
  description: string[];
  chapters: TrainingChapter[];
  /** Chapter index whose slide frame is the poster/thumbnail everywhere. */
  thumbnailChapter: number;
  attachments: TrainingAttachment[];
}

export interface TrainingSubgroup {
  id: string;
  /** Rendered as small-caps section header, e.g. "ROSTER WALKTHROUGH". */
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
  /** Share path: /training/<slug>. */
  slug: string;
  title: string;
  description: string;
  status: 'live' | 'draft';
  /** Course-level "Sequential unlock" badge. */
  sequentialUnlock: boolean;
  /** ISO timestamp from the database. */
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
  /** Set when a learner added this person via the Add Staff button. */
  staffOfViewerId: string | null;
  /** Confirmed staff sign-in that owns this row; absent for demo/gate viewers. */
  authUserId?: string | null;
  location: string;
  /** ISO timestamps from the database. */
  firstSeenAt: string;
  lastSeenAt: string;
  sessions: number;
}

/**
 * One viewer's watch record for one video. A row with completedAt null means
 * started-but-not-finished; watchSeconds may exceed the video duration when
 * someone rewatches.
 */
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
  /** Always null today — reserved slot for a future storage provider. */
  video_source: string | null;
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

function sanitizeAttachments(value: unknown): TrainingAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: TrainingAttachment[] = [];
  for (const item of value) {
    if (item && typeof item === 'object' && typeof (item as TrainingAttachment).id === 'string') {
      const attachment = item as { id: string; name?: unknown; sizeLabel?: unknown };
      attachments.push({
        id: attachment.id,
        name: typeof attachment.name === 'string' ? attachment.name : 'Attachment',
        sizeLabel: typeof attachment.sizeLabel === 'string' ? attachment.sizeLabel : '—',
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
 * Assemble flat rows into the nested course model. Ordering rules:
 * courses by created_at (oldest first), modules by position, module entries
 * by position across root videos AND sub-groups (they share one entry-order
 * space), videos inside a sub-group by position. Ties break deterministically
 * by kind then id, so concurrent inserts can never scramble the editor.
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
    .map((courseRow) => ({
      id: courseRow.id,
      slug: courseRow.slug,
      title: courseRow.title,
      description: courseRow.description,
      status: courseRow.status === 'live' ? ('live' as const) : ('draft' as const),
      sequentialUnlock: Boolean(courseRow.sequential_unlock),
      createdAt: courseRow.created_at,
      modules: (modulesByCourse.get(courseRow.id) ?? [])
        .sort(byPosition)
        .map((moduleRow) => {
          const entryItems: { position: number; id: string; kind: 'video' | 'subgroup'; entry: ModuleEntry }[] = [];
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
            entries: entryItems.map((item) => item.entry),
          };
        }),
    }));
}

// ---------------------------------------------------------------------------
// Placements — the inverse of assembly, for syncing structure edits back
// ---------------------------------------------------------------------------

export interface CoursePlacements {
  modules: { id: string; position: number }[];
  subgroups: { id: string; moduleId: string; position: number }[];
  videos: { id: string; moduleId: string; subgroupId: string | null; position: number }[];
}

/**
 * Read every row's (parent, position) straight off the nested model's array
 * indexes. After a pure transform (move/reorder/ungroup), diffing these
 * against the previous placements yields exactly the rows to UPDATE.
 */
export function collectPlacements(course: TrainingCourse): CoursePlacements {
  const placements: CoursePlacements = { modules: [], subgroups: [], videos: [] };
  course.modules.forEach((module, moduleIndex) => {
    placements.modules.push({ id: module.id, position: moduleIndex });
    module.entries.forEach((entry, entryIndex) => {
      if (entry.kind === 'video') {
        placements.videos.push({ id: entry.video.id, moduleId: module.id, subgroupId: null, position: entryIndex });
      } else {
        placements.subgroups.push({ id: entry.subgroup.id, moduleId: module.id, position: entryIndex });
        entry.subgroup.videos.forEach((videoItem, videoIndex) => {
          placements.videos.push({
            id: videoItem.id,
            moduleId: module.id,
            subgroupId: entry.subgroup.id,
            position: videoIndex,
          });
        });
      }
    });
  });
  return placements;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** djb2 — stable tiny hash for palette/slide variation. */
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO timestamp → "Aug 21" (or "Aug 21, 2025" when the year differs from now). */
export function formatDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const base = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? base : `${base}, ${date.getFullYear()}`;
}

const formatTime = (date: Date): string => {
  const h24 = date.getHours();
  const m = date.getMinutes();
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
};

const sameLocalDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** ISO timestamp → "Today · 3:42 PM" / "Yesterday · 9:05 AM" / "Aug 21 · 9:05 AM". */
export function formatDateTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const yesterday = new Date(now.getTime() - 86_400_000);
  const day = sameLocalDay(date, now) ? 'Today' : sameLocalDay(date, yesterday) ? 'Yesterday' : formatDate(iso, now);
  return `${day} · ${formatTime(date)}`;
}

export function formatLastSeen(viewer: Pick<TrainingViewer, 'lastSeenAt'>, now: Date = new Date()): string {
  return formatDateTime(viewer.lastSeenAt, now);
}

export const slugifyTitle = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';

/** "office-onboarding" is taken → "office-onboarding-2", "-3", … */
export function nextFreeSlug(title: string, taken: ReadonlySet<string>): string {
  const base = slugifyTitle(title);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Defaults for a brand-new video entry — metadata only, no file anywhere. */
export function buildNewVideoDefaults(title: string, chapterIdPrefix: string): Omit<TrainingVideo, 'id'> {
  const duration = 300;
  const titles = ['Intro', 'Walkthrough', 'Details', 'Wrap-up'];
  return {
    title,
    duration,
    published: 'draft',
    unlock: 'sequential',
    addStaff: 'auto',
    description: [
      `Outline for ${title}. Describe what this walkthrough covers — this entry stores metadata only; video file hosting isn't set up yet.`,
    ],
    chapters: titles.map((chapterTitle, index) => ({
      id: `${chapterIdPrefix}-ch${index + 1}`,
      at: Math.round((duration * index) / titles.length),
      title: chapterTitle,
    })),
    thumbnailChapter: 0,
    attachments: [],
  };
}

// ---------------------------------------------------------------------------
// Course structure helpers
// ---------------------------------------------------------------------------

export interface OrderedVideo {
  video: TrainingVideo;
  module: TrainingModule;
  subgroup: TrainingSubgroup | null;
  /** 1-based order among the course's published videos (analytics rows). */
  position: number;
  /** Display numbering: "1.2" or "2.4.1". */
  numbering: string;
}

/**
 * Flattened course order. `publishedOnly` (learner/analytics view) skips
 * draft modules, subgroups, and videos; the admin editor passes false.
 * Numbering counts every entry the ADMIN sees so it matches the editor.
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

export interface VideoLocation extends OrderedVideo {
  course: TrainingCourse;
}

/** Find a video (published or draft) anywhere in a course. */
export function findVideoInCourse(course: TrainingCourse, videoId: string): VideoLocation | null {
  const all = getOrderedVideos(course, false);
  const hit = all.find((item) => item.video.id === videoId);
  return hit ? { ...hit, course } : null;
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

export const ADD_STAFF_LABELS: Record<AddStaffMode, string> = {
  auto: 'Auto',
  show: 'Show on this video',
  hidden: 'Hidden',
};

export const UNLOCK_LABELS: Record<UnlockMode, string> = {
  sequential: 'Sequential',
  free: 'Open',
};

// ---------------------------------------------------------------------------
// Pure structural transforms (the authoring UI's move/reorder/ungroup)
// ---------------------------------------------------------------------------

/**
 * Move a video one step through the course's flattened admin order. The
 * entry/subgroup structure stays fixed; the ordered video list is permuted
 * and refilled slot by slot — so an "up" at a boundary slides the video into
 * the neighboring sub-group or module, exactly like a small drag would.
 */
export function moveVideoInCourse(course: TrainingCourse, videoId: string, direction: 'up' | 'down'): TrainingCourse {
  const ordered: TrainingVideo[] = [];
  for (const module of course.modules) {
    for (const entry of module.entries) {
      if (entry.kind === 'video') ordered.push(entry.video);
      else ordered.push(...entry.subgroup.videos);
    }
  }
  const from = ordered.findIndex((videoItem) => videoItem.id === videoId);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= ordered.length) return course;
  const permuted = [...ordered];
  const [moved] = permuted.splice(from, 1);
  permuted.splice(to, 0, moved!);

  let cursor = 0;
  const next = () => permuted[cursor++]!;
  return {
    ...course,
    modules: course.modules.map((module) => ({
      ...module,
      entries: module.entries.map((entry): ModuleEntry =>
        entry.kind === 'video'
          ? { kind: 'video', video: next() }
          : { kind: 'subgroup', subgroup: { ...entry.subgroup, videos: entry.subgroup.videos.map(() => next()) } },
      ),
    })),
  };
}

/** Remove a video from wherever it sits in the course. */
export function stripVideoFromCourse(course: TrainingCourse, videoId: string): TrainingCourse {
  return {
    ...course,
    modules: course.modules.map((module) => ({
      ...module,
      entries: module.entries
        .filter((entry) => !(entry.kind === 'video' && entry.video.id === videoId))
        .map((entry) =>
          entry.kind === 'subgroup'
            ? {
                kind: 'subgroup' as const,
                subgroup: { ...entry.subgroup, videos: entry.subgroup.videos.filter((videoItem) => videoItem.id !== videoId) },
              }
            : entry,
        ),
    })),
  };
}

/** Reassign a video's sub-group (or none) — the editor's SUB-GROUP dropdown. */
export function moveVideoToContainerInCourse(
  course: TrainingCourse,
  videoId: string,
  target: { moduleId: string; subgroupId: string | null },
): TrainingCourse {
  const located = findVideoInCourse(course, videoId);
  if (!located) return course;
  const without = stripVideoFromCourse(course, videoId);
  return {
    ...without,
    modules: without.modules.map((module) => {
      if (target.subgroupId) {
        return {
          ...module,
          entries: module.entries.map((entry) =>
            entry.kind === 'subgroup' && entry.subgroup.id === target.subgroupId
              ? {
                  kind: 'subgroup' as const,
                  subgroup: { ...entry.subgroup, videos: [...entry.subgroup.videos, located.video] },
                }
              : entry,
          ),
        };
      }
      if (module.id !== target.moduleId) return module;
      return { ...module, entries: [...module.entries, { kind: 'video' as const, video: located.video }] };
    }),
  };
}

/**
 * Delete a sub-group but keep its videos: they slide back to the module
 * level, in place, in their old order — the editor's promise.
 */
export function removeSubgroupKeepVideos(course: TrainingCourse, subgroupId: string): TrainingCourse {
  return {
    ...course,
    modules: course.modules.map((module) => ({
      ...module,
      entries: module.entries.flatMap((entry) =>
        entry.kind === 'subgroup' && entry.subgroup.id === subgroupId
          ? entry.subgroup.videos.map((video) => ({ kind: 'video' as const, video }))
          : [entry],
      ),
    })),
  };
}

// ---------------------------------------------------------------------------
// Completion index + per-viewer derivations
//
// Every statistic intersects completion rows with the CURRENT published
// order, so reordering, moving, publishing/unpublishing, and deleting videos
// stay truthful with no reconciliation pass.
// ---------------------------------------------------------------------------

/** viewerId → (videoId → completion row). */
export type CompletionIndex = Map<string, Map<string, TrainingCompletion>>;

export type ViewerCompletionMap = ReadonlyMap<string, TrainingCompletion>;

const EMPTY_COMPLETION_MAP: ViewerCompletionMap = new Map();

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

/** Videos from `order` this viewer has touched at all (any watch row). */
export function startedCount(map: ViewerCompletionMap, order: OrderedVideo[]): number {
  let count = 0;
  for (const item of order) if (map.has(item.video.id)) count += 1;
  return count;
}

export function isVideoCompleted(map: ViewerCompletionMap, videoId: string): boolean {
  return Boolean(map.get(videoId)?.completedAt);
}

export function hasStartedVideo(map: ViewerCompletionMap, videoId: string): boolean {
  return map.has(videoId);
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
// Derived statistics — every page reads these, nobody hand-computes
// ---------------------------------------------------------------------------

export interface TrainingTotals {
  totalViewers: number;
  newViewersThisWeek: number;
  totalWatchSeconds: number;
  totalSessions: number;
  videoCompletions: number;
  fullCourseCompletions: number;
  libraryVideoCount: number;
  libraryDuration: number;
}

/**
 * Portal-wide headline numbers. Watch time and completion counts cover every
 * LIVE course's current published order; the library counts cover everything
 * (drafts included), matching what the admin sees in the editor.
 */
export function getTrainingTotals(
  courses: TrainingCourse[],
  viewers: TrainingViewer[],
  completions: TrainingCompletion[],
  now: Date = new Date(),
): TrainingTotals {
  const liveCourses = courses.filter((course) => course.status === 'live');
  const liveVideoIds = new Set<string>();
  for (const course of liveCourses) {
    for (const item of getOrderedVideos(course, true)) liveVideoIds.add(item.video.id);
  }

  let totalWatchSeconds = 0;
  let videoCompletions = 0;
  for (const row of completions) {
    if (!liveVideoIds.has(row.videoId)) continue;
    totalWatchSeconds += row.watchSeconds;
    if (row.completedAt) videoCompletions += 1;
  }

  const index = buildCompletionIndex(completions);
  let fullCourseCompletions = 0;
  for (const course of liveCourses) {
    const order = getOrderedVideos(course, true);
    if (order.length === 0) continue;
    for (const viewer of viewers) {
      if (completedCount(completionsFor(index, viewer.id), order) === order.length) fullCourseCompletions += 1;
    }
  }

  const weekAgo = now.getTime() - 7 * 86_400_000;
  return {
    totalViewers: viewers.length,
    newViewersThisWeek: viewers.filter((viewer) => Date.parse(viewer.firstSeenAt) >= weekAgo).length,
    totalWatchSeconds,
    totalSessions: viewers.reduce((sum, viewer) => sum + viewer.sessions, 0),
    videoCompletions,
    fullCourseCompletions,
    libraryVideoCount: courses.reduce((sum, course) => sum + countVideos(course, false), 0),
    libraryDuration: courses.reduce((sum, course) => sum + courseDuration(course, false), 0),
  };
}

export interface VideoStat extends OrderedVideo {
  started: number;
  completedCount: number;
  /** completed / population, in percent (0-100, one decimal). */
  pctOfPopulation: number;
  /** Drop vs previous video in percentage points; null = first video. */
  dropPts: number | null;
  /** Real seconds watched on this video, summed across viewers. */
  watchSeconds: number;
}

export interface CourseAnalytics {
  order: OrderedVideo[];
  stats: VideoStat[];
  /** Viewers with at least one watch row on the course's published order. */
  population: number;
  avgCompletionPct: number;
  avgWatchSecondsPerViewer: number;
  finished: number;
  finishedPct: number;
  biggestDrop: { stat: VideoStat; pts: number } | null;
  /** Histogram buckets of how far viewers get (population only). */
  buckets: { label: string; count: number }[];
  /** Mean wall-clock seconds from a finisher's first visit to their last completion. */
  avgCompletionSeconds: number;
  activeViewers: number;
  totalWatchSeconds: number;
}

export function getCourseAnalytics(
  course: TrainingCourse,
  viewers: TrainingViewer[],
  completions: TrainingCompletion[],
): CourseAnalytics {
  const order = getOrderedVideos(course, true);
  const n = order.length;
  const index = buildCompletionIndex(completions);

  const populationViewers = viewers.filter(
    (viewer) => startedCount(completionsFor(index, viewer.id), order) >= 1,
  );
  const population = populationViewers.length;

  const stats: VideoStat[] = order.map((item) => {
    let started = 0;
    let completedHere = 0;
    let watchSeconds = 0;
    for (const viewer of populationViewers) {
      const row = completionsFor(index, viewer.id).get(item.video.id);
      if (!row) continue;
      started += 1;
      watchSeconds += row.watchSeconds;
      if (row.completedAt) completedHere += 1;
    }
    const pct = population > 0 ? (completedHere / population) * 100 : 0;
    return {
      ...item,
      started,
      completedCount: completedHere,
      pctOfPopulation: Math.round(pct * 10) / 10,
      dropPts: null, // filled below
      watchSeconds,
    };
  });
  for (let i = 1; i < stats.length; i++) {
    const drop = Math.round((stats[i - 1]!.pctOfPopulation - stats[i]!.pctOfPopulation) * 10) / 10;
    stats[i]!.dropPts = drop;
  }

  let biggestDrop: CourseAnalytics['biggestDrop'] = null;
  for (const stat of stats) {
    if (stat.dropPts !== null && (biggestDrop === null || stat.dropPts > biggestDrop.pts)) {
      biggestDrop = { stat, pts: stat.dropPts };
    }
  }

  const completionPcts = populationViewers.map(
    (viewer) => (completedCount(completionsFor(index, viewer.id), order) / Math.max(1, n)) * 100,
  );
  const avgCompletionPct =
    population > 0 ? Math.round((completionPcts.reduce((sum, value) => sum + value, 0) / population) * 10) / 10 : 0;

  const totalWatchSeconds = stats.reduce((sum, stat) => sum + stat.watchSeconds, 0);
  const finishedViewers = populationViewers.filter(
    (viewer) => n > 0 && completedCount(completionsFor(index, viewer.id), order) >= n,
  );

  // Real wall clock: from the finisher's first visit to their last completion
  // on this course's published order.
  let completionSpanTotal = 0;
  let completionSpanCount = 0;
  for (const viewer of finishedViewers) {
    const map = completionsFor(index, viewer.id);
    let lastCompleted = Number.NEGATIVE_INFINITY;
    for (const item of order) {
      const row = map.get(item.video.id);
      if (row?.completedAt) lastCompleted = Math.max(lastCompleted, Date.parse(row.completedAt));
    }
    const span = (lastCompleted - Date.parse(viewer.firstSeenAt)) / 1000;
    if (Number.isFinite(span) && span > 0) {
      completionSpanTotal += span;
      completionSpanCount += 1;
    }
  }
  const avgCompletionSeconds = completionSpanCount > 0 ? Math.round(completionSpanTotal / completionSpanCount) : 0;

  const bucketDefs = [
    { label: '1-25%', min: 0.0001, max: 25 },
    { label: '26-50%', min: 25.0001, max: 50 },
    { label: '51-75%', min: 50.0001, max: 75 },
    { label: '76-99%', min: 75.0001, max: 99.9999 },
    { label: '100%', min: 99.9999, max: 1000 },
  ];
  const buckets = bucketDefs.map((def) => ({
    label: def.label,
    count: completionPcts.filter((value) => value >= def.min && value <= def.max).length,
  }));

  return {
    order,
    stats,
    population,
    avgCompletionPct,
    // Labeled "across active viewers" in Analytics — denominator must be the
    // active population, not the whole roster.
    avgWatchSecondsPerViewer: population > 0 ? Math.round(totalWatchSeconds / population) : 0,
    finished: finishedViewers.length,
    finishedPct: population > 0 ? Math.round((finishedViewers.length / population) * 1000) / 10 : 0,
    biggestDrop,
    buckets,
    avgCompletionSeconds,
    activeViewers: population,
    totalWatchSeconds,
  };
}

/** Top videos by real watch time — dashboard "most watched". */
export function getMostWatched(
  course: TrainingCourse,
  viewers: TrainingViewer[],
  completions: TrainingCompletion[],
  limit = 5,
): VideoStat[] {
  const { stats } = getCourseAnalytics(course, viewers, completions);
  return [...stats].sort((a, b) => b.watchSeconds - a.watchSeconds).slice(0, limit);
}

/** Viewers sorted by most recent activity — dashboard "recent viewers". */
export function getRecentViewers(viewers: TrainingViewer[], limit = 6): TrainingViewer[] {
  return [...viewers]
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
    .slice(0, limit);
}

export interface VideoEngagement {
  started: number;
  completed: number;
  totalWatchSeconds: number;
  /** completed / started, in percent; null when nobody has started. */
  completionPct: number | null;
}

/** Real per-video engagement — replaces the old synthetic retention curve. */
export function getVideoEngagement(videoId: string, completions: TrainingCompletion[]): VideoEngagement {
  let started = 0;
  let completed = 0;
  let totalWatchSeconds = 0;
  for (const row of completions) {
    if (row.videoId !== videoId) continue;
    started += 1;
    totalWatchSeconds += row.watchSeconds;
    if (row.completedAt) completed += 1;
  }
  return {
    started,
    completed,
    totalWatchSeconds,
    completionPct: started > 0 ? Math.round((completed / started) * 1000) / 10 : null,
  };
}

export interface RetentionPoint {
  /** Seconds from the start of the video. */
  at: number;
  /** Share of this video's watchers still watching at `at`, 0-100 (one decimal). */
  pct: number;
}

export interface VideoRetention {
  /** Viewers with any watch row on this video. */
  viewers: number;
  /**
   * Survival curve sampled evenly from 0 to the runtime (inclusive). Empty
   * when nobody has watched or the runtime is zero — the UI shows an honest
   * empty state instead of a fake flat line.
   */
  points: RetentionPoint[];
}

/**
 * Survival curve for one video: at each sampled timestamp, the share of its
 * watchers whose watch position reaches at least that far. A completed row
 * counts as watched to the end; an in-progress row counts up to its recorded
 * watchSeconds, clamped to the runtime (rewatch metadata can exceed it).
 *
 * Deliberately timestamp-free: `completedAt` is only checked for presence and
 * nothing is ever Date-parsed, so the curve is byte-identical in every
 * timezone and across renders (no clock reads).
 */
export function getVideoRetention(
  video: Pick<TrainingVideo, 'id' | 'duration'>,
  completions: TrainingCompletion[],
  samples = 48,
): VideoRetention {
  const duration = Math.max(0, Math.round(video.duration));
  const stops: number[] = [];
  for (const row of completions) {
    if (row.videoId !== video.id) continue;
    stops.push(row.completedAt ? duration : Math.min(Math.max(0, row.watchSeconds), duration));
  }
  const viewers = stops.length;
  if (viewers === 0 || duration <= 0 || samples < 1) return { viewers, points: [] };
  const points: RetentionPoint[] = [];
  for (let i = 0; i <= samples; i++) {
    const at = (duration * i) / samples;
    let still = 0;
    for (const stop of stops) if (stop >= at) still += 1;
    points.push({ at, pct: Math.round((still / viewers) * 1000) / 10 });
  }
  return { viewers, points };
}
