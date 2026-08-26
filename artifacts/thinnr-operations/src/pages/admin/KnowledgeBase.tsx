/**
 * AI Support knowledge base — the library behind the provider AI Support
 * chat. Unlike most HQ pages this is LIVE data: uploads go straight to App
 * Storage, the api-server extracts full text server-side, and provider
 * chats will answer from exactly what's stored here. That's also why the
 * page insists on a real signed-in HQ admin — demo personas get a notice,
 * not doomed requests.
 *
 * Trust surface: the extracted-text preview IS the product. Admins check
 * what the AI can actually read (extraction status, character counts, the
 * text itself) rather than assuming a successful upload means usable
 * knowledge. Failures stay loud — a failed chip with the parser's plain
 * words and a retry — never a silently empty document.
 */
import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FileText, FileUp, Pencil, RotateCw, Trash2 } from 'lucide-react';
import { useSession } from '@/contexts/session';
import { useToast } from '@/hooks/use-toast';
import { AdminPage, PageHeader, MetricTile } from '@/components/admin/primitives';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CHIP_COBALT,
  CHIP_RISK,
  CHIP_WARM,
  INPUT_CLASS,
  INSET,
  SectionCard,
} from '@/components/patient/heritage';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  UPLOAD_ACCEPT,
  describeDocumentProblem,
  deleteKnowledgeDocument,
  documentTypeLabel,
  fetchKnowledgeDocument,
  formatBytes,
  listKnowledgeDocuments,
  renameKnowledgeDocument,
  replaceKnowledgeDocument,
  resolveDocumentType,
  retryExtraction,
  uploadKnowledgeDocument,
  type KnowledgeDocument,
} from '@/lib/knowledge-docs';

const DOCS_KEY = ['knowledge-docs'];

type UploadPhase = 'waiting' | 'uploading' | 'finalizing' | 'done' | 'failed';

interface UploadItem {
  key: string;
  name: string;
  pct: number;
  phase: UploadPhase;
  error: string | null;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusChip(doc: KnowledgeDocument): { className: string; label: string } {
  switch (doc.status) {
    case 'ready':
      return { className: CHIP_COBALT, label: 'Ready' };
    case 'failed':
      return { className: CHIP_RISK, label: 'Failed' };
    case 'extracting':
      return { className: `${CHIP_WARM} animate-pulse`, label: 'Extracting…' };
    default:
      return { className: CHIP_WARM, label: 'Queued' };
  }
}

function problemText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong — try again.';
}

