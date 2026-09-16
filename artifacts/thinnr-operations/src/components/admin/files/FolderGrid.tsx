import { Folder, GripVertical, MoreHorizontal } from 'lucide-react';
import type { HqFolder } from '@workspace/api-client-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useDragReorder } from './reorder';

interface Props {
  folders: HqFolder[];
  onOpen(folder: HqFolder): void;
  onRename?(folder: HqFolder): void;
  onMove?(folder: HqFolder): void;
  onDelete?(folder: HqFolder): void;
  /** HQ only: enables drag-and-drop plus Move up / Move down. Providers never get this. */
  onReorder?(folderIds: string[], movedId: string): void;
}

export function FolderGrid({ folders, onOpen, onRename, onMove, onDelete, onReorder }: Props) {
  const reorder = useDragReorder('folder', folders.map((folder) => folder.id), onReorder ?? (() => {}), 'grid');
  if (!folders.length) return null;
  const reorderable = Boolean(onReorder);
  const hasMenu = Boolean(onRename || onMove || onDelete || reorderable);
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="folder-grid">
    {folders.map((folder) => {
      const marker = reorder.over?.id === folder.id ? reorder.over : null;
      return <div
        key={folder.id}
        className={`relative flex items-center rounded-[7px] border border-border bg-paper-alt shadow-xs transition hover:shadow-soft ${reorder.dragging === folder.id ? 'opacity-40' : ''}`}
        data-testid={`folder-card-${folder.id}`}
        data-drop={marker ? (marker.after ? 'after' : 'before') : undefined}
        {...(reorderable ? reorder.itemProps(folder.id) : {})}
      >
        {marker && <span aria-hidden="true" className={`pointer-events-none absolute inset-y-1 w-0.5 rounded bg-primary ${marker.after ? '-right-[7px]' : '-left-[7px]'}`} />}
        {reorderable && <span className="ml-1.5 cursor-grab text-muted-foreground/60 active:cursor-grabbing" aria-hidden="true"><GripVertical size={14} /></span>}
        <button type="button" className={`flex min-w-0 flex-1 items-center gap-3 rounded-l-[7px] py-3 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${reorderable ? 'pl-1.5' : 'pl-4'}`} onClick={() => onOpen(folder)} data-testid={`folder-${folder.id}`}>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-accent text-primary" aria-hidden="true"><Folder size={17} /></span>
          <span className="truncate text-xs font-semibold text-navy">{folder.name}</span>
        </button>
        {hasMenu && <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" className="mr-2 rounded p-2 text-muted-foreground hover:bg-accent" aria-label={`Actions for ${folder.name}`}><MoreHorizontal size={16} /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {reorderable && <DropdownMenuItem disabled={!reorder.canStep(folder.id, -1)} onSelect={() => reorder.step(folder.id, -1)} data-testid={`folder-move-up-${folder.id}`}>Move back (left)</DropdownMenuItem>}
            {reorderable && <DropdownMenuItem disabled={!reorder.canStep(folder.id, 1)} onSelect={() => reorder.step(folder.id, 1)} data-testid={`folder-move-down-${folder.id}`}>Move forward (right)</DropdownMenuItem>}
            {onRename && <DropdownMenuItem onSelect={() => onRename(folder)}>Rename</DropdownMenuItem>}
            {onMove && <DropdownMenuItem onSelect={() => onMove(folder)}>Move to…</DropdownMenuItem>}
            {onDelete && <DropdownMenuItem className="text-destructive" onSelect={() => onDelete(folder)}>Delete</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>;
    })}
  </div>;
}
