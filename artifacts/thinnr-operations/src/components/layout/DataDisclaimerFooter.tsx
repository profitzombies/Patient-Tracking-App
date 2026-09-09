import { useSession } from '@/contexts/session';

export function DataDisclaimerFooter() {
  const { authStatus } = useSession();
  return (
    <div className="shrink-0 border-t border-border bg-sidebar px-5 py-2 text-center">
      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground" data-testid="data-disclaimer">
        {authStatus === 'signed-out' ? 'Synthetic Demo Data • Not Medical Advice' : 'Not Medical Advice'}
      </p>
    </div>
  );
}