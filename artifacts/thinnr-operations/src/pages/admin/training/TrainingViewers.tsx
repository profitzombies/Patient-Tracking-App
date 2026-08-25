import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { Search } from 'lucide-react';
import { useTrainingData } from '@/contexts/training-data';
import { useHqData } from '@/contexts/hq-data';
import { TrainingSection, TrainingLoading, TrainingLoadError } from '@/components/admin/training/shared';
import { INPUT_CLASS, SectionCard, WARM_TEXT } from '@/components/patient/heritage';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  getOrderedVideos,
  completionsFor,
  viewerWatchSeconds,
  completedCount,
  formatHours,
  formatLastSeen,
} from '@/data/hq/training';

export default function TrainingViewers() {
  const { viewers, flagshipCourse, assignViewerAccount, completionIndex, status, errorMessage, refresh } =
    useTrainingData();
  const { accounts } = useHqData();
  const [search, setSearch] = useState('');

  const order = useMemo(
    () => (flagshipCourse ? getOrderedVideos(flagshipCourse, true) : []),
    [flagshipCourse],
  );
  const totalVideos = order.length;

  const filteredViewers = useMemo(() => {
    let result = viewers;
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (v) => v.name.toLowerCase().includes(q) || v.email.toLowerCase().includes(q) || v.phone.toLowerCase().includes(q)
      );
    }
    return [...result].sort((a, b) => {
      const diff = Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
  }, [viewers, search]);

  if (status !== 'ready') {
    return (
      <TrainingSection
        title="Viewers"
        sub="Everyone who entered the email gate — click a viewer for their full activity profile."
      >
        {status === 'loading' ? <TrainingLoading /> : <TrainingLoadError message={errorMessage} onRetry={refresh} />}
      </TrainingSection>
    );
  }

  return (
    <TrainingSection
      title="Viewers"
      sub="Everyone who entered the email gate — click a viewer for their full activity profile."
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <p className="text-xs font-semibold text-navy" data-testid="text-total-viewers">
          {filteredViewers.length} {filteredViewers.length === 1 ? 'viewer' : 'viewers'}
        </p>
        <div className="relative w-full sm:w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            className={`${INPUT_CLASS} h-9 w-full pl-9`}
            placeholder="Search name, email, phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search-viewers"
          />
        </div>
      </div>

      <SectionCard title="Viewer list">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                <th className="px-5 py-3 font-bold">Name</th>
                <th className="px-3 py-3 font-bold">Email</th>
                <th className="px-3 py-3 font-bold">Phone</th>
                <th className="px-3 py-3 font-bold">Client</th>
                <th className="px-3 py-3 font-bold">Location</th>
                <th className="px-3 py-3 text-right font-bold">Sessions</th>
                <th className="px-3 py-3 text-right font-bold">Watch time</th>
                <th className="px-3 py-3 font-bold">Progress</th>
                <th className="px-5 py-3 text-right font-bold">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {filteredViewers.length > 0 ? (
                filteredViewers.map((viewer) => {
                  const completionMap = completionsFor(completionIndex, viewer.id);
                  const watchTime = viewerWatchSeconds(completionMap, order);
                  const done = completedCount(completionMap, order);
                  const progressPct = totalVideos > 0 ? Math.min(100, Math.round((done / totalVideos) * 100)) : 0;

                  let staffOfName = null;
                  if (viewer.staffOfViewerId) {
                    const boss = viewers.find(v => v.id === viewer.staffOfViewerId);
                    if (boss) {
                      staffOfName = boss.name.split(' ')[0];
                    }
                  }

                  return (
                    <tr key={viewer.id} className="border-b border-border transition hover:bg-accent/40 last:border-b-0" data-testid={`row-viewer-${viewer.id}`}>
                      <td className="px-5 py-3">
                        <Link href={`/admin/training/viewers/${viewer.id}`} className="font-semibold text-primary hover:underline" data-testid={`link-viewer-${viewer.id}`}>
                          {viewer.name}
                        </Link>
                        {staffOfName && (
                          <span className="mt-1 block text-[9px] font-bold uppercase tracking-[.06em]" style={{ color: WARM_TEXT }}>
                            Staff of {staffOfName}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{viewer.email}</td>
                      <td className="px-3 py-3 text-muted-foreground">{viewer.phone}</td>
                      <td className="px-3 py-3">
                        <Select
                          value={viewer.accountId || 'none'}
                          onValueChange={(val) => void assignViewerAccount(viewer.id, val === 'none' ? null : val)}
                        >
                          <SelectTrigger className="h-7 w-[160px] text-[11px]" data-testid={`select-client-${viewer.id}`}>
                            <SelectValue placeholder="No client" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none" className="text-[11px] text-muted-foreground">No client</SelectItem>
                            {accounts.map(acc => (
                              <SelectItem key={acc.id} value={acc.id} className="text-[11px]">{acc.officeName}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{viewer.location}</td>
                      <td className="px-3 py-3 text-right font-semibold text-navy">{viewer.sessions}</td>
                      <td className="px-3 py-3 text-right text-muted-foreground">{formatHours(watchTime)}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <span className="w-9 text-right font-semibold text-navy">
                            {done}/{totalVideos}
                          </span>
                          <div className="h-1.5 w-[60px] overflow-hidden rounded-full bg-border" aria-hidden="true">
                            <div className="h-full bg-primary" style={{ width: `${progressPct}%` }} />
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right text-muted-foreground whitespace-nowrap">
                        {formatLastSeen(viewer)}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={9} className="px-5 py-8 text-center text-xs text-muted-foreground">
                    {search.trim()
                      ? 'No viewers match.'
                      : 'No viewers yet — they appear here after entering the email gate on a shared course link.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </TrainingSection>
  );
}
