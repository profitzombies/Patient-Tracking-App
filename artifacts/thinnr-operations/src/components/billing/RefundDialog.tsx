import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, PANEL_LABEL } from '@/components/patient/heritage';
import { centsToDollarsInput, parseDollarsToCents, formatCents } from '@/lib/billing-format';
import type { OrderDetail } from '@/lib/billing-types';

export function RefundDialog({
  order,
  open,
  onOpenChange,
  onConfirm,
  pending,
  error,
}: {
  order: OrderDetail;
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(amount_cents: number | undefined, reason: string): void;
  pending: boolean;
  error?: string | null;
}) {
  const refunded = order.refunds.reduce((sum, row) => sum + row.amount_cents, 0);
  const remainder = Math.max(0, order.total_cents - refunded);
  const [amount, setAmount] = useState(centsToDollarsInput(remainder));
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setAmount(centsToDollarsInput(remainder));
      setReason('');
      setLocalError(null);
    }
  }, [open, remainder]);
  const submit = () => {
    const parsed = parseDollarsToCents(amount);
    if (!parsed.ok || parsed.cents < 1 || parsed.cents > remainder)
      return setLocalError(parsed.ok ? `Enter no more than ${formatCents(remainder)}.` : parsed.error);
    if (!reason.trim()) return setLocalError('Enter a reason for the refund.');
    onConfirm(parsed.cents === remainder ? undefined : parsed.cents, reason.trim());
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-serif text-navy">Refund {order.order_number}</DialogTitle>
          <DialogDescription>
            THINNR keeps its application fee. Up to {formatCents(remainder)} can be returned.
          </DialogDescription>
        </DialogHeader>
        <label>
          <span className={PANEL_LABEL}>Amount</span>
          <input
            data-testid="input-refund-amount"
            className={`${INPUT_CLASS} mt-1 w-full`}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          <span className={PANEL_LABEL}>Reason</span>
          <textarea
            data-testid="input-refund-reason"
            className={`${INPUT_CLASS} mt-1 min-h-20 w-full`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {(localError || error) && (
          <p role="alert" className="text-xs text-destructive">
            {localError || error}
          </p>
        )}
        <DialogFooter>
          <button className={BTN_SECONDARY} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button data-testid="button-refund-confirm" disabled={pending} className={BTN_PRIMARY} onClick={submit}>
            {pending ? 'Refunding…' : 'Issue refund'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
