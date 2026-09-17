import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import PublicPayArea from '../src/pages/public/pay/PublicPayArea';
import type { PublicLink } from '../src/lib/billing-types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const browser = globalThis as typeof globalThis & {
  window: { location: { origin: string } };
  __billingStripeLoad?: { publishableKey: string; stripeAccount?: string };
  __billingElementsSecret?: string;
};
browser.window = { location: { origin: 'https://payments.example' } };

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
const text = (node: ReactTestInstance | ReactTestRenderer) => {
  const root = 'root' in node ? node.root : node;
  const output: string[] = [];
  const walk = (item: ReactTestInstance | string) => {
    if (typeof item === 'string') output.push(item);
    else item.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(root);
  return output.join('');
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
let queue: Response[] = [];
const requests: Array<{ url: string; method: string; body: any; headers?: HeadersInit }> = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers });
  const response = queue.shift();
  if (!response) throw new Error(`Unexpected fetch: ${url}`);
  return response;
};
async function settle(rounds = 5) {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
}
// Mounted as App.tsx does: a `nest` route at /pay, so in-area links must be
// relative to that base.
async function render(path: string) {
  const location = memoryLocation({ path: `/pay${path}` });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Router hook={location.hook}><Route path="/pay" nest><PublicPayArea /></Route></Router>); });
  await settle();
  return renderer;
}
const fixture: PublicLink = {
  token: 'good', office: { name: 'Beacon Hill Aesthetics', city: 'Boston', state: 'MA' },
  products: [
    { product_id: 'control', name: 'Control', description: '', image_url: null, unit_price_cents: 6999, subscription_available: true },
    { product_id: 'fiber', name: 'Fiber', description: '', image_url: null, unit_price_cents: 3499, subscription_available: false },
  ],
  shipping_charge_cents: 1000, tax_enabled: true, locked_payer: null, sandbox: true,
  publishable_key: 'pk_test_link', stripe_account_id: 'acct_link', active: true,
  preselected_product_id: null,
};
const one = (root: ReactTestInstance, testId: string) => root.find((node) => node.props['data-testid'] === testId);
const change = async (node: ReactTestInstance, value: string) => act(async () => node.props.onChange({ target: { value } }));
const click = async (node: ReactTestInstance) => act(async () => node.props.onClick());

console.log('billing public: inactive link');
queue = [json(404, { error: 'Not found' })];
let view = await render('/expired');
check('inactive link has the prescribed message', text(view).includes('This payment link is no longer active. Ask your office for a new one.'));
view.unmount();

console.log('\nbilling public: checkout');
requests.length = 0;
queue = [
  json(200, fixture),
  json(200, {
    order_id: 'order-1', order_number: 'TH-ABC123', client_secret: 'pi_secret',
    stripe_account_id: 'acct_returned', publishable_key: 'pk_test_returned', sandbox: true,
    totals: { subtotal_cents: 6999, shipping_charge_cents: 1000, tax_cents: 640, total_cents: 8639 },
    subscription: null,
  }),
];
view = await render('/good?source=app');
const root = view.root;
const addControl = root.find((node) => node.props['aria-label'] === 'Add one Control');
await click(addControl);
await change(one(root, 'input-name'), 'Jamie Patient');
await change(one(root, 'input-email'), 'jamie@example.com');
await change(one(root, 'input-phone'), '6175550199');
await change(one(root, 'input-shipping_name'), 'Jamie Patient');
await change(one(root, 'input-line1'), '10 Main Street');
await change(one(root, 'input-city'), 'Boston');
await change(one(root, 'input-state'), 'MA');
await change(one(root, 'input-postal_code'), '02110');
const form = root.findAllByType('form')[0];
await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
await settle();
const post = requests.find((request) => request.method === 'POST');
check('one-time checkout sends the exact request body', JSON.stringify(post?.body) === JSON.stringify({
  items: [{ product_id: 'control', quantity: 1 }],
  shipping_address: { name: 'Jamie Patient', line1: '10 Main Street', line2: null, city: 'Boston', state: 'MA', postal_code: '02110', country: 'US', phone: null },
  purchase: 'one_time',
  payer: { name: 'Jamie Patient', email: 'jamie@example.com', phone: '6175550199' },
}), JSON.stringify(post?.body));
check('returned Stripe account and client secret mount Elements', browser.__billingStripeLoad?.stripeAccount === 'acct_returned' && browser.__billingElementsSecret === 'pi_secret');
check(
  'app source is preserved in the Stripe return URL',
  root.findAll((node) => typeof node.props.returnUrl === 'string')
    .some((node) => node.props.returnUrl.endsWith('&source=app')),
);
const editButton = root.find((node) => node.type === 'button' && text(node).includes('Edit order'));
await click(editButton);
queue.push(json(400, { error: 'That email cannot be used.', field: 'payer.email' }));
await act(async () => { root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }); });
await settle();
check('server field errors land on their field', one(root, 'input-email').props['aria-invalid'] === true && text(root).includes('That email cannot be used.'));
view.unmount();

