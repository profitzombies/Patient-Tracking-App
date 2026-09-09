import { useState } from 'react';
import { Pencil, Check, History, AlertTriangle } from 'lucide-react';
import type { BloodworkResult } from './use-bloodwork';
import { useCorrectResultMutation, useBloodworkCorrectionsQuery } from './use-bloodwork';
import { useToast } from '@/hooks/use-toast';
import { BTN_PRIMARY } from '@/components/patient/heritage';

export function BloodworkResultRow({
  result,
  reportId,
  patientId,
  office,
  canEdit,
  onViewSource
}: {
  result: BloodworkResult;
  reportId: string;
  patientId: string;
  office: string | null;
  canEdit: boolean;
  onViewSource: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const snapshot = () => ({
    testName: result.testName || '',
    valueText: result.valueText || '',
    units: result.units || '',
    referenceRange: result.referenceRange || '',
    labFlag: result.labFlag || '',
    uncertain: result.uncertain,
    expectedVersion: result.version,
  });
  const [draft, setDraft] = useState(snapshot);
  const [conflicted, setConflicted] = useState(false);

  const mutation = useCorrectResultMutation(patientId, office, reportId);
  const { toast } = useToast();

  const handleSave = () => {
    mutation.mutate({
      patientId,
      reportId,
      resultId: result.id,
      data: {
        expectedVersion: draft.expectedVersion,
        testName: draft.testName.trim() || null,
        valueText: draft.valueText.trim() || null,
        units: draft.units.trim() || null,
        referenceRange: draft.referenceRange.trim() || null,
        labFlag: draft.labFlag.trim() || null,
        uncertain: draft.uncertain
      },
      params: office ? { office } : undefined
    }, {
      onSuccess: () => {
        setIsEditing(false);
        toast({ variant: 'success', title: 'Result updated', description: 'Correction saved successfully.' });
      },
      onError: (err: any) => {
        if (err?.status === 409) {
          setConflicted(true);
          toast({ variant: 'destructive', title: 'Conflict', description: 'This result was changed by someone else. Reload to see the latest.' });
        } else {
          toast({ variant: 'destructive', title: 'Update failed', description: 'Could not save the correction.' });
        }
      }
    });
  };

  const handleCancel = () => {
    setDraft(snapshot());
    setConflicted(false);
    setIsEditing(false);
  };

  const beginEditing = () => {
    setDraft(snapshot());
    setConflicted(false);
    setIsEditing(true);
  };

  const reloadLatest = () => {
    setDraft(snapshot());
    setConflicted(false);
  };

  if (isEditing) {
    return (
      <tr data-testid={`bloodwork-result-edit-${result.id}`} className="bg-secondary/50">
        <td colSpan={5} className="p-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <div>
              <label className="block text-[10px] font-semibold text-muted-foreground uppercase mb-1">Test Name</label>
              <input data-testid="bloodwork-edit-test-name" type="text" value={draft.testName} onChange={e => setDraft(d => ({ ...d, testName: e.target.value }))} className="w-full h-8 px-2 text-xs border border-border rounded bg-background" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-muted-foreground uppercase mb-1">Value</label>
              <input data-testid="bloodwork-edit-value" type="text" value={draft.valueText} onChange={e => setDraft(d => ({ ...d, valueText: e.target.value }))} className="w-full h-8 px-2 text-xs border border-border rounded bg-background" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-muted-foreground uppercase mb-1">Units</label>
              <input type="text" value={draft.units} onChange={e => setDraft(d => ({ ...d, units: e.target.value }))} className="w-full h-8 px-2 text-xs border border-border rounded bg-background" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-muted-foreground uppercase mb-1">Ref Range</label>
              <input type="text" value={draft.referenceRange} onChange={e => setDraft(d => ({ ...d, referenceRange: e.target.value }))} className="w-full h-8 px-2 text-xs border border-border rounded bg-background" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-muted-foreground uppercase mb-1">Flag</label>
              <input type="text" value={draft.labFlag} onChange={e => setDraft(d => ({ ...d, labFlag: e.target.value }))} className="w-full h-8 px-2 text-xs border border-border rounded bg-background" />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <input type="checkbox" id={`uncertain-${result.id}`} checked={draft.uncertain} onChange={e => setDraft(d => ({ ...d, uncertain: e.target.checked }))} className="rounded border-border text-primary focus:ring-primary" />
              <label htmlFor={`uncertain-${result.id}`} className="text-xs text-foreground cursor-pointer">Mark uncertain</label>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            {conflicted && (
              <button data-testid="bloodwork-reload-correction" onClick={reloadLatest} className="px-3 py-1.5 text-xs text-primary hover:underline">
                Reload latest
              </button>
            )}
            <button onClick={handleCancel} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
            <button data-testid="bloodwork-save-correction" onClick={handleSave} disabled={mutation.isPending} className={`${BTN_PRIMARY} px-4 h-8 flex items-center gap-1`}>
              <Check size={14} />
              {mutation.isPending ? 'Saving...' : 'Save Correction'}
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <>
      <tr data-testid={`bloodwork-result-${result.id}`} className="hover:bg-secondary/30 transition-colors group">
        <td className="px-3 py-2">
          <div className="flex items-start gap-1">
            <span className={`font-medium ${result.uncertain ? 'text-amber-600' : 'text-foreground'}`}>
              {result.testName || <span className="text-muted-foreground italic">Missing</span>}
            </span>
            {result.uncertain && <span title="Uncertain extraction" className="flex shrink-0 mt-0.5"><AlertTriangle size={12} className="text-amber-500" /></span>}
          </div>
          {result.corrected && (
            <button data-testid={`bloodwork-history-${result.id}`} onClick={() => setShowHistory(!showHistory)} className="flex items-center gap-1 text-[9px] text-primary hover:underline mt-0.5" title="View correction history">
              <History size={10} /> Edited
            </button>
          )}
        </td>
        <td className="px-3 py-2 font-mono text-foreground">
          {result.valueText || '-'}
          {result.units && <span className="ml-1 text-muted-foreground text-[10px] font-sans">{result.units}</span>}
        </td>
        <td className="px-3 py-2 text-muted-foreground font-mono">
          {result.referenceRange || '-'}
        </td>
        <td className="px-3 py-2 text-center">
          {result.labFlag ? (
            <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[10px] font-bold text-muted-foreground border border-border">
              {result.labFlag}
            </span>
          ) : '-'}
        </td>
          <td className="px-3 py-2 text-center">
            <div className="flex items-center justify-center gap-1">
            <button onClick={onViewSource} className="p-1.5 text-muted-foreground hover:text-primary hover:bg-white rounded transition-colors focus:opacity-100" title="View page source" aria-label="View page source">
              <span className="sr-only">Source</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>
            </button>
            {canEdit && <button onClick={beginEditing} className="p-1.5 text-muted-foreground hover:text-primary hover:bg-white rounded transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100" title="Edit result" aria-label="Edit result">
              <Pencil size={14} />
            </button>}
            </div>
          </td>
      </tr>
      {showHistory && (
        <CorrectionHistoryRow patientId={patientId} office={office} reportId={reportId} resultId={result.id} />
      )}
    </>
  );
}

function CorrectionHistoryRow({ patientId, office, reportId, resultId }: { patientId: string; office: string | null; reportId: string; resultId: string }) {
  const { data, isLoading, isError } = useBloodworkCorrectionsQuery(patientId, office, reportId, resultId);
  
  return (
      <tr data-testid={`bloodwork-corrections-${resultId}`} className="bg-secondary/50">
      <td colSpan={5} className="px-3 py-3 border-t border-dashed border-border/50">
        <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-2 px-1">Correction History</p>
        {isLoading ? (
          <p className="text-xs text-muted-foreground px-1">Loading history...</p>
        ) : isError ? (
          <p className="text-xs text-red-500 px-1">Could not load history.</p>
        ) : (
          <div className="space-y-2 max-h-40 overflow-y-auto pr-2">
            {data?.corrections.map((corr: any) => (
              <div key={corr.id} className="bg-card border border-border rounded p-2 text-[10px]">
                <div className="flex justify-between text-muted-foreground mb-1">
                  <span>Edited by {corr.actorRole}</span>
                  <span>{new Date(corr.createdAt).toLocaleString()}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-[9px] uppercase text-muted-foreground block">Before</span>
                    <span className="text-red-700 bg-red-50 px-1 rounded line-through decoration-red-300">
                      {corr.before.testName || '-'} / {corr.before.valueText || '-'} {corr.before.units || ''}
                    </span>
                  </div>
                  <div>
                    <span className="text-[9px] uppercase text-muted-foreground block">After</span>
                    <span className="text-green-700 bg-green-50 px-1 rounded">
                      {corr.after.testName || '-'} / {corr.after.valueText || '-'} {corr.after.units || ''}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}
