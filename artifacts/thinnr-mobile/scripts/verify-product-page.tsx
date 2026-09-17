/**
 * Product page contract check (real providers, scripted HTTP).
 *
 * The route resolves by slug, storefront product id, AND the legacy catalog
 * id the coach's product card still pushes (/product/prod3). The page shows
 * the full content sections, the one-time / subscribe toggle with cadence
 * picker and subscribe-and-save price, quantity, and Add to cart, which
 * lands the right line in the shared cart (merging repeats). Bundles have no
 * subscription choice. Unknown products get an explicit state, and the demo
 * persona renders the same page from the bundled storefront.
 */
import {
  act, alerts, assert, finish, has, hosts, mount, press, productBySlug, script, section, shopCalls,
  signIn, signOut, storageMap, text, allText, unmount,
} from './shop-stubs/harness';
import React from 'react';
import { readFileSync } from 'node:fs';
import ProductScreen from '../app/product/[id]';
import CareTeamBundleScreen from '../app/care-team-bundle';
import { CareTeamChatProvider } from '../context/CareTeamChatContext';
import { routerLog, setSearchParams } from './provider-training-stubs/expo-router';
import { announcements } from './onboarding-gate-stubs/react-native';
import { findCatalogProduct } from '../data/product-catalog';

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cartLines = () => (JSON.parse(storageMap.get('thinnr_cart_v1:patient-1') ?? '{"lines":[]}') as { lines: { product_id: string; quantity: number; purchase: string; cadence_weeks: number | null }[] }).lines;

