export function DropOverlay({ visible, folderName }: { visible: boolean; folderName: string }) {
  if (!visible) return null;
  return <div className="pointer-events-none fixed inset-0 z-[65] grid place-items-center bg-navy/35 p-8" data-testid="files-drop-overlay"><div className="rounded-[9px] border-2 border-dashed border-primary bg-paper px-10 py-8 text-center font-serif text-xl font-semibold text-navy shadow-xl">Drop to upload into {folderName}</div></div>;
}