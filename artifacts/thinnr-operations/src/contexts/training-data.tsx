/**
 * Session-mutable training portal state: courses and viewers.
 *
 * Same contract as the rest of the HQ demo — there is no server. The seeded
 * catalog from data/hq/training.ts is the initial state; every mutation
 * (authoring edits, publish toggles, viewer assignment, learner-gate
 * sign-ins) produces a structurally-new copy that mirrors into
 * sessionStorage, so the demo persists across reloads in this tab and resets
 * when the tab closes. Unlike hq-data (where seeds are immutable for parity),
 * training data has no cross-app parity constraints, so whole-state
 * copy-on-write is safe and keeps the authoring UX honest.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  FLAGSHIP_COURSE_ID,
  buildNewCourse,
  buildNewModule,
  buildNewVideo,
  SEEDED_COURSES,
  SEEDED_VIEWERS,
  findVideoInCourse,
  hashId,
  type AddStaffMode,
  type ModuleEntry,
  type PublishState,
  type TrainingChapter,
  type TrainingCourse,
  type TrainingModule,
  type TrainingSubgroup,
  type TrainingVideo,
  type TrainingViewer,
  type UnlockMode,
  type VideoLocation,
} from '@/data/hq/training';
import { TODAY_KEY } from '@/data/nutrition-data';

const STORAGE_KEY = 'thinnr-hq-training-v1';

interface StoredTrainingState {
  courses: TrainingCourse[];
  viewers: TrainingViewer[];
}

function readStoredState(): StoredTrainingState {
  const fallback: StoredTrainingState = { courses: SEEDED_COURSES, viewers: SEEDED_VIEWERS };
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredTrainingState>;
    if (!Array.isArray(parsed.courses) || parsed.courses.length === 0) return fallback;
    if (!Array.isArray(parsed.viewers) || parsed.viewers.length === 0) return fallback;
    return { courses: parsed.courses as TrainingCourse[], viewers: parsed.viewers as TrainingViewer[] };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Pure course-transform helpers (structural copies, JSON-safe)
// ---------------------------------------------------------------------------

const mapCourse = (courses: TrainingCourse[], courseId: string, fn: (course: TrainingCourse) => TrainingCourse) =>
  courses.map((course) => (course.id === courseId ? fn(course) : course));

const mapModule = (course: TrainingCourse, moduleId: string, fn: (module: TrainingModule) => TrainingModule): TrainingCourse => ({
  ...course,
  modules: course.modules.map((module) => (module.id === moduleId ? fn(module) : module)),
});

const mapSubgroup = (course: TrainingCourse, subgroupId: string, fn: (subgroup: TrainingSubgroup) => TrainingSubgroup): TrainingCourse => ({
  ...course,
  modules: course.modules.map((module) => ({
    ...module,
    entries: module.entries.map((entry) =>
      entry.kind === 'subgroup' && entry.subgroup.id === subgroupId ? { kind: 'subgroup', subgroup: fn(entry.subgroup) } : entry,
    ),
  })),
});

const mapVideo = (course: TrainingCourse, videoId: string, fn: (video: TrainingVideo) => TrainingVideo): TrainingCourse => ({
  ...course,
  modules: course.modules.map((module) => ({
    ...module,
    entries: module.entries.map((entry) =>
      entry.kind === 'video'
        ? entry.video.id === videoId
          ? { kind: 'video', video: fn(entry.video) }
          : entry
        : {
            kind: 'subgroup',
            subgroup: {
              ...entry.subgroup,
              videos: entry.subgroup.videos.map((videoItem) => (videoItem.id === videoId ? fn(videoItem) : videoItem)),
            },
          },
    ),
  })),
});

const stripVideo = (course: TrainingCourse, videoId: string): TrainingCourse => ({
  ...course,
  modules: course.modules.map((module) => ({
    ...module,
    entries: module.entries
      .filter((entry) => !(entry.kind === 'video' && entry.video.id === videoId))
      .map((entry) =>
        entry.kind === 'subgroup'
          ? { kind: 'subgroup' as const, subgroup: { ...entry.subgroup, videos: entry.subgroup.videos.filter((videoItem) => videoItem.id !== videoId) } }
          : entry,
      ),
  })),
});

/** All video ids in a course list (uniqueness scans for new ids). */
function allIds(courses: TrainingCourse[]): Set<string> {
  const ids = new Set<string>();
  for (const course of courses) {
    ids.add(course.id);
    for (const module of course.modules) {
      ids.add(module.id);
      for (const entry of module.entries) {
        if (entry.kind === 'video') ids.add(entry.video.id);
        else {
          ids.add(entry.subgroup.id);
          for (const videoItem of entry.subgroup.videos) ids.add(videoItem.id);
        }
      }
    }
  }
  return ids;
}

