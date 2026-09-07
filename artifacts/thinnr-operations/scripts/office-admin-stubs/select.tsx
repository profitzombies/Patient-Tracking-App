/**
 * DOM-free stand-in for '@/components/ui/select' (Radix) used by the office
 * admin suites (tsconfig.office-admin.json). Radix Select needs a document
 * for its popper/portal; under react-test-renderer the suites only need a
 * controllable value, so the trigger renders as a combobox button carrying
 * data-value and every item renders as an always-present option button
 * whose click calls onValueChange. Props the real pages pass through
 * (className, aria-label, data-testid) are preserved verbatim.
 */
import * as React from 'react';
import { createContext, useContext, type ReactNode } from 'react';

interface SelectCtx { value: string | undefined; onValueChange?: (value: string) => void }
const Ctx = createContext<SelectCtx>({ value: undefined });

export function Select({ value, onValueChange, children }: { value?: string; onValueChange?: (value: string) => void; children: ReactNode; defaultValue?: string; disabled?: boolean }) {
  return <Ctx.Provider value={{ value, onValueChange }}>{children}</Ctx.Provider>;
}

export function SelectTrigger({ children, ...props }: { children?: ReactNode; className?: string; 'aria-label'?: string; 'data-testid'?: string; id?: string }) {
  const { value } = useContext(Ctx);
  return <button type="button" role="combobox" data-value={value ?? ''} {...props}>{children}</button>;
}

export function SelectValue({ placeholder }: { placeholder?: string }) {
  const { value } = useContext(Ctx);
  return <span data-placeholder={placeholder ?? ''}>{value ?? placeholder ?? ''}</span>;
}

export function SelectContent({ children }: { children: ReactNode; className?: string; position?: string }) {
  return <div role="listbox">{children}</div>;
}

export function SelectItem({ value, children, ...props }: { value: string; children: ReactNode; className?: string; disabled?: boolean }) {
  const ctx = useContext(Ctx);
  return (
    <button type="button" role="option" data-value={value} aria-selected={ctx.value === value} disabled={props.disabled} onClick={() => ctx.onValueChange?.(value)}>
      {children}
    </button>
  );
}

export function SelectGroup({ children }: { children: ReactNode }) { return <div>{children}</div>; }
export function SelectLabel({ children }: { children: ReactNode }) { return <div>{children}</div>; }
export function SelectSeparator() { return <hr />; }
