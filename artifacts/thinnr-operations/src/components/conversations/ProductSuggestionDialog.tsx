import { useEffect, useState } from 'react';
import { Package } from 'lucide-react';
import { useOfficeSaleContext } from '@/hooks/use-billing';
import type { PublicLinkProduct } from '@/lib/billing-types';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BTN_SECONDARY } from '@/components/patient/heritage';

export type SuggestionPurchase = 'one_time' | 'subscription';
export type SuggestionMode = 'individual' | 'bundle';

export interface SuggestedProductSelection {
  product: PublicLinkProduct;
  purchase: SuggestionPurchase;
  cadenceWeeks: number | null;
  quantity: number;
}

interface ProductSuggestionDialogProps {
  patientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selections: SuggestedProductSelection[];
  mode: SuggestionMode;
  onConfirm: (selections: SuggestedProductSelection[], mode: SuggestionMode) => void;
}

const formatPrice = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export function ProductSuggestionDialog({
  patientId,
  open,
  onOpenChange,
  selections,
  mode,
  onConfirm,
}: ProductSuggestionDialogProps) {
  const saleContext = useOfficeSaleContext(patientId, open);
  const [draft, setDraft] = useState<SuggestedProductSelection[]>(selections);
  const [draftMode, setDraftMode] = useState<SuggestionMode>(mode);

  useEffect(() => {
    if (!open) return;
    setDraft(selections);
    setDraftMode(selections.length > 1 ? mode : 'individual');
  }, [open, selections, mode]);

  const products = saleContext.data?.products ?? [];

  const update = (productId: string, changes: Partial<SuggestedProductSelection>) => {
    setDraft(current => current.map(selection =>
      selection.product.product_id === productId ? { ...selection, ...changes } : selection,
    ));
  };

  const toggle = (product: PublicLinkProduct, checked: boolean) => {
    if (!checked) {
      setDraft(current => current.filter(selection => selection.product.product_id !== product.product_id));
      return;
    }
    setDraft(current => {
      if (current.length >= 8) return current;
      return [...current, {
        product,
        purchase: 'one_time',
        cadenceWeeks: null,
        quantity: 1,
      }];
    });
  };

  const confirm = () => {
    const confirmedMode = draft.length > 1 ? draftMode : 'individual';
    onConfirm(draft, confirmedMode);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl rounded-lg border-card-border bg-card">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-serif text-xl text-navy">
            <Package size={19} className="text-primary" />
            Add product suggestion
          </DialogTitle>
          <DialogDescription>Choose up to eight products available in this patient’s storefront.</DialogDescription>
        </DialogHeader>

        {saleContext.isLoading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading products…</p> : null}
        {saleContext.isError ? <p role="alert" className="rounded-md bg-destructive/5 p-3 text-sm text-destructive">The patient storefront could not be loaded.</p> : null}
        {saleContext.data && !saleContext.data.available ? (
          <p className="rounded-md border border-warn/30 bg-warn/5 p-3 text-xs text-warn">
            This office can't take payments yet, so patients can't check out suggestions.
          </p>
        ) : null}
        {!saleContext.isLoading && !saleContext.isError && products.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No products are currently offered by this office.</p>
        ) : null}

        <div className="divide-y divide-border rounded-lg border border-card-border bg-cream">
          {products.map(product => {
            const selection = draft.find(item => item.product.product_id === product.product_id);
            const subscriptionAvailable = product.subscription_available && product.subscription_unit_price_cents !== null;
            return (
              <div key={product.product_id} className="p-3">
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    aria-label={`Select ${product.name}`}
                    checked={Boolean(selection)}
                    disabled={!selection && draft.length >= 8}
                    onChange={event => toggle(product, event.target.checked)}
                  />
                  {product.image_url ? (
                    <img src={product.image_url} alt="" className="h-12 w-12 rounded-md border border-border object-cover" />
                  ) : (
                    <span className="grid h-12 w-12 place-items-center rounded-md border border-border bg-accent">
                      <Package size={18} className="text-primary" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block font-serif text-sm font-bold text-navy">{product.name}</span>
                    {product.tagline ? <span className="block truncate text-xs text-muted-foreground">{product.tagline}</span> : null}
                  </span>
                  <span className="text-sm font-semibold text-navy">{formatPrice(product.unit_price_cents)}</span>
                </label>

                {selection ? (
                  <div className="ml-7 mt-3 grid gap-3 rounded-md bg-paper-alt p-3 sm:grid-cols-[1fr_150px_90px]">
                    <fieldset className="text-xs">
                      <legend className="mb-1 font-semibold text-navy">Purchase</legend>
                      <label className="mr-3 inline-flex items-center gap-1.5">
                        <input
                          type="radio"
                          name={`purchase-${product.product_id}`}
                          checked={selection.purchase === 'one_time'}
                          onChange={() => update(product.product_id, { purchase: 'one_time', cadenceWeeks: null })}
                        />
                        One-time
                      </label>
                      {subscriptionAvailable ? (
                        <label className="inline-flex items-center gap-1.5">
                          <input
                            type="radio"
                            name={`purchase-${product.product_id}`}
                            checked={selection.purchase === 'subscription'}
                            onChange={() => update(product.product_id, {
                              purchase: 'subscription',
                              cadenceWeeks: product.default_cadence_weeks,
                            })}
                          />
                          Subscribe ({formatPrice(product.subscription_unit_price_cents!)})
                        </label>
                      ) : null}
                    </fieldset>
                    {selection.purchase === 'subscription' ? (
                      <label className="text-xs font-semibold text-navy">
                        Cadence
                        <Select
                          value={String(selection.cadenceWeeks ?? product.default_cadence_weeks)}
                          onValueChange={value => update(product.product_id, { cadenceWeeks: Number(value) })}
                        >
                          <SelectTrigger aria-label={`${product.name} cadence`} className="mt-1 h-8 bg-background text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {product.subscription_cadences_weeks.map(weeks => (
                              <SelectItem key={weeks} value={String(weeks)}>Every {weeks} weeks</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>
                    ) : <span />}
                    <label className="text-xs font-semibold text-navy">
                      Quantity
                      <input
                        aria-label={`${product.name} quantity`}
                        type="number"
                        min={1}
                        max={20}
                        value={selection.quantity}
                        onChange={event => update(product.product_id, {
                          quantity: Math.max(1, Math.min(20, Number(event.target.value) || 1)),
                        })}
                        className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                      />
                    </label>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {draft.length > 1 ? (
          <fieldset className="rounded-lg border border-card-border bg-paper-alt p-3 text-sm">
            <legend className="px-1 font-serif font-bold text-navy">How should the patient receive these?</legend>
            <label className="mt-2 flex items-start gap-2">
              <input type="radio" name="suggestion-mode" checked={draftMode === 'individual'} onChange={() => setDraftMode('individual')} />
              <span><b>Send each individually</b><span className="block text-xs text-muted-foreground">One suggestion card per product</span></span>
            </label>
            <label className="mt-2 flex items-start gap-2">
              <input type="radio" name="suggestion-mode" checked={draftMode === 'bundle'} onChange={() => setDraftMode('bundle')} />
              <span><b>Send as a bundle to checkout</b><span className="block text-xs text-muted-foreground">One card that opens a checkout</span></span>
            </label>
          </fieldset>
        ) : null}

        <DialogFooter>
          <button type="button" className={`${BTN_SECONDARY} h-9 px-4 text-xs`} onClick={() => onOpenChange(false)}>Cancel</button>
          <button
            type="button"
            className="h-9 rounded-md bg-primary px-4 text-xs font-bold text-primary-foreground disabled:opacity-50"
            disabled={draft.length === 0}
            onClick={confirm}
          >
            Attach {draft.length} {draft.length === 1 ? 'product' : 'products'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}