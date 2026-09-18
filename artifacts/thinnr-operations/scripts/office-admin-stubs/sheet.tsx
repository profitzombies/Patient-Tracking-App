/**
 * DOM-free stand-in for '@/components/ui/sheet' (Radix Dialog). Content renders
 * only while `open` so suites can assert that the phone-width builder lives in
 * the sheet; the container carries data-side for the same reason.
 */
import * as React from 'react';

const Ctx = React.createContext<{ open: boolean; onOpenChange?: (open: boolean) => void }>({ open: false });

export function Sheet({ open = false, onOpenChange, children }: { open?: boolean; onOpenChange?: (open: boolean) => void; children: React.ReactNode }) {
  return <Ctx.Provider value={{ open, onOpenChange }}>{children}</Ctx.Provider>;
}
export function SheetTrigger({ children }: { children: React.ReactElement; asChild?: boolean }) { return children; }
export function SheetClose({ children }: { children: React.ReactElement; asChild?: boolean }) { return children; }
export function SheetContent({ children, side, ...props }: React.HTMLAttributes<HTMLDivElement> & { side?: string }) {
  const { open } = React.useContext(Ctx);
  if (!open) return null;
  return <div role="dialog" data-side={side ?? 'right'} {...props}>{children}</div>;
}
export function SheetHeader({ children }: React.HTMLAttributes<HTMLDivElement>) { return <div>{children}</div>; }
export function SheetFooter({ children }: React.HTMLAttributes<HTMLDivElement>) { return <div>{children}</div>; }
export function SheetTitle({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) { return <h2 {...props}>{children}</h2>; }
export function SheetDescription({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) { return <p {...props}>{children}</p>; }
