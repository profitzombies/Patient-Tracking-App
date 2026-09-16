import { Download, FileText, FileX2, GripVertical, MoreHorizontal } from 'lucide-react';
import { format } from 'date-fns';
import type { HqFile } from '@workspace/api-client-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { formatBytes } from './utils';
import { useDragReorder } from './reorder';

interface Props {
  files: HqFile[];
  downloadingId: string | null;
  onOpen(file: HqFile): void;
  onDownload?(file: HqFile): void;
  onRename?(file: HqFile): void;
  onMove?(file: HqFile): void;
  onDelete?(file: HqFile): void;
  /** HQ only: drag cards (and Move up / Move down) to set the file order. */
  onReorder?(fileIds: string[], movedId: string): void;
}

function typeLabel(contentType: string) {
  const subtype = contentType.split('/')[1] ?? contentType;
  if (subtype.includes('pdf')) return 'PDF';
  if (subtype.includes('wordprocessingml')) return 'Word';
  if (subtype.includes('spreadsheetml')) return 'Excel';
  if (subtype.includes('presentationml')) return 'PowerPoint';
  if (contentType.startsWith('image/')) return subtype.toUpperCase();
  return subtype.length <= 5 ? subtype.toUpperCase() : contentType;
}

/** Card view of one folder's files. Same actions as the list; drag to reorder in reading order. */
export function FileGrid({ files, downloadingId, onOpen, onDownload, onRename, onMove, onDelete, onReorder }: Props) {
  const reorder = useDragReorder('file', files.map((file) => file.id), onReorder ?? (() => {}), 'grid');
  if (!files.length) return null;
  const reorderable = Boolean(onReorder);
  const hasMenu = Boolean(onRename || onMove || onDelete || reorderable);
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="file-grid">
    {files.map((file) => {
      const marker = reorder.over?.id === file.id ? reorder.over : null;
      return <div
        key={file.id}
        className={`relative flex flex-col rounded-[7px] border border-border bg-white shadow-xs transition hover:shadow-soft ${reorder.dragging === file.id ? 'opacity-40' : ''}`}
        data-testid={`file-card-${file.id}`}
        data-drop={marker ? (marker.after ? 'after' : 'before') : undefined}
        {...(reorderable ? reorder.itemProps(file.id) : {})}
      >
        {marker && <span aria-hidden="true" className={`pointer-events-none absolute inset-y-1 w-0.5 rounded bg-primary ${marker.after ? '-right-[7px]' : '-left-[7px]'}`} />}
        <div className="flex items-start gap-2 p-3 pb-0">
          {reorderable && <span className="mt-2 cursor-grab text-muted-foreground/60 active:cursor-grabbing" aria-hidden="true"><GripVertical size={14} /></span>}
          <button type="button" className="flex min-w-0 flex-1 items-start gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpen(file)} data-testid={`file-${file.id}`}>
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-accent text-primary" aria-hidden="true"><FileText size={17} /></span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold text-navy">{file.name}</span>
              <span className="block text-[10px] text-muted-foreground">{typeLabel(file.contentType)} · {formatBytes(file.size)} · {format(new Date(file.createdAt), 'MMM d, yyyy')}</span>
              {file.unavailableSince && <span className="block text-[10px] text-destructive"><FileX2 size={10} className="inline" /> File unavailable</span>}
            </span>
          </button>
        </div>
        <div className="flex items-center justify-end gap-1 px-2 pb-1.5 pt-1">
          {onDownload && <button type="button" className="rounded p-2 text-primary hover:bg-accent disabled:opacity-40" disabled={!!file.unavailableSince || downloadingId === file.id} aria-label={`Download ${file.name}`} onClick={() => onDownload(file)}><Download size={15} /></button>}
          {hasMenu && <DropdownMenu>
            <DropdownMenuTrigger asChild><button type="button" className="rounded p-2 text-muted-foreground hover:bg-accent" aria-label={`Actions for ${file.name}`}><MoreHorizontal size={16} /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {reorderable && <DropdownMenuItem disabled={!reorder.canStep(file.id, -1)} onSelect={() => reorder.step(file.id, -1)} data-testid={`file-move-up-${file.id}`}>Move back (left)</DropdownMenuItem>}
              {reorderable && <DropdownMenuItem disabled={!reorder.canStep(file.id, 1)} onSelect={() => reorder.step(file.id, 1)} data-testid={`file-move-down-${file.id}`}>Move forward (right)</DropdownMenuItem>}
              {onRename && <DropdownMenuItem onSelect={() => onRename(file)}>Rename</DropdownMenuItem>}
              {onMove && <DropdownMenuItem onSelect={() => onMove(file)}>Move to…</DropdownMenuItem>}
              {onDelete && <DropdownMenuItem className="text-destructive" onSelect={() => onDelete(file)}>Delete</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>}
        </div>
      </div>;
    })}
  </div>;
}
