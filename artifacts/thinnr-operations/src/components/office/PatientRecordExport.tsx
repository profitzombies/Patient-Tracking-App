/**
 * "Download full record" — a right-of-access copy of one patient's chart.
 *
 * Office owners and admins (and HQ holding provider management for the
 * office) can request the same complete archive the patient's own export
 * builds, plus a printable record-summary.pdf in part 1. The server decides
 * who may ask: the button only renders when the caller's export options
 * include the patient-record kind, so office staff never see it.
 *
 * The dialog explains what leaves the office, asks for confirmation, then
 * lists this patient's record exports with build progress and one download
 * per numbered ZIP part. A queued or running build can be cancelled from
 * the list: the worker stops at its next part boundary and removes every
 * part it wrote. Every request, cancel, and download is audited against
 * the patient.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Archive, Ban, CheckCircle2, Clock3, Loader2 } from 'lucide-react';
import {
  getListExportsQueryKey,
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
import { EXPORT_STATUS_LABELS, countLabel, expiryLabel, formatBytes, progressLabel, requestExportJob } from '@/lib/export-jobs';
import { politeInterval } from '@/lib/polite-refetch';
import { ExportCancelButton, ExportDownloadButtons, apiErrorMessage, useExportCancel, useExportDownload } from '@/components/exports/ExportDownloads';

const PENDING: ReadonlySet<ExportJob['status']> = new Set(['queued', 'running']);

const STATUS_STYLES: Record<ExportJob['status'], string> = {
  queued: 'border-border bg-secondary text-muted-foreground',
  running: 'border-accent-border bg-accent text-primary',
  ready: 'border-[#bfe3c5] bg-[#eaf7ec] text-[#1f6b34]',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  expired: 'border-border bg-secondary text-muted-foreground',
  cancelled: 'border-border bg-secondary text-muted-foreground',
};

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function PatientRecordExport({ patientId, patientName, office }: {
  patientId: string;
  patientName: string;
  /** HQ drill-in: the office account id every request must name. Null for office staff. */
  office: string | null;
}) {
  const { authStatus, authUser } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const signedIn = authStatus === 'signed-in';

  const list = useListExports({ patient: patientId }, {
    query: {
      enabled: signedIn,
      queryKey: [...getListExportsQueryKey({ patient: patientId }), authUser?.id],
      refetchInterval: (query) => {
        const jobs = query.state.data?.jobs ?? [];
        return politeInterval(jobs.some((job) => PENDING.has(job.status)) ? 3_000 : 60_000);
      },
    },
  });
  // Exports move patient data out of the system: the request rides the
  // re-auth-aware office client so a fresh-code challenge can retry it.
  const request = useMutation({ mutationFn: (data: Parameters<typeof requestExportJob>[0]) => requestExportJob(data) });
  const { download, downloading } = useExportDownload();
  const { cancel, cancelling } = useExportCancel();

  const allowed = (list.data?.available ?? []).some((option) => option.kind === 'patient_record');
  if (!signedIn || !allowed) return null;

  const jobs = (list.data?.jobs ?? []).filter((job) => job.kind === 'patient_record' && job.scope.patientId === patientId);
  const inFlight = jobs.some((job) => PENDING.has(job.status));
  const ttlHours = list.data?.ttlHours ?? 24;

  const submit = async () => {
    setFormError(null);
    try {
      await request.mutateAsync({ kind: 'patient_record', patientId, office });
      await queryClient.invalidateQueries({ queryKey: getListExportsQueryKey() });
      toast({ variant: 'success', title: 'Record export started', description: `${patientName}'s archive is being built. Download links appear here when it is ready.` });
    } catch (error) {
      setFormError(apiErrorMessage(error, 'The record export could not be requested right now.'));
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`${BTN_SECONDARY} h-9 px-4`} data-testid="button-download-full-record">
        <Archive size={14} className="text-primary" aria-hidden="true" />Download full record
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]" data-testid="dialog-patient-record-export">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Download {patientName}&apos;s full record</DialogTitle>
            <DialogDescription>
              Builds a complete copy of this chart for a right-of-access request: identity and enrollment, weigh-ins and measurements, food and water diary, medications with dose history, bloodwork results and lab files, every progress photo, care-team conversations, coach conversations, orders, and consent history. Part 1 opens with a printable record-summary.pdf. Large records arrive as numbered ZIP parts; manifest.json lists every part and file.
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-md border border-[#f0d9a8] bg-[#fff8e6] px-3 py-2 text-xs text-[#6b4a00]" data-testid="text-record-export-notice">
            This request, and every download of the result, is recorded in the office audit log with your name. Links expire {ttlHours} hours after the archive is ready.
          </p>
          {formError && <p className="text-xs text-destructive" role="alert" data-testid="text-record-export-error">{formError}</p>}
          <DialogFooter className="gap-2 sm:gap-2">
            <button type="button" onClick={() => setOpen(false)} className={`${BTN_SECONDARY} h-9 px-4`} data-testid="button-record-export-cancel">Close</button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={request.isPending || inFlight}
              className={`${BTN_PRIMARY} h-9 px-4`}
              data-testid="button-record-export-confirm"
            >
              {request.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
              {inFlight ? 'Archive in progress' : 'Build the archive'}
            </button>
          </DialogFooter>

          <section aria-labelledby="record-export-history" className="mt-2 border-t border-border pt-4">
            <h3 id="record-export-history" className={PANEL_LABEL}>Record downloads for this patient</h3>
            {list.isPending ? (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="text-record-exports-loading">Loading…</p>
            ) : list.isError ? (
              <p className="mt-2 text-xs text-destructive" role="alert" data-testid="text-record-exports-error">
                {apiErrorMessage(list.error, 'Record exports could not be loaded.')} <button type="button" className="underline" onClick={() => void list.refetch()}>Try again</button>
              </p>
            ) : jobs.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="text-record-exports-empty">No archive has been built for this patient yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-md border border-border" data-testid="list-record-exports">
                {jobs.map((job) => {
                  const pending = PENDING.has(job.status);
                  const size = formatBytes(job.sizeBytes);
                  const count = countLabel(job);
                  return (
                    <li key={job.id} className="px-3 py-2.5" data-testid={`record-export-${job.id}`} data-status={job.status}>
                      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-navy">
                        <span>Requested {formatWhen(job.createdAt)}</span>
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[.08em] ${STATUS_STYLES[job.status]}`}
                          data-testid={`status-record-export-${job.id}`}
                        >
                          {pending ? <Loader2 size={10} className="animate-spin" aria-hidden="true" /> : job.status === 'ready' ? <CheckCircle2 size={10} aria-hidden="true" /> : job.status === 'failed' ? <AlertCircle size={10} aria-hidden="true" /> : job.status === 'cancelled' ? <Ban size={10} aria-hidden="true" /> : <Clock3 size={10} aria-hidden="true" />}
                          {EXPORT_STATUS_LABELS[job.status]}
                        </span>
                        <span className="ml-auto text-[10px] font-normal text-muted-foreground" data-testid={`text-record-export-expiry-${job.id}`}>
                          {job.status === 'expired' ? 'Expired' : job.status === 'failed' || job.status === 'cancelled' ? '' : expiryLabel(job.expiresAt)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {[count, size, job.parts && job.parts.length > 1 ? `${job.parts.length} parts` : null, job.downloadCount > 0 ? `downloaded ${job.downloadCount}×` : null].filter(Boolean).join(' · ') || 'Archive'}
                      </p>
                      {pending && (
                        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                          <p className="text-[11px] text-primary" aria-live="polite" data-testid={`text-record-export-progress-${job.id}`}>
                            {progressLabel(job.status, job.progress, job.cancelRequested)}
                          </p>
                          <ExportCancelButton job={job} cancelling={cancelling} onCancel={(target) => void cancel(target)} />
                        </div>
                      )}
                      {job.status === 'cancelled' && (
                        <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`text-record-export-cancelled-${job.id}`}>
                          Cancelled before it finished; nothing was kept. Build it again if you still need it.
                        </p>
                      )}
                      {job.status === 'ready' && job.omittedFiles ? (
                        <p className="mt-1 text-[11px] text-[#8a5a00]" data-testid={`text-record-export-omitted-${job.id}`}>
                          {job.omittedFiles.toLocaleString('en-US')} stored file{job.omittedFiles === 1 ? ' was' : 's were'} not found in storage and could not be included; manifest.json lists {job.omittedFiles === 1 ? 'it' : 'each one'}.
                        </p>
                      ) : null}
                      {job.status === 'failed' && job.error && <p className="mt-1 text-[11px] text-destructive" data-testid={`text-record-export-failed-${job.id}`}>{job.error}</p>}
                      {job.status === 'expired' && <p className="mt-1 text-[11px] text-muted-foreground">{job.error ?? 'This archive has expired and was removed. Build it again if you still need it.'}</p>}
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
