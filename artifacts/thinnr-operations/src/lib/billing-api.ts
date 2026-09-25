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
  AiCostSummary,
  BillingSettings,
  BillingModeStatus,
  CatalogChange,
  CatalogProduct,
  CatalogProductDetail,
  CatalogProductInput,
  ProductStatus,
  ConnectedAccount,
  CustomerEmail,
  CustomerEmailList,
  CustomerEmailPreview,
  CustomerEmailSendResult,
  FulfillmentUpdate,
  HqCatalogResponse,
  HqActivityRow,
  HqOverview,
  HqTodayOverview,
  HqProviderDetail,
  HqProviderRow,
  OfficeBillingStatus,
  OfficeDashboard,
  OfficePayoutsResponse,
  OfficePrice,
  OfficePricesResponse,
  OfficeRefundRow,
  OfficeShippingSettings,
  OfficeAccessSnapshot,
  OfficeAccessSetupIntent,
  OfficeAccessSlot,
  NotificationContactChange,
  NotificationContactsResponse,
  OfficeAccessBoard,
  OfficeAccessChange,
  OfficeAccessDetail,
  OfficeAccessPlan,
  PaidThroughSource,
  OrderDetail,
  OrderSummary,
  Paged,
  PatientPurchasesSummary,
  PatientSearchHit,
  PaymentLink,
  PaymentsHealth,
  PublicLink,
  PublicOrderRequest,
  PublicOrderResponse,
  PublicOrderStatus,
  PaymentLinkInput,
  PaymentLinkUpdate,
  PublicSubscription,
  SubscriptionChangeInput,
  SubscriptionChangeQuote,
  SubscriptionRow,
  CartLineInput,
  CartQuote,
  CartCheckoutResponse,
  PrebuiltCart,
  PublicCartDetails,
  PublicCartPeek,
  PublicCartStatus,
  ShippingAddress,
  StaffSaleContext,
  WarehouseSync,
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
const HQ_ACCESS = '/api/hq/office-access';
const PUBLIC = '/api/billing/public';

export type ListFilters = Record<string, string | number | null | undefined>;

// ---------------- customer email ledger (shared by office and HQ) ----------------

function emailLedger(root: string) {
  const email = (emailId: string) => `${root}/emails/${encodeURIComponent(emailId)}`;
  const contacts = (payerId: string) => `${root}/payers/${encodeURIComponent(payerId)}/contacts`;
  return {
    /** Office: one of order_id / payer_id / patient_id / subscription_id is required. HQ: free-text `q` and office/date filters. */
    emails: (filters: ListFilters, office?: string | null) =>
      officeRequest<CustomerEmailList>(`${root}/emails${qs(filters, office)}`, MESSAGES),
    email: (emailId: string, office?: string | null) =>
      officeRequest<{ email: CustomerEmail }>(`${email(emailId)}${qs({}, office)}`, MESSAGES),
    emailPreview: (emailId: string, office?: string | null) =>
      officeRequest<CustomerEmailPreview>(`${email(emailId)}/preview${qs({}, office)}`, MESSAGES),
    resendEmail: (emailId: string, office?: string | null) =>
      officeRequest<CustomerEmailSendResult>(`${email(emailId)}/resend${qs({}, office)}`, MESSAGES, { method: 'POST', body: '{}' }),
    sendEmailTo: (emailId: string, to: string, office?: string | null) =>
      officeRequest<CustomerEmailSendResult>(`${email(emailId)}/send-to${qs({}, office)}`, MESSAGES, { method: 'POST', body: JSON.stringify({ email: to }) }),
    contacts: (payerId: string, office?: string | null) =>
      officeRequest<NotificationContactsResponse>(`${contacts(payerId)}${qs({}, office)}`, MESSAGES),
    addContact: (payerId: string, body: { email: string; label?: string | null }, office?: string | null) =>
      officeRequest<NotificationContactChange>(`${contacts(payerId)}${qs({}, office)}`, MESSAGES, { method: 'POST', body: JSON.stringify(body) }),
    removeContact: (payerId: string, contactId: string, office?: string | null) =>
      officeRequest<NotificationContactChange>(`${contacts(payerId)}/${encodeURIComponent(contactId)}${qs({}, office)}`, MESSAGES, { method: 'DELETE' }),
  };
}