export default function KnowledgeBase() {
  const { authStatus } = useSession();
  const signedIn = authStatus === 'signed-in';
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const uploadInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const uploadBusyRef = useRef(false);

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [previewDoc, setPreviewDoc] = useState<KnowledgeDocument | null>(null);
  const [renameDoc, setRenameDoc] = useState<KnowledgeDocument | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteDoc, setDeleteDoc] = useState<KnowledgeDocument | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [replaceConfirmDoc, setReplaceConfirmDoc] = useState<KnowledgeDocument | null>(null);
  const replaceTargetRef = useRef<KnowledgeDocument | null>(null);
  const [replacing, setReplacing] = useState<{ id: string; pct: number } | null>(null);

  const docsQuery = useQuery({
    queryKey: DOCS_KEY,
    queryFn: listKnowledgeDocuments,
    enabled: signedIn,
    // Poll while any document is mid-pipeline so status chips move on
    // their own; go quiet the moment everything is settled.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((doc) => doc.status === 'uploaded' || doc.status === 'extracting')
        ? 2500
        : false,
  });
  const docs = useMemo(() => docsQuery.data ?? [], [docsQuery.data]);

  const detailQuery = useQuery({
    queryKey: ['knowledge-doc', previewDoc?.id],
    queryFn: () => fetchKnowledgeDocument(previewDoc!.id),
    enabled: signedIn && previewDoc !== null,
  });

  const readyCount = docs.filter((doc) => doc.status === 'ready').length;
  const failedCount = docs.filter((doc) => doc.status === 'failed').length;
  const totalBytes = docs.reduce((sum, doc) => sum + doc.sizeBytes, 0);

  const refresh = () => queryClient.invalidateQueries({ queryKey: DOCS_KEY });

  const updateUpload = (key: string, patch: Partial<UploadItem>) => {
    setUploads((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  };

  const handleFiles = async (list: FileList | null) => {
    if (!list || list.length === 0 || uploadBusyRef.current) return;
    uploadBusyRef.current = true;
    const files = Array.from(list);
    const stamp = Date.now();
    const items: UploadItem[] = files.map((file, index) => ({
      key: `${stamp}-${index}`,
      name: file.name,
      pct: 0,
      phase: 'waiting',
      error: null,
    }));
    setUploads((prev) => [...prev.filter((item) => item.phase !== 'done'), ...items]);
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const key = items[index].key;
        const problem = describeDocumentProblem(file);
        if (problem) {
          updateUpload(key, { phase: 'failed', error: problem });
          continue;
        }
        const contentType = resolveDocumentType(file)!;
        try {
          updateUpload(key, { phase: 'uploading' });
          await uploadKnowledgeDocument(file, contentType, (pct) => updateUpload(key, { pct }));
          updateUpload(key, { phase: 'finalizing', pct: 100 });
          await refresh();
          updateUpload(key, { phase: 'done' });
        } catch (error) {
          updateUpload(key, { phase: 'failed', error: problemText(error) });
        }
      }
    } finally {
      uploadBusyRef.current = false;
    }
  };

  const handleReplaceFile = async (list: FileList | null) => {
    const doc = replaceTargetRef.current;
    replaceTargetRef.current = null;
    const file = list?.[0];
    if (!doc || !file) return;
    const problem = describeDocumentProblem(file);
    if (problem) {
      toast({ title: 'That file won’t work', description: problem, variant: 'destructive' });
      return;
    }
    const contentType = resolveDocumentType(file)!;
    setReplacing({ id: doc.id, pct: 0 });
    try {
      await replaceKnowledgeDocument(doc.id, file, contentType, (pct) =>
        setReplacing({ id: doc.id, pct }),
      );
      await refresh();
      toast({
        title: 'File replaced',
        description: 'The old text is cleared — extraction from the new file is underway.',
      });
    } catch (error) {
      toast({ title: 'Replace failed', description: problemText(error), variant: 'destructive' });
    } finally {
      setReplacing(null);
    }
  };

  const handleRename = async () => {
    if (!renameDoc) return;
    const title = renameTitle.trim();
    if (!title) return;
    setRenameBusy(true);
    try {
      await renameKnowledgeDocument(renameDoc.id, title);
      await refresh();
      setRenameDoc(null);
    } catch (error) {
      toast({ title: 'Rename failed', description: problemText(error), variant: 'destructive' });
    } finally {
      setRenameBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteDoc) return;
    setDeleteBusy(true);
    try {
      await deleteKnowledgeDocument(deleteDoc.id);
      await refresh();
      toast({ title: 'Document deleted', description: `“${deleteDoc.title}” is out of the library.` });
      setDeleteDoc(null);
    } catch (error) {
      toast({ title: 'Delete failed', description: problemText(error), variant: 'destructive' });
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleRetry = async (doc: KnowledgeDocument) => {
    try {
      await retryExtraction(doc.id);
      await refresh();
    } catch (error) {
      toast({ title: 'Retry failed', description: problemText(error), variant: 'destructive' });
    }
  };

  const activeUploads = uploads.some((item) => item.phase === 'waiting' || item.phase === 'uploading' || item.phase === 'finalizing');

  return (
    <AdminPage>
      <PageHeader
        kicker="Learning"
        title="AI Support"
        sub="The library behind the provider AI Support chat — upload program PDFs and Word documents, then check exactly what the AI can read."
        action={
          signedIn ? (
            <button
              type="button"
              className={`${BTN_PRIMARY} px-4 py-2`}
              onClick={() => uploadInputRef.current?.click()}
              disabled={activeUploads}
              data-testid="button-upload-documents"
            >
              <FileUp className="h-3.5 w-3.5" aria-hidden />
              Upload documents
            </button>
          ) : undefined
        }
      />

      <input
        ref={uploadInputRef}
        type="file"
        accept={UPLOAD_ACCEPT}
        multiple
        className="hidden"
        data-testid="input-upload-documents"
        onChange={(event) => {
          void handleFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={replaceInputRef}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="hidden"
        data-testid="input-replace-document"
        onChange={(event) => {
          void handleReplaceFile(event.target.files);
          event.target.value = '';
        }}
      />

      {!signedIn ? (
        <SectionCard title="Sign in required" sub="Live data — demo personas browse everything else, but not this.">
          <p className="max-w-xl text-xs leading-relaxed text-muted-foreground" data-testid="text-knowledge-signin">
            These documents feed real provider AI Support chats, so only the signed-in THINNR HQ
            admin account can see or change them. Sign out of the demo persona and sign in with the
            HQ admin account to manage the library.
          </p>
        </SectionCard>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricTile label="Documents" value={String(docs.length)} testId="text-metric-docs" />
            <MetricTile label="Ready" value={String(readyCount)} testId="text-metric-ready" />
            <MetricTile
              label="Needs attention"
              value={String(failedCount)}
              detail={failedCount > 0 ? 'Extraction failed — retry or replace' : undefined}
              testId="text-metric-attention"
            />
            <MetricTile label="Library size" value={formatBytes(totalBytes)} testId="text-metric-size" />
          </div>

          {uploads.length > 0 && (
            <SectionCard
              title="Uploads"
              sub="Files go straight to storage, then text extraction starts server-side."
              action={
                !activeUploads ? (
                  <button
                    type="button"
                    className={`${BTN_SECONDARY} px-3 py-1.5`}
                    onClick={() => setUploads([])}
                    data-testid="button-clear-uploads"
                  >
                    Clear
                  </button>
                ) : undefined
              }
            >
              <ul className="space-y-2">
                {uploads.map((item) => (
                  <li key={item.key} className={`${INSET} px-3 py-2`} data-testid={`upload-item-${item.key}`}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-xs font-semibold text-foreground">{item.name}</span>
                      <span className="shrink-0 text-[10px] font-bold uppercase tracking-[.06em] text-muted-foreground">
                        {item.phase === 'waiting' && 'Waiting'}
                        {item.phase === 'uploading' && `Uploading ${item.pct}%`}
                        {item.phase === 'finalizing' && 'Finalizing…'}
                        {item.phase === 'done' && 'Done — extracting text'}
                        {item.phase === 'failed' && 'Failed'}
                      </span>
                    </div>
                    {(item.phase === 'uploading' || item.phase === 'finalizing') && (
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
                        <div
                          className="h-full rounded-full bg-primary transition-[width]"
                          style={{ width: `${item.pct}%` }}
                        />
                      </div>
                    )}
                    {item.phase === 'failed' && item.error && (
                      <p className="mt-1 text-[11px] leading-snug text-destructive">{item.error}</p>
                    )}
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          <SectionCard
            title="Document library"
            sub={
              docs.length === 0
                ? 'Nothing uploaded yet.'
                : `${docs.length} ${docs.length === 1 ? 'document' : 'documents'} · ${readyCount} ready for the AI`
            }
          >
            {docsQuery.isLoading ? (
              <p className="py-6 text-center text-xs text-muted-foreground">Loading the library…</p>
            ) : docsQuery.isError ? (
              <p className="py-6 text-center text-xs text-destructive" data-testid="text-knowledge-error">
                {problemText(docsQuery.error)}
              </p>
            ) : docs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center" data-testid="text-knowledge-empty">
                <FileText className="h-6 w-6 text-muted-foreground" aria-hidden />
                <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                  No documents yet — upload the program PDFs and Word files the AI Support chat
                  should answer from.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">
                      <th scope="col" className="py-2 pr-3 font-bold">Document</th>
                      <th scope="col" className="py-2 pr-3 font-bold">Type</th>
                      <th scope="col" className="py-2 pr-3 font-bold">Size</th>
                      <th scope="col" className="py-2 pr-3 font-bold">Uploaded</th>
                      <th scope="col" className="py-2 pr-3 font-bold">Status</th>
                      <th scope="col" className="py-2 text-right font-bold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docs.map((doc) => {
                      const chip = statusChip(doc);
                      const isReplacing = replacing?.id === doc.id;
                      return (
                        <tr key={doc.id} className="border-b border-border/60 align-top" data-testid={`row-doc-${doc.id}`}>
                          <td className="max-w-[280px] py-2.5 pr-3">
                            <p className="truncate font-semibold text-foreground" title={doc.title} data-testid={`text-doc-title-${doc.id}`}>
                              {doc.title}
                            </p>
                            <p className="truncate text-[11px] text-muted-foreground" title={doc.originalFilename}>
                              {doc.originalFilename}
                            </p>
                            {doc.status === 'failed' && doc.errorMessage && (
                              <p className="mt-1 max-w-[280px] text-[11px] leading-snug text-destructive" data-testid={`text-doc-error-${doc.id}`}>
                                {doc.errorMessage}
                              </p>
                            )}
                          </td>
                          <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">{documentTypeLabel(doc.contentType)}</td>
                          <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">{formatBytes(doc.sizeBytes)}</td>
                          <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">{formatDate(doc.createdAt)}</td>
                          <td className="py-2.5 pr-3 whitespace-nowrap">
                            <span className={chip.className} data-testid={`chip-doc-status-${doc.id}`}>
                              {isReplacing ? `Uploading ${replacing.pct}%` : chip.label}
                            </span>
                          </td>
                          <td className="py-2 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-0.5">
                              {doc.status === 'failed' && (
                                <button
                                  type="button"
                                  className="rounded-sm p-1.5 text-primary transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  onClick={() => void handleRetry(doc)}
                                  aria-label={`Retry extraction for ${doc.title}`}
                                  title="Retry extraction"
                                  data-testid={`button-doc-retry-${doc.id}`}
                                >
                                  <RotateCw className="h-3.5 w-3.5" aria-hidden />
                                </button>
                              )}
                              <button
                                type="button"
                                className="rounded-sm p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() => setPreviewDoc(doc)}
                                aria-label={`Preview extracted text of ${doc.title}`}
                                title="Preview extracted text"
                                data-testid={`button-doc-preview-${doc.id}`}
                              >
                                <Eye className="h-3.5 w-3.5" aria-hidden />
                              </button>
                              <button
                                type="button"
                                className="rounded-sm p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() => {
                                  setRenameDoc(doc);
                                  setRenameTitle(doc.title);
                                }}
                                aria-label={`Rename ${doc.title}`}
                                title="Rename"
                                data-testid={`button-doc-rename-${doc.id}`}
                              >
                                <Pencil className="h-3.5 w-3.5" aria-hidden />
                              </button>
                              <button
                                type="button"
                                className="rounded-sm p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() => setReplaceConfirmDoc(doc)}
                                disabled={isReplacing}
                                aria-label={`Replace the file behind ${doc.title}`}
                                title="Replace file"
                                data-testid={`button-doc-replace-${doc.id}`}
                              >
                                <FileUp className="h-3.5 w-3.5" aria-hidden />
                              </button>
                              <button
                                type="button"
                                className="rounded-sm p-1.5 text-muted-foreground transition hover:bg-accent hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() => setDeleteDoc(doc)}
                                aria-label={`Delete ${doc.title}`}
                                title="Delete"
                                data-testid={`button-doc-delete-${doc.id}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      )}

      {/* Extracted-text preview — how admins trust what the AI knows. */}
      <Dialog open={previewDoc !== null} onOpenChange={(open) => !open && setPreviewDoc(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-serif text-xl">{previewDoc?.title}</DialogTitle>
            <DialogDescription>
              {previewDoc && (
                <>
                  {documentTypeLabel(previewDoc.contentType)} · {formatBytes(previewDoc.sizeBytes)} · uploaded{' '}
                  {formatDate(previewDoc.createdAt)}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {detailQuery.isLoading ? (
            <p className="py-4 text-center text-xs text-muted-foreground">Loading the extracted text…</p>
          ) : detailQuery.isError ? (
            <p className="py-4 text-center text-xs text-destructive">{problemText(detailQuery.error)}</p>
          ) : detailQuery.data ? (
            <div className="space-y-3">
              {detailQuery.data.status === 'failed' && detailQuery.data.errorMessage && (
                <div className={`${INSET} border-[#d5a7a7] bg-[#fff0f0] px-3 py-2 text-[11px] leading-snug text-destructive`}>
                  {detailQuery.data.errorMessage}
                </div>
              )}
              {detailQuery.data.summary && (
                <p className="text-xs italic leading-relaxed text-muted-foreground" data-testid="text-preview-summary">
                  {detailQuery.data.summary}
                </p>
              )}
              {detailQuery.data.keywords.length > 0 && (
                <div className="flex flex-wrap gap-1" data-testid="list-preview-keywords">
                  {detailQuery.data.keywords.map((keyword) => (
                    <span key={keyword} className={`${INSET} rounded-sm px-2 py-0.5 text-[10px] font-semibold text-muted-foreground`}>
                      {keyword}
                    </span>
                  ))}
                </div>
              )}
              {detailQuery.data.extractedText ? (
                <>
                  <p className="text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">
                    Extracted text · {detailQuery.data.extractedChars.toLocaleString('en-US')} characters
                  </p>
                  <pre
                    className={`${INSET} max-h-[45vh] overflow-y-auto whitespace-pre-wrap px-3 py-2 font-sans text-[11px] leading-relaxed text-foreground`}
                    data-testid="text-preview-extracted"
                  >
                    {detailQuery.data.extractedText}
                  </pre>
                </>
              ) : detailQuery.data.status !== 'failed' ? (
                <p className="py-2 text-center text-xs text-muted-foreground">
                  No text stored yet — extraction is still running.
                </p>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Rename */}
      <Dialog open={renameDoc !== null} onOpenChange={(open) => !open && setRenameDoc(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-serif text-xl">Rename document</DialogTitle>
            <DialogDescription>The stored file and extracted text stay as they are.</DialogDescription>
          </DialogHeader>
          <input
            className={`${INPUT_CLASS} h-9 w-full`}
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleRename();
            }}
            aria-label="Document title"
            data-testid="input-rename-title"
          />
          <DialogFooter>
            <button type="button" className={`${BTN_SECONDARY} px-3 py-2`} onClick={() => setRenameDoc(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={`${BTN_PRIMARY} px-4 py-2`}
              onClick={() => void handleRename()}
              disabled={renameBusy || renameTitle.trim().length === 0}
              data-testid="button-rename-save"
            >
              {renameBusy ? 'Saving…' : 'Save name'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Replace confirm → file picker */}
      <AlertDialog open={replaceConfirmDoc !== null} onOpenChange={(open) => !open && setReplaceConfirmDoc(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-xl">
              Replace “{replaceConfirmDoc?.title}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The current file and its extracted text are cleared, and the AI re-learns this
              document from the new file. The name stays the same.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                replaceTargetRef.current = replaceConfirmDoc;
                setReplaceConfirmDoc(null);
                replaceInputRef.current?.click();
              }}
              data-testid="button-replace-confirm"
            >
              Choose new file
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteDoc !== null} onOpenChange={(open) => !open && setDeleteDoc(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-xl">Delete “{deleteDoc?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The document and its extracted text leave the AI Support library for every provider
              office. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()} disabled={deleteBusy} data-testid="button-delete-confirm">
              {deleteBusy ? 'Deleting…' : 'Delete document'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminPage>
  );
}
