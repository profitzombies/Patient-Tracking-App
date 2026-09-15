import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BTN_SECONDARY, INPUT_CLASS, PANEL_LABEL } from '@/components/patient/heritage';
import { formatCents, formatDate } from '@/lib/billing-format';
import type { SubscriptionRow } from '@/lib/billing-types';

export const CONFIRM_WORD = 'CANCEL';

const BTN_DANGER =
  'inline-flex items-center justify-center gap-2 rounded-md bg-destructive text-xs font-semibold text-white shadow-xs transition hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Danger-zone confirmation for ending a subscription. Staff pick WHEN it
 * ends, then must type CANCEL before the destructive button arms. Shared by
 * the office page and HQ so the safeguard cannot drift between the two.
 */
export function CancelSubscriptionDialog({
  row,
  open,
  onOpenChange,
  onConfirm,
  pending,
  error,
  demo = false,
}: {
  row: SubscriptionRow | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(atPeriodEnd: boolean): void;
  pending: boolean;
  error?: string | null;
  demo?: boolean;
}) {
  const [atPeriodEnd, setAtPeriodEnd] = useState(true);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) {
      setAtPeriodEnd(true);
      setTyped('');
    }
  }, [open, row?.id]);
  const armed = typed.trim().toUpperCase() === CONFIRM_WORD && !pending && !demo;
  const periodEnd = row?.current_period_end ? formatDate(row.current_period_end) : null;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onOpenChange(false)}>
      <DialogContent aria-describedby="cancel-subscription-description">
        <DialogHeader>
          <DialogTitle className="font-serif text-navy">Cancel subscription</DialogTitle>
          <DialogDescription id="cancel-subscription-description">
            {row ? (
              <>
                {row.payer.name}&apos;s <b className="text-foreground">{row.product_name}</b> subscription
                ({formatCents(row.unit_price_cents + row.shipping_charge_cents)} every 4 weeks).
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className={PANEL_LABEL}>When should it end?</legend>
          <label className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-3 text-xs ${atPeriodEnd ? 'border-primary bg-accent' : 'border-border'}`}>
            <input
              data-testid="radio-cancel-period-end"
              type="radio"
              name="cancel-timing"
              className="mt-0.5 accent-primary"
              checked={atPeriodEnd}
              onChange={() => setAtPeriodEnd(true)}
            />
            <span>
              <b className="block text-foreground">At the end of the current period</b>
              <span className="text-muted-foreground">
                {periodEnd ? `Stays active through ${periodEnd}, then stops renewing.` : 'Finishes the paid period, then stops renewing.'}
              </span>
            </span>
          </label>
          <label className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-3 text-xs ${!atPeriodEnd ? 'border-primary bg-accent' : 'border-border'}`}>
            <input
              data-testid="radio-cancel-now"
              type="radio"
              name="cancel-timing"
              className="mt-0.5 accent-primary"
              checked={!atPeriodEnd}
              onChange={() => setAtPeriodEnd(false)}
            />
            <span>
              <b className="block text-foreground">Immediately</b>
              <span className="text-muted-foreground">Ends today. The remaining days in the paid period are not refunded automatically.</span>
            </span>
          </label>
        </fieldset>
        <div className="rounded-md border border-destructive/40 bg-[#fff0f0] p-3">
          <p className="text-[10px] font-bold uppercase tracking-[.12em] text-destructive">Danger zone</p>
          <p className="mt-1 text-xs text-foreground">
            This cannot be undone from here. Type <b>{CONFIRM_WORD}</b> to confirm.
          </p>
          <input
            data-testid="input-cancel-confirm"
            className={`${INPUT_CLASS} mt-2 h-9 w-full font-semibold uppercase tracking-[.08em]`}
            value={typed}
            placeholder={CONFIRM_WORD}
            autoComplete="off"
            spellCheck={false}
            aria-label={`Type ${CONFIRM_WORD} to confirm`}
            disabled={demo}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => onOpenChange(false)}>
            Keep subscription
          </button>
          <button
            type="button"
            data-testid="button-cancel-subscription-confirm"
            className={`${BTN_DANGER} h-9 px-3.5`}
            disabled={!armed}
            onClick={() => onConfirm(atPeriodEnd)}
          >
            {pending ? 'Canceling…' : atPeriodEnd ? 'Cancel at period end' : 'Cancel now'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
