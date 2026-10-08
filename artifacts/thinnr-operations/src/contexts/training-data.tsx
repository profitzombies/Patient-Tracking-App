/**
 * Live training portal state: courses, viewers, and completions from Supabase.
 *
 * Unlike the rest of the HQ demo, training is real data — every read comes
 * from the project database and every authoring edit writes back to it, so
 * the portal looks the same in any browser and survives reloads. One
 * react-query snapshot holds the whole (small) dataset; mutations write
 * through the Supabase client and then invalidate the snapshot.
 *
 * Authoring writes require a real signed-in HQ admin (RLS enforces this on
 * the server; `canEdit` mirrors it in the UI so demo personas get a friendly
 * "sign in to make changes" nudge instead of a 401). The learner-preview
 * flows — email gate, staff invites, mark-complete — go through narrow
 * SECURITY DEFINER RPCs keyed by an opaque per-registration session token,
 * never by a caller-supplied viewer id.
 *
 * Privacy: only seeded demo viewers (is_demo) — and their completions and
 * invites — are readable without a real admin session, and a signed-out
 * snapshot skips even those when demo entry is switched off
 * (src/lib/demo-entry.ts): the share-link page needs only the catalog.
 * Email-gate registrations are invisible to anon reads, so the learner page
 * keeps its own progress state from the RPC payloads rather than this
 * snapshot.
 *
 * Ordering invariant: `position` columns stay contiguous per container
 * (0..n-1). The seed writes them that way and every structural mutation here
 * re-syncs positions from the transformed course (see syncPlacements), so
 * "append at length" is always correct and assembly order is stable.
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assembleCourses,
  buildCompletionIndex,
  buildNewVideoDefaults,
  collectPlacements,
  findVideoInCourse,
  mapCompletionRow,
  mapViewerRow,
  mapVideoRow,
  moveVideoInCourse,
  moveVideoToContainerInCourse,
  nextFreeSlug,
  removeSubgroupKeepVideos,
  stripVideoFromCourse,
  type AddStaffMode,
  type CompletionIndex,
  type CoursePlacements,
  type PublishState,
  type TrainingChapter,
  type TrainingCompletion,
  type TrainingCompletionRow,
  type TrainingCourse,
  type TrainingCourseRow,
  type TrainingModule,
  type TrainingModuleRow,
  type TrainingSubgroup,
  type TrainingSubgroupRow,
  type TrainingVideo,
  type TrainingVideoRow,
  type TrainingViewer,
  type TrainingViewerRow,
  type UnlockMode,
  type VideoLocation,
} from '@/data/hq/training';
import { getOrderedVideos } from '@/data/hq/training';
import { removeAllAttachments, removeVideoFile } from '@/lib/training-media';
import { purgeVideosMedia, type VideoMediaPurgeDeps } from '@/lib/training-purge';
import { supabase } from '@/lib/supabase';
import { demoEntryEnabled } from '@/lib/demo-entry';
import { useSession } from '@/contexts/session';
import { toast } from '@/hooks/use-toast';

/** The real storage deletions behind the purge sequencer (training-purge). */
const hostedMediaPurge: VideoMediaPurgeDeps = {
  clearAttachments: removeAllAttachments,
  removeHostedFile: removeVideoFile,
};

const TRAINING_QUERY_KEY = ['training-data'] as const;

/**
 * Per-table fetch guard. PostgREST caps responses at 1000 rows server-side
 * anyway; at demo scale (dozens of videos, hundreds of completions) the whole
 * dataset fits comfortably in one snapshot.
 */
const FETCH_LIMIT = 1000;

interface TrainingSnapshot {
  courses: TrainingCourse[];
  viewers: TrainingViewer[];
  completions: TrainingCompletion[];
}

function requireClient(): SupabaseClient {
  if (!supabase) throw new Error('The database is not configured for this environment.');
  return supabase;
}

/** Throw a readable error for any failed PostgREST response. */
function assertOk(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  assertOk(result.error);
  if (result.data === null) throw new Error('The database returned no data.');
  return result.data;
}

/**
 * `includePeople` false = catalog only. Used for signed-out visitors when demo
 * entry is switched off: anon reads can only ever return the seeded demo
 * viewers, and the share-link learner page tracks its own progress through
 * the gate RPCs, so nothing anonymous depends on those rows.
 */
