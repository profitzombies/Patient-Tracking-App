import { Download, FileText, FileX2, MoreHorizontal } from 'lucide-react';
import { format } from 'date-fns';
import type { HqFile } from '@workspace/api-client-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { formatBytes } from './utils';

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
}

export function FileTable({ files, downloadingId, onOpen, onDownload, onRename, onMove, onDelete, onRestore, onFolder, showPath, compactActions }: Props) {
  if (!files.length) return null;
  return <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-xs">
    <thead><tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground"><th className="py-2.5 pr-3">Name</th><th className="px-3 py-2.5">Type</th><th className="px-3 py-2.5">Size</th><th className="px-3 py-2.5">Added</th><th className="py-2.5 pl-3 text-right">Actions</th></tr></thead>
    <tbody>{files.map((file) => <tr key={file.id} className="cursor-pointer border-b border-border last:border-0 hover:bg-paper-alt" data-testid={`file-${file.id}`} onClick={() => onOpen(file)}>
      <td className="py-2.5 pr-3"><span className="flex items-center gap-2.5"><span className="grid h-7 w-7 shrink-0 place-items-center rounded bg-accent text-primary" aria-hidden="true"><FileText size={15} /></span><span className="min-w-0"><button type="button" className="block max-w-[300px] truncate font-medium text-primary hover:underline" onClick={(event) => { event.stopPropagation(); onOpen(file); }}>{file.name}</button>{file.unavailableSince && <span className="text-[10px] text-destructive"><FileX2 size={10} className="inline" /> File unavailable</span>}{showPath && <span className="block text-[10px] text-muted-foreground">{file.path?.length ? file.path.map((folder, index) => <span key={folder.id}>{index > 0 && ' › '}<button type="button" className="hover:underline" onClick={(event) => { event.stopPropagation(); onFolder?.(folder); }}>{folder.name}</button></span>) : 'Files'}</span>}</span></span></td>
      <td className="px-3 py-2.5 text-muted-foreground">{file.contentType}</td>
      <td className="px-3 py-2.5 text-muted-foreground">{formatBytes(file.size)}{file.originalSize && file.originalSize > file.size && <span className="block text-[10px]">was {formatBytes(file.originalSize)}</span>}</td>
      <td className="px-3 py-2.5 text-muted-foreground">{format(new Date(file.createdAt), 'MMM d, yyyy')}</td>
      <td className="py-2.5 pl-3" onClick={(event) => event.stopPropagation()}><div className="flex justify-end gap-1">
        {!compactActions && onDownload && <button type="button" className="rounded p-2 text-primary hover:bg-accent disabled:opacity-40" disabled={!!file.unavailableSince || downloadingId === file.id} aria-label={`Download ${file.name}`} onClick={() => onDownload(file)}><Download size={15} /></button>}
        {onRestore && <button type="button" className="rounded px-2 py-1 text-primary hover:bg-accent" onClick={() => onRestore(file)}>Restore</button>}
        {!compactActions && (onRename || onMove || onDelete) && <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="rounded p-2 text-muted-foreground hover:bg-accent" aria-label={`Actions for ${file.name}`}><MoreHorizontal size={16} /></button></DropdownMenuTrigger><DropdownMenuContent align="end">{onRename && <DropdownMenuItem onSelect={() => onRename(file)}>Rename</DropdownMenuItem>}{onMove && <DropdownMenuItem onSelect={() => onMove(file)}>Move to…</DropdownMenuItem>}{onDelete && <DropdownMenuItem className="text-destructive" onSelect={() => onDelete(file)}>Delete</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>}
      </div></td>
    </tr>)}</tbody>
  </table></div>;
}