import React from 'react';
import { openedUrls } from 'react-native';
import { all, check, finish, isBlocked, mount, one, paths, press, release, requests, resetRequests, section, setScript, settle, STAFF, text, textOf, type, writes } from './payments-stubs/harness';
import { setPathname, setSearchParams } from './provider-training-stubs/expo-router';
import GetPaidScreen from '../app/(tabs)/payments/get-paid';
import SettingsScreen from '../app/(tabs)/payments/settings';
import type { OfficeAppAccessSettings, OfficeBillingStatus } from '../lib/office-billing-types';

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

const APP_ACCESS_OFF: OfficeAppAccessSettings = { enabled: false, price_cents: null, cadence: 'monthly', trial_days: 7, version: 1, updated_at: null, thinnr_share_percent: 30 };
let appAccess: OfficeAppAccessSettings = APP_ACCESS_OFF;
let appAccessPutStatus = 200;

function script(status: OfficeBillingStatus = STATUS, fail?: string) {
  setScript((req) => {
    if (req.path === '/api/billing/office/status') return { status: 200, body: status };
    if (req.path === '/api/billing/office/app-access' && req.method === 'GET') return { status: 200, body: appAccess };
    if (req.path === '/api/billing/office/app-access' && req.method === 'PUT') {
      if (appAccessPutStatus === 409) return { status: 409, body: { error: 'Settings changed' } };
      const body = req.body as { enabled: boolean; price_cents: number | null; cadence: 'monthly' | '2_weeks'; trial_days: number };
      appAccess = { ...appAccess, enabled: body.enabled, price_cents: body.price_cents, cadence: body.cadence, trial_days: body.trial_days, version: appAccess.version + 1 };
      return { status: 200, body: appAccess };
    }
    if (req.path === '/api/billing/office/connect/oauth/start') return fail === 'oauth' ? { status: 400, body: { error: 'OAuth unavailable' } } : { status: 200, body: { url: 'https://connect.stripe.test/start' } };
    if (req.path === '/api/billing/office/connect/sync') return fail === 'sync' ? { status: 409, body: { error: 'Sync blocked' } } : { status: 200, body: { account: ACCOUNT } };
    return undefined;
  });
}

async function main() {
  setPathname('/payments/get-paid'); setSearchParams({});
  section('Signed out');
  resetRequests(); script();
  const signedOut = await mount(<GetPaidScreen />, null);
  check('signed out is request-free', requests.length === 0, paths().join(' | '));
  check('signed out holds the sign-in frame with no setup cards or OAuth button', !!one(signedOut.root, 'billing-session-loading') && !textOf(signedOut.root).includes('Connect an existing Stripe account') && !one(signedOut.root, 'button-oauth-start'));
  check('signed out never requests account creation', !requests.some((r) => r.path.endsWith('/connect/create')));
  await signedOut.unmount();

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
  const settingsSignedOut = await mount(<SettingsScreen />, null);
  check('settings signed out is request-free and holds the sign-in frame', requests.length === 0 && !!one(settingsSignedOut.root, 'billing-session-loading') && !one(settingsSignedOut.root, 'settings-bank-summary'));
  await settingsSignedOut.unmount();
  const settings = await mount(<SettingsScreen />, STAFF);
  check('settings summary is read-only', !!one(settings.root, 'settings-bank-summary') && textOf(settings.root).includes('Maple Med Spa') === false);
  await press(settings.root, 'settings-tab-identity');
  check('identity summary renders business data', textOf(settings.root).includes('Maple Med Spa') && !!one(settings.root, 'settings-managed-web'));
  const pressables = settings.root.findAll((n) => n.type === 'Pressable' && typeof n.props.onPress === 'function');
  check('every pressable has role and name', pressables.every((n) => n.props.accessibilityRole && (n.props.accessibilityLabel || textOf(n).trim())));
  await settings.unmount();

  section('AI feature pricing (app access)');
  appAccess = APP_ACCESS_OFF; appAccessPutStatus = 200;
  resetRequests(); script();
  const access = await mount(<SettingsScreen />, STAFF);
  const accessGet = requests.find((r) => r.path === '/api/billing/office/app-access');
  check('settings read the office app-access settings with the staff bearer', accessGet?.method === 'GET' && accessGet.auth === 'Bearer staff-token', paths().join(' | '));
  check('off by default: toggle off, save blocked, nothing locks', !!one(access.root, 'office-app-access-settings') && text(access.root, 'text-app-access-summary').includes('Right now nothing locks') && text(access.root, 'text-app-access-summary').includes('7 free days') && isBlocked(access.root, 'button-save-app-access'));
  await press(access.root, 'toggle-app-access-enabled');
  await press(access.root, 'button-save-app-access');
  check('charging without a price is refused locally (no write)', text(access.root, 'text-app-access-error').includes('Set a price') && writes().length === 0);
  await type(access.root, 'input-app-access-price', '0.25');
  await press(access.root, 'button-save-app-access');
  check('prices under 50¢ are refused locally', text(access.root, 'text-app-access-error').includes('at least $0.50') && writes().length === 0);
  await type(access.root, 'input-app-access-price', '6.99');
  await press(access.root, 'app-access-cadence-2_weeks');
  await type(access.root, 'input-app-access-trial-days', '400');
  await press(access.root, 'button-save-app-access');
  check('trial days outside 0–365 are refused locally', text(access.root, 'text-app-access-error').includes('between 0 and 365') && writes().length === 0);
  await type(access.root, 'input-app-access-trial-days', '14');
  check('summary previews the price, cadence and THINNR share before saving', text(access.root, 'text-app-access-summary').includes('$6.99 every 2 weeks') && text(access.root, 'text-app-access-summary').includes('14 free days') && text(access.root, 'text-app-access-summary').includes('30%'));
  await press(access.root, 'button-save-app-access');
  const put = writes()[0];
  check('save sends the exact versioned PUT', put?.method === 'PUT' && put.path === '/api/billing/office/app-access' && put.auth === 'Bearer staff-token'
    && JSON.stringify(put.body) === JSON.stringify({ enabled: true, price_cents: 699, cadence: '2_weeks', trial_days: 14, expected_version: 1 }), JSON.stringify(put?.body));
  check('save success notice and the form settles on the saved values', text(access.root, 'text-app-access-saved').includes('AI feature pricing saved') && isBlocked(access.root, 'button-save-app-access'));
  appAccessPutStatus = 409;
  await press(access.root, 'toggle-app-access-enabled');
  await press(access.root, 'button-save-app-access');
  check('a stale version (409) reloads and explains', text(access.root, 'text-app-access-error').includes('Someone else changed these settings') && requests.filter((r) => r.path === '/api/billing/office/app-access' && r.method === 'GET').length >= 2);
  await access.unmount();
  appAccessPutStatus = 200; appAccess = APP_ACCESS_OFF;
  finish('payments-status');
}
main().catch((error) => { console.error(error); process.exit(1); });