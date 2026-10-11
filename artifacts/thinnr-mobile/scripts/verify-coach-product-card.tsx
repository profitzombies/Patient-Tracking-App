/**
 * Coach product card → shop product page handoff (real providers, scripted HTTP).
 *
 * A real account's card carries the office's own storefront identity (uuid
 * product id, HQ-edited name/line/image) plus the office's own price and
 * whether ordering is open; a payload without a live price falls back to the
 * bundled copy. Tapping the card routes to /product/<slug>, where the product
 * page prices from the live storefront (one-time and subscribe options) or,
 * when the office cannot take orders, opens informationally with no buy
 * button. Payload parsing is strict: a bare bundled id still renders (legacy
 * shape), a bare unknown id or garbage renders nothing.
 */
import {
  act, assert, finish, has, liveShop, mount, press, pressable, productBySlug, script, section, signIn, signOut, text, unavailableShop, unmount,
} from './shop-stubs/harness';
import React from 'react';
import ProductScreen from '../app/product/[id]';
import { CoachCardSlot } from '../components/coach/CoachCardSlot';
import { formatCardPrice, readProductCardPayload, resolveProductCard } from '../components/coach/ProductSuggestionCard';
import { routerLog, setSearchParams } from './provider-training-stubs/expo-router';
import { findCatalogProduct } from '../data/product-catalog';
import { PRODUCT_IMAGES } from '@/data/product-images';

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const creatine = findCatalogProduct('prod7')!;
// Live cards carry the storefront's own id (a uuid the bundled catalog has
// never seen), HQ copy, and the HQ image; the harness storefront's product id
// for the same slug is what the product page resolves.
const LIVE_ID = '9b2e4c7a-3d1f-4e8b-a6c5-000000000007';
const livePayload = {
  id: LIVE_ID, slug: creatine.slug, name: 'Creatine+ (HQ edited)', line: 'HQ line: lean mass support.',
  price: 45.5, priceCents: 4550, productId: LIVE_ID, imageUrl: 'https://cdn.example/creatine.png',
  available: true, subscriptionAvailable: true, reason: 'low_protein', cta: 'Tap to open',
};
const legacyPayload = { id: creatine.id, slug: creatine.slug, name: creatine.name, line: creatine.cardLine, price: creatine.price, priceCents: null, productId: null, imageUrl: null, available: true, subscriptionAvailable: true, reason: 'conversation', cta: 'Tap to open' };

function card(payload: unknown, readOnly = false) {
  return <CoachCardSlot card={{ kind: 'product', payload }} messageId="m1" readOnly={readOnly} />;
}

