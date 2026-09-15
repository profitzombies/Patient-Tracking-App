import * as React from 'react';

export const Switch = React.forwardRef<HTMLButtonElement, {
  checked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  'aria-label'?: string;
  'data-testid'?: string;
}>(({ checked = false, onCheckedChange, ...props }, ref) => (
  <button ref={ref} type="button" role="switch" aria-checked={checked} onClick={() => onCheckedChange?.(!checked)} {...props} />
));
Switch.displayName = 'Switch';