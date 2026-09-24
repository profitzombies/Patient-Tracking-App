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
