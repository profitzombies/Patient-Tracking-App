/**
 * Money and percent inputs for the payments area. Staff type dollars
 * ("59.99") and percents ("2.90"); the wire contract stays integer cents and
 * basis points, so every consumer converts with the helpers exported here.
 */
import { forwardRef, type InputHTMLAttributes } from 'react';
import { INPUT_CLASS } from '@/components/patient/heritage';
import { parseDollarsToCents } from '@/lib/billing-format';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'prefix'> & { invalid?: boolean };

const BASE = `${INPUT_CLASS} h-9 w-full tabular-nums`;

/**
 * `$` sits inside the field; the value is plain dollars text the caller owns.
 * `className` lands on the wrapper so spacing utilities (mt-1 and friends)
 * move the prefix together with the field instead of leaving it behind.
 */
export const MoneyInput = forwardRef<HTMLInputElement, Props>(function MoneyInput({ className, invalid, ...props }, ref) {
  return (
    <span className={`relative block ${className ?? ''}`}>
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-y-0 left-3 flex items-center text-xs font-semibold ${invalid ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        $
      </span>
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        placeholder="0.00"
        aria-invalid={invalid || undefined}
        className={`${BASE} pl-7 ${invalid ? 'border-destructive focus:ring-destructive/40' : ''}`}
        {...props}
      />
    </span>
  );
});

/** `%` suffix; value is percent text like "2.90". */
export const PercentInput = forwardRef<HTMLInputElement, Props>(function PercentInput({ className, invalid, ...props }, ref) {
  return (
    <span className={`relative block ${className ?? ''}`}>
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        placeholder="0.00"
        aria-invalid={invalid || undefined}
        className={`${BASE} pr-8 ${invalid ? 'border-destructive focus:ring-destructive/40' : ''}`}
        {...props}
      />
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-semibold text-muted-foreground">
        %
      </span>
    </span>
  );
});

/**
 * Blur formatter: "9" → "9.00", "$1,250.5" → "1250.50". Anything that does
 * not parse is returned untouched so the validation message can point at it.
 */
export function normalizeDollarsInput(value: string): string {
  const parsed = parseDollarsToCents(value);
  return parsed.ok ? (parsed.cents / 100).toFixed(2) : value;
}

/** "2.9" → 290 basis points; up to two decimals of a percent. */
export function parsePercentToBps(input: string): { ok: true; bps: number } | { ok: false; error: string } {
  const trimmed = input.trim().replace(/%$/, '');
  if (!trimmed) return { ok: false, error: 'Enter a percentage.' };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return { ok: false, error: 'Use a percentage with up to two decimals, like 2.90.' };
  const [whole, fraction = ''] = trimmed.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10000) return { ok: false, error: 'Enter a percentage between 0 and 100.' };
  return { ok: true, bps };
}

export function bpsToPercentInput(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '';
  return (bps / 100).toFixed(2);
}
