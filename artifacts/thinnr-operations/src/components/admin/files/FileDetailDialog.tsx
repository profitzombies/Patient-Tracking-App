import { useEffect, useId, useRef, useState } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import {
  createHqFileReplacement,
  getHqFileContent,
  replaceHqFile,
  type HqFile,
  type HqFolder,
} from '@workspace/api-client-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BTN_PRIMARY, BTN_SECONDARY } from '@/components/patient/heritage';
import { formatBytes } from './utils';
import { isCompressibleImage, putFile } from './upload-queue';

const ACCEPTED_FILES = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.jpg,.jpeg,.png,.webp,.gif';
const loadHqFileContent = (id: string) => getHqFileContent(id, { responseType: 'blob' });

export function friendlyFileKind(contentType: string) {
  const type = contentType.toLowerCase();
  if (type === 'image/png') return 'PNG image';
  if (type === 'image/jpeg') return 'JPEG image';
  if (type === 'image/webp') return 'WebP image';
  if (type === 'image/gif') return 'GIF image';
  if (type === 'application/pdf') return 'PDF document';
  if (type.includes('word') || type === 'application/msword') return 'Word document';
  if (type.includes('spreadsheet') || type.includes('excel')) return 'Excel spreadsheet';
  if (type.includes('presentation') || type.includes('powerpoint')) return 'PowerPoint deck';
  if (type === 'text/csv') return 'CSV file';
  if (type === 'text/plain') return 'Text file';
  return 'Document';
}

interface Props {
  file: HqFile | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onDownload(file: HqFile): void;
  onRename?(file: HqFile): void;
  onMove?(file: HqFile): void;
  onArchive?(file: HqFile, archived: boolean): Promise<void>;
  onDelete?(file: HqFile): void;
  onFolder(folder: HqFolder): void;
  onReplaced?(file: HqFile): Promise<void> | void;
  readOnly?: boolean;
  loadContent?(fileId: string): Promise<Blob>;
}

