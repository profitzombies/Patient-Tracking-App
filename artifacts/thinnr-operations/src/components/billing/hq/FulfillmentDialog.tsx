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
import type { OrderDetail } from '@/lib/billing-types';

export function FulfillmentDialog({
  order,
  mode,
  open,
  onOpenChange,
  onConfirm,
  pending,
  error,
}: {
  order: OrderDetail;
  mode: 'ship' | 'cancel';
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(value: { carrier?: string; tracking_number?: string; canceled_reason?: string }): void;
  pending: boolean;
  error?: string | null;
}) {
  const [carrier, setCarrier] = useState('USPS');
  const [tracking, setTracking] = useState('');
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setCarrier('USPS');
      setTracking('');
      setReason('');
      setLocalError(null);
    }
  }, [open]);
  const submit = () => {
    if (mode === 'ship' && !tracking.trim()) return setLocalError('Enter a tracking number.');
    if (mode === 'cancel' && !reason.trim()) return setLocalError('Enter a cancellation reason.');
    onConfirm(mode === 'ship' ? { carrier, tracking_number: tracking.trim() } : { canceled_reason: reason.trim() });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-serif text-navy">
            {mode === 'ship' ? 'Mark order shipped' : 'Cancel order'}
          </DialogTitle>
          <DialogDescription>
            {order.order_number} for {order.payer.name}
          </DialogDescription>
        </DialogHeader>
        {mode === 'ship' ? (
          <>
            <label>
              <span className={PANEL_LABEL}>Carrier</span>
              <select
                data-testid="select-fulfillment-carrier"
                className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
              >
                {['USPS', 'UPS', 'FedEx', 'Other'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              <span className={PANEL_LABEL}>Tracking number</span>
              <input
                data-testid="input-fulfillment-tracking"
                className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
              />
            </label>
          </>
        ) : (
          <label>
            <span className={PANEL_LABEL}>Reason</span>
            <textarea
              data-testid="input-fulfillment-reason"
              className={`${INPUT_CLASS} mt-1 min-h-20 w-full py-2`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}
        {(localError || error) && (
          <p role="alert" className="text-xs text-destructive">
            {localError || error}
          </p>
        )}
        <DialogFooter>
          <button className={`${BTN_SECONDARY} h-8 px-3`} onClick={() => onOpenChange(false)}>
            Back
          </button>
          <button data-testid="button-fulfillment-confirm" disabled={pending} className={`${BTN_PRIMARY} h-9 px-3.5`} onClick={submit}>
            {pending ? 'Saving…' : mode === 'ship' ? 'Mark shipped' : 'Cancel order'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