console.log('\nbilling public: product preselection');
const preselected = { ...fixture, preselected_product_id: 'control' };
queue = [json(200, preselected)];
view = await render('/preselected');
check(
  'preselected link starts with its product in the one-time cart',
  text(one(view.root, 'quantity-control')) === '1'
    && text(one(view.root, 'quantity-fiber')) === '0'
    && view.root.find((node) => node.type === 'button' && text(node).includes('One-time order')).props['aria-pressed'] === true
    && text(one(view.root, 'order-summary')).includes('$69.99'),
);
await click(view.root.find((node) => node.props['aria-label'] === 'Remove one Control'));
check(
  'preselected product remains editable without mutating the resolved link',
  text(one(view.root, 'quantity-control')) === '0'
    && preselected.preselected_product_id === 'control'
    && preselected.products[0].product_id === 'control',
);
view.unmount();

queue = [json(200, fixture)];
view = await render('/not-preselected');
check(
  'null preselection leaves every cart quantity empty',
  text(one(view.root, 'quantity-control')) === '0' && text(one(view.root, 'quantity-fiber')) === '0',
);
view.unmount();

console.log('\nbilling public: subscription and locked payer');
queue = [json(200, fixture)];
view = await render('/good');
const subscriptionButton = view.root.find((node) => node.type === 'button' && text(node).includes('Subscribe every 4 weeks'));
await click(subscriptionButton);
check('subscription selects one eligible product at quantity one', text(one(view.root, 'quantity-control')) === '1' && text(one(view.root, 'quantity-fiber')) === '0');
view.unmount();

const locked = { ...fixture, locked_payer: { name: 'Pat Locked', email: 'pat@example.com', phone: '6175550111' } };
queue = [
  json(200, locked),
  json(200, {
    order_id: 'order-locked', order_number: 'TH-LOCKED', client_secret: 'locked_secret',
    stripe_account_id: 'acct_locked', publishable_key: 'pk_test_locked', sandbox: true,
    totals: { subtotal_cents: 6999, shipping_charge_cents: 1000, tax_cents: 0, total_cents: 7999 },
    subscription: null,
  }),
];
view = await render('/locked');
check('locked payer is read-only', Boolean(one(view.root, 'locked-payer')) && view.root.findAll((node) => node.props['data-testid'] === 'input-email').length === 0);
await click(view.root.find((node) => node.props['aria-label'] === 'Add one Control'));
await change(one(view.root, 'input-line1'), '10 Main Street');
await change(one(view.root, 'input-city'), 'Boston');
await change(one(view.root, 'input-state'), 'MA');
await change(one(view.root, 'input-postal_code'), '02110');
await act(async () => { view.root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }); });
await settle();
check('locked payer is omitted from the order request', requests.at(-1)?.body?.payer === undefined);
view.unmount();

