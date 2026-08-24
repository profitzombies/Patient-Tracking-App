import { useMemo } from 'react';
import { Link, useParams } from 'wouter';
import { ArrowLeft, Check } from 'lucide-react';
import { useTrainingData } from '@/contexts/training-data';
import { useHqData } from '@/contexts/hq-data';
import { AdminPage, MetricTile, PageHeader } from '@/components/admin/primitives';
import { SectionCard, CHIP_COBALT, CHIP_WARM, PANEL_LABEL } from '@/components/patient/heritage';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  getOrderedVideos, 
  viewerWatchSeconds, 
  completedCount,
  frontierIndex,
  isVideoCompletedBy,
  formatHours, 
  formatMinute, 
  formatClock,
  formatDateKey 
} from '@/data/hq/training';

export default function ViewerProfile() {
  const { viewerId } = useParams<{ viewerId: string }>();
  const { viewers, flagshipCourse, assignViewerAccount } = useTrainingData();
  const { accounts } = useHqData();

  const viewer = useMemo(() => viewers.find(v => v.id === viewerId), [viewers, viewerId]);
  const order = useMemo(() => getOrderedVideos(flagshipCourse, true), [flagshipCourse]);
  const totalVideos = order.length;

  if (!viewer) {
    return (
      <AdminPage>
        <div className="mx-auto max-w-md rounded-lg border border-card-border bg-card px-6 py-10 text-center shadow-soft">
          <h1 className="font-serif text-lg font-bold text-navy">Viewer not found</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            This viewer doesn&rsquo;t exist in the demo session.
          </p>
          <Link href="/admin/training/viewers" className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-card px-3.5 text-xs font-semibold text-foreground shadow-xs transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="link-back-to-viewers">
            <ArrowLeft size={14} aria-hidden="true" />
            Back to All viewers
          </Link>
        </div>
      </AdminPage>
    );
  }

  const watchTime = viewerWatchSeconds(viewer, order);
  const done = completedCount(viewer, order);
  const frontier = frontierIndex(viewer, order);
  const progressPct = totalVideos > 0 ? Math.min(100, Math.round((done / totalVideos) * 100)) : 0;
  
  let staffOfName = null;
  if (viewer.staffOfViewerId) {
    const boss = viewers.find(v => v.id === viewer.staffOfViewerId);
    if (boss) {
      staffOfName = boss.name.split(' ')[0];
    }
  }

  const assignedAccount = viewer.accountId ? accounts.find(a => a.id === viewer.accountId) : null;

  // Group videos by module
  const videosByModule = useMemo(() => {
    const grouped: Record<string, typeof order> = {};
    order.forEach(ov => {
      if (!grouped[ov.module.id]) grouped[ov.module.id] = [];
      grouped[ov.module.id]!.push(ov);
    });
    return grouped;
  }, [order]);

  const lastSeenDay = viewer.lastSeenKey === '2026-08-22' ? 'Today' : formatDateKey(viewer.lastSeenKey);

  return (
    <AdminPage>
      <Link href="/admin/training/viewers" className="mb-4 inline-flex items-center gap-1.5 rounded-sm text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="link-back-to-viewers">
        <ArrowLeft size={12} aria-hidden="true" />
        All viewers
      </Link>

      <PageHeader
        kicker="Training Profile"
        title={viewer.name}
        sub={`${viewer.email} · ${viewer.phone} · ${viewer.location}`}
        action={
          <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
            {assignedAccount && (
              <span className={CHIP_COBALT}>{assignedAccount.officeName}</span>
            )}
            <Select
              value={viewer.accountId || 'none'}
              onValueChange={(val) => assignViewerAccount(viewer.id, val === 'none' ? null : val)}
            >
              <SelectTrigger className="h-9 w-[180px] bg-card text-xs shadow-xs" data-testid="select-client">
                <SelectValue placeholder="Assign a client" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-xs text-muted-foreground">No client</SelectItem>
                {accounts.map(acc => (
                  <SelectItem key={acc.id} value={acc.id} className="text-xs">{acc.officeName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      {staffOfName && (
        <div className="mb-6">
          <span className={CHIP_WARM}>Staff of {staffOfName}</span>
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile 
          label="Watch time" 
          value={formatHours(watchTime)} 
          testId="tile-watch-time"
        />
        <MetricTile 
          label="Sessions" 
          value={viewer.sessions.toString()} 
          testId="tile-sessions"
        />
        <MetricTile 
          label="Progress" 
          value={`${done} of ${totalVideos} videos`} 
          detail={`${progressPct}% complete`}
          testId="tile-progress"
        />
        <MetricTile 
          label="Last seen" 
          value={lastSeenDay} 
          detail={`${formatMinute(viewer.lastSeenMinute)} ET`}
          testId="tile-last-seen"
        />
      </div>

      <SectionCard title="Course activity" sub={flagshipCourse.title}>
        <div>
          {flagshipCourse.modules.map(module => {
            const moduleVideos = videosByModule[module.id];
            if (!moduleVideos || moduleVideos.length === 0) return null;

            return (
              <div key={module.id} className="border-b border-border last:border-0" data-testid={`module-${module.id}`}>
                <div className="bg-secondary/40 px-5 py-3">
                  <h3 className="font-serif text-sm font-bold text-navy">{module.title}</h3>
                </div>
                <ul>
                  {moduleVideos.map(ov => {
                    const isCompleted = isVideoCompletedBy(viewer, ov.video.id);
                    const isNext = ov.position - 1 === frontier && viewer.startedExtra === 1;
                    const isFirst = ov.position === 1;

                    return (
                      <li key={ov.video.id} className="flex items-center justify-between gap-4 border-b border-border px-5 py-3 last:border-0 hover:bg-accent/20" data-testid={`row-video-${ov.video.id}`}>
                        <div className="flex items-center gap-4 min-w-0">
                          <span className="shrink-0 w-8 text-xs font-medium text-muted-foreground">{ov.numbering}</span>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-foreground">{ov.video.title}</p>
                            <div className="mt-0.5 flex items-center gap-2">
                              <span className="text-[10px] text-muted-foreground">{formatClock(ov.video.duration)}</span>
                              {isFirst && viewer.replay > 1 && (
                                <span className="inline-flex items-center rounded-sm bg-accent px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.06em] text-primary">
                                  Replays the intro
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          {isCompleted ? (
                            <span className={CHIP_COBALT}>
                              <Check size={10} strokeWidth={3} className="mr-1 inline-block" aria-hidden="true" />
                              Completed
                            </span>
                          ) : isNext ? (
                            <span className={CHIP_WARM}>In progress</span>
                          ) : (
                            <span className="text-[10px] font-bold uppercase tracking-[.06em] text-muted-foreground/60">Not started</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </SectionCard>
    </AdminPage>
  );
}