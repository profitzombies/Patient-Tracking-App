import * as React from 'react';

/** DOM-free stand-in for the Radix radio group: a role=radiogroup div and plain radio buttons. */
export function RadioGroup({
  children,
  value,
  onValueChange,
  ...props
}: { children?: React.ReactNode; value?: string; onValueChange?: (value: string) => void } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="radiogroup" data-value={value} {...props}>
      {React.Children.map(children, (child) =>
        React.isValidElement(child) ? React.cloneElement(child as React.ReactElement<any>, { __group: { value, onValueChange } }) : child,
      )}
    </div>
  );
}

export function RadioGroupItem({
  value,
  __group,
  ...props
}: { value: string; __group?: { value?: string; onValueChange?: (value: string) => void } } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={__group?.value === value}
      onClick={() => __group?.onValueChange?.(value)}
      {...props}
    />
  );
}
