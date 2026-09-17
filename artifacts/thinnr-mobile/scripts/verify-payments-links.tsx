import React from 'react';
import { sharedMessages } from 'react-native';
import { check, finish, ids, isBlocked, mount, one, paths, press, release, requests, resetRequests, routerLog, section, setScript, settle, STAFF, text, textOf, type, writes } from './payments-stubs/harness';
import { DEMO_LINKS, DEMO_PRICES } from '../data/office-payments-demo';
import LinksScreen from '../app/(tabs)/payments/links';
import type { OfficeBillingStatus, PaymentLink } from '../lib/office-billing-types';

const STATUS: OfficeBillingStatus = {
  account: {
    provider_id: 'p', stripe_account_id: 'acct', origin: 'oauth', dashboard_type: 'full', charges_enabled: true, payouts_enabled: true, details_submitted: true,
    requirements: { currently_due: [], past_due: [], eventually_due: [], disabled_reason: null, current_deadline: null }, capabilities: {}, default_currency: 'usd',
    business_name: 'Maple', email: null, tax_enabled: false, livemode: false, stripe_customer_emails: 'off', stripe_customer_emails_checked_at: null,
    stripe_customer_emails_note: null, last_synced_at: null, disconnected_at: null, created_at: '2026-01-01T00:00:00Z',
  }, offered_products: 2, links: 1, sandbox: true, oauth_available: true,
  viewer: { office_role: 'owner', can_manage: true }, office: { provider_id: 'p', office_name: 'Maple' },
};
const LINK: PaymentLink = { ...DEMO_LINKS[1], id: 'link-live', patient_id: 'pat-1', patient_name: 'Ava Reed', active: true, usable: true, uses: 0, max_uses: null };
let failure = '';
let delayed = false;
function script(links: PaymentLink[] = [LINK]) {
  setScript((req) => {
    if (req.path === '/api/billing/office/status') return { status: 200, body: STATUS };
    if (req.path === '/api/billing/office/links' && req.method === 'GET') return { status: 200, body: { items: links } };
    if (req.path === '/api/billing/office/prices') return { status: 200, body: { products: DEMO_PRICES, settings: {} } };
    if (req.path === '/api/billing/office/patients/search') return { status: 200, body: { items: [{ id: 'pat-9', name: 'Nora Jones', email: 'nora@example.com', phone: null }] } };
    if (req.method === 'POST' && req.path === '/api/billing/office/links') {
      if (failure === 'create') return { status: 422, body: { error: 'Invalid link options' } };
      if (delayed) return { delay: true, body: { link: { ...LINK, url: 'https://pay.test/new' } } };
      return { status: 200, body: { link: { ...LINK, url: 'https://pay.test/new' } } };
    }
    if (req.method === 'PATCH') return failure === 'update' ? { status: 400, body: { error: 'Update refused' } } : { status: 200, body: { link: LINK } };
    if (req.method === 'DELETE') return failure === 'delete' ? { status: 409, body: { error: 'Already used' } } : { status: 200, body: { link: { ...LINK, active: false } } };
    return undefined;
  });
}

