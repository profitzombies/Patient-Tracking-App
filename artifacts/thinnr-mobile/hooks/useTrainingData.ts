/**
 * Live training snapshot for the mobile provider (Care Team) persona.
 *
 * Training is the first provider surface on mobile backed by LIVE data: the
 * snapshot reads the same six Supabase tables as the web operations app and
 * assembles them with the same rules (lib/training.ts), so every number a
 * phone shows agrees with the web portal for the same rows.
 *
 * Read-only by design — no authoring, no mark-complete, no roster writes.
 * RLS only exposes the seeded demo viewers and their completions to this
 * anonymous client, which is exactly what the demo Care Team persona shows.
 *
 * States the screens must handle:
 *   'unconfigured' — the EXPO_PUBLIC_SUPABASE_* env vars are absent, so the
 *                    client is null (lib/supabase.ts). Screens explain that
 *                    training needs configuration instead of crashing.
 *   'loading'      — first fetch in flight.
 *   'error'        — any table failed; screens offer a retry.
 *   'ready'        — assembled snapshot available.
 */
import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import {
  assembleCourses,
  buildCompletionIndex,
  mapCompletionRow,
  mapViewerRow,
  type CompletionIndex,
  type TrainingCompletion,
  type TrainingCompletionRow,
  type TrainingCourse,
  type TrainingCourseRow,
  type TrainingModuleRow,
  type TrainingSubgroupRow,
  type TrainingVideoRow,
  type TrainingViewer,
  type TrainingViewerRow,
} from '@/lib/training';

/**
 * Per-table fetch guard, matching the web portal. PostgREST caps responses
 * at 1000 rows server-side anyway; the demo dataset is far smaller.
 */
const FETCH_LIMIT = 1000;

export interface TrainingSnapshot {
  courses: TrainingCourse[];
  viewers: TrainingViewer[];
  completions: TrainingCompletion[];
}

/** Throw a readable error for any failed PostgREST response. */
function assertOk(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

/**
 * Fetch and assemble the whole training snapshot. Exported with an explicit
 * client parameter so the Node verification suite can drive it with a fake
 * PostgREST client; the hook below always passes the app's real client.
 */
export async function fetchTrainingSnapshot(client: SupabaseClient): Promise<TrainingSnapshot> {
  const [courses, modules, subgroups, videos, viewers, completions] = await Promise.all([
    client.from('training_courses').select('*').order('created_at', { ascending: true }).limit(FETCH_LIMIT),
    client.from('training_modules').select('*').order('position', { ascending: true }).limit(FETCH_LIMIT),
    client.from('training_subgroups').select('*').order('position', { ascending: true }).limit(FETCH_LIMIT),
    client.from('training_videos').select('*').order('position', { ascending: true }).limit(FETCH_LIMIT),
    client.from('training_viewers').select('*').order('first_seen_at', { ascending: true }).limit(FETCH_LIMIT),
    client.from('training_completions').select('*').order('first_watched_at', { ascending: true }).limit(FETCH_LIMIT),
  ]);
  for (const result of [courses, modules, subgroups, videos, viewers, completions]) {
    assertOk(result.error);
  }
  return {
    courses: assembleCourses({
      courses: (courses.data ?? []) as TrainingCourseRow[],
      modules: (modules.data ?? []) as TrainingModuleRow[],
      subgroups: (subgroups.data ?? []) as TrainingSubgroupRow[],
      videos: (videos.data ?? []) as TrainingVideoRow[],
    }),
    viewers: ((viewers.data ?? []) as TrainingViewerRow[]).map(mapViewerRow),
    completions: ((completions.data ?? []) as TrainingCompletionRow[]).map(mapCompletionRow),
  };
}

export type TrainingStatus = 'unconfigured' | 'loading' | 'error' | 'ready';

export interface TrainingData {
  status: TrainingStatus;
  /** Set when status === 'error'. */
  errorMessage: string | null;
  /** Refetch the snapshot (error-state retry button). */
  refresh: () => void;
  courses: TrainingCourse[];
  /** Courses published by THINNR HQ — all any learner surface shows. */
  liveCourses: TrainingCourse[];
  viewers: TrainingViewer[];
  completions: TrainingCompletion[];
  /** viewerId → (videoId → completion row), rebuilt with the snapshot. */
  completionIndex: CompletionIndex;
  findCourse: (courseId: string | undefined) => TrainingCourse | undefined;
}

const EMPTY_COURSES: TrainingCourse[] = [];
const EMPTY_VIEWERS: TrainingViewer[] = [];
const EMPTY_COMPLETIONS: TrainingCompletion[] = [];

/**
 * One shared react-query snapshot (Training home, course outline, and lesson
 * pages all read the same cache entry — one fetch per visit, refreshed after
 * 30s like the web portal). The mobile client is always the anonymous demo
 * scope, so a fixed query key is correct here; there is no staff sign-in on
 * mobile to partition by.
 */
export function useTrainingData(): TrainingData {
  const query = useQuery({
    queryKey: ['mobile-training-data'],
    queryFn: () => fetchTrainingSnapshot(supabase as SupabaseClient),
    enabled: supabase !== null,
    staleTime: 30_000,
  });

  const courses = query.data?.courses ?? EMPTY_COURSES;
  const viewers = query.data?.viewers ?? EMPTY_VIEWERS;
  const completions = query.data?.completions ?? EMPTY_COMPLETIONS;

  const status: TrainingStatus = !supabase
    ? 'unconfigured'
    : query.isError
      ? 'error'
      : query.data
        ? 'ready'
        : 'loading';
  const errorMessage =
    status === 'error'
      ? query.error instanceof Error
        ? query.error.message
        : 'Could not load training data.'
      : null;

  const refresh = useCallback(() => {
    void query.refetch();
  }, [query.refetch]);

  const completionIndex = useMemo(() => buildCompletionIndex(completions), [completions]);

  const liveCourses = useMemo(() => courses.filter(course => course.status === 'live'), [courses]);

  const findCourse = useCallback(
    (courseId: string | undefined) => courses.find(course => course.id === courseId),
    [courses],
  );

  return {
    status,
    errorMessage,
    refresh,
    courses,
    liveCourses,
    viewers,
    completions,
    completionIndex,
    findCourse,
  };
}