console.log('\nbilling public: prebuilt cart');
const cartPeek = { status: 'open', office: { name: 'Beacon Hill Aesthetics' }, sandbox: true };
const cartQuote = {
  lines: [{ product_id: 'control', name: 'Control', purchase: 'one_time', quantity: 2, cadence_weeks: null, unit_price_cents: 6999, list_price_cents: 6999, discount_cents: 0, line_total_cents: 13998 }],
  groups: [{ kind: 'one_time', product_id: null, cadence_weeks: null, quantity: 2, subtotal_cents: 13998, shipping_charge_cents: 1000, total_cents: 14998 }],
  subtotal_cents: 13998, discount_cents: 0, shipping_charge_cents: 1000, total_cents: 14998,
};
const cartDetails = {
  office: { name: 'Beacon Hill Aesthetics', city: 'Boston', state: 'MA' },
  patient: { name: 'Maya Thompson', email: 'maya@example.com', phone: '6175550100' },
  lines: cartQuote.lines, quote: cartQuote, products: [], shipping_charge_cents: 1000, tax_enabled: false,
  default_address: { name: 'Maya Thompson', line1: '10 Main St', line2: null, city: 'Boston', state: 'MA', postal_code: '02110', country: 'US', phone: '6175550100' },
  stripe_account_id: 'acct_cart', publishable_key: 'pk_test_cart', sandbox: true, expires_at: '2099-01-01T00:00:00Z',
};
requests.length = 0;
queue = [
  json(200, cartPeek),
  json(200, { request_id: 'verify-1', devCode: '246810' }),
  json(200, { session: 'cart-session-1' }),
  json(200, cartDetails),
  json(200, {
    cart_id: 'cart-1', status: 'paid',
    items: [{ kind: 'one_time', order_id: 'order-cart', order_number: 'TH-CART01', subscription_id: null, status: 'paid', client_secret: null, error: null, total_cents: 14998 }],
    stripe_account_id: 'acct_cart', publishable_key: 'pk_test_cart', sandbox: true,
  }),
];
view = await render('/cart/cart-token');
const phoneForm = view.root.find((node) => node.type === 'form' && text(node).includes('Enter the mobile number on file'));
await change(phoneForm.findByType('input'), '6175550100');
await act(async () => phoneForm.props.onSubmit({ preventDefault() {} })); await settle();
check('cart phone advances to code and displays devCode as test-mode only', text(view).includes('Test-mode code:') && text(view).includes('246810'), text(view));
const codeForm = view.root.find((node) => node.type === 'form' && text(node).includes('Enter your code'));
await change(codeForm.findByType('input'), '246810');
await act(async () => codeForm.props.onSubmit({ preventDefault() {} })); await settle();
check('cart details send X-Cart-Session and render quote lines', new Headers(requests.find((request) => request.url.endsWith('/details'))?.headers).get('X-Cart-Session') === 'cart-session-1' && text(view).includes('2 × Control') && text(view).includes('$149.98'));
const cartStripeForm = one(view.root, 'stripe-payment-method-form');
await act(async () => cartStripeForm.props.onSubmit({ preventDefault() {} })); await settle();
const cartCheckout = requests.find((request) => request.url.endsWith('/checkout'));
check('cart checkout sends session, payment method and prefilled address', new Headers(cartCheckout?.headers).get('X-Cart-Session') === 'cart-session-1'
  && cartCheckout?.body.payment_method_id === 'pm_test_staff_sale'
  && JSON.stringify(cartCheckout?.body.shipping_address) === JSON.stringify(cartDetails.default_address)
  && cartCheckout?.body.payer === undefined,
JSON.stringify(cartCheckout));
check('paid cart renders receipt and order number', text(one(view.root, 'cart-payment-receipt')).includes('TH-CART01') && text(one(view.root, 'cart-payment-receipt')).includes('$149.98'));
view.unmount();

queue = [
  json(200, cartPeek),
  json(200, { request_id: 'verify-partial', devCode: '246810' }),
  json(200, { session: 'cart-session-partial' }),
  json(200, cartDetails),
  json(200, {
    cart_id: 'cart-partial', status: 'partial',
    items: [
      { kind: 'one_time', order_id: 'order-paid', order_number: 'TH-PAID02', subscription_id: null, status: 'paid', client_secret: null, error: null, total_cents: 6999 },
      { kind: 'subscription', order_id: 'order-failed', order_number: 'TH-FAIL02', subscription_id: 'sub-failed', status: 'failed', client_secret: null, error: 'The subscription payment was declined.', total_cents: 7999 },
    ],
    stripe_account_id: 'acct_cart', publishable_key: 'pk_test_cart', sandbox: true,
  }),
];
view = await render('/cart/partial-cart');
const partialPhoneForm = view.root.findByType('form');
await change(partialPhoneForm.findByType('input'), '6175550100');
await act(async () => partialPhoneForm.props.onSubmit({ preventDefault() {} })); await settle();
const partialCodeForm = view.root.findByType('form');
await change(partialCodeForm.findByType('input'), '246810');
await act(async () => partialCodeForm.props.onSubmit({ preventDefault() {} })); await settle();
await act(async () => one(view.root, 'stripe-payment-method-form').props.onSubmit({ preventDefault() {} })); await settle();
const partialReceipt = one(view.root, 'cart-partial-receipt');
check('partial cart receipt identifies paid and failed items and prevents a misleading retry',
  text(partialReceipt).includes('Some items were paid')
    && text(partialReceipt).includes('TH-PAID02 · Paid')
    && text(partialReceipt).includes('TH-FAIL02 · Failed')
    && text(partialReceipt).includes('The subscription payment was declined.')
    && text(partialReceipt).includes('Contact the office')
    && !text(view).includes('No payment was completed')
    && !text(view).includes('Try another card'));