async function main() {
  section('payload parsing');
  assert('live payload keeps the office price in dollars', readProductCardPayload(livePayload)?.price === 45.5 && readProductCardPayload(livePayload)?.available === true);
  assert('legacy payload (no priceCents) falls back to the bundled price', readProductCardPayload(legacyPayload)?.price === null);
  assert('legacy bare-id payload still parses with defaults', JSON.stringify(readProductCardPayload({ id: 'prod7' })) === JSON.stringify({ id: 'prod7', slug: null, name: null, line: null, price: null, productId: null, imageUrl: null, available: true, cta: 'Tap to open' }));
  assert('garbage payloads parse to null', readProductCardPayload(null) === null && readProductCardPayload({ slug: 'x' }) === null && readProductCardPayload('prod7') === null);
  assert('prices format as whole dollars or cents', formatCardPrice(55) === '$55' && formatCardPrice(45.5) === '$45.50');

  section('card resolution: payload first, bundled catalog only as a fallback');
  const liveResolved = resolveProductCard(readProductCardPayload(livePayload)!)!;
  assert('live card shows HQ name, line, price, and image, never the bundled copy', liveResolved.name === 'Creatine+ (HQ edited)' && liveResolved.line === 'HQ line: lean mass support.' && liveResolved.price === 45.5 && JSON.stringify(liveResolved.image) === JSON.stringify({ uri: 'https://cdn.example/creatine.png' }) && liveResolved.slug === creatine.slug);
  const hqOnly = resolveProductCard(readProductCardPayload({ id: '9b2e4c7a-3d1f-4e8b-a6c5-000000000099', slug: 'sleep-support', name: 'Sleep Support', line: 'Wind down.', priceCents: 8999, productId: '9b2e4c7a-3d1f-4e8b-a6c5-000000000099', imageUrl: null, available: true })!)!;
  assert('an HQ-created product unknown to the bundled catalog still renders, without artwork', hqOnly !== null && hqOnly.name === 'Sleep Support' && hqOnly.price === 89.99 && hqOnly.image === undefined && hqOnly.slug === 'sleep-support');
  // The Node stub of the bundled artwork map is mutable and starts empty, so
  // the fallback is proven by planting one entry under the bundled id.
  PRODUCT_IMAGES[creatine.id] = { uri: 'bundled://creatine' };
  const liveNoImage = resolveProductCard(readProductCardPayload({ ...livePayload, imageUrl: null })!)!;
  assert('a live card with no HQ image borrows the bundled artwork for its slug', JSON.stringify(liveNoImage.image) === JSON.stringify({ uri: 'bundled://creatine' }));
  delete PRODUCT_IMAGES[creatine.id];
  const legacy = resolveProductCard(readProductCardPayload({ id: 'prod7' })!)!;
  assert('legacy bare bundled id fills name, line, price, and slug from the bundled catalog', legacy.name === creatine.name && legacy.line === creatine.cardLine && legacy.price === creatine.price && legacy.slug === creatine.slug);
  assert('a bare unknown id with no copy resolves to nothing', resolveProductCard(readProductCardPayload({ id: 'prod999', priceCents: 100 })!) === null);

  section('real account: card shows the office price and opens the live product page');
  await signIn();
  let tree = await mount(card(livePayload));
  assert('card renders with the office price and the CTA', has(tree, 'coach-product-card') && text(tree, 'coach-product-price') === '$45.50' && text(tree, 'coach-product-view').includes('TAP TO OPEN') && !has(tree, 'coach-product-unavailable'));
  const liveImage = tree.root.findAllByProps({ testID: 'coach-product-image' }).find((node) => typeof node.type === 'string');
  assert('card shows the HQ name and image', pressable(tree, 'coach-product-card')?.props.accessibilityLabel?.startsWith('Creatine+ (HQ edited), $45.50') && JSON.stringify(liveImage?.props.source) === JSON.stringify({ uri: 'https://cdn.example/creatine.png' }));
  const before = routerLog.length;
  await press(tree, 'coach-product-card');
  assert('tap routes to /product/<slug>', routerLog.length === before + 1 && routerLog.at(-1)?.method === 'push' && routerLog.at(-1)?.target === `/product/${creatine.slug}`);
  await unmount(tree);

  const live = productBySlug(creatine.slug);
  setSearchParams({ id: creatine.slug });
  tree = await mount(<ProductScreen />);
  assert('product page renders Creatine+ from the live storefront', text(tree, 'pdp-name') === creatine.name && !has(tree, 'pdp-missing'));
  assert('page shows the office list price and the subscribe-and-save option', text(tree, 'pdp-price') === money(live.unit_price_cents) && has(tree, 'pdp-subscribe-price') && text(tree, 'pdp-subscribe-price').includes(money(live.subscription_unit_price_cents as number)));
  assert('one-time purchase panel with Add to cart is present', has(tree, 'pdp-add-cart') && !has(tree, 'pdp-informational'));
  await unmount(tree);

  section('read-only history: the card is inert');
  tree = await mount(card(livePayload, true));
  const inert = pressable(tree, 'coach-product-card');
  assert('read-only card is disabled for taps and assistive tech', inert?.props.disabled === true && inert?.props.accessibilityState?.disabled === true);
  await unmount(tree);

  section('ordering closed: card flags it and the page opens informationally');
  // The server keeps returning the offering when ordering is closed so the
  // informational page can still resolve the product.
  script.shop = { ...unavailableShop('not_connected'), products: liveShop().products };
  const closedPayload = { ...livePayload, available: false, subscriptionAvailable: false };
  tree = await mount(card(closedPayload));
  assert('card shows ORDERING CLOSED next to the price', text(tree, 'coach-product-unavailable') === 'ORDERING CLOSED' && text(tree, 'coach-product-price') === '$45.50');
  await press(tree, 'coach-product-card');
  assert('tap still routes to the product page', routerLog.at(-1)?.target === `/product/${creatine.slug}`);
  await unmount(tree);
  await signOut();
  await signIn();
  setSearchParams({ id: creatine.slug });
  tree = await mount(<ProductScreen />);
  assert('informational page: no buy button, no price row, notice names the office', has(tree, 'pdp-informational') && !has(tree, 'pdp-add-cart') && !has(tree, 'pdp-price') && text(tree, 'pdp-informational').includes('Harbor Health') && text(tree, 'pdp-name') === creatine.name);
  await unmount(tree);

  section('signed out: card still routes, product page asks to sign in');
  await signOut();
  tree = await mount(card(legacyPayload));
  assert('signed-out card falls back to the bundled catalog price', text(tree, 'coach-product-price') === formatCardPrice(creatine.price));
  await press(tree, 'coach-product-card');
  assert('signed-out tap routes to the same product page', routerLog.at(-1)?.target === `/product/${creatine.slug}`);
  await unmount(tree);
  setSearchParams({ id: creatine.slug });
  tree = await mount(<ProductScreen />);
  assert('signed-out product page shows the sign-in state with no buy panel', has(tree, 'pdp-error') && text(tree, 'pdp-error').includes('Sign in') && !has(tree, 'pdp-add-cart') && !has(tree, 'pdp-price'));
  await unmount(tree);

  section('HQ-created product: renders from the payload with a placeholder thumbnail');
  await signIn();
  tree = await mount(card({ id: '9b2e4c7a-3d1f-4e8b-a6c5-000000000099', slug: 'sleep-support', name: 'Sleep Support', line: 'Wind down.', priceCents: 8999, productId: '9b2e4c7a-3d1f-4e8b-a6c5-000000000099', imageUrl: null, available: true, cta: 'Tap to open' }));
  assert('card renders Sleep Support at $89.99 with a placeholder', has(tree, 'coach-product-card') && text(tree, 'coach-product-price') === '$89.99' && has(tree, 'coach-product-image-placeholder') && !has(tree, 'coach-product-image'));
  await press(tree, 'coach-product-card');
  assert('tap routes to /product/sleep-support', routerLog.at(-1)?.target === '/product/sleep-support');
  await unmount(tree);
  await signOut();

  section('unknown bare id renders no card');
  tree = await mount(card({ id: 'prod999', priceCents: 100 }));
  assert('unknown id with no copy: nothing rendered', !has(tree, 'coach-product-card'));
  await unmount(tree);
  await act(async () => {});

  finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