function nextId(prefix: string, taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const candidate = `${prefix}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Move a video one step through the course's flattened admin order. The
 * entry/subgroup structure stays fixed; the ordered video list is permuted
 * and refilled slot by slot — so an "up" at a boundary slides the video into
 * the neighboring sub-group or module, exactly like a small drag would.
 */
function moveVideoInCourse(course: TrainingCourse, videoId: string, direction: 'up' | 'down'): TrainingCourse {
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


// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface VideoPatch {
  title?: string;
  description?: string[];
  published?: PublishState;
  unlock?: UnlockMode;
  addStaff?: AddStaffMode;
  chapters?: TrainingChapter[];
  thumbnailChapter?: number;
  attachments?: TrainingVideo['attachments'];
}

interface TrainingDataValue {
  courses: TrainingCourse[];
  viewers: TrainingViewer[];
  /** The live flagship course (falls back to the first course). */
  flagshipCourse: TrainingCourse;
  findCourse: (courseId: string | undefined) => TrainingCourse | undefined;
  locateVideo: (courseId: string | undefined, videoId: string | undefined) => VideoLocation | null;

  addCourse: (input: { title: string; description: string }) => TrainingCourse;
  updateCourse: (courseId: string, patch: Partial<Pick<TrainingCourse, 'title' | 'description' | 'status' | 'sequentialUnlock'>>) => void;

  addModule: (courseId: string, title: string) => void;
  updateModule: (courseId: string, moduleId: string, patch: Partial<Pick<TrainingModule, 'title' | 'published' | 'unlock'>>) => void;
  removeModule: (courseId: string, moduleId: string) => void;

  addSubgroup: (courseId: string, moduleId: string, title: string) => void;
  updateSubgroup: (courseId: string, subgroupId: string, patch: Partial<Pick<TrainingSubgroup, 'title' | 'published' | 'unlock'>>) => void;
  removeSubgroup: (courseId: string, subgroupId: string) => void;

  /** New videos land as drafts with an "auto-encoded" duration and AI-seeded chapters. */
  addVideo: (courseId: string, target: { moduleId: string; subgroupId?: string | null }, title: string) => TrainingVideo;
  updateVideo: (courseId: string, videoId: string, patch: VideoPatch) => void;
  moveVideo: (courseId: string, videoId: string, direction: 'up' | 'down') => void;
  /** Reassign a video's sub-group (or none) within its module — the editor's SUB-GROUP dropdown. */
  moveVideoToContainer: (courseId: string, videoId: string, target: { moduleId: string; subgroupId: string | null }) => void;
  /** Danger zone: removes the video and its chapters/attachments permanently. */
  removeVideo: (courseId: string, videoId: string) => void;

  assignViewerAccount: (viewerId: string, accountId: string | null) => void;
  /** Email gate on the learner view — returns the existing viewer for a repeat email. */
  addViewerFromGate: (email: string) => TrainingViewer;
  /** Learner "Add your staff" — creates a teammate viewer linked to the inviter (dedupes by email). */
  inviteStaff: (staffOfViewerId: string, email: string) => TrainingViewer;
  /** Learner preview progress ("mark complete & continue"). */
  markVideoComplete: (viewerId: string, videoId: string) => void;
}

const TrainingDataContext = createContext<TrainingDataValue | null>(null);

export function TrainingDataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoredTrainingState>(readStoredState);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage may be unavailable; in-memory state still works.
    }
  }, [state]);

  const findCourse = useCallback(
    (courseId: string | undefined) => state.courses.find((course) => course.id === courseId),
    [state.courses],
  );

  const locateVideo = useCallback(
    (courseId: string | undefined, videoId: string | undefined): VideoLocation | null => {
      const course = state.courses.find((item) => item.id === courseId);
      if (!course || !videoId) return null;
      return findVideoInCourse(course, videoId);
    },
    [state.courses],
  );

  const addCourse = useCallback((input: { title: string; description: string }): TrainingCourse => {
    // Built OUTSIDE setState: React may defer functional updaters, so a value
    // smuggled out of one is not reliably populated when this returns.
    const course = buildNewCourse(state.courses, input);
    setState((current) => ({ ...current, courses: [...current.courses, course] }));
    return course;
  }, [state.courses]);

  const updateCourse = useCallback<TrainingDataValue['updateCourse']>((courseId, patch) => {
    setState((current) => ({ ...current, courses: mapCourse(current.courses, courseId, (course) => ({ ...course, ...patch })) }));
  }, []);

  const addModule = useCallback<TrainingDataValue['addModule']>((courseId, title) => {
    const module = buildNewModule(state.courses, title);
    setState((current) => ({
      ...current,
      courses: mapCourse(current.courses, courseId, (course) => ({
        ...course,
        modules: [...course.modules, module],
      })),
    }));
  }, [state.courses]);

  const updateModule = useCallback<TrainingDataValue['updateModule']>((courseId, moduleId, patch) => {
    setState((current) => ({
      ...current,
      courses: mapCourse(current.courses, courseId, (course) => mapModule(course, moduleId, (module) => ({ ...module, ...patch }))),
    }));
  }, []);

  const removeModule = useCallback<TrainingDataValue['removeModule']>((courseId, moduleId) => {
    setState((current) => ({
      ...current,
      courses: mapCourse(current.courses, courseId, (course) => ({
        ...course,
        modules: course.modules.filter((module) => module.id !== moduleId),
      })),
    }));
  }, []);

  const addSubgroup = useCallback<TrainingDataValue['addSubgroup']>((courseId, moduleId, title) => {
    setState((current) => ({
      ...current,
      courses: mapCourse(current.courses, courseId, (course) =>
        mapModule(course, moduleId, (module) => {
          const taken = allIds(current.courses);
          return {
            ...module,
            entries: [
              ...module.entries,
              {
                kind: 'subgroup',
                subgroup: { id: nextId('sg-new', taken), title, published: 'published', unlock: 'free', videos: [] },
              },
            ],
          };
        }),
      ),
    }));
  }, []);

  const updateSubgroup = useCallback<TrainingDataValue['updateSubgroup']>((courseId, subgroupId, patch) => {
    setState((current) => ({
      ...current,
      courses: mapCourse(current.courses, courseId, (course) => mapSubgroup(course, subgroupId, (subgroup) => ({ ...subgroup, ...patch }))),
    }));
  }, []);

  const removeSubgroup = useCallback<TrainingDataValue['removeSubgroup']>((courseId, subgroupId) => {
    setState((current) => ({
      ...current,
      courses: mapCourse(current.courses, courseId, (course) => ({
        ...course,
        modules: course.modules.map((module) => ({
          ...module,
          // The editor promises deleting a sub-group keeps its videos: they
          // slide back to the module level, in place, in their old order.
          entries: module.entries.flatMap((entry) =>
            entry.kind === 'subgroup' && entry.subgroup.id === subgroupId
              ? entry.subgroup.videos.map((video) => ({ kind: 'video' as const, video }))
              : [entry],
          ),
        })),
      })),
    }));
  }, []);

  const addVideo = useCallback<TrainingDataValue['addVideo']>((courseId, target, title) => {
    // Same rule as addCourse: build first, then insert.
    const video = buildNewVideo(state.courses, title);
    setState((current) => ({
      ...current,
      courses: mapCourse(current.courses, courseId, (course) => {
        if (target.subgroupId) {
          return mapSubgroup(course, target.subgroupId, (subgroup) => ({ ...subgroup, videos: [...subgroup.videos, video] }));
        }
        return mapModule(course, target.moduleId, (module) => ({
          ...module,
          entries: [...module.entries, { kind: 'video', video }],
        }));
      }),
    }));
    return video;
  }, [state.courses]);

  const updateVideo = useCallback<TrainingDataValue['updateVideo']>((courseId, videoId, patch) => {
    setState((current) => ({
      ...current,
      courses: mapCourse(current.courses, courseId, (course) => mapVideo(course, videoId, (video) => ({ ...video, ...patch }))),
    }));
  }, []);

  const moveVideo = useCallback<TrainingDataValue['moveVideo']>((courseId, videoId, direction) => {
    setState((current) => ({
      ...current,
      courses: mapCourse(current.courses, courseId, (course) => moveVideoInCourse(course, videoId, direction)),
    }));
  }, []);

  const moveVideoToContainer = useCallback<TrainingDataValue['moveVideoToContainer']>((courseId, videoId, target) => {
    setState((current) => ({
      ...current,
      courses: mapCourse(current.courses, courseId, (course) => {
        const located = findVideoInCourse(course, videoId);
        if (!located) return course;
        const without = stripVideo(course, videoId);
        if (target.subgroupId) {
          return mapSubgroup(without, target.subgroupId, (subgroup) => ({ ...subgroup, videos: [...subgroup.videos, located.video] }));
        }
        return mapModule(without, target.moduleId, (module) => ({
          ...module,
          entries: [...module.entries, { kind: 'video', video: located.video }],
        }));
      }),
    }));
  }, []);

  const removeVideo = useCallback<TrainingDataValue['removeVideo']>((courseId, videoId) => {
    // No progress reconciliation needed: viewer progress is a set of video
    // ids and every count is derived against the CURRENT published order.
    setState((current) => ({
      ...current,
      courses: mapCourse(current.courses, courseId, (course) => stripVideo(course, videoId)),
    }));
  }, []);

  const assignViewerAccount = useCallback<TrainingDataValue['assignViewerAccount']>((viewerId, accountId) => {
    setState((current) => ({
      ...current,
      viewers: current.viewers.map((viewer) => (viewer.id === viewerId ? { ...viewer, accountId } : viewer)),
    }));
  }, []);

  const addViewerFromGate = useCallback<TrainingDataValue['addViewerFromGate']>((email) => {
    const normalized = email.trim().toLowerCase();
    const existing = state.viewers.find((viewer) => viewer.email.toLowerCase() === normalized);
    if (existing) return existing;
    const local = normalized.split('@')[0] ?? 'new.viewer';
    const name = local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(' ');
    const viewer: TrainingViewer = {
      id: `vw-gate-${hashId(normalized) % 100000}`,
      name: name || 'New Viewer',
      email: normalized,
      phone: '—',
      accountId: null,
      staffOfViewerId: null,
      location: '—',
      firstSeenKey: TODAY_KEY,
      lastSeenKey: TODAY_KEY,
      // Deterministic morning-to-afternoon minute from the email.
      lastSeenMinute: 8 * 60 + (hashId(normalized) % (9 * 60)),
      sessions: 1,
      completedVideoIds: [],
      startedExtra: 0,
      replay: 1.0,
    };
    setState((current) =>
      current.viewers.some((item) => item.email.toLowerCase() === normalized)
        ? current
        : { ...current, viewers: [...current.viewers, viewer] },
    );
    return viewer;
  }, [state.viewers]);

  const inviteStaff = useCallback<TrainingDataValue['inviteStaff']>((staffOfViewerId, email) => {
    const normalized = email.trim().toLowerCase();
    const existing = state.viewers.find((viewer) => viewer.email.toLowerCase() === normalized);
    if (existing) return existing;
    const local = normalized.split('@')[0] ?? 'new.teammate';
    const name = local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(' ');
    const inviter = state.viewers.find((viewer) => viewer.id === staffOfViewerId);
    const viewer: TrainingViewer = {
      id: `vw-staff-${hashId(normalized) % 100000}`,
      name: name || 'New Teammate',
      email: normalized,
      phone: '—',
      // Staff inherit the inviter's office so per-account rollups stay honest.
      accountId: inviter?.accountId ?? null,
      staffOfViewerId,
      location: inviter?.location ?? '—',
      firstSeenKey: TODAY_KEY,
      lastSeenKey: TODAY_KEY,
      lastSeenMinute: 8 * 60 + (hashId(normalized) % (9 * 60)),
      sessions: 0,
      completedVideoIds: [],
      startedExtra: 0,
      replay: 1.0,
    };
    setState((current) =>
      current.viewers.some((item) => item.email.toLowerCase() === normalized)
        ? current
        : { ...current, viewers: [...current.viewers, viewer] },
    );
    return viewer;
  }, [state.viewers]);

  const markVideoComplete = useCallback<TrainingDataValue['markVideoComplete']>((viewerId, videoId) => {
    setState((current) => ({
      ...current,
      viewers: current.viewers.map((viewer) =>
        viewer.id === viewerId
          ? {
              ...viewer,
              completedVideoIds: viewer.completedVideoIds.includes(videoId)
                ? viewer.completedVideoIds
                : [...viewer.completedVideoIds, videoId],
              startedExtra: 0,
              lastSeenKey: TODAY_KEY,
            }
          : viewer,
      ),
    }));
  }, []);

  const flagshipCourse = useMemo(
    () => state.courses.find((course) => course.id === FLAGSHIP_COURSE_ID) ?? state.courses[0]!,
    [state.courses],
  );

  const value = useMemo<TrainingDataValue>(
    () => ({
      courses: state.courses,
      viewers: state.viewers,
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
      addViewerFromGate,
      inviteStaff,
      markVideoComplete,
    }),
    [
      state.courses,
      state.viewers,
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
      addViewerFromGate,
      inviteStaff,
      markVideoComplete,
    ],
  );

  return <TrainingDataContext.Provider value={value}>{children}</TrainingDataContext.Provider>;
}

export function useTrainingData() {
  const context = useContext(TrainingDataContext);
  if (!context) throw new Error('useTrainingData must be used within TrainingDataProvider');
  return context;
}
