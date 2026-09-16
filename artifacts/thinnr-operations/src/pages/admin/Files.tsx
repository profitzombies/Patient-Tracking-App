/**
 * Drive-style files preview and Live file storage.
 *
 * A browsable mockup of the HQ shared drive for the demo persona.
 * Signed-in HQ admins use the live API to interact with real durable storage.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Link2,
  Plus,
  Presentation,
  Download,
  FileX2,
  LayoutGrid,
  List,
  Trash2,
} from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { useSession } from '@/contexts/session';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearch } from 'wouter';
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
import { BTN_PRIMARY, BTN_SECONDARY, INSET, SectionCard } from '@/components/patient/heritage';
import { AdminPage, PageHeader, PreviewBanner, copyText, UnauthorizedState } from '@/components/admin/primitives';
import { DRIVE_ROOT, DRIVE_SHARE_BASE, findFolderPath, type DriveFile, type DriveFileKind } from '@/data/hq/files';
import {
  useGetHqFiles,
  getGetHqFilesQueryKey,
  useCreateHqFileUpload,
  useFinalizeHqFile,
  useDeleteHqFile,
  useCreateHqFolder,
  useUpdateHqFolder,
  useDeleteHqFolder,
  useUpdateHqFile,
  useReorderHqDrive,
  useSearchHqFiles,
  getSearchHqFilesQueryKey,
  getHqFileDownload,
  type HqFile,
  type HqFileListResult,
  type HqFolder,
} from '@workspace/api-client-react';
import { FolderGrid } from '@/components/admin/files/FolderGrid';
import { FileGrid } from '@/components/admin/files/FileGrid';
import { FileTable } from '@/components/admin/files/FileTable';
import { orderBy } from '@/components/admin/files/reorder';
import { MoveDialog } from '@/components/admin/files/MoveDialog';
import { DropOverlay } from '@/components/admin/files/DropOverlay';
import { UploadPanel } from '@/components/admin/files/UploadPanel';
import { UploadQueue, type UploadItem } from '@/components/admin/files/upload-queue';
import { apiError, openDownload } from '@/components/admin/files/utils';
import { FileDetailDialog } from '@/components/admin/files/FileDetailDialog';
import { SearchResults } from '@/components/admin/files/SearchResults';

type DriveView = 'cards' | 'list';
const VIEW_KEY = 'hq-files-view';
function readStoredView(): DriveView {
  try { return window.localStorage?.getItem(VIEW_KEY) === 'list' ? 'list' : 'cards'; } catch { return 'cards'; }
}
function storeView(view: DriveView) {
  try { window.localStorage?.setItem(VIEW_KEY, view); } catch { /* private mode: view just won't persist */ }
}

function ViewToggle({ view, onChange }: { view: DriveView; onChange(view: DriveView): void }) {
  const option = (value: DriveView, label: string, icon: React.ReactNode) => (
    <button type="button" aria-pressed={view === value} aria-label={`${label} view`} title={`${label} view`} data-testid={`view-${value}`} className={`inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-semibold transition ${view === value ? 'bg-white text-navy shadow-xs' : 'text-muted-foreground hover:text-navy'}`} onClick={() => onChange(value)}>{icon}<span className="hidden sm:inline">{label}</span></button>
  );
  return <div role="group" aria-label="Layout" className="inline-flex rounded-[7px] border border-border bg-paper-alt p-0.5">
    {option('cards', 'Cards', <LayoutGrid size={14} aria-hidden="true" />)}
    {option('list', 'List', <List size={14} aria-hidden="true" />)}
  </div>;
}

const FILE_ICONS: Record<DriveFileKind, React.ReactNode> = {
  doc: <FileText size={15} />,
  sheet: <FileSpreadsheet size={15} />,
  slides: <Presentation size={15} />,
  pdf: <FileText size={15} />,
  image: <FileImage size={15} />,
  video: <FileVideo size={15} />,
};

