/**
 * Typed client for the OFFICE slice of the provider payments API, mirroring
 * the web app's `officeBilling` function list (artifacts/thinnr-operations
 * src/lib/billing-api.ts) one for one so both clients speak the same wire
 * contract.
 *
 * Every call rides the staff session bearer; the server derives the office
 * from the caller (the mobile app never sends `?office=`). Money writes that
 * must not double-charge (`saleCheckout`) carry an Idempotency-Key. Errors
 * surface as `OfficeBillingError` with the server's message and HTTP status
 * so screens can tell permission (403) and card declines (402) apart.
 */
import { officeBearerRequest, OfficeRosterError, type OfficeRequestScope } from '@/lib/office-roster-api';
import type {
  AccountSessionResponse,
  CartCheckoutResponse,
  CartLineInput,
  CartQuote,
  ConnectedAccount,
  HqActivityRow,
  HqTodayOverview,
  OfficeAppAccessSettings,
  OfficeAppAccessSettingsInput,
  OfficeBillingStatus,
  OfficeDashboard,
  OfficePayoutsResponse,
  OfficePrice,
  OfficePricesResponse,
  OfficeRefundRow,
  OrderDetail,
  OrderSummary,
  Paged,
  PatientPurchasesSummary,
  PatientSearchHit,
  PaymentLink,
  PaymentLinkInput,
  PaymentLinkUpdate,
  PrebuiltCart,
  ShippingAddress,
  StaffSaleContext,
  SubscriptionChangeInput,
  TapCancelResponse,
  TapCaptureResponse,
  TapSaleResponse,
  TerminalConnectionToken,
  SubscriptionChangeQuote,
  SubscriptionRow,
} from '@/lib/office-billing-types';
import type {
  OfficeAccessSetupIntent,
  OfficeAccessSlot,
  OfficeAccessSnapshot,
} from '@/lib/office-access-types';

export { OfficeRosterError as OfficeBillingError };

// apiBase() already ends in /api, so the prefix here is relative to it.
const OFFICE = '/billing/office';
const FAILED = 'The payments request failed';

export type ListFilters = Record<string, string | number | null | undefined>;

/** Identity scope for every call: the signed-in staff user (React Query keys are identity-scoped too). */
export interface BillingScope {
  userId: string;
  billingScope?: string;
  signal?: AbortSignal;
}

function qs(params: ListFilters): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  scope: BillingScope,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const requestScope: OfficeRequestScope = { userId: scope.userId, signal: scope.signal,
    headers: { ...headers, ...(scope.billingScope ? { 'X-Billing-Scope': scope.billingScope } : {}) }, failedMessage: FAILED };
  return officeBearerRequest<T>(method, path, body, requestScope);
}

const enc = encodeURIComponent;