async function main() {
  await signIn();
  const control = productBySlug('control');
  const subUnit = control.subscription_unit_price_cents as number;

  section('resolves by slug, product id, and legacy catalog id');
  for (const ref of ['control', control.product_id, 'prod3']) {
    setSearchParams({ id: ref });
    const tree = await mount(<ProductScreen />);
    assert(`/product/${ref} renders Control`, text(tree, 'pdp-name') === 'Control' && !has(tree, 'pdp-missing'));
    await unmount(tree);
  }
  assert('legacy id prod3 really maps to the Control slug', findCatalogProduct('prod3')?.slug === 'control');
  const coachCard = readFileSync(new URL('../components/coach/ProductSuggestionCard.tsx', import.meta.url), 'utf8');
  assert('coach product card pushes /product/<slug>', /router\.push\(`\/product\/\$\{slug\}`\)/.test(coachCard) && /slug: card\.slug \?\? bundled\?\.slug \?\? card\.productId \?\? card\.id/.test(coachCard));

  section('content sections');
  setSearchParams({ id: 'control' });
  let tree = await mount(<ProductScreen />);
  const page = allText(tree);
  assert('tagline, description, benefits, facts, FAQs, disclaimer all present', [control.tagline, control.description, control.benefits[0], control.facts[0].name, control.faqs[0].question, control.faqs[0].answer, control.disclaimer].every(piece => piece && page.includes(piece)) && page.toUpperCase().includes(control.facts_title.toUpperCase()));
  assert('gallery renders the storefront images', has(tree, 'pdp-gallery'));
  assert('list price and subscribe-and-save price shown', text(tree, 'pdp-price') === money(control.unit_price_cents) && text(tree, 'pdp-subscribe-price').includes(money(subUnit)) && text(tree, 'pdp-subscribe-price').includes(`${script.shop.subscribe_save_percent}%`));
  assert('storefront fetched once with bearer', shopCalls().filter(call => call.path.endsWith('/shop')).length >= 1 && shopCalls().every(call => call.auth === 'Bearer patient-token'));

  section('one-time purchase');
  assert('defaults to one-time, quantity 1, no cadence picker', text(tree, 'pdp-qty-value') === '1' && !has(tree, 'pdp-cadence-4') && text(tree, 'pdp-total') === money(control.unit_price_cents));
  await press(tree, 'pdp-qty-inc');
  await press(tree, 'pdp-qty-inc');
  assert('quantity steps and the item total follows', text(tree, 'pdp-qty-value') === '3' && text(tree, 'pdp-total') === money(control.unit_price_cents * 3) && !has(tree, 'pdp-saving'));
  await press(tree, 'pdp-add-cart');
  assert('Add to cart writes a one-time line and confirms inline + announces', cartLines().length === 1 && cartLines()[0].product_id === control.product_id && cartLines()[0].quantity === 3 && cartLines()[0].purchase === 'one_time' && has(tree, 'pdp-added') && text(tree, 'pdp-added').includes('3 × Control') && announcements.some(a => a.includes('3 × Control')));
  assert('header badge reflects the cart', text(tree, 'pdp-cart-count') === '3');
  await press(tree, 'pdp-view-cart');
  assert('View cart routes to /cart', routerLog.at(-1)?.target === '/cart');

  section('subscription purchase');
  await press(tree, 'pdp-subscribe');
  assert('subscribe reveals cadence picker at the default cadence and the discounted total', has(tree, `pdp-cadence-${control.default_cadence_weeks}`) && text(tree, 'pdp-total') === money(subUnit * 3) && text(tree, 'pdp-saving').includes(money((control.unit_price_cents - subUnit) * 3)));
  await press(tree, 'pdp-cadence-12');
  await press(tree, 'pdp-qty-dec');
  await press(tree, 'pdp-add-cart');
  const sub = cartLines().find(line => line.purchase === 'subscription');
  assert('subscription line carries the chosen cadence and quantity, separate from the one-time line', cartLines().length === 2 && sub?.cadence_weeks === 12 && sub?.quantity === 2 && cartLines()[0].quantity === 3);
  await press(tree, 'pdp-add-cart');
  assert('adding the same subscription again merges quantities', cartLines().length === 2 && cartLines().find(line => line.purchase === 'subscription')?.quantity === 4);
  await press(tree, 'pdp-one-time');
  assert('switching back hides the cadence picker and saving', !has(tree, 'pdp-cadence-12') && !has(tree, 'pdp-saving'));
  await unmount(tree);

  section('how to take');
  const creatine = productBySlug('creatine-plus');
  setSearchParams({ id: creatine.slug });
  tree = await mount(<ProductScreen />);
  assert('suggested use renders verbatim when the product has one', creatine.how_to_take.length > 0 && allText(tree).includes(creatine.how_to_take));
  await unmount(tree);

  section('bundle: no subscription');
  const bundle = script.shop.products.find(product => !product.subscription_available)!;
  setSearchParams({ id: bundle.slug });
  tree = await mount(<ProductScreen />);
  const subscribeButton = hosts(tree, 'pdp-subscribe')[0];
  assert('bundle offers no subscribe choice and no subscribe price', (!subscribeButton || subscribeButton.props.disabled === true || subscribeButton.props['aria-disabled'] === true || subscribeButton.props.accessibilityState?.disabled === true) && !has(tree, 'pdp-subscribe-price'));
  await unmount(tree);

  section('cart locked behind a pending payment');
  const priorLines = cartLines();
  const pendingLine = { product_id: control.product_id, quantity: 1, purchase: 'one_time', cadence_weeks: null };
  const pendingQuote = { lines: [{ ...pendingLine, unit_price_cents: control.unit_price_cents, list_price_cents: control.unit_price_cents, discount_cents: 0, line_total_cents: control.unit_price_cents }], groups: [], subtotal_cents: control.unit_price_cents, discount_cents: 0, shipping_charge_cents: script.shop.shipping_charge_cents, tax_enabled: false, tax_cents: 0, total_cents: control.unit_price_cents + script.shop.shipping_charge_cents, total_due_cents: control.unit_price_cents + script.shop.shipping_charge_cents };
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines: [pendingLine], pending: { cartId: 'cart-pending-1', request: { lines: [{ product_id: control.product_id, quantity: 1, purchase: 'one_time' }], shipping_address: { name: 'P', line1: '1', line2: null, city: 'B', state: 'MA', postal_code: '02110', country: 'US', phone: null }, payment_method_id: 'pm_x', set_default: false, expected_total_due_cents: pendingQuote.total_due_cents }, quote: pendingQuote } }));
  setSearchParams({ id: 'fiber' });
  tree = await mount(<ProductScreen />);
  await press(tree, 'pdp-add-cart');
  assert('Add is refused while a payment is unsettled: the line is NOT written, the lock is explained, and the way forward is Confirm payment', cartLines().length === 1 && cartLines()[0].product_id === control.product_id && has(tree, 'pdp-locked') && !has(tree, 'pdp-added') && has(tree, 'pdp-confirm-payment'));
  await press(tree, 'pdp-confirm-payment');
  assert('Confirm payment routes to /checkout', routerLog.at(-1)?.target === '/checkout');
  await unmount(tree);
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines: priorLines }));

  section('care-team param preselection');
  setSearchParams({
    id: control.product_id,
    purchase: 'subscription',
    cadence: '12',
    quantity: '4',
    suggestedName: control.name,
  });
  tree = await mount(<ProductScreen />);
  assert('suggested purchase params preselect subscription, cadence, and quantity',
    has(tree, 'pdp-cadence-12') &&
    hosts(tree, 'pdp-subscribe')[0]?.props.accessibilityState?.checked === true &&
    text(tree, 'pdp-qty-value') === '4' &&
    text(tree, 'pdp-total') === money(subUnit * 4));
  await unmount(tree);

  section('unknown product');
  setSearchParams({
    id: 'not-a-product',
    suggestedName: 'Care Team Formula',
    suggestedImage: 'https://example.test/formula.jpg',
  });
  tree = await mount(<ProductScreen />);
  assert('unknown ref shows the care-team fallback name and informational state',
    has(tree, 'pdp-missing') &&
    text(tree, 'pdp-name') === 'Care Team Formula' &&
    text(tree, 'pdp-missing').includes("isn't available right now") &&
    has(tree, 'pdp-missing-shop') &&
    !has(tree, 'pdp-add-cart'));
  await press(tree, 'pdp-missing-shop');
  assert('Browse the shop replaces to /shop', routerLog.at(-1)?.target === '/shop');
  await unmount(tree);

  section('known product unavailable right now');
  const availableShop = script.shop;
  script.shop = { ...availableShop, available: false, unavailable_reason: 'not_connected' };
  setSearchParams({ id: control.product_id, suggestedName: 'Wrong fallback' });
  tree = await mount(<ProductScreen />);
  assert('known unavailable row opens informationally: storefront copy, office notice, no price or purchase controls',
    text(tree, 'pdp-name') === control.name &&
    allText(tree).includes(control.description) &&
    has(tree, 'pdp-informational') &&
    !has(tree, 'pdp-price') &&
    !has(tree, 'pdp-add-cart'));
  await unmount(tree);
  script.shop = availableShop;

  section('demo persona');
  await signOut();
  shopCalls().length;
  const before = shopCalls().length;
  setSearchParams({ id: 'prod3' });
  tree = await mount(<ProductScreen />);
  assert('demo renders Control from the bundled storefront, offline', text(tree, 'pdp-name') === 'Control' && shopCalls().length === before && has(tree, 'pdp-subscribe-price'));
  await press(tree, 'pdp-add-cart');
  assert('demo cart is separate from the real cart', has(tree, 'pdp-added') && (JSON.parse(storageMap.get('thinnr_cart_v1:demo') ?? '{"lines":[]}') as { lines: unknown[] }).lines.length === 1 && cartLines().length === 2);
  await unmount(tree);

  section('demo care-team bundle checkout');
  setSearchParams({ clientId: 'demo-care-team-bundle' });
  tree = await mount(<CareTeamChatProvider><CareTeamBundleScreen /></CareTeamChatProvider>);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
  assert('bundle summary is restored from the message and has a checkout action',
    has(tree, 'care-team-bundle-summary') &&
    has(tree, 'care-team-bundle-checkout') &&
    text(tree, 'care-team-bundle-total').includes('$'));
  await press(tree, 'care-team-bundle-checkout');
  const demoBundleLines = (JSON.parse(storageMap.get('thinnr_cart_v1:demo') ?? '{"lines":[]}') as { lines: { product_id: string }[] }).lines;
  assert('bundle checkout replaces cart with available lines and navigates to checkout',
    demoBundleLines.length === 2 &&
    demoBundleLines.some(line => line.product_id === 'demo-boost') &&
    demoBundleLines.some(line => line.product_id === 'demo-control') &&
    routerLog.at(-1)?.target === '/checkout');
  await unmount(tree);
  assert('no alerts fired', alerts.length === 0);

  finish();
}

main().catch(error => { console.error(error); process.exit(1); });
