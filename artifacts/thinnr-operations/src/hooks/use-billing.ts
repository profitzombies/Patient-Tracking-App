/**
 * React-query hooks for the payments screens.
 *
 * Every office hook is gated on `useLiveOfficeScope().liveEnabled` and keyed by
 * the caller identity + office, so a signed-out demo session issues no live
 * request and an HQ drill-in never adopts an office session's cache. HQ hooks
 * are gated on a signed-in HQ session. Add new hooks here rather than calling
 * the client from pages so the gating stays in one place.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useSession } from '@/contexts/session';
import { useLiveOfficeScope } from '@/hooks/use-live-office-scope';
import { hqBilling, officeBilling, type ListFilters } from '@/lib/billing-api';
import type {
  BillingSettings,
  CatalogProductInput,
  FulfillmentUpdate,
  OfficePrice,
} from '@/lib/billing-types';

export const billingKeys = {
  office: (user: string | null, office: string | null) => ['billing', 'office', user, office] as const,
  hq: (user: string | null) => ['billing', 'hq', user] as const,
};

/** Shared gate for office payments screens. */
export function useOfficeBillingScope() {
  const scope = useLiveOfficeScope();
  return {
    ...scope,
    base: billingKeys.office(scope.authUserId, scope.liveOffice),
    office: scope.liveOffice,
  };
}

export function useHqBillingScope() {
  const { authStatus, authRole, authUser } = useSession();
  const liveEnabled = authStatus === 'signed-in' && authRole === 'hq_admin';
  return {
    liveEnabled,
    isDemo: authStatus === 'signed-out',
    isResolving: authStatus === 'loading',
    authUserId: authUser?.id ?? null,
    base: billingKeys.hq(authUser?.id ?? null),
  };
}

type QueryOpts<T> = Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn' | 'enabled'>;

// ---------------- office ----------------

export function useOfficeBillingStatus(options?: QueryOpts<Awaited<ReturnType<typeof officeBilling.status>>>) {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  return useQuery({
    queryKey: [...base, 'status'],
    queryFn: () => officeBilling.status(office),
    enabled: liveEnabled,
    staleTime: 30_000,
    ...options,
  });
}

export function useOfficeDashboard(range: { from?: string; to?: string }) {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  return useQuery({
    queryKey: [...base, 'dashboard', range.from ?? null, range.to ?? null],
    queryFn: () => officeBilling.dashboard(range, office),
    enabled: liveEnabled,
  });
}

export function useOfficePrices() {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  return useQuery({
    queryKey: [...base, 'prices'],
    queryFn: () => officeBilling.prices(office),
    enabled: liveEnabled,
  });
}

export function useUpdateOfficePrice() {
  const { office, base } = useOfficeBillingScope();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { productId: string; sell_price_cents: number | null; subscription_enabled: boolean }) =>
      officeBilling.updatePrice(input.productId, {
        sell_price_cents: input.sell_price_cents,
        subscription_enabled: input.subscription_enabled,
      }, office),
    onSuccess: (result) => {
      client.setQueryData<Awaited<ReturnType<typeof officeBilling.prices>>>([...base, 'prices'], (previous) =>
        previous
          ? {
              ...previous,
              products: previous.products.map((row: OfficePrice) =>
                row.product_id === result.product.product_id ? result.product : row,
              ),
            }
          : previous,
      );
      void client.invalidateQueries({ queryKey: [...base, 'status'] });
    },
  });
}

export function useOfficeLinks() {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  return useQuery({
    queryKey: [...base, 'links'],
    queryFn: () => officeBilling.links(office),
    enabled: liveEnabled,
  });
}

export function useOfficeOrders(filters: ListFilters) {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  return useQuery({
    queryKey: [...base, 'orders', filters],
    queryFn: () => officeBilling.orders(filters, office),
    enabled: liveEnabled,
  });
}

export function useOfficeOrder(orderId: string | null) {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  return useQuery({
    queryKey: [...base, 'order', orderId],
    queryFn: () => officeBilling.order(orderId as string, office),
    enabled: liveEnabled && Boolean(orderId),
  });
}

export function useOfficeSubscriptions(filters: ListFilters) {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  return useQuery({
    queryKey: [...base, 'subscriptions', filters],
    queryFn: () => officeBilling.subscriptions(filters, office),
    enabled: liveEnabled,
  });
}

export function useOfficePayouts() {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  return useQuery({
    queryKey: [...base, 'payouts'],
    queryFn: () => officeBilling.payouts(office),
    enabled: liveEnabled,
  });
}

