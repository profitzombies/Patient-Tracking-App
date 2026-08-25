/**
 * Office lesson page — one training lesson opened from the course outline.
 *
 * Reads the same live snapshot and unlock rules as the outline (lessonState
 * reuses videoAvailability), so a deep link can never bypass sequential
 * unlock: locked lessons render an explanation instead of content. Playback
 * has two modes: a lesson with an uploaded file streams the real video from
 * App Storage over short-lived signed URLs (signed-in staff only — the media
 * endpoint verifies the caller's Supabase session), while a lesson without
 * one keeps the simulated THINNR chapter/slide deck and says so plainly.
 * Signed-in staff mark the lesson complete right here, which refreshes the
 * shared snapshot (outline progress, team counts, and the next lesson's
 * unlock all follow); demo personas browse read-only.
 */
import { useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowLeft, ArrowRight, CheckCircle2, FileText, Lock } from 'lucide-react';
import { useTrainingData } from '@/contexts/training-data';
import { useToast } from '@/hooks/use-toast';
import { completionsFor, formatClock, type OrderedVideo, type TrainingCourse } from '@/data/hq/training';
import { lessonState, type LessonState, type VideoAvailability } from '@/data/office-training';
import { chapterIndexAt, SlideFrame, TrainingLoading, TrainingLoadError } from '@/components/admin/training/shared';
import {
  HostedVideoPlayer,
  useVideoMedia,
  type HostedVideoPlayerHandle,
} from '@/components/training/HostedVideoPlayer';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CHIP_COBALT,
  CHIP_WARM,
  MICRO_LABEL,
  SectionCard,
} from '@/components/patient/heritage';

/** Page frame — same rhythm as the other office screens, narrowed for reading. */
const PAGE_WRAP = 'mx-auto max-w-[1100px] space-y-6 px-4 py-6 sm:px-5 sm:py-7 md:px-8';

export default function OfficeTrainingLesson({
  params,
}: {
  params: { courseId: string; videoId: string };
}) {
  const { status, errorMessage, refresh, findCourse, completionIndex, myViewer } = useTrainingData();

  const course = findCourse(params.courseId);
  const isLive = course?.status === 'live';
  const myMap = useMemo(
    () => completionsFor(completionIndex, myViewer?.id ?? ''),
    [completionIndex, myViewer],
  );
  const state = useMemo(
    () => (course && isLive ? lessonState(course, params.videoId, myMap) : null),
    [course, isLive, params.videoId, myMap],
  );

  const backToCourse = (
    <Link
      href={`/training/${params.courseId}`}
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
      data-testid="link-back-to-course"
    >
      <ArrowLeft size={13} aria-hidden="true" /> Course outline
    </Link>
  );

  if (status !== 'ready') {
    return (
      <div className={PAGE_WRAP}>
        {backToCourse}
        {status === 'loading' ? <TrainingLoading /> : <TrainingLoadError message={errorMessage} onRetry={refresh} />}
      </div>
    );
  }

  if (!course || !isLive) {
    return (
      <div className={PAGE_WRAP}>
        <Link
          href="/training"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
          data-testid="link-back-to-training"
        >
          <ArrowLeft size={13} aria-hidden="true" /> All training
        </Link>
        <SectionCard title="This course isn't available">
          <p className="px-5 py-6 text-xs text-muted-foreground" data-testid="text-course-unavailable">
            It may have been unpublished by THINNR HQ. Head back to Training for the live catalog.
          </p>
        </SectionCard>
      </div>
    );
  }

  if (!state || !state.item) {
    return (
      <div className={PAGE_WRAP}>
        {backToCourse}
        <SectionCard title="This lesson isn't available">
          <p className="px-5 py-6 text-xs text-muted-foreground" data-testid="text-lesson-unavailable">
            It may have been unpublished or removed by THINNR HQ. Head back to the course outline for the
            current lessons.
          </p>
        </SectionCard>
      </div>
    );
  }

  const item = state.item;

  if (state.availability === 'locked') {
    const blocker = state.blocker;
    return (
      <div className={PAGE_WRAP}>
        {backToCourse}
        <SectionCard title="This lesson is still locked">
          <div className="space-y-4 px-5 py-6">
            <p
              className="flex items-start gap-2.5 text-xs leading-relaxed text-muted-foreground"
              data-testid="text-lesson-locked"
            >
              <Lock size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                Lessons in {course.title} unlock in order.{' '}
                {blocker ? (
                  <>
                    Finish <span className="font-semibold text-navy">&ldquo;{blocker.video.title}&rdquo;</span>{' '}
                    ({blocker.numbering}) to open &ldquo;{item.video.title}&rdquo;.
                  </>
                ) : (
                  <>Complete the earlier lessons to open &ldquo;{item.video.title}&rdquo;.</>
                )}
              </span>
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              {blocker && (
                <Link
                  href={`/training/${course.id}/videos/${blocker.video.id}`}
                  className={`${BTN_PRIMARY} h-9 px-4`}
                  data-testid="link-goto-blocker"
                >
                  Open your next lesson
                </Link>
              )}
              <Link
                href={`/training/${course.id}`}
                className={`${BTN_SECONDARY} h-9 px-4`}
                data-testid="link-locked-back"
              >
                Back to the course outline
              </Link>
            </div>
          </div>
        </SectionCard>
      </div>
    );
  }

  // Key by lesson so prev/next navigation resets the chapter position.
  return <LessonView key={item.video.id} course={course} state={state} item={item} />;
}

