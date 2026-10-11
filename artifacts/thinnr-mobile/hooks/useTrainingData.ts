/**
 * Live training snapshot for the mobile provider (Care Team) persona.
 *
 * Training is the first provider surface on mobile backed by LIVE data: the
 * snapshot reads the same six Supabase tables as the web operations app and
 * assembles them with the same rules (lib/training.ts), so every number a
 * phone shows agrees with the web portal for the same rows.
 *
 * Signed-in provider staff use the same RLS-backed office rows and narrow self-service RPCs as
 * web; patients never receive a private training snapshot.
 *
 * States the screens must handle:
 *   'unconfigured' — the EXPO_PUBLIC_SUPABASE_* env vars are absent, so the
 *                    client is null (lib/supabase.ts). Screens explain that
 *                    training needs configuration instead of crashing.
 *   'loading'      — session, profile, lock, or first fetch in flight.
 *   'signed-out'   — no staff session: nothing is fetched and the screens
 *                    show a sign-in holding card instead of a catalog.
 *   'error'        — any table failed; screens offer a retry.
 *   'ready'        — assembled snapshot available.
 */
import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase, useSupabaseSession } from '@/lib/supabase';
import { useAppMode } from '@/context/AppModeContext';
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
 * at 1000 rows server-side anyway.
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

export type TrainingStatus = 'unconfigured' | 'loading' | 'signed-out' | 'error' | 'ready';

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
  /** null until a signed-in provider's office code resolves. */
  accountId: string | null;
  myViewer: TrainingViewer | null;
  isLiveStaff: boolean;
  isOfficeLocked: boolean;
  addStaffMember: (input: { name: string; email: string }) => Promise<TrainingViewer>;
  markMyVideoComplete: (videoId: string) => Promise<TrainingCompletion>;
  findCourse: (courseId: string | undefined) => TrainingCourse | undefined;
}

const EMPTY_COURSES: TrainingCourse[] = [];
const EMPTY_VIEWERS: TrainingViewer[] = [];
const EMPTY_COMPLETIONS: TrainingCompletion[] = [];

/**
 * One shared react-query snapshot (Training home, course outline, and lesson
 * pages read one auth-scoped cache entry, refreshed after 30s like the web
 * portal). Signed-in providers receive only the office rows allowed by RLS.
 * Nothing is requested — not even the profile lookup — until a session
 * exists, and the snapshot query stays disabled until that session resolves
 * to an unlocked provider_staff account.
 */
