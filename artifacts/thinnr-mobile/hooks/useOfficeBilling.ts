/**
 * React Query hooks for the provider app's Payments area (office billing).
 *
 * Every key is identity-scoped (`['office-billing', userId, ...]`) so a
 * sign-out/sign-in never shows the previous account's money, and the
 * `BillingScope` handed to the client carries the same userId plus the query
 * signal so a superseded request can never refresh under a new bearer.
 *
 * Mirrors the web app's hooks/use-billing.ts office hooks: same stale times,
 * same retry rule (never retry a 403, at most two transient retries), same
 * one-minute refresh on today's running totals.
 */
import { useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseMutationOptions, type UseQueryOptions } from '@tanstack/react-query';
import { officeBilling, OfficeBillingError, type BillingScope, type ListFilters } from '@/lib/office-billing-api';

export const OFFICE_BILLING_KEY = 'office-billing';

export function officeBillingKey(userId: string): readonly unknown[] {
  return [OFFICE_BILLING_KEY, userId] as const;
}

export function billingRetry(count: number, error: unknown): boolean {
  if (error instanceof OfficeBillingError && (error.status === 403 || error.status === 401 || error.status === 402)) return false;
  return count < 2;
}

/**
 * Backoff between transient retries (1s, 2s). The verify suites shrink it
 * so error branches settle in milliseconds; the app never changes it.
 */
let retryBaseMs = 1000;
export function setBillingRetryBaseMs(ms: number): void { retryBaseMs = ms; }
export function billingRetryDelay(attempt: number): number { return retryBaseMs * 2 ** attempt; }

type Opts<T> = Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'>;

function scoped<T>(userId: string, key: unknown[], run: (scope: BillingScope) => Promise<T>, options?: Opts<T>) {
  return useQuery<T, Error>({
    queryKey: [...officeBillingKey(userId), ...key],
    queryFn: ({ signal }) => run({ userId, signal }),
    retry: billingRetry,
    retryDelay: billingRetryDelay,
    ...options,
  });
}

export function useOfficeBillingStatus(userId: string, options?: Opts<Awaited<ReturnType<typeof officeBilling.status>>>) {
  return scoped(userId, ['status'], (scope) => officeBilling.status(scope), { staleTime: 30_000, ...options });
}

/** Shared by the provider admission gate and the payment-method manager. */
export function useOfficeAccess(
  userId: string,
  options?: Opts<Awaited<ReturnType<typeof officeBilling.access>>>,
) {
  return scoped(userId, ['access'], (scope) => officeBilling.access(scope), {
    staleTime: 30_000,
    ...options,
  });
}

export function useOfficeDashboard(userId: string, range: { from?: string; to?: string }) {
  return scoped(userId, ['dashboard', range.from ?? null, range.to ?? null], (scope) => officeBilling.dashboard(range, scope));
}

export function useOfficeToday(userId: string, tz: string) {
  return scoped(userId, ['overview-today', tz], (scope) => officeBilling.today(tz, scope), { refetchInterval: 60_000 });
}

export function useOfficePrices(userId: string) {
  return scoped(userId, ['prices'], (scope) => officeBilling.prices(scope));
}

export function useOfficeLinks(userId: string) {
  return scoped(userId, ['links'], (scope) => officeBilling.links(scope));
}

export function useOfficeOrders(userId: string, filters: ListFilters) {
  return scoped(userId, ['orders', filters], (scope) => officeBilling.orders(filters, scope));
}

