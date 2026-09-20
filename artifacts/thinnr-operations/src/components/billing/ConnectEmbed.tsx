import { useEffect, useState, type ReactNode } from 'react';
import { loadConnectAndInitialize } from '@stripe/connect-js';
import {
  ConnectAccountManagement as StripeAccountManagement,
  ConnectAccountOnboarding as StripeAccountOnboarding,
  ConnectBalances as StripeBalances,
  ConnectComponentsProvider,
  ConnectDocuments as StripeDocuments,
  ConnectDisputesList as StripeDisputesList,
  ConnectNotificationBanner as StripeNotificationBanner,
  ConnectPayouts as StripePayouts,
  ConnectTaxRegistrations as StripeTaxRegistrations,
  ConnectTaxSettings as StripeTaxSettings,
} from '@stripe/react-connect-js';
import { ExternalLink } from 'lucide-react';
import { officeBilling, BillingApiError } from '@/lib/billing-api';
import type { AccountSessionResponse } from '@/lib/billing-types';
import { BTN_SECONDARY } from '@/components/patient/heritage';

export type ConnectComponent =
  | 'account_onboarding'
  | 'account_management'
  | 'payouts'
  | 'balances'
  | 'notification_banner'
  | 'tax_settings'
  | 'tax_registrations'
  | 'documents'
  | 'disputes_list';

export function ConnectEmbed({
  components,
  office,
  children,
}: {
  components: ConnectComponent[];
  office?: string | null;
  children: ReactNode;
}) {
  const [failure, setFailure] = useState<Error | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<AccountSessionResponse | null>(null);
  const [connectInstance, setConnectInstance] = useState<ReturnType<typeof loadConnectAndInitialize> | null>(null);
  const componentKey = components.join(',');
  useEffect(() => {
    let current = true;
    setFailure(null);
    setUnsupported(false);
    setSession(null);
    setConnectInstance(null);
    officeBilling.accountSession(components, office).then(
      (response) => current && setSession(response),
      (error: unknown) => {
        if (!current) return;
        if (error instanceof BillingApiError && error.status === 409) setUnsupported(true);
        else setFailure(error instanceof Error ? error : new Error('Stripe tools could not be loaded.'));
      },
    );
    return () => {
      current = false;
    };
    // The stable key prevents a caller's inline array from restarting the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [componentKey, office, attempt]);
  useEffect(() => {
    if (!session) return;
    let firstRequest = true;
    try {
      setConnectInstance(
        loadConnectAndInitialize({
          publishableKey: session.publishable_key,
          fetchClientSecret: async () => {
            if (firstRequest) {
              firstRequest = false;
              return session.client_secret;
            }
            try {
              const refreshed = await officeBilling.accountSession(components, office);
              if (refreshed.publishable_key !== session.publishable_key || refreshed.sandbox !== session.sandbox ||
                  refreshed.stripe_account_id !== session.stripe_account_id) {
                throw new Error('Payment configuration changed. Reload this page before continuing.');
              }
              return refreshed.client_secret;
            } catch (error) {
              if (error instanceof BillingApiError && error.status === 409) setUnsupported(true);
              else setFailure(error instanceof Error ? error : new Error('Stripe tools could not be loaded.'));
              throw error;
            }
          },
          appearance: {
            overlays: 'dialog',
            variables: {
              colorPrimary: '#315eae',
              colorBackground: '#fdfcf9',
              colorText: '#26364b',
              colorDanger: '#a04646',
              borderRadius: '7px',
              fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
            },
          },
        }),
      );
    } catch (error) {
      setFailure(error instanceof Error ? error : new Error('Stripe tools could not be loaded.'));
    }
    // Components are represented by componentKey in the session-producing effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, office]);

  if (unsupported) {
    return (
      <div className="rounded-md border border-border bg-secondary p-4">
        <p className="text-xs text-muted-foreground">
          This setting is managed in the Stripe Dashboard for your connected account.
        </p>
        <a
          className={`${BTN_SECONDARY} mt-3 h-9 px-3.5`}
          href="https://dashboard.stripe.com/"
          target="_blank"
          rel="noreferrer"
        >
          Manage in Stripe <ExternalLink size={13} aria-hidden="true" />
        </a>
      </div>
    );
  }
  if (failure) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4" role="alert">
        <p className="text-xs text-destructive">{failure?.message ?? 'Stripe tools could not be loaded.'}</p>
        <button
          className={`${BTN_SECONDARY} mt-3 h-8 px-3`}
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Try again
        </button>
      </div>
    );
  }
  if (!connectInstance) return <p className="py-4 text-xs text-muted-foreground">Loading secure Stripe tools…</p>;
  return <ConnectComponentsProvider connectInstance={connectInstance}>{children}</ConnectComponentsProvider>;
}

export function ConnectOnboarding({ onExit }: { onExit: () => void }) {
  return <StripeAccountOnboarding onExit={onExit} />;
}
export function ConnectAccountManagement() {
  return <StripeAccountManagement />;
}
export function ConnectPayouts() {
  return <StripePayouts />;
}
export function ConnectBalances() {
  return <StripeBalances />;
}
export function ConnectNotificationBanner() {
  return <StripeNotificationBanner />;
}
export function ConnectTaxSettings() {
  return <StripeTaxSettings />;
}
export function ConnectTaxRegistrations() {
  return <StripeTaxRegistrations />;
}
export function ConnectDocuments() {
  return <StripeDocuments />;
}
export function ConnectDisputesList() {
  return <StripeDisputesList />;
}
