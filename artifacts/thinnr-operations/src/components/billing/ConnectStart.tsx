import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { BTN_PRIMARY, BTN_SECONDARY, SectionCard } from '@/components/patient/heritage';
import { useOfficeBillingScope } from '@/hooks/use-billing';
import { useLaunchData } from '@/hooks/use-launch';
import { useToast } from '@/hooks/use-toast';
import { officeBilling } from '@/lib/billing-api';
import type { OfficeBillingStatus } from '@/lib/billing-types';

/**
 * The two ways an office without a Stripe account gets one: log in to an
 * account it already manages (OAuth, when a Connect client ID is configured)
 * or create a new one through Stripe's embedded onboarding. Shown on Get paid
 * and on the practice setup screen, where a brand-new owner is held until
 * payments are ready.
 */
export function ConnectStartCards({ status, demo = false }: { status: OfficeBillingStatus | null; demo?: boolean }) {
  const { office } = useOfficeBillingScope();
  const client = useQueryClient();
  const { toast } = useToast();
  const launchQuery = useLaunchData();
  const scope = launchQuery.data?.billingScope ?? '';
  // A new account changes the office payments status, the office-access
  // setup snapshot and the practice launch state all at once.
  const refreshAll = () => client.invalidateQueries({ predicate: (query) =>
    query.queryKey[0] === 'office' || (query.queryKey[0] === 'billing' && query.queryKey[1] === 'office') });
  const create = useMutation({
    mutationFn: () => officeBilling.createAccount(scope, office),
    onSuccess: () => void refreshAll(),
    onError: (error) =>
      toast({
        variant: 'destructive',
        title: 'Account not created',
        description: error instanceof Error ? error.message : 'Try again.',
      }),
  });
  const oauth = async () => {
    try {
      window.location.assign((await officeBilling.oauthStart(scope, office)).url);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Stripe connection not started',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    }
  };
  const oauthAvailable = demo || status?.oauth_available;
  const waitingForScope = !demo && !scope;
  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="connect-start">
      <SectionCard title="Connect an existing Stripe account" sub="Use an account your office already manages.">
        <div className="p-5">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Authorize THINNR to create charges and deduct the program fee.
          </p>
          {oauthAvailable ? (
            <button
              data-testid="button-oauth-start"
              type="button"
              className={`${BTN_SECONDARY} mt-4 h-9 px-3.5`}
              disabled={demo || waitingForScope}
              onClick={() => void oauth()}
            >
              Connect Stripe <ExternalLink size={13} aria-hidden="true" />
            </button>
          ) : (
            <p data-testid="oauth-unavailable" className="mt-4 text-xs text-muted-foreground">
              Existing account connection is not configured yet. You can set up a new account now.
            </p>
          )}
        </div>
      </SectionCard>
      <SectionCard title="Set up a new account" sub="Create a Stripe account without leaving THINNR.">
        <div className="p-5">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Stripe securely collects business, owner, and bank details.
          </p>
          <button
            data-testid="button-create-account"
            type="button"
            className={`${BTN_PRIMARY} mt-4 h-9 px-3.5`}
            disabled={demo || waitingForScope || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating…' : 'Start setup'}
          </button>
        </div>
      </SectionCard>
    </div>
  );
}
