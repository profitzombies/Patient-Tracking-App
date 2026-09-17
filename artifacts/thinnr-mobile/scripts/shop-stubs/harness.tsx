/**
 * Shared harness for the shop suites: a scripted HTTP boundary (claim,
 * patient state, storefront, quote, checkout, cards), the REAL account /
 * patient / cart providers, and small tree helpers. Each suite imports this
 * first so the globals (localStorage, window, fetch) exist before the app
 * modules load.
 */
process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, String(value)),
  removeItem: (key: string) => void storage.delete(key),
};
export const alerts: string[] = [];
(globalThis as Record<string, unknown>).window = {
  open: () => ({}),
  alert: (message: string) => { alerts.push(message); },
  confirm: () => true,
};

import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { CartProvider } from '../../context/CartContext';
import { PatientAccountProvider } from '../../context/PatientAccountProvider';
import { PatientProvider } from '../../context/PatientContext';
import { localQuote, type CartLine } from '../../lib/cart-math';
import { buildDemoShop } from '../../lib/shop-catalog';
import type { CartCheckoutResponse, PatientShop, PublicLinkProduct } from '../../lib/patient-billing-types';
import { setStubSession, type StubSession } from '../live-diary-stubs/supabase';

export { act, setStubSession };
export const storageMap = storage;

let checks = 0;
let failures = 0;
export function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) { failures += 1; console.error(`  FAIL  ${label}`); }
}
export function section(label: string) { console.log(`\n· ${label}`); }
export function finish() {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

export type Call = { method: string; path: string; auth: string | null; headers: Record<string, string>; body: Record<string, unknown> | null };
export const calls: Call[] = [];
export const shopCalls = () => calls.filter(call => call.path.startsWith('patient-data/billing/'));

/** The "real office" storefront: the demo catalog re-keyed with server-style ids. */
export function liveShop(): PatientShop {
  const demo = buildDemoShop();
  return {
    ...demo,
    office: { provider_id: 'office-1', office_name: 'Harbor Health', payments_available: true },
    products: demo.products.map(product => ({ ...product, product_id: `prod-${product.slug}`, image_urls: [`/objects/products/${product.slug}.jpg`], image_url: `/objects/products/${product.slug}.jpg` })),
    default_address: { name: 'Pat Example', line1: '9 Harbor Rd', line2: 'Unit 4', city: 'Boston', state: 'MA', postal_code: '02110', country: 'US', phone: '+15550001010' },
    stripe_account_id: 'acct_office1',
    publishable_key: 'pk_test_office1',
    sandbox: true,
  };
}
export const unavailableShop = (reason: 'not_connected' | 'no_products'): PatientShop => ({
  office: { provider_id: 'office-1', office_name: 'Harbor Health', payments_available: false },
  available: false, unavailable_reason: reason, products: [], shipping_charge_cents: 0, subscribe_save_percent: 0,
  default_address: null, stripe_account_id: null, publishable_key: null, sandbox: true, tax_enabled: false,
});

type CheckoutAnswer = { status: number; body: unknown } | 'network';

export const script = {
  shop: liveShop() as PatientShop,
  shopFailure: null as null | { status: number; error: string },
  quoteFailure: null as null | { status: number; error: string },
  /** Sales-tax rate the fake Stripe Tax applies when the shop collects tax and a quote carries an address. */
  taxRate: 0.0825,
  cards: { cards: [] as { id: string; brand: string; last4: string; exp_month: number; exp_year: number; is_default: boolean }[], default_payment_method_id: null as string | null },
  /** Decides each checkout answer; receives the attempt number for that cart id. */
  checkout: ((_body, _cartId, _attempt) => ({ status: 200, body: paidResponse('cart', []) })) as (body: Record<string, unknown>, cartId: string, attempt: number) => CheckoutAnswer | Promise<CheckoutAnswer>,
  checkoutAttempts: new Map<string, number>(),
};

export function paidResponse(cartId: string, lines: CartLine[]): CartCheckoutResponse {
  const products = script.shop.products;
  const quote = localQuote(lines, products, script.shop.shipping_charge_cents);
  let n = 0;
  return {
    cart_id: cartId,
    status: 'paid',
    items: quote.groups.map(group => {
      n += 1;
      return {
        kind: group.kind, order_id: `order-${n}`, order_number: `TH-10${n}`,
        subscription_id: group.kind === 'subscription' ? `sub-${n}` : null,
        status: 'paid', client_secret: null, error: null, total_cents: group.total_cents,
        product_ids: group.kind === 'subscription' ? [group.product_id as string] : quote.lines.filter(line => line.purchase === 'one_time').map(line => line.product_id),
      };
    }),
    stripe_account_id: 'acct_office1', publishable_key: 'pk_test_office1', sandbox: true,
  };
}

export const profile = { firstName: 'Pat', lastName: 'Example', email: 'pat@example.com', phone: '+15550001010', dateOfBirth: '1985-04-03', heightInches: 66, startingWeight: 205, currentWeight: 191, goalWeight: 165, timezone: 'America/New_York', programId: 'glp1', programStartDate: '2026-08-20', setupComplete: true };
const patientState = { entries: [], water: {}, targets: {}, favorites: [], recents: [], customFoods: [], catalogFoods: [], savedRecipes: [], photos: [], checkIns: [], medications: [], doseLogs: [], flags: { nudgeOptOut: false, nudgeEngaged: false, nudgeLastSentKey: null, nudgeLastCrossingKey: null, onboardingComplete: true }, entry: { firstName: 'Pat', programStartDate: '2026-08-20', todayKey: '2026-09-07', programDay: 19 }, profile };

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.slice('/api/'.length);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const call: Call = {
    method: (init?.method ?? 'GET').toUpperCase(),
    path,
    auth: headers.Authorization ?? null,
    headers,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null,
  };
  calls.push(call);
  let status = 200;
  let body: unknown;
  // The account follows the bearer, so a scripted session switch resolves to a second patient.
  if (path === 'claim/whoami') body = { kind: 'patient', patientId: call.auth === `Bearer ${otherSession.access_token}` ? 'patient-2' : 'patient-1' };
  else if (path.startsWith('patient-data/state')) body = patientState;
  else if (path === 'patient-data/profile') body = { profile };
  else if (path === 'patient-data/billing/shop') {
    if (script.shopFailure) { status = script.shopFailure.status; body = { error: script.shopFailure.error }; }
    else body = script.shop;
  } else if (path === 'patient-data/billing/cart/quote') {
    if (script.quoteFailure) { status = script.quoteFailure.status; body = { error: script.quoteFailure.error }; }
    else {
      const quote = localQuote((call.body?.lines as CartLine[]).map(line => ({ ...line, cadence_weeks: line.cadence_weeks ?? null })), script.shop.products, script.shop.shipping_charge_cents, !!script.shop.tax_enabled);
      // Like the server: a tax office's quote is only final once an address is in.
      if (quote.tax_enabled && call.body?.shipping_address) {
        const tax = Math.round(quote.total_cents * script.taxRate);
        body = { ...quote, tax_cents: tax, total_due_cents: quote.total_cents + tax };
      } else body = quote;
    }
  } else if (path === 'patient-data/billing/cart/checkout') {
    const cartId = String(call.body?.cart_id ?? '');
    const attempt = (script.checkoutAttempts.get(cartId) ?? 0) + 1;
    script.checkoutAttempts.set(cartId, attempt);
    const answer = await script.checkout(call.body ?? {}, cartId, attempt);
    if (answer === 'network') throw new TypeError('Failed to fetch');
    status = answer.status; body = answer.body;
  } else if (path === 'patient-data/billing/cards') body = script.cards;
  else throw new Error(`Unscripted request: ${call.method} ${path}`);
  return { ok: status < 300, status, json: async () => body } as Response;
}) as typeof fetch;

