/**
 * DOM-free stand-in for '@/components/ui/command' (cmdk needs a document).
 * Items render as option buttons whose click calls onSelect(value).
 */
import * as React from 'react';

export function Command({ children }: { children: React.ReactNode; className?: string }) { return <div role="listbox">{children}</div>; }
export function CommandInput({ placeholder }: { placeholder?: string; className?: string }) { return <input type="text" placeholder={placeholder} aria-label={placeholder} />; }
export function CommandList({ children }: { children: React.ReactNode }) { return <div>{children}</div>; }
export function CommandEmpty({ children }: { children: React.ReactNode }) { return <div data-empty>{children}</div>; }
export function CommandGroup({ children }: { children: React.ReactNode; heading?: string }) { return <div>{children}</div>; }
export function CommandSeparator() { return <hr />; }
export function CommandItem({ children, value, onSelect, ...props }: { children: React.ReactNode; value?: string; onSelect?: (value: string) => void; className?: string; 'data-value'?: string; disabled?: boolean }) {
  return <button type="button" role="option" data-value={props['data-value'] ?? value} disabled={props.disabled} onClick={() => onSelect?.(value ?? '')}>{children}</button>;
}
export function CommandShortcut({ children }: { children: React.ReactNode }) { return <span>{children}</span>; }
export function CommandDialog({ children }: { children: React.ReactNode }) { return <div>{children}</div>; }
