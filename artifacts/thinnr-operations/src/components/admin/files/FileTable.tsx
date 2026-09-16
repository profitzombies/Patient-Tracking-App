import { Download, FileText, FileX2, Folder, GripVertical, MoreHorizontal } from 'lucide-react';
import { format } from 'date-fns';
import type { HqFile, HqFolder } from '@workspace/api-client-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { formatBytes } from './utils';
import { useDragReorder, type DragReorder } from './reorder';

interface Props {
  files: HqFile[];
  downloadingId: string | null;
  onOpen(file: HqFile): void;
  onDownload?(file: HqFile): void;
  onRename?(file: HqFile): void;
  onMove?(file: HqFile): void;
  onDelete?(file: HqFile): void;
  onRestore?(file: HqFile): void;
  onFolder?(folder: NonNullable<HqFile['path']>[number]): void;
  showPath?: boolean;
  compactActions?: boolean;
  /** HQ only: drag rows (and Move up / Move down) to set the file order. */
  onReorder?(fileIds: string[], movedId: string): void;
  /** List view: sub-folders as rows above the files, in the same table. */
  folders?: HqFolder[];
  onOpenFolder?(folder: HqFolder): void;
  onRenameFolder?(folder: HqFolder): void;
  onMoveFolder?(folder: HqFolder): void;
  onDeleteFolder?(folder: HqFolder): void;
  onReorderFolders?(folderIds: string[], movedId: string): void;
}

function rowClasses(reorder: DragReorder, id: string, base: string) {
  const marker = reorder.over?.id === id ? reorder.over : null;
  return [
    base,
    reorder.dragging === id ? 'opacity-40' : '',
    marker ? (marker.after ? 'shadow-[inset_0_-2px_0_0_var(--color-primary)]' : 'shadow-[inset_0_2px_0_0_var(--color-primary)]') : '',
  ].join(' ');
}

function dropMarker(reorder: DragReorder, id: string) {
  const marker = reorder.over?.id === id ? reorder.over : null;
  return marker ? (marker.after ? 'after' : 'before') : undefined;
}

function StepItems({ reorder, id, testPrefix }: { reorder: DragReorder; id: string; testPrefix: string }) {
  return <>
    <DropdownMenuItem disabled={!reorder.canStep(id, -1)} onSelect={() => reorder.step(id, -1)} data-testid={`${testPrefix}-move-up-${id}`}>Move up</DropdownMenuItem>
    <DropdownMenuItem disabled={!reorder.canStep(id, 1)} onSelect={() => reorder.step(id, 1)} data-testid={`${testPrefix}-move-down-${id}`}>Move down</DropdownMenuItem>
  </>;
}

