import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, XCircle } from 'lucide-react';
import { usePaymentsHealth } from '@/hooks/use-billing';
import type { PaymentsHealth } from '@/lib/billing-types';

export function PaymentsHealthBannerView({ health }: { health: PaymentsHealth }) {
  const [open, setOpen] = useState(false);
  const problems: string[] = [];
  if (!health.webhooks.registered) problems.push('Payment webhooks are not registered.');
  if (health.pending_orders_over_1h > 0) {
    problems.push(`${health.pending_orders_over_1h} ${health.pending_orders_over_1h === 1 ? 'order is' : 'orders are'} stuck pending.`);
  }
  if (health.unprocessed_webhook_events > 0) {
    problems.push(`${health.unprocessed_webhook_events} webhook ${health.unprocessed_webhook_events === 1 ? 'event is' : 'events are'} unprocessed.`);
  }
  if (health.stripe_customer_emails?.accounts_on.length) {
    const n = health.stripe_customer_emails.accounts_on.length;
    problems.push(`Stripe is emailing customers for ${n} connected ${n === 1 ? 'account' : 'accounts'}; THINNR should send every customer email.`);
  }
  if (health.stripe_customer_emails?.accounts_unverified.length) {
    const n = health.stripe_customer_emails.accounts_unverified.length;
    problems.push(`${n} connected ${n === 1 ? 'account has' : 'accounts have'} not confirmed Stripe customer emails are off; confirm on the provider page.`);
  }
  if (!health.last_reconcile_run) problems.push('Billing reconciliation has never run.');
  else if (health.last_reconcile_run.status === 'failed') problems.push('The latest billing reconciliation failed.');
  if (health.credentials_ok && problems.length === 0) return null;

  const red = !health.credentials_ok;
  return (
    <section
      role="alert"
      className={`rounded-xl border p-4 ${red ? 'border-red-300 bg-red-50 text-red-950' : 'border-amber-300 bg-amber-50 text-navy'}`}
    >
      <div className="flex items-start gap-3">
        {red ? <XCircle className="mt-0.5 size-5 shrink-0" /> : <AlertTriangle className="mt-0.5 size-5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{red ? 'Payments are not configured for this mode.' : 'Payments need attention.'}</p>
          {red && <p className="mt-1 text-sm">An HQ administrator must configure the selected mode’s environment keys. Payments stay unavailable until configuration is complete; the app will not fall back to another mode.</p>}
          {!red && <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1 text-sm font-semibold underline underline-offset-2"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            Details {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
          {open && (
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              <div><dt className="font-semibold">Mode</dt><dd>{health.sandbox ? 'Test' : health.livemode ? 'Live' : 'Unavailable'}</dd></div>
              <div><dt className="font-semibold">Public origin</dt><dd>{health.public_origin ?? 'Not configured'}</dd></div>
              <div><dt className="font-semibold">Last webhook</dt><dd>{health.last_webhook_received_at ?? 'None received'}</dd></div>
              <div><dt className="font-semibold">Failed events, 24 hours</dt><dd>{health.failed_events_24h}</dd></div>
              {health.stripe_customer_emails && (
                <div>
                  <dt className="font-semibold">Stripe customer emails</dt>
                  <dd>
                    Platform: none sent · {health.stripe_customer_emails.accounts_off} off · {health.stripe_customer_emails.accounts_unverified.length} unverified · {health.stripe_customer_emails.accounts_on.length} on
                  </dd>
                </div>
              )}
            </dl>
          )}
        </div>
      </div>
    </section>
  );
}

export function PaymentsHealthBanner() {
  const health = usePaymentsHealth();
  if (!health.data) return null;
  return <PaymentsHealthBannerView health={health.data} />;
}