async function fetchSnapshot(includePeople: boolean): Promise<TrainingSnapshot> {
  const client = requireClient();
  const catalogQuery = Promise.all([
    client.from('training_courses').select('*').order('created_at', { ascending: true }).limit(FETCH_LIMIT),
    client.from('training_modules').select('*').order('position', { ascending: true }).limit(FETCH_LIMIT),
    client.from('training_subgroups').select('*').order('position', { ascending: true }).limit(FETCH_LIMIT),
    client.from('training_videos').select('*').order('position', { ascending: true }).limit(FETCH_LIMIT),
  ]);
  const peopleQuery = includePeople
    ? Promise.all([
        client.from('training_viewers').select('*').order('first_seen_at', { ascending: true }).limit(FETCH_LIMIT),
        client.from('training_completions').select('*').order('first_watched_at', { ascending: true }).limit(FETCH_LIMIT),
      ])
    : Promise.resolve(null);
  const [[courses, modules, subgroups, videos], people] = await Promise.all([catalogQuery, peopleQuery]);
  for (const result of [courses, modules, subgroups, videos, ...(people ?? [])]) {
    assertOk(result.error);
  }
  const [viewers, completions] = people ?? [null, null];
  return {
    courses: assembleCourses({
      courses: (courses.data ?? []) as TrainingCourseRow[],
      modules: (modules.data ?? []) as TrainingModuleRow[],
      subgroups: (subgroups.data ?? []) as TrainingSubgroupRow[],
      videos: (videos.data ?? []) as TrainingVideoRow[],
    }),
    viewers: ((viewers?.data ?? []) as TrainingViewerRow[]).map(mapViewerRow),
    completions: ((completions?.data ?? []) as TrainingCompletionRow[]).map(mapCompletionRow),
  };
}

/**
 * Write only the placement rows that changed between two course shapes.
 * Placements are derived from array indexes (collectPlacements), so this
 * both persists the transform AND re-compacts positions to 0..n-1 — which is
 * what keeps the contiguity invariant alive across deletes and moves.
 */
