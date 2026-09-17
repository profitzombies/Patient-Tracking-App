/**
 * Cart math and checkout orchestration, checked without React.
 *
 * - cart lines: merge by product+purchase, quantity clamp, line cap, cadence
 *   edits, pruning against a changed storefront;
 * - local quote: subscription discount per unit, shipping once per group
 *   (one for all one-time lines, one per subscription), totals;
 * - checkout flow: request shape, address validation, and the cart-id rule
 *   (same id after an ambiguous failure, new id after a definite decline,
 *   3DS re-POST with the same id, success only on `paid`).
 */
import {
  CART_MAX_LINES,
  CART_MAX_QUANTITY,
  addCartLine,
  cartItemCount,
  cartLineKey,
  formatCents,
  linesAfterPaidItems,
  localQuote,
  newCartId,
  pruneCartLines,
  removeCartLine,
  setCartLineCadence,
  setCartLineQuantity,
  toQuoteRequest,
  type CartLine,
} from '../lib/cart-math';
import {
  buildCheckoutRequest,
  classifyCheckoutFailure,
  runCheckout,
  TOTAL_CHANGED_STATUS,
  summarizeCheckout,
  validateAddress,
  type CheckoutDeps,
} from '../lib/checkout-flow';
import { buildDemoShop, findShopProduct } from '../lib/shop-catalog';
import type { CartCheckoutResponse, PublicLinkProduct, ShippingAddress } from '../lib/patient-billing-types';

let checks = 0;
let failures = 0;
function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) { failures += 1; console.error(`  FAIL  ${label}`); }
}
function section(label: string) { console.log(`\n· ${label}`); }

const shop = buildDemoShop();
const products = shop.products;
const control = findShopProduct(products, 'control') as PublicLinkProduct;
const subscribable = products.find(product => product.subscription_available && product.subscription_unit_price_cents !== null) as PublicLinkProduct;
const other = products.find(product => product.product_id !== subscribable.product_id) as PublicLinkProduct;

const address: ShippingAddress = { name: 'Pat Example', line1: '1 Main St', line2: null, city: 'Austin', state: 'tx', postal_code: '78701', country: 'us', phone: null };

