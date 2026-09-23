/**
 * Page-header refresh control for order, fulfillment and subscription pages.
 *
 * Wired to the React Query results the page renders from: the button
 * refetches every source through our API, spins while any of them is in
 * flight, and reports "Updated n min ago" from the oldest successful read.
 * A refresh that fails keeps the last good data on screen and raises a
 * non-blocking toast; the demo persona has nothing to fetch, so its refresh
 * only animates and confirms the preview is current. Completion is announced
 * through a polite live region so screen-reader users hear the result.
 */
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { BTN_SECONDARY } from '@/components/patient/heritage';
import { useToast } from '@/hooks/use-toast';

export interface RefreshSource {
  refetch: () => Promise<{ isError: boolean; error: unknown }>;
  dataUpdatedAt: number;
  isFetching: boolean;
}

interface RefreshControlProps {
  /** What the button refreshes, for the accessible name ("Refresh transactions"). */
  subject: string;
  sources?: readonly RefreshSource[];
  /** Demo persona: nothing to fetch, the control animates and confirms. */
  demo?: boolean;
  testId?: string;
}

const DEMO_SPIN_MS = 500;
const TICK_MS = 30_000;

export function formatUpdatedAgo(updatedAt: number, now: number): string {
  const ageMs = Math.max(0, now - updatedAt);
  if (ageMs < 60_000) return 'Updated just now';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours} hr ago`;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The refresh did not complete.';
}

export function RefreshControl({ subject, sources = [], demo = false, testId }: RefreshControlProps) {
  const { toast } = useToast();
  const [manualPending, setManualPending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState('');
  const [demoUpdatedAt] = useState(() => Date.now());
  const mounted = useRef(true);
  const id = testId ?? `refresh-${subject.toLowerCase().replace(/\s+/g, '-')}`;

  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    (timer as { unref?: () => void }).unref?.();
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);

  const live = !demo ? sources.filter((source) => source.dataUpdatedAt > 0) : [];
  const updatedAt = demo
    ? demoUpdatedAt
    : live.length ? Math.min(...live.map((source) => source.dataUpdatedAt)) : 0;
  const spinning = manualPending || (!demo && sources.some((source) => source.isFetching));
  const lowerSubject = subject.toLowerCase();

  const refresh = async () => {
    if (manualPending) return;
    setManualPending(true);
    setAnnouncement('');
    try {
      if (demo) {
        await new Promise((resolve) => setTimeout(resolve, DEMO_SPIN_MS));
        if (!mounted.current) return;
        setAnnouncement(`${subject} preview is up to date.`);
        return;
      }
      const results = await Promise.all(sources.map((source) => source.refetch()));
      if (!mounted.current) return;
      const failed = results.find((result) => result.isError);
      const at = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      if (failed) {
        toast({
          variant: 'destructive',
          title: `Couldn't refresh ${lowerSubject}`,
          description: `${errorText(failed.error)} Showing the last loaded data.`,
        });
        setAnnouncement(`${subject} refresh failed at ${at}. Showing the last loaded data.`);
      } else {
        setAnnouncement(`${subject} refreshed at ${at}.`);
      }
    } finally {
      if (mounted.current) {
        setManualPending(false);
        setNow(Date.now());
      }
    }
  };

  return (
    <div className="flex items-center gap-2" data-testid={id}>
      {updatedAt > 0 ? (
        <span className="text-[11px] text-muted-foreground" data-testid={`${id}-updated`} aria-hidden="true">
          {formatUpdatedAgo(updatedAt, now)}
        </span>
      ) : null}
      <button
        type="button"
        className={`${BTN_SECONDARY} h-9 gap-1.5 px-3`}
        onClick={() => void refresh()}
        aria-label={updatedAt > 0 ? `Refresh ${lowerSubject}. ${formatUpdatedAgo(updatedAt, now)}` : `Refresh ${lowerSubject}`}
        aria-busy={spinning || undefined}
        data-testid={`${id}-button`}
        data-spinning={spinning ? 'true' : 'false'}
      >
        <RefreshCw size={14} className={spinning ? 'animate-spin' : undefined} aria-hidden="true" />
        Refresh
      </button>
      <span role="status" aria-live="polite" className="sr-only" data-testid={`${id}-status`}>
        {announcement}
      </span>
    </div>
  );
}