export async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); });
}
export async function mount(element: React.ReactElement): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <PatientAccountProvider><PatientProvider><CartProvider>{element}</CartProvider></PatientProvider></PatientAccountProvider>,
    );
  });
  await settle();
  return tree;
}
export async function unmount(tree: ReactTestRenderer) { await act(async () => tree.unmount()); }
export function hosts(tree: ReactTestRenderer, id: string) {
  return tree.root.findAllByProps({ testID: id }).filter(node => typeof node.type === 'string');
}
export function has(tree: ReactTestRenderer, id: string) { return hosts(tree, id).length > 0; }
export function text(tree: ReactTestRenderer, id: string): string {
  const flatten = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(flatten).join('');
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (value && typeof value === 'object' && 'children' in value) return flatten((value as { children?: unknown }).children);
    if (value && typeof value === 'object' && 'props' in value) return flatten((value as { props: { children?: unknown } }).props.children);
    return '';
  };
  return hosts(tree, id).map(node => flatten(node.children)).join('');
}
export function allText(tree: ReactTestRenderer): string {
  const flatten = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(flatten).join(' ');
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (value && typeof value === 'object' && 'children' in value) return flatten((value as { children?: unknown }).children);
    return '';
  };
  return flatten(tree.toJSON());
}
export function pressable(tree: ReactTestRenderer, id: string) {
  return hosts(tree, id).find(candidate => typeof candidate.props.onPress === 'function') ?? null;
}
export async function press(tree: ReactTestRenderer, id: string) {
  const node = pressable(tree, id);
  if (!node) throw new Error(`Missing button ${id}`);
  await act(async () => node.props.onPress());
  await settle();
}
export async function type(tree: ReactTestRenderer, id: string, value: string) {
  const node = hosts(tree, id).find(candidate => typeof candidate.props.onChangeText === 'function');
  if (!node) throw new Error(`Missing input ${id}`);
  await act(async () => node.props.onChangeText(value));
  await settle(2);
}
export const session: StubSession = { access_token: 'patient-token', user: { id: 'user-1' } };
/** A second signed-in patient (whoami resolves this bearer to patient-2). */
export const otherSession: StubSession = { access_token: 'patient-2-token', user: { id: 'user-2' } };
export async function signIn(as: StubSession = session) { await act(async () => setStubSession(as)); await settle(); }
export async function signOut() { await act(async () => setStubSession(null)); await settle(); }
export function productBySlug(slug: string): PublicLinkProduct {
  const product = script.shop.products.find(row => row.slug === slug);
  if (!product) throw new Error(`No product ${slug}`);
  return product;
}
