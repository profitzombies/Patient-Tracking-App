import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useLaunchWrite, type LaunchState } from '@/hooks/use-launch';
import { SectionCard, BTN_PRIMARY, BTN_SECONDARY, PANEL_LABEL, INPUT_CLASS } from '@/components/patient/heritage';
import { parseDollarsToCents, formatCents } from '@/lib/billing-format';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { officeRequest } from '@/lib/office-api';
import { useSession } from '@/contexts/session';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { OfficeAccessSetup } from '@/components/billing/OfficeAccessSetup';
import { useToast } from '@/hooks/use-toast';

const labels: Record<keyof LaunchState['details'], string> = {
  officeName: 'Practice name', providerName: 'Provider name', email: 'Contact email', phone: 'Office phone',
  address1: 'Address 1', address2: 'Address 2 (optional)', city: 'City', state: 'US state', postalCode: 'ZIP code',
};
export const paymentLabels = { not_started: 'Not started', action_required: 'Action required', pending: 'Submitted — Stripe verification pending', ready: 'Ready' };

/**
 * Stripe's OAuth callback returns owners to /payments/get-paid?connected=1
 * (or ?error=…). While practice setup is unfinished that path renders this
 * screen instead, so announce the result here, refresh the setup state, and
 * drop the one-shot query so a reload does not repeat it.
 */
function useStripeReturnNotice(): string | null {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const { toast } = useToast();
  const client = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(search);
    const connected = params.get('connected') === '1';
    const error = params.get('error');
    if (!connected && !error) return;
    if (connected) toast({ variant: 'success', title: 'Stripe account connected' });
    setFailure(error ? error : null);
    void client.invalidateQueries({ predicate: (query) =>
      query.queryKey[0] === 'office' || (query.queryKey[0] === 'billing' && query.queryKey[1] === 'office') });
    params.delete('connected');
    params.delete('error');
    const rest = params.toString();
    navigate(rest ? `${location}?${rest}` : location, { replace: true });
    // Runs once per arrival; the navigation above clears the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  return failure;
}

