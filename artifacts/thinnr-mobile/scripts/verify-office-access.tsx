import React from 'react';
import { check, finish, mount, one, press, requests, section, setScript, STAFF, text } from './payments-stubs/harness';
import PaymentMethodsScreen from '../app/(tabs)/payments/payment-methods';
import { officeAccessGateDecision } from '../lib/office-access-gate';
import { setStaffCardBridgeForTests } from '../lib/staff-card-bridge';
import type { OfficeAccessSnapshot } from '../lib/office-access-types';

const SNAPSHOT: OfficeAccessSnapshot = {
  office: { providerId: 'provider-1', officeName: 'Maple Med Spa' },
  complete: true,
  connectAlreadyDone: true,
  steps: [
    { id: 'connect', status: 'done', detail: null },
    { id: 'bank', status: 'done', detail: null },
    { id: 'card_primary', status: 'done', detail: null },
    { id: 'card_backup', status: 'done', detail: null },
    { id: 'plan', status: 'done', detail: null },
    { id: 'disclosure', status: 'done', detail: null },
  ],
  connect: { state: 'ready', sandbox: true },
  instruments: [
    { slot: 'bank', kind: 'bank', brand: null, last4: '6789', expMonth: null, expYear: null, bankName: 'Test Bank', verificationStatus: 'verified', verificationDeadline: null, addedAt: '2026-01-01T00:00:00Z' },
    { slot: 'card_primary', kind: 'card', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030, bankName: null, verificationStatus: 'verified', verificationDeadline: null, addedAt: '2026-01-01T00:00:00Z' },
    { slot: 'card_backup', kind: 'card', brand: 'mastercard', last4: '4444', expMonth: 8, expYear: 2031, bankName: null, verificationStatus: 'verified', verificationDeadline: null, addedAt: '2026-01-01T00:00:00Z' },
  ],
  plan: { selected: 'monthly', monthlyPriceCents: 20000, yearlyPriceCents: 200000, priceCents: 20000, firstChargeAt: null, includedPeriodDays: 365, nextPeriodEndsAt: null },
  disclosure: { text: 'Terms', version: 7, acknowledgedAt: '2026-01-01T00:00:00Z' },
  bank: { verificationPending: false, deadline: null, overdue: false, windowHours: 48, verificationUrl: null },
  balance: { state: 'past_due', outstanding: true, amountCents: 20000, graceEndsAt: null },
  canManage: true,
  canChoosePlan: true,
};

const STATUS = {
  account: { id: 'acct_1' },
  offered_products: 0,
  links: 0,
  sandbox: true,
  oauth_available: true,
  viewer: { office_role: 'staff', can_manage: true },
  office: { provider_id: 'provider-1', office_name: 'Maple Med Spa' },
};

function gate(snapshot: OfficeAccessSnapshot | undefined, failed = false) {
  return officeAccessGateDecision({
    modeHydrated: true,
    mode: 'staff',
    sessionLoading: false,
    signedIn: true,
    pathname: '/payments',
    pending: false,
    failed,
    snapshot,
  });
}

async function main() {
  section('Provider admission');
  const incomplete = {
    ...SNAPSHOT,
    complete: false,
    steps: SNAPSHOT.steps.map((step) => step.id === 'bank'
      ? { ...step, status: 'todo' as const, detail: 'Add a bank account' }
      : step),
  };
  const blocked = gate(incomplete);
  check('incomplete office gets desktop handoff with missing steps', blocked.kind === 'handoff' && blocked.missing.includes('Add a bank account'));
  check('complete office reaches the provider app', gate(SNAPSHOT).kind === 'allow');
  check('failed snapshot fails closed', gate(undefined, true).kind === 'error');
  check('patient routes are unaffected', officeAccessGateDecision({
    modeHydrated: true, mode: 'patient', sessionLoading: false, signedIn: true,
    pathname: '/today', pending: true, failed: false,
  }).kind === 'allow');

  section('Payment method management');
  let duplicate = true;
  setStaffCardBridgeForTests({ createPaymentMethod: async () => 'pm_replacement' });
  setScript((request) => {
    if (request.path === '/api/billing/office/status') return { status: 200, body: STATUS };
    if (request.path === '/api/billing/office/access' && request.method === 'GET') return { status: 200, body: SNAPSHOT };
    if (request.path.endsWith('/setup-intent')) return { status: 200, body: { clientSecret: 'seti_secret', setupIntentId: 'seti_1', publishableKey: 'pk_test', slot: 'card_backup' } };
    if (request.path.endsWith('/instruments')) {
      if (duplicate) return { status: 409, body: { error: 'Duplicate card', code: 'duplicate_card' } };
      return { status: 200, body: SNAPSHOT };
    }
    if (request.path.endsWith('/pay')) return { status: 200, body: { status: 'succeeded', setup: { ...SNAPSHOT, balance: { ...SNAPSHOT.balance, outstanding: false } } } };
    return undefined;
  });
  const screen = await mount(<PaymentMethodsScreen />, STAFF);
  check('two cards are distinguishable', text(screen.root, 'payments-overview').includes('VISA •••• 4242') && text(screen.root, 'payments-overview').includes('MASTERCARD •••• 4444'));
  await press(screen.root, 'button-replace-card_backup');
  await press(screen.root, 'button-save-office-card');
  check('duplicate card conflict is explained clearly', text(screen.root, 'office-access-notice').includes('already on file'));
  const instrumentWrite = requests.find((request) => request.path.endsWith('/instruments'));
  check('server receives only Stripe ids and slot', JSON.stringify(instrumentWrite?.body) === JSON.stringify({ slot: 'card_backup', paymentMethodId: 'pm_replacement', setupIntentId: 'seti_1' }), JSON.stringify(instrumentWrite?.body));
  duplicate = false;
  await press(screen.root, 'button-save-office-card');
  check('replacement can succeed after choosing another card', text(screen.root, 'office-access-notice').includes('updated'));
  await press(screen.root, 'button-pay-office-balance');
  check('outstanding balance can be paid', text(screen.root, 'office-access-notice').includes('balance paid'));
  check('pay uses an empty server write', requests.some((request) => request.path.endsWith('/pay') && JSON.stringify(request.body) === '{}'));
  await screen.unmount();
  setStaffCardBridgeForTests(null);
  finish('office-access');
}

main().catch((error) => { console.error(error); process.exit(1); });