export function FileDetailDialog({
  file, open, onOpenChange, onDownload, onRename, onMove, onArchive, onDelete, onFolder, onReplaced,
  readOnly = false, loadContent = loadHqFileContent,
}: Props) {
  const titleId = useId();
  const replacementRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [replacement, setReplacement] = useState<File | null>(null);
  const [compress, setCompress] = useState<boolean | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState<'replace' | 'archive' | null>(null);
  const [replacementError, setReplacementError] = useState<string | null>(null);
  const [replacedSummary, setReplacedSummary] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !file || file.unavailableSince) {
      setPreviewState('idle');
      return;
    }
    const type = file.contentType.toLowerCase();
    if (!type.startsWith('image/') && type !== 'application/pdf' && type !== 'text/plain' && type !== 'text/csv') {
      setPreviewState('ready');
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    setPreviewState('loading');
    setPreviewText(null);
    setPreviewUrl(null);
    void loadContent(file.id).then(async (blob) => {
      if (!active) return;
      if (type === 'text/plain' || type === 'text/csv') {
        setPreviewText(await blob.slice(0, 200 * 1024).text());
      } else {
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      }
      if (active) setPreviewState('ready');
    }).catch(() => {
      if (active) setPreviewState('error');
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file?.id, file?.contentType, file?.unavailableSince, open, previewAttempt, loadContent]);

  useEffect(() => {
    if (!open) {
      setReplacement(null);
      setCompress(null);
      setProgress(0);
      setReplacementError(null);
      setReplacedSummary(null);
    }
  }, [open]);

  if (!file) return null;
  const kind = friendlyFileKind(file.contentType);
  const replacementNeedsChoice = replacement && isCompressibleImage(replacement);
  const runReplacement = async (shouldCompress: boolean) => {
    if (!replacement) return;
    setBusy('replace');
    setCompress(shouldCompress);
    setProgress(0);
    setReplacementError(null);
    setReplacedSummary(null);
    try {
      const upload = await createHqFileReplacement(file.id, {
        name: replacement.name,
        contentType: replacement.type || 'application/octet-stream',
        size: replacement.size,
      });
      await putFile(upload.uploadUrl, replacement, setProgress);
      const replaced = await replaceHqFile(file.id, {
        name: replacement.name,
        contentType: replacement.type || 'application/octet-stream',
        size: replacement.size,
        objectPath: upload.objectPath,
        compress: shouldCompress,
      });
       await onReplaced?.(replaced);
      const saved = replaced.originalSize && replaced.originalSize > replaced.size
        ? `Compressed ${formatBytes(replaced.originalSize)} → ${formatBytes(replaced.size)}, ${Math.round((1 - replaced.size / replaced.originalSize) * 100)}% smaller.`
        : shouldCompress ? 'Uploaded. It was already as small as it gets, so the original was kept.' : 'Uploaded.';
      setReplacedSummary(saved);
      setReplacement(null);
      setPreviewAttempt((attempt) => attempt + 1);
    } catch {
      setReplacementError('Couldn’t replace the file. Please try again.');
    } finally {
      setBusy(null);
    }
  };
  const archive = async () => {
    setBusy('archive');
    try { await onArchive?.(file, !file.archivedAt); } finally { setBusy(null); }
  };

  return <Dialog open={open} onOpenChange={(next) => { if (busy !== 'replace') onOpenChange(next); }}>
    <DialogContent
      className="max-h-[92vh] sm:max-w-[1050px]"
      aria-labelledby={titleId}
      onEscapeKeyDown={(event) => { if (busy === 'replace') event.preventDefault(); }}
      onInteractOutside={(event) => { if (busy === 'replace') event.preventDefault(); }}
    >
      <DialogHeader>
        <DialogTitle id={titleId} className="pr-8 font-serif text-navy">{file.name}</DialogTitle>
        <DialogDescription>{readOnly ? 'Preview or download this file.' : 'Preview and manage this file.'}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(240px,1fr)]">
        <div className="flex min-h-64 items-center justify-center overflow-auto rounded-lg border border-border bg-paper-alt p-3">
          {file.unavailableSince ? <p role="status" className="text-sm text-destructive">The stored file is missing.</p>
            : previewState === 'loading' ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="animate-spin" size={16} />Loading preview…</p>
            : previewState === 'error' ? <div className="text-center"><p role="alert" className="text-sm text-destructive">Couldn’t load the preview.</p><button className={`${BTN_SECONDARY} mt-3 h-8 px-3`} onClick={() => setPreviewAttempt((attempt) => attempt + 1)}>Retry</button></div>
            : file.contentType.startsWith('image/') && previewUrl ? <img src={previewUrl} alt={file.name} className="max-h-[60vh] max-w-full object-contain" />
            : file.contentType === 'application/pdf' && previewUrl ? <iframe title={`Preview of ${file.name}`} src={previewUrl} className="h-[70vh] w-full border-0" />
            : (file.contentType === 'text/plain' || file.contentType === 'text/csv') && previewText !== null ? <pre className="max-h-[60vh] w-full overflow-auto whitespace-pre-wrap text-xs">{previewText}</pre>
            : <div className="max-w-sm text-center"><FileText size={48} className="mx-auto mb-3 text-primary" /><strong className="text-lg text-navy">{kind}</strong><p className="mt-2 text-sm text-muted-foreground">Preview isn’t available for {kind} files in the browser. Download it to open it.</p></div>}
        </div>
        <dl className="grid content-start grid-cols-[auto_1fr] gap-x-3 gap-y-3 text-xs">
          <dt className="font-semibold">Name</dt><dd className="break-all">{file.name}</dd>
          <dt className="font-semibold">Type</dt><dd>{kind}</dd>
          <dt className="font-semibold">Size</dt><dd>{formatBytes(file.size)}{file.originalSize && file.originalSize > file.size ? ` (was ${formatBytes(file.originalSize)})` : ''}</dd>
          <dt className="font-semibold">Folder</dt><dd>{file.path?.length ? file.path.map((folder, index) => <span key={folder.id}>{index > 0 && ' › '}<button className="text-primary hover:underline" onClick={() => onFolder(folder)}>{folder.name}</button></span>) : 'Files'}</dd>
          <dt className="font-semibold">Added</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(file.createdAt))}</dd>
          <dt className="font-semibold">Uploaded by</dt><dd>{file.uploadedBy || 'Unknown'}</dd>
          {file.archivedAt && <><dt className="font-semibold">Archived on</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(file.archivedAt))}</dd></>}
        </dl>
      </div>
      {!readOnly && replacementError && !replacement && <p role="alert" className="text-xs text-destructive">{replacementError}</p>}
      {!readOnly && replacedSummary && !replacement && <div role="status" className="flex items-center justify-between gap-3 rounded-md border border-border bg-paper-alt p-3 text-xs" data-testid="replace-complete">
        <p><strong>Replaced.</strong> {replacedSummary}</p>
        <button className={`${BTN_PRIMARY} h-8 shrink-0 px-3`} onClick={() => setReplacedSummary(null)}>Done</button>
      </div>}
      {!readOnly && replacement && <div className="rounded-md border border-border bg-paper-alt p-3 text-xs">
        <p><strong>Replace with:</strong> {replacement.name}</p>
        {replacementError && <p role="alert" className="mt-2 text-destructive">{replacementError}</p>}
        {busy === 'replace' ? <div className="mt-2"><div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-2 overflow-hidden rounded bg-muted"><div className={progress >= 100 ? 'h-full w-full animate-pulse bg-primary/70' : 'h-full bg-primary'} style={progress >= 100 ? undefined : { width: `${progress}%` }} /></div><p className="mt-1">{progress >= 100 ? (compress ? 'Uploaded. Compressing…' : 'Uploaded. Saving…') : `Uploading ${progress}%`}</p></div>
          : replacementNeedsChoice ? <div className="mt-2 flex items-center gap-2"><span>Compress before saving? Quality stays the same.</span><button className={`${BTN_PRIMARY} h-8 px-3`} onClick={() => void runReplacement(true)}>Yes, compress</button><button className={`${BTN_SECONDARY} h-8 px-3`} onClick={() => void runReplacement(false)}>No, keep original</button></div>
          : <button className={`${BTN_PRIMARY} mt-2 h-8 px-3`} onClick={() => void runReplacement(false)}>Replace file</button>}
      </div>}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        {!readOnly && <input ref={replacementRef} type="file" accept={ACCEPTED_FILES} className="hidden" onChange={(event) => { const next = event.target.files?.[0] ?? null; setReplacementError(next && next.size > 50 * 1024 * 1024 ? 'The replacement exceeds the 50 MB maximum.' : null); setReplacement(next && next.size <= 50 * 1024 * 1024 ? next : null); event.target.value = ''; }} />}
        {!file.unavailableSince && <button disabled={!!busy} aria-disabled={!!busy} className={`${BTN_SECONDARY} h-9 px-3`} onClick={() => onDownload(file)}><Download size={14} />Download</button>}
        {!readOnly && !file.unavailableSince && <button disabled={!!busy} aria-disabled={!!busy} className={`${BTN_SECONDARY} h-9 px-3`} onClick={() => replacementRef.current?.click()}>Replace</button>}
        {!readOnly && !file.unavailableSince && onRename && <button disabled={!!busy} aria-disabled={!!busy} className={`${BTN_SECONDARY} h-9 px-3`} onClick={() => onRename(file)}>Rename</button>}
        {!readOnly && !file.unavailableSince && onMove && <button disabled={!!busy} aria-disabled={!!busy} className={`${BTN_SECONDARY} h-9 px-3`} onClick={() => onMove(file)}>Move to…</button>}
        {!readOnly && !file.unavailableSince && onArchive && <button disabled={!!busy} aria-disabled={!!busy} className={`${BTN_SECONDARY} h-9 px-3`} onClick={() => void archive()}>{file.archivedAt ? 'Restore' : 'Archive'}</button>}
        {!readOnly && onDelete && <button disabled={!!busy} aria-disabled={!!busy} className="h-9 rounded-md bg-destructive px-3 text-xs font-semibold text-destructive-foreground disabled:opacity-50" onClick={() => onDelete(file)}>Delete{file.archivedAt ? ' permanently' : ''}</button>}
      </div>
    </DialogContent>
  </Dialog>;
}