async function syncPlacements(client: SupabaseClient, before: CoursePlacements, after: CoursePlacements): Promise<void> {
  const beforeModules = new Map(before.modules.map((item) => [item.id, item]));
  const beforeSubgroups = new Map(before.subgroups.map((item) => [item.id, item]));
  const beforeVideos = new Map(before.videos.map((item) => [item.id, item]));

  const writes: PromiseLike<{ error: { message: string } | null }>[] = [];
  for (const item of after.modules) {
    const prev = beforeModules.get(item.id);
    if (!prev || prev.position !== item.position) {
      writes.push(client.from('training_modules').update({ position: item.position }).eq('id', item.id));
    }
  }
  for (const item of after.subgroups) {
    const prev = beforeSubgroups.get(item.id);
    if (!prev || prev.moduleId !== item.moduleId || prev.position !== item.position) {
      writes.push(
        client.from('training_subgroups').update({ module_id: item.moduleId, position: item.position }).eq('id', item.id),
      );
    }
  }
  for (const item of after.videos) {
    const prev = beforeVideos.get(item.id);
    if (!prev || prev.moduleId !== item.moduleId || prev.subgroupId !== item.subgroupId || prev.position !== item.position) {
      writes.push(
        client
          .from('training_videos')
          .update({ module_id: item.moduleId, subgroup_id: item.subgroupId, position: item.position })
          .eq('id', item.id),
      );
    }
  }
  const results = await Promise.all(writes);
  for (const result of results) assertOk(result.error);
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface VideoPatch {
  title?: string;
  description?: string[];
  /** Seconds — the editor's duration field (video files aren't hosted, so this is authored metadata). */
  duration?: number;
  published?: PublishState;
  unlock?: UnlockMode;
  addStaff?: AddStaffMode;
  chapters?: TrainingChapter[];
  thumbnailChapter?: number;
  // Attachments are deliberately NOT patchable here: entries are written by
  // the media API's finalize/remove routes (the single writer that also owns
  // the stored files), so a draft save can never clobber an upload.
}

export type TrainingStatus = 'loading' | 'error' | 'ready';

/**
 * A learner's private session: their own viewer row, completion rows, and the
 * opaque capability token the learner RPCs require. Never part of the shared
 * snapshot — non-demo learners aren't readable by other anonymous visitors.
 */
export interface LearnerSession {
  viewer: TrainingViewer;
  token: string;
  completions: TrainingCompletion[];
}

interface TrainingDataValue {
  status: TrainingStatus;
  /** Set when status === 'error'. */
  errorMessage: string | null;
  /** Refetch the snapshot (error-state retry button). */
  refresh: () => void;
  /** True for a real signed-in HQ admin; demo personas browse read-only. */
  canEdit: boolean;
  /** True for signed-in staff (HQ admin or provider staff) — gates teammate adds. */
  canAddStaff: boolean;
  /** The signed-in staffer's own linked viewer row (null for demo, anon, or HQ-only sign-ins). */
  myViewer: TrainingViewer | null;

  courses: TrainingCourse[];
  viewers: TrainingViewer[];
  completions: TrainingCompletion[];
  /** viewerId → (videoId → completion row), rebuilt with the snapshot. */
  completionIndex: CompletionIndex;
  /** The first live course (falls back to the first course; null while empty). */
  flagshipCourse: TrainingCourse | null;
  findCourse: (courseId: string | undefined) => TrainingCourse | undefined;
  locateVideo: (courseId: string | undefined, videoId: string | undefined) => VideoLocation | null;

  addCourse: (input: { title: string; description: string }) => Promise<TrainingCourse | null>;
  /**
   * The mutations below resolve true when the write landed (a no-op edit
   * counts as landed) and false when it did not: the demo-persona gate and
   * database failures both toast their own explanation in here, so callers
   * fire success toasts only on true.
   */
  updateCourse: (
    courseId: string,
    patch: Partial<Pick<TrainingCourse, 'title' | 'description' | 'status' | 'sequentialUnlock'>>,
  ) => Promise<boolean>;

  addModule: (courseId: string, title: string) => Promise<boolean>;
  updateModule: (
    courseId: string,
    moduleId: string,
    patch: Partial<Pick<TrainingModule, 'title' | 'published' | 'unlock'>>,
  ) => Promise<boolean>;
  removeModule: (courseId: string, moduleId: string) => Promise<boolean>;

  addSubgroup: (courseId: string, moduleId: string, title: string) => Promise<boolean>;
  updateSubgroup: (
    courseId: string,
    subgroupId: string,
    patch: Partial<Pick<TrainingSubgroup, 'title' | 'published' | 'unlock'>>,
  ) => Promise<boolean>;
  removeSubgroup: (courseId: string, subgroupId: string) => Promise<boolean>;

  /** New videos land as drafts with placeholder metadata (no file upload exists). */
  addVideo: (
    courseId: string,
    target: { moduleId: string; subgroupId?: string | null },
    title: string,
  ) => Promise<TrainingVideo | null>;
  updateVideo: (courseId: string, videoId: string, patch: VideoPatch) => Promise<boolean>;
  /** Boundary moves (already first/last) resolve false — nothing changed. */
  moveVideo: (courseId: string, videoId: string, direction: 'up' | 'down') => Promise<boolean>;
  /** Reassign a video's sub-group (or none) within its module — the editor's SUB-GROUP dropdown. */
  moveVideoToContainer: (
    courseId: string,
    videoId: string,
    target: { moduleId: string; subgroupId: string | null },
  ) => Promise<boolean>;
  /** Danger zone: removes the video, its chapters/attachments, and its completion rows permanently. */
  removeVideo: (courseId: string, videoId: string) => Promise<boolean>;

  assignViewerAccount: (viewerId: string, accountId: string | null) => Promise<void>;
  /** Email gate on the learner view — registers (or resumes) the email and returns a private session. */
  registerLearner: (email: string) => Promise<LearnerSession | null>;
  /** Rehydrate a stored learner token. Resolves null (silently) when the token is stale. */
  fetchLearnerState: (token: string) => Promise<LearnerSession | null>;
  /** Learner "Add your staff" — records the invite server-side without exposing the invitee. */
  inviteStaff: (token: string, email: string) => Promise<boolean>;
  /** Learner preview progress — persists and returns the completion row. */
  markVideoComplete: (token: string, videoId: string) => Promise<TrainingCompletion | null>;

  /**
   * Office self-serve teammate add: pre-approves the email for staff sign-up
   * under the office and puts them on the roster immediately. HQ admins may
   * target any office; provider staff only their own (RLS enforces both).
   */
  addStaffMember: (accountId: string, input: { name: string; email: string }) => Promise<TrainingViewer | null>;
  /** Signed-in staff progress — persists against the caller's own linked viewer row. */
  markMyVideoComplete: (videoId: string) => Promise<TrainingCompletion | null>;
}

const TrainingDataContext = createContext<TrainingDataValue | null>(null);

const EMPTY_COURSES: TrainingCourse[] = [];
const EMPTY_VIEWERS: TrainingViewer[] = [];
const EMPTY_COMPLETIONS: TrainingCompletion[] = [];

export function TrainingDataProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { authStatus, authRole, authUser, providerAccountCode, roleStatus } = useSession();
  const canEdit = authStatus === 'signed-in' && authRole === 'hq_admin';
  const canAddStaff =
    authStatus === 'signed-in' && (authRole === 'hq_admin' || authRole === 'provider_staff');

  // Row-level security widens/narrows what the snapshot can see as auth
  // changes (e.g. provider staff gain their office's non-demo rows), so the
  // cache is PARTITIONED by auth scope: each scope (user + role + office) gets
  // its own snapshot entry, and one scope's rows can never be served to
  // another — including across provider remounts (sign-out → sign-in), where
  // an in-place invalidation would never fire.
  const authUserId = authUser?.id ?? null;
  const authScopeKey = `${authUserId ?? 'anon'}:${authRole ?? 'none'}:${providerAccountCode ?? ''}`;
  // Fetch only once auth has settled (session + profile resolved): the scope
  // key is meaningless mid-boot, and gating here means the boot sequence runs
  // exactly one fetch instead of one per transition (anon → role → office).
  const scopeSettled =
    authStatus !== 'loading' &&
    (authStatus !== 'signed-in' || roleStatus === 'ready' || roleStatus === 'error');
  // Signed-out visitors only see the seeded demo learners, so without demo
  // entry they get the catalog alone (fetchSnapshot).
  const includePeople = authStatus === 'signed-in' || demoEntryEnabled;
  const query = useQuery({
    queryKey: [...TRAINING_QUERY_KEY, authScopeKey, includePeople ? 'people' : 'catalog'],
    queryFn: () => fetchSnapshot(includePeople),
    enabled: supabase !== null && scopeSettled,
    staleTime: 30_000,
  });

  const courses = query.data?.courses ?? EMPTY_COURSES;
  const viewers = query.data?.viewers ?? EMPTY_VIEWERS;
  const completions = query.data?.completions ?? EMPTY_COMPLETIONS;

  const status: TrainingStatus = !supabase ? 'error' : query.isError ? 'error' : query.data ? 'ready' : 'loading';
  const errorMessage = !supabase
    ? 'The database is not configured for this environment.'
    : query.isError
      ? query.error instanceof Error
        ? query.error.message
        : 'Could not load training data.'
      : null;

  const refresh = useCallback(() => {
    void query.refetch();
  }, [query.refetch]);

  const completionIndex = useMemo(() => buildCompletionIndex(completions), [completions]);

  const flagshipCourse = useMemo(
    () => courses.find((course) => course.status === 'live') ?? courses[0] ?? null,
    [courses],
  );

  const myViewer = useMemo(
    () => (authUserId ? (viewers.find((viewer) => viewer.authUserId === authUserId) ?? null) : null),
    [viewers, authUserId],
  );

  const findCourse = useCallback(
    (courseId: string | undefined) => courses.find((course) => course.id === courseId),
    [courses],
  );

  const locateVideo = useCallback(
    (courseId: string | undefined, videoId: string | undefined): VideoLocation | null => {
      const course = courses.find((item) => item.id === courseId);
      if (!course || !videoId) return null;
      return findVideoInCourse(course, videoId);
    },
    [courses],
  );

  // Real accounts are told what their sign-in can't do; only the signed-out
  // development demo hears about the demo persona.
  const signedIn = authStatus === 'signed-in';
  const notifyReadOnly = useCallback(() => {
    toast(
      signedIn
        ? {
            title: 'You can’t make this change',
            description: 'Your sign-in can view training but not edit it. Only THINNR HQ admins can author training.',
          }
        : {
            title: 'Sign in to make changes',
            description: 'The demo persona can browse training, but authoring needs a real THINNR HQ sign-in.',
          },
    );
  }, [signedIn]);

  /** Run a write, refresh the snapshot, surface failures as a toast. */
  const runWrite = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T | null> => {
      try {
        const result = await operation();
        await queryClient.invalidateQueries({ queryKey: TRAINING_QUERY_KEY });
        return result;
      } catch (error) {
        toast({
          title: 'Change not saved',
          description: error instanceof Error ? error.message : 'Unexpected database error.',
          variant: 'destructive',
        });
        return null;
      }
    },
    [queryClient],
  );

  /** Same as runWrite, but blocked (with the nudge) for demo personas. */
  const authorWrite = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T | null> => {
      if (!canEdit) {
        notifyReadOnly();
        return null;
      }
      return runWrite(operation);
    },
    [canEdit, notifyReadOnly, runWrite],
  );

  /** Like authorWrite, but for actions any signed-in staffer may take. */
  const staffWrite = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T | null> => {
      if (!canAddStaff) {
        toast(
          signedIn
            ? {
                title: 'You can’t make this change',
                description: 'Your sign-in can view this office’s training but not change it.',
              }
            : {
                title: 'Sign in to make changes',
                description: 'The demo persona can browse training, but staff actions need a real staff sign-in.',
              },
        );
        return null;
      }
      return runWrite(operation);
    },
    [canAddStaff, runWrite, signedIn],
  );

  // -------------------------------------------------------------------------
  // Authoring mutations (RLS mirrors the canEdit gate server-side)
  // -------------------------------------------------------------------------

  const addCourse = useCallback<TrainingDataValue['addCourse']>(
    (input) =>
      authorWrite(async () => {
        const client = requireClient();
        const slug = nextFreeSlug(input.title, new Set(courses.map((course) => course.slug)));
        const courseRow = unwrap(
          await client
            .from('training_courses')
            .insert({ slug, title: input.title, description: input.description, status: 'draft', sequential_unlock: true })
            .select('*')
            .single<TrainingCourseRow>(),
        );
        // Every course starts with a module so the editor has somewhere to add videos.
        const moduleRow = unwrap(
          await client
            .from('training_modules')
            .insert({ course_id: courseRow.id, title: 'Module 1', published: 'published', unlock_mode: 'sequential', position: 0 })
            .select('*')
            .single<TrainingModuleRow>(),
        );
        return assembleCourses({ courses: [courseRow], modules: [moduleRow], subgroups: [], videos: [] })[0]!;
      }),
    [authorWrite, courses],
  );

  const updateCourse = useCallback<TrainingDataValue['updateCourse']>(
    async (courseId, patch) => {
      const row: Record<string, unknown> = {};
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.description !== undefined) row.description = patch.description;
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.sequentialUnlock !== undefined) row.sequential_unlock = patch.sequentialUnlock;
      if (Object.keys(row).length === 0) return true;
      const landed = await authorWrite(async () => {
        assertOk((await requireClient().from('training_courses').update(row).eq('id', courseId)).error);
      });
      return landed !== null;
    },
    [authorWrite],
  );

  const addModule = useCallback<TrainingDataValue['addModule']>(
    async (courseId, title) => {
      const course = findCourse(courseId);
      const position = course ? course.modules.length : 0;
      const landed = await authorWrite(async () => {
        assertOk(
          (
            await requireClient()
              .from('training_modules')
              .insert({ course_id: courseId, title, published: 'published', unlock_mode: 'sequential', position })
          ).error,
        );
      });
      return landed !== null;
    },
    [authorWrite, findCourse],
  );

  const updateModule = useCallback<TrainingDataValue['updateModule']>(
    async (_courseId, moduleId, patch) => {
      const row: Record<string, unknown> = {};
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.published !== undefined) row.published = patch.published;
      if (patch.unlock !== undefined) row.unlock_mode = patch.unlock;
      if (Object.keys(row).length === 0) return true;
      const landed = await authorWrite(async () => {
        assertOk((await requireClient().from('training_modules').update(row).eq('id', moduleId)).error);
      });
      return landed !== null;
    },
    [authorWrite],
  );

  const removeModule = useCallback<TrainingDataValue['removeModule']>(
    async (courseId, moduleId) => {
      const course = findCourse(courseId);
      const doomed = course
        ? getOrderedVideos(course, false)
            .filter((item) => item.module.id === moduleId)
            .map((item) => item.video)
        : [];
      const landed = await authorWrite(async () => {
        // The row delete below cascades every video row in the module, so
        // their hosted files and attachments must come out of storage FIRST —
        // a refused storage delete throws here and keeps all rows as the
        // retry handle instead of stranding unreferenced objects.
        await purgeVideosMedia(doomed, hostedMediaPurge);
        const client = requireClient();
        // Cascades sub-groups, videos, and their completion rows.
        assertOk((await client.from('training_modules').delete().eq('id', moduleId)).error);
        if (course) {
          const after = { ...course, modules: course.modules.filter((module) => module.id !== moduleId) };
          await syncPlacements(client, collectPlacements(course), collectPlacements(after));
        }
      });
      return landed !== null;
    },
    [authorWrite, findCourse],
  );

  const addSubgroup = useCallback<TrainingDataValue['addSubgroup']>(
    async (courseId, moduleId, title) => {
      const course = findCourse(courseId);
      const module = course?.modules.find((item) => item.id === moduleId);
      const position = module ? module.entries.length : 0;
      const landed = await authorWrite(async () => {
        assertOk(
          (
            await requireClient()
              .from('training_subgroups')
              .insert({ module_id: moduleId, title, published: 'published', unlock_mode: 'free', position })
          ).error,
        );
      });
      return landed !== null;
    },
    [authorWrite, findCourse],
  );

  const updateSubgroup = useCallback<TrainingDataValue['updateSubgroup']>(
    async (_courseId, subgroupId, patch) => {
      const row: Record<string, unknown> = {};
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.published !== undefined) row.published = patch.published;
      if (patch.unlock !== undefined) row.unlock_mode = patch.unlock;
      if (Object.keys(row).length === 0) return true;
      const landed = await authorWrite(async () => {
        assertOk((await requireClient().from('training_subgroups').update(row).eq('id', subgroupId)).error);
      });
      return landed !== null;
    },
    [authorWrite],
  );

  const removeSubgroup = useCallback<TrainingDataValue['removeSubgroup']>(
    async (courseId, subgroupId) => {
      const course = findCourse(courseId);
      if (!course) return false;
      // The editor promises deleting a sub-group keeps its videos: they slide
      // back to the module level, in place, in their old order.
      const after = removeSubgroupKeepVideos(course, subgroupId);
      const landed = await authorWrite(async () => {
        const client = requireClient();
        await syncPlacements(client, collectPlacements(course), collectPlacements(after));
        assertOk((await client.from('training_subgroups').delete().eq('id', subgroupId)).error);
      });
      return landed !== null;
    },
    [authorWrite, findCourse],
  );

  const addVideo = useCallback<TrainingDataValue['addVideo']>(
    (courseId, target, title) =>
      authorWrite(async () => {
        const course = findCourse(courseId);
        const module = course?.modules.find((item) => item.id === target.moduleId);
        const subgroup = target.subgroupId
          ? module?.entries.find(
              (entry) => entry.kind === 'subgroup' && entry.subgroup.id === target.subgroupId,
            )
          : undefined;
        const position =
          target.subgroupId && subgroup?.kind === 'subgroup'
            ? subgroup.subgroup.videos.length
            : (module?.entries.length ?? 0);
        const defaults = buildNewVideoDefaults(title, crypto.randomUUID().slice(0, 8));
        const row = unwrap(
          await requireClient()
            .from('training_videos')
            .insert({
              module_id: target.moduleId,
              subgroup_id: target.subgroupId ?? null,
              title: defaults.title,
              duration_seconds: defaults.duration,
              published: defaults.published,
              unlock_mode: defaults.unlock,
              add_staff: defaults.addStaff,
              description: defaults.description,
              chapters: defaults.chapters,
              thumbnail_chapter: defaults.thumbnailChapter,
              attachments: defaults.attachments,
              position,
            })
            .select('*')
            .single<TrainingVideoRow>(),
        );
        return mapVideoRow(row);
      }),
    [authorWrite, findCourse],
  );

  const updateVideo = useCallback<TrainingDataValue['updateVideo']>(
    async (_courseId, videoId, patch) => {
      const row: Record<string, unknown> = {};
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.description !== undefined) row.description = patch.description;
      if (patch.duration !== undefined) row.duration_seconds = Math.max(0, Math.round(patch.duration));
      if (patch.published !== undefined) row.published = patch.published;
      if (patch.unlock !== undefined) row.unlock_mode = patch.unlock;
      if (patch.addStaff !== undefined) row.add_staff = patch.addStaff;
      if (patch.chapters !== undefined) row.chapters = patch.chapters;
      if (patch.thumbnailChapter !== undefined) row.thumbnail_chapter = patch.thumbnailChapter;
      if (Object.keys(row).length === 0) return true;
      const landed = await authorWrite(async () => {
        assertOk((await requireClient().from('training_videos').update(row).eq('id', videoId)).error);
      });
      return landed !== null;
    },
    [authorWrite],
  );

  const moveVideo = useCallback<TrainingDataValue['moveVideo']>(
    async (courseId, videoId, direction) => {
      const course = findCourse(courseId);
      if (!course) return false;
      const after = moveVideoInCourse(course, videoId, direction);
      if (after === course) return false; // Already at the boundary.
      const landed = await authorWrite(() => syncPlacements(requireClient(), collectPlacements(course), collectPlacements(after)));
      return landed !== null;
    },
    [authorWrite, findCourse],
  );

  const moveVideoToContainer = useCallback<TrainingDataValue['moveVideoToContainer']>(
    async (courseId, videoId, target) => {
      const course = findCourse(courseId);
      if (!course) return false;
      const after = moveVideoToContainerInCourse(course, videoId, target);
      if (after === course) return false; // Already in that container.
      const landed = await authorWrite(() => syncPlacements(requireClient(), collectPlacements(course), collectPlacements(after)));
      return landed !== null;
    },
    [authorWrite, findCourse],
  );

  const removeVideo = useCallback<TrainingDataValue['removeVideo']>(
    async (courseId, videoId) => {
      const course = findCourse(courseId);
      const doomed = course
        ? getOrderedVideos(course, false)
            .filter((item) => item.video.id === videoId)
            .map((item) => item.video)
        : [];
      const landed = await authorWrite(async () => {
        // Hosted file and attachments come out of storage BEFORE the row —
        // every delete entry point (editor danger zone, course quick-remove)
        // rides this one path. A refused storage delete throws, keeping the
        // row as the retry handle so no object is ever orphaned.
        await purgeVideosMedia(doomed, hostedMediaPurge);
        const client = requireClient();
        // Cascades the video's completion rows; counts are always re-derived
        // against the current published order, so no reconciliation needed.
        assertOk((await client.from('training_videos').delete().eq('id', videoId)).error);
        if (course) {
          const after = stripVideoFromCourse(course, videoId);
          await syncPlacements(client, collectPlacements(course), collectPlacements(after));
        }
      });
      return landed !== null;
    },
    [authorWrite, findCourse],
  );

  const assignViewerAccount = useCallback<TrainingDataValue['assignViewerAccount']>(
    async (viewerId, accountId) => {
      await authorWrite(async () => {
        assertOk((await requireClient().from('training_viewers').update({ account_id: accountId }).eq('id', viewerId)).error);
      });
    },
    [authorWrite],
  );

  // -------------------------------------------------------------------------
  // Learner flows — SECURITY DEFINER RPCs keyed by an opaque session token.
  // Open to the demo/anon session; a caller can only ever act as (and see)
  // the registration whose token it holds.
  // -------------------------------------------------------------------------

  const registerLearner = useCallback<TrainingDataValue['registerLearner']>(
    (email) =>
      runWrite(async () => {
        const payload = unwrap(
          await requireClient().rpc('training_register_viewer', { p_email: email.trim().toLowerCase() }),
        ) as { viewer: TrainingViewerRow; token: string; completions: TrainingCompletionRow[] };
        return {
          viewer: mapViewerRow(payload.viewer),
          token: payload.token,
          completions: (payload.completions ?? []).map(mapCompletionRow),
        };
      }),
    [runWrite],
  );

  const fetchLearnerState = useCallback<TrainingDataValue['fetchLearnerState']>(async (token) => {
    try {
      const payload = unwrap(await requireClient().rpc('training_learner_state', { p_token: token })) as {
        viewer: TrainingViewerRow;
        completions: TrainingCompletionRow[];
      };
      return {
        viewer: mapViewerRow(payload.viewer),
        token,
        completions: (payload.completions ?? []).map(mapCompletionRow),
      };
    } catch {
      // Stale or revoked token (or a transient failure): callers fall back to
      // the email gate, which mints a fresh session.
      return null;
    }
  }, []);

  const inviteStaff = useCallback<TrainingDataValue['inviteStaff']>(
    async (token, email) => {
      const result = await runWrite(async () => {
        assertOk(
          (
            await requireClient().rpc('training_invite_staff', {
              p_token: token,
              p_email: email.trim().toLowerCase(),
            })
          ).error,
        );
        return true;
      });
      return result === true;
    },
    [runWrite],
  );

  const markVideoComplete = useCallback<TrainingDataValue['markVideoComplete']>(
    (token, videoId) =>
      runWrite(async () => {
        const row = unwrap(
          await requireClient().rpc('training_mark_video_complete', { p_token: token, p_video_id: videoId }),
        ) as TrainingCompletionRow;
        return mapCompletionRow(row);
      }),
    [runWrite],
  );

  // -------------------------------------------------------------------------
  // Signed-in staff flows — auth.uid()-keyed RPCs (no tokens involved).
  // -------------------------------------------------------------------------

  const addStaffMember = useCallback<TrainingDataValue['addStaffMember']>(
    (accountId, input) =>
      staffWrite(async () => {
        const payload = unwrap(
          await requireClient().rpc('training_add_staff', {
            p_account_id: accountId,
            p_name: input.name.trim(),
            p_email: input.email.trim().toLowerCase(),
          }),
        ) as { viewer: TrainingViewerRow };
        return mapViewerRow(payload.viewer);
      }),
    [staffWrite],
  );

  const markMyVideoComplete = useCallback<TrainingDataValue['markMyVideoComplete']>(
    (videoId) =>
      staffWrite(async () => {
        const row = unwrap(
          await requireClient().rpc('training_mark_video_complete_self', { p_video_id: videoId }),
        ) as TrainingCompletionRow;
        return mapCompletionRow(row);
      }),
    [staffWrite],
  );

  const value = useMemo<TrainingDataValue>(
    () => ({
      status,
      errorMessage,
      refresh,
      canEdit,
      canAddStaff,
      myViewer,
      courses,
      viewers,
      completions,
      completionIndex,
      flagshipCourse,
      findCourse,
      locateVideo,
      addCourse,
      updateCourse,
      addModule,
      updateModule,
      removeModule,
      addSubgroup,
      updateSubgroup,
      removeSubgroup,
      addVideo,
      updateVideo,
      moveVideo,
      moveVideoToContainer,
      removeVideo,
      assignViewerAccount,
      registerLearner,
      fetchLearnerState,
      inviteStaff,
      markVideoComplete,
      addStaffMember,
      markMyVideoComplete,
    }),
    [
      status,
      errorMessage,
      refresh,
      canEdit,
      canAddStaff,
      myViewer,
      courses,
      viewers,
      completions,
      completionIndex,
      flagshipCourse,
      findCourse,
      locateVideo,
      addCourse,
      updateCourse,
      addModule,
      updateModule,
      removeModule,
      addSubgroup,
      updateSubgroup,
      removeSubgroup,
      addVideo,
      updateVideo,
      moveVideo,
      moveVideoToContainer,
      removeVideo,
      assignViewerAccount,
      registerLearner,
      fetchLearnerState,
      inviteStaff,
      markVideoComplete,
      addStaffMember,
      markMyVideoComplete,
    ],
  );

  return <TrainingDataContext.Provider value={value}>{children}</TrainingDataContext.Provider>;
}

export function useTrainingData() {
  const context = useContext(TrainingDataContext);
  if (!context) throw new Error('useTrainingData must be used within TrainingDataProvider');
  return context;
}
