import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { type Stripe } from '@stripe/stripe-js';
import { loadBrandedStripe } from '@/lib/stripe-branding';
import { ConnectEmbed, ConnectOnboarding } from '@/components/billing/ConnectEmbed';
import { ConnectStartCards } from '@/components/billing/ConnectStart';
import { useOfficeBillingStatus } from '@/hooks/use-billing';
import { BTN_PRIMARY, BTN_SECONDARY, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { BillingApiError } from '@/lib/billing-api';
import type { OfficeAccessInstrument, OfficeAccessSlot, OfficeAccessSnapshot } from '@/lib/billing-types';
import { useOfficeAccessSetup, useOfficeAccessMutations } from '@/hooks/use-office-access';
import { BusyLabel } from '@/components/ui/busy-label';
import { setupSectionId } from '@/lib/setup-checklist';
import { HolderDetailsFields, holderBillingDetails, holderProblem, useHolderDetails } from '@/components/billing/HolderDetails';

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

    {management && <p className="rounded-md border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground" data-testid="payment-methods-replace-only">
      Your office always keeps one bank account and two different cards on file. You can replace any of them; a replaced method is removed from Stripe once its replacement is saved.
    </p>}
    <InstrumentCard title="Bank account" slot="bank" item={instrument('bank')} snapshot={snapshot} refresh={refresh} management={management} />
    <InstrumentCard title={management ? 'Primary card' : 'First card'} slot="card_primary" item={instrument('card_primary')} snapshot={snapshot} refresh={refresh} management={management} />
    <InstrumentCard title={management ? 'Backup card' : 'Second card'} slot="card_backup" item={instrument('card_backup')} snapshot={snapshot} refresh={refresh} management={management} />

    {!management && <div id={setupSectionId('plan')} className="scroll-mt-6"><SectionCard title={`Plan · ${snapshot.plan.selected ? 'Done' : 'To do'}`} sub={`Choose what happens after the ${snapshot.plan.includedPeriodDays}-day included period ends.`}>
      <div className="space-y-4 p-5 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          {/* The choice shows the moment it is clicked; a refused save puts the old one back. */}
          {(['monthly', 'yearly'] as const).map((plan) => <button key={plan} type="button" disabled={!snapshot.canChoosePlan || writes.plan.isPending}
            aria-pressed={snapshot.plan.selected === plan} data-testid={`access-plan-${plan}`}
            onClick={() => writes.choosePlan(plan)}
            className={`rounded-md border p-4 text-left ${snapshot.plan.selected === plan ? 'border-primary bg-accent' : 'border-border bg-card'}`}>
            <b className="capitalize"><BusyLabel busy={writes.plan.isPending && writes.plan.variables === plan} label={plan} /></b><span className="block">{money(plan === 'monthly' ? snapshot.plan.monthlyPriceCents : snapshot.plan.yearlyPriceCents)} after the included period</span>
          </button>)}
        </div>
        {snapshot.plan.firstChargeAt && <p>First charge: <strong>{date(snapshot.plan.firstChargeAt)}</strong>. Your office price is {money(snapshot.plan.priceCents)}.</p>}
        {!snapshot.canChoosePlan && <p className="text-muted-foreground">Only the practice owner may choose the plan. You can review the current selection.</p>}
        {writes.plan.isError && <InlineError prefix="Your plan choice was not saved." error={writes.plan.error} retry={refresh} />}
      </div>
    </SectionCard></div>}

    {!management && <div id={setupSectionId('disclosure')} className="scroll-mt-6"><SectionCard title={`${snapshot.disclosure.kind === 'software' ? 'Software agreement' : 'Disclosure'} · ${snapshot.disclosure.acknowledgedAt ? 'Done' : 'To do'}`}>
      <div className="space-y-4 p-5 text-sm"><p className="whitespace-pre-wrap">{snapshot.disclosure.text}</p>
        {snapshot.disclosure.acknowledgedAt
          ? <p className="flex flex-wrap items-center gap-2 font-semibold text-emerald-700" data-testid="access-disclosure-acknowledged">
            <Check size={16} aria-hidden="true" />Acknowledged {date(snapshot.disclosure.acknowledgedAt)}.
            {writes.disclosure.isPending && <span className="font-normal text-muted-foreground"><BusyLabel busy label="" busyLabel="Saving…" /></span>}
          </p>
          : snapshot.canChoosePlan ? <button className={`${BTN_PRIMARY} h-10 px-4`} disabled={writes.disclosure.isPending} onClick={() => writes.acknowledge(snapshot.disclosure.version)}>{snapshot.disclosure.kind === 'software' ? 'Accept the software agreement' : 'Acknowledge disclosure'}</button>
            : <p className="text-muted-foreground">Only the practice owner may {snapshot.disclosure.kind === 'software' ? 'accept this agreement' : 'acknowledge this disclosure'}.</p>}
        {writes.disclosure.isError && <InlineError prefix="Your acceptance was not saved." error={writes.disclosure.error} retry={refresh} />}
      </div>
    </SectionCard></div>}

    {snapshot.balance.outstanding && <SectionCard title="Outstanding balance" sub={`${money(snapshot.balance.amountCents)} is due.`}>
      <div className="space-y-3 p-5"><button className={`${BTN_PRIMARY} h-10 px-4`} disabled={!snapshot.canManage || writes.pay.isPending} onClick={() => writes.payBalance()}><BusyLabel busy={writes.pay.isPending} busyLabel="Paying…" label={`Pay ${money(snapshot.balance.amountCents)}`} /></button>
        {writes.pay.isError && <InlineError error={writes.pay.error} retry={refresh} />}</div>
    </SectionCard>}
  </div>;
}

