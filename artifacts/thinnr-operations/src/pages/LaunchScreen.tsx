import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { useLaunchWrite, type LaunchState } from '@/hooks/use-launch';
import { SectionCard, BTN_PRIMARY, BTN_SECONDARY, PANEL_LABEL, INPUT_CLASS } from '@/components/patient/heritage';
import { parseDollarsToCents, formatCents } from '@/lib/billing-format';

const labels: Record<keyof LaunchState['details'], string> = {
  officeName: 'Practice name', providerName: 'Provider name', email: 'Contact email', phone: 'Office phone',
  address1: 'Address 1', address2: 'Address 2 (optional)', city: 'City', state: 'US state', postalCode: 'ZIP code',
};
export const paymentLabels = { not_started: 'Not started', action_required: 'Action required', pending: 'Submitted — Stripe verification pending', ready: 'Ready' };

export function LaunchScreen({ launchData, onTour, allowTour = true }: { launchData: LaunchState; onTour: () => void; allowTour?: boolean }) {
  const complete = useLaunchWrite('complete');
  const [error, setError] = useState('');
  const ready = launchData.detailsConfirmed && launchData.productsConfirmed && launchData.security.ready &&
    (launchData.payments.state === 'ready' || launchData.payments.state === 'pending');
  const finish = async () => {
    setError('');
    try {
      const result = await complete.save({ expectedVersion: launchData.version }, launchData.billingScope);
      if (result) onTour();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not finish setup.'); }
  };
  const count = [launchData.detailsConfirmed, launchData.security.ready, ['pending', 'ready'].includes(launchData.payments.state), launchData.productsConfirmed].filter(Boolean).length;
  return <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 sm:px-6" data-testid="practice-launch">
    <header><p className={PANEL_LABEL}>Practice launch · {launchData.payments.sandbox ? 'Test payments' : 'Live payments'}</p>
      <h1 className="mt-2 font-serif text-2xl font-bold text-navy">Welcome to {launchData.office.officeName}</h1>
      <p className="mt-2 text-sm text-muted-foreground">A few essentials, then a hands-on tour. Confirmed steps are saved to your practice so you can return on any device.</p></header>
    <div className="rounded-lg border border-border bg-card p-5"><p className="text-sm font-semibold">{count} of 4 essentials confirmed</p><progress className="mt-3 h-2 w-full accent-primary" value={count} max={4} aria-label="Practice setup progress" /></div>
    {!launchData.canEdit && <SectionCard title="Your practice owner completes setup"><div className="space-y-3 p-5 text-sm"><p>These settings affect the whole practice. Ask your owner to confirm the remaining essentials. {allowTour ? 'You can explore the sample tour without changing office settings.' : 'HQ inspection is read-only; you cannot accept terms or confirm owner setup.'}</p>{allowTour && <button className={`${BTN_SECONDARY} h-10 px-4`} onClick={onTour}>Explore sample tour</button>}</div></SectionCard>}
    <SectionCard title={`1. Practice details${launchData.detailsConfirmed ? ' · Confirmed' : ''}`} sub="Review your existing contact information. No new signup is needed.">
      <DetailsForm launchData={launchData} />
    </SectionCard>
    <SectionCard title={`2. Account security · ${launchData.security.ready ? 'Ready' : 'Action required'}`} sub="Your existing email verification and required second-factor policy apply.">
      <div className="p-5"><Link href="/security" className={`${BTN_SECONDARY} h-10 px-4`}>Review account security</Link></div>
    </SectionCard>
    <SectionCard title={`3. Connect payments · ${paymentLabels[launchData.payments.state]}`} sub="Stripe securely collects business, owner and bank details.">
      <div className="space-y-3 p-5 text-sm">
        <p>{launchData.payments.sandbox ? 'This is Test mode. Test readiness does not confirm Live readiness.' : 'This is Live mode. Review your real business information carefully.'}</p>
        {launchData.payments.state === 'pending' && <p>Currently actionable steps are submitted. You can take the tour while Stripe verifies your account, but you cannot charge patients until payments are ready.</p>}
        {launchData.canEdit && <Link href="/payments/get-paid" className={`${BTN_PRIMARY} h-10 px-4`}>{launchData.payments.state === 'not_started' ? 'Connect payments' : 'Review Stripe setup'}</Link>}
        <p className="text-muted-foreground">Return to Practice setup after completing Stripe’s steps. Use Refresh status there to check the latest requirements.</p>
      </div>
    </SectionCard>
    <SectionCard title={`4. Products and pricing${launchData.productsConfirmed ? ' · Confirmed' : ''}`} sub="Choose the products patients can buy and review every price.">
      <ProductsForm launchData={launchData} />
    </SectionCard>
    {error && <p role="alert" className="text-sm text-destructive">{error} Refresh the setup status before retrying if another session changed it.</p>}
    <footer className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
      {launchData.canEdit && <button className={`${BTN_PRIMARY} h-10 px-4`} disabled={!ready || complete.isPending} onClick={() => void finish()}>{complete.isPending ? 'Saving…' : launchData.completedAt ? 'Continue to sample tour' : 'Finish setup and explore'}</button>}
      <p className="text-sm text-muted-foreground">Invitations, training and the tour are optional.</p>
    </footer>
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