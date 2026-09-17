import React from 'react';
import { openedUrls } from 'react-native';
import { all, check, finish, isBlocked, mount, one, paths, press, release, requests, resetRequests, section, setScript, settle, STAFF, text, textOf, writes } from './payments-stubs/harness';
import { setPathname, setSearchParams } from './provider-training-stubs/expo-router';
import GetPaidScreen from '../app/(tabs)/payments/get-paid';
import SettingsScreen from '../app/(tabs)/payments/settings';
import type { OfficeBillingStatus } from '../lib/office-billing-types';

const ACCOUNT = {
  provider_id: 'prov-1', stripe_account_id: 'acct_1', origin: 'oauth', dashboard_type: 'full',
  charges_enabled: true, payouts_enabled: true, details_submitted: true,
  requirements: { currently_due: [], past_due: [], eventually_due: [], disabled_reason: null, current_deadline: null },
  capabilities: {}, default_currency: 'usd', business_name: 'Maple Med Spa', email: 'owner@example.com',
  tax_enabled: false, livemode: false, stripe_customer_emails: 'off',
  stripe_customer_emails_checked_at: '2026-10-01T12:00:00Z', stripe_customer_emails_note: null,
  last_synced_at: '2026-10-01T12:00:00Z', disconnected_at: null, created_at: '2026-01-01T12:00:00Z',
} as const;
const STATUS: OfficeBillingStatus = {
  account: ACCOUNT, offered_products: 2, links: 1, sandbox: true, oauth_available: true,
  viewer: { office_role: 'owner', can_manage: true }, office: { provider_id: 'prov-1', office_name: 'Maple Med Spa' },
};

function script(status: OfficeBillingStatus = STATUS, fail?: string) {
  setScript((req) => {
    if (req.path === '/api/billing/office/status') return { status: 200, body: status };
    if (req.path === '/api/billing/office/connect/oauth/start') return fail === 'oauth' ? { status: 400, body: { error: 'OAuth unavailable' } } : { status: 200, body: { url: 'https://connect.stripe.test/start' } };
    if (req.path === '/api/billing/office/connect/sync') return fail === 'sync' ? { status: 409, body: { error: 'Sync blocked' } } : { status: 200, body: { account: ACCOUNT } };
    return undefined;
  });
}

async function main() {
  setPathname('/payments/get-paid'); setSearchParams({});
  section('Demo setup cards');
  resetRequests(); script();
  const demo = await mount(<GetPaidScreen />, null);
  check('demo is request-free', requests.length === 0, paths().join(' | '));
  check('demo setup cards render', textOf(demo.root).includes('Connect an existing Stripe account') && textOf(demo.root).includes('Set up a new account'));
  check('demo web handoff is truthful', text(demo.root, 'get-paid-web-handoff').includes('THINNR web dashboard (Payments → Get paid)'));
  check('demo OAuth write is blocked', isBlocked(demo.root, 'button-oauth-start'));
  check('demo never requests account creation', !requests.some((r) => r.path.endsWith('/connect/create')));
  await demo.unmount();

  section('No account setup writes');
  const noAccount = { ...STATUS, account: null };
  resetRequests(); script(noAccount); (openedUrls as string[]).length = 0;
  const setup = await mount(<GetPaidScreen />, STAFF);
  check('allowNoAccount renders setup instead of redirecting', !!one(setup.root, 'get-paid-web-handoff') && setup.root.findAll((n) => n.type === 'Redirect').length === 0);
  await press(setup.root, 'button-oauth-start'); await settle();
  const oauth = requests.find((r) => r.path.endsWith('/connect/oauth/start'));
  check('oauth start is authenticated GET and opens returned URL', oauth?.method === 'GET' && oauth.auth === 'Bearer staff-token' && openedUrls.includes('https://connect.stripe.test/start'), JSON.stringify(paths()));
  check('live setup never requests account creation', !requests.some((r) => r.path.endsWith('/connect/create')));
  check('live setup shows web handoff', text(setup.root, 'get-paid-web-handoff').includes('live payment workspace automatically'));
  await setup.unmount();

  section('Connected account and sync');
  resetRequests(); script();
  const connected = await mount(<GetPaidScreen />, STAFF);
  check('connection flags and account status render', textOf(connected.root).includes('Charges') && !!one(connected.root, 'stripe-customer-emails'));
  await press(connected.root, 'button-sync-status'); await settle();
  const sync = writes()[0];
  check('sync sends exact empty POST body', sync?.path.endsWith('/connect/sync') && JSON.stringify(sync.body) === '{}');
  check('sync success notice', text(connected.root, 'sync-notice').includes('Payment status refreshed'));
  await connected.unmount();

  section('4xx failure messages');
  script(noAccount, 'oauth');
  const failedOauth = await mount(<GetPaidScreen />, STAFF);
  await press(failedOauth.root, 'button-oauth-start');
  check('oauth 4xx is surfaced', text(failedOauth.root, 'setup-notice').includes('OAuth unavailable'));
  await failedOauth.unmount();
  script(STATUS, 'sync');
  const failedSync = await mount(<GetPaidScreen />, STAFF);
  await press(failedSync.root, 'button-sync-status');
  check('sync 4xx is surfaced', text(failedSync.root, 'sync-notice').includes('Sync blocked'));
  await failedSync.unmount();

  section('Loading and retry');
  setScript((req) => req.path.endsWith('/status') ? { delay: true, body: STATUS } : undefined);
  const loading = await mount(<GetPaidScreen />, STAFF);
  check('status loading is announced', !!one(loading.root, 'billing-status-loading'));
  release?.(); await settle(); await loading.unmount();
  setScript((req) => req.path.endsWith('/status') ? { status: 500, body: { error: 'Status unavailable' } } : undefined);
  const errored = await mount(<GetPaidScreen />, STAFF);
  check('status error offers retry', !!one(errored.root, 'billing-status-error-retry'));
  script();
  await press(errored.root, 'billing-status-error-retry');
  check('status retry recovers', !!one(errored.root, 'button-sync-status'));
  await errored.unmount();

  section('Settings');
  resetRequests(); script();
  const settingsDemo = await mount(<SettingsScreen />, null);
  check('settings demo is request-free and uses web copy', requests.length === 0 && text(settingsDemo.root, 'settings-demo').includes('Secure Stripe settings are available after sign in.'));
  await settingsDemo.unmount();
  const settings = await mount(<SettingsScreen />, STAFF);
  check('settings summary is read-only', !!one(settings.root, 'settings-bank-summary') && textOf(settings.root).includes('Maple Med Spa') === false);
  await press(settings.root, 'settings-tab-identity');
  check('identity summary renders business data', textOf(settings.root).includes('Maple Med Spa') && !!one(settings.root, 'settings-managed-web'));
  const pressables = settings.root.findAll((n) => n.type === 'Pressable' && typeof n.props.onPress === 'function');
  check('every pressable has role and name', pressables.every((n) => n.props.accessibilityRole && (n.props.accessibilityLabel || textOf(n).trim())));
  await settings.unmount();
  finish('payments-status');
}
main().catch((error) => { console.error(error); process.exit(1); });