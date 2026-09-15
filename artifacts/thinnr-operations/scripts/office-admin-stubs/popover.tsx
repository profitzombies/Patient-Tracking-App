import * as React from 'react';

export function Popover({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function PopoverTrigger({ children, asChild }: { children: React.ReactElement; asChild?: boolean }) {
  return asChild ? children : <button type="button">{children}</button>;
}

export function PopoverContent({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props}>{children}</div>;
}

export function PopoverAnchor({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}