/** Every HQ office-access write answers with the refreshed terms, so they share one shape. */
function accessAction(providerId: string, action: string, body: Record<string, unknown>) {
  return officeRequest<OfficeAccessChange>(`${HQ_ACCESS}/${encodeURIComponent(providerId)}/${action}`, MESSAGES, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ---------------- office ----------------

export const officeBilling = {
  ...emailLedger(OFFICE),
  status: (office?: string | null) =>
    officeRequest<OfficeBillingStatus>(`${OFFICE}/status${qs({}, office)}`, MESSAGES),
  access: (office?: string | null) =>
    officeRequest<OfficeAccessSnapshot>(`${OFFICE}/access${qs({}, office)}`, MESSAGES),
  accessSetupIntent: (slot: OfficeAccessSlot, office?: string | null) =>
    officeRequest<OfficeAccessSetupIntent>(`${OFFICE}/access/setup-intent${qs({}, office)}`, MESSAGES, { method: 'POST', body: JSON.stringify({ slot }) }),
  accessInstrument: (body: { slot: OfficeAccessSlot; paymentMethodId: string; setupIntentId?: string }, office?: string | null) =>
    officeRequest<OfficeAccessSnapshot>(`${OFFICE}/access/instruments${qs({}, office)}`, MESSAGES, { method: 'POST', body: JSON.stringify(body) }),
  accessPlan: (plan: 'monthly' | 'yearly', office?: string | null) =>
    officeRequest<OfficeAccessSnapshot>(`${OFFICE}/access/plan${qs({}, office)}`, MESSAGES, { method: 'POST', body: JSON.stringify({ plan }) }),
  accessDisclosure: (version: number, office?: string | null) =>
    officeRequest<OfficeAccessSnapshot>(`${OFFICE}/access/disclosure${qs({}, office)}`, MESSAGES, { method: 'POST', body: JSON.stringify({ version }) }),
  accessBankVerify: (office?: string | null) =>
    officeRequest<{ verified: boolean; setup: OfficeAccessSnapshot }>(`${OFFICE}/access/bank/verify${qs({}, office)}`, MESSAGES, { method: 'POST', body: '{}' }),
  accessPay: (office?: string | null) =>
    officeRequest<{ status: string; setup: OfficeAccessSnapshot }>(`${OFFICE}/access/pay${qs({}, office)}`, MESSAGES, { method: 'POST', body: '{}' }),
  createAccount: (billingScope: string, office?: string | null) =>
    officeRequest<{ account: ConnectedAccount }>(`${OFFICE}/connect/create${qs({}, office)}`, MESSAGES, { method: 'POST', body: '{}', headers: { 'X-Billing-Scope': billingScope } }),
  /** Discard an unfinished Stripe setup. The server refuses (409) once the account has financial history. */
  restartConnect: (billingScope: string, office?: string | null) =>
    officeRequest<{ restarted: boolean }>(`${OFFICE}/connect/restart${qs({}, office)}`, MESSAGES, { method: 'POST', body: '{}', headers: { 'X-Billing-Scope': billingScope } }),
  oauthStart: (billingScope: string, office?: string | null) =>
    officeRequest<{ url: string }>(`${OFFICE}/connect/oauth/start${qs({}, office)}`, MESSAGES, { headers: { 'X-Billing-Scope': billingScope } }),
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
  settings: (office?: string | null) =>
    officeRequest<OfficeShippingSettings>(`${OFFICE}/settings${qs({}, office)}`, MESSAGES),
  updateSettings: (body: { pick_pack_pass_through: boolean | null; expected_version: number }, office?: string | null) =>
    officeRequest<OfficeShippingSettings>(`${OFFICE}/settings${qs({}, office)}`, MESSAGES, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
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
  createLink: (body: PaymentLinkInput, office?: string | null) =>
    officeRequest<{ link: PaymentLink }>(`${OFFICE}/links${qs({}, office)}`, MESSAGES, { method: 'POST', body: JSON.stringify(body) }),
  updateLink: (linkId: string, body: PaymentLinkUpdate, office?: string | null) =>
    officeRequest<{ link: PaymentLink }>(`${OFFICE}/links/${encodeURIComponent(linkId)}${qs({}, office)}`, MESSAGES, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
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
  /** One patient's purchases at this office (the patient record's Purchases panel). */
  patientPurchases: (patientId: string, office?: string | null) =>
    officeRequest<PatientPurchasesSummary>(`${OFFICE}/patients/${encodeURIComponent(patientId)}/summary${qs({}, office)}`, MESSAGES),
  cancelSubscription: (subscriptionId: string, body: { at_period_end: boolean }, office?: string | null) =>
    officeRequest<{ subscription: SubscriptionRow }>(
      `${OFFICE}/subscriptions/${encodeURIComponent(subscriptionId)}/cancel${qs({}, office)}`,
      MESSAGES,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  retrySubscriptionPayment: (subscriptionId: string, office?: string | null) =>
    officeRequest<{ subscription: SubscriptionRow }>(
      `${OFFICE}/subscriptions/${encodeURIComponent(subscriptionId)}/retry-payment${qs({}, office)}`,
      MESSAGES, { method: 'POST', body: '{}' },
    ),
  resendSubscriptionPaymentEmail: (subscriptionId: string, office?: string | null) =>
    officeRequest<{ subscription: SubscriptionRow }>(
      `${OFFICE}/subscriptions/${encodeURIComponent(subscriptionId)}/resend-payment-email${qs({}, office)}`,
      MESSAGES, { method: 'POST', body: '{}' },
    ),
  pauseSubscription: (subscriptionId: string, office?: string | null) =>
    officeRequest<{ subscription: SubscriptionRow }>(
      `${OFFICE}/subscriptions/${encodeURIComponent(subscriptionId)}/pause${qs({}, office)}`,
      MESSAGES, { method: 'POST', body: '{}' },
    ),
  resumeSubscription: (subscriptionId: string, office?: string | null) =>
    officeRequest<{ subscription: SubscriptionRow }>(
      `${OFFICE}/subscriptions/${encodeURIComponent(subscriptionId)}/resume${qs({}, office)}`,
      MESSAGES, { method: 'POST', body: '{}' },
    ),
  subscriptionChangeQuote: (subscriptionId: string, productId: string, office?: string | null) =>
    officeRequest<SubscriptionChangeQuote>(
      `${OFFICE}/subscriptions/${encodeURIComponent(subscriptionId)}/change-quote${qs({ product_id: productId }, office)}`,
      MESSAGES,
    ),
  changeSubscription: (subscriptionId: string, body: SubscriptionChangeInput, office?: string | null) =>
    officeRequest<{ subscription: SubscriptionRow }>(
      `${OFFICE}/subscriptions/${encodeURIComponent(subscriptionId)}/change${qs({}, office)}`,
      MESSAGES, { method: 'POST', body: JSON.stringify(body) },
    ),
  payouts: (office?: string | null) => officeRequest<OfficePayoutsResponse>(`${OFFICE}/payouts${qs({}, office)}`, MESSAGES),
  today: (tz: string, office?: string | null) =>
    officeRequest<HqTodayOverview>(`${OFFICE}/overview/today${qs({ tz }, office)}`, MESSAGES),
  activity: (filters: ListFilters, office?: string | null) =>
    officeRequest<Paged<HqActivityRow>>(`${OFFICE}/activity${qs(filters, office)}`, MESSAGES),
  refunds: (filters: ListFilters, office?: string | null) =>
    officeRequest<Paged<OfficeRefundRow>>(`${OFFICE}/refunds${qs(filters, office)}`, MESSAGES),
  fulfillment: (filters: ListFilters, office?: string | null) =>
    officeRequest<Paged<OrderDetail>>(`${OFFICE}/fulfillment${qs(filters, office)}`, MESSAGES),
  searchPatients: (q: string, office?: string | null) =>
    officeRequest<{ items: PatientSearchHit[] }>(`${OFFICE}/patients/search${qs({ q }, office)}`, MESSAGES),
  saleContext: (patientId: string, office?: string | null) =>
    officeRequest<StaffSaleContext>(`${OFFICE}/sales/context${qs({ patient_id: patientId }, office)}`, MESSAGES),
  saleQuote: (body: { patient_id: string; lines: CartLineInput[] }, office?: string | null) =>
    officeRequest<CartQuote>(`${OFFICE}/sales/quote${qs({}, office)}`, MESSAGES, { method: 'POST', body: JSON.stringify(body) }),
  saleCheckout: (
    body: { patient_id: string; lines: CartLineInput[]; shipping_address: ShippingAddress; payment_method_id: string; cart_id: string },
    office?: string | null,
    idempotencyKey?: string,
    billingScope?: string,
  ) =>
    officeRequest<CartCheckoutResponse>(`${OFFICE}/sales${qs({}, office)}`, MESSAGES, {
      method: 'POST',
      headers: { ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), 'X-Billing-Scope': billingScope ?? '' },
      body: JSON.stringify(body),
    }),
  createCart: (body: { patient_id?: string; lines: CartLineInput[]; label?: string; expires_in_minutes?: number }, office?: string | null) =>
    officeRequest<PrebuiltCart>(`${OFFICE}/carts${qs({}, office)}`, MESSAGES, { method: 'POST', body: JSON.stringify(body) }),
  cart: (id: string, office?: string | null) =>
    officeRequest<PrebuiltCart>(`${OFFICE}/carts/${encodeURIComponent(id)}${qs({}, office)}`, MESSAGES),
  listCarts: (params: { patient_id?: string; status?: string }, office?: string | null) =>
    officeRequest<{ items: PrebuiltCart[] }>(`${OFFICE}/carts${qs(params, office)}`, MESSAGES),
  revokeCart: (id: string, office?: string | null) =>
    officeRequest<PrebuiltCart>(`${OFFICE}/carts/${encodeURIComponent(id)}/revoke${qs({}, office)}`, MESSAGES, { method: 'POST', body: '{}' }),
};

// ---------------- HQ ----------------

export const hqBilling = {
  ...emailLedger(HQ),
  mode: () => officeRequest<BillingModeStatus>(`${HQ}/mode`, MESSAGES),
  switchMode: (body: { mode: 'test' | 'live'; expected_version: number; confirm_live: boolean }) =>
    officeRequest<BillingModeStatus>(`${HQ}/mode`, MESSAGES, { method: 'PUT', body: JSON.stringify(body) }),
  health: () => officeRequest<PaymentsHealth>(`${HQ}/health`, MESSAGES),
  overview: (range: { from?: string; to?: string }) => officeRequest<HqOverview>(`${HQ}/overview${qs(range)}`, MESSAGES),
  aiCosts: (range: { from?: string; to?: string }) => officeRequest<AiCostSummary>(`${HQ}/ai-costs${qs(range)}`, MESSAGES),
  today: (tz: string) => officeRequest<HqTodayOverview>(`${HQ}/overview/today${qs({ tz })}`, MESSAGES),
  activity: (filters: ListFilters) => officeRequest<Paged<HqActivityRow>>(`${HQ}/activity${qs(filters)}`, MESSAGES),
  providers: () => officeRequest<{ items: HqProviderRow[] }>(`${HQ}/providers`, MESSAGES),
  provider: (providerId: string) => officeRequest<HqProviderDetail>(`${HQ}/providers/${encodeURIComponent(providerId)}`, MESSAGES),
  recordStripeCustomerEmails: (providerId: string, state: 'off' | 'on') =>
    officeRequest<{ account: ConnectedAccount }>(`${HQ}/providers/${encodeURIComponent(providerId)}/stripe-customer-emails`, MESSAGES, {
      method: 'PUT',
      body: JSON.stringify({ state }),
    }),
  // Office access subscriptions: what an office pays THINNR. These routes sit
  // under /api/hq/office-access, not the Connect-program /api/billing/hq tree.
  officeAccessBoard: () => officeRequest<OfficeAccessBoard>(`${HQ_ACCESS}`, MESSAGES),
  officeAccess: (providerId: string) =>
    officeRequest<OfficeAccessDetail>(`${HQ_ACCESS}/${encodeURIComponent(providerId)}`, MESSAGES),
  setIncludedPeriod: (providerId: string, body: { lifetime?: boolean; days?: number; endsAt?: string | null }) =>
    accessAction(providerId, 'included-period', body),
  resetAccessTrial: (providerId: string, body: { days?: number }) => accessAction(providerId, 'reset-trial', body),
  setAccessTerms: (providerId: string, body: { plan?: OfficeAccessPlan; priceCentsOverride?: number | null }) =>
    accessAction(providerId, 'terms', body),
  recordAccessPaidThrough: (providerId: string, body: { paidThrough: string; source: PaidThroughSource; note?: string }) =>
    accessAction(providerId, 'paid-through', body),
  recordAccessOfflinePayment: (providerId: string, body: { paidThrough: string; amountCents?: number; note?: string }) =>
    accessAction(providerId, 'offline-payment', body),
  transactions: (filters: ListFilters) => officeRequest<Paged<OrderSummary>>(`${HQ}/transactions${qs(filters)}`, MESSAGES),
  transaction: (orderId: string) => officeRequest<OrderDetail>(`${HQ}/transactions/${encodeURIComponent(orderId)}`, MESSAGES),
  refund: (orderId: string, body: { amount_cents?: number; reason: string }) =>
    officeRequest<{ order: OrderDetail }>(`${HQ}/transactions/${encodeURIComponent(orderId)}/refund`, MESSAGES, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  fulfillment: (filters: ListFilters) => officeRequest<Paged<OrderDetail>>(`${HQ}/fulfillment${qs(filters)}`, MESSAGES),
  updateFulfillment: (orderId: string, body: FulfillmentUpdate) =>
    officeRequest<{ order: OrderDetail; warehouse_sync?: WarehouseSync }>(`${HQ}/fulfillment/${encodeURIComponent(orderId)}`, MESSAGES, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  retryWarehouse: (orderId: string) =>
    officeRequest<{ order: OrderDetail }>(`${HQ}/fulfillment/${encodeURIComponent(orderId)}/warehouse-retry`, MESSAGES, { method: 'POST' }),
  catalog: () => officeRequest<HqCatalogResponse>(`${HQ}/catalog`, MESSAGES),
  product: (productId: string) =>
    officeRequest<{ product: CatalogProductDetail }>(`${HQ}/catalog/products/${encodeURIComponent(productId)}`, MESSAGES),
  createProduct: (body: CatalogProductInput) =>
    officeRequest<{ product: CatalogProductDetail }>(`${HQ}/catalog/products`, MESSAGES, { method: 'POST', body: JSON.stringify(body) }),
  updateProduct: (productId: string, body: Partial<CatalogProductInput>) =>
    officeRequest<{ product: CatalogProductDetail }>(`${HQ}/catalog/products/${encodeURIComponent(productId)}`, MESSAGES, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  setProductStatus: (productId: string, status: ProductStatus) =>
    officeRequest<{ product: CatalogProductDetail }>(`${HQ}/catalog/products/${encodeURIComponent(productId)}/status`, MESSAGES, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),
  retireProduct: (productId: string) => hqBilling.setProductStatus(productId, 'retired'),
  reactivateProduct: (productId: string) => hqBilling.setProductStatus(productId, 'active'),
  reorderProducts: (ids: string[]) =>
    officeRequest<{ products: CatalogProduct[] }>(`${HQ}/catalog/order`, MESSAGES, { method: 'PUT', body: JSON.stringify({ ids }) }),
  productImageUploadUrl: (productId: string, body: { content_type: string; size: number }) =>
    officeRequest<{ image_id: string; upload_url: string; object_path: string; expires_in: number }>(
      `${HQ}/catalog/products/${encodeURIComponent(productId)}/images/upload-url`,
      MESSAGES,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  finalizeProductImage: (productId: string, body: { image_id: string; object_path: string; content_type: string; size: number }) =>
    officeRequest<{ product: CatalogProductDetail }>(`${HQ}/catalog/products/${encodeURIComponent(productId)}/images`, MESSAGES, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeProductImage: (productId: string, imageId: string) =>
    officeRequest<{ product: CatalogProductDetail }>(
      `${HQ}/catalog/products/${encodeURIComponent(productId)}/images/${encodeURIComponent(imageId)}`,
      MESSAGES,
      { method: 'DELETE' },
    ),
  setDefaultProductImage: (productId: string, imageId: string) =>
    officeRequest<{ product: CatalogProductDetail }>(
      `${HQ}/catalog/products/${encodeURIComponent(productId)}/images/${encodeURIComponent(imageId)}/default`,
      MESSAGES,
      { method: 'POST' },
    ),
  updateSettings: (body: Omit<BillingSettings, 'updated_at' | 'version' | 'weekly_paid_orders'> & { expected_version: number }) =>
    officeRequest<{ settings: BillingSettings }>(`${HQ}/catalog/settings`, MESSAGES, { method: 'PUT', body: JSON.stringify(body) }),
  changes: (filters: ListFilters) => officeRequest<Paged<CatalogChange>>(`${HQ}/catalog/changes${qs(filters)}`, MESSAGES),
  subscriptions: (filters: ListFilters) => officeRequest<Paged<SubscriptionRow>>(`${HQ}/subscriptions${qs(filters)}`, MESSAGES),
  cancelSubscription: (subscriptionId: string, body: { at_period_end: boolean }) =>
    officeRequest<{ subscription: SubscriptionRow }>(`${HQ}/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, MESSAGES, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  retrySubscriptionPayment: (subscriptionId: string) =>
    officeRequest<{ subscription: SubscriptionRow }>(`${HQ}/subscriptions/${encodeURIComponent(subscriptionId)}/retry-payment`, MESSAGES, {
      method: 'POST', body: '{}',
    }),
  resendSubscriptionPaymentEmail: (subscriptionId: string) =>
    officeRequest<{ subscription: SubscriptionRow }>(`${HQ}/subscriptions/${encodeURIComponent(subscriptionId)}/resend-payment-email`, MESSAGES, {
      method: 'POST', body: '{}',
    }),
  pauseSubscription: (subscriptionId: string) =>
    officeRequest<{ subscription: SubscriptionRow }>(`${HQ}/subscriptions/${encodeURIComponent(subscriptionId)}/pause`, MESSAGES, {
      method: 'POST', body: '{}',
    }),
  resumeSubscription: (subscriptionId: string) =>
    officeRequest<{ subscription: SubscriptionRow }>(`${HQ}/subscriptions/${encodeURIComponent(subscriptionId)}/resume`, MESSAGES, {
      method: 'POST', body: '{}',
    }),
  subscriptionChangeQuote: (subscriptionId: string, productId: string) =>
    officeRequest<SubscriptionChangeQuote>(`${HQ}/subscriptions/${encodeURIComponent(subscriptionId)}/change-quote${qs({ product_id: productId })}`, MESSAGES),
  changeSubscription: (subscriptionId: string, body: SubscriptionChangeInput) =>
    officeRequest<{ subscription: SubscriptionRow }>(`${HQ}/subscriptions/${encodeURIComponent(subscriptionId)}/change`, MESSAGES, {
      method: 'POST', body: JSON.stringify(body),
    }),
};

// ---------------- public (no session) ----------------

export class PublicBillingError extends Error {
  constructor(message: string, readonly status: number, readonly field: string | null = null, readonly attemptsLeft: number | null = null) {
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
  let body: { error?: unknown; field?: unknown; attempts_left?: unknown } & Partial<T> = {};
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
      typeof body.attempts_left === 'number' ? body.attempts_left : null,
    );
  }
  const billingScope = response.headers.get('X-Billing-Scope');
  if (billingScope && body && typeof body === 'object') Object.assign(body, { billing_scope: billingScope });
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
  cartPeek: (token: string) => publicRequest<PublicCartPeek>(`${PUBLIC}/carts/${encodeURIComponent(token)}`),
  cartPhone: (token: string, phone: string) =>
    publicRequest<{ request_id: string; devCode?: string }>(`${PUBLIC}/carts/${encodeURIComponent(token)}/phone`, {
      method: 'POST', body: JSON.stringify({ phone }),
    }),
  cartVerify: (token: string, requestId: string, code: string) =>
    publicRequest<{ session: string }>(`${PUBLIC}/carts/${encodeURIComponent(token)}/verify`, {
      method: 'POST', body: JSON.stringify({ request_id: requestId, code }),
    }),
  cartDetails: (token: string, session: string) =>
    publicRequest<PublicCartDetails>(`${PUBLIC}/carts/${encodeURIComponent(token)}/details`, {
      headers: { 'X-Cart-Session': session },
    }),
  cartCheckout: (
    token: string,
    session: string,
    body: { shipping_address: ShippingAddress; payment_method_id: string; payer?: { name: string; email: string; phone: string } },
    billingScope?: string,
  ) =>
    publicRequest<CartCheckoutResponse>(`${PUBLIC}/carts/${encodeURIComponent(token)}/checkout`, {
      method: 'POST', headers: { 'X-Cart-Session': session, 'X-Billing-Scope': billingScope ?? '' }, body: JSON.stringify(body),
    }),
  cartStatus: (token: string, session: string) =>
    publicRequest<PublicCartStatus>(`${PUBLIC}/carts/${encodeURIComponent(token)}/status`, {
      headers: { 'X-Cart-Session': session },
    }),
};
