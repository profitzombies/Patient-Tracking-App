/**
 * Checkout orchestration, kept free of React so the Node suite can drive it
 * with a fake server and a fake card SDK.
 *
 * Money rules:
 * - One cart id per PAY ATTEMPT. The server keys idempotency on it, so a
 *   retry after an AMBIGUOUS result (network error, timeout, 409 still
 *   processing, any 5xx, an unknown throw) re-sends the SAME cart id and the
 *   SAME request, and the server replays what the first attempt created
 *   instead of charging again. Only a DEFINITE answer (a checkout result, a
 *   4xx other than 409/408/429) may start a fresh cart id, since the server
 *   keeps the failed attempt's rows under the old one.
 * - A response of `requires_action` hands the PaymentIntent secret to the
 *   card SDK for 3DS, then re-POSTs the same cart id so the server re-reads
 *   the intents and answers with final statuses.
 * - Only a `paid` response is success. A `partial` answer means some
 *   groups WERE charged: the outcome names them so the caller drops those
 *   lines from the cart before any retry; re-sending them would charge twice.
 *   Everything else is reported inline and the cart is kept.
 * - The attempt in flight is persisted by the caller (cart id + request)
 *   BEFORE the request leaves, so a remount or reload after an ambiguous
 *   result still replays it; a `requires_action` item with no client secret
 *   is still open on the server and counts as ambiguous.
 * - The request carries the total the button showed; the server refuses
 *   (422) a cart that no longer prices to it, and the caller re-quotes.
 */
import type { NextActionOutcome } from '@/components/shop/card-entry-types';
import { toQuoteRequest, type CartLine } from '@/lib/cart-math';
import type { CartCheckoutItem, CartCheckoutRequest, CartCheckoutResponse, CartQuote, ShippingAddress } from '@/lib/patient-billing-types';

/** Whether a thrown request error leaves the server's side unknown (`ambiguous`) or certainly did nothing (`definite`). */
export type FailureCertainty = 'ambiguous' | 'definite';

export interface CheckoutDeps {
  checkout: (input: CartCheckoutRequest, cartId: string) => Promise<CartCheckoutResponse>;
  handleNextAction: (clientSecret: string) => Promise<NextActionOutcome>;
  classifyError?: (caught: unknown) => FailureCertainty;
}

export type CheckoutOutcome =
  | { kind: 'paid'; response: CartCheckoutResponse }
  | {
      kind: 'failed';
      message: string;
      response: CartCheckoutResponse | null;
      /** Whether the next tap must reuse this cart id and request (ambiguous result) or may start a fresh one. */
      nextCartId: 'same' | 'new';
      /**
       * Items the server DID charge in this definite result (a partial
       * answer). Their lines must leave the cart before the next attempt.
       * Always empty when nextCartId is 'same': the replay reconciles them.
       */
      paid: CartCheckoutItem[];
      /** HTTP status of a refused request (no checkout result), when known. 422 = the total moved; re-quote before asking again. */
      status: number | null;
    };

/**
 * An attempt whose result is not final yet; persisted BEFORE the request
 * leaves so a reload replays it unchanged. While one exists the cart is
 * locked (no edits), and checkout renders this frozen quote, not the live
 * cart, so what the patient confirms is exactly what the server replays.
 */
export interface PendingAttempt {
  cartId: string;
  request: CartCheckoutRequest;
  /** The priced quote the patient authorized (tax included), for the confirm screen. */
  quote: CartQuote;
}

export const MAX_ACTION_ROUNDS = 2;

export function buildCheckoutRequest(
  lines: CartLine[],
  address: ShippingAddress,
  paymentMethodId: string,
  setDefault: boolean,
  /** The total the Pay button showed (quote.total_due_cents); the server refuses a cart that no longer prices to it. */
  expectedTotalDueCents: number,
): CartCheckoutRequest {
  return {
    ...toQuoteRequest(lines),
    shipping_address: normalizeAddress(address),
    payment_method_id: paymentMethodId,
    set_default: setDefault,
    expected_total_due_cents: expectedTotalDueCents,
  };
}

/** The server refused the request because the amount the button showed is no longer the amount due. */
export const TOTAL_CHANGED_STATUS = 422;

export function normalizeAddress(address: ShippingAddress): ShippingAddress {
  const trim = (value: string | null) => (value ?? '').trim();
  return {
    name: trim(address.name),
    line1: trim(address.line1),
    line2: trim(address.line2) || null,
    city: trim(address.city),
    state: trim(address.state).toUpperCase(),
    postal_code: trim(address.postal_code),
    country: (trim(address.country) || 'US').toUpperCase(),
    phone: trim(address.phone) || null,
  };
}

export type AddressField = 'name' | 'line1' | 'city' | 'state' | 'postal_code';

/** Field-level problems for the address form; empty when the address can ship. */
export function validateAddress(address: ShippingAddress): Partial<Record<AddressField, string>> {
  const normalized = normalizeAddress(address);
  const problems: Partial<Record<AddressField, string>> = {};
  if (!normalized.name) problems.name = 'Enter the name for the package.';
  if (!normalized.line1) problems.line1 = 'Enter a street address.';
  if (!normalized.city) problems.city = 'Enter a city.';
  if (!/^[A-Z]{2}$/.test(normalized.state)) problems.state = 'Use the two-letter state code.';
  if (!/^\d{5}(-\d{4})?$/.test(normalized.postal_code)) problems.postal_code = 'Enter a 5-digit ZIP code.';
  return problems;
}

