import { Folder, MoreHorizontal } from 'lucide-react';
import type { HqFolder } from '@workspace/api-client-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

interface Props {
  folders: HqFolder[];
  onOpen(folder: HqFolder): void;
  onRename?(folder: HqFolder): void;
  onMove?(folder: HqFolder): void;
  onDelete?(folder: HqFolder): void;
}

export function FolderGrid({ folders, onOpen, onRename, onMove, onDelete }: Props) {
  if (!folders.length) return null;
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
    {folders.map((folder) => <div key={folder.id} className="flex items-center rounded-[7px] border border-border bg-paper-alt shadow-xs transition hover:shadow-soft">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-l-[7px] px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpen(folder)} data-testid={`folder-${folder.id}`}>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-accent text-primary" aria-hidden="true"><Folder size={17} /></span>
        <span className="truncate text-xs font-semibold text-navy">{folder.name}</span>
      </button>
      {(onRename || onMove || onDelete) && <DropdownMenu>
        <DropdownMenuTrigger asChild><button type="button" className="mr-2 rounded p-2 text-muted-foreground hover:bg-accent" aria-label={`Actions for ${folder.name}`}><MoreHorizontal size={16} /></button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onRename && <DropdownMenuItem onSelect={() => onRename(folder)}>Rename</DropdownMenuItem>}
          {onMove && <DropdownMenuItem onSelect={() => onMove(folder)}>Move to…</DropdownMenuItem>}
          {onDelete && <DropdownMenuItem className="text-destructive" onSelect={() => onDelete(folder)}>Delete</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>)}
  </div>;
}