view.unmount();

queue = [json(200, { status: 'expired', office: { name: 'Beacon Hill Aesthetics' }, sandbox: true })];
view = await render('/cart/expired-cart');
check('expired cart has friendly terminal copy', text(view).includes('This cart has expired') && text(view).includes('create a new QR code'));
view.unmount();

requests.length = 0;
queue = [json(200, cartPeek), json(400, { error: "That number doesn't match the patient on file.", attempts_left: 3 })];
view = await render('/cart/wrong-phone');
const wrongPhoneForm = view.root.findByType('form');
await change(wrongPhoneForm.findByType('input'), '6175559999');
await act(async () => wrongPhoneForm.props.onSubmit({ preventDefault() {} })); await settle();
check('wrong phone announces attempts left', text(view).includes("That number doesn't match the patient on file. 3 attempts left."));
view.unmount();

queue = [json(200, { status: 'locked', office: { name: 'Beacon Hill Aesthetics' }, sandbox: true })];
view = await render('/cart/locked-cart');
check('locked cart has friendly terminal copy', text(view).includes('This cart is locked') && text(view).includes('Too many phone numbers'));
view.unmount();

console.log('\nbilling public: done and cancel');
const paidStatus = {
  order_id: 'order-1', order_number: 'TH-ABC123', status: 'paid' as const, total_cents: 8639,
  tax_cents: 640, subtotal_cents: 6999, shipping_charge_cents: 1000,
  items: [{ name: 'Control', quantity: 1, unit_price_cents: 6999 }],
  office_name: 'Beacon Hill Aesthetics', payer_email: 'j***@example.com', subscription: null,
};
queue = [json(200, { ...paidStatus, status: 'pending' }), json(200, paidStatus)];
view = await render('/good/done?order=order-1&token=good&source=app');
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2050)); });
await settle();
check('done page renders the paid receipt', text(view).includes('TH-ABC123') && text(view).includes('Receipt sent to j***@example.com'));
check(
  'app checkout confirmation preserves its return guidance',
  Boolean(one(view.root, 'text-return-to-app')) &&
    text(one(view.root, 'text-return-to-app')).includes('Close this window to return to the THINNR app.'),
);
view.unmount();

queue = [
  json(200, { product_name: 'Control', office_name: 'Beacon Hill Aesthetics', unit_price_cents: 6999, shipping_charge_cents: 1000, status: 'active', current_period_end: '2027-01-15T00:00:00Z', cancel_at_period_end: false }),
  json(200, { product_name: 'Control', office_name: 'Beacon Hill Aesthetics', unit_price_cents: 6999, shipping_charge_cents: 1000, status: 'active', current_period_end: '2027-01-15T00:00:00Z', cancel_at_period_end: true }),
];
view = await render('/cancel/cancel-token');
const cancelButton = view.root.find((node) => node.type === 'button' && text(node).includes('Cancel at the end'));
await click(cancelButton);
await settle();
check('cancel page posts and confirms the cancellation', requests.at(-1)?.method === 'POST' && requests.at(-1)?.url.includes('/cancel') && text(view).includes('Your subscription will end after the current period.'));
view.unmount();

console.log(failures ? `\n${failures} billing public check(s) failed.` : '\nAll billing public checks passed.');
process.exit(failures ? 1 : 0);