function LessonView({
  course,
  state,
  item,
}: {
  course: TrainingCourse;
  state: LessonState;
  item: OrderedVideo;
}) {
  const { myViewer, canAddStaff, markMyVideoComplete } = useTrainingData();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const video = item.video;
  const [chapterIndex, setChapterIndex] = useState(0);
  const [playerTime, setPlayerTime] = useState(0);
  const [marking, setMarking] = useState(false);
  const playerRef = useRef<HostedVideoPlayerHandle | null>(null);

  // Real playback needs a staff session (the media endpoint verifies it);
  // demo personas keep the simulated deck, with no doomed fetch attempted.
  const { media, loading: mediaLoading, error: mediaError, reload: reloadMedia } = useVideoMedia(
    video.id,
    video.videoSource,
    canAddStaff,
  );
  const hostedPlayback = Boolean(video.videoSource) && canAddStaff;
  // Sidebar highlight: follows playback time when streaming, clicks otherwise.
  const activeChapterIndex = hostedPlayback ? chapterIndexAt(video, playerTime) : chapterIndex;

  const done = state.availability === 'done';
  const canMark = Boolean(myViewer) && canAddStaff && state.availability === 'available';

  const markComplete = async () => {
    if (marking) return;
    setMarking(true);
    const completion = await markMyVideoComplete(video.id);
    setMarking(false);
    if (!completion) return; // Failure already toasted — stay on the lesson.
    if (state.next) {
      toast({
        title: `Marked "${video.title}" complete`,
        description: `Continuing to ${state.next.numbering} — ${state.next.video.title}.`,
      });
      navigate(`/training/${course.id}/videos/${state.next.video.id}`);
    } else {
      toast({
        title: `Marked "${video.title}" complete`,
        description: 'That was the last lesson — course complete.',
      });
    }
  };

  return (
    <div className={PAGE_WRAP}>
      <header className="space-y-3">
        <Link
          href={`/training/${course.id}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
          data-testid="link-back-to-course"
        >
          <ArrowLeft size={13} aria-hidden="true" /> Course outline
        </Link>
        <div className="min-w-0">
          <p className={MICRO_LABEL} data-testid="text-lesson-context">
            {course.title} — {item.module.title}
            {item.subgroup ? ` · ${item.subgroup.title}` : ''}
          </p>
          <h1
            className="mt-1 font-serif text-[26px] leading-tight tracking-[-.01em] text-navy"
            data-testid="text-lesson-title"
          >
            <span className="mr-2 text-muted-foreground">{item.numbering}</span>
            {video.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className={CHIP_COBALT}>{formatClock(video.duration)}</span>
            <span className={CHIP_COBALT} data-testid="chip-lesson-position">
              Lesson {state.index + 1} of {state.order.length}
            </span>
            {done && (
              <span className={CHIP_COBALT} data-testid="chip-lesson-completed">
                <CheckCircle2 size={11} aria-hidden="true" /> Completed
              </span>
            )}
          </div>
        </div>
      </header>

      {hostedPlayback ? (
        /* Real player — streams the uploaded file from App Storage. */
        <div className="overflow-hidden rounded-lg border border-card-border bg-card shadow-soft">
          {media ? (
            <HostedVideoPlayer
              ref={playerRef}
              src={media.videoUrl}
              poster={media.thumbnailUrl}
              chapters={video.chapters}
              durationSeconds={video.duration}
              onTimeChange={setPlayerTime}
              testId="player-lesson"
            />
          ) : mediaLoading ? (
            <div
              className="flex aspect-video w-full items-center justify-center bg-navy/90"
              data-testid="player-loading"
            >
              <p className="text-xs font-semibold text-card">Loading the video…</p>
            </div>
          ) : (
            <div
              className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-navy/90 px-6 text-center"
              data-testid="player-error"
            >
              <p className="text-xs font-semibold text-card" role="alert">
                {mediaError ?? 'Could not load the video.'}
              </p>
              <button type="button" className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`} onClick={reloadMedia}>
                Try again
              </button>
            </div>
          )}
        </div>
      ) : (
      /* Simulated player — the THINNR slide deck standing in for a video file. */
      <div className="overflow-hidden rounded-lg border border-card-border bg-card shadow-soft">
        <SlideFrame video={video} chapterIndex={chapterIndex} className="rounded-none border-none" />
        <div className="flex flex-col gap-2.5 border-t border-border px-4 py-3">
          {video.chapters.length > 0 && (
            <div className="flex h-1.5 overflow-hidden rounded-full bg-secondary">
              {video.chapters.map((chapter, idx) => {
                const isPastOrCurrent = idx <= chapterIndex;
                const isLast = idx === video.chapters.length - 1;
                const nextAt = isLast ? video.duration : video.chapters[idx + 1]!.at;
                const pct = Math.max(0, Math.min(100, ((nextAt - chapter.at) / Math.max(1, video.duration)) * 100));
                return (
                  <button
                    key={chapter.id}
                    type="button"
                    onClick={() => setChapterIndex(idx)}
                    style={{ width: `${pct}%` }}
                    className={`h-full border-r border-card transition-colors last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isPastOrCurrent ? 'bg-primary' : 'bg-secondary hover:bg-muted'
                    }`}
                    title={chapter.title}
                    aria-label={`Chapter ${idx + 1}: ${chapter.title}`}
                    aria-current={idx === chapterIndex ? 'true' : undefined}
                    data-testid={`timeline-chapter-${idx}`}
                  />
                );
              })}
            </div>
          )}
          <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-muted-foreground tabular-nums">
            <span>{formatClock(video.chapters[chapterIndex]?.at ?? 0)}</span>
            <span>{formatClock(video.duration)}</span>
          </div>
        </div>
        <p
          className="border-t border-border bg-secondary/50 px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground"
          data-testid="text-simulated-player"
        >
          {video.videoSource
            ? 'A video file is hosted for this lesson — sign in with a staff account to stream it. The chapters here step through the workbook slides instead.'
            : 'Simulated player — no video file has been uploaded for this lesson yet, so the chapters step through the lesson\u2019s workbook slides.'}
        </p>
      </div>
      )}

      <div className="flex flex-col gap-6 md:flex-row md:gap-7">
        <div className="min-w-0 flex-1 space-y-6">
          <SectionCard title="About this lesson">
            <div
              className="space-y-3 px-5 py-4 text-sm leading-relaxed text-foreground/90"
              data-testid="text-lesson-description"
            >
              {video.description.length > 0 ? (
                video.description.map((paragraph, idx) => <p key={idx}>{paragraph}</p>)
              ) : (
                <p className="text-xs text-muted-foreground">
                  No description has been written for this lesson yet.
                </p>
              )}
            </div>
          </SectionCard>

          {video.attachments.length > 0 && (
            <SectionCard
              title="Resources"
              sub="Included with this lesson — file hosting isn't connected in this demo, so these are listed for reference only."
            >
              <ul className="divide-y divide-border">
                {video.attachments.map((attachment) => (
                  <li
                    key={attachment.id}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 py-3"
                    data-testid={`row-attachment-${attachment.id}`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-accent-border bg-accent text-primary">
                        <FileText size={14} aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-navy">{attachment.name}</p>
                        <p className="text-[11px] text-muted-foreground tabular-nums">{attachment.sizeLabel}</p>
                      </div>
                    </div>
                    <span className={`${CHIP_WARM} shrink-0`}>No file yet</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          <div className="pt-1">
            {canMark ? (
              <button
                type="button"
                className={`${BTN_PRIMARY} h-10 w-full px-6 sm:h-9 sm:w-auto`}
                onClick={() => void markComplete()}
                disabled={marking}
                data-testid="button-mark-lesson-complete"
              >
                {marking ? 'Saving…' : state.next ? 'Mark complete & continue' : 'Mark complete'}
              </button>
            ) : done ? (
              <p
                className="flex items-center gap-2 text-xs font-semibold text-navy"
                data-testid="text-lesson-done-note"
              >
                <CheckCircle2 size={14} className="text-primary" aria-hidden="true" />
                You&rsquo;ve completed this lesson — rewatch it any time.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="text-lesson-read-only">
                Browsing read-only — sign in with a staff account to track your progress here.
              </p>
            )}
          </div>
        </div>

        {video.chapters.length > 0 && (
          <div className="w-full shrink-0 md:w-[280px]">
            <SectionCard
              title="Chapters"
              sub={video.chapters.length === 1 ? '1 chapter' : `${video.chapters.length} chapters`}
            >
              <ol className="space-y-1 px-3 py-3">
                {video.chapters.map((chapter, idx) => {
                  const isCurrent = idx === activeChapterIndex;
                  return (
                    <li key={chapter.id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (hostedPlayback) playerRef.current?.seekTo(chapter.at);
                          else setChapterIndex(idx);
                        }}
                        aria-current={isCurrent ? 'true' : undefined}
                        className={`flex w-full items-start gap-3 rounded-md border p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          isCurrent
                            ? 'border-border bg-secondary font-semibold text-navy'
                            : 'border-transparent text-muted-foreground hover:bg-secondary/50'
                        }`}
                        data-testid={`button-chapter-${idx}`}
                      >
                        <span className="w-9 shrink-0 pt-0.5 text-[10px] font-bold tabular-nums">
                          {formatClock(chapter.at)}
                        </span>
                        <span className="flex-1 text-xs leading-snug">{chapter.title}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </SectionCard>
          </div>
        )}
      </div>

      <nav aria-label="Lesson navigation" className="grid gap-3 sm:grid-cols-2">
        <LessonNavCard
          courseId={course.id}
          direction="prev"
          item={state.prev}
          availability={state.prevAvailability}
        />
        <LessonNavCard
          courseId={course.id}
          direction="next"
          item={state.next}
          availability={state.nextAvailability}
        />
      </nav>
    </div>
  );
}

function LessonNavCard({
  courseId,
  direction,
  item,
  availability,
}: {
  courseId: string;
  direction: 'prev' | 'next';
  item: OrderedVideo | null;
  availability: VideoAvailability | null;
}) {
  if (!item) return <div className="hidden sm:block" aria-hidden="true" />;
  const alignEnd = direction === 'next';
  const body = (
    <>
      <p className={`${MICRO_LABEL} flex items-center gap-1 ${alignEnd ? 'sm:justify-end' : ''}`}>
        {direction === 'prev' && <ArrowLeft size={11} aria-hidden="true" />}
        {direction === 'prev' ? 'Previous lesson' : 'Next lesson'}
        {direction === 'next' &&
          (availability === 'locked' ? (
            <Lock size={11} aria-hidden="true" />
          ) : (
            <ArrowRight size={11} aria-hidden="true" />
          ))}
      </p>
      <p className={`mt-1 truncate text-xs font-semibold text-navy ${alignEnd ? 'sm:text-right' : ''}`}>
        <span className="mr-1.5 text-muted-foreground">{item.numbering}</span>
        {item.video.title}
      </p>
      <p className={`mt-0.5 text-[11px] text-muted-foreground ${alignEnd ? 'sm:text-right' : ''}`}>
        {availability === 'locked'
          ? 'Locked until the lessons before it are complete'
          : formatClock(item.video.duration)}
      </p>
    </>
  );
  if (availability === 'locked') {
    return (
      <div
        className="min-w-0 rounded-lg border border-border bg-card px-4 py-3 opacity-60 shadow-soft"
        data-testid={`nav-${direction}-locked`}
      >
        {body}
      </div>
    );
  }
  return (
    <Link
      href={`/training/${courseId}/videos/${item.video.id}`}
      className="min-w-0 rounded-lg border border-card-border bg-card px-4 py-3 shadow-soft transition hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid={`link-${direction}-lesson`}
    >
      {body}
    </Link>
  );
}
