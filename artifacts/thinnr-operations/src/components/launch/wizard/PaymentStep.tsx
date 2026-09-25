import { useState, type ReactNode } from 'react';
import { CardCvcElement, CardExpiryElement, CardNumberElement, Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import type { Stripe } from '@stripe/stripe-js';
import { CreditCard, Landmark, ShieldCheck } from 'lucide-react';
import { BTN_PRIMARY, BTN_SECONDARY, LINK_ACTION } from '@/components/patient/heritage';
import { useOfficeAccessMutations } from '@/hooks/use-office-access';
import { BillingApiError } from '@/lib/billing-api';
import type { OfficeAccessInstrument, OfficeAccessSlot, OfficeAccessSnapshot } from '@/lib/billing-types';
import { THINNR_CARD_STYLE, THINNR_ELEMENTS_APPEARANCE, THINNR_ELEMENTS_FONTS, loadBrandedStripe } from '@/lib/stripe-branding';
import { firstCharge, instrumentFor, longDate, paymentDetailsDone } from './steps';
import { DoneMark, InlineError, StepFrame, WizardFooter, readable } from './ui';

export const DUPLICATE_CARD_MESSAGE = 'This is the same card as the first card. Add a different card for backup.';

function saveError(failure: unknown) {
  return failure instanceof BillingApiError && failure.code === 'duplicate_card' ? DUPLICATE_CARD_MESSAGE : readable(failure);
}

export function PaymentStep({ access, readOnly, onBack, onNext }: {
  access: OfficeAccessSnapshot; readOnly: boolean; onBack: () => void; onNext: () => void;
}) {
  const charge = firstCharge(access);
  const days = access.plan.includedPeriodDays;
  const done = paymentDetailsDone(access);
  const missing = [!instrumentFor(access, 'bank') && 'a bank account', !instrumentFor(access, 'card_primary') && 'a first card',
    !instrumentFor(access, 'card_backup') && 'a backup card'].filter(Boolean) as string[];
  const canManage = !readOnly && access.canManage;
  return <StepFrame testId="wizard-step-payment" eyebrow="Step 5" title="Add your payment details"
    sub="Your THINNR plan is paid from your bank account, with your cards as backups if a bank payment doesn't go through.">
    <Reassurance days={days} at={charge.at} estimated={charge.estimated} />
    <div className="overflow-hidden rounded-lg border border-card-border bg-card shadow-soft">
      <SlotSection slot="bank" icon={<Landmark size={18} aria-hidden="true" />} title="Bank account"
        sub="Log in to your bank for instant confirmation, or type your routing and account numbers instead (Stripe then sends two small test deposits to confirm it)."
        access={access} canManage={canManage} />
      <div className="border-t border-border" />
      <SlotSection slot="card_primary" icon={<CreditCard size={18} aria-hidden="true" />} title="First card"
        sub="Used if a bank payment can't be completed." access={access} canManage={canManage} />
    </div>
    <div className="overflow-hidden rounded-lg border-2 border-dashed border-accent-border bg-card shadow-soft" data-testid="wizard-backup-section">
      <div className="flex items-center gap-2 border-b border-border bg-accent px-5 py-2.5 text-[11px] font-bold uppercase tracking-[.14em] text-primary">
        <ShieldCheck size={14} aria-hidden="true" />Backup card
      </div>
      <SlotSection slot="card_backup" icon={<CreditCard size={18} aria-hidden="true" />} title="Backup card"
        sub="A second, different card we try only if the first card also fails." access={access} canManage={canManage} />
    </div>
    {!canManage && <p className="text-xs text-muted-foreground">Payment details are read-only for your account.</p>}
    <WizardFooter onBack={onBack} onContinue={onNext} canContinue={readOnly || done}
      hint={access.bank.overdue ? 'Verify or replace your bank account to continue.' : missing.length ? `Add ${missing.join(', ').replace(/, ([^,]*)$/, ' and $1')} to continue.` : null} />
  </StepFrame>;
}

function Reassurance({ days, at, estimated }: { days: number; at: string; estimated: boolean }) {
  return <div className="flex items-start gap-3 rounded-lg border border-accent-border bg-accent px-4 py-3.5 text-sm" data-testid="wizard-no-charge">
    <ShieldCheck size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
    <p><span className="font-semibold text-navy">Nothing is charged until your free access ends.</span>{' '}
      <span className="text-muted-foreground">You get {days} {days === 1 ? 'day' : 'days'} free; your first charge {estimated ? 'would be' : 'is'} on {longDate(at)}{estimated ? ' if you activate today' : ''}.</span></p>
  </div>;
}

function SlotSection({ slot, icon, title, sub, access, canManage }: {
  slot: OfficeAccessSlot; icon: ReactNode; title: string; sub: string; access: OfficeAccessSnapshot; canManage: boolean;
}) {
  const writes = useOfficeAccessMutations();
  const item = instrumentFor(access, slot);
  const [intent, setIntent] = useState<{ clientSecret: string; setupIntentId: string; stripe: Promise<Stripe | null> } | null>(null);
  const [error, setError] = useState('');
  const start = async () => {
    setError('');
    try {
      const result = await writes.setupIntent.mutateAsync(slot);
      setIntent({ clientSecret: result.clientSecret, setupIntentId: result.setupIntentId, stripe: loadBrandedStripe(result.publishableKey) });
    } catch (failure) { setError(readable(failure, 'Stripe could not be opened. Try again.')); }
  };
  const finish = () => { setIntent(null); };
  const ready = item && !(slot === 'bank' && access.bank.overdue);
  return <div className="space-y-4 p-5" data-testid={`wizard-slot-${slot}`}>
    <div className="flex items-start gap-3">
      {ready ? <DoneMark size={36} /> : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-primary">{icon}</span>}
      <div className="min-w-0 flex-1"><p className="font-serif text-lg font-bold text-navy">{title}</p><p className="text-xs leading-relaxed text-muted-foreground">{sub}</p></div>
    </div>
    {item && !intent && <InstrumentLine item={item} />}
    {slot === 'bank' && item && <BankVerification access={access} />}
    {intent
      ? slot === 'bank'
        ? <Elements stripe={intent.stripe} options={{ clientSecret: intent.clientSecret, appearance: THINNR_ELEMENTS_APPEARANCE, fonts: THINNR_ELEMENTS_FONTS }}>
          <BankForm setupIntentId={intent.setupIntentId} onDone={finish} onCancel={finish} />
        </Elements>
        : <Elements stripe={intent.stripe} options={{ fonts: THINNR_ELEMENTS_FONTS }}>
          <CardForm slot={slot} clientSecret={intent.clientSecret} setupIntentId={intent.setupIntentId} onDone={finish} onCancel={finish} />
        </Elements>
      : canManage && <button type="button" className={`${item ? BTN_SECONDARY : BTN_PRIMARY} h-10 px-4 text-sm`} data-testid={`wizard-add-${slot}`}
        disabled={writes.setupIntent.isPending} onClick={() => void start()}>
        {writes.setupIntent.isPending && writes.setupIntent.variables === slot ? 'Opening secure form…' : item ? `Replace ${title.toLowerCase()}` : slot === 'bank' ? 'Connect bank account' : `Add ${title.toLowerCase()}`}
      </button>}
    {error && <InlineError message={error} />}
  </div>;
}

function InstrumentLine({ item }: { item: OfficeAccessInstrument }) {
  const brand = item.brand ? item.brand.charAt(0).toUpperCase() + item.brand.slice(1) : 'Card';
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-secondary px-4 py-3 text-sm" data-testid={`wizard-instrument-${item.slot}`}>
    <span className="font-semibold text-navy">{item.kind === 'card' ? brand : item.bankName || 'Bank account'} ending in {item.last4}</span>
    {item.kind === 'card' && item.expMonth && item.expYear && <span className="text-xs text-muted-foreground">Expires {String(item.expMonth).padStart(2, '0')}/{String(item.expYear).slice(-2)}</span>}
    {item.kind === 'bank' && <span className={`text-xs ${item.verificationStatus === 'verified' ? 'text-primary' : item.verificationStatus === 'failed' ? 'text-destructive' : 'text-[#b65c22]'}`}>
      {item.verificationStatus === 'verified' ? 'Verified' : item.verificationStatus === 'failed' ? 'Verification failed' : 'Waiting for test deposits'}</span>}
  </div>;
}

function BankVerification({ access }: { access: OfficeAccessSnapshot }) {
  const writes = useOfficeAccessMutations();
  if (access.bank.overdue) return <InlineError message="Bank verification is overdue. Confirm the test deposits or replace this bank account to continue." />;
  if (!access.bank.verificationPending) return null;
  return <div className="space-y-2 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-4 py-3 text-sm" data-testid="wizard-bank-pending">
    <p className="font-semibold text-[#8a4517]">Watch for two small deposits</p>
    <p className="text-xs text-[#8a4517]">Stripe sends them in 1–2 business days. You can finish setup now and enter the amounts within {access.bank.windowHours} hours{access.bank.deadline ? ` (by ${longDate(access.bank.deadline)})` : ''}.</p>
    <div className="flex flex-wrap items-center gap-3 pt-1">
      {access.bank.verificationUrl && <a className={LINK_ACTION} href={access.bank.verificationUrl} target="_blank" rel="noreferrer">Enter deposit amounts in Stripe</a>}
      <button type="button" className={`${BTN_SECONDARY} h-9 px-3`} disabled={writes.bankVerify.isPending} onClick={() => writes.bankVerify.mutate()}>I've entered the amounts</button>
    </div>
    {writes.bankVerify.isError && <p role="alert" className="text-xs text-destructive">{readable(writes.bankVerify.error)}</p>}
  </div>;
}

function BankForm({ setupIntentId, onDone, onCancel }: { setupIntentId: string; onDone: () => void; onCancel: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const writes = useOfficeAccessMutations();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!stripe || !elements) return;
    setError(''); setBusy(true);
    try {
      const result = await stripe.confirmSetup({ elements, redirect: 'if_required' });
      if (result.error) throw new Error(result.error.message || 'Stripe could not confirm this bank account.');
      const method = result.setupIntent?.payment_method;
      const paymentMethodId = typeof method === 'string' ? method : method?.id;
      if (!paymentMethodId) throw new Error('Stripe confirmation is incomplete. Try again.');
      await writes.instrument.mutateAsync({ slot: 'bank', paymentMethodId, setupIntentId });
      onDone();
    } catch (failure) { setError(saveError(failure)); }
    finally { setBusy(false); }
  };
  return <div className="space-y-4 rounded-md border border-border bg-background p-4" data-testid="wizard-bank-form">
    <PaymentElement options={{ layout: 'tabs' }} />
    {error && <InlineError message={error} />}
    <div className="flex flex-wrap gap-3">
      <button type="button" className={`${BTN_PRIMARY} h-10 px-4 text-sm`} disabled={!stripe || busy} onClick={() => void submit()} data-testid="wizard-save-bank">{busy ? 'Saving…' : 'Save bank account'}</button>
      <button type="button" className={`${BTN_SECONDARY} h-10 px-4 text-sm`} disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}

const CARD_FIELD = 'rounded-md border border-border bg-card px-3 py-3 shadow-xs transition focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/40';

function CardForm({ slot, clientSecret, setupIntentId, onDone, onCancel }: {
  slot: OfficeAccessSlot; clientSecret: string; setupIntentId: string; onDone: () => void; onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const writes = useOfficeAccessMutations();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!stripe || !elements) return;
    const card = elements.getElement(CardNumberElement);
    if (!card) return;
    setError(''); setBusy(true);
    try {
      const result = await stripe.confirmCardSetup(clientSecret, { payment_method: { card } });
      if (result.error) throw new Error(result.error.message || 'Stripe could not confirm this card.');
      const method = result.setupIntent?.payment_method;
      const paymentMethodId = typeof method === 'string' ? method : method?.id;
      if (!paymentMethodId) throw new Error('Stripe confirmation is incomplete. Try again.');
      await writes.instrument.mutateAsync({ slot, paymentMethodId, setupIntentId });
      onDone();
    } catch (failure) { setError(saveError(failure)); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3 rounded-md border border-border bg-background p-4" data-testid={`wizard-card-form-${slot}`}>
    <label className="block text-xs font-semibold text-navy">Card number
      <div className={`${CARD_FIELD} mt-1.5`}><CardNumberElement options={{ style: THINNR_CARD_STYLE, showIcon: true, disableLink: true }} /></div>
    </label>
    <div className="grid grid-cols-2 gap-3">
      <label className="block text-xs font-semibold text-navy">Expiry
        <div className={`${CARD_FIELD} mt-1.5`}><CardExpiryElement options={{ style: THINNR_CARD_STYLE }} /></div>
      </label>
      <label className="block text-xs font-semibold text-navy">Security code
        <div className={`${CARD_FIELD} mt-1.5`}><CardCvcElement options={{ style: THINNR_CARD_STYLE }} /></div>
      </label>
    </div>
    {error && <InlineError message={error} />}
    <div className="flex flex-wrap gap-3 pt-1">
      <button type="button" className={`${BTN_PRIMARY} h-10 px-4 text-sm`} disabled={!stripe || busy} onClick={() => void submit()} data-testid={`wizard-save-${slot}`}>{busy ? 'Saving…' : 'Save card'}</button>
      <button type="button" className={`${BTN_SECONDARY} h-10 px-4 text-sm`} disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}
