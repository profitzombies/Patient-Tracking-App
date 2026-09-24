import { useEffect, useState } from 'react';
import { ChevronLeft, Folder } from 'lucide-react';
import { getHqFiles, type HqFileListResult, type HqFolder } from '@workspace/api-client-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BTN_PRIMARY, BTN_SECONDARY } from '@/components/patient/heritage';

interface Props {
  open: boolean;
  itemName: string;
  currentFolderId: string | null;
  movingFolderId?: string;
  onOpenChange(open: boolean): void;
  onMove(folderId: string | null): Promise<void>;
}

export function MoveDialog({ open, itemName, currentFolderId, movingFolderId, onOpenChange, onMove }: Props) {
  const [browser, setBrowser] = useState<HqFileListResult | null>(null);
  const [destination, setDestination] = useState<string | null>(currentFolderId);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (folderId: string | null) => {
    setError('');
    try {
      const next = await getHqFiles(folderId ? { folderId } : undefined);
      setBrowser(next);
      setDestination(folderId);
    } catch {
      setError('Could not load folders.');
    }
  };
  useEffect(() => { if (open) void load(null); }, [open]);

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-[470px]">
    <DialogHeader><DialogTitle className="font-serif text-navy">Move “{itemName}”</DialogTitle><DialogDescription>Choose a destination folder.</DialogDescription></DialogHeader>
    <div className="min-h-52 rounded-[7px] border border-border bg-paper-alt p-2">
      {browser?.folder && <button type="button" className="mb-1 flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-accent" onClick={() => void load(browser.folder?.parentId ?? null)}><ChevronLeft size={14} /> Back</button>}
      <button type="button" className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs ${destination === (browser?.folder?.id ?? null) ? 'bg-accent font-semibold' : ''}`} onClick={() => setDestination(browser?.folder?.id ?? null)}><Folder size={15} /> {browser?.folder?.name ?? 'Marketing Assets (root)'} <span className="ml-auto text-muted-foreground">Select here</span></button>
      {browser?.folders.filter((folder) => folder.id !== movingFolderId).map((folder: HqFolder) => <button key={folder.id} type="button" className="flex w-full items-center gap-2 rounded px-2 py-2 pl-6 text-left text-xs hover:bg-accent" onClick={() => void load(folder.id)}><Folder size={15} /> {folder.name}</button>)}
      {error && <p role="alert" className="p-2 text-xs text-destructive">{error}</p>}
    </div>
    <DialogFooter><button type="button" className={`${BTN_SECONDARY} h-9 px-3`} onClick={() => onOpenChange(false)}>Cancel</button><button type="button" className={`${BTN_PRIMARY} h-9 px-3`} disabled={busy} onClick={async () => { setBusy(true); try { await onMove(destination); onOpenChange(false); } finally { setBusy(false); } }}>Move here</button></DialogFooter>
  </DialogContent></Dialog>;
}