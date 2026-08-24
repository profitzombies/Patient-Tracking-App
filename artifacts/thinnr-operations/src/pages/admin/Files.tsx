/**
 * Drive-style files preview.
 *
 * A browsable mockup of the HQ shared drive: nested folders, files with
 * sizes and modified dates, and a "share link" dialog that copies a fake
 * public URL. Nothing is stored or served — the preview banner and the
 * .example.com share domain keep that unmistakable.
 */
import { useState } from 'react';
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
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BTN_PRIMARY, BTN_SECONDARY, INSET, SectionCard } from '@/components/patient/heritage';
import { AdminPage, PageHeader, PreviewBanner, copyText } from '@/components/admin/primitives';
import { DRIVE_ROOT, DRIVE_SHARE_BASE, findFolderPath, type DriveFile, type DriveFileKind } from '@/data/hq/files';

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

export default function Files() {
  const { toast } = useToast();
  // Folder ids below the root; [] = at the drive root. State-only navigation
  // keeps the mockup self-contained (no routes to maintain for a preview).
  const [pathIds, setPathIds] = useState<string[]>([]);
  const [sharing, setSharing] = useState<DriveFile | null>(null);

  const chain = findFolderPath(pathIds) ?? [DRIVE_ROOT];
  const current = chain[chain.length - 1];

  const shareUrl = sharing ? `${DRIVE_SHARE_BASE}/${sharing.shareId}` : '';

  const handleCopy = async () => {
    const landed = await copyText(shareUrl);
    toast(
      landed
        ? { title: 'Share link copied', description: 'Simulated URL — it goes nowhere outside this demo.' }
        : { title: 'Copy unavailable', description: 'Select the link text and copy it manually.' },
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

      {/* Fake public share link dialog */}
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
