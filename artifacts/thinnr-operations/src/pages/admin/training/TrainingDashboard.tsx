import { Link } from 'wouter';
import { useTrainingData } from '@/contexts/training-data';
import {
  getTrainingTotals,
  getMostWatched,
  getRecentViewers,
  formatHours,
  formatLastSeen,
} from '@/data/hq/training';
import { SectionCard } from '@/components/patient/heritage';
import { MetricTile } from '@/components/admin/primitives';
import { TrainingSection } from '@/components/admin/training/shared';
import { PlayCircle } from 'lucide-react';

const fmt = (value: number) => value.toLocaleString('en-US');

export default function TrainingDashboard() {
  const { courses, viewers, flagshipCourse } = useTrainingData();

  const totals = getTrainingTotals(courses, viewers);
  const mostWatched = getMostWatched(flagshipCourse, viewers, 5);
  const recentViewers = getRecentViewers(viewers, 6);

  const action = (
    <Link
      href="/admin/training/courses"
      className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3.5 h-9 text-xs font-semibold text-primary-foreground shadow-xs transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="button-manage-courses"
    >
      Manage courses
    </Link>
  );

  return (
    <TrainingSection
      title="Training"
      sub="Gated mini-courses with viewer analytics."
      action={action}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Total viewers"
          value={fmt(totals.totalViewers)}
          detail={`+${totals.newViewersThisWeek} this week`}
          testId="text-total-viewers"
        />
        <MetricTile
          label="Total watch time"
          value={formatHours(totals.totalWatchSeconds)}
          detail={`across ${fmt(totals.totalSessions)} sessions`}
          testId="text-total-watch-time"
        />
        <MetricTile
          label="Video completions"
          value={fmt(totals.videoCompletions)}
          detail={`${fmt(totals.fullCourseCompletions)} full course completions`}
          testId="text-video-completions"
        />
        <MetricTile
          label="Content library"
          value={`${totals.libraryVideoCount} videos`}
          detail={`${formatHours(totals.libraryDuration)} total · ${
            courses.filter((c) => c.status === 'live').length
          } live`}
          testId="text-content-library"
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <SectionCard title="Most watched videos" className="h-full">
          <ul className="flex flex-col">
            {mostWatched.map((stat, index) => (
              <li
                key={stat.video.id}
                className="border-b border-border last:border-b-0"
              >
                <Link
                  href={`/admin/training/courses/${flagshipCourse.id}/videos/${stat.video.id}`}
                  className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  data-testid={`link-most-watched-${stat.video.id}`}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-bold text-muted-foreground">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-navy">
                      {stat.video.title}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                      {stat.module.title}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <PlayCircle size={14} aria-hidden="true" className="text-primary/60" />
                    {formatHours(stat.watchSeconds)}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="Recent viewers" className="h-full">
          <ul className="flex flex-col">
            {recentViewers.map((viewer) => (
              <li
                key={viewer.id}
                className="border-b border-border last:border-b-0"
              >
                <Link
                  href={`/admin/training/viewers/${viewer.id}`}
                  className="flex items-center justify-between gap-3 px-5 py-3.5 transition hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  data-testid={`link-recent-viewer-${viewer.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-navy">
                      {viewer.name}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {viewer.email}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-[10px] text-muted-foreground">
                    {formatLastSeen(viewer)}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>
    </TrainingSection>
  );
}
