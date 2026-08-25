/**
 * Teammate training stats — the office-side, read-only cousin of the HQ
 * viewer profile (pages/admin/training/ViewerProfile).
 *
 * Reached by clicking a roster row on the office Training page (including
 * your own "You" row): one teammate's name and email, their progress across
 * the whole live catalog, a per-course breakdown, watch time, last active,
 * and every lesson they've finished. The lens matches the roster exactly —
 * provider staff resolve only their own office's people, the unscoped demo
 * office reads any office-assigned learner — and the page has no write
 * actions for anyone, so demo behavior is read-only by construction.
 */
import { useMemo } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, ArrowRight, CheckCircle2 } from 'lucide-react';
import { useTrainingData } from '@/contexts/training-data';
import { useProviderScope } from '@/contexts/provider-scope';
import { useSession } from '@/contexts/session';
import { findSeededAccount } from '@/data/hq/accounts';
import { courseDuration, formatClock, formatDateTime, formatHours } from '@/data/hq/training';
import { teammateStats } from '@/data/office-training';
import { TrainingLoading, TrainingLoadError } from '@/components/admin/training/shared';
import { MetricTile } from '@/components/admin/primitives';
import { CHIP_COBALT, MICRO_LABEL, SectionCard } from '@/components/patient/heritage';

/** Page frame — office pages pad themselves; same rhythm as the other screens. */
const PAGE_WRAP = 'mx-auto max-w-[1320px] space-y-6 px-4 py-6 sm:px-5 sm:py-7 md:px-8';

export default function OfficeTeammate({ params }: { params: { viewerId: string } }) {
  const { status, errorMessage, refresh, courses, viewers, completionIndex, myViewer } = useTrainingData();
  const scope = useProviderScope();
  const { authStatus, authRole, providerAccountCode } = useSession();

  // Same scope resolution as the Training page: HQ drill-in and matched staff
  // sign-ins arrive scoped; the demo persona stays unscoped.
  const accountId =
    scope?.id ??
    (authStatus === 'signed-in' && authRole === 'provider_staff' ? providerAccountCode : null);

  const stats = useMemo(
    () => teammateStats(viewers, accountId, params.viewerId, courses, completionIndex, myViewer?.id ?? null),
    [viewers, accountId, params.viewerId, courses, completionIndex, myViewer],
  );

  const backLink = (
    <Link
      href="/training"
      className="inline-flex items-center gap-1.5 rounded-sm text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="link-back-to-training"
    >
      <ArrowLeft size={13} aria-hidden="true" /> All training
    </Link>
  );

  if (status !== 'ready') {
    return (
      <div className={PAGE_WRAP}>
        {backLink}
        {status === 'loading' ? <TrainingLoading /> : <TrainingLoadError message={errorMessage} onRetry={refresh} />}
      </div>
    );
  }

  if (!stats) {
    return (
      <div className={PAGE_WRAP}>
        {backLink}
        <SectionCard title="This teammate isn't available">
          <p className="px-5 py-6 text-xs text-muted-foreground" data-testid="text-teammate-unavailable">
            They may have been removed, or they aren't on your office's roster. Head back to Training for your team.
          </p>
        </SectionCard>
      </div>
    );
  }

  const officeName = stats.viewer.accountId
    ? (findSeededAccount(stats.viewer.accountId)?.officeName ?? null)
    : null;
  const [lastSeenDay = '—', lastSeenTime] = formatDateTime(stats.viewer.lastSeenAt).split(' · ');

  return (
    <div className={PAGE_WRAP}>
      <header className="space-y-3">
        {backLink}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className={MICRO_LABEL}>Enablement — Teammate</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h1
                className="font-serif text-[26px] leading-tight tracking-[-.01em] text-navy"
                data-testid="text-teammate-name"
              >
                {stats.viewer.name}
              </h1>
              {stats.isSelf && (
                <span className={CHIP_COBALT} data-testid="chip-you">
                  You
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="text-teammate-email">
              {stats.viewer.email}
            </p>
          </div>
          {officeName && (
            <span className={`${CHIP_COBALT} shrink-0`} data-testid="chip-teammate-office">
              {officeName}
            </span>
          )}
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Catalog progress"
          value={`${stats.done} of ${stats.total} videos`}
          detail={`${stats.pct}% of the live catalog`}
          testId="tile-catalog-progress"
        />
        <MetricTile label="Watch time" value={formatHours(stats.watchSeconds)} testId="tile-watch-time" />
        <MetricTile
          label="Courses finished"
          value={`${stats.coursesFinished} of ${stats.courses.length}`}
          testId="tile-courses-finished"
        />
        <MetricTile
          label="Last active"
          value={lastSeenDay}
          detail={lastSeenTime ? `${lastSeenTime} local` : undefined}
          testId="tile-last-active"
        />
      </div>

      <SectionCard
        title="Course progress"
        sub="Where they stand in each live course — the same numbers the roster and HQ report."
      >
        {stats.courses.length > 0 ? (
          <div className="divide-y divide-border">
            {stats.courses.map((row) => (
              <Link
                key={row.course.id}
                href={`/training/${row.course.id}`}
                className="group flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5 transition hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:ring-inset focus-visible:ring-ring"
                data-testid={`link-teammate-course-${row.course.id}`}
              >
                <div className="min-w-[200px] flex-1">
                  <p className="truncate font-serif text-sm text-navy transition group-hover:text-primary">
                    {row.course.title}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {row.total} video{row.total === 1 ? '' : 's'} · {formatHours(courseDuration(row.course, true))} ·
                    watched {formatHours(row.watchSeconds)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="w-11 text-right text-xs font-semibold text-navy">
                    {row.done}/{row.total}
                  </span>
                  <div className="h-1.5 w-[72px] overflow-hidden rounded-full bg-border" aria-hidden="true">
                    <div className="h-full bg-primary" style={{ width: `${row.pct}%` }} />
                  </div>
                  <span className="w-9 text-[11px] text-muted-foreground">{row.pct}%</span>
                  <ArrowRight
                    size={14}
                    className="shrink-0 text-muted-foreground transition group-hover:text-primary"
                    aria-hidden="true"
                  />
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <p className="px-5 py-8 text-center text-xs text-muted-foreground">
            No live courses yet — progress appears here as soon as THINNR HQ publishes training.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Completed lessons"
        sub="Every lesson they've finished across the live catalog, newest first."
        action={
          <span className={CHIP_COBALT} data-testid="chip-completed-count">
            {stats.completedLessons.length} finished
          </span>
        }
      >
        {stats.completedLessons.length > 0 ? (
          <ul className="divide-y divide-border">
            {stats.completedLessons.map((lesson) => (
              <li
                key={lesson.item.video.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3"
                data-testid={`row-completed-${lesson.item.video.id}`}
              >
                <CheckCircle2 size={15} className="shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-[180px] flex-1">
                  <p className="truncate text-xs font-semibold text-navy">
                    <span className="mr-1.5 text-muted-foreground">{lesson.item.numbering}</span>
                    {lesson.item.video.title}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {lesson.courseTitle} · {formatClock(lesson.item.video.duration)}
                  </p>
                </div>
                <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                  {formatDateTime(lesson.completedAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-no-completions">
            Nothing finished yet — completed lessons will list here as they work through the catalog.
          </p>
        )}
      </SectionCard>
    </div>
  );
}