function ConnectStart() {
  const status = useOfficeBillingStatus();
  return <ConnectStartCards status={status.data ?? null} />;
}

type OpenIntent = { clientSecret: string; setupIntentId: string; stripe: Promise<Stripe | null>; billingDetails: { name: string | null; email: string | null } | null };

function InstrumentCard({ title, slot, item, snapshot, refresh, management = false }: {
  title: string; slot: OfficeAccessSlot; item?: OfficeAccessInstrument; snapshot: OfficeAccessSnapshot; refresh: () => void; management?: boolean;
}) {
  const writes = useOfficeAccessMutations();
  const [intent, setIntent] = useState<OpenIntent | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const opening = useRef(false);
  const start = async () => {
    if (opening.current) return;
    opening.current = true;
    setError(''); setSaved('');
    try {
      const result = await writes.setupIntent.mutateAsync(slot);
      setIntent({ clientSecret: result.clientSecret, setupIntentId: result.setupIntentId, stripe: loadBrandedStripe(result.publishableKey), billingDetails: result.billingDetails ?? null });
    } catch (failure) { setError(readable(failure)); }
    finally { opening.current = false; }
  };
  const replacement = slot === 'bank' ? snapshot.bank.replacement ?? null : null;
  // A staged replacement is what the office is verifying; the bank in service is not pending.
  const pendingBank = slot === 'bank' && snapshot.bank.verificationPending && !replacement;
  return <div id={setupSectionId(slot)} className="scroll-mt-6"><SectionCard title={`${title} · ${snapshot.steps.find((s) => s.id === slot)?.status ?? (item ? 'done' : 'todo')}`}>
    <div className="space-y-4 p-5 text-sm">
      {item && <InstrumentDetail item={item} />}
      {replacement && <div className="rounded-md border border-amber-300 bg-amber-50 p-4" data-testid="bank-replacement-pending">
        <b>Replacement bank waiting on test deposits</b>
        <p className="mt-1">{replacement.bankName || 'Bank account'} •••• {replacement.last4}{replacement.holderName ? ` · ${replacement.holderName}` : ''}</p>
        <p className="mt-1">Your current bank stays on file and is still charged until the new one is verified{replacement.deadline ? ` (by ${date(replacement.deadline)})` : ''}. It then takes over automatically. If verification fails or runs out of time, your current bank stays in place.</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {replacement.verificationUrl && <a className="font-semibold text-primary underline" href={replacement.verificationUrl} target="_blank" rel="noreferrer">Enter microdeposit amounts securely in Stripe</a>}
          <button className={`${BTN_SECONDARY} h-9 px-3`} disabled={writes.bankVerify.isPending} onClick={() => writes.verifyBank()}><BusyLabel busy={writes.bankVerify.isPending} busyLabel="Checking…" label="I have entered the amounts" /></button>
        </div>
        {writes.bankVerify.isError && <InlineError error={writes.bankVerify.error} retry={refresh} />}
      </div>}
      {saved && <p role="status" className="flex items-center gap-2 text-primary" data-testid={`replaced-${slot}`}><Check size={16} aria-hidden="true" />{saved}</p>}
      {slot === 'bank' && snapshot.bank.overdue && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-destructive"><b>Bank verification is overdue.</b><p>This step is blocked until the bank is verified or replaced.</p></div>}
      {pendingBank && !snapshot.bank.overdue && <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
        <b>Bank verification is pending</b>
        <p>You may keep using the dashboard for {snapshot.bank.windowHours} hours{snapshot.bank.deadline ? `, through ${date(snapshot.bank.deadline)}` : ''}.</p>
        {snapshot.bank.verificationUrl && <a className="font-semibold text-primary underline" href={snapshot.bank.verificationUrl} target="_blank" rel="noreferrer">Enter microdeposit amounts securely in Stripe</a>}
        <button className={`${BTN_SECONDARY} ml-3 h-9 px-3`} disabled={writes.bankVerify.isPending} onClick={() => writes.verifyBank()}><BusyLabel busy={writes.bankVerify.isPending} busyLabel="Checking…" label="I have entered the amounts" /></button>
        {writes.bankVerify.isError && <InlineError error={writes.bankVerify.error} retry={refresh} />}
      </div>}
      {!snapshot.canManage ? <p className="text-muted-foreground">This payment method is read-only for your account.</p>
        : !intent ? <button className={`${item ? BTN_SECONDARY : BTN_PRIMARY} h-10 px-4`} onClick={() => void start()} disabled={writes.setupIntent.isPending}><BusyLabel busy={writes.setupIntent.isPending} busyLabel="Opening secure form…" label={item ? `Replace ${title.toLowerCase()}` : `Add ${title.toLowerCase()}`} /></button>
          : <Elements stripe={intent.stripe} options={{ clientSecret: intent.clientSecret }}>
            <PaymentMethodForm slot={slot} setupIntentId={intent.setupIntentId} billingDefaults={intent.billingDetails}
              replacing={Boolean(item)} management={management}
              onDone={(staged) => { setIntent(null); if (item) setSaved(staged
                ? 'New bank saved. It takes over once its test deposits are confirmed; your current bank stays on file until then.'
                : `${title} replaced. The old one has been removed from your office's Stripe account.`); }}
              onCancel={() => setIntent(null)} />
          </Elements>}
      {error && <p role="alert" className="text-destructive">{error} <button className="underline" onClick={() => void start()}>Try again</button></p>}
    </div>
  </SectionCard></div>;
}

export function PaymentMethodForm({ slot, setupIntentId, billingDefaults, replacing = false, management = false, onDone, onCancel }: {
  slot: OfficeAccessSlot; setupIntentId: string; billingDefaults?: { name: string | null; email: string | null } | null;
  replacing?: boolean; management?: boolean;
  /** `staged` is true when a replacement bank waits on deposits beside the bank in service. */
  onDone: (staged: boolean) => void; onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const writes = useOfficeAccessMutations();
  const kind = slot === 'bank' ? 'bank' : 'card';
  const [holder, setHolder] = useHolderDetails(billingDefaults);
  const [error, setError] = useState('');
  // Busy from the click (Stripe's confirmation included), not only while our
  // own save runs, and a second press is dropped rather than confirming twice.
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const submit = async () => {
    if (!stripe || !elements || lock.current) return;
    const problem = holderProblem(holder, kind);
    if (problem) { setError(problem); return; }
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await stripe.confirmSetup({
        elements, redirect: 'if_required',
        confirmParams: { payment_method_data: { billing_details: holderBillingDetails(holder) } },
      });
      if (result.error) throw new Error(result.error.message || 'Stripe could not confirm this payment method.');
      const method = result.setupIntent?.payment_method;
      const paymentMethodId = typeof method === 'string' ? method : method?.id;
      if (!paymentMethodId) throw new Error('Stripe confirmation is incomplete. Refresh and try again.');
      const answer = await writes.instrument.mutateAsync({ slot, paymentMethodId, setupIntentId });
      onDone(Boolean(answerSnapshot(answer)?.bank.replacement) && slot === 'bank');
    } catch (failure) {
      setError(failure instanceof BillingApiError && failure.code === 'duplicate_card'
        ? slot === 'card_primary'
          ? 'This is the same card as your backup card. Use a different card.'
          : 'This is the same card as the first card. Add a different card for backup.'
        : readable(failure));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return <div className="space-y-3 rounded-md border border-border p-4">
    <HolderDetailsFields kind={kind} details={holder} onChange={setHolder} disabled={busy} idPrefix={`access-${slot}`} />
    {/* The holder name and email come from the fields above, not Stripe's own inputs. */}
    <PaymentElement options={{ fields: { billingDetails: { name: 'never', email: 'never' } } }} />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex gap-3"><button className={`${BTN_PRIMARY} h-10 px-4`} disabled={!stripe || busy} onClick={() => void submit()}><BusyLabel busy={busy} label={replacing ? `Save replacement ${kind === 'bank' ? 'bank account' : 'card'}` : 'Save payment method'} /></button>
      <button className={`${BTN_SECONDARY} h-10 px-4`} disabled={busy} onClick={onCancel}>{management || replacing ? 'Cancel' : 'Cancel and restart'}</button></div>
    {replacing && <p className="text-xs text-muted-foreground">{kind === 'bank'
      ? 'Your current bank stays on file until this one is saved (and, if it needs test deposits, until they are confirmed).'
      : 'Your current card stays on file until this one is saved.'}</p>}
  </div>;
}

/** The access snapshot an instrument save answered with, if any. */
function answerSnapshot(data: unknown): OfficeAccessSnapshot | null {
  if (!data || typeof data !== 'object') return null;
  if ('setup' in data) return (data as { setup: OfficeAccessSnapshot | null }).setup ?? null;
  return 'steps' in data ? data as OfficeAccessSnapshot : null;
}

function InstrumentDetail({ item }: { item: OfficeAccessInstrument }) {
  return <div className="rounded-md bg-secondary p-3" data-testid={`instrument-${item.slot}`}>
    {item.kind === 'card' ? <p><b>{item.brand || 'Card'} •••• {item.last4}</b>{item.expMonth && item.expYear ? ` · expires ${String(item.expMonth).padStart(2, '0')}/${item.expYear}` : ''}</p>
      : <p><b>{item.bankName || 'Bank account'} •••• {item.last4}</b> · {item.verificationStatus}</p>}
    {item.holderName && <p className="text-xs">Name on {item.kind === 'bank' ? 'account' : 'card'}: <span className="font-semibold">{item.holderName}</span></p>}
    <p className="text-xs text-muted-foreground">Added {date(item.addedAt)}</p>
  </div>;
}
function readable(error: unknown) { return error instanceof Error ? error.message : 'The request could not be completed. Try again.'; }
function InlineError({ error, retry, prefix }: { error: unknown; retry: () => void; prefix?: string }) {
  return <p role="alert" className="text-sm text-destructive">{prefix ? `${prefix} ` : ''}{readable(error)} <button className="underline" onClick={retry}>Refresh and try again</button></p>;
}