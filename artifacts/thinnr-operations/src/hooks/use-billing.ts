/**
 * React-query hooks for the payments screens.
 *
 * Every office hook is gated on `useLiveOfficeScope().liveEnabled` and keyed by
 * the caller identity + office, so a signed-out demo session issues no live
 * request and an HQ drill-in never adopts an office session's cache. HQ hooks
 * are gated on a signed-in HQ session. Add new hooks here rather than calling
 * the client from pages so the gating stays in one place.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useSession } from '@/contexts/session';
import { useLiveOfficeScope } from '@/hooks/use-live-office-scope';
import { hqBilling, officeBilling, type ListFilters } from '@/lib/billing-api';
import type {
  BillingSettings,
  CatalogProductDetail,
  CatalogProductInput,
  FulfillmentUpdate,
  HqCatalogResponse,
  OfficePrice,
  ProductStatus,
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
export function usePaymentsHealth() {
  const { liveEnabled, base } = useHqBillingScope();
  return useQuery({
    queryKey: [...base, 'health'],
    queryFn: () => hqBilling.health(),
    enabled: liveEnabled,
    staleTime: 60_000,
  });
}


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

export function useOfficeShippingSettings() {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  return useQuery({
    queryKey: [...base, 'settings'],
    queryFn: () => officeBilling.settings(office),
    enabled: liveEnabled,
  });
}

export function useUpdateOfficeShippingSettings() {
  const { office, base } = useOfficeBillingScope();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { pick_pack_pass_through: boolean | null; expected_version: number }) =>
      officeBilling.updateSettings(input, office),
    onSuccess: (settings) => {
      client.setQueryData([...base, 'settings'], settings);
    },
  });
}

export function useOfficeSaleContext(patientId: string, enabled = true) {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  return useQuery({
    queryKey: [...base, 'sale-context', patientId],
    queryFn: () => officeBilling.saleContext(patientId, office),
    enabled: liveEnabled && enabled && patientId.length > 0,
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

export function useOfficeToday() {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  const tz = viewerTimeZone();
  return useQuery({
    queryKey: [...base, 'overview-today', tz],
    queryFn: () => officeBilling.today(tz, office),
    enabled: liveEnabled,
    // Today's chart keeps itself current while the page is open.
    refetchInterval: 60_000,
  });
}

export function useOfficeActivity(filters: ListFilters) {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  return useInfiniteQuery({
    queryKey: [...base, 'activity', filters],
    queryFn: ({ pageParam }) => officeBilling.activity({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }, office),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: liveEnabled,
  });
}

export function useOfficeRefunds(filters: ListFilters) {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  return useQuery({
    queryKey: [...base, 'refunds', filters],
    queryFn: () => officeBilling.refunds(filters, office),
    enabled: liveEnabled,
  });
}

export function useOfficeFulfillment(filters: ListFilters) {
  const { liveEnabled, office, base } = useOfficeBillingScope();
  return useQuery({
    queryKey: [...base, 'fulfillment', filters],
    queryFn: () => officeBilling.fulfillment(filters, office),
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

export function useHqAiCosts(range: { from?: string; to?: string }) {
  const { liveEnabled, base } = useHqBillingScope();
  return useQuery({
    queryKey: [...base, 'ai-costs', range.from ?? null, range.to ?? null],
    queryFn: () => hqBilling.aiCosts(range),
    enabled: liveEnabled,
  });
}

/** Browser time zone, so "today" on the overview matches the viewer's clock. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}
export function useHqToday() {
  const { liveEnabled, base } = useHqBillingScope();
  const tz = viewerTimeZone();
  return useQuery({
    queryKey: [...base, 'overview-today', tz],
    queryFn: () => hqBilling.today(tz),
    enabled: liveEnabled,
    // Today's chart keeps itself current while the page is open.
    refetchInterval: 60_000,
  });
}

export function useHqActivity(filters: ListFilters) {
  const { liveEnabled, base } = useHqBillingScope();
  return useInfiniteQuery({
    queryKey: [...base, 'activity', filters],
    queryFn: ({ pageParam }) => hqBilling.activity({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
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
      void client.invalidateQueries({ queryKey: [...base, 'overview-today'] });
    },
  });
}

export function useHqCatalog() {
  const { liveEnabled, base } = useHqBillingScope();
  return useQuery({ queryKey: [...base, 'catalog'], queryFn: () => hqBilling.catalog(), enabled: liveEnabled });
}

export function useHqProduct(productId: string | null) {
  const { liveEnabled, base } = useHqBillingScope();
  return useQuery({
    queryKey: [...base, 'catalog', 'product', productId],
    queryFn: () => hqBilling.product(productId as string),
    enabled: liveEnabled && Boolean(productId),
  });
}

/**
 * Upload one product image: ask for a signed PUT, send the bytes, then let the
 * server verify and record it. Progress is per file; the caller sequences files.
 */
