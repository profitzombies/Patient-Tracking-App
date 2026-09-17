/**
 * Pure cart arithmetic for the in-app shop. No React Native imports so the
 * Node suites can exercise it directly.
 *
 * Mirrors the server's cart rules (api-server/src/billing/cart.ts): one line
 * per product and purchase kind (a subscription line carries its cadence),
 * quantities 1..10, at most 20 lines, subscription units priced at the
 * subscribe-and-save rate, shipping charged once for the one-time order and
 * once per subscription (each subscription ships on its own schedule). The
 * local quote is what the demo persona and the pre-quote render show; a real
 * cart always confirms against POST /cart/quote before checkout.
 */
import type {
  CartCheckoutItem,
  CartLineInput,
  CartPurchase,
  CartQuote,
  CartQuoteGroup,
  CartQuoteLine,
  CartQuoteRequest,
  PublicLinkProduct,
} from '@/lib/patient-billing-types';

export const CART_MAX_QUANTITY = 10;
export const CART_MAX_LINES = 20;

export interface CartLine {
  product_id: string;
  quantity: number;
  purchase: CartPurchase;
  /** Set for subscription lines; null for one-time lines. */
  cadence_weeks: number | null;
}

/** Server uniqueness: one line per product and purchase kind. */
export function cartLineKey(line: Pick<CartLine, 'product_id' | 'purchase'>): string {
  return `${line.product_id}:${line.purchase}`;
}

export function clampQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return 1;
  return Math.min(CART_MAX_QUANTITY, Math.max(1, Math.round(quantity)));
}

export type AddCartResult =
  | { ok: true; lines: CartLine[]; merged: boolean }
  | { ok: false; lines: CartLine[]; reason: 'cart_full' | 'locked' };

/**
 * Adds (or merges into) a line. Merging a subscription line adopts the new
 * cadence, since the server keys subscriptions by product, not by cadence.
 */
export function addCartLine(lines: CartLine[], input: CartLine): AddCartResult {
  const key = cartLineKey(input);
  const index = lines.findIndex(line => cartLineKey(line) === key);
  if (index === -1) {
    if (lines.length >= CART_MAX_LINES) return { ok: false, lines, reason: 'cart_full' };
    return {
      ok: true,
      merged: false,
      lines: [...lines, { ...input, quantity: clampQuantity(input.quantity), cadence_weeks: input.purchase === 'subscription' ? input.cadence_weeks : null }],
    };
  }
  const existing = lines[index];
  const next: CartLine = {
    ...existing,
    quantity: clampQuantity(existing.quantity + input.quantity),
    cadence_weeks: input.purchase === 'subscription' ? input.cadence_weeks ?? existing.cadence_weeks : null,
  };
  return { ok: true, merged: true, lines: lines.map((line, i) => (i === index ? next : line)) };
}

/** Quantity 0 removes the line. */
export function setCartLineQuantity(lines: CartLine[], key: string, quantity: number): CartLine[] {
  if (quantity <= 0) return lines.filter(line => cartLineKey(line) !== key);
  return lines.map(line => (cartLineKey(line) === key ? { ...line, quantity: clampQuantity(quantity) } : line));
}

export function setCartLineCadence(lines: CartLine[], key: string, cadenceWeeks: number): CartLine[] {
  return lines.map(line =>
    cartLineKey(line) === key && line.purchase === 'subscription' ? { ...line, cadence_weeks: cadenceWeeks } : line,
  );
}

export function removeCartLine(lines: CartLine[], key: string): CartLine[] {
  return lines.filter(line => cartLineKey(line) !== key);
}