export function FileTable({ files, downloadingId, onOpen, onDownload, onRename, onMove, onDelete, onRestore, onFolder, showPath, compactActions, onReorder, folders = [], onOpenFolder, onRenameFolder, onMoveFolder, onDeleteFolder, onReorderFolders }: Props) {
  const fileReorder = useDragReorder('file', files.map((file) => file.id), onReorder ?? (() => {}), 'list');
  const folderReorder = useDragReorder('folder', folders.map((folder) => folder.id), onReorderFolders ?? (() => {}), 'list');
  if (!files.length && !folders.length) return null;
  const filesReorderable = Boolean(onReorder);
  const foldersReorderable = Boolean(onReorderFolders);
  const grip = <span className="mr-1 inline-flex cursor-grab text-muted-foreground/60 active:cursor-grabbing" aria-hidden="true"><GripVertical size={14} /></span>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-xs">
    <thead><tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground"><th className="py-2.5 pr-3">Name</th><th className="px-3 py-2.5">Type</th><th className="px-3 py-2.5">Size</th><th className="px-3 py-2.5">Added</th><th className="py-2.5 pl-3 text-right">Actions</th></tr></thead>
    <tbody>
      {folders.map((folder) => <tr key={`folder-${folder.id}`} className={rowClasses(folderReorder, folder.id, 'cursor-pointer border-b border-border last:border-0 hover:bg-paper-alt')} data-testid={`folder-row-${folder.id}`} data-drop={dropMarker(folderReorder, folder.id)} onClick={() => onOpenFolder?.(folder)} {...(foldersReorderable ? folderReorder.itemProps(folder.id) : {})}>
        <td className="py-2.5 pr-3"><span className="flex items-center gap-2.5">{foldersReorderable && grip}<span className="grid h-7 w-7 shrink-0 place-items-center rounded bg-accent text-primary" aria-hidden="true"><Folder size={15} /></span><button type="button" className="block max-w-[300px] truncate font-semibold text-navy hover:underline" data-testid={`folder-${folder.id}`} onClick={(event) => { event.stopPropagation(); onOpenFolder?.(folder); }}>{folder.name}</button></span></td>
        <td className="px-3 py-2.5 text-muted-foreground">Folder</td>
        <td className="px-3 py-2.5 text-muted-foreground">—</td>
        <td className="px-3 py-2.5 text-muted-foreground">{folder.createdAt ? format(new Date(folder.createdAt), 'MMM d, yyyy') : ''}</td>
        <td className="py-2.5 pl-3" onClick={(event) => event.stopPropagation()}><div className="flex justify-end gap-1">
          {(onRenameFolder || onMoveFolder || onDeleteFolder || foldersReorderable) && <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="rounded p-2 text-muted-foreground hover:bg-accent" aria-label={`Actions for ${folder.name}`}><MoreHorizontal size={16} /></button></DropdownMenuTrigger><DropdownMenuContent align="end">
            {foldersReorderable && <StepItems reorder={folderReorder} id={folder.id} testPrefix="folder" />}
            {onRenameFolder && <DropdownMenuItem onSelect={() => onRenameFolder(folder)}>Rename</DropdownMenuItem>}
            {onMoveFolder && <DropdownMenuItem onSelect={() => onMoveFolder(folder)}>Move to…</DropdownMenuItem>}
            {onDeleteFolder && <DropdownMenuItem className="text-destructive" onSelect={() => onDeleteFolder(folder)}>Delete</DropdownMenuItem>}
          </DropdownMenuContent></DropdownMenu>}
        </div></td>
      </tr>)}
      {files.map((file) => <tr key={file.id} className={rowClasses(fileReorder, file.id, 'cursor-pointer border-b border-border last:border-0 hover:bg-paper-alt')} data-testid={`file-${file.id}`} data-drop={dropMarker(fileReorder, file.id)} onClick={() => onOpen(file)} {...(filesReorderable ? fileReorder.itemProps(file.id) : {})}>
        <td className="py-2.5 pr-3"><span className="flex items-center gap-2.5">{filesReorderable && grip}<span className="grid h-7 w-7 shrink-0 place-items-center rounded bg-accent text-primary" aria-hidden="true"><FileText size={15} /></span><span className="min-w-0"><button type="button" className="block max-w-[300px] truncate font-medium text-primary hover:underline" onClick={(event) => { event.stopPropagation(); onOpen(file); }}>{file.name}</button>{file.unavailableSince && <span className="text-[10px] text-destructive"><FileX2 size={10} className="inline" /> File unavailable</span>}{showPath && <span className="block text-[10px] text-muted-foreground">{file.path?.length ? file.path.map((folder, index) => <span key={folder.id}>{index > 0 && ' › '}<button type="button" className="hover:underline" onClick={(event) => { event.stopPropagation(); onFolder?.(folder); }}>{folder.name}</button></span>) : 'Files'}</span>}</span></span></td>
        <td className="px-3 py-2.5 text-muted-foreground">{file.contentType}</td>
        <td className="px-3 py-2.5 text-muted-foreground">{formatBytes(file.size)}{file.originalSize && file.originalSize > file.size && <span className="block text-[10px]">was {formatBytes(file.originalSize)}</span>}</td>
        <td className="px-3 py-2.5 text-muted-foreground">{format(new Date(file.createdAt), 'MMM d, yyyy')}</td>
        <td className="py-2.5 pl-3" onClick={(event) => event.stopPropagation()}><div className="flex justify-end gap-1">
          {!compactActions && onDownload && <button type="button" className="rounded p-2 text-primary hover:bg-accent disabled:opacity-40" disabled={!!file.unavailableSince || downloadingId === file.id} aria-label={`Download ${file.name}`} onClick={() => onDownload(file)}><Download size={15} /></button>}
          {onRestore && <button type="button" className="rounded px-2 py-1 text-primary hover:bg-accent" onClick={() => onRestore(file)}>Restore</button>}
          {!compactActions && (onRename || onMove || onDelete || filesReorderable) && <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="rounded p-2 text-muted-foreground hover:bg-accent" aria-label={`Actions for ${file.name}`}><MoreHorizontal size={16} /></button></DropdownMenuTrigger><DropdownMenuContent align="end">
            {filesReorderable && <StepItems reorder={fileReorder} id={file.id} testPrefix="file" />}
            {onRename && <DropdownMenuItem onSelect={() => onRename(file)}>Rename</DropdownMenuItem>}
            {onMove && <DropdownMenuItem onSelect={() => onMove(file)}>Move to…</DropdownMenuItem>}
            {onDelete && <DropdownMenuItem className="text-destructive" onSelect={() => onDelete(file)}>Delete</DropdownMenuItem>}
          </DropdownMenuContent></DropdownMenu>}
        </div></td>
      </tr>)}
    </tbody>
  </table></div>;
}
