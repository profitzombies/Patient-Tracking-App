/**
 * Typed client for the provider payments API (docs/billing-connect/SPEC.md §6).
 *
 * Office calls ride `officeRequest` (server-derived office scope, `?office=`
 * for HQ drill-ins). HQ calls use the same bearer contract. Public calls send
 * no bearer at all. URLs are root-relative because the operations web app is
 * the root artifact.
 */
import { officeRequest, officeQuery, OfficeApiError, type OfficeRequestMessages } from '@/lib/office-api';
import type {
  AccountSessionResponse,
  BillingSettings,
  CatalogChange,
  CatalogProduct,
  CatalogProductInput,
  ConnectedAccount,
  FulfillmentUpdate,
  HqCatalogResponse,
  HqOverview,
  HqProviderDetail,
  HqProviderRow,
  OfficeBillingStatus,
  OfficeDashboard,
  OfficePayoutsResponse,
  OfficePrice,
  OfficePricesResponse,
  OrderDetail,
  OrderSummary,
  Paged,
  PatientSearchHit,
  PaymentLink,
  PublicLink,
  PublicOrderRequest,
  PublicOrderResponse,
  PublicOrderStatus,
  PublicSubscription,
  SubscriptionRow,
} from '@/lib/billing-types';

export { OfficeApiError as BillingApiError };

const MESSAGES: OfficeRequestMessages = {
  unconfigured: 'Live payments are not configured in this environment.',
  signedOut: 'Your session has ended. Sign in again to continue.',
  unreachable: 'Could not reach the payments service. Check your connection and try again.',
  failed: 'The payments request failed',
};

function qs(params: Record<string, string | number | null | undefined>, office?: string | null): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  return officeQuery(office, search);
}

const OFFICE = '/api/billing/office';
const HQ = '/api/billing/hq';
const PUBLIC = '/api/billing/public';

export type ListFilters = Record<string, string | number | null | undefined>;

// ---------------- office ----------------