/** Cursor-paged office orders; subsequent pages use the opaque server cursor. */
export function useOfficeOrdersInfinite(userId: string, filters: ListFilters) {
  return useInfiniteQuery({
    queryKey: [...officeBillingKey(userId), 'orders-infinite', filters],
    queryFn: ({ pageParam, signal }) =>
      officeBilling.orders(
        { ...filters, ...(pageParam ? { cursor: pageParam } : {}) },
        { userId, signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    retry: billingRetry,
    retryDelay: billingRetryDelay,
  });
}

export function useOfficeOrder(userId: string, orderId: string) {
  return scoped(userId, ['order', orderId], (scope) => officeBilling.order(orderId, scope));
}

export function useOfficeSubscriptions(userId: string, filters: ListFilters) {
  return scoped(userId, ['subscriptions', filters], (scope) => officeBilling.subscriptions(filters, scope));
}

export function useOfficePayouts(userId: string) {
  return scoped(userId, ['payouts'], (scope) => officeBilling.payouts(scope));
}

/** Cursor-paged activity feed (Load more appends pages), same as the web hook. */
export function useOfficeActivity(userId: string, filters: ListFilters) {
  return useInfiniteQuery({
    queryKey: [...officeBillingKey(userId), 'activity', filters],
    queryFn: ({ pageParam, signal }) =>
      officeBilling.activity({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }, { userId, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    retry: billingRetry,
    retryDelay: billingRetryDelay,
  });
}

export function useOfficeRefunds(userId: string, filters: ListFilters) {
  return scoped(userId, ['refunds', filters], (scope) => officeBilling.refunds(filters, scope));
}

export function useOfficeFulfillment(userId: string, filters: ListFilters) {
  return scoped(userId, ['fulfillment', filters], (scope) => officeBilling.fulfillment(filters, scope));
}

/** Cursor-paged fulfillment queue; subsequent pages use the opaque server cursor. */
export function useOfficeFulfillmentInfinite(userId: string, filters: ListFilters) {
  return useInfiniteQuery({
    queryKey: [...officeBillingKey(userId), 'fulfillment-infinite', filters],
    queryFn: ({ pageParam, signal }) =>
      officeBilling.fulfillment(
        { ...filters, ...(pageParam ? { cursor: pageParam } : {}) },
        { userId, signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    retry: billingRetry,
    retryDelay: billingRetryDelay,
  });
}

export function useOfficeSaleContext(userId: string, patientId: string) {
  return scoped(userId, ['sale-context', patientId], (scope) => officeBilling.saleContext(patientId, scope));
}

export function useOfficePatientPurchases(userId: string, patientId: string) {
  return scoped(userId, ['patient-purchases', patientId], (scope) => officeBilling.patientPurchases(patientId, scope));
}

/**
 * On-demand re-read for the screen's header Refresh / pull-to-refresh: every
 * active office-billing query for this identity (the page's list or detail,
 * plus the billing status) refetches through our API. Cached data stays in
 * place while the reads are in flight; a failed read resolves with its error
 * so the screen can show a non-blocking notice instead of an error state.
 */
export function useRefreshOfficeBilling(userId: string) {
  const client = useQueryClient();
  return useCallback(async (): Promise<Error | null> => {
    const queryKey = officeBillingKey(userId);
    await client.refetchQueries({ queryKey, type: 'active' });
    const failed = client.getQueryCache().findAll({ queryKey, type: 'active' }).find((query) => query.state.status === 'error');
    if (!failed) return null;
    const error = failed.state.error;
    return error instanceof Error ? error : new Error('The refresh did not complete.');
  }, [client, userId]);
}

/** Drops every cached office-billing read for this identity (after any write). */
export function useInvalidateOfficeBilling(userId: string) {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: officeBillingKey(userId) }), [client, userId]);
}

/**
 * A write against the office billing API. The mutation function receives the
 * identity scope; on success every office-billing read is invalidated (unless
 * the caller opts out to patch the cache itself).
 */
export function useOfficeBillingMutation<TData, TVariables = void>(
  userId: string,
  run: (variables: TVariables, scope: BillingScope) => Promise<TData>,
  options?: Omit<UseMutationOptions<TData, Error, TVariables>, 'mutationFn'> & { invalidate?: boolean },
) {
  const invalidate = useInvalidateOfficeBilling(userId);
  const { invalidate: shouldInvalidate = true, onSuccess, ...rest } = options ?? {};
  return useMutation<TData, Error, TVariables>({
    mutationFn: (variables) => run(variables, { userId }),
    onSuccess: (data, variables, context, mutation) => {
      if (shouldInvalidate) void invalidate();
      return onSuccess?.(data, variables, context, mutation);
    },
    ...rest,
  });
}
