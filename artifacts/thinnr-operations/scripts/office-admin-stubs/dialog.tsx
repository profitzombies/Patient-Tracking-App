/**
 * DOM-free stand-in for '@/components/ui/dialog' (Radix) used by the office
 * admin suites (tsconfig.office-admin.json). Radix portals need a document;
 * here an open dialog simply renders its content inline as role="dialog"
 * and a closed one renders nothing — exactly what the pages rely on.
 */
import * as React from 'react';
import { createContext, useContext, type ReactNode } from 'react';

interface DialogCtx { open: boolean; onOpenChange?: (open: boolean) => void }
const Ctx = createContext<DialogCtx>({ open: false });

export function Dialog({ open = false, onOpenChange, children }: { open?: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode }) {
  return <Ctx.Provider value={{ open, onOpenChange }}>{children}</Ctx.Provider>;
}
export function DialogTrigger({ children }: { children: ReactNode; asChild?: boolean }) { return <>{children}</>; }
export function DialogPortal({ children }: { children: ReactNode }) { return <>{children}</>; }
export function DialogOverlay() { return null; }
export function DialogContent({ children, className }: { children: ReactNode; className?: string }) {
  const { open } = useContext(Ctx);
  return open ? <div role="dialog" aria-modal="true" className={className}>{children}</div> : null;
}
export function DialogClose({ children }: { children?: ReactNode; asChild?: boolean; className?: string }) {
  const { onOpenChange } = useContext(Ctx);
  return <button type="button" onClick={() => onOpenChange?.(false)}>{children}</button>;
}
export function DialogHeader({ children, className }: { children: ReactNode; className?: string }) { return <div className={className}>{children}</div>; }
export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) { return <div className={className}>{children}</div>; }
export function DialogTitle({ children, className }: { children: ReactNode; className?: string }) { return <h2 className={className}>{children}</h2>; }
export function DialogDescription({ children, className }: { children: ReactNode; className?: string }) { return <p className={className}>{children}</p>; }