export const officeBilling = {
  access: (scope: BillingScope) =>
    request<OfficeAccessSnapshot>('GET', `${OFFICE}/access`, scope),
  accessSetupIntent: (slot: OfficeAccessSlot, scope: BillingScope) =>
    request<OfficeAccessSetupIntent>('POST', `${OFFICE}/access/setup-intent`, scope, { slot }),
  accessInstrument: (
    body: { slot: OfficeAccessSlot; paymentMethodId: string; setupIntentId?: string },
    scope: BillingScope,
  ) => request<OfficeAccessSnapshot>('POST', `${OFFICE}/access/instruments`, scope, body),
  accessVerifyBank: (scope: BillingScope) =>
    request<{ verified: boolean; setup: OfficeAccessSnapshot }>('POST', `${OFFICE}/access/bank/verify`, scope, {}),
  accessPay: (scope: BillingScope) =>
    request<{ status: string; setup: OfficeAccessSnapshot }>('POST', `${OFFICE}/access/pay`, scope, {}),
  status: (scope: BillingScope) => request<OfficeBillingStatus>('GET', `${OFFICE}/status`, scope),
  createAccount: (scope: BillingScope) => request<{ account: ConnectedAccount }>('POST', `${OFFICE}/connect/create`, scope, {}),
  oauthStart: (scope: BillingScope) => request<{ url: string }>('GET', `${OFFICE}/connect/oauth/start`, scope),
  accountSession: (components: string[], scope: BillingScope) =>
    request<AccountSessionResponse>('POST', `${OFFICE}/connect/account-session`, scope, { components }),
  sync: (scope: BillingScope) => request<{ account: ConnectedAccount }>('POST', `${OFFICE}/connect/sync`, scope, {}),
  dashboard: (range: { from?: string; to?: string }, scope: BillingScope) =>
    request<OfficeDashboard>('GET', `${OFFICE}/dashboard${qs(range)}`, scope),
  prices: (scope: BillingScope) => request<OfficePricesResponse>('GET', `${OFFICE}/prices`, scope),
  updatePrice: (productId: string, body: { sell_price_cents: number | null; subscription_enabled: boolean }, scope: BillingScope) =>
    request<{ product: OfficePrice }>('PUT', `${OFFICE}/prices/${enc(productId)}`, scope, body),
  appAccess: (scope: BillingScope) => request<OfficeAppAccessSettings>('GET', `${OFFICE}/app-access`, scope),
  updateAppAccess: (body: OfficeAppAccessSettingsInput, scope: BillingScope) =>
    request<OfficeAppAccessSettings>('PUT', `${OFFICE}/app-access`, scope, body),
  links: (scope: BillingScope) => request<{ items: PaymentLink[] }>('GET', `${OFFICE}/links`, scope),
  createLink: (body: PaymentLinkInput, scope: BillingScope) => request<{ link: PaymentLink }>('POST', `${OFFICE}/links`, scope, body),
  updateLink: (linkId: string, body: PaymentLinkUpdate, scope: BillingScope) =>
    request<{ link: PaymentLink }>('PATCH', `${OFFICE}/links/${enc(linkId)}`, scope, body),
  deactivateLink: (linkId: string, scope: BillingScope) => request<{ link: PaymentLink }>('DELETE', `${OFFICE}/links/${enc(linkId)}`, scope),
  orders: (filters: ListFilters, scope: BillingScope) => request<Paged<OrderSummary>>('GET', `${OFFICE}/orders${qs(filters)}`, scope),
  order: (orderId: string, scope: BillingScope) => request<OrderDetail>('GET', `${OFFICE}/orders/${enc(orderId)}`, scope),
  refund: (orderId: string, body: { amount_cents?: number; reason: string }, scope: BillingScope) =>
    request<{ order: OrderDetail }>('POST', `${OFFICE}/orders/${enc(orderId)}/refund`, scope, body),
  subscriptions: (filters: ListFilters, scope: BillingScope) =>
    request<Paged<SubscriptionRow>>('GET', `${OFFICE}/subscriptions${qs(filters)}`, scope),
  /** One patient's purchases at this office (the patient record's Purchases panel). */
  patientPurchases: (patientId: string, scope: BillingScope) =>
    request<PatientPurchasesSummary>('GET', `${OFFICE}/patients/${enc(patientId)}/summary`, scope),
  cancelSubscription: (subscriptionId: string, body: { at_period_end: boolean }, scope: BillingScope) =>
    request<{ subscription: SubscriptionRow }>('POST', `${OFFICE}/subscriptions/${enc(subscriptionId)}/cancel`, scope, body),
  retrySubscriptionPayment: (subscriptionId: string, scope: BillingScope) =>
    request<{ subscription: SubscriptionRow }>('POST', `${OFFICE}/subscriptions/${enc(subscriptionId)}/retry-payment`, scope, {}),
  resendSubscriptionPaymentEmail: (subscriptionId: string, scope: BillingScope) =>
    request<{ subscription: SubscriptionRow }>('POST', `${OFFICE}/subscriptions/${enc(subscriptionId)}/resend-payment-email`, scope, {}),
  pauseSubscription: (subscriptionId: string, scope: BillingScope) =>
    request<{ subscription: SubscriptionRow }>('POST', `${OFFICE}/subscriptions/${enc(subscriptionId)}/pause`, scope, {}),
  resumeSubscription: (subscriptionId: string, scope: BillingScope) =>
    request<{ subscription: SubscriptionRow }>('POST', `${OFFICE}/subscriptions/${enc(subscriptionId)}/resume`, scope, {}),
  subscriptionChangeQuote: (subscriptionId: string, productId: string, scope: BillingScope) =>
    request<SubscriptionChangeQuote>('GET', `${OFFICE}/subscriptions/${enc(subscriptionId)}/change-quote${qs({ product_id: productId })}`, scope),
  changeSubscription: (subscriptionId: string, body: SubscriptionChangeInput, scope: BillingScope) =>
    request<{ subscription: SubscriptionRow }>('POST', `${OFFICE}/subscriptions/${enc(subscriptionId)}/change`, scope, body),
  payouts: (scope: BillingScope) => request<OfficePayoutsResponse>('GET', `${OFFICE}/payouts`, scope),
  today: (tz: string, scope: BillingScope) => request<HqTodayOverview>('GET', `${OFFICE}/overview/today${qs({ tz })}`, scope),
  activity: (filters: ListFilters, scope: BillingScope) => request<Paged<HqActivityRow>>('GET', `${OFFICE}/activity${qs(filters)}`, scope),
  refunds: (filters: ListFilters, scope: BillingScope) => request<Paged<OfficeRefundRow>>('GET', `${OFFICE}/refunds${qs(filters)}`, scope),
  fulfillment: (filters: ListFilters, scope: BillingScope) => request<Paged<OrderDetail>>('GET', `${OFFICE}/fulfillment${qs(filters)}`, scope),
  searchPatients: (q: string, scope: BillingScope) => request<{ items: PatientSearchHit[] }>('GET', `${OFFICE}/patients/search${qs({ q })}`, scope),
  saleContext: (patientId: string, scope: BillingScope) =>
    request<StaffSaleContext>('GET', `${OFFICE}/sales/context${qs({ patient_id: patientId })}`, scope),
  saleQuote: (body: { patient_id: string; lines: CartLineInput[]; shipping_address?: ShippingAddress; shipping_method?: CartQuote['shipping_method'] }, scope: BillingScope) =>
    request<CartQuote>('POST', `${OFFICE}/sales/quote`, scope, body),
  saleCheckout: (
    body: { patient_id: string; lines: CartLineInput[]; shipping_address: ShippingAddress; shipping_method?: CartQuote['shipping_method']; payment_method_id: string; cart_id: string; expected_total_cents?: number },
    scope: BillingScope,
    idempotencyKey?: string,
  ) => request<CartCheckoutResponse>('POST', `${OFFICE}/sales`, scope, body, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined),
  createCart: (body: { patient_id?: string; lines: CartLineInput[]; label?: string; expires_in_minutes?: number }, scope: BillingScope) =>
    request<PrebuiltCart>('POST', `${OFFICE}/carts`, scope, body),
  cart: (id: string, scope: BillingScope) => request<PrebuiltCart>('GET', `${OFFICE}/carts/${enc(id)}`, scope),
  listCarts: (params: { patient_id?: string; status?: string }, scope: BillingScope) =>
    request<{ items: PrebuiltCart[] }>('GET', `${OFFICE}/carts${qs(params)}`, scope),
  revokeCart: (id: string, scope: BillingScope) => request<PrebuiltCart>('POST', `${OFFICE}/carts/${enc(id)}/revoke`, scope, {}),
  // Tap to Pay: the phone is the card reader. Tokens are short-lived and minted
  // per connected account; the sale itself keys on the same cart id as a card sale.
  terminalConnectionToken: (scope: BillingScope) => request<TerminalConnectionToken>('POST', `${OFFICE}/terminal/connection-token`, scope, {}),
  tapSale: (
    body: { patient_id: string; lines: CartLineInput[]; shipping_address: ShippingAddress; shipping_method?: CartQuote['shipping_method']; cart_id: string; expected_total_cents?: number },
    scope: BillingScope,
    idempotencyKey?: string,
  ) => request<TapSaleResponse>('POST', `${OFFICE}/sales/tap`, scope, body, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined),
  tapCapture: (cartId: string, orderId: string, scope: BillingScope) =>
    request<TapCaptureResponse>('POST', `${OFFICE}/sales/tap/${enc(cartId)}/capture`, scope, { order_id: orderId }),
  tapCancel: (cartId: string, body: { reason: 'declined' | 'canceled' | 'fallback'; message?: string | null }, scope: BillingScope) =>
    request<TapCancelResponse>('POST', `${OFFICE}/sales/tap/${enc(cartId)}/cancel`, scope, body),
  tapCardOnFile: (cartId: string, body: { subscription_id: string; payment_method_id: string }, scope: BillingScope) =>
    request<{ saved: true }>('POST', `${OFFICE}/sales/tap/${enc(cartId)}/card-on-file`, scope, body),
};

export type OfficeBillingClient = typeof officeBilling;
