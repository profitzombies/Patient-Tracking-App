import * as React from 'react';
import type { ReactNode } from 'react';

export function DropdownMenu({ children }: { children: ReactNode }) { return <div>{children}</div>; }
export function DropdownMenuTrigger({ children }: { children: ReactNode; asChild?: boolean }) { return <>{children}</>; }
export function DropdownMenuContent({ children }: { children: ReactNode; align?: string }) { return <div>{children}</div>; }
export function DropdownMenuItem({ children, onSelect, className }: { children: ReactNode; onSelect?: () => void; className?: string }) { return <button type="button" className={className} onClick={onSelect}>{children}</button>; }