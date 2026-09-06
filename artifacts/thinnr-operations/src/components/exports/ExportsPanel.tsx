/**
 * Exports panel — request CSV exports and pick up the finished files.
 *
 * Shared by HQ (/admin/exports) and the office Analytics page. The server
 * decides what the caller may export (the `available` list) and pins office
 * staff to their own office; this panel only shapes the request:
 *   - ranged kinds ride the shared operations date range,
 *   - HQ patient-activity exports need one explicit office (aggregate-only
 *     otherwise, enforced server-side and mirrored in the copy here),
 *   - jobs poll while queued/running, downloads mint a short-lived signed
 *     link on click, expired jobs stay listed but not downloadable.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Clock3, Download, FileDown, Loader2, RefreshCw } from 'lucide-react';
import {
  getExportDownloadUrl,
  getListExportsQueryKey,
  useListExports,
  useRequestExport,
  type ExportJob,
  type ExportKind,
  type ExportKindOption,
} from '@workspace/api-client-react';
import { formatRangeLabel, useDateRange } from '@/contexts/date-range';
import { useSession } from '@/contexts/session';
import { useToast } from '@/hooks/use-toast';
import { openDownload } from '@/lib/training-media';
import { expiryLabel } from '@/lib/export-jobs';

export interface ExportOfficeOption {
  /** Provider account id; an empty id means "whatever office the server pins me to". */
  id: string;
  name: string;
}

interface ExportsPanelProps {
  /** HQ: offices selectable for office-scoped exports. Omit for office staff. */
  officeOptions?: ExportOfficeOption[];
  /** Pin every request to one office (office staff, or an HQ drill-in). */
  pinnedOffice?: ExportOfficeOption | null;
  /** Override the section heading. */
  title?: string;
  className?: string;
}

const PENDING: ReadonlySet<ExportJob['status']> = new Set(['queued', 'running']);

const STATUS_STYLES: Record<ExportJob['status'], string> = {
  queued: 'border-border bg-secondary text-muted-foreground',
  running: 'border-accent-border bg-accent text-primary',
  ready: 'border-[#bfe3c5] bg-[#eaf7ec] text-[#1f6b34]',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  expired: 'border-border bg-secondary text-muted-foreground',
};

