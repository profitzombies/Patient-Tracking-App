import { authedRequest } from '@/lib/patient-data-api';
import type {
  CartCheckoutRequest,
  CartCheckoutResponse,
  CartQuote,
  CartQuoteRequest,
  PatientBillingOverview,
  PatientBillingSubscription,
  PatientCardAddRequest,
  PatientCardList,
  PatientCardSetup,
  PatientCheckoutLink,
  PatientCheckoutLinkRequest,
  PatientOrderDetail,
  PatientOrderList,
  PatientReceipt,
  PatientShop,
  PatientSubscriptionDetail,
  SubscriptionAddressRequest,
  SubscriptionCardRequest,
  SubscriptionMoveNextRequest,
  SubscriptionPlanRequest,
  SubscriptionRetryPaymentRequest,
} from '@/lib/patient-billing-types';

function mutationKey(kind: string, id = ''): string {
  return `patient-billing-${kind}-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
const enc = encodeURIComponent;

export function getBillingOverview(): Promise<PatientBillingOverview> {
  return authedRequest('GET', '/patient-data/billing/overview') as Promise<PatientBillingOverview>;
}

export function createCheckoutLink(input: PatientCheckoutLinkRequest): Promise<PatientCheckoutLink> {
  return authedRequest('POST', '/patient-data/billing/checkout-link', input, {
    idempotencyKey: mutationKey('checkout', input.product_id ?? 'general'),
  }) as Promise<PatientCheckoutLink>;
}

export function getOrderReceipt(orderId: string): Promise<PatientReceipt> {
  return authedRequest('GET', `/patient-data/billing/orders/${enc(orderId)}/receipt`) as Promise<PatientReceipt>;
}

export function cancelSubscription(id: string): Promise<PatientBillingSubscription> {
  return authedRequest('POST', `/patient-data/billing/subscriptions/${enc(id)}/cancel`, {}, {
    idempotencyKey: mutationKey('cancel', id),
  }) as Promise<PatientBillingSubscription>;
}

/* ---------------- In-app shop ---------------- */

export function getShop(): Promise<PatientShop> {
  return authedRequest('GET', '/patient-data/billing/shop') as Promise<PatientShop>;
}

export function quoteCart(input: CartQuoteRequest): Promise<CartQuote> {
  return authedRequest('POST', '/patient-data/billing/cart/quote', input) as Promise<CartQuote>;
}

/**
 * One confirmation for the whole cart. Retrying with the same cart id replays
 * the rows the first attempt created instead of charging again, so callers
 * must keep the cart id stable across retries of a single tap.
 */
const CHECKOUT_TIMEOUT_MS = 90_000;
export function checkoutCart(input: CartCheckoutRequest, cartId: string, options?: { accessToken?: string }): Promise<CartCheckoutResponse> {
  return authedRequest('POST', '/patient-data/billing/cart/checkout', { ...input, cart_id: cartId }, {
    // The bearer is the one the pay flow captured for the account that
    // started the attempt, never whatever session is current when the POST
    // finally leaves (an account switch during card entry must not charge the
    // first patient's cart under the second's identity).
    accessToken: options?.accessToken,
    idempotencyKey: `patient-billing-checkout-${cartId}`,
    // A declined cart answers 402 with the same response shape (status
    // "failed", per-item errors); keep that body instead of a bare error.
    acceptStatuses: [402],
    // Customer, card attach, PaymentIntent, and subscriptions are several
    // sequential Stripe round-trips; the 15 s diary deadline aborts real
    // checkouts mid-flight.
    timeoutMs: CHECKOUT_TIMEOUT_MS,
  }) as Promise<CartCheckoutResponse>;
}

/* ---------------- Saved cards ---------------- */

export function listCards(): Promise<PatientCardList> {
  return authedRequest('GET', '/patient-data/billing/cards') as Promise<PatientCardList>;
}

export function startCardSetup(): Promise<PatientCardSetup> {
  return authedRequest('POST', '/patient-data/billing/cards/setup', {}, {
    idempotencyKey: mutationKey('card-setup'),
  }) as Promise<PatientCardSetup>;
}

export function addCard(input: PatientCardAddRequest): Promise<PatientCardList> {
  return authedRequest('POST', '/patient-data/billing/cards', input, {
    idempotencyKey: mutationKey('card-add', input.payment_method_id),
  }) as Promise<PatientCardList>;
}

export function setDefaultCard(paymentMethodId: string): Promise<PatientCardList> {
  return authedRequest('POST', `/patient-data/billing/cards/${enc(paymentMethodId)}/default`, {}, {
    idempotencyKey: mutationKey('card-default', paymentMethodId),
  }) as Promise<PatientCardList>;
}

export function removeCard(paymentMethodId: string): Promise<PatientCardList> {
  return authedRequest('DELETE', `/patient-data/billing/cards/${enc(paymentMethodId)}`) as Promise<PatientCardList>;
}

/* ---------------- Orders ---------------- */

export function listOrders(cursor?: string | null, limit = 20): Promise<PatientOrderList> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return authedRequest('GET', `/patient-data/billing/orders?${params.toString()}`) as Promise<PatientOrderList>;
}

export function getOrder(orderId: string): Promise<PatientOrderDetail> {
  return authedRequest('GET', `/patient-data/billing/orders/${enc(orderId)}`) as Promise<PatientOrderDetail>;
}

/* ---------------- Subscription self-service ---------------- */

export function listSubscriptions(): Promise<{ items: PatientSubscriptionDetail[] }> {
  return authedRequest('GET', '/patient-data/billing/subscriptions') as Promise<{ items: PatientSubscriptionDetail[] }>;
}

export function getSubscription(id: string): Promise<PatientSubscriptionDetail> {
  return authedRequest('GET', `/patient-data/billing/subscriptions/${enc(id)}`) as Promise<PatientSubscriptionDetail>;
}

type SubscriptionAction = 'move-next' | 'skip-next' | 'pause' | 'resume' | 'address' | 'plan' | 'card' | 'retry-payment';
function subscriptionAction(id: string, name: SubscriptionAction, body: unknown = {}): Promise<PatientBillingSubscription> {
  return authedRequest('POST', `/patient-data/billing/subscriptions/${enc(id)}/${name}`, body, {
    idempotencyKey: mutationKey(name, id),
  }) as Promise<PatientBillingSubscription>;
}

export const moveNextShipment = (id: string, input: SubscriptionMoveNextRequest) => subscriptionAction(id, 'move-next', input);
export const skipNextShipment = (id: string) => subscriptionAction(id, 'skip-next');
export const pauseSubscription = (id: string) => subscriptionAction(id, 'pause');
export const resumeSubscription = (id: string) => subscriptionAction(id, 'resume');
export const changeSubscriptionAddress = (id: string, input: SubscriptionAddressRequest) => subscriptionAction(id, 'address', input);
export const changeSubscriptionPlan = (id: string, input: SubscriptionPlanRequest) => subscriptionAction(id, 'plan', input);
export const updateSubscriptionCard = (id: string, input: SubscriptionCardRequest) => subscriptionAction(id, 'card', input);
/**
 * Failed renewal: optionally switch the renewal card first, then pay the
 * open invoice. A decline surfaces as the server's 402 message.
 */
export const retrySubscriptionPayment = (id: string, input: SubscriptionRetryPaymentRequest = {}) => subscriptionAction(id, 'retry-payment', input);
