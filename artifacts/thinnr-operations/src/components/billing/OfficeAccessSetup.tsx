import { useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { ConnectEmbed, ConnectOnboarding } from '@/components/billing/ConnectEmbed';
import { ConnectStartCards } from '@/components/billing/ConnectStart';
import { useOfficeBillingStatus } from '@/hooks/use-billing';
import { BTN_PRIMARY, BTN_SECONDARY, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { BillingApiError } from '@/lib/billing-api';
import type { OfficeAccessInstrument, OfficeAccessSlot, OfficeAccessSnapshot } from '@/lib/billing-types';
import { useOfficeAccessSetup, useOfficeAccessMutations } from '@/hooks/use-office-access';

const STEP_LABELS: Record<string, string> = {
  connect: 'Stripe connection', bank: 'Bank account', card_primary: 'First card',
  card_backup: 'Second card', plan: 'Plan', disclosure: 'Disclosure',
};
const money = (cents: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);
const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(value));

export function OfficeAccessSetup({ management = false }: { management?: boolean }) {
  const query = useOfficeAccessSetup();
  if (query.isPending) return <p role="status" className="py-5 text-sm text-muted-foreground">Loading office payment setup…</p>;
  if (query.isError || !query.data) return <SectionCard title="Office payment setup could not be loaded">
    <div className="space-y-3 p-5"><p role="alert" className="text-sm text-destructive">{query.error instanceof Error ? query.error.message : 'Try again.'}</p>
      <button className={`${BTN_SECONDARY} h-9 px-3`} onClick={() => void query.refetch()}>Try again</button></div>
  </SectionCard>;
  return <OfficeAccessContent snapshot={query.data} refresh={() => void query.refetch()} management={management} />;
}

export function OfficeAccessContent({ snapshot, refresh, management = false }: {
  snapshot: OfficeAccessSnapshot; refresh: () => void; management?: boolean;
}) {
  const writes = useOfficeAccessMutations();
  const done = snapshot.steps.filter((step) => step.status === 'done').length;
  const left = snapshot.steps.filter((step) => step.status !== 'done').map((step) => STEP_LABELS[step.id]).join(', ');
  const instrument = (slot: OfficeAccessSlot) => snapshot.instruments.find((item) => item.slot === slot);
  return <div className="space-y-5" data-testid={management ? 'payment-methods' : 'office-access-setup'}>
    {!management && <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap justify-between gap-2"><b>{done} of {snapshot.steps.length} payment essentials complete</b><span className="text-sm text-muted-foreground">{left ? `Left: ${left}` : 'All complete'}</span></div>
      <progress className="mt-3 h-2 w-full accent-primary" value={done} max={snapshot.steps.length} aria-label="Office access setup progress" />
      <ol className="mt-4 grid gap-2 sm:grid-cols-3">{snapshot.steps.map((step) => <li key={step.id} className="text-xs"><span className={PANEL_LABEL}>{step.status}</span><br /><b>{STEP_LABELS[step.id]}</b>{step.detail && <span className="block text-muted-foreground">{step.detail}</span>}</li>)}</ol>
    </div>}

    {!management && <SectionCard title={`Stripe connection · ${snapshot.steps.find((s) => s.id === 'connect')?.status ?? snapshot.connect.state}`} sub="Stripe securely collects the business and owner information it needs.">
      <div className="p-5">{snapshot.connectAlreadyDone || snapshot.connect.state === 'ready'
        ? <p className="text-sm">Your connected Stripe account is ready.</p>
        : snapshot.connect.state === 'not_started'
          // No account yet: Stripe's embedded tools need one before they can load.
          ? <ConnectStart />
          : <ConnectEmbed components={['account_onboarding']}><ConnectOnboarding onExit={refresh} /></ConnectEmbed>}
        {snapshot.connect.state !== 'not_started' && <button className={`${BTN_SECONDARY} mt-3 h-9 px-3`} onClick={refresh}>Refresh connection status</button>}
      </div>
    </SectionCard>}

    <InstrumentCard title="Bank account" slot="bank" item={instrument('bank')} snapshot={snapshot} refresh={refresh} />
    <InstrumentCard title={management ? 'Primary card' : 'First card'} slot="card_primary" item={instrument('card_primary')} snapshot={snapshot} refresh={refresh} />
    <InstrumentCard title={management ? 'Backup card' : 'Second card'} slot="card_backup" item={instrument('card_backup')} snapshot={snapshot} refresh={refresh} />

    {!management && <SectionCard title={`Plan · ${snapshot.plan.selected ? 'Done' : 'To do'}`} sub={`Choose what happens after the ${snapshot.plan.includedPeriodDays}-day included period ends.`}>
      <div className="space-y-4 p-5 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          {(['monthly', 'yearly'] as const).map((plan) => <button key={plan} type="button" disabled={!snapshot.canChoosePlan || writes.plan.isPending}
            onClick={() => writes.plan.mutate(plan)}
            className={`rounded-md border p-4 text-left ${snapshot.plan.selected === plan ? 'border-primary bg-accent' : 'border-border bg-card'}`}>
            <b className="capitalize">{plan}</b><span className="block">{money(plan === 'monthly' ? snapshot.plan.monthlyPriceCents : snapshot.plan.yearlyPriceCents)} after the included period</span>
          </button>)}
        </div>
        {snapshot.plan.firstChargeAt && <p>First charge: <strong>{date(snapshot.plan.firstChargeAt)}</strong>. Your office price is {money(snapshot.plan.priceCents)}.</p>}
        {!snapshot.canChoosePlan && <p className="text-muted-foreground">Only the practice owner may choose the plan. You can review the current selection.</p>}
        {writes.plan.isError && <InlineError error={writes.plan.error} retry={refresh} />}
      </div>
    </SectionCard>}

    {!management && <SectionCard title={`Disclosure · ${snapshot.disclosure.acknowledgedAt ? 'Done' : 'To do'}`}>
      <div className="space-y-4 p-5 text-sm"><p className="whitespace-pre-wrap">{snapshot.disclosure.text}</p>
        {snapshot.disclosure.acknowledgedAt ? <p>Acknowledged {date(snapshot.disclosure.acknowledgedAt)}.</p>
          : snapshot.canChoosePlan ? <button className={`${BTN_PRIMARY} h-10 px-4`} disabled={writes.disclosure.isPending} onClick={() => writes.disclosure.mutate(snapshot.disclosure.version)}>Acknowledge disclosure</button>
            : <p className="text-muted-foreground">Only the practice owner may acknowledge this disclosure.</p>}
        {writes.disclosure.isError && <InlineError error={writes.disclosure.error} retry={refresh} />}
      </div>
    </SectionCard>}

    {snapshot.balance.outstanding && <SectionCard title="Outstanding balance" sub={`${money(snapshot.balance.amountCents)} is due.`}>
      <div className="space-y-3 p-5"><button className={`${BTN_PRIMARY} h-10 px-4`} disabled={!snapshot.canManage || writes.pay.isPending} onClick={() => writes.pay.mutate()}>{writes.pay.isPending ? 'Paying…' : `Pay ${money(snapshot.balance.amountCents)}`}</button>
        {writes.pay.isError && <InlineError error={writes.pay.error} retry={refresh} />}</div>
    </SectionCard>}
  </div>;
}

