/**
 * The office's own THINNR access: what it owes, whether the workspace is
 * narrowed for nonpayment, and the action that pays it.
 *
 * Only the office's own staff read this. An HQ drill-in is never narrowed by
 * the office's billing state (HQ must still see and help the account), so the
 * query stays off whenever an office id is named explicitly.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { officeRequest } from '@/lib/office-api';
import { useLiveOfficeScope } from '@/hooks/use-live-office-scope';
import { officeBilling } from '@/lib/billing-api';
import type { OfficeAccessSlot } from '@/lib/billing-types';

export interface OfficeAccessState {
  restricted: boolean;
  message: string | null;
  allowed_capabilities: string[] | null;
  share_percent: number;
  state: string | null;
  plan: string | null;
  price_cents: number | null;
  lifetime: boolean;
  included_period_ends_at: string | null;
  paid_through: string | null;
  grace_ends_at: string | null;
  restricted_at: string | null;
  setup_completed_at: string | null;
}

export interface OfficeAccessPayment extends OfficeAccessState {
  paid: boolean;
  pending: boolean;
}

const messages = {
  unconfigured: 'Account billing is not configured.',
  signedOut: 'Sign in to see your account status.',
  unreachable: 'Account status could not be reached. Try again.',
  failed: 'Account status could not be loaded',
};

export function officeAccessKey(user: string | null) {
  return ['office', 'access', user] as const;
}

/**
 * The setup snapshot is a different question from the narrowed state: what the
 * office still owes THINNR before it may use the workspace at all. HQ drill-ins
 * name an office, so the key carries it.
 */
export function officeAccessSetupKey(user: string | null, office: string | null) {
  return ['billing', 'office', 'access', 'setup', user, office] as const;
}

export function useOfficeAccess() {
  const scope = useLiveOfficeScope();
  return useQuery({
    queryKey: officeAccessKey(scope.authUserId),
    queryFn: () => officeRequest<OfficeAccessState>('/api/office/access', messages),
    // Own-office staff only: an HQ drill-in names an office and is not narrowed.
    enabled: scope.liveEnabled && scope.liveOffice === null,
    staleTime: 0,
    refetchInterval: 60_000,
  });
}

/** What the office still has to put in place before the workspace opens. */
export function useOfficeAccessSetup() {
  const scope = useLiveOfficeScope();
  return useQuery({
    queryKey: officeAccessSetupKey(scope.authUserId, scope.liveOffice),
    queryFn: () => officeBilling.access(scope.liveOffice),
    enabled: scope.liveEnabled,
    staleTime: 0,
  });
}

export function useOfficeAccessMutations() {
  const scope = useLiveOfficeScope();
  const client = useQueryClient();
  const key = officeAccessSetupKey(scope.authUserId, scope.liveOffice);
  const refresh = (data?: unknown) => {
    const snapshot = data && typeof data === 'object' && 'setup' in data
      ? (data as { setup: unknown }).setup : data;
    if (snapshot) client.setQueryData(key, snapshot);
    void client.invalidateQueries({ queryKey: key });
    // Settling a balance can also lift a narrowed workspace.
    void client.invalidateQueries({ queryKey: officeAccessKey(scope.authUserId) });
    void client.invalidateQueries({ predicate: (query) => query.queryKey.includes('launch') });
  };
  return {
    setupIntent: useMutation({ mutationFn: (slot: OfficeAccessSlot) => officeBilling.accessSetupIntent(slot, scope.liveOffice) }),
    instrument: useMutation({ mutationFn: (body: { slot: OfficeAccessSlot; paymentMethodId: string; setupIntentId?: string }) => officeBilling.accessInstrument(body, scope.liveOffice), onSuccess: refresh }),
    plan: useMutation({ mutationFn: (plan: 'monthly' | 'yearly') => officeBilling.accessPlan(plan, scope.liveOffice), onSuccess: refresh }),
    disclosure: useMutation({ mutationFn: (version: number) => officeBilling.accessDisclosure(version, scope.liveOffice), onSuccess: refresh }),
    bankVerify: useMutation({ mutationFn: () => officeBilling.accessBankVerify(scope.liveOffice), onSuccess: refresh }),
    pay: useMutation({ mutationFn: () => officeBilling.accessPay(scope.liveOffice), onSuccess: refresh }),
  };
}

/** Pay now. Any staff member may do this — nonpayment is not an owner-only problem. */
export function usePayOfficeAccess() {
  const scope = useLiveOfficeScope();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => officeRequest<OfficeAccessPayment>('/api/office/access/pay', {
      ...messages,
      failed: 'That payment could not be started',
    }, { method: 'POST' }),
    onSuccess: (data) => {
      client.setQueryData(officeAccessKey(scope.authUserId), data);
      // Recovery restores the whole workspace, so everything cached under the
      // narrowed surface must be asked again.
      if (!data.restricted) void client.invalidateQueries();
    },
  });
}