const FILE_KIND_LABELS: Record<DriveFileKind, string> = {
  doc: 'Doc',
  sheet: 'Sheet',
  slides: 'Slides',
  pdf: 'PDF',
  image: 'Image',
  video: 'Video',
};

function formatBytes(bytes: number, decimals = 1) {
  if (!+bytes) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function getIconForContentType(contentType: string) {
  const t = contentType.toLowerCase();
  if (t.includes('image/')) return <FileImage size={15} />;
  if (t.includes('video/')) return <FileVideo size={15} />;
  if (t.includes('pdf')) return <FileText size={15} />;
  if (t.includes('spreadsheet') || t.includes('excel') || t.includes('csv')) return <FileSpreadsheet size={15} />;
  if (t.includes('presentation') || t.includes('powerpoint')) return <Presentation size={15} />;
  return <FileText size={15} />;
}

function getLabelForContentType(contentType: string) {
  const t = contentType.toLowerCase();
  if (t.includes('image/')) return 'Image';
  if (t.includes('video/')) return 'Video';
  if (t.includes('pdf')) return 'PDF';
  if (t.includes('spreadsheet') || t.includes('excel') || t.includes('csv')) return 'Sheet';
  if (t.includes('presentation') || t.includes('powerpoint')) return 'Slides';
  return 'Doc';
}

function DemoFiles() {
  const { toast } = useToast();
  const [pathIds, setPathIds] = useState<string[]>([]);
  const [sharing, setSharing] = useState<DriveFile | null>(null);

  const chain = findFolderPath(pathIds) ?? [DRIVE_ROOT];
  const current = chain[chain.length - 1];

  const shareUrl = sharing ? `${DRIVE_SHARE_BASE}/${sharing.shareId}` : '';

  const handleCopy = async () => {
    const landed = await copyText(shareUrl);
    toast(
      landed
        ? { variant: 'success', title: 'Share link copied', description: 'Simulated URL — it goes nowhere outside this demo.' }
        : { variant: 'destructive', title: 'Copy unavailable', description: 'Select the link text and copy it manually.' },
    );
  };

  return (
    <AdminPage>
      <PageHeader
        kicker="Library"
        title="Files"
        sub="The shared HQ drive: brand assets, onboarding packets, and internal docs, organized by folder."
        action={
          <button
            type="button"
            className={`${BTN_PRIMARY} h-9 px-3.5`}
            data-testid="button-new-file"
            onClick={() => toast({ title: 'Preview only', description: 'Uploads arrive with real file storage.' })}
          >
            <Plus size={14} aria-hidden="true" />
            New
          </button>
        }
      />

      <PreviewBanner>
        This is a preview of the HQ drive — files are placeholders and the public share links are simulated (nothing is
        actually stored or shared).
      </PreviewBanner>

      <SectionCard
        title="HQ Drive"
        sub={
          <span className="flex flex-wrap items-center gap-1" aria-label="Folder path">
            {chain.map((folder, index) => {
              const isCurrent = index === chain.length - 1;
              return (
                <span key={folder.id} className="flex items-center gap-1">
                  {index > 0 && <ChevronRight size={11} className="text-muted-foreground/60" aria-hidden="true" />}
                  {isCurrent ? (
                    <strong className="text-xs font-semibold text-navy">{folder.name}</strong>
                  ) : (
                    <button
                      type="button"
                      className="rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid={`breadcrumb-folder-${folder.id}`}
                      onClick={() => setPathIds(pathIds.slice(0, index))}
                    >
                      {folder.name}
                    </button>
                  )}
                </span>
              );
            })}
          </span>
        }
        action={
          pathIds.length > 0 ? (
            <button
              type="button"
              className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}
              onClick={() => setPathIds(pathIds.slice(0, -1))}
              data-testid="button-folder-up"
            >
              <ArrowLeft size={12} aria-hidden="true" />
              Up one level
            </button>
          ) : undefined
        }
      >
        <div className="px-5 py-4">
          {current.folders.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {current.folders.map((folder) => {
                const itemCount = folder.folders.length + folder.files.length;
                return (
                  <button
                    key={folder.id}
                    type="button"
                    className="flex items-center gap-3 rounded-md border border-border bg-paper-alt px-4 py-3 text-left shadow-xs transition hover:-translate-y-0.5 hover:shadow-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid={`folder-${folder.id}`}
                    onClick={() => setPathIds([...pathIds, folder.id])}
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
                      <Folder size={16} />
                    </span>
                    <span className="min-w-0">
                      <b className="block truncate text-xs font-semibold text-navy">{folder.name}</b>
                      <small className="text-[10px] text-muted-foreground">
                        {itemCount} item{itemCount === 1 ? '' : 's'}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {current.files.length > 0 ? (
            <div className={`${current.folders.length > 0 ? 'mt-4' : ''} overflow-x-auto`}>
              <table className="w-full min-w-[560px] text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                    <th className="py-2.5 pr-3 font-bold">Name</th>
                    <th className="px-3 py-2.5 font-bold">Type</th>
                    <th className="px-3 py-2.5 font-bold">Size</th>
                    <th className="px-3 py-2.5 font-bold">Modified</th>
                    <th className="py-2.5 pl-3 text-right font-bold">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {current.files.map((file) => (
                    <tr key={file.id} className="border-b border-border last:border-b-0" data-testid={`file-${file.id}`}>
                      <td className="py-2.5 pr-3">
                        <span className="flex items-center gap-2.5">
                          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-accent text-primary" aria-hidden="true">
                            {FILE_ICONS[file.kind]}
                          </span>
                          <span className="truncate font-medium text-foreground">{file.name}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{FILE_KIND_LABELS[file.kind]}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{file.size}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{file.modifiedLabel}</td>
                      <td className="py-2.5 pl-3 text-right">
                        <button
                          type="button"
                          className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}
                          data-testid={`button-share-${file.id}`}
                          onClick={() => setSharing(file)}
                        >
                          <Link2 size={12} aria-hidden="true" />
                          Share
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            current.folders.length === 0 && (
              <p className="py-6 text-center text-xs text-muted-foreground">This folder is empty.</p>
            )
          )}
        </div>
      </SectionCard>

      <Dialog open={sharing !== null} onOpenChange={(open) => !open && setSharing(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Share “{sharing?.name}”</DialogTitle>
            <DialogDescription>
              Anyone with the link could view — simulated. This URL is fake and nothing is actually shared.
            </DialogDescription>
          </DialogHeader>
          <div className={`${INSET} flex items-center gap-2 px-3 py-2.5`}>
            <Link2 size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <code className="min-w-0 flex-1 truncate text-[11px] text-foreground" data-testid="text-share-url">{shareUrl}</code>
          </div>
          <DialogFooter>
            <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => setSharing(null)}>
              Done
            </button>
            <button type="button" className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-copy-share" onClick={handleCopy}>
              Copy link
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}

function LiveFiles() {
  const { authUser } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [, navigate] = useLocation();
  const search = useSearch();
  const folderId = new URLSearchParams(search).get('folder');
  const archivedView = new URLSearchParams(search).get('view') === 'archived';
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [editItem, setEditItem] = useState<{ kind: 'file' | 'folder'; item: HqFile | HqFolder; action: 'rename' | 'move' } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [folderToDelete, setFolderToDelete] = useState<HqFolder | null>(null);
  const lastFolderNameRef = useRef<string>('');
  if (folderToDelete) lastFolderNameRef.current = folderToDelete.name;
  const [fileToDelete, setFileToDelete] = useState<HqFile | null>(null);
  const lastFileNameRef = useRef<string>('');
  if (fileToDelete) lastFileNameRef.current = fileToDelete.name;
  const [selectedFile, setSelectedFile] = useState<HqFile | null>(null);
  const [fileSearch, setFileSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [deletingFile, setDeletingFile] = useState(false);
  const [deletingFolder, setDeletingFolder] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [uploadsMinimized, setUploadsMinimized] = useState(false);
  const [dropVisible, setDropVisible] = useState(false);
  const [view, setView] = useState<DriveView>(readStoredView);
  const [orderNotice, setOrderNotice] = useState('');
  const orderSeqRef = useRef(0);
  const changeView = (next: DriveView) => { setView(next); storeView(next); };
  const dragDepth = useRef(0);
  const queryParams = archivedView ? { view: 'archived' as const } : folderId ? { folderId } : undefined;
  const queryKey = [...getGetHqFilesQueryKey(queryParams), authUser?.id] as const;
  const { data, isLoading, isError, error } = useGetHqFiles(queryParams, { query: { queryKey } });
  const createUpload = useCreateHqFileUpload();
  const finalizeUpload = useFinalizeHqFile();
  const deleteFile = useDeleteHqFile();
  const createFolder = useCreateHqFolder();
  const updateFolder = useUpdateHqFolder();
  const deleteFolder = useDeleteHqFolder();
  const updateFile = useUpdateHqFile();
  const reorderDrive = useReorderHqDrive();
  const searchParams = { q: debouncedSearch };
  const searchResult = useSearchHqFiles(searchParams, { query: { queryKey: getSearchHqFilesQueryKey(searchParams), enabled: debouncedSearch.length > 0 } });
  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: ['/api/hq/files'] }), [queryClient]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(fileSearch.trim()), 250);
    return () => clearTimeout(timer);
  }, [fileSearch]);
  const queue = useMemo(() => new UploadQueue({
    create: (item) => createUpload.mutateAsync({ data: { name: item.file.name, contentType: item.file.type || 'application/octet-stream', size: item.file.size, folderId: item.folderId } }),
    finalize: (item, upload) => finalizeUpload.mutateAsync({ data: { ...upload, name: item.file.name, contentType: item.file.type || 'application/octet-stream', size: item.file.size, folderId: item.folderId, compress: item.compress ?? false } }),
  }, setUploadItems, () => void refresh()), [createUpload.mutateAsync, finalizeUpload.mutateAsync, refresh]);
  const addUploads = useCallback((files: File[], destination = folderId) => {
    const valid = files.filter((file) => {
      if (file.size <= 50 * 1024 * 1024) return true;
      toast({ variant: 'destructive', title: 'File too large', description: `${file.name} exceeds the 50 MB maximum.` });
      return false;
    });
    if (valid.length) {
      queue.add(valid, destination, `${Date.now()}-${Math.random()}`);
      setUploadsMinimized(false);
    }
  }, [folderId, queue, toast]);
  type DropEntry = {
    name: string;
    isDirectory: boolean;
    isFile: boolean;
    file(callback: (file: File) => void, error?: (error: unknown) => void): void;
    createReader(): { readEntries(callback: (entries: DropEntry[]) => void, error?: (error: unknown) => void): void };
  };
  const droppedFile = (entry: DropEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));
  const droppedChildren = async (entry: DropEntry) => {
    const reader = entry.createReader();
    const all: DropEntry[] = [];
    while (true) {
      const page = await new Promise<DropEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!page.length) return all;
      all.push(...page);
    }
  };
  const importEntry = useCallback(async (entry: DropEntry, parentId: string | null): Promise<void> => {
    if (entry.isFile) {
      addUploads([await droppedFile(entry)], parentId);
      return;
    }
    let childId: string;
    try {
      childId = (await createFolder.mutateAsync({ data: { name: entry.name, parentId } })).id;
    } catch (caught) {
      const status = (caught as { status?: number }).status;
      if (status !== 409) throw caught;
      const listing = await import('@workspace/api-client-react').then(({ getHqFiles }) => getHqFiles(parentId ? { folderId: parentId } : undefined));
      const existing = listing.folders.find((folder) => folder.name.localeCompare(entry.name, undefined, { sensitivity: 'accent' }) === 0);
      if (!existing) throw caught;
      childId = existing.id;
    }
    for (const child of await droppedChildren(entry)) await importEntry(child, childId);
  }, [addUploads, createFolder.mutateAsync]);
  const importDrop = useCallback(async (transfer: DataTransfer) => {
    const entries: DropEntry[] = [];
    for (const item of Array.from(transfer.items ?? [])) {
      const entry = (item as unknown as { webkitGetAsEntry?: () => DropEntry | null }).webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    if (!entries.length) { addUploads(Array.from(transfer.files)); return; }
    try {
      for (const entry of entries) await importEntry(entry, folderId);
      await refresh();
    } catch (caught) {
      toast({ variant: 'destructive', title: 'Could not import dropped folder', description: apiError(caught, 'Please try again.') });
    }
  }, [addUploads, folderId, importEntry, refresh, toast]);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const enter = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth.current += 1; setDropVisible(true); };
    const over = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault(); };
    const leave = (event: DragEvent) => { if (!hasFiles(event)) return; dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDropVisible(false); } };
    const drop = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth.current = 0; setDropVisible(false); if (event.dataTransfer) void importDrop(event.dataTransfer); };
    window.addEventListener('dragenter', enter); window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  }, [importDrop]);

  const goFolder = (id: string | null) => {
    setFileSearch('');
    setDebouncedSearch('');
    navigate(id ? `/admin/files?folder=${encodeURIComponent(id)}` : '/admin/files', { replace: true });
  };
  /**
   * Manual order: show the new order immediately, then save it. On failure
   * the previous listing comes back and (on a stale-listing 409) reloads.
   */
  const applyOrder = async (kind: 'folders' | 'files', ids: string[], movedId: string) => {
    // Stop an in-flight listing from overwriting the optimistic order, and
    // remember which reorder is the newest so only the latest one may roll back.
    const seq = ++orderSeqRef.current;
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData<HqFileListResult>(queryKey);
    const items: Array<{ id: string; name: string }> = previous ? (kind === 'folders' ? previous.folders : previous.files) : [];
    queryClient.setQueryData<HqFileListResult>(queryKey, (current) => !current ? current
      : kind === 'folders' ? { ...current, folders: orderBy(current.folders, ids) } : { ...current, files: orderBy(current.files, ids) });
    const movedName = items.find((item) => item.id === movedId)?.name;
    if (movedName) setOrderNotice(`${movedName} moved to position ${ids.indexOf(movedId) + 1} of ${ids.length}.`);
    try {
      await reorderDrive.mutateAsync({ data: { parentId: folderId, ...(kind === 'folders' ? { folderIds: ids } : { fileIds: ids }) } });
      if (seq === orderSeqRef.current) await queryClient.invalidateQueries({ queryKey });
    } catch (caught) {
      if (seq !== orderSeqRef.current) return; // a newer reorder owns the screen now
      queryClient.setQueryData(queryKey, previous);
      toast({ variant: 'destructive', title: 'Could not save the new order', description: apiError(caught, 'Please try again.') });
      if ((caught as { status?: number }).status === 409) await refresh();
    }
  };
  const mutate = async (work: () => Promise<unknown>, success: string) => {
    try { await work(); await refresh(); toast({ variant: 'success', title: success }); }
    catch (caught) { toast({ variant: 'destructive', title: 'Could not save changes', description: apiError(caught, 'Please try again.') }); throw caught; }
  };

  const renameFile = (item: HqFile) => { setRenameValue(item.name); setEditItem({ kind: 'file', item, action: 'rename' }); };
  const moveFile = (item: HqFile) => setEditItem({ kind: 'file', item, action: 'move' });
  const renameFolder = (item: HqFolder) => { setRenameValue(item.name); setEditItem({ kind: 'folder', item, action: 'rename' }); };
  const moveFolder = (item: HqFolder) => setEditItem({ kind: 'folder', item, action: 'move' });

  const handleDownload = async (file: HqFile) => {
    try {
      setDownloadingId(file.id);
      const res = await getHqFileDownload(file.id);
      openDownload(res.url);
    } catch (error) {
      const status = (error as { status?: number })?.status;
      toast({
        variant: 'destructive',
        title: status === 410 ? 'File unavailable' : 'Download failed',
        description: status === 410 ? 'The stored file is missing. It can be deleted, but not downloaded.' : 'Could not generate a download link.',
      });
      if (status === 410) await queryClient.invalidateQueries({ queryKey });
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async () => {
    if (!fileToDelete) return;
    setDeletingFile(true);
    try {
      const deletedName = fileToDelete.name;
      await deleteFile.mutateAsync({ fileId: fileToDelete.id });
      setDeletingFile(false);
      setFileToDelete(null);
      setSelectedFile(null);
      await refresh();
      toast({ variant: 'success', title: 'File deleted', description: deletedName });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Delete failed', description: 'Could not delete the file.' });
    } finally {
      setDeletingFile(false);
      setFileToDelete(null);
    }
  };

  return (
    <AdminPage>
      <p className="sr-only" aria-live="polite" data-testid="order-notice">{orderNotice}</p>
      <PageHeader
        kicker="Library"
        title="Files"
        sub="Durable document storage for HQ administrators."
        action={
          <div className="flex gap-2">
            <input
              type="file"
              multiple
              ref={fileInputRef}
              className="hidden"
              onChange={(event) => { addUploads(Array.from(event.target.files ?? [])); event.target.value = ''; }}
              data-testid="input-file-upload"
            />
            <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} data-testid="button-new-folder" onClick={() => setNewFolderOpen(true)}><Folder size={14} />New folder</button>
            <button
              type="button"
              className={`${BTN_PRIMARY} h-9 px-3.5`}
              data-testid="button-new-file"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus size={14} aria-hidden="true" />
              Upload
            </button>
          </div>
        }
      />
      {!archivedView && <div role="search" className="mb-4 flex max-w-xl items-center gap-2">
        <label htmlFor="hq-file-search" className="sr-only">Search files</label>
        <input id="hq-file-search" type="search" value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setFileSearch(''); }} placeholder="Search files by name" className="h-10 flex-1 rounded-md border border-input bg-white px-3 text-sm" />
        {fileSearch && <button type="button" aria-label="Clear search" className={`${BTN_SECONDARY} h-10 px-3 text-lg`} onClick={() => setFileSearch('')}>×</button>}
      </div>}
      <SectionCard
        title={fileSearch.trim() ? `Results for “${fileSearch.trim()}”` : 'HQ Drive'}
        sub={<span className="flex flex-wrap items-center gap-1" aria-label="Folder path"><button type="button" className="text-xs text-primary hover:underline" onClick={() => goFolder(null)}>Files</button>{archivedView ? <><ChevronRight size={11} /><strong className="text-xs text-navy">Archived</strong></> : data?.breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.id}><ChevronRight size={11} /><button type="button" className={index === data.breadcrumbs.length - 1 ? 'text-xs font-semibold text-navy' : 'text-xs text-primary hover:underline'} onClick={() => goFolder(crumb.id)}>{crumb.name}</button></React.Fragment>)}</span>}
        action={!fileSearch.trim() ? <div className="flex items-center gap-2">
          {!archivedView && <ViewToggle view={view} onChange={changeView} />}
          <button type="button" className={`${archivedView ? BTN_PRIMARY : BTN_SECONDARY} h-8 px-3 text-xs`} onClick={() => { setFileSearch(''); setDebouncedSearch(''); navigate(archivedView ? '/admin/files' : '/admin/files?view=archived', { replace: true }); }}>{archivedView ? 'Back to files' : 'Archived'}</button>
        </div> : undefined}
      >
        <div className="px-5 py-4">
          {fileSearch.trim() ? (
            <SearchResults query={fileSearch.trim()} files={searchResult.data?.files ?? []} loading={searchResult.isLoading || debouncedSearch !== fileSearch.trim()} error={searchResult.isError ? apiError(searchResult.error, 'Could not search files right now.') : null} onOpen={setSelectedFile} onFolder={(folder) => { setSelectedFile(null); goFolder(folder.id); }} />
          ) : isLoading ? (
            <p className="py-6 text-center text-xs text-muted-foreground">Loading files...</p>
          ) : isError ? (
            <p role="alert" className="py-6 text-center text-xs text-destructive">{apiError(error, 'Failed to load files.')}</p>
          ) : !data?.files.length && !data?.folders.length ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{archivedView ? 'Nothing archived.' : 'This folder is empty.'}</p>
          ) : (
            archivedView ? (
              <FileTable files={data.files} downloadingId={downloadingId} onOpen={setSelectedFile} showPath onFolder={(folder) => goFolder(folder.id)} onDownload={handleDownload} onDelete={setFileToDelete} onRestore={(item) => void mutate(() => updateFile.mutateAsync({ fileId: item.id, data: { archived: false } }), 'Restored')} />
            ) : view === 'list' ? (
              <FileTable files={data.files} downloadingId={downloadingId} onOpen={setSelectedFile} onDownload={handleDownload} onRename={renameFile} onMove={moveFile} onDelete={setFileToDelete} onReorder={(ids, moved) => void applyOrder('files', ids, moved)} folders={data.folders} onOpenFolder={(folder) => goFolder(folder.id)} onRenameFolder={renameFolder} onMoveFolder={moveFolder} onDeleteFolder={setFolderToDelete} onReorderFolders={(ids, moved) => void applyOrder('folders', ids, moved)} />
            ) : (
              <div className="space-y-4">
                <FolderGrid folders={data.folders} onOpen={(folder) => goFolder(folder.id)} onRename={renameFolder} onMove={moveFolder} onDelete={setFolderToDelete} onReorder={(ids, moved) => void applyOrder('folders', ids, moved)} />
                <FileGrid files={data.files} downloadingId={downloadingId} onOpen={setSelectedFile} onDownload={handleDownload} onRename={renameFile} onMove={moveFile} onDelete={setFileToDelete} onReorder={(ids, moved) => void applyOrder('files', ids, moved)} />
              </div>
            )
          )}
        </div>
      </SectionCard>

      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}><DialogContent><DialogHeader><DialogTitle className="font-serif text-navy">New folder</DialogTitle><DialogDescription>Create a folder inside {data?.folder?.name ?? 'Files'}.</DialogDescription></DialogHeader><label className="text-xs font-semibold">Folder name<input autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} className="mt-1 block h-10 w-full rounded-md border border-input bg-background px-3" /></label><DialogFooter><button type="button" className={`${BTN_SECONDARY} h-9 px-3`} onClick={() => setNewFolderOpen(false)}>Cancel</button><button type="button" className={`${BTN_PRIMARY} h-9 px-3`} disabled={!newFolderName.trim()} onClick={() => void mutate(() => createFolder.mutateAsync({ data: { name: newFolderName, parentId: folderId } }), 'Folder created').then(() => { setNewFolderOpen(false); setNewFolderName(''); }).catch(() => {})}>Create folder</button></DialogFooter></DialogContent></Dialog>

      <Dialog open={editItem?.action === 'rename'} onOpenChange={(open) => !open && setEditItem(null)}><DialogContent><DialogHeader><DialogTitle className="font-serif text-navy">Rename {editItem?.kind}</DialogTitle><DialogDescription>Enter a new name.</DialogDescription></DialogHeader><input aria-label="New name" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} className="h-10 rounded-md border border-input px-3" /><DialogFooter><button type="button" className={`${BTN_PRIMARY} h-9 px-3`} onClick={() => { if (!editItem) return; const work = editItem.kind === 'file' ? () => updateFile.mutateAsync({ fileId: editItem.item.id, data: { name: renameValue } }) : () => updateFolder.mutateAsync({ folderId: editItem.item.id, data: { name: renameValue } }); void mutate(work, 'Renamed').then(() => setEditItem(null)).catch(() => {}); }}>Save</button></DialogFooter></DialogContent></Dialog>
      {editItem?.action === 'move' && <MoveDialog open itemName={editItem.item.name} currentFolderId={folderId} movingFolderId={editItem.kind === 'folder' ? editItem.item.id : undefined} onOpenChange={(open) => !open && setEditItem(null)} onMove={(destination) => mutate(editItem.kind === 'file' ? () => updateFile.mutateAsync({ fileId: editItem.item.id, data: { folderId: destination } }) : () => updateFolder.mutateAsync({ folderId: editItem.item.id, data: { parentId: destination } }), 'Moved')} />}
      <DropOverlay visible={dropVisible} folderName={data?.folder?.name ?? 'Files'} />
      <UploadPanel items={uploadItems} minimized={uploadsMinimized} onMinimizedChange={setUploadsMinimized} onAnswer={(batch, compress) => queue.answer(batch, compress)} onRetry={(id) => queue.retry(id)} onClose={() => { queue.clearSettled(); setUploadItems(queue.snapshot); }} />
      <FileDetailDialog
        file={selectedFile}
        open={selectedFile !== null}
        onOpenChange={(open) => { if (!open) setSelectedFile(null); }}
        onDownload={handleDownload}
        onRename={(item) => { setSelectedFile(null); setRenameValue(item.name); setEditItem({ kind: 'file', item, action: 'rename' }); }}
        onMove={(item) => { setSelectedFile(null); setEditItem({ kind: 'file', item, action: 'move' }); }}
        onArchive={async (item, archived) => {
          const updated = await updateFile.mutateAsync({ fileId: item.id, data: { archived } });
          await refresh();
          toast({ variant: 'success', title: archived ? 'Archived — find it under Archived' : 'Restored' });
          setSelectedFile(updated);
        }}
        onDelete={setFileToDelete}
        onFolder={(folder) => { setSelectedFile(null); goFolder(folder.id); }}
        onReplaced={async (updated) => { await refresh(); setSelectedFile(updated); toast({ variant: 'success', title: 'Replaced' }); }}
      />

      <AlertDialog open={fileToDelete !== null} onOpenChange={(open) => !open && !deletingFile && setFileToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-navy">Delete file?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete “{fileToDelete?.name ?? lastFileNameRef.current}”? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingFile}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deletingFile}
              onClick={(event) => { event.preventDefault(); void handleDelete(); }}
              data-testid="button-confirm-delete"
            >
              {deletingFile ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={folderToDelete !== null} onOpenChange={(open) => !open && !deletingFolder && setFolderToDelete(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle className="font-serif text-navy">Delete folder and everything inside?</AlertDialogTitle><AlertDialogDescription>“{folderToDelete?.name ?? lastFolderNameRef.current}”, every sub-folder, and every file inside will be permanently deleted.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={deletingFolder}>Cancel</AlertDialogCancel><AlertDialogAction disabled={deletingFolder} className="bg-destructive text-destructive-foreground" data-testid="button-confirm-folder-delete" onClick={(event) => { event.preventDefault(); if (!folderToDelete) return; setDeletingFolder(true); void (async () => { try { const result = await deleteFolder.mutateAsync({ folderId: folderToDelete.id }); setDeletingFolder(false); setFolderToDelete(null); await refresh(); toast({ variant: 'success', title: 'Folder deleted', description: `${result.deletedFolders} folder${result.deletedFolders === 1 ? '' : 's'} and ${result.deletedFiles} file${result.deletedFiles === 1 ? '' : 's'} deleted.` }); } catch (caught) { toast({ variant: 'destructive', title: 'Delete failed', description: apiError(caught, 'Could not delete the folder.') }); } finally { setDeletingFolder(false); setFolderToDelete(null); } })(); }}>{deletingFolder ? 'Deleting…' : 'Delete everything'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </AdminPage>
  );
}

export default function Files() {
  const { authStatus, hqRole } = useSession();
  const canManageFiles = hqRole === 'Admin' || hqRole === 'Super Admin';

  if (authStatus === 'signed-in') {
    if (canManageFiles) {
      return <LiveFiles />;
    }
    return <UnauthorizedState role={hqRole} />;
  }

  return <DemoFiles />;
}
