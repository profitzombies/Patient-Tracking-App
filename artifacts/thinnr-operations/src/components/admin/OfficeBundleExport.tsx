/**
 * "Export entire office record" — everything one office owns, as one bundle.
 *
 * HQ (holding provider management) uses this when an office leaves THINNR,
 * changes vendors, or its records are subpoenaed. The server offers the
 * office-bundle kind only to those callers, so the button renders only when
 * the caller's export options include it.
 *
 * The dialog first shows what the bundle would hold — the live patient count,
 * purged-patient tombstones, and a size estimate taken from the nightly size
 * snapshots — and asks for confirmation. The job then runs in the background
 * (it survives restarts and resumes from the last packed patient); progress
 * and one download per numbered ZIP part show here and in the Exports panel.
 * Every request and every part download is audited against the office.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Archive, Ban, CheckCircle2, Clock3, Loader2 } from 'lucide-react';
import {
  getGetOfficeBundleEstimateQueryKey,
  getListExportsQueryKey,
  useGetOfficeBundleEstimate,
  useListExports,
  type ExportJob,
} from '@workspace/api-client-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BTN_PRIMARY, BTN_SECONDARY, PANEL_LABEL } from '@/components/patient/heritage';
import { useSession } from '@/contexts/session';
import { useToast } from '@/hooks/use-toast';
import { bundleEstimateLabel, countLabel, expiryLabel, formatBytes, progressLabel, requestExportJob } from '@/lib/export-jobs';
import { politeInterval } from '@/lib/polite-refetch';
import { ExportCancelButton, ExportDownloadButtons, apiErrorMessage, useExportCancel, useExportDownload } from '@/components/exports/ExportDownloads';

const PENDING: ReadonlySet<ExportJob['status']> = new Set(['queued', 'running']);

const STATUS_LABELS: Record<ExportJob['status'], string> = {
  queued: 'Queued',
  running: 'Building',
  ready: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

const STATUS_STYLES: Record<ExportJob['status'], string> = {
  queued: 'border-border bg-secondary text-muted-foreground',
  running: 'border-accent-border bg-accent text-primary',
  ready: 'border-[#bfe3c5] bg-[#eaf7ec] text-[#1f6b34]',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  cancelled: 'border-border bg-secondary text-muted-foreground',
  expired: 'border-border bg-secondary text-muted-foreground',
};

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function OfficeBundleExport({ officeId, officeName }: { officeId: string; officeName: string }) {
  const { authStatus, authUser } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [includeTombstones, setIncludeTombstones] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const signedIn = authStatus === 'signed-in';

  const list = useListExports(undefined, {
    query: {
      enabled: signedIn,
      queryKey: [...getListExportsQueryKey(), authUser?.id],
      refetchInterval: (query) => {
        const jobs = query.state.data?.jobs ?? [];
        return politeInterval(jobs.some((job) => PENDING.has(job.status)) ? 3_000 : 60_000);
      },
    },
  });
  const allowed = (list.data?.available ?? []).some((option) => option.kind === 'office_bundle');
  // The estimate is only fetched while the dialog is open: it counts the office live.
  const estimate = useGetOfficeBundleEstimate({ office: officeId }, {
    query: {
      enabled: signedIn && allowed && open,
      queryKey: [...getGetOfficeBundleEstimateQueryKey({ office: officeId }), authUser?.id],
      staleTime: 30_000,
    },
  });
  // Bundles move an office's whole record out of the system: the request
  // rides the re-auth-aware office client so a fresh-code challenge can retry it.
  const request = useMutation({ mutationFn: (data: Parameters<typeof requestExportJob>[0]) => requestExportJob(data) });
  const { download, downloading } = useExportDownload();
  const { cancel, cancelling } = useExportCancel();

  if (!signedIn || !allowed) return null;

  const jobs = (list.data?.jobs ?? []).filter((job) => job.kind === 'office_bundle' && job.scope.providerId === officeId);
  const inFlight = jobs.some((job) => PENDING.has(job.status));
  const ttlHours = list.data?.ttlHours ?? 24;

  const submit = async () => {
    setFormError(null);
    try {
      await request.mutateAsync({ kind: 'office_bundle', office: officeId, includeTombstones });
      await queryClient.invalidateQueries({ queryKey: getListExportsQueryKey() });
      toast({ variant: 'success', title: 'Office record export started', description: `${officeName}'s bundle is being built in the background. Download links appear here when it is ready.` });
    } catch (error) {
      setFormError(apiErrorMessage(error, 'The office record export could not be requested right now.'));
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`${BTN_SECONDARY} h-9 px-3.5`} data-testid="button-export-office-record">
        <Archive size={14} className="text-primary" aria-hidden="true" />Export entire office record
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[620px]" data-testid="dialog-office-bundle-export">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Export {officeName}&apos;s entire record</DialogTitle>
            <DialogDescription>
              Builds one bundle of everything this office owns: a folder per patient with the same complete archive a right-of-access request produces (sealed charts included, each with its printable record summary), plus the office&apos;s own records as CSVs — orders, payments, refunds, shipments, subscriptions, staff team, audit events, and patient activity. A top-level manifest lists every file with a checksum. Large offices arrive as numbered ZIP parts.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-md border border-border bg-secondary px-3 py-2.5 text-xs" data-testid="text-office-bundle-estimate" aria-live="polite">
            {estimate.isPending ? (
              <span className="text-muted-foreground">Counting this office&apos;s records…</span>
            ) : estimate.isError ? (
              <span className="text-destructive" role="alert">
                {apiErrorMessage(estimate.error, 'The size estimate could not be loaded.')}{' '}
                <button type="button" className="underline" onClick={() => void estimate.refetch()}>Try again</button>
              </span>
            ) : (
              <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto,1fr]">
                <dt className="font-semibold text-navy">Patients</dt>
                <dd data-testid="text-office-bundle-patients">
                  {estimate.data.patientCount.toLocaleString('en-US')} patient record{estimate.data.patientCount === 1 ? '' : 's'}
                  {estimate.data.tombstoneCount > 0 ? ` · ${estimate.data.tombstoneCount.toLocaleString('en-US')} purged patient${estimate.data.tombstoneCount === 1 ? '' : 's'} on file as tombstones` : ''}
                </dd>
                <dt className="font-semibold text-navy">Estimated size</dt>
                <dd data-testid="text-office-bundle-size">{bundleEstimateLabel(estimate.data)}</dd>
              </dl>
            )}
          </div>

          <label className="flex items-start gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={includeTombstones}
              onChange={(event) => setIncludeTombstones(event.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-primary"
              data-testid="checkbox-office-bundle-tombstones"
            />
            <span>
              <b className="font-semibold text-navy">Include purged-patient tombstones.</b> Adds an office/tombstones.csv of former patients whose records were already purged — ids and dates only, no names or health details — so the bundle&apos;s counts reconcile with the office&apos;s history.
            </span>
          </label>

          <p className="rounded-md border border-[#f0d9a8] bg-[#fff8e6] px-3 py-2 text-xs text-[#6b4a00]" data-testid="text-office-bundle-notice">
            This request, and every part downloaded from the result, is recorded in the HQ audit log with your name and this office&apos;s id. Download links are HQ-only and expire {ttlHours} hours after the bundle is ready. Building does not disable the office or seal its patients.
          </p>
          {formError && <p className="text-xs text-destructive" role="alert" data-testid="text-office-bundle-error">{formError}</p>}
          <DialogFooter className="gap-2 sm:gap-2">
            <button type="button" onClick={() => setOpen(false)} className={`${BTN_SECONDARY} h-9 px-4`} data-testid="button-office-bundle-cancel">Close</button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={request.isPending || inFlight || estimate.isPending || estimate.isError}
              className={`${BTN_PRIMARY} h-9 px-4`}
              data-testid="button-office-bundle-confirm"
            >
              {request.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
              {inFlight ? 'Bundle in progress' : 'Build the bundle'}
            </button>
          </DialogFooter>

          <section aria-labelledby="office-bundle-history" className="mt-2 border-t border-border pt-4">
            <h3 id="office-bundle-history" className={PANEL_LABEL}>Office record bundles</h3>
            {list.isPending ? (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="text-office-bundles-loading">Loading…</p>
            ) : list.isError ? (
              <p className="mt-2 text-xs text-destructive" role="alert" data-testid="text-office-bundles-error">
                {apiErrorMessage(list.error, 'Office bundles could not be loaded.')} <button type="button" className="underline" onClick={() => void list.refetch()}>Try again</button>
              </p>
            ) : jobs.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="text-office-bundles-empty">No bundle has been built for this office yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-md border border-border" data-testid="list-office-bundles">
                {jobs.map((job) => {
                  const pending = PENDING.has(job.status);
                  const size = formatBytes(job.sizeBytes);
                  const count = countLabel(job);
                  return (
                    <li key={job.id} className="px-3 py-2.5" data-testid={`office-bundle-${job.id}`} data-status={job.status}>
                      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-navy">
                        <span>Requested {formatWhen(job.createdAt)}</span>
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[.08em] ${STATUS_STYLES[job.status]}`}
                          data-testid={`status-office-bundle-${job.id}`}
                        >
                          {pending ? <Loader2 size={10} className="animate-spin" aria-hidden="true" /> : job.status === 'ready' ? <CheckCircle2 size={10} aria-hidden="true" /> : job.status === 'failed' ? <AlertCircle size={10} aria-hidden="true" /> : job.status === 'cancelled' ? <Ban size={10} aria-hidden="true" /> : <Clock3 size={10} aria-hidden="true" />}
                          {STATUS_LABELS[job.status]}
                        </span>
                        <span className="ml-auto text-[10px] font-normal text-muted-foreground" data-testid={`text-office-bundle-expiry-${job.id}`}>
                          {job.status === 'expired' ? 'Expired' : job.status === 'failed' || job.status === 'cancelled' ? '' : expiryLabel(job.expiresAt)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid={`text-office-bundle-summary-${job.id}`}>
                        {[
                          count,
                          size,
                          job.parts && job.parts.length > 1 ? `${job.parts.length} parts` : null,
                          job.includeTombstones ? 'with tombstones' : null,
                          job.downloadCount > 0 ? `downloaded ${job.downloadCount}×` : null,
                        ].filter(Boolean).join(' · ') || 'Bundle'}
                      </p>
                      {pending && (
                        <p className="mt-1 text-[11px] text-primary" aria-live="polite" data-testid={`text-office-bundle-progress-${job.id}`}>
                          {progressLabel(job.status, job.progress, job.cancelRequested)}
                        </p>
                      )}
                      {job.status === 'ready' && job.omittedFiles ? (
                        <p className="mt-1 text-[11px] text-[#8a5a00]" data-testid={`text-office-bundle-omitted-${job.id}`}>
                          {job.omittedFiles.toLocaleString('en-US')} stored file{job.omittedFiles === 1 ? ' was' : 's were'} not found in storage and could not be included; manifest.json lists {job.omittedFiles === 1 ? 'it' : 'each one'}.
                        </p>
                      ) : null}
                      {job.status === 'failed' && job.error && <p className="mt-1 text-[11px] text-destructive" data-testid={`text-office-bundle-failed-${job.id}`}>{job.error}</p>}
                      {job.status === 'cancelled' && (
                        <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`text-office-bundle-cancelled-${job.id}`}>
                          Cancelled before it finished; every part written so far was removed. Build it again if you still need it.
                        </p>
                      )}
                      {job.status === 'expired' && <p className="mt-1 text-[11px] text-muted-foreground">{job.error ?? 'This bundle has expired and was removed. Build it again if you still need it.'}</p>}
                      {pending && (
                        <div className="mt-2">
                          <ExportCancelButton job={job} cancelling={cancelling} onCancel={(target) => void cancel(target)} />
                        </div>
                      )}
                      {job.downloadable && (
                        <div className="mt-2">
                          <ExportDownloadButtons job={job} downloading={downloading} onDownload={(target, part) => void download(target, part)} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </DialogContent>
      </Dialog>
    </>
  );
}
