import { useTrainingData } from '@/contexts/training-data';
import { getCourseAnalytics, formatHours } from '@/data/hq/training';
import { MetricTile } from '@/components/admin/primitives';
import { SectionCard, CHIP_WARM } from '@/components/patient/heritage';
import {
  TrainingSection,
  TrainingLoading,
  TrainingLoadError,
  TrainingEmpty,
  CourseLiveChip,
} from '@/components/admin/training/shared';
import { Users, Target, CheckCircle2, TrendingDown } from 'lucide-react';

const fmt = (value: number) => value.toLocaleString('en-US');

export default function TrainingAnalytics() {
  const { viewers, completions, flagshipCourse, status, errorMessage, refresh } = useTrainingData();

  if (status !== 'ready') {
    return (
      <TrainingSection
        title="Analytics"
        sub="Viewer visibility stats, plus per-course engagement — expand for modules and videos."
      >
        {status === 'loading' ? <TrainingLoading /> : <TrainingLoadError message={errorMessage} onRetry={refresh} />}
      </TrainingSection>
    );
  }

  if (!flagshipCourse) {
    return (
      <TrainingSection
        title="Analytics"
        sub="Viewer visibility stats, plus per-course engagement — expand for modules and videos."
      >
        <TrainingEmpty
          title="Nothing to analyze yet"
          sub="Create a course and share its learner link — completion analytics build up from real viewer activity."
        />
      </TrainingSection>
    );
  }

  const analytics = getCourseAnalytics(flagshipCourse, viewers, completions);

  const neutralChip = "inline-flex items-center gap-1.5 rounded-sm border border-border bg-secondary px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.06em] text-muted-foreground";

  return (
    <TrainingSection
      title="Analytics"
      sub="Viewer visibility stats, plus per-course engagement — expand for modules and videos."
    >
      {/* Headline MetricTiles */}
      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6 mb-6">
        <MetricTile
          label="Avg watch time / viewer"
          value={formatHours(analytics.avgWatchSecondsPerViewer)}
          detail="Across active viewers"
          testId="text-avg-watch-time"
        />
        <MetricTile
          label="Avg completion"
          value={`${analytics.avgCompletionPct}%`}
          detail="Mean viewer progress"
          testId="text-avg-completion"
        />
        <MetricTile
          label="Active viewers"
          value={fmt(analytics.activeViewers)}
          detail="With any watch history"
          testId="text-active-viewers"
        />
        <MetricTile
          label="Total watch time"
          value={formatHours(analytics.totalWatchSeconds)}
          detail="All viewers combined"
          testId="text-total-watch"
        />
        <MetricTile
          label="Course completions"
          value={fmt(analytics.finished)}
          detail="Finished every video"
          testId="text-course-completions"
        />
        <MetricTile
          label="Avg time to complete"
          value={formatHours(analytics.avgCompletionSeconds)}
          detail="Gate entry to final video"
          testId="text-avg-time-to-complete"
        />
      </div>

      <SectionCard
        title="Course Progress Overview"
        sub="Whole-population progress — everyone who started, how far they got, and where they drop off."
      >
        <div className="grid gap-6 border-b border-border p-5 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
              <Users size={12} />
              Population
            </p>
            <p className="mt-1 font-serif text-[26px] font-bold leading-none tracking-[-.01em] text-navy" data-testid="text-overview-population">
              {analytics.population}
            </p>
            <p className="mt-1.5 text-[11px] text-muted-foreground">Started at least one video</p>
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
              <Target size={12} className="text-primary" />
              Avg completion
            </p>
            <p className="mt-1 font-serif text-[26px] font-bold leading-none tracking-[-.01em] text-navy" data-testid="text-overview-avg-completion">
              {analytics.avgCompletionPct}%
            </p>
            <p className="mt-1.5 text-[11px] text-muted-foreground">Mean completion rate</p>
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
              <CheckCircle2 size={12} className="text-[#3b82f6]" />
              Finished the course
            </p>
            <p className="mt-1 font-serif text-[26px] font-bold leading-none tracking-[-.01em] text-navy" data-testid="text-overview-finished">
              {analytics.finished}
            </p>
            <p className="mt-1.5 text-[11px] text-muted-foreground">{analytics.finishedPct}% of population</p>
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
              <TrendingDown size={12} className="text-[#b65c22]" />
              Biggest drop-off
            </p>
            <p className="mt-1 font-serif text-[26px] font-bold leading-none tracking-[-.01em] text-navy" data-testid="text-overview-drop">
              {analytics.biggestDrop ? `-${analytics.biggestDrop.pts} pts` : '—'}
            </p>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {analytics.biggestDrop ? `At video ${analytics.biggestDrop.stat.position} of ${analytics.stats.length}` : '—'}
            </p>
          </div>
        </div>

        {analytics.population === 0 ? (
          <p className="px-5 py-10 text-center text-xs text-muted-foreground" data-testid="text-analytics-empty">
            No viewer activity yet — the drop-off chart and per-video table fill in as viewers start watching.
          </p>
        ) : (
          <>
            <div className="grid gap-8 p-5 lg:grid-cols-3">
              {/* Drop-off chart */}
              <div className="lg:col-span-2">
                <h3 className="text-[11px] font-bold text-navy">Drop-off by video</h3>
                <p className="mb-6 text-[11px] text-muted-foreground">% of the population that completed each video, in course order. The amber bar is the biggest drop.</p>

                <div className="relative h-48 w-full border-b border-border pl-8">
                  {[100, 75, 50, 25, 0].map(y => (
                    <div key={y} className="absolute w-full border-t border-border/40" style={{ bottom: `${y}%` }}>
                      <span className="absolute -left-7 -top-2 text-[9px] text-muted-foreground">{y}%</span>
                    </div>
                  ))}
                  <div className="absolute inset-0 ml-8 flex items-end gap-[2px]">
                    {analytics.stats.map((stat) => {
                      const isBiggest = analytics.biggestDrop?.stat.video.id === stat.video.id;
                      const height = Math.max(0, Math.min(100, stat.pctOfPopulation));
                      return (
                        <div 
                          key={stat.video.id} 
                          className="group relative flex h-full flex-1 flex-col justify-end"
                          title={`${stat.video.title}\nCompleted by ${stat.pctOfPopulation}% of population`}
                        >
                          <div 
                            className={`w-full rounded-t-sm transition-opacity hover:opacity-80 ${isBiggest ? 'bg-[#b65c22]' : 'bg-primary'}`}
                            style={{ height: `${height}%` }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="ml-8 mt-2 flex gap-[2px]">
                  {analytics.stats.map((stat, i) => {
                    const isEdge = i === 0 || i === analytics.stats.length - 1;
                    const isInterval = (i + 1) % 5 === 0;
                    const showLabel = isEdge || isInterval;
                    return (
                      <div key={stat.video.id} className="flex-1 text-center text-[9px] text-muted-foreground">
                        {showLabel ? stat.numbering.split('.')[0] : ''}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* How far people get */}
              <div>
                <h3 className="text-[11px] font-bold text-navy">How far people get</h3>
                <p className="mb-6 text-[11px] text-muted-foreground">Viewers by % of the course completed.</p>

                <div className="flex flex-col justify-center gap-3 h-[calc(100%-2.5rem)]">
                  {analytics.buckets.map((bucket) => {
                    const widthPct = analytics.population > 0 ? (bucket.count / analytics.population) * 100 : 0;
                    return (
                      <div key={bucket.label} className="flex items-center gap-3">
                        <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground">{bucket.label}</span>
                        <div className="flex h-3.5 flex-1 items-center overflow-hidden rounded-sm bg-secondary">
                          <div className="h-full bg-[#00a8e8]" style={{ width: `${Math.max(0.5, widthPct)}%` }} />
                        </div>
                        <span className="w-6 shrink-0 text-right text-xs font-semibold text-navy">{bucket.count}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Per-video table */}
            <div className="border-t border-border overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-secondary/50 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                    <th className="px-5 py-3 font-bold">#</th>
                    <th className="px-3 py-3 font-bold">Video</th>
                    <th className="px-3 py-3 font-bold">Module</th>
                    <th className="px-3 py-3 text-right font-bold">Started</th>
                    <th className="px-3 py-3 text-right font-bold">Completed</th>
                    <th className="px-3 py-3 text-right font-bold">% of population</th>
                    <th className="px-5 py-3 text-right font-bold">Drop</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.stats.map((stat) => (
                    <tr key={stat.video.id} className="border-b border-border transition hover:bg-accent/30 last:border-b-0" data-testid={`row-analytics-video-${stat.video.id}`}>
                      <td className="px-5 py-3 text-muted-foreground">{stat.numbering}</td>
                      <td className="px-3 py-3 font-semibold text-navy">{stat.video.title}</td>
                      <td className="px-3 py-3 text-muted-foreground">{stat.module.title}</td>
                      <td className="px-3 py-3 text-right text-foreground">{stat.started}</td>
                      <td className="px-3 py-3 text-right text-foreground">{stat.completedCount}</td>
                      <td className="px-3 py-3 text-right text-foreground">{stat.pctOfPopulation}%</td>
                      <td className="px-5 py-3 text-right">
                        {stat.dropPts === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : stat.dropPts > 0 ? (
                          <span className={CHIP_WARM}>-{stat.dropPts} pts</span>
                        ) : (
                          <span className={neutralChip}>held</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Footer summary bar */}
        <div className="flex flex-wrap items-center gap-x-12 gap-y-4 border-t border-border bg-card px-5 py-4 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="font-bold uppercase tracking-[.12em] text-muted-foreground">Course</span>
            <span className="font-semibold text-navy">{flagshipCourse.title}</span>
            <CourseLiveChip status={flagshipCourse.status} />
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold uppercase tracking-[.12em] text-muted-foreground">Videos</span>
            <span className="font-semibold text-navy">{analytics.stats.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold uppercase tracking-[.12em] text-muted-foreground">Viewers started</span>
            <span className="font-semibold text-navy">{analytics.population}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold uppercase tracking-[.12em] text-muted-foreground">Total watch</span>
            <span className="font-semibold text-navy">{formatHours(analytics.totalWatchSeconds)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold uppercase tracking-[.12em] text-muted-foreground">Avg watch / viewer</span>
            <span className="font-semibold text-navy">{formatHours(analytics.avgWatchSecondsPerViewer)}</span>
          </div>
        </div>
      </SectionCard>
    </TrainingSection>
  );
}