const STATUS_LABELS: Record<ExportJob['status'], string> = {
  queued: 'Queued',
  running: 'Generating',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
};

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const data = (error as { data?: { error?: unknown } }).data;
    if (data && typeof data.error === 'string' && data.error) return data.error;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatBytes(bytes: number | null): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ExportsPanel({ officeOptions = [], pinnedOffice = null, title = 'Exports', className }: ExportsPanelProps) {
  const { range, mode } = useDateRange();
  const { authUser, authStatus } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const signedIn = authStatus === 'signed-in';
  const listQuery = useListExports({
    query: {
      enabled: signedIn,
      queryKey: [...getListExportsQueryKey(), authUser?.id],
      refetchInterval: (query) => {
        const jobs = query.state.data?.jobs ?? [];
        return jobs.some((job) => PENDING.has(job.status)) ? 3_000 : 60_000;
      },
    },
  });
  const requestMutation = useRequestExport();

  const available: ExportKindOption[] = listQuery.data?.available ?? [];
  const jobs: ExportJob[] = listQuery.data?.jobs ?? [];
  const ttlHours = listQuery.data?.ttlHours ?? 24;

  const [kind, setKind] = useState<ExportKind | ''>('');
  const [officeId, setOfficeId] = useState<string>(pinnedOffice?.id ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    if (!kind && available.length > 0) setKind(available[0].kind);
  }, [available, kind]);
  useEffect(() => {
    if (pinnedOffice) setOfficeId(pinnedOffice.id);
  }, [pinnedOffice]);

  const selected = useMemo(() => available.find((option) => option.kind === kind) ?? null, [available, kind]);
  const rangeLabel = formatRangeLabel(range);
  const showOfficePicker = !pinnedOffice && Boolean(selected) && officeOptions.length > 0 && selected!.kind !== 'provider_directory';
  const officeRequired = Boolean(selected?.needsOffice) && !pinnedOffice;

  const submit = async () => {
    if (!selected) return;
    setFormError(null);
    if (officeRequired && !officeId) {
      setFormError('Choose an office. Patient activity exports are aggregate-only network-wide, so HQ must pick one office it manages.');
      return;
    }
    const body = {
      kind: selected.kind,
      office: pinnedOffice ? pinnedOffice.id || null : officeId || null,
      ...(selected.ranged ? { start: range.start, end: range.end } : {}),
    };
    try {
      const result = await requestMutation.mutateAsync({ data: body });
      await queryClient.invalidateQueries({ queryKey: getListExportsQueryKey() });
      toast({
        variant: 'success',
        title: `${result.job.label} export queued`,
        description: 'It will appear below as soon as the file is ready.',
      });
    } catch (error) {
      setFormError(apiErrorMessage(error, 'The export could not be requested right now.'));
    }
  };

  const download = async (job: ExportJob) => {
    setDownloading(job.id);
    try {
      const result = await getExportDownloadUrl(job.id);
      openDownload(result.url);
      toast({
        variant: 'success',
        title: 'Download started',
        description: `${result.fileName ?? job.fileName ?? 'export.csv'} · link valid for ${Math.round(result.expiresInSeconds / 60)} minutes.`,
      });
      queryClient.invalidateQueries({ queryKey: getListExportsQueryKey() });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Download unavailable',
        description: apiErrorMessage(error, 'This export could not be downloaded.'),
      });
      queryClient.invalidateQueries({ queryKey: getListExportsQueryKey() });
    } finally {
      setDownloading(null);
    }
  };

  return (
    <section
      className={`rounded-lg border border-card-border bg-card shadow-soft ${className ?? ''}`}
      aria-labelledby="exports-panel-title"
      data-testid="panel-exports"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-secondary px-5 py-4">
        <div>
          <h2 id="exports-panel-title" className="font-serif text-[15px] font-bold text-navy">{title}</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            CSV files generated in the background. Downloads use a short-lived link and files expire after {ttlHours} hours.
            {mode === 'demo' && ' Exports need a signed-in staff account.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => listQuery.refetch()}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[11px] font-semibold text-navy hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="button-exports-refresh"
        >
          <RefreshCw size={12} aria-hidden="true" className={listQuery.isFetching ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="border-b border-border px-5 py-4">
        {!signedIn ? (
          <p className="text-xs text-muted-foreground" data-testid="text-exports-signed-out">Sign in with a staff account to request exports.</p>
        ) : listQuery.isPending ? (
          <p className="text-xs text-muted-foreground" data-testid="text-exports-loading">Loading export options…</p>
        ) : listQuery.isError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert" data-testid="text-exports-error">
            <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>{apiErrorMessage(listQuery.error, 'Exports could not be loaded.')} <button type="button" className="underline" onClick={() => listQuery.refetch()}>Try again</button></span>
          </div>
        ) : available.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="text-exports-none">Your role has no export types available.</p>
        ) : (
          <form
            className="grid gap-3 sm:grid-cols-[minmax(0,1fr),minmax(0,1fr),auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="block text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
              Export type
              <select
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as ExportKind);
                  setFormError(null);
                }}
                className="mt-1 block h-9 w-full rounded-md border border-border bg-card px-2.5 text-xs font-medium normal-case tracking-normal text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="select-export-kind"
              >
                {available.map((option) => (
                  <option key={option.kind} value={option.kind}>{option.label}</option>
                ))}
              </select>
            </label>

            {showOfficePicker ? (
              <label className="block text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                Office{officeRequired ? '' : ' (optional)'}
                <select
                  value={officeId}
                  onChange={(event) => {
                    setOfficeId(event.target.value);
                    setFormError(null);
                  }}
                  className="mt-1 block h-9 w-full rounded-md border border-border bg-card px-2.5 text-xs font-medium normal-case tracking-normal text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="select-export-office"
                >
                  <option value="">{officeRequired ? 'Choose an office…' : 'All offices'}</option>
                  {officeOptions.map((office) => (
                    <option key={office.id} value={office.id}>{office.name}</option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="text-[11px] text-muted-foreground sm:pb-2" data-testid="text-export-scope">
                {pinnedOffice ? <>Scoped to <b className="font-semibold text-navy">{pinnedOffice.name}</b>.</> : 'Network-wide.'}
              </p>
            )}

            <button
              type="submit"
              disabled={requestMutation.isPending || !selected}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-xs transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              data-testid="button-request-export"
            >
              {requestMutation.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <FileDown size={14} aria-hidden="true" />}
              Request CSV
            </button>

            <p className="text-[11px] text-muted-foreground sm:col-span-3" data-testid="text-export-range">
              {selected?.ranged
                ? <>Covers <b className="font-semibold text-navy">{rangeLabel}</b> — change the date range in the header to export a different period.</>
                : 'Current directory snapshot; no date range applies.'}
            </p>
            {formError && (
              <p className="text-xs text-destructive sm:col-span-3" role="alert" data-testid="text-export-form-error">{formError}</p>
            )}
          </form>
        )}
      </div>

      <ul className="divide-y divide-border" data-testid="list-export-jobs">
        {signedIn && !listQuery.isPending && !listQuery.isError && jobs.length === 0 && (
          <li className="px-5 py-6 text-center text-xs text-muted-foreground" data-testid="text-export-jobs-empty">
            No exports yet. Request one above.
          </li>
        )}
        {jobs.map((job) => {
          const pending = PENDING.has(job.status);
          const size = formatBytes(job.sizeBytes);
          return (
            <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5" data-testid={`export-job-${job.id}`} data-status={job.status}>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-navy">
                  <span data-testid={`text-export-label-${job.id}`}>{job.label}</span>
                  <span
                    className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[.08em] ${STATUS_STYLES[job.status]}`}
                    data-testid={`status-export-${job.id}`}
                  >
                    {pending ? <Loader2 size={10} className="animate-spin" aria-hidden="true" /> : job.status === 'ready' ? <CheckCircle2 size={10} aria-hidden="true" /> : job.status === 'failed' ? <AlertCircle size={10} aria-hidden="true" /> : <Clock3 size={10} aria-hidden="true" />}
                    {STATUS_LABELS[job.status]}
                  </span>
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {job.scope.officeName ?? 'All offices'}
                  {job.range ? ` · ${formatRangeLabel(job.range)}` : ''}
                  {' · '}Requested {formatWhen(job.createdAt)}
                  {job.rowCount != null ? ` · ${job.rowCount.toLocaleString('en-US')} rows` : ''}
                  {size ? ` · ${size}` : ''}
                </p>
                {job.status === 'failed' && job.error && (
                  <p className="mt-1 text-[11px] text-destructive" data-testid={`text-export-error-${job.id}`}>{job.error}</p>
                )}
                {job.status === 'expired' && (
                  <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`text-export-expired-${job.id}`}>
                    {job.error ?? 'This file has expired and was removed. Request it again if you still need it.'}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-muted-foreground" data-testid={`text-export-expiry-${job.id}`}>
                  {job.status === 'expired' ? 'Expired' : job.status === 'failed' ? '' : expiryLabel(job.expiresAt)}
                </span>
                {job.downloadable && (
                  <button
                    type="button"
                    onClick={() => download(job)}
                    disabled={downloading === job.id}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[11px] font-semibold text-navy hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    aria-label={`Download ${job.label} CSV (${job.fileName ?? 'export.csv'})`}
                    data-testid={`button-download-export-${job.id}`}
                  >
                    {downloading === job.id ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
                    Download
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
