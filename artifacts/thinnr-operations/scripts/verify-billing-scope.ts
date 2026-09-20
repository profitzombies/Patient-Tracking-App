import assert from 'node:assert/strict';
import { officeBilling, publicBilling } from '../src/lib/billing-api';
import { __setSession } from './invite-stubs/supabase';

__setSession('synthetic-token');
const calls: Array<{ headers: Headers; body: any }> = [];
let returnedScope = 'test:acct_synthetic';
globalThis.fetch = async (_url, init) => {
  calls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) });
  return new Response('{}', { headers: { 'Content-Type': 'application/json', 'X-Billing-Scope': returnedScope } });
};
const context = await officeBilling.saleContext('synthetic-patient');
assert.equal(context.billing_scope, 'test:acct_synthetic');
returnedScope = 'live:acct_synthetic';
await officeBilling.saleCheckout({} as any, undefined, 'stable-key', context.billing_scope);
assert.equal(calls.at(-1)!.headers.get('X-Billing-Scope'), 'test:acct_synthetic');
assert.equal(calls.at(-1)!.headers.get('Idempotency-Key'), 'stable-key');
const details = await publicBilling.cartDetails('synthetic-cart', 'synthetic-session');
assert.equal(details.billing_scope, 'live:acct_synthetic');
returnedScope = 'test:acct_other';
await publicBilling.cartCheckout('synthetic-cart', 'synthetic-session', {} as any, details.billing_scope);
assert.equal(calls.at(-1)!.headers.get('X-Billing-Scope'), 'live:acct_synthetic');
assert.equal(calls.at(-1)!.headers.get('X-Cart-Session'), 'synthetic-session');
assert.equal(calls.length, 4, 'Mutations must not silently fetch a newer billing scope');
console.log('Web billing scopes: response capture and original-context mutation headers passed.');