export function useTrainingData(): TrainingData {
  const queryClient = useQueryClient();
  const { hydrated: modeHydrated } = useAppMode();
  const { session, sessionLoading } = useSupabaseSession();
  const userId = session?.user.id ?? null;
  const profileQuery = useQuery({
    queryKey: ['mobile-training-profile', userId ?? 'anon'],
    queryFn: async () => {
      const result = await (supabase as SupabaseClient)
        .from('profiles')
        .select('role, provider_account_code')
        .eq('id', userId!)
        .maybeSingle();
      assertOk(result.error);
      return result.data as { role: string; provider_account_code: string | null } | null;
    },
    enabled: Boolean(supabase && userId),
    staleTime: 30_000,
  });
  const profileSettled = !userId || profileQuery.isSuccess || profileQuery.isError;
  const role = profileQuery.data?.role ?? null;
  const accountId = role === 'provider_staff' ? profileQuery.data?.provider_account_code ?? null : null;
  // This table is intentionally world-readable: lock state gates every
  // provider surface before its office snapshot can be requested.
  const lockQuery = useQuery({
    queryKey: ['mobile-training-office-lock', accountId ?? 'none'],
    queryFn: async () => {
      const result = await (supabase as SupabaseClient)
        .from('provider_account_locks')
        .select('account_id')
        .eq('account_id', accountId!)
        .maybeSingle();
      assertOk(result.error);
      return result.data;
    },
    enabled: Boolean(supabase && userId && role === 'provider_staff' && accountId),
    staleTime: 30_000,
  });
  const lockSettled = !accountId || lockQuery.isSuccess || lockQuery.isError;
  const isOfficeLocked = Boolean(lockQuery.data);
  const isLiveStaff = Boolean(
    userId && role === 'provider_staff' && accountId && lockQuery.isSuccess && !isOfficeLocked,
  );
  // The snapshot is private: only a resolved, unlocked provider_staff session
  // may request it. Signed-out mounts issue zero Supabase calls.
  const permitted = isLiveStaff;
  const authScopeKey = `${userId ?? 'anon'}:${role ?? 'none'}:${accountId ?? ''}:locked=${isOfficeLocked}`;
  const query = useQuery({
    queryKey: ['mobile-training-data', authScopeKey],
    queryFn: () => fetchTrainingSnapshot(supabase as SupabaseClient),
    enabled: Boolean(supabase && modeHydrated && !sessionLoading && profileSettled && lockSettled && permitted),
    staleTime: 30_000,
  });

  const courses = query.data?.courses ?? EMPTY_COURSES;
  const viewers = query.data?.viewers ?? EMPTY_VIEWERS;
  const completions = query.data?.completions ?? EMPTY_COMPLETIONS;

  const status: TrainingStatus = !supabase
    ? 'unconfigured'
    : !modeHydrated || sessionLoading || !profileSettled || !lockSettled
      ? 'loading'
      : !userId
        ? 'signed-out'
      : !permitted
        ? 'error'
    : query.isError
      ? 'error'
      : query.data
        ? 'ready'
        : 'loading';
  const errorMessage =
    status === 'error' && isOfficeLocked
      ? 'This office is locked by THINNR. Contact THINNR to restore training access.'
      : status === 'error' && !permitted
      ? 'Training is private to signed-in provider staff. Sign in with an office account to continue.'
      : status === 'error'
      ? query.error instanceof Error
        ? query.error.message
        : 'Could not load training data.'
      : null;

  const refresh = useCallback(() => {
    if (userId) void profileQuery.refetch();
    if (accountId) void lockQuery.refetch();
    if (permitted) void query.refetch();
  }, [accountId, lockQuery.refetch, permitted, profileQuery.refetch, query.refetch, userId]);

  const completionIndex = useMemo(() => buildCompletionIndex(completions), [completions]);

  const liveCourses = useMemo(() => courses.filter(course => course.status === 'live'), [courses]);
  const myViewer = useMemo(
    () => (userId ? viewers.find(viewer => viewer.authUserId === userId) ?? null : null),
    [userId, viewers],
  );

  const addStaffMember = useCallback(async (input: { name: string; email: string }) => {
    if (!supabase || !isLiveStaff || !accountId) {
      throw new Error(isOfficeLocked ? 'This office is locked by THINNR.' : 'Sign in with an office account to add teammates.');
    }
    const result = await supabase.rpc('training_add_staff', {
      p_account_id: accountId,
      p_name: input.name.trim(),
      p_email: input.email.trim().toLowerCase(),
    });
    assertOk(result.error);
    const payload = result.data as { viewer: TrainingViewerRow } | null;
    if (!payload?.viewer) throw new Error('The database returned no teammate.');
    await queryClient.invalidateQueries({ queryKey: ['mobile-training-data'] });
    return mapViewerRow(payload.viewer);
  }, [accountId, isLiveStaff, isOfficeLocked, queryClient]);

  const markMyVideoComplete = useCallback(async (videoId: string) => {
    if (!supabase || !isLiveStaff || !myViewer) {
      throw new Error(isOfficeLocked ? 'This office is locked by THINNR.' : 'Your office sign-in is not linked to a training learner.');
    }
    const result = await supabase.rpc('training_mark_video_complete_self', { p_video_id: videoId });
    assertOk(result.error);
    if (!result.data) throw new Error('The database returned no completion.');
    await queryClient.invalidateQueries({ queryKey: ['mobile-training-data'] });
    return mapCompletionRow(result.data as TrainingCompletionRow);
  }, [isLiveStaff, isOfficeLocked, myViewer, queryClient]);

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
    accountId,
    myViewer,
    isLiveStaff,
    isOfficeLocked,
    addStaffMember,
    markMyVideoComplete,
    findCourse,
  };
}
