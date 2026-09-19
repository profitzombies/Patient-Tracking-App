/**
 * Download controls shared by the Exports panel and the patient page's
 * record-download dialog: one button for single-file exports, one button per
 * numbered ZIP part for multi-part archives. Every click mints a fresh
 * short-lived signed link (the server audits each part separately).
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Loader2 } from 'lucide-react';
import { getExportDownloadUrl, getListExportsQueryKey, type ExportJob } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { openDownload } from '@/lib/training-media';
import { partLabel } from '@/lib/export-jobs';

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

const BUTTON =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[11px] font-semibold text-navy hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

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
