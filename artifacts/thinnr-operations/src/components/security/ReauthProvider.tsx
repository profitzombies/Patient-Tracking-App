import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ReauthSheet } from '@/components/security/ReauthSheet';
import { registerReauthHandler } from '@/lib/reauth';
import { supabase } from '@/lib/supabase';

export function ReauthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  const resolve = useCallback((confirmed: boolean) => {
    const pending = resolveRef.current;
    resolveRef.current = null;
    setOpen(false);
    pending?.(confirmed);
  }, []);

  useEffect(() => registerReauthHandler(async () => {
    if (!supabase) return false;
    const { data } = await supabase.auth.getSession();
    if (!data.session) return false;
    return new Promise<boolean>((resolvePending) => {
      resolveRef.current = resolvePending;
      setOpen(true);
    });
  }), []);

  useEffect(() => () => {
    resolveRef.current?.(false);
    resolveRef.current = null;
  }, []);

  return (
    <>
      {children}
      <ReauthSheet open={open} onResolve={resolve} />
    </>
  );
}