export function failureMessage(response: CartCheckoutResponse): string {
  const failed = response.items.find(item => item.status === 'failed' && item.error);
  const paid = response.items.filter(item => item.status === 'paid');
  if (paid.length) {
    const numbers = paid.map(item => item.order_number).join(', ');
    const reason = failed?.error ? ` ${failed.error}` : '';
    return `Order ${numbers} was paid and is on its way. The remaining items were not charged and stay in your cart.${reason} Check your card and try again.`;
  }
  if (failed?.error) return failed.error;
  return 'Your card was declined. Try another card or contact your bank.';
}

/**
 * A request that never got a checkout answer is only "definite" when the
 * server itself refused it with a client error: 4xx other than 409 (an
 * attempt still processing), 408, and 429. Lost responses, 5xx, and anything
 * we cannot read are ambiguous, and an ambiguous attempt is always replayed.
 */
export function classifyCheckoutFailure(caught: unknown): FailureCertainty {
  const kind = (caught as { kind?: unknown } | null)?.kind;
  const status = (caught as { status?: unknown } | null)?.status;
  if (kind === 'network') return 'ambiguous';
  if (typeof status !== 'number') return 'ambiguous';
  if (status === 409 || status === 408 || status === 429) return 'ambiguous';
  return status >= 400 && status < 500 ? 'definite' : 'ambiguous';
}

function definite(message: string, response: CartCheckoutResponse | null, status: number | null = null): CheckoutOutcome {
  return { kind: 'failed', message, response, nextCartId: 'new', paid: response?.items.filter(item => item.status === 'paid') ?? [], status };
}

function ambiguous(message: string, response: CartCheckoutResponse | null, status: number | null = null): CheckoutOutcome {
  return { kind: 'failed', message, response, nextCartId: 'same', paid: [], status };
}

function statusOf(caught: unknown): number | null {
  const status = (caught as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * Runs one pay attempt end to end. Never throws for a payment result; the
 * only rejections come out of the card SDK itself and are turned into a
 * failed outcome with the SDK's message.
 */
export async function runCheckout(
  cartId: string,
  request: CartCheckoutRequest,
  deps: CheckoutDeps,
): Promise<CheckoutOutcome> {
  const classify = deps.classifyError ?? classifyCheckoutFailure;
  let response: CartCheckoutResponse;
  try {
    response = await deps.checkout(request, cartId);
  } catch (caught) {
    const message = caught instanceof Error && caught.message ? caught.message : 'Couldn’t reach the server. Please try again.';
    // A lost response, a 5xx, or an attempt still settling: the same cart id replays safely.
    return classify(caught) === 'definite' ? definite(message, null, statusOf(caught)) : ambiguous(message, null, statusOf(caught));
  }

  for (let round = 0; round < MAX_ACTION_ROUNDS; round += 1) {
    if (response.status === 'paid') return { kind: 'paid', response };
    if (response.status === 'failed') return definite(failureMessage(response), response);
    const pending = response.items.filter(item => item.status === 'requires_action' && item.client_secret);
    if (!pending.length) {
      if (response.items.some(item => item.status === 'requires_action')) {
        // A group is still open on the server's side but there is nothing for
        // the device to do: its result is unknown, so the same id must replay.
        return ambiguous('Your bank is still verifying this payment. Tap Pay again in a moment.', response);
      }
      // partial with nothing left to authenticate: the failed items failed for
      // good, and the paid ones are reported so their lines leave the cart.
      return definite(failureMessage(response), response);
    }
    for (const item of pending) {
      let outcome: NextActionOutcome;
      try {
        outcome = await deps.handleNextAction(item.client_secret as string);
      } catch (caught) {
        // The bank step failed on the device. Whether the intent is now
        // failed or still open is unknown to us: replay the same cart id so
        // the server reads the intent and answers honestly.
        const message = caught instanceof Error && caught.message ? caught.message : 'Your bank didn’t approve the payment.';
        return ambiguous(message, response);
      }
      if (outcome === 'requires_payment_method' || outcome === 'failed') {
        // Stripe reported the intent itself as not payable with this card;
        // still replay the same id so any group that DID pay is reconciled
        // and the rest come back as definite failures.
        return ambiguous('Your bank didn’t approve the payment. Try another card, then tap Pay again.', response);
      }
    }
    // Same cart id: the server re-reads the intents and reports final statuses.
    try {
      response = await deps.checkout(request, cartId);
    } catch (caught) {
      const message = caught instanceof Error && caught.message ? caught.message : 'Couldn’t confirm the payment. Please try again.';
      return ambiguous(message, response);
    }
  }
  if (response.status === 'paid') return { kind: 'paid', response };
  if (response.status === 'failed') return definite(failureMessage(response), response);
  return ambiguous(
    response.status === 'requires_action'
      ? 'Your bank is still verifying this payment. Tap Pay again in a moment.'
      : failureMessage(response),
    response,
  );
}

/** What the confirmation screen says was started. */
export function summarizeCheckout(response: CartCheckoutResponse): {
  orderNumbers: string[];
  subscriptionOrderNumbers: string[];
  totalCents: number;
} {
  const paid = response.items.filter(item => item.status === 'paid');
  return {
    orderNumbers: paid.filter(item => item.kind === 'one_time').map(item => item.order_number),
    subscriptionOrderNumbers: paid.filter(item => item.kind === 'subscription').map(item => item.order_number),
    totalCents: paid.reduce((sum, item) => sum + item.total_cents, 0),
  };
}