export const officeBilling = {
  status: (office?: string | null) =>
    officeRequest<OfficeBillingStatus>(`${OFFICE}/status${qs({}, office)}`, MESSAGES),
  createAccount: (office?: string | null) =>
    officeRequest<{ account: ConnectedAccount }>(`${OFFICE}/connect/create${qs({}, office)}`, MESSAGES, { method: 'POST', body: '{}' }),
  oauthStart: (office?: string | null) =>
    officeRequest<{ url: string }>(`${OFFICE}/connect/oauth/start${qs({}, office)}`, MESSAGES),
  accountSession: (components: string[], office?: string | null) =>
    officeRequest<AccountSessionResponse>(`${OFFICE}/connect/account-session${qs({}, office)}`, MESSAGES, {
      method: 'POST',
      body: JSON.stringify({ components }),
    }),
  sync: (office?: string | null) =>
    officeRequest<{ account: ConnectedAccount }>(`${OFFICE}/connect/sync${qs({}, office)}`, MESSAGES, { method: 'POST', body: '{}' }),
  dashboard: (range: { from?: string; to?: string }, office?: string | null) =>
    officeRequest<OfficeDashboard>(`${OFFICE}/dashboard${qs(range, office)}`, MESSAGES),
  prices: (office?: string | null) =>
    officeRequest<OfficePricesResponse>(`${OFFICE}/prices${qs({}, office)}`, MESSAGES),
  updatePrice: (
    productId: string,
    body: { sell_price_cents: number | null; subscription_enabled: boolean },
    office?: string | null,
  ) =>
    officeRequest<{ product: OfficePrice }>(`${OFFICE}/prices/${encodeURIComponent(productId)}${qs({}, office)}`, MESSAGES, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  links: (office?: string | null) => officeRequest<{ items: PaymentLink[] }>(`${OFFICE}/links${qs({}, office)}`, MESSAGES),
  createLink: (body: { patient_id?: string | null; label?: string | null }, office?: string | null) =>
    officeRequest<{ link: PaymentLink }>(`${OFFICE}/links${qs({}, office)}`, MESSAGES, { method: 'POST', body: JSON.stringify(body) }),
  deactivateLink: (linkId: string, office?: string | null) =>
    officeRequest<{ link: PaymentLink }>(`${OFFICE}/links/${encodeURIComponent(linkId)}${qs({}, office)}`, MESSAGES, { method: 'DELETE' }),
  orders: (filters: ListFilters, office?: string | null) =>
    officeRequest<Paged<OrderSummary>>(`${OFFICE}/orders${qs(filters, office)}`, MESSAGES),
  order: (orderId: string, office?: string | null) =>
    officeRequest<OrderDetail>(`${OFFICE}/orders/${encodeURIComponent(orderId)}${qs({}, office)}`, MESSAGES),
  refund: (orderId: string, body: { amount_cents?: number; reason: string }, office?: string | null) =>
    officeRequest<{ order: OrderDetail }>(`${OFFICE}/orders/${encodeURIComponent(orderId)}/refund${qs({}, office)}`, MESSAGES, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  subscriptions: (filters: ListFilters, office?: string | null) =>
    officeRequest<Paged<SubscriptionRow>>(`${OFFICE}/subscriptions${qs(filters, office)}`, MESSAGES),
  cancelSubscription: (subscriptionId: string, body: { at_period_end: boolean }, office?: string | null) =>
    officeRequest<{ subscription: SubscriptionRow }>(
      `${OFFICE}/subscriptions/${encodeURIComponent(subscriptionId)}/cancel${qs({}, office)}`,
      MESSAGES,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  payouts: (office?: string | null) => officeRequest<OfficePayoutsResponse>(`${OFFICE}/payouts${qs({}, office)}`, MESSAGES),
  searchPatients: (q: string, office?: string | null) =>
    officeRequest<{ items: PatientSearchHit[] }>(`${OFFICE}/patients/search${qs({ q }, office)}`, MESSAGES),
};

// ---------------- HQ ----------------

export const hqBilling = {
  overview: (range: { from?: string; to?: string }) => officeRequest<HqOverview>(`${HQ}/overview${qs(range)}`, MESSAGES),
  providers: () => officeRequest<{ items: HqProviderRow[] }>(`${HQ}/providers`, MESSAGES),
  provider: (providerId: string) => officeRequest<HqProviderDetail>(`${HQ}/providers/${encodeURIComponent(providerId)}`, MESSAGES),
  transactions: (filters: ListFilters) => officeRequest<Paged<OrderSummary>>(`${HQ}/transactions${qs(filters)}`, MESSAGES),
  transaction: (orderId: string) => officeRequest<OrderDetail>(`${HQ}/transactions/${encodeURIComponent(orderId)}`, MESSAGES),
  refund: (orderId: string, body: { amount_cents?: number; reason: string }) =>
    officeRequest<{ order: OrderDetail }>(`${HQ}/transactions/${encodeURIComponent(orderId)}/refund`, MESSAGES, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  fulfillment: (filters: ListFilters) => officeRequest<Paged<OrderDetail>>(`${HQ}/fulfillment${qs(filters)}`, MESSAGES),
  updateFulfillment: (orderId: string, body: FulfillmentUpdate) =>
    officeRequest<{ order: OrderDetail }>(`${HQ}/fulfillment/${encodeURIComponent(orderId)}`, MESSAGES, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  catalog: () => officeRequest<HqCatalogResponse>(`${HQ}/catalog`, MESSAGES),
  createProduct: (body: CatalogProductInput) =>
    officeRequest<{ product: CatalogProduct }>(`${HQ}/catalog/products`, MESSAGES, { method: 'POST', body: JSON.stringify(body) }),
  updateProduct: (productId: string, body: Partial<CatalogProductInput>) =>
    officeRequest<{ product: CatalogProduct }>(`${HQ}/catalog/products/${encodeURIComponent(productId)}`, MESSAGES, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  retireProduct: (productId: string) =>
    officeRequest<{ product: CatalogProduct }>(`${HQ}/catalog/products/${encodeURIComponent(productId)}/retire`, MESSAGES, {
      method: 'POST',
      body: '{}',
    }),
  reactivateProduct: (productId: string) =>
    officeRequest<{ product: CatalogProduct }>(`${HQ}/catalog/products/${encodeURIComponent(productId)}/reactivate`, MESSAGES, {
      method: 'POST',
      body: '{}',
    }),
  updateSettings: (body: Omit<BillingSettings, 'updated_at' | 'version'> & { expected_version: number }) =>
    officeRequest<{ settings: BillingSettings }>(`${HQ}/catalog/settings`, MESSAGES, { method: 'PUT', body: JSON.stringify(body) }),
  changes: (filters: ListFilters) => officeRequest<Paged<CatalogChange>>(`${HQ}/catalog/changes${qs(filters)}`, MESSAGES),
  subscriptions: (filters: ListFilters) => officeRequest<Paged<SubscriptionRow>>(`${HQ}/subscriptions${qs(filters)}`, MESSAGES),
  cancelSubscription: (subscriptionId: string, body: { at_period_end: boolean }) =>
    officeRequest<{ subscription: SubscriptionRow }>(`${HQ}/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, MESSAGES, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ---------------- public (no session) ----------------

export class PublicBillingError extends Error {
  constructor(message: string, readonly status: number, readonly field: string | null = null) {
    super(message);
    this.name = 'PublicBillingError';
  }
}

async function publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new PublicBillingError('Could not reach the payment service. Check your connection and try again.', 0);
  }
  let body: { error?: unknown; field?: unknown } & Partial<T> = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Generic message below.
  }
  if (!response.ok) {
    throw new PublicBillingError(
      typeof body.error === 'string' ? body.error : `The payment request failed (${response.status}).`,
      response.status,
      typeof body.field === 'string' ? body.field : null,
    );
  }
  return body as T;
}

export const publicBilling = {
  config: () => publicRequest<{ sandbox: boolean }>(`${PUBLIC}/config`),
  link: (token: string) => publicRequest<PublicLink>(`${PUBLIC}/links/${encodeURIComponent(token)}`),
  createOrder: (token: string, body: PublicOrderRequest) =>
    publicRequest<PublicOrderResponse>(`${PUBLIC}/links/${encodeURIComponent(token)}/orders`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  orderStatus: (orderId: string, token: string) =>
    publicRequest<PublicOrderStatus>(`${PUBLIC}/orders/${encodeURIComponent(orderId)}/status?token=${encodeURIComponent(token)}`),
  subscription: (cancelToken: string) => publicRequest<PublicSubscription>(`${PUBLIC}/subscriptions/${encodeURIComponent(cancelToken)}`),
  cancelSubscription: (cancelToken: string) =>
    publicRequest<PublicSubscription>(`${PUBLIC}/subscriptions/${encodeURIComponent(cancelToken)}/cancel`, {
      method: 'POST',
      body: '{}',
    }),
};