export async function uploadProductImage(
  productId: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<CatalogProductDetail> {
  const ticket = await hqBilling.productImageUploadUrl(productId, { content_type: file.type, size: file.size });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', ticket.upload_url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new Error('The image upload was interrupted. Check your connection and try again.'));
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error('The image could not be stored. Try again.'));
    xhr.send(file);
  });
  const result = await hqBilling.finalizeProductImage(productId, {
    image_id: ticket.image_id,
    object_path: ticket.object_path,
    content_type: file.type,
    size: file.size,
  });
  return result.product;
}

export function useHqCatalogMutations() {
  const { base } = useHqBillingScope();
  const client = useQueryClient();
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: [...base, 'catalog'] });
    void client.invalidateQueries({ queryKey: [...base, 'changes'] });
  };
  const settleProduct = (result: { product: CatalogProductDetail }) => {
    client.setQueryData([...base, 'catalog', 'product', result.product.id], result);
    invalidate();
  };
  return {
    create: useMutation({ mutationFn: (body: CatalogProductInput) => hqBilling.createProduct(body), onSuccess: settleProduct }),
    update: useMutation({
      mutationFn: (input: { productId: string } & Partial<CatalogProductInput>) => {
        const { productId, ...body } = input;
        return hqBilling.updateProduct(productId, body);
      },
      onSuccess: settleProduct,
    }),
    setStatus: useMutation({
      mutationFn: (input: { productId: string; status: ProductStatus }) => hqBilling.setProductStatus(input.productId, input.status),
      onSuccess: settleProduct,
    }),
    retire: useMutation({ mutationFn: (productId: string) => hqBilling.retireProduct(productId), onSuccess: settleProduct }),
    reactivate: useMutation({ mutationFn: (productId: string) => hqBilling.reactivateProduct(productId), onSuccess: settleProduct }),
    reorder: useMutation({
      mutationFn: (ids: string[]) => hqBilling.reorderProducts(ids),
      onMutate: async (ids) => {
        // Optimistic: the list re-sorts immediately; the server order wins on settle.
        await client.cancelQueries({ queryKey: [...base, 'catalog'], exact: true });
        const previous = client.getQueryData<HqCatalogResponse>([...base, 'catalog']);
        if (previous) {
          const position = new Map(ids.map((id, index) => [id, index]));
          client.setQueryData<HqCatalogResponse>([...base, 'catalog'], {
            ...previous,
            products: [...previous.products].sort(
              (a, b) => (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER),
            ),
          });
        }
        return { previous };
      },
      onError: (_error, _ids, context) => {
        if (context?.previous) client.setQueryData([...base, 'catalog'], context.previous);
      },
      onSettled: invalidate,
    }),
    uploadImage: useMutation({
      mutationFn: (input: { productId: string; file: File; onProgress?: (fraction: number) => void }) =>
        uploadProductImage(input.productId, input.file, input.onProgress).then((product) => ({ product })),
      onSuccess: settleProduct,
    }),
    removeImage: useMutation({
      mutationFn: (input: { productId: string; imageId: string }) => hqBilling.removeProductImage(input.productId, input.imageId),
      onSuccess: settleProduct,
    }),
    setDefaultImage: useMutation({
      mutationFn: (input: { productId: string; imageId: string }) => hqBilling.setDefaultProductImage(input.productId, input.imageId),
      onSuccess: settleProduct,
    }),
    settings: useMutation({
      mutationFn: (body: Omit<BillingSettings, 'updated_at' | 'version' | 'weekly_paid_orders'> & { expected_version: number }) => hqBilling.updateSettings(body),
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
