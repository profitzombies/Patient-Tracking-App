import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, PANEL_LABEL } from '@/components/patient/heritage';
import { MoneyInput, normalizeDollarsInput } from '@/components/billing/MoneyInput';
import { centsToDollarsInput, parseDollarsToCents, formatCents } from '@/lib/billing-format';
import type { OrderDetail } from '@/lib/billing-types';

type Preset = 'remaining' | 'product' | 'product_shipping' | 'custom';

/**
 * Preset refund amounts, each capped at what is still refundable. Presets that
 * would duplicate another (no shipping charged, product already equals the
 * remainder) are dropped so the list never shows two rows with one amount.
 */
export function refundPresets(order: OrderDetail, remainder: number): Array<{ id: Preset; label: string; cents: number | null }> {
  const product = Math.min(order.fees.subtotal_cents, remainder);
  const productShipping = Math.min(order.fees.subtotal_cents + order.fees.shipping_charge_cents, remainder);
  const rows: Array<{ id: Preset; label: string; cents: number | null }> = [
    { id: 'remaining', label: `Everything remaining · ${formatCents(remainder)}`, cents: remainder },
  ];
  if (product > 0 && product < remainder) rows.push({ id: 'product', label: `Product only · ${formatCents(product)}`, cents: product });
  if (order.fees.shipping_charge_cents > 0 && productShipping > product && productShipping < remainder)
    rows.push({ id: 'product_shipping', label: `Product + shipping · ${formatCents(productShipping)}`, cents: productShipping });
  rows.push({ id: 'custom', label: 'Custom amount', cents: null });
  return rows;
}

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
  onConfirm(amount_cents: number, reason: string): void;
  pending: boolean;
  error?: string | null;
}) {
  // Mirror the server: failed and canceled refunds never left the order.
  const refunded = order.refunds
    .filter((row) => row.status !== 'failed' && row.status !== 'canceled')
    .reduce((sum, row) => sum + row.amount_cents, 0);
  const remainder = Math.max(0, order.total_cents - refunded);
  const presets = useMemo(() => refundPresets(order, remainder), [order, remainder]);
  const [preset, setPreset] = useState<Preset>('remaining');
  const [amount, setAmount] = useState(centsToDollarsInput(remainder));
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPreset('remaining');
      setAmount(centsToDollarsInput(remainder));
      setReason('');
      setAcknowledged(false);
      setLocalError(null);
    }
  }, [open, remainder]);

  const parsed = parseDollarsToCents(amount);
  const overMax = parsed.ok && parsed.cents > remainder;
  const amountCents = parsed.ok && !overMax && parsed.cents >= 1 ? parsed.cents : null;
  // The acknowledgement gates the button itself; amount and reason problems
  // are explained on click so a disabled button never leaves staff guessing.
  const canSubmit = acknowledged && !pending;

  const choosePreset = (next: Preset) => {
    setPreset(next);
    setLocalError(null);
    const row = presets.find((item) => item.id === next);
    if (row?.cents != null) setAmount(centsToDollarsInput(row.cents));
  };
  const submit = () => {
    if (!parsed.ok) return setLocalError(parsed.error);
    if (parsed.cents < 1) return setLocalError('Enter an amount of at least $0.01.');
    if (overMax) return setLocalError(`Enter no more than ${formatCents(remainder)}.`);
    if (!reason.trim()) return setLocalError('Enter a reason for the refund.');
    if (!acknowledged) return setLocalError('Check the box to confirm you understand the refund is final.');
    // Always send the exact acknowledged amount; never let the server pick.
    onConfirm(parsed.cents, reason.trim());
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-serif text-navy">Refund {order.order_number}</DialogTitle>
          <DialogDescription>
            THINNR keeps its application fee. Up to {formatCents(remainder)} can be returned to {order.payer.name}.
          </DialogDescription>
        </DialogHeader>
        <label className="block">
          <span className={PANEL_LABEL}>Refund</span>
          <select
            data-testid="select-refund-preset"
            className={`${INPUT_CLASS} mt-1 h-9 w-full`}
            value={preset}
            onChange={(e) => choosePreset(e.target.value as Preset)}
          >
            {presets.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={PANEL_LABEL}>Amount</span>
          <MoneyInput
            data-testid="input-refund-amount"
            className="mt-1"
            value={amount}
            invalid={overMax || (!parsed.ok && amount.trim().length > 0)}
            onChange={(e) => {
              setAmount(e.target.value);
              setPreset('custom');
              setLocalError(null);
            }}
            onBlur={() => setAmount((current) => normalizeDollarsInput(current))}
          />
        </label>
        {overMax && (
          <p
            role="alert"
            data-testid="refund-over-max"
            className="rounded-md border border-destructive/40 bg-[#fff0f0] px-3 py-2 text-xs font-semibold text-destructive"
          >
            That is more than the {formatCents(remainder)} left on this order. Enter {formatCents(remainder)} or less.
          </p>
        )}
        <label className="block">
          <span className={PANEL_LABEL}>Reason</span>
          <textarea
            data-testid="input-refund-reason"
            className={`${INPUT_CLASS} mt-1 min-h-20 w-full py-2`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <label className="flex items-start gap-2.5 rounded-md border border-border bg-secondary/60 p-3 text-xs leading-relaxed">
          <input
            data-testid="checkbox-refund-acknowledge"
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            checked={acknowledged}
            onChange={(e) => {
              setAcknowledged(e.target.checked);
              setLocalError(null);
            }}
          />
          <span>
            By checking this box, I understand this refund is final and cannot be undone. {order.payer.name} will receive{' '}
            {amountCents !== null ? formatCents(amountCents) : 'the amount above'} back on their original payment method, and
            THINNR&apos;s application fee on this order is not returned.
          </span>
        </label>
        {(localError || error) && (
          <p role="alert" className="text-xs text-destructive">
            {localError || error}
          </p>
        )}
        <DialogFooter>
          <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="button-refund-confirm"
            disabled={!canSubmit}
            className={`${BTN_PRIMARY} h-9 px-3.5 disabled:cursor-not-allowed disabled:opacity-50`}
            onClick={submit}
          >
            {pending ? 'Refunding…' : 'Issue refund'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
