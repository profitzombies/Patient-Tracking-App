/**
 * Drive-style files preview and Live file storage.
 *
 * A browsable mockup of the HQ shared drive for the demo persona.
 * Signed-in HQ admins use the live API to interact with real durable storage.
 */
import React, { useState, useRef } from 'react';
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
  Trash2,
} from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { useSession } from '@/contexts/session';
import { useQueryClient } from '@tanstack/react-query';
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
  getHqFileDownload,
  type HqFile,
} from '@workspace/api-client-react';

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

  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [fileToDelete, setFileToDelete] = useState<HqFile | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const queryKey = [...getGetHqFilesQueryKey(), authUser?.id] as const;
  const { data, isLoading, isError } = useGetHqFiles({
    query: { queryKey }
  });

  const createUpload = useCreateHqFileUpload();
  const finalizeUpload = useFinalizeHqFile();
  const deleteFile = useDeleteHqFile();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    if (file.size > 50 * 1024 * 1024) {
      toast({ variant: 'destructive', title: 'File too large', description: 'Maximum file size is 50 MB.' });
      return;
    }

    try {
      setUploadingName(file.name);
      const { uploadUrl, fileId, objectPath } = await createUpload.mutateAsync({
        data: {
          name: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
        }
      });

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });

      if (!putRes.ok) {
        throw new Error('Upload to storage failed');
      }

      await finalizeUpload.mutateAsync({
        data: {
          fileId,
          name: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          objectPath,
        }
      });

      queryClient.invalidateQueries({ queryKey });
      toast({ variant: 'success', title: 'File uploaded', description: file.name });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Upload failed', description: 'There was a problem uploading your file.' });
    } finally {
      setUploadingName(null);
    }
  };

  const handleDownload = async (file: HqFile) => {
    try {
      setDownloadingId(file.id);
      const res = await getHqFileDownload(file.id);
      window.location.assign(res.url);
    } catch (error) {
      toast({ variant: 'destructive', title: 'Download failed', description: 'Could not generate a download link.' });
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async () => {
    if (!fileToDelete) return;
    try {
      await deleteFile.mutateAsync({ fileId: fileToDelete.id });
      queryClient.setQueryData(queryKey, (old: any) => {
        if (!old) return old;
        return {
          ...old,
          files: old.files.filter((f: HqFile) => f.id !== fileToDelete.id),
        };
      });
      toast({ variant: 'success', title: 'File deleted', description: fileToDelete.name });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Delete failed', description: 'Could not delete the file.' });
    } finally {
      setFileToDelete(null);
    }
  };

  return (
    <AdminPage>
      <PageHeader
        kicker="Library"
        title="Files"
        sub="Durable document storage for HQ administrators."
        action={
          <>
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              onChange={handleFileChange}
              data-testid="input-file-upload"
            />
            <button
              type="button"
              className={`${BTN_PRIMARY} h-9 px-3.5`}
              data-testid="button-new-file"
              disabled={!!uploadingName}
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus size={14} aria-hidden="true" />
              {uploadingName ? 'Uploading...' : 'Upload'}
            </button>
          </>
        }
      />

      <SectionCard title="Documents">
        <div className="px-5 py-4">
          {isLoading ? (
            <p className="py-6 text-center text-xs text-muted-foreground">Loading files...</p>
          ) : isError ? (
            <p className="py-6 text-center text-xs text-destructive">Failed to load files.</p>
          ) : data?.files.length === 0 && !uploadingName ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No files uploaded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                    <th className="py-2.5 pr-3 font-bold">Name</th>
                    <th className="px-3 py-2.5 font-bold">Type</th>
                    <th className="px-3 py-2.5 font-bold">Size</th>
                    <th className="px-3 py-2.5 font-bold">Uploaded</th>
                    <th className="py-2.5 pl-3 text-right font-bold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {uploadingName && (
                    <tr className="border-b border-border last:border-b-0">
                      <td className="py-2.5 pr-3">
                        <span className="flex items-center gap-2.5 opacity-50">
                          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-accent text-primary">
                            <FileText size={15} />
                          </span>
                          <span className="truncate font-medium text-foreground">{uploadingName}</span>
                        </span>
                      </td>
                      <td colSpan={4} className="px-3 py-2.5 text-muted-foreground text-right italic">
                        Uploading...
                      </td>
                    </tr>
                  )}
                  {data?.files.map((file) => (
                    <tr key={file.id} className="border-b border-border last:border-b-0" data-testid={`file-${file.id}`}>
                      <td className="py-2.5 pr-3">
                        <span className="flex items-center gap-2.5">
                          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-accent text-primary" aria-hidden="true">
                            {getIconForContentType(file.contentType)}
                          </span>
                          <span className="truncate font-medium text-foreground">{file.name}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{getLabelForContentType(file.contentType)}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{formatBytes(file.size)}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{format(new Date(file.createdAt), 'MMM d, yyyy')}</td>
                      <td className="py-2.5 pl-3 text-right">
                        <div className="flex justify-end items-center gap-2">
                          <button
                            type="button"
                            className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}
                            data-testid={`button-download-${file.id}`}
                            disabled={downloadingId === file.id}
                            onClick={() => handleDownload(file)}
                          >
                            <Download size={12} aria-hidden="true" />
                            {downloadingId === file.id ? 'Starting...' : 'Download'}
                          </button>
                          <button
                            type="button"
                            className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px] text-destructive hover:bg-destructive/10 hover:border-destructive/30`}
                            data-testid={`button-delete-${file.id}`}
                            onClick={() => setFileToDelete(file)}
                          >
                            <Trash2 size={12} aria-hidden="true" />
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SectionCard>

      <AlertDialog open={fileToDelete !== null} onOpenChange={(open) => !open && setFileToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-navy">Delete file?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete “{fileToDelete?.name}”? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
