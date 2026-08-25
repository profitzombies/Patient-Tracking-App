/**
 * Office course detail — one live course's outline for a provider office.
 *
 * Shows the full published order with the signed-in staffer's own unlock
 * state (same frontier rules as the learner preview) and how much of the
 * office team has finished each video. Staff can mark any unlocked video
 * complete right here; demo personas browse read-only.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, CheckCircle2, Lock, PlayCircle } from 'lucide-react';
import { useTrainingData } from '@/contexts/training-data';
import { useProviderScope } from '@/contexts/provider-scope';
import { useSession } from '@/contexts/session';
import { useToast } from '@/hooks/use-toast';
import {
  completionsFor,
  countVideos,
  courseDuration,
  formatClock,
  formatHours,
  frontierIndex,
  getOrderedVideos,
} from '@/data/hq/training';
import { officeCourseStats, officeRoster, videoAvailability, videoTeamDone } from '@/data/office-training';
import { TrainingLoading, TrainingLoadError } from '@/components/admin/training/shared';
import { CHIP_COBALT, MICRO_LABEL, SectionCard } from '@/components/patient/heritage';

export default function OfficeTrainingCourse({ params }: { params: { courseId: string } }) {
  const {
    status,
    errorMessage,
    refresh,
    findCourse,
    viewers,
    completionIndex,
    myViewer,
    canAddStaff,
    markMyVideoComplete,
  } = useTrainingData();
  const scope = useProviderScope();
  const { authStatus, authRole, providerAccountCode } = useSession();
  const { toast } = useToast();
  const [markingId, setMarkingId] = useState<string | null>(null);

  const accountId =
    scope?.id ??
    (authStatus === 'signed-in' && authRole === 'provider_staff' ? providerAccountCode : null);

  const course = findCourse(params.courseId);
  const isLive = course?.status === 'live';

  const order = useMemo(
    () => (course && isLive ? getOrderedVideos(course, true) : []),
    [course, isLive],
  );
  const roster = useMemo(
    () => officeRoster(viewers, accountId, order, completionIndex, myViewer?.id ?? null),
    [viewers, accountId, order, completionIndex, myViewer],
  );
  const teamStats = useMemo(() => officeCourseStats(roster), [roster]);
  const myMap = useMemo(
    () => completionsFor(completionIndex, myViewer?.id ?? ''),
    [completionIndex, myViewer],
  );
  const frontier = useMemo(() => frontierIndex(myMap, order), [myMap, order]);

  const backLink = (
    <Link
      href="/training"
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
      data-testid="link-back-to-training"
    >
      <ArrowLeft size={13} aria-hidden="true" /> All training
    </Link>
  );

  if (status !== 'ready') {
    return (
      <div className="space-y-6">
        {backLink}
        {status === 'loading' ? <TrainingLoading /> : <TrainingLoadError message={errorMessage} onRetry={refresh} />}
      </div>
    );
  }

  if (!course || !isLive) {
    return (
      <div className="space-y-6">
        {backLink}
        <SectionCard title="This course isn't available">
          <p className="px-5 py-6 text-xs text-muted-foreground" data-testid="text-course-unavailable">
            It may have been unpublished by THINNR HQ. Head back to Training for the live catalog.
          </p>
        </SectionCard>
      </div>
    );
  }

  const markComplete = async (videoId: string, title: string) => {
    if (markingId) return;
    setMarkingId(videoId);
    const completion = await markMyVideoComplete(videoId);
    setMarkingId(null);
    if (completion) {
      toast({ title: 'Marked complete', description: title });
    }
  };

  let lastModuleId: string | null = null;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        {backLink}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className={MICRO_LABEL}>Enablement — Course</p>
            <h1 className="mt-1 font-serif text-[26px] leading-tight tracking-[-.01em] text-navy" data-testid="text-course-title">
              {course.title}
            </h1>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{course.description}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className={CHIP_COBALT}>{countVideos(course, true)} videos</span>
            <span className={CHIP_COBALT}>{formatHours(courseDuration(course, true))}</span>
            <span className={CHIP_COBALT} data-testid="chip-team-avg">
              Team avg {teamStats.avgPct}%
            </span>
          </div>
        </div>
      </header>

      <SectionCard
        title="Course outline"
        sub={
          myViewer
            ? 'Your progress unlocks in order — free videos can be taken any time.'
            : 'Sign in with a staff account to track your own progress here.'
        }
      >
        <ul className="divide-y divide-border">
          {order.map((item, index) => {
            const availability = videoAvailability(course, item, index, myMap, frontier);
            const teamDone = videoTeamDone(item.video.id, roster, completionIndex);
            const moduleHeader =
              item.module.id !== lastModuleId ? (
                <p className={`${MICRO_LABEL} px-5 pb-1 pt-4`}>{item.module.title}</p>
              ) : null;
            lastModuleId = item.module.id;
            const canMark = Boolean(myViewer) && canAddStaff && availability === 'available';
            return (
              <li key={item.video.id} className="last:pb-2">
                {moduleHeader}
                <div
                  className={`flex items-center gap-3 px-5 py-3 ${availability === 'locked' ? 'opacity-55' : ''}`}
                  data-testid={`row-video-${item.video.id}`}
                >
                  <span
                    className={
                      availability === 'done'
                        ? 'text-primary'
                        : availability === 'available'
                          ? 'text-navy'
                          : 'text-muted-foreground'
                    }
                    aria-hidden="true"
                  >
                    {availability === 'done' ? (
                      <CheckCircle2 size={16} />
                    ) : availability === 'available' ? (
                      <PlayCircle size={16} />
                    ) : (
                      <Lock size={14} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-navy">
                      <span className="mr-1.5 text-muted-foreground">{item.numbering}</span>
                      {item.video.title}
                      {item.subgroup && (
                        <span className="ml-2 text-[10px] font-normal text-muted-foreground">{item.subgroup.title}</span>
                      )}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {formatClock(item.video.duration)} · {teamDone}/{roster.length || 0} on your team finished
                    </p>
                  </div>
                  {canMark && (
                    <button
                      className="shrink-0 rounded-md border border-accent-border bg-accent px-2.5 py-1.5 text-[11px] font-semibold text-primary transition hover:bg-accent/70 disabled:opacity-60"
                      onClick={() => void markComplete(item.video.id, item.video.title)}
                      disabled={markingId !== null}
                      data-testid={`button-mark-${item.video.id}`}
                    >
                      {markingId === item.video.id ? 'Saving…' : 'Mark complete'}
                    </button>
                  )}
                  {availability === 'done' && (
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-[.08em] text-primary">Done</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">
          Video files aren't hosted in this demo — completing a video records the workbook's tracked duration.
        </p>
      </SectionCard>
    </div>
  );
}