async function main() {
  section('Demo');
  resetRequests(); script();
  const demo = await mount(<LinksScreen />, null);
  check('pinned demo links render without fetches', requests.length === 0 && ids(demo.root, 'link-row-').length === DEMO_LINKS.length, paths().join(' | '));
  check('all demo writes blocked', DEMO_LINKS.every((link) => isBlocked(demo.root, `button-edit-link-${link.id}`)) && DEMO_LINKS.filter((l) => l.active).every((link) => isBlocked(demo.root, `button-deactivate-link-${link.id}`)) && isBlocked(demo.root, 'button-create-patient-link') && isBlocked(demo.root, 'button-sell-to-patient'));
  await demo.unmount();

  section('Live reads, search and navigation');
  resetRequests(); script();
  const live = await mount(<LinksScreen />, STAFF);
  check('status, links and prices use bearer', requests.length === 3 && requests.every((r) => r.auth === 'Bearer staff-token'), paths().join(' | '));
  resetRequests(); await press(live.root, 'button-create-office-link');
  const officeCreate = writes()[0];
  check('office link body is exact', JSON.stringify(officeCreate?.body) === JSON.stringify({ patient_id: null, expires_in_hours: null, max_uses: null, product_id: null }), JSON.stringify(officeCreate?.body));
  await type(live.root, 'input-patient-search', 'Nora'); await settle(70);
  const search = requests.find((r) => r.path.endsWith('/patients/search'));
  check('patient search is debounced and query encoded', search?.url.includes('q=Nora') === true);
  await press(live.root, 'patient-result-pat-9');
  await press(live.root, 'button-sell-to-patient');
  check('sell navigation carries patient id and name', routerLog.some((r) => r.target === '/sell-to-patient?patientId=pat-9&name=Nora+Jones'), JSON.stringify(routerLog));

  section('Create validation and exact body');
  await type(live.root, 'input-link-max-uses', '1');
  resetRequests(); await press(live.root, 'button-create-patient-link');
  check('bad use limit blocked client-side', writes().length === 0 && text(live.root, 'link-validation').includes('2 or more'));
  await type(live.root, 'input-link-max-uses', '4');
  await press(live.root, 'select-link-expiry-168');
  await press(live.root, 'select-link-product-control');
  resetRequests(); delayed = true; (sharedMessages as string[]).length = 0;
  await press(live.root, 'button-create-patient-link');
  check('create displays busy while request is pending', one(live.root, 'button-create-patient-link')?.props.accessibilityState?.busy === true);
  const create = writes()[0];
  check('create POST body is exact', create?.method === 'POST' && create.path === '/api/billing/office/links' && JSON.stringify(create.body) === JSON.stringify({ patient_id: 'pat-9', expires_in_hours: 168, max_uses: 4, product_id: 'control' }), JSON.stringify(create?.body));
  release?.(); delayed = false; await settle();
  check('create success is shown and link shared', text(live.root, 'links-notice').includes('Link created') && sharedMessages.includes('https://pay.test/new'));

  section('Update and deactivate');
  await press(live.root, 'button-edit-link-link-live');
  await type(live.root, 'input-edit-link-label', 'VIP');
  await type(live.root, 'input-edit-link-expiry', '2027-01-02T03:04:00Z');
  await type(live.root, 'input-edit-link-max-uses', '5');
  resetRequests(); await press(live.root, 'button-save-link');
  const patch = writes()[0];
  check('update PATCH body is exact', patch?.method === 'PATCH' && patch.path.endsWith('/links/link-live') && JSON.stringify(patch.body) === JSON.stringify({ label: 'VIP', expires_at: '2027-01-02T03:04:00.000Z', max_uses: 5, active: true }), JSON.stringify(patch?.body));
  check('update success notice', text(live.root, 'links-notice').includes('Link updated'));
  await press(live.root, 'button-deactivate-link-link-live');
  check('deactivate requires confirmation sheet', !!one(live.root, 'deactivate-link-sheet'));
  resetRequests(); await press(live.root, 'button-confirm-deactivate-link');
  check('deactivate is exact DELETE', writes()[0]?.method === 'DELETE' && writes()[0]?.path.endsWith('/links/link-live'));
  await live.unmount();

  section('Loading, error, retry, and 4xx');
  resetRequests();
  setScript((req) => {
    if (req.path.endsWith('/status')) return { status: 200, body: STATUS };
    if (req.path.endsWith('/links')) return { delay: true, body: { items: [LINK] } };
    if (req.path.endsWith('/prices')) return { status: 200, body: { products: DEMO_PRICES, settings: {} } };
    return undefined;
  });
  const loading = await mount(<LinksScreen />, STAFF);
  check('query loading state renders', !!one(loading.root, 'links-loading'));
  release?.(); await settle(); await loading.unmount();
  setScript((req) => req.path.endsWith('/status') ? { status: 200, body: STATUS } : req.path.endsWith('/links') && req.method === 'GET' ? { status: 500, body: { error: 'Links unavailable' } } : req.path.endsWith('/prices') ? { status: 200, body: { products: DEMO_PRICES, settings: {} } } : undefined);
  const errored = await mount(<LinksScreen />, STAFF);
  check('read error has retry', !!one(errored.root, 'links-error-retry'));
  script(); await press(errored.root, 'links-error-retry'); check('retry recovers', !!one(errored.root, 'link-row-link-live')); await errored.unmount();
  failure = 'create'; script();
  const failed = await mount(<LinksScreen />, STAFF);
  await type(failed.root, 'input-patient-search', 'Nora'); await settle(70); await press(failed.root, 'patient-result-pat-9'); await press(failed.root, 'button-create-patient-link');
  check('create 4xx message is surfaced', text(failed.root, 'links-notice').includes('Invalid link options'));
  failure = 'update'; script();
  await press(failed.root, 'button-edit-link-link-live'); await press(failed.root, 'button-save-link');
  check('update 4xx message is surfaced', text(failed.root, 'links-notice').includes('Update refused'));
  await press(failed.root, 'edit-link-sheet-close');
  failure = 'delete'; script();
  await press(failed.root, 'button-deactivate-link-link-live'); await press(failed.root, 'button-confirm-deactivate-link');
  check('delete 4xx message is surfaced', text(failed.root, 'links-notice').includes('Already used'));
  const pressables = failed.root.findAll((n) => n.type === 'Pressable' && typeof n.props.onPress === 'function');
  check('every pressable has role and name', pressables.every((n) => n.props.accessibilityRole && (n.props.accessibilityLabel || textOf(n).trim())));
  await failed.unmount();
  finish('payments-links');
}
main().catch((error) => { console.error(error); process.exit(1); });