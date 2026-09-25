import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { officeRequest, officeQuery } from '@/lib/office-api';
import { useLiveOfficeScope } from '@/hooks/use-live-office-scope';

export interface LaunchProduct {
  productId: string; name: string; enabled: boolean; sellPriceCents: number | null;
  suggestedPriceCents: number; minimumPriceCents: number; subscriptionEnabled: boolean;
  subscriptionEligible: boolean; existingPrice: boolean; available: boolean;
}
export interface LaunchState {
  billingScope: string;
  office: { providerId: string; officeName: string }; canEdit: boolean; required: boolean; fullSetupRequired: boolean;
  /** HQ is inspecting this office; it reads the setup screen but is never held at it. */
  hqInspection?: boolean;
  version: number; detailsConfirmed: boolean; productsConfirmed: boolean; completedAt: string | null;
  details: { officeName: string; providerName: string; email: string; phone: string; address1: string; address2: string; city: string; state: string; postalCode: string };
  /**
   * The viewer's own sign-in facts. `emailVerified` is true for anyone signed
   * in by emailed code; `phoneMasked` is display-only, e.g. "(•••) •••-7788".
   */
  security: { ready: boolean; emailVerified: boolean; phoneVerified: boolean; phoneRequired: boolean; phoneMasked: string | null };
  /** HQ waived the gate for this office; the fields above still report reality. */
  setupOverride?: { active: boolean; at: string | null; note: string | null };
  payments: { state: 'not_started' | 'action_required' | 'pending' | 'ready'; sandbox: boolean };
  /** The office's own payment arrangements with THINNR, as the server's gate sees them. */
  accessSetup?: LaunchAccessSetup;
  products: LaunchProduct[];
}
export interface LaunchAccessSetup {
  complete: boolean;
  missing: Array<'bank' | 'card_primary' | 'card_backup'>;
  planSelected: boolean;
  disclosureAcknowledged: boolean;
  bankVerificationPending: boolean;
  bankVerificationDeadline: string | null;
  bankVerificationOverdue: boolean;
}
const messages = { unconfigured: 'Practice setup is not configured.', signedOut: 'Sign in to continue practice setup.', unreachable: 'Practice setup could not be reached. Try again.', failed: 'Practice setup could not be saved' };
export function launchKey(user: string | null, office: string | null) { return ['office', 'launch', user, office] as const; }
export function useLaunchData() {
  const scope = useLiveOfficeScope();
  return useQuery({
    queryKey: launchKey(scope.authUserId, scope.liveOffice),
    queryFn: () => officeRequest<LaunchState>(`/api/office/launch${officeQuery(scope.liveOffice)}`, messages),
    enabled: scope.liveEnabled, staleTime: 0, refetchInterval: 30_000,
  });
}
export function useLaunchWrite(path: 'details' | 'products' | 'complete') {
  const scope = useLiveOfficeScope();
  const client = useQueryClient();
  const lock = useRef(false);
  const key = launchKey(scope.authUserId, scope.liveOffice);
  const mutation = useMutation({
    mutationFn: (input: { body: unknown; billingScope?: string }) => officeRequest<LaunchState>(
      `/api/office/launch/${path}${officeQuery(scope.liveOffice)}`, messages,
      { method: path === 'details' ? 'PUT' : 'POST',
        headers: input.billingScope ? { 'X-Billing-Scope': input.billingScope } : {},
        body: JSON.stringify(input.body) }),
    onSuccess: (data) => {
      client.setQueryData(key, data);
      if (path === 'products') void client.invalidateQueries({ predicate: (query) =>
        !query.queryKey.includes('launch') && query.queryKey.some((part) => typeof part === 'string' && part.includes('billing')) });
    },
  });
  const save = async (body: unknown, billingScope?: string) => {
    if (lock.current) return null;
    lock.current = true;
    try { return await mutation.mutateAsync({ body, billingScope }); }
    finally { lock.current = false; }
  };
  return { ...mutation, save };
}