async function main() {
  section('demo storefront');
  assert('demo shop lists the full catalog with page content', products.length >= 9 && products.every(product => product.slug && product.tagline && product.benefits.length > 0 && product.faqs.length > 0));
  assert('findShopProduct resolves by product id, slug, and legacy catalog id', findShopProduct(products, control.product_id) === control && findShopProduct(products, 'control') === control && findShopProduct(products, 'prod1') !== undefined);
  assert('subscribe-and-save price is the list price less the percent', subscribable.subscription_unit_price_cents === Math.round(subscribable.unit_price_cents * (100 - shop.subscribe_save_percent) / 100));

  section('cart lines');
  let lines: CartLine[] = [];
  let added = addCartLine(lines, { product_id: other.product_id, quantity: 2, purchase: 'one_time', cadence_weeks: 4 });
  assert('one-time add drops the cadence', added.ok && added.lines[0].cadence_weeks === null && added.lines[0].quantity === 2);
  lines = added.lines;
  added = addCartLine(lines, { product_id: other.product_id, quantity: 100, purchase: 'one_time', cadence_weeks: null });
  assert('same product + purchase merges and clamps quantity', added.ok && added.merged && added.lines.length === 1 && added.lines[0].quantity === CART_MAX_QUANTITY);
  lines = added.lines;
  added = addCartLine(lines, { product_id: subscribable.product_id, quantity: 1, purchase: 'subscription', cadence_weeks: 8 });
  assert('subscription line for the same product is a separate line', added.ok && !added.merged && added.lines.length === 2 && cartLineKey(added.lines[1]) === `${subscribable.product_id}:subscription`);
  lines = added.lines;
  assert('item count sums quantities', cartItemCount(lines) === CART_MAX_QUANTITY + 1);
  lines = setCartLineQuantity(lines, cartLineKey(lines[0]), 3);
  lines = setCartLineCadence(lines, cartLineKey(lines[1]), 12);
  assert('quantity and cadence edits target one line', lines[0].quantity === 3 && lines[1].cadence_weeks === 12 && lines[1].quantity === 1);
  assert('quantity 0 removes the line', setCartLineQuantity(lines, cartLineKey(lines[0]), 0).length === 1);
  assert('remove drops by key', removeCartLine(lines, cartLineKey(lines[1])).length === 1);
  const full: CartLine[] = Array.from({ length: CART_MAX_LINES }, (_, i) => ({ product_id: `p${i}`, quantity: 1, purchase: 'one_time', cadence_weeks: null }));
  const overflow = addCartLine(full, { product_id: 'extra', quantity: 1, purchase: 'one_time', cadence_weeks: null });
  assert('line cap refuses a new line but keeps the cart', !overflow.ok && overflow.lines === full);
  const pruned = pruneCartLines(
    [...lines, { product_id: 'gone', quantity: 1, purchase: 'one_time', cadence_weeks: null }],
    products.map(product => (product.product_id === subscribable.product_id ? { ...product, subscription_cadences_weeks: [4], default_cadence_weeks: 4 } : product)),
  );
  assert('prune drops unknown products and re-homes an unoffered cadence', pruned.removed.length === 1 && pruned.lines.length === 2 && pruned.lines[1].cadence_weeks === 4);
  assert('quote request carries only wire fields', JSON.stringify(toQuoteRequest(lines)) === JSON.stringify({ lines: [
    { product_id: other.product_id, quantity: 3, purchase: 'one_time' },
    { product_id: subscribable.product_id, quantity: 1, purchase: 'subscription', cadence_weeks: 12 },
  ] }));

  section('local quote');
  const quote = localQuote(lines, products, shop.shipping_charge_cents);
  const subUnit = subscribable.subscription_unit_price_cents as number;
  assert('one-time line bills list price', quote.lines[0].unit_price_cents === other.unit_price_cents && quote.lines[0].line_total_cents === other.unit_price_cents * 3 && quote.lines[0].discount_cents === 0);
  assert('subscription line bills the discounted unit and reports the discount', quote.lines[1].unit_price_cents === subUnit && quote.lines[1].discount_cents === subscribable.unit_price_cents - subUnit);
  assert('shipping is charged once per group (one-time + each subscription)', quote.groups.length === 2 && quote.shipping_charge_cents === shop.shipping_charge_cents * 2);
  assert('totals add up', quote.subtotal_cents === other.unit_price_cents * 3 + subUnit && quote.total_cents === quote.subtotal_cents + quote.shipping_charge_cents && quote.discount_cents === subscribable.unit_price_cents - subUnit);
  const twoSubs = localQuote([
    { product_id: subscribable.product_id, quantity: 1, purchase: 'subscription', cadence_weeks: 4 },
    { product_id: subscribable.product_id, quantity: 2, purchase: 'one_time', cadence_weeks: null },
  ], products, shop.shipping_charge_cents);
  assert('one-time group precedes subscription groups', twoSubs.groups[0].kind === 'one_time' && twoSubs.groups[1].kind === 'subscription' && twoSubs.groups[1].product_id === subscribable.product_id && twoSubs.groups[1].cadence_weeks === 4);
  assert('no-tax office: tax 0 and total due equals the total', quote.tax_enabled === false && quote.tax_cents === 0 && quote.total_due_cents === quote.total_cents);
  const taxed = localQuote(lines, products, shop.shipping_charge_cents, true);
  assert('tax office: the local estimate leaves tax and amount due UNKNOWN (null), never the pre-tax total', taxed.tax_enabled === true && taxed.tax_cents === null && taxed.total_due_cents === null && taxed.total_cents === quote.total_cents);
  assert('empty cart quotes to zero', localQuote([], products, 1000).total_cents === 0 && localQuote([], products, 1000).groups.length === 0);
  assert('formatCents renders dollars', formatCents(6999) === '$69.99' && formatCents(0) === '$0.00' && formatCents(-500) === '-$5.00' && formatCents(100000) === '$1,000.00');
  const ids = new Set(Array.from({ length: 50 }, () => newCartId()));
  assert('cart ids are unique and opaque', ids.size === 50 && [...ids].every(id => /^[a-z0-9-]{16,}$/i.test(id)));

  section('checkout request + address');
  const request = buildCheckoutRequest(lines, address, 'pm_123', true, 12345);
  assert('request carries wire lines, normalized address, card, set_default, and the authorized total', request.lines.length === 2 && request.shipping_address.state === 'TX' && request.shipping_address.country === 'US' && request.shipping_address.line2 === null && request.payment_method_id === 'pm_123' && request.set_default === true && request.expected_total_due_cents === 12345 && !('cart_id' in request));
  assert('valid address has no problems', Object.keys(validateAddress(address)).length === 0);
  const bad = validateAddress({ ...address, name: ' ', line1: '', city: '', state: 'Texas', postal_code: '1234' });
  assert('each missing or malformed field is named', bad.name !== undefined && bad.line1 !== undefined && bad.city !== undefined && bad.state !== undefined && bad.postal_code !== undefined);
  assert('ZIP+4 accepted', validateAddress({ ...address, postal_code: '78701-1234' }).postal_code === undefined);

  section('checkout flow');
  const paidItem = (kind: 'one_time' | 'subscription', n: string, productIds: string[] = []) => ({ kind, order_id: `o-${n}`, order_number: `TH-${n}`, subscription_id: kind === 'subscription' ? `sub-${n}` : null, status: 'paid' as const, client_secret: null, error: null, total_cents: 5000, product_ids: productIds });
  const response = (status: CartCheckoutResponse['status'], items: CartCheckoutResponse['items']): CartCheckoutResponse => ({ cart_id: 'c1', status, items, stripe_account_id: 'acct_1', publishable_key: 'pk_test', sandbox: true });
  const log: { cartId: string; secret?: string }[] = [];
  const deps = (answers: (CartCheckoutResponse | Error)[], next: Array<'succeeded' | 'failed'> = ['succeeded']): CheckoutDeps => ({
    checkout: async (_input, cartId) => {
      log.push({ cartId });
      const answer = answers.shift();
      if (!answer) throw new Error('unscripted checkout');
      if (answer instanceof Error) throw answer;
      return answer;
    },
    handleNextAction: async secret => {
      log.push({ cartId: 'action', secret });
      return next.shift() ?? 'succeeded';
    },
  });

  let outcome = await runCheckout('cart-a', request, deps([response('paid', [paidItem('one_time', '1'), paidItem('subscription', '2')])]));
  assert('paid answer is success with both items', outcome.kind === 'paid' && log.length === 1 && log[0].cartId === 'cart-a');
  if (outcome.kind === 'paid') {
    const summary = summarizeCheckout(outcome.response);
    assert('summary splits orders from subscriptions and sums totals', summary.orderNumbers.join() === 'TH-1' && summary.subscriptionOrderNumbers.join() === 'TH-2' && summary.totalCents === 10000);
  }

  log.length = 0;
  const networkError = Object.assign(new Error('Couldn’t reach the server.'), { kind: 'network' });
  outcome = await runCheckout('cart-b', request, deps([networkError]));
  assert('network failure keeps the SAME cart id for the retry', outcome.kind === 'failed' && outcome.nextCartId === 'same' && outcome.response === null && outcome.message.includes('reach'));
  const conflict = Object.assign(new Error('Still processing.'), { kind: 'http', status: 409 });
  outcome = await runCheckout('cart-b', request, deps([conflict]));
  assert('409 in-flight also keeps the same cart id', outcome.kind === 'failed' && outcome.nextCartId === 'same');
  const badRequest = Object.assign(new Error('Check your cart.'), { kind: 'http', status: 400 });
  outcome = await runCheckout('cart-b', request, deps([badRequest]));
  assert('a 4xx rejection starts a fresh cart next time', outcome.kind === 'failed' && outcome.nextCartId === 'new' && outcome.message === 'Check your cart.' && outcome.paid.length === 0 && outcome.status === 400);
  outcome = await runCheckout('cart-b', request, deps([Object.assign(new Error('Your total changed.'), { kind: 'http', status: 422 })]));
  assert('a total-changed refusal is definite (new id) and carries the 422 so the screen re-quotes', outcome.kind === 'failed' && outcome.nextCartId === 'new' && outcome.status === TOTAL_CHANGED_STATUS);
  const serverError = Object.assign(new Error('Something went wrong.'), { kind: 'http', status: 502 });
  outcome = await runCheckout('cart-b', request, deps([serverError]));
  assert('a 5xx is ambiguous: the SAME cart id replays (the server may have charged)', outcome.kind === 'failed' && outcome.nextCartId === 'same');
  outcome = await runCheckout('cart-b', request, deps([Object.assign(new Error('Slow down.'), { kind: 'http', status: 429 })]));
  assert('429 and 408 are ambiguous too', outcome.kind === 'failed' && outcome.nextCartId === 'same' && classifyCheckoutFailure({ status: 408 }) === 'ambiguous');
  outcome = await runCheckout('cart-b', request, deps([new Error('unreadable')]));
  assert('an unclassifiable throw is ambiguous, never a fresh cart id', outcome.kind === 'failed' && outcome.nextCartId === 'same');
  assert('classifier: 402/400/404 definite, 500/503 ambiguous, network ambiguous', classifyCheckoutFailure({ status: 402 }) === 'definite' && classifyCheckoutFailure({ status: 404 }) === 'definite' && classifyCheckoutFailure({ status: 500 }) === 'ambiguous' && classifyCheckoutFailure({ status: 503 }) === 'ambiguous' && classifyCheckoutFailure({ kind: 'network', status: 400 }) === 'ambiguous');

  log.length = 0;
  const declined = response('failed', [{ ...paidItem('one_time', '3'), status: 'failed', error: 'Your card was declined.' }]);
  outcome = await runCheckout('cart-c', request, deps([declined]));
  assert('definite decline surfaces the item error and demands a NEW cart id', outcome.kind === 'failed' && outcome.nextCartId === 'new' && outcome.message === 'Your card was declined.' && log.length === 1);

  log.length = 0;
  const needsAction = response('requires_action', [{ ...paidItem('one_time', '4'), status: 'requires_action', client_secret: 'pi_secret_4' }]);
  outcome = await runCheckout('cart-d', request, deps([needsAction, response('paid', [paidItem('one_time', '4')])]));
  assert('requires_action runs 3DS then re-POSTs the SAME cart id and succeeds', outcome.kind === 'paid' && log.map(entry => entry.cartId).join() === 'cart-d,action,cart-d' && log[1].secret === 'pi_secret_4');

  log.length = 0;
  const openNoSecret = response('requires_action', [{ ...paidItem('one_time', '4b'), status: 'requires_action', client_secret: null }]);
  outcome = await runCheckout('cart-d2', request, deps([openNoSecret]));
  assert('requires_action with NO client secret is ambiguous: same cart id, nothing for the device to do, no second POST', outcome.kind === 'failed' && outcome.nextCartId === 'same' && outcome.paid.length === 0 && log.length === 1);

  log.length = 0;
  outcome = await runCheckout('cart-e', request, deps([needsAction], ['failed']));
  assert('failed 3DS keeps the SAME cart id so the server reconciles the intent (no blind second POST)', outcome.kind === 'failed' && outcome.nextCartId === 'same' && outcome.paid.length === 0 && log.length === 2);

  log.length = 0;
  outcome = await runCheckout('cart-f', request, deps([needsAction, networkError]));
  assert('lost response after 3DS keeps the same cart id', outcome.kind === 'failed' && outcome.nextCartId === 'same' && outcome.response !== null);

  log.length = 0;
  const partial = response('partial', [paidItem('one_time', '5', [lines[0].product_id]), { ...paidItem('subscription', '6', [lines[1].product_id]), status: 'failed', error: 'Insufficient funds.' }]);
  outcome = await runCheckout('cart-g', request, deps([partial]));
  assert('partial is definite: names the paid order and the failed reason, new cart id next, and reports the PAID items', outcome.kind === 'failed' && outcome.message.includes('TH-5') && outcome.message.includes('Insufficient funds.') && outcome.nextCartId === 'new' && outcome.paid.length === 1 && outcome.paid[0].order_number === 'TH-5');
  if (outcome.kind === 'failed') {
    const remaining = linesAfterPaidItems(lines, outcome.paid);
    assert('the paid one-time line leaves the cart; the unpaid subscription line stays', remaining.length === 1 && remaining[0].purchase === 'subscription' && remaining[0].product_id === lines[1].product_id);
    assert('same product as a different purchase kind is NOT dropped', linesAfterPaidItems(lines, [{ kind: 'subscription', product_ids: [lines[0].product_id] }]).length === 2);
    assert('no paid items → same array back', linesAfterPaidItems(lines, []) === lines);
  }

  log.length = 0;
  outcome = await runCheckout('cart-h', request, deps([needsAction, needsAction, needsAction]));
  assert('3DS that never settles stops after the round cap with a retry-same message', outcome.kind === 'failed' && outcome.nextCartId === 'same' && log.filter(entry => entry.cartId === 'cart-h').length === 3);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
