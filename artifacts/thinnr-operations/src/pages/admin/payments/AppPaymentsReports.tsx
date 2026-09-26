/**
 * App payment reports: three HQ-only CSVs through the shared export system.
 * Each button sends the range the page is showing (the forecast window, the
 * collected history range); the job list below is the Exports panel limited
 * to these kinds. Patient shop and office sales never appear in them.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileDown, Loader2 } from 'lucide-react';
import { getListExportsQueryKey, useListExports, type ExportKind } from '@workspace/api-client-react';
import { ExportsPanel } from '@/components/exports/ExportsPanel';
import { apiErrorMessage } from '@/components/exports/ExportDownloads';
import { useSession } from '@/contexts/session';
import { useToast } from '@/hooks/use-toast';
import { requestExportJob } from '@/lib/export-jobs';
import type { DayWindow } from '@/lib/app-payments';

export const APP_PAYMENT_EXPORT_KINDS = ['app_payments_offices', 'app_payments_forecast', 'app_payments_transactions'] as const;
type AppPaymentExportKind = (typeof APP_PAYMENT_EXPORT_KINDS)[number];

const REPORTS: { kind: AppPaymentExportKind; id: string; label: string; detail: (props: ReportsProps) => string }[] = [
  { kind: 'app_payments_offices', id: 'offices', label: 'Billable offices', detail: () => 'Snapshot of the office list as of now' },
  { kind: 'app_payments_forecast', id: 'forecast', label: 'Scheduled charges and forecast', detail: ({ forecastWindow }) => (forecastWindow ? `${forecastWindow.start} to ${forecastWindow.end}` : 'Pick a valid forecast window first') },
  { kind: 'app_payments_transactions', id: 'transactions', label: 'App payment transactions', detail: ({ historyWindow }) => `${historyWindow.start} to ${historyWindow.end}` },
];

interface ReportsProps {
  demo: boolean;
  forecastWindow: DayWindow | null;
  historyWindow: DayWindow;
}

export function AppPaymentsReports(props: ReportsProps) {
  const { demo, forecastWindow, historyWindow } = props;
  const { authStatus, authUser } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const signedIn = !demo && authStatus === 'signed-in';
  // Same key as the Exports panel below, so both share one list request.
  const list = useListExports(undefined, { query: { enabled: signedIn, queryKey: [...getListExportsQueryKey(), authUser?.id] } });
  const allowed = new Set((list.data?.available ?? []).map((option) => option.kind));
  const [busy, setBusy] = useState<AppPaymentExportKind | null>(null);

  const request = async (kind: AppPaymentExportKind) => {
    const range = kind === 'app_payments_forecast' ? forecastWindow : kind === 'app_payments_transactions' ? historyWindow : null;
    if (kind === 'app_payments_forecast' && !range) return;
    setBusy(kind);
    try {
      const result = await requestExportJob({ kind: kind as ExportKind, office: null, ...(range ? { start: range.start, end: range.end } : {}) });
      await queryClient.invalidateQueries({ queryKey: getListExportsQueryKey() });
      toast({ variant: 'success', title: `${result.job.label} report queued`, description: 'It appears in the list below as soon as the file is ready.' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Report not requested', description: apiErrorMessage(error, 'The report could not be requested right now.') });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="reports-title" className="mt-8">
      <h2 id="reports-title" className="font-serif text-[17px] font-bold text-navy">Reports</h2>
      <p className="mb-3 mt-0.5 text-[11px] text-muted-foreground">
        CSV files of app revenue only — patient shop and office sales are never included. Test mode reports cover Test mode data only.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {REPORTS.map((report) => {
          const unavailable = !signedIn || (list.isSuccess && !allowed.has(report.kind)) || (report.kind === 'app_payments_forecast' && !forecastWindow);
          return (
            <div key={report.kind} className="flex flex-col justify-between gap-3 rounded-lg border border-card-border bg-card p-4 shadow-soft">
              <div>
                <p className="text-xs font-semibold text-navy">{report.label}</p>
                <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`text-report-${report.id}-range`}>{report.detail(props)}</p>
              </div>
              <button
                type="button"
                disabled={unavailable || busy !== null}
                onClick={() => void request(report.kind)}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-xs transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                data-testid={`button-report-${report.id}`}
              >
                {busy === report.kind ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <FileDown size={14} aria-hidden="true" />}
                Download CSV
              </button>
            </div>
          );
        })}
      </div>
      {demo ? (
        <p className="mt-3 text-[11px] text-muted-foreground" data-testid="text-reports-demo">Reports need a signed-in HQ account.</p>
      ) : (
        <ExportsPanel kinds={APP_PAYMENT_EXPORT_KINDS} hideRequestForm title="Report downloads" className="mt-4" />
      )}
    </section>
  );
}