/** Invalidate everything under the office payments cache after a mutation. */
export function useInvalidateOfficeBilling() {
  const { base } = useOfficeBillingScope();
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: base });
}

// ---------------- HQ ----------------

export function useHqOverview(range: { from?: string; to?: string }) {
  const { liveEnabled, base } = useHqBillingScope();
  return useQuery({
    queryKey: [...base, 'overview', range.from ?? null, range.to ?? null],
    queryFn: () => hqBilling.overview(range),
    enabled: liveEnabled,
  });
}

export function useHqProviders() {
  const { liveEnabled, base } = useHqBillingScope();
  return useQuery({ queryKey: [...base, 'providers'], queryFn: () => hqBilling.providers(), enabled: liveEnabled });
}

export function useHqProvider(providerId: string | null) {
  const { liveEnabled, base } = useHqBillingScope();
  return useQuery({
    queryKey: [...base, 'provider', providerId],
    queryFn: () => hqBilling.provider(providerId as string),
    enabled: liveEnabled && Boolean(providerId),
  });
}

export function useHqTransactions(filters: ListFilters) {
  const { liveEnabled, base } = useHqBillingScope();
  return useQuery({
    queryKey: [...base, 'transactions', filters],
    queryFn: () => hqBilling.transactions(filters),
    enabled: liveEnabled,
  });
}

export function useHqTransaction(orderId: string | null) {
  const { liveEnabled, base } = useHqBillingScope();
  return useQuery({
    queryKey: [...base, 'transaction', orderId],
    queryFn: () => hqBilling.transaction(orderId as string),
    enabled: liveEnabled && Boolean(orderId),
  });
}

export function useHqFulfillment(filters: ListFilters) {
  const { liveEnabled, base } = useHqBillingScope();
  return useQuery({
    queryKey: [...base, 'fulfillment', filters],
    queryFn: () => hqBilling.fulfillment(filters),
    enabled: liveEnabled,
  });
}

export function useUpdateFulfillment() {
  const { base } = useHqBillingScope();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { orderId: string } & FulfillmentUpdate) => {
      const { orderId, ...body } = input;
      return hqBilling.updateFulfillment(orderId, body);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: [...base, 'fulfillment'] });
      void client.invalidateQueries({ queryKey: [...base, 'transaction'] });
      void client.invalidateQueries({ queryKey: [...base, 'transactions'] });
      void client.invalidateQueries({ queryKey: [...base, 'overview'] });
    },
  });
}

export function useHqCatalog() {
  const { liveEnabled, base } = useHqBillingScope();
  return useQuery({ queryKey: [...base, 'catalog'], queryFn: () => hqBilling.catalog(), enabled: liveEnabled });
}

export function useHqCatalogMutations() {
  const { base } = useHqBillingScope();
  const client = useQueryClient();
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: [...base, 'catalog'] });
    void client.invalidateQueries({ queryKey: [...base, 'changes'] });
  };
  return {
    create: useMutation({ mutationFn: (body: CatalogProductInput) => hqBilling.createProduct(body), onSuccess: invalidate }),
    update: useMutation({
      mutationFn: (input: { productId: string } & Partial<CatalogProductInput>) => {
        const { productId, ...body } = input;
        return hqBilling.updateProduct(productId, body);
      },
      onSuccess: invalidate,
    }),
    retire: useMutation({ mutationFn: (productId: string) => hqBilling.retireProduct(productId), onSuccess: invalidate }),
    reactivate: useMutation({ mutationFn: (productId: string) => hqBilling.reactivateProduct(productId), onSuccess: invalidate }),
    settings: useMutation({
      mutationFn: (body: Omit<BillingSettings, 'updated_at' | 'version'> & { expected_version: number }) => hqBilling.updateSettings(body),
      onSuccess: invalidate,
    }),
  };
}

export function useHqCatalogChanges(filters: ListFilters) {
  const { liveEnabled, base } = useHqBillingScope();
  return useQuery({
    queryKey: [...base, 'changes', filters],
    queryFn: () => hqBilling.changes(filters),
    enabled: liveEnabled,
  });
}

export function useHqSubscriptions(filters: ListFilters) {
  const { liveEnabled, base } = useHqBillingScope();
  return useQuery({
    queryKey: [...base, 'subscriptions', filters],
    queryFn: () => hqBilling.subscriptions(filters),
    enabled: liveEnabled,
  });
}

export function useInvalidateHqBilling() {
  const { base } = useHqBillingScope();
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: base });
}