function ConnectStart() {
  const status = useOfficeBillingStatus();
  return <ConnectStartCards status={status.data ?? null} />;
}

function InstrumentCard({ title, slot, item, snapshot, refresh }: {
  title: string; slot: OfficeAccessSlot; item?: OfficeAccessInstrument; snapshot: OfficeAccessSnapshot; refresh: () => void;
}) {
  const writes = useOfficeAccessMutations();
  const [intent, setIntent] = useState<{ clientSecret: string; setupIntentId: string; stripe: Promise<Stripe | null> } | null>(null);
  const [error, setError] = useState('');
  const start = async () => {
    setError('');
    try {
      const result = await writes.setupIntent.mutateAsync(slot);
      setIntent({ clientSecret: result.clientSecret, setupIntentId: result.setupIntentId, stripe: loadStripe(result.publishableKey) });
    } catch (failure) { setError(readable(failure)); }
  };
  const pendingBank = slot === 'bank' && snapshot.bank.verificationPending;
  return <SectionCard title={`${title} · ${snapshot.steps.find((s) => s.id === slot)?.status ?? (item ? 'done' : 'todo')}`}>
    <div className="space-y-4 p-5 text-sm">
      {item && <InstrumentDetail item={item} />}
      {slot === 'bank' && snapshot.bank.overdue && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-destructive"><b>Bank verification is overdue.</b><p>This step is blocked until the bank is verified or replaced.</p></div>}
      {pendingBank && !snapshot.bank.overdue && <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
        <b>Bank verification is pending</b>
        <p>You may keep using the dashboard for {snapshot.bank.windowHours} hours{snapshot.bank.deadline ? `, through ${date(snapshot.bank.deadline)}` : ''}.</p>
        {snapshot.bank.verificationUrl && <a className="font-semibold text-primary underline" href={snapshot.bank.verificationUrl} target="_blank" rel="noreferrer">Enter microdeposit amounts securely in Stripe</a>}
        <button className={`${BTN_SECONDARY} ml-3 h-9 px-3`} disabled={writes.bankVerify.isPending} onClick={() => writes.bankVerify.mutate()}>I have entered the amounts</button>
        {writes.bankVerify.isError && <InlineError error={writes.bankVerify.error} retry={refresh} />}
      </div>}
      {!snapshot.canManage ? <p className="text-muted-foreground">This payment method is read-only for your account.</p>
        : !intent ? <button className={`${item ? BTN_SECONDARY : BTN_PRIMARY} h-10 px-4`} onClick={() => void start()} disabled={writes.setupIntent.isPending}>{item ? `Replace ${title.toLowerCase()}` : `Add ${title.toLowerCase()}`}</button>
          : <Elements stripe={intent.stripe} options={{ clientSecret: intent.clientSecret }}>
            <PaymentMethodForm slot={slot} setupIntentId={intent.setupIntentId} onDone={() => { setIntent(null); refresh(); }} onCancel={() => setIntent(null)} />
          </Elements>}
      {error && <p role="alert" className="text-destructive">{error} <button className="underline" onClick={() => void start()}>Try again</button></p>}
    </div>
  </SectionCard>;
}

export function PaymentMethodForm({ slot, setupIntentId, onDone, onCancel }: { slot: OfficeAccessSlot; setupIntentId: string; onDone: () => void; onCancel: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const writes = useOfficeAccessMutations();
  const [error, setError] = useState('');
  const submit = async () => {
    if (!stripe || !elements) return;
    setError('');
    try {
      const result = await stripe.confirmSetup({ elements, redirect: 'if_required' });
      if (result.error) throw new Error(result.error.message || 'Stripe could not confirm this payment method.');
      const method = result.setupIntent?.payment_method;
      const paymentMethodId = typeof method === 'string' ? method : method?.id;
      if (!paymentMethodId) throw new Error('Stripe confirmation is incomplete. Refresh and try again.');
      await writes.instrument.mutateAsync({ slot, paymentMethodId, setupIntentId });
      onDone();
    } catch (failure) {
      setError(failure instanceof BillingApiError && failure.code === 'duplicate_card'
        ? 'This is the same card as the first card. Add a different card for backup.'
        : readable(failure));
    }
  };
  return <div className="space-y-3 rounded-md border border-border p-4"><PaymentElement />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex gap-3"><button className={`${BTN_PRIMARY} h-10 px-4`} disabled={!stripe || writes.instrument.isPending} onClick={() => void submit()}>{writes.instrument.isPending ? 'Saving…' : 'Save payment method'}</button>
      <button className={`${BTN_SECONDARY} h-10 px-4`} onClick={onCancel}>Cancel and restart</button></div>
  </div>;
}

function InstrumentDetail({ item }: { item: OfficeAccessInstrument }) {
  return <div className="rounded-md bg-secondary p-3">
    {item.kind === 'card' ? <p><b>{item.brand || 'Card'} •••• {item.last4}</b>{item.expMonth && item.expYear ? ` · expires ${String(item.expMonth).padStart(2, '0')}/${item.expYear}` : ''}</p>
      : <p><b>{item.bankName || 'Bank account'} •••• {item.last4}</b> · {item.verificationStatus}</p>}
    <p className="text-xs text-muted-foreground">Added {date(item.addedAt)}</p>
  </div>;
}
function readable(error: unknown) { return error instanceof Error ? error.message : 'The request could not be completed. Try again.'; }
function InlineError({ error, retry }: { error: unknown; retry: () => void }) {
  return <p role="alert" className="text-sm text-destructive">{readable(error)} <button className="underline" onClick={retry}>Refresh and try again</button></p>;
}