export function cartItemCount(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function toQuoteRequest(lines: CartLine[]): CartQuoteRequest {
  return {
    lines: lines.map((line): CartLineInput => ({
      product_id: line.product_id,
      quantity: line.quantity,
      purchase: line.purchase,
      ...(line.purchase === 'subscription' ? { cadence_weeks: line.cadence_weeks } : {}),
    })),
  };
}

export interface PruneResult {
  lines: CartLine[];
  /** Lines dropped because the office no longer sells them that way. */
  removed: CartLine[];
}

/**
 * Drops lines the storefront can no longer honor (product gone, subscription
 * switched off, cadence withdrawn) so a stale cart never reaches checkout.
 */
export function pruneCartLines(lines: CartLine[], products: PublicLinkProduct[]): PruneResult {
  const byId = new Map(products.map(product => [product.product_id, product]));
  const kept: CartLine[] = [];
  const removed: CartLine[] = [];
  for (const line of lines) {
    const product = byId.get(line.product_id);
    if (!product) { removed.push(line); continue; }
    if (line.purchase === 'subscription') {
      const offered = product.subscription_cadences_weeks as number[];
      if (!product.subscription_available || product.subscription_unit_price_cents === null) { removed.push(line); continue; }
      if (line.cadence_weeks === null || !offered.includes(line.cadence_weeks)) {
        kept.push({ ...line, cadence_weeks: product.default_cadence_weeks });
        continue;
      }
    }
    kept.push(line);
  }
  return { lines: kept, removed };
}

/** Server-equivalent quote computed from the storefront the patient already holds. */
/**
 * Client-side estimate of the server quote (used for the demo persona and as
 * the placeholder while the live quote loads). An office that collects sales
 * tax cannot be estimated here: its tax and amount due stay unknown (null)
 * until the server has priced the cart for a shipping address.
 */
export function localQuote(lines: CartLine[], products: PublicLinkProduct[], shippingChargeCents: number, taxEnabled = false): CartQuote {
  const byId = new Map(products.map(product => [product.product_id, product]));
  const quoteLines: CartQuoteLine[] = [];
  for (const line of lines) {
    const product = byId.get(line.product_id);
    if (!product) continue;
    const list = product.unit_price_cents;
    const unit =
      line.purchase === 'subscription' && product.subscription_unit_price_cents !== null
        ? product.subscription_unit_price_cents
        : list;
    quoteLines.push({
      product_id: product.product_id,
      name: product.name,
      purchase: line.purchase,
      quantity: line.quantity,
      cadence_weeks: line.purchase === 'subscription' ? line.cadence_weeks ?? product.default_cadence_weeks : null,
      unit_price_cents: unit,
      list_price_cents: list,
      discount_cents: (list - unit) * line.quantity,
      line_total_cents: unit * line.quantity,
    });
  }
  const group = (kind: CartPurchase, members: CartQuoteLine[]): CartQuoteGroup => {
    const subtotal = members.reduce((sum, line) => sum + line.line_total_cents, 0);
    return {
      kind,
      product_id: kind === 'subscription' ? members[0].product_id : null,
      cadence_weeks: kind === 'subscription' ? members[0].cadence_weeks : null,
      quantity: members.reduce((sum, line) => sum + line.quantity, 0),
      subtotal_cents: subtotal,
      shipping_charge_cents: shippingChargeCents,
      total_cents: subtotal + shippingChargeCents,
    };
  };
  const oneTime = quoteLines.filter(line => line.purchase === 'one_time');
  const groups: CartQuoteGroup[] = [
    ...(oneTime.length ? [group('one_time', oneTime)] : []),
    ...quoteLines.filter(line => line.purchase === 'subscription').map(line => group('subscription', [line])),
  ];
  const total = groups.reduce((sum, item) => sum + item.total_cents, 0);
  return {
    lines: quoteLines,
    groups,
    subtotal_cents: groups.reduce((sum, item) => sum + item.subtotal_cents, 0),
    discount_cents: quoteLines.reduce((sum, line) => sum + line.discount_cents, 0),
    shipping_charge_cents: groups.reduce((sum, item) => sum + item.shipping_charge_cents, 0),
    total_cents: total,
    tax_enabled: taxEnabled,
    tax_cents: taxEnabled ? null : 0,
    total_due_cents: taxEnabled ? null : total,
  };
}

/**
 * The lines still owed after a checkout that paid some groups and not
 * others: every line a paid item names (product + purchase kind) is gone,
 * since that order exists and was charged; the rest stay for the next try.
 */
export function linesAfterPaidItems(lines: CartLine[], paid: ReadonlyArray<Pick<CartCheckoutItem, 'kind' | 'product_ids'>>): CartLine[] {
  const settled = new Set<string>();
  for (const item of paid) for (const productId of item.product_ids) settled.add(cartLineKey({ product_id: productId, purchase: item.kind }));
  if (!settled.size) return lines;
  const remaining = lines.filter(line => !settled.has(cartLineKey(line)));
  return remaining.length === lines.length ? lines : remaining;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars.toLocaleString('en-US')}.${rest}`;
}

export function cadenceLabel(weeks: number | null | undefined): string {
  if (!weeks) return '';
  if (weeks === 4) return 'Every 4 weeks';
  return `Every ${weeks} weeks`;
}

/** Bounded, per-attempt cart id used as the checkout idempotency key. */
export function newCartId(random: () => number = Math.random, now: () => number = Date.now): string {
  const stamp = now().toString(36);
  const salt = Math.floor(random() * 0xffffffff).toString(36).padStart(7, '0');
  return `cart-${stamp}-${salt}`;
}
