/**
 * Download controls shared by the Exports panel and the patient page's
 * record-download dialog: one button for single-file exports, one button per
 * numbered ZIP part for multi-part archives. Every click mints a fresh
 * short-lived signed link (the server audits each part separately).
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, Download, Loader2 } from 'lucide-react';
import { getExportDownloadUrl, getListExportsQueryKey, type ExportJob } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { openDownload } from '@/lib/training-media';
import { cancelExportJob, cancellable, partLabel } from '@/lib/export-jobs';

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const data = (error as { data?: { error?: unknown } }).data;
    if (data && typeof data.error === 'string' && data.error) return data.error;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

export function useExportDownload() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [downloading, setDownloading] = useState<string | null>(null);
  const download = async (job: ExportJob, part: number | null = null) => {
    const key = part == null ? job.id : `${job.id}:${part}`;
    setDownloading(key);
    try {
      const result = await getExportDownloadUrl(job.id, part == null ? undefined : { part });
      openDownload(result.url);
      toast({
        variant: 'success',
        title: 'Download started',
        description: `${result.fileName ?? job.fileName ?? 'export'} · link valid for ${Math.round(result.expiresInSeconds / 60)} minutes.`,
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Download unavailable',
        description: apiErrorMessage(error, 'This export could not be downloaded.'),
      });
    } finally {
      setDownloading(null);
      queryClient.invalidateQueries({ queryKey: getListExportsQueryKey() });
    }
  };
  return { download, downloading };
}

/**
 * Cancel a queued/running export. The request rides the re-auth-aware
 * office client; the list is refetched either way so the row shows the
 * server's verdict (cancelled, or "stopping" while the worker unwinds).
 */
export function useExportCancel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const cancel = async (job: ExportJob) => {
    setCancelling(job.id);
    try {
      const result = await cancelExportJob(job.id);
      const stopped = result.job.status === 'cancelled';
      toast({
        variant: 'success',
        title: stopped ? 'Export cancelled' : 'Export stopping',
        description: stopped
          ? `${job.scope.patientName ? `${job.scope.patientName}'s ` : ''}${job.label} was cancelled before anything was written.`
          : 'The build stops at the next part boundary and everything written so far is removed.',
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Could not cancel',
        description: apiErrorMessage(error, 'This export could not be cancelled.'),
      });
    } finally {
      setCancelling(null);
      queryClient.invalidateQueries({ queryKey: getListExportsQueryKey() });
    }
  };
  return { cancel, cancelling };
}

const BUTTON =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[11px] font-semibold text-navy hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

/**
 * The cancel control for one queued/running job. Once the worker has been
 * asked to stop the button stays visible but inert ("Stopping…") until the
 * next poll shows the row cancelled; it renders nothing for finished jobs.
 */
export function ExportCancelButton({ job, cancelling, onCancel }: {
  job: ExportJob;
  cancelling: string | null;
  onCancel: (job: ExportJob) => void;
}) {
  if (job.status !== 'queued' && job.status !== 'running') return null;
  const stopping = !cancellable(job);
  const busy = cancelling === job.id;
  const label = stopping ? 'Stopping…' : busy ? 'Cancelling…' : 'Cancel';
  return (
    <button
      type="button"
      onClick={() => { if (!stopping && !busy) onCancel(job); }}
      aria-disabled={stopping || busy ? true : undefined}
      className={`${BUTTON} ${stopping || busy ? 'cursor-default opacity-60' : 'hover:border-destructive/40 hover:text-destructive'}`}
      aria-label={`${stopping ? 'Stopping' : 'Cancel'} ${job.scope.patientName ? `${job.scope.patientName}'s ` : ''}${job.label} export`}
      data-testid={`button-cancel-export-${job.id}`}
      data-state={stopping ? 'stopping' : busy ? 'cancelling' : 'idle'}
    >
      {stopping || busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Ban size={12} aria-hidden="true" />}
      {label}
    </button>
  );
}

/** The download button(s) for one ready job. Renders nothing when not downloadable. */
export function ExportDownloadButtons({ job, downloading, onDownload }: {
  job: ExportJob;
  downloading: string | null;
  onDownload: (job: ExportJob, part: number | null) => void;
}) {
  if (!job.downloadable) return null;
  const parts = job.parts ?? [];
  if (parts.length <= 1) {
    const busy = downloading === job.id;
    return (
      <button
        type="button"
        onClick={() => onDownload(job, null)}
        disabled={busy}
        className={BUTTON}
        aria-label={`Download ${job.label} (${job.fileName ?? 'export'})`}
        data-testid={`button-download-export-${job.id}`}
      >
        {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
        Download
      </button>
    );
  }
  return (
    <ul className="flex flex-wrap items-center gap-2" aria-label={`${job.label} parts`} data-testid={`list-export-parts-${job.id}`}>
      {parts.map((part) => {
        const busy = downloading === `${job.id}:${part.part}`;
        return (
          <li key={part.part}>
            <button
              type="button"
              onClick={() => onDownload(job, part.part)}
              disabled={busy}
              className={BUTTON}
              aria-label={`Download ${job.label} part ${part.part} of ${parts.length} (${part.fileName})`}
              title={part.fileName}
              data-testid={`button-download-export-${job.id}-part-${part.part}`}
            >
              {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
              {partLabel(part, parts.length)}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
