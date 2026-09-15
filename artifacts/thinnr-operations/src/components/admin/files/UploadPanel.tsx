import { Check, ChevronDown, ChevronUp, X } from 'lucide-react';
import { BTN_PRIMARY, BTN_SECONDARY } from '@/components/patient/heritage';
import { formatBytes } from './utils';
import { isCompressibleImage, type UploadItem } from './upload-queue';

interface Props {
  items: UploadItem[];
  minimized: boolean;
  onMinimizedChange(value: boolean): void;
  onAnswer(batchId: string, compress: boolean): void;
  onRetry(id: string): void;
  onClose(): void;
}

function savingsLabel(item: UploadItem) {
  const original = item.result?.originalSize;
  const size = item.result?.size ?? item.file.size;
  if (original && original > size) return `${formatBytes(original)} → ${formatBytes(size)}, ${Math.round((1 - size / original) * 100)}% smaller`;
  return null;
}

function Bar({ value, indeterminate, label }: { value: number; indeterminate?: boolean; label: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : value} className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
      <div className={indeterminate ? 'h-full w-full animate-pulse bg-primary/70' : 'h-full bg-primary transition-[width]'} style={indeterminate ? undefined : { width: `${value}%` }} />
    </div>
  );
}

export function UploadPanel({ items, minimized, onMinimizedChange, onAnswer, onRetry, onClose }: Props) {
  if (!items.length) return null;
  const uploading = items.filter((item) => item.state === 'uploading' || item.state === 'saving').length;
  const compressing = items.filter((item) => item.state === 'compressing').length;
  const unsettled = items.some((item) => item.state !== 'done' && item.state !== 'failed');
  const done = items.filter((item) => item.state === 'done').length;
  const failed = items.filter((item) => item.state === 'failed').length;
  const pendingBatch = items.find((item) => isCompressibleImage(item.file) && item.compress === undefined)?.batchId;
  const batchItems = pendingBatch ? items.filter((item) => item.batchId === pendingBatch) : [];
  const imageCount = batchItems.filter((item) => isCompressibleImage(item.file)).length;
  let status = `${done} of ${items.length} complete`;
  if (compressing) status = `Compressing ${compressing} of ${items.length}`;
  else if (uploading) status = `Uploading ${uploading} of ${items.length}`;
  else if (pendingBatch) status = 'Waiting for your answer';
  else if (!unsettled) status = failed ? `${done} uploaded, ${failed} failed` : 'All uploads complete';

  return (
    <section role="dialog" aria-label="Uploads" className="fixed bottom-5 right-5 z-[70] w-[min(430px,calc(100vw-2.5rem))] rounded-[9px] border border-border bg-paper shadow-xl">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div><h2 className="font-serif text-base font-semibold text-navy">Uploads</h2><p aria-live="polite" className="text-[11px] text-muted-foreground">{status}</p></div>
        <div className="flex gap-1">
          <button type="button" className="rounded p-1.5 hover:bg-accent" aria-label={minimized ? 'Expand uploads' : 'Minimize uploads'} onClick={() => onMinimizedChange(!minimized)}>{minimized ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>
          <button type="button" className="rounded p-1.5 hover:bg-accent disabled:opacity-40" aria-label="Close uploads" disabled={unsettled} onClick={onClose}><X size={15} /></button>
        </div>
      </header>
      {!minimized && (
        <div className="max-h-[55vh] overflow-y-auto p-4">
          {pendingBatch && (
            <div className="mb-3 rounded-[7px] border border-border bg-paper-alt p-3" data-testid="upload-compress-prompt">
              <p className="text-xs text-foreground">{imageCount} of these {batchItems.length} files are images. Compress them before saving? Quality stays the same; the files just get smaller.</p>
              <div className="mt-3 flex gap-2">
                <button type="button" className={`${BTN_PRIMARY} h-8 px-3 text-[11px]`} onClick={() => onAnswer(pendingBatch, true)}>Yes, compress</button>
                <button type="button" className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`} onClick={() => onAnswer(pendingBatch, false)}>No, keep originals</button>
              </div>
            </div>
          )}
          <div className="space-y-4">
            {items.map((item) => {
              const twoStep = item.compress === true;
              const uploaded = item.state === 'compressing' || item.state === 'saving' || item.state === 'done';
              const savings = item.state === 'done' ? savingsLabel(item) : null;
              let uploadLabel = 'Waiting';
              if (item.state === 'uploading') uploadLabel = `Uploading ${item.progress}%`;
              if (item.state === 'saving') uploadLabel = 'Saving…';
              if (uploaded && (twoStep || item.state === 'done')) uploadLabel = 'Uploaded';
              if (item.state === 'failed') uploadLabel = `Failed — ${item.error}`;
              let compressLabel = 'Compress after upload';
              if (item.state === 'compressing') compressLabel = 'Compressing…';
              if (item.state === 'done') compressLabel = savings ? `Compressed — ${savings}` : 'Compressed — already as small as it gets, kept the original';
              if (item.state === 'failed') compressLabel = 'Not compressed';
              return <div key={item.id} data-testid={`upload-row-${item.file.name}`}>
                <div className="flex justify-between gap-3 text-xs"><span className="truncate font-medium">{item.file.name}</span><span className="shrink-0 text-muted-foreground">{formatBytes(item.file.size)}</span></div>
                <Bar value={uploaded ? 100 : item.progress} label={`Upload progress for ${item.file.name}`} />
                <div className="mt-1 flex items-center justify-between">
                  <span className={item.state === 'failed' ? 'text-[11px] text-destructive' : 'flex items-center gap-1 text-[11px] text-muted-foreground'}>{uploaded && item.state !== 'failed' && <Check size={11} className="text-primary" />}{uploadLabel}</span>
                  {item.state === 'failed' && <button type="button" className="text-[11px] font-semibold text-primary underline" onClick={() => onRetry(item.id)}>Retry</button>}
                </div>
                {twoStep && <>
                  <Bar value={item.state === 'done' ? 100 : 0} indeterminate={item.state === 'compressing'} label={`Compression progress for ${item.file.name}`} />
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">{item.state === 'done' && <Check size={11} className="text-primary" />}{compressLabel}</p>
                </>}
                {!twoStep && item.state === 'done' && savings && <p className="mt-1 text-[11px] text-muted-foreground">{savings}</p>}
              </div>;
            })}
          </div>
        </div>
      )}
      {!unsettled && (
        <footer className="flex justify-end border-t border-border px-4 py-3">
          <button type="button" className={`${BTN_PRIMARY} h-9 px-4`} onClick={onClose} data-testid="button-uploads-done">Done</button>
        </footer>
      )}
    </section>
  );
}
