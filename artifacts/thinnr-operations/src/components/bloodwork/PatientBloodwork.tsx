import { useEffect, useState } from 'react';
import { FileText, Eye, AlertCircle, RefreshCw, Info } from 'lucide-react';
import { useBloodworkReportsQuery, useBloodworkDetailQuery, useRetryExtractionMutation, useReviewReportMutation } from './use-bloodwork';
import { BloodworkViewer } from './BloodworkViewer';
import { BloodworkResultRow } from './BloodworkResultRow';
import { SectionCard, BTN_SECONDARY, CHIP_WARM, CHIP_COBALT, CHIP_RISK } from '@/components/patient/heritage';
import { useToast } from '@/hooks/use-toast';
import { useSession } from '@/contexts/session';

export function PatientBloodwork({ patientId, office, canEdit }: { patientId: string; office: string | null; canEdit: boolean }) {
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const { authUser } = useSession();
  const { reports, isLoading: listLoading, isError: listError, refresh: refreshList, hasNextPage, fetchNextPage, isFetchingNextPage } = useBloodworkReportsQuery(patientId, office);
  const actorKey = `${authUser?.id ?? 'signed-out'}:${office ?? 'own'}:${patientId}`;

  useEffect(() => {
    setSelectedReportId(null);
  }, [actorKey]);

  useEffect(() => {
    if (!listLoading && selectedReportId && !reports.some((report) => report.id === selectedReportId)) {
      setSelectedReportId(null);
    }
  }, [listLoading, reports, selectedReportId]);

  if (listLoading) {
    return (
      <SectionCard title="Bloodwork Reports">
        <div data-testid="bloodwork-list-loading" className="p-6 text-center text-xs text-muted-foreground animate-pulse">Loading reports...</div>
      </SectionCard>
    );
  }

  if (listError) {
    return (
      <SectionCard title="Bloodwork Reports">
        <div data-testid="bloodwork-list-error" className="p-6 text-center text-xs text-red-500 flex flex-col items-center">
          <AlertCircle size={20} className="mb-2" />
          <p>Could not load bloodwork reports.</p>
          <button onClick={() => refreshList()} className={`${BTN_SECONDARY} mt-3 px-4 py-1.5`}>Retry</button>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Bloodwork Reports">
      <div className="p-0">
        {reports.length === 0 ? (
          <div data-testid="bloodwork-list-empty" className="p-6 text-center text-xs text-muted-foreground">
            No bloodwork reports have been uploaded by this patient.
          </div>
        ) : (
          <div className="grid md:grid-cols-[300px_1fr] divide-x divide-border">
            <div className="divide-y divide-border overflow-y-auto max-h-[600px]">
              {reports.map((report) => (
                <button
                  key={report.id}
                  data-testid={`bloodwork-report-${report.id}`}
                  onClick={() => setSelectedReportId(report.id)}
                  className={`w-full text-left p-4 transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:bg-secondary ${selectedReportId === report.id ? 'bg-secondary relative before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-primary' : ''}`}
                >
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-semibold text-sm text-navy truncate pr-2">{report.title}</span>
                    <StatusBadge status={report.extractionStatus} />
                  </div>
                  <div className="text-[10px] text-muted-foreground flex flex-col gap-0.5">
                    <span>{report.reportDate ? `Reported: ${new Date(report.reportDate).toLocaleDateString()}` : 'Date unknown'}</span>
                    <span>Uploaded: {new Date(report.uploadedAt).toLocaleDateString()}</span>
                  </div>
                </button>
              ))}
               <div className="p-3 flex items-center justify-between gap-2">
                 <button data-testid="bloodwork-refresh-reports" onClick={() => void refreshList()} className="text-xs text-primary hover:underline">Refresh</button>
                 {hasNextPage && (
                   <button data-testid="bloodwork-load-more-reports" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage} className={BTN_SECONDARY}>
                     {isFetchingNextPage ? 'Loading...' : 'Load older reports'}
                   </button>
                 )}
               </div>
            </div>
            
            <div className="bg-paper-alt min-h-[400px]">
              {selectedReportId ? (
                <ReportDetail
                  key={`${actorKey}:${selectedReportId}`}
                  patientId={patientId} 
                  office={office} 
                  reportId={selectedReportId} 
                  canEdit={canEdit}
                />
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
                  <FileText size={32} className="mb-3 opacity-20" />
                  <p className="text-sm">Select a report to view details</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'completed') return <span className={CHIP_COBALT}>Completed</span>;
  if (status === 'failed') return <span className={CHIP_RISK}>Failed</span>;
  if (status === 'queued' || status === 'processing') return <span className={CHIP_WARM}>Processing</span>;
  return <span className={CHIP_WARM}>{status}</span>;
}

function ReportDetail({ patientId, office, reportId, canEdit }: { patientId: string; office: string | null; reportId: string; canEdit: boolean }) {
  const { data, isLoading, isError, refetch } = useBloodworkDetailQuery(patientId, office, reportId);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerInitialPage, setViewerInitialPage] = useState<{ fileId: string, page: number } | undefined>();
  const retryMutation = useRetryExtractionMutation(patientId, office);
  const reviewMutation = useReviewReportMutation(patientId, office);
  const { toast } = useToast();

  if (isLoading) return <div data-testid="bloodwork-detail-loading" className="p-6 text-center text-xs text-muted-foreground animate-pulse">Loading details...</div>;
  if (isError || !data) return (
    <div data-testid="bloodwork-detail-error" className="p-6 text-center flex flex-col items-center">
      <AlertCircle size={24} className="text-red-500 mb-2" />
      <p className="text-sm text-red-500 mb-4">Could not load report details</p>
      <button onClick={() => refetch()} className={BTN_SECONDARY}>Retry</button>
    </div>
  );

  const { report, files, results } = data;

  const handleRetry = () => {
    retryMutation.mutate({
      patientId,
      reportId: report.id,
      params: office ? { office } : undefined
    }, {
      onSuccess: () => toast({ variant: 'success', title: 'Extraction retried', description: 'The report is queued for processing.' }),
      onError: () => toast({ variant: 'destructive', title: 'Retry failed', description: 'Could not queue the report.' })
    });
  };

  const setReviewed = (reviewed: boolean) => {
    reviewMutation.mutate({
      patientId,
      reportId: report.id,
      data: { reviewed },
      params: office ? { office } : undefined,
    }, {
      onError: () => toast({ variant: 'destructive', title: 'Review update failed', description: 'Could not update the report review.' }),
    });
  };

  const openViewer = (fileId?: string, page?: number) => {
    if (fileId && page) {
      setViewerInitialPage({ fileId, page });
    } else {
      setViewerInitialPage(undefined);
    }
    setViewerOpen(true);
  };

  return (
    <div className="flex flex-col h-full max-h-[600px]">
      <div className="p-4 border-b border-border bg-card flex justify-between items-center shrink-0">
        <div>
          <h3 className="font-serif text-lg font-bold text-navy mb-1">{report.title}</h3>
          <div className="text-xs text-muted-foreground flex gap-3">
            <span>{report.kind === 'pdf' ? 'PDF Document' : 'Images'} ({files.length} file{files.length === 1 ? '' : 's'})</span>
            <span>{report.pageCount} page{report.pageCount === 1 ? '' : 's'}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {canEdit && report.extractionStatus === 'completed' && (
            report.reviewStatus === 'reviewed' ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Reviewed {report.reviewedAt ? new Date(report.reviewedAt).toLocaleDateString() : ''}</span>
                <button
                  data-testid={`button-bloodwork-unreview-${report.id}`}
                  onClick={() => setReviewed(false)}
                  disabled={reviewMutation.isPending}
                  className="text-primary hover:underline disabled:opacity-50"
                >
                  Undo
                </button>
              </div>
            ) : (
              <button
                data-testid={`button-bloodwork-review-${report.id}`}
                onClick={() => setReviewed(true)}
                disabled={reviewMutation.isPending}
                className={BTN_SECONDARY}
              >
                Mark reviewed
              </button>
            )
          )}
          <button onClick={() => openViewer()} className={`${BTN_SECONDARY} flex items-center gap-2 px-4 py-2`}>
            <Eye size={14} />
            View Source
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {report.extractionStatus === 'queued' || report.extractionStatus === 'processing' ? (
          <div data-testid="bloodwork-processing" className="h-full flex flex-col items-center justify-center text-center p-6 text-muted-foreground">
            <RefreshCw size={24} className="animate-spin mb-4 text-primary" />
            <p className="text-sm font-semibold text-foreground mb-1">Processing report...</p>
            <p className="text-xs">Extracting structured results from the uploaded files.</p>
          </div>
        ) : report.extractionStatus === 'failed' ? (
          <div data-testid="bloodwork-extraction-failed" className="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">
            <div className="flex items-start gap-3">
              <AlertCircle size={20} className="mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-semibold mb-1">Extraction Failed</p>
                <p className="text-xs mb-3">{report.extractionError || 'An unknown error occurred during processing.'}</p>
                {canEdit && (
                  <button onClick={handleRetry} disabled={retryMutation.isPending} className="px-3 py-1.5 bg-white border border-red-200 rounded text-xs font-semibold hover:bg-red-50 disabled:opacity-50">
                    {retryMutation.isPending ? 'Retrying...' : 'Retry Extraction'}
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : results.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
            No structured results were found in this report.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 p-3 bg-secondary rounded-md text-xs text-muted-foreground border border-border">
              <Info size={14} className="text-primary shrink-0" />
              <p>Results are automatically extracted and unreviewed until a member of the care team marks the report reviewed. Edits track changes but do not imply clinical sign-off. Only reviewed reports can inform the coach&apos;s suggestions.</p>
            </div>
            
            <div className="rounded-md border border-border overflow-hidden bg-card">
              <table className="w-full text-left text-xs">
                <thead className="bg-secondary text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-bold w-1/3">Test</th>
                    <th className="px-3 py-2 font-bold w-1/4">Value</th>
                    <th className="px-3 py-2 font-bold w-1/4">Ref Range</th>
                    <th className="px-3 py-2 font-bold text-center w-12">Flag</th>
                    <th className="px-3 py-2 w-16 text-center">{canEdit ? 'Source / Edit' : 'Source'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {results.map((result) => (
                    <BloodworkResultRow 
                      key={result.id} 
                      result={result} 
                      reportId={report.id} 
                      patientId={patientId} 
                      office={office}
                      canEdit={canEdit}
                      onViewSource={() => openViewer(result.sourceFileId, result.sourcePage)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {viewerOpen && (
        <BloodworkViewer
          patientId={patientId}
          office={office}
          report={report}
          files={files}
          initialPage={viewerInitialPage}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </div>
  );
}
