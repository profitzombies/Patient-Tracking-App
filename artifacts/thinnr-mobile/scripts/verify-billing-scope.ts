import assert from 'node:assert/strict';
import { checkoutCart, startCardSetup, addCard, getShop } from '../lib/patient-billing-api';
import { setStubSession } from './live-diary-stubs/supabase';
import { officeBilling } from '../lib/office-billing-api';

async function main() {
  process.env.EXPO_PUBLIC_DOMAIN = 'synthetic.test';
  setStubSession({ access_token: 'synthetic-token', user: { id: 'synthetic-user' } } as any);
  const calls: Array<{ headers: Headers; body: any }> = [];
  let returnedScope = 'test:acct_synthetic';
  globalThis.fetch = async (_url, init) => {
    calls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response('{}', { headers: { 'Content-Type': 'application/json', 'X-Billing-Scope': returnedScope } });
  };
  const shop = await getShop();
  assert.equal(shop.billing_scope, 'test:acct_synthetic');
  returnedScope = 'live:acct_other';
  const pending = JSON.parse(JSON.stringify({ billing_scope: shop.billing_scope, lines: [] }));
  await checkoutCart(pending, 'stable-cart', { accessToken: 'synthetic-token' });
  assert.equal(calls.at(-1)!.headers.get('X-Billing-Scope'), 'test:acct_synthetic');
  assert.equal(calls.at(-1)!.body.billing_scope, undefined);
  await startCardSetup(shop.billing_scope);
  assert.equal(calls.at(-1)!.headers.get('X-Billing-Scope'), 'test:acct_synthetic');
  await addCard({ payment_method_id: 'synthetic-card' } as any, shop.billing_scope);
  assert.equal(calls.at(-1)!.headers.get('X-Billing-Scope'), 'test:acct_synthetic');
  assert.equal(calls.length, 4, 'No automatic latest-scope fetch is permitted');
  const staff = { userId: 'synthetic-user' };
  const context = await officeBilling.saleContext('synthetic-patient', staff);
  const captured = { ...staff, billingScope: context.billing_scope };
  returnedScope = 'test:acct_replacement';
  await officeBilling.saleCheckout({} as any, captured, 'stable-card-sale');
  assert.equal(calls.at(-1)!.headers.get('X-Billing-Scope'), 'live:acct_other');
  await officeBilling.tapSale({} as any, captured, 'stable-tap-sale');
  assert.equal(calls.at(-1)!.headers.get('X-Billing-Scope'), 'live:acct_other');
  assert.equal(calls.at(-1)!.headers.get('Idempotency-Key'), 'stable-tap-sale');
  assert.equal(calls.length, 7);
  console.log('Mobile billing scopes: capture, persisted retry, card setup and card save passed.');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });