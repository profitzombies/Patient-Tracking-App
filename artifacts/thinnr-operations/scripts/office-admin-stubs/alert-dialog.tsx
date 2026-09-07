/**
 * DOM-free stand-in for '@/components/ui/alert-dialog' (Radix) used by the
 * office admin suites (tsconfig.office-admin.json). Open content renders
 * inline as role="alertdialog"; Cancel closes via onOpenChange; Action is a
 * plain button that forwards its own onClick and test id.
 */
import * as React from 'react';
import { createContext, useContext, type MouseEvent, type ReactNode } from 'react';

interface DialogCtx { open: boolean; onOpenChange?: (open: boolean) => void }
const Ctx = createContext<DialogCtx>({ open: false });

export function AlertDialog({ open = false, onOpenChange, children }: { open?: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode }) {
  return <Ctx.Provider value={{ open, onOpenChange }}>{children}</Ctx.Provider>;
}
export function AlertDialogTrigger({ children }: { children: ReactNode; asChild?: boolean }) { return <>{children}</>; }
export function AlertDialogPortal({ children }: { children: ReactNode }) { return <>{children}</>; }
export function AlertDialogOverlay() { return null; }
export function AlertDialogContent({ children, className }: { children: ReactNode; className?: string }) {
  const { open } = useContext(Ctx);
  return open ? <div role="alertdialog" aria-modal="true" className={className}>{children}</div> : null;
}
export function AlertDialogHeader({ children, className }: { children: ReactNode; className?: string }) { return <div className={className}>{children}</div>; }
export function AlertDialogFooter({ children, className }: { children: ReactNode; className?: string }) { return <div className={className}>{children}</div>; }
export function AlertDialogTitle({ children, className }: { children: ReactNode; className?: string }) { return <h2 className={className}>{children}</h2>; }
export function AlertDialogDescription({ children, className }: { children: ReactNode; className?: string }) { return <p className={className}>{children}</p>; }
export function AlertDialogAction({ children, onClick, ...props }: { children: ReactNode; onClick?: (event: MouseEvent<HTMLButtonElement>) => void; className?: string; disabled?: boolean; 'data-testid'?: string }) {
  return <button type="button" onClick={onClick} {...props}>{children}</button>;
}
export function AlertDialogCancel({ children, ...props }: { children: ReactNode; className?: string; 'data-testid'?: string }) {
  const { onOpenChange } = useContext(Ctx);
  return <button type="button" onClick={() => onOpenChange?.(false)} {...props}>{children}</button>;
}