export function LaunchScreen({ launchData }: { launchData: LaunchState }) {
  const complete = useLaunchWrite('complete');
  const { staffSession } = useSession();
  const [error, setError] = useState('');
  const [restartOpen, setRestartOpen] = useState(false);
  const client = useQueryClient();
  const stripeReturn = useStripeReturnNotice();
  const { fullSetupRequired } = launchData;
  const ready = fullSetupRequired
    ? launchData.detailsConfirmed && launchData.productsConfirmed && launchData.security.ready && launchData.payments.state === 'ready'
    : launchData.security.ready && launchData.payments.state === 'ready';

  const finish = async () => {
    setError('');
    try {
      await complete.save({ expectedVersion: launchData.version }, launchData.billingScope);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not finish setup.'); }
  };

  const restart = useMutation({
    mutationFn: () => officeRequest('/api/billing/office/connect/restart', { unconfigured: '', signedOut: '', unreachable: 'Could not reach server.', failed: 'Could not restart Stripe setup.' }, {
      method: 'POST', body: '{}', headers: { 'X-Billing-Scope': launchData.billingScope }
    }),
    onSuccess: () => {
      setRestartOpen(false);
      void client.invalidateQueries({ predicate: (query) =>
        query.queryKey[0] === 'office' ||
        (query.queryKey[0] === 'billing' && query.queryKey[1] === 'office') });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Could not restart Stripe setup.');
      setRestartOpen(false);
    }
  });

  const count = fullSetupRequired
    ? [launchData.detailsConfirmed, launchData.security.ready, launchData.payments.state === 'ready', launchData.productsConfirmed].filter(Boolean).length
    : [launchData.security.ready, launchData.payments.state === 'ready'].filter(Boolean).length;
  const total = fullSetupRequired ? 4 : 2;

  const isOwner = staffSession?.staffKind === 'provider';
  const canRestart = isOwner && launchData.payments.state !== 'not_started' && launchData.payments.state !== 'ready';

  return <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 sm:px-6" data-testid="practice-launch">
    <header><p className={PANEL_LABEL}>Practice launch · {launchData.payments.sandbox ? 'Test payments' : 'Live payments'}</p>
      <h1 className="mt-2 font-serif text-2xl font-bold text-navy">Welcome to {launchData.office.officeName}</h1>
      <p className="mt-2 text-sm text-muted-foreground">A few essentials to get started. Confirmed steps are saved to your practice so you can return on any device.</p></header>
    <div className="rounded-lg border border-border bg-card p-5"><p className="text-sm font-semibold">{count} of {total} essentials confirmed</p><progress className="mt-3 h-2 w-full accent-primary" value={count} max={total} aria-label="Practice setup progress" /></div>
    {!launchData.canEdit && <SectionCard title="Your practice owner completes setup"><div className="space-y-3 p-5 text-sm"><p>These settings affect the whole practice. Ask your owner to confirm the remaining essentials. HQ inspection is read-only; you cannot accept terms or confirm owner setup.</p></div></SectionCard>}
    {fullSetupRequired && <SectionCard title={`1. Practice details${launchData.detailsConfirmed ? ' · Confirmed' : ''}`} sub="Review your existing contact information. No new signup is needed.">
      <DetailsForm launchData={launchData} />
    </SectionCard>}
    <SectionCard title={`${fullSetupRequired ? '2' : '1'}. Account security · ${launchData.security.ready ? 'Ready' : 'Action required'}`} sub="Your existing email verification and required second-factor policy apply.">
      <div className="p-5"><Link href="/security" className={`${BTN_SECONDARY} h-10 px-4`}>Review account security</Link></div>
    </SectionCard>
    <SectionCard title={`${fullSetupRequired ? '3' : '2'}. Connect payments · ${paymentLabels[launchData.payments.state]}`} sub="Stripe securely collects business, owner and bank details.">
      <div className="space-y-3 p-5 text-sm">
        <p>{launchData.payments.sandbox ? 'This is Test mode. Test readiness does not confirm Live readiness.' : 'This is Live mode. Review your real business information carefully.'}</p>
        {launchData.payments.state === 'pending' && <p>Currently actionable steps are submitted, but Stripe is still verifying your account. <strong className="font-semibold text-navy">Your account remains gated</strong> — you cannot charge patients or use operational features until payments are ready.</p>}
        {launchData.canEdit && <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={`${BTN_PRIMARY} h-10 px-4`} onClick={() => document.querySelector('[data-testid="office-access-setup"]')?.scrollIntoView({ behavior: 'smooth' })}>{launchData.payments.state === 'not_started' ? 'Connect payments below' : 'Review Stripe setup below'}</button>
          {canRestart && <button type="button" className={`${BTN_SECONDARY} h-10 px-4`} onClick={() => setRestartOpen(true)}>Restart Stripe setup</button>}
        </div>}
        <p className="text-muted-foreground">Return to Practice setup after completing Stripe’s steps. Use Refresh status there to check the latest requirements.</p>
      </div>
    </SectionCard>
    {fullSetupRequired && <SectionCard title={`4. Products and pricing${launchData.productsConfirmed ? ' · Confirmed' : ''}`} sub="Choose the products patients can buy and review every price.">
      <ProductsForm launchData={launchData} />
    </SectionCard>}
    {stripeReturn && <p role="alert" data-testid="stripe-return-error" className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">Stripe connection was not completed: {stripeReturn} Try again below.</p>}
    <OfficeAccessSetup />
    {error && <p role="alert" className="text-sm text-destructive">{error} Refresh the setup status before retrying if another session changed it. For blocked restarts, please <Link href="/ai-support" className="underline">contact THINNR support</Link>.</p>}
    <footer className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
      {launchData.canEdit && <button className={`${BTN_PRIMARY} h-10 px-4`} disabled={!ready || complete.isPending} onClick={() => void finish()}>{complete.isPending ? 'Saving…' : launchData.completedAt ? 'Setup complete' : 'Finish setup'}</button>}
      <p className="text-sm text-muted-foreground">Invitations and training are optional.</p>
    </footer>

    {canRestart && (
      <Dialog open={restartOpen} onOpenChange={setRestartOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Restart Stripe setup?</DialogTitle>
            <DialogDescription>
              This will detach the current unfinished connection and allow you to link a different existing Stripe account or start fresh. The local archive and remote Stripe account remain untouched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <button
              type="button"
              className={`${BTN_SECONDARY} h-9 px-3.5`}
              onClick={() => setRestartOpen(false)}
              disabled={restart.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${BTN_PRIMARY} h-9 px-4`}
              onClick={() => restart.mutate()}
              disabled={restart.isPending}
            >
              {restart.isPending ? 'Restarting…' : 'Restart setup'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )}
  </div>;
}

function DetailsForm({ launchData }: { launchData: LaunchState }) {
  const [details, setDetails] = useState({ ...launchData.details });
  const baseline = useRef(launchData.version);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const write = useLaunchWrite('details');
  useEffect(() => {
    if (!dirty) { setDetails({ ...launchData.details }); baseline.current = launchData.version; }
  }, [launchData, dirty]);
  return <form className="space-y-4 p-5" onSubmit={async (event) => {
    event.preventDefault(); setError('');
    try {
      const result = await write.save({ expectedVersion: baseline.current, details });
      if (result) { baseline.current = result.version; setDirty(false); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Details could not be saved.'); }
  }}>
    <fieldset disabled={!launchData.canEdit || write.isPending} className="grid gap-4 sm:grid-cols-2">
      {(Object.keys(labels) as Array<keyof typeof labels>).map((key) => <label key={key} className="block text-sm font-semibold">{labels[key]}
        <input className={`${INPUT_CLASS} mt-1 h-10 w-full px-3`} value={details[key]} required={key !== 'address2'}
          type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'}
          maxLength={key === 'state' ? 40 : key === 'postalCode' ? 10 : 320}
          onChange={(event) => { setDirty(true); setDetails({ ...details, [key]: event.target.value }); }} />
      </label>)}
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {dirty && launchData.version !== baseline.current && <p role="alert" className="text-sm text-destructive">Setup changed while you were editing. Discard your draft to review the latest details.</p>}
    {dirty && <button type="button" className={`${BTN_SECONDARY} mr-3 h-10 px-4`} onClick={() => { setDirty(false); setError(''); }}>Discard draft</button>}
    {launchData.canEdit && <button className={`${BTN_PRIMARY} h-10 px-4`} disabled={write.isPending}>{write.isPending ? 'Saving…' : 'Confirm practice details'}</button>}
  </form>;
}

function ProductsForm({ launchData }: { launchData: LaunchState }) {
  const [custom, setCustom] = useState(false);
  const [products, setProducts] = useState(() => launchData.products.map((p) => ({ ...p, dollars: ((p.sellPriceCents ?? p.suggestedPriceCents) / 100).toFixed(2) })));
  const baseline = useRef({ version: launchData.version, billingScope: launchData.billingScope });
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const write = useLaunchWrite('products');
  useEffect(() => {
    if (!dirty) {
      setProducts(launchData.products.map((p) => ({ ...p, dollars: ((p.sellPriceCents ?? p.suggestedPriceCents) / 100).toFixed(2) })));
      baseline.current = { version: launchData.version, billingScope: launchData.billingScope };
    }
  }, [launchData, dirty]);
  const edit = (index: number, patch: Partial<(typeof products)[number]>) => {
    setDirty(true);
    setProducts(products.map((item, i) => i === index ? { ...item, ...patch } : item));
  };
  // Other successful checklist steps can advance the version. Price edits must not
  // silently cross a billing mode change or catalog refresh.
  const save = async (suggested: boolean) => {
    setError('');
    if (baseline.current.billingScope !== launchData.billingScope) return setError('Payment mode changed. Refresh setup and review prices in the current mode.');
    try {
      const payload = products.map((p) => {
        const useSuggestion = suggested && !p.existingPrice;
        const parsed = parseDollarsToCents(useSuggestion ? (p.suggestedPriceCents / 100).toFixed(2) : p.dollars);
        if (!parsed.ok) throw new Error(`${p.name}: ${parsed.error}`);
        const enabled = useSuggestion ? p.available : p.enabled;
        if (enabled && parsed.cents < p.minimumPriceCents) throw new Error(`${p.name}: price must be at least ${formatCents(p.minimumPriceCents)}.`);
        return { productId: p.productId, enabled, sellPriceCents: parsed.cents, subscriptionEnabled: enabled && p.subscriptionEligible && (useSuggestion || p.subscriptionEnabled) };
      });
      const result = await write.save({ expectedVersion: baseline.current.version, products: payload }, baseline.current.billingScope);
      if (result) setDirty(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Product setup could not be saved.'); }
  };
  return <div className="space-y-4 p-5 text-sm">
    <p>Suggested patient prices are exactly <b>2× the THINNR product fee</b>, excluding shipping and card fees. The product fee is 60% of the catalog floor, truncated to cents before doubling. Existing custom prices and choices stay unchanged.</p>
    <p className="text-muted-foreground">All available active products are suggested, with supported subscriptions enabled when eligible. Turning a product off hides it from new patient purchases; it does not cancel existing subscriptions.</p>
    <div className="divide-y divide-border rounded-md border border-border">
      {products.map((p, index) => <div key={p.productId} className="space-y-3 p-4">
        <div className="flex flex-wrap justify-between gap-2"><b>{p.name}</b><span>{formatCents(p.sellPriceCents ?? p.suggestedPriceCents)} {p.existingPrice ? '· Existing price preserved' : '· Suggested price'}</span></div>
        {!p.available && <p className="text-muted-foreground">Unavailable for setup at the current catalog or fee constraints.</p>}
        {custom && <fieldset disabled={!launchData.canEdit || write.isPending || !p.available} className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2"><input type="checkbox" checked={p.enabled} onChange={(e) => edit(index, { enabled: e.target.checked })} />Enabled for patients</label>
          <label>Patient price ($)<input aria-label={`${p.name} patient price`} className={`${INPUT_CLASS} ml-2 h-9 w-28 px-2`} inputMode="decimal" value={p.dollars} onChange={(e) => edit(index, { dollars: e.target.value })} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={p.subscriptionEnabled} disabled={!p.subscriptionEligible || !p.enabled} onChange={(e) => edit(index, { subscriptionEnabled: e.target.checked })} />Subscriptions</label>
          <p className="w-full text-xs text-muted-foreground">Minimum {formatCents(p.minimumPriceCents)}. Subscription discount and fees are checked again before saving.</p>
        </fieldset>}
      </div>)}
    </div>
    {!products.length && <p>No active catalog products are available. Contact THINNR support before continuing.</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {dirty && launchData.version !== baseline.current.version && <p role="alert" className="text-destructive">Setup changed while you were editing. Discard this draft and review the latest product choices.</p>}
    {dirty && <button className={`${BTN_SECONDARY} h-10 px-4`} onClick={() => { setDirty(false); setError(''); }}>Discard product draft</button>}
    {launchData.canEdit && <div className="flex flex-wrap gap-3">
      <button className={`${BTN_PRIMARY} h-10 px-4`} disabled={write.isPending || !products.length} onClick={() => void save(!custom)}>{write.isPending ? 'Saving…' : custom ? 'Save custom setup' : 'Use suggested setup'}</button>
      <button className={`${BTN_SECONDARY} h-10 px-4`} disabled={write.isPending} onClick={() => setCustom(!custom)}>{custom ? 'Review suggested setup' : 'Customize setup'}</button>
    </div>}
  </div>;
}