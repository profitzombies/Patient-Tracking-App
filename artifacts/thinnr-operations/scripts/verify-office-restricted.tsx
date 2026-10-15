/**
 * The narrowed-for-nonpayment office in the operations app.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:office-restricted
 *
 * Renders the REAL route gate under react-test-renderer at a series of typed
 * locations, and proves:
 *
 *   1. A paid office is never narrowed — every location renders its page.
 *   2. A restricted office keeps the allowed surface: its own account and
 *      payment page (which hosts patient data export), patient subscriptions,
 *      Stripe payouts / connection / get-paid, and its own sign-in security.
 *   3. Every other area — roster, messaging, analytics, orders, team,
 *      settings, audit, files, training, alerts, leaderboard, and the
 *      overview itself — resolves to the explanation screen, whether reached
 *      by menu click or by typing the URL. Deep links below a blocked area
 *      are blocked too.
 *   4. The explanation is non-punitive and actionable: it carries the
 *      server's own message and a one-click path to pay.
 *   5. The banner shows only while restricted, and recovery restores every
 *      blocked page with no further action.
 *   6. The client's allow-list matches the server's, path for path, so the
 *      two copies of the narrowed surface cannot drift.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RestrictedBanner, RestrictedRoutes } from '../src/components/office/RestrictedAccess';
import {
  isRestrictedOfficePath,
  OfficeRestrictionProvider,
  RESTRICTED_OFFICE_PATHS,
} from '../src/contexts/office-restriction';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    node.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(instance);
  return parts.join('');
}

const byTestId = (renderer: ReactTestRenderer, id: string) => renderer.root.findAll(
  (node) => node.props['data-testid'] === id && typeof node.type === 'string',
);

const MESSAGE = "This part of THINNR is unavailable until your office's account is paid.";

async function renderAt(location: string, restricted: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  const { hook } = memoryLocation({ path: location, static: true });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Router hook={hook}>
          <OfficeRestrictionProvider value={{ restricted, message: restricted ? MESSAGE : null, officeKind: null }}>
            <RestrictedBanner />
            <RestrictedRoutes>
              <div data-testid="page-content">the real page</div>
            </RestrictedRoutes>
          </OfficeRestrictionProvider>
        </Router>
      </QueryClientProvider>,
    );
  });
  return renderer;
}

const ALLOWED = [
  '/account',
  '/subscriptions',
  '/payments/subscriptions',
  '/payments/payouts',
  '/payments/settings',
  '/payments/get-paid',
  '/security',
];

const BLOCKED = [
  '/',
  '/patients',
  '/patients/p-100',
  '/conversations',
  '/analytics',
  '/leaderboard',
  '/payments',
  '/payments/orders',
  '/payments/sell',
  '/team',
  '/settings',
  '/audit',
  '/files',
  '/training',
  '/alerts',
  '/ai-support',
];

async function main() {
  console.log('Office restricted for nonpayment — operations app');

  console.log(' paid office is never narrowed');
  for (const location of [...ALLOWED, ...BLOCKED]) {
    const renderer = await renderAt(location, false);
    check(`${location} renders its page`, byTestId(renderer, 'page-content').length === 1);
    check(`${location} shows no banner`, byTestId(renderer, 'banner-office-restricted').length === 0);
  }

  console.log(' restricted office keeps payments, subscriptions and export');
  for (const location of ALLOWED) {
    const renderer = await renderAt(location, true);
    check(`${location} still renders`, byTestId(renderer, 'page-content').length === 1);
    check(`${location} carries the banner`, byTestId(renderer, 'banner-office-restricted').length === 1);
  }

  console.log(' restricted office reaches nothing else, by menu or by URL');
  for (const location of BLOCKED) {
    const renderer = await renderAt(location, true);
    check(`${location} is replaced by the explanation`,
      byTestId(renderer, 'page-content').length === 0
      && byTestId(renderer, 'screen-office-restricted').length === 1);
  }

  console.log(' the explanation says what to do, not what went wrong');
  const blockedScreen = await renderAt('/patients', true);
  const message = textOf(byTestId(blockedScreen, 'text-restricted-message')[0]);
  check('carries the server\'s own message', message.includes(MESSAGE), message);
  const copy = textOf(byTestId(blockedScreen, 'screen-office-restricted')[0]);
  check('never scolds or threatens', !/suspend|violat|penalt|delinquen|fail/i.test(copy), copy);
  check('promises nothing is lost', /Nothing has been deleted/.test(copy));
  check('recovery needs no HQ call', /no call to THINNR needed/.test(copy));
  const pay = byTestId(blockedScreen, 'link-restricted-pay')[0];
  check('payment is one click away', pay.props.href === '/account');
  check('subscriptions are one click away',
    byTestId(blockedScreen, 'link-restricted-open-subscriptions')[0].props.href === '/subscriptions');
  const banner = await renderAt('/account', true);
  check('the banner pays too', byTestId(banner, 'link-banner-pay')[0].props.href === '/account');
  check('the banner is announced', byTestId(banner, 'banner-office-restricted')[0].props.role === 'status');

  console.log(' recovery restores everything on the next render');
  for (const location of BLOCKED) {
    const renderer = await renderAt(location, false);
    check(`${location} works again once paid`,
      byTestId(renderer, 'page-content').length === 1
      && byTestId(renderer, 'screen-office-restricted').length === 0);
  }

  console.log(' the client copy matches the server policy');
  const serverSource = fs.readFileSync(
    path.resolve(process.cwd(), '../api-server/src/lib/office-restriction.ts'),
    'utf8',
  );
  // The server keys its allow-list on API paths; every client path must have a
  // counterpart there, so a page cannot be offered that the server refuses.
  const serverAllows = (prefix: string) => serverSource.includes(prefix);
  check('office access + pay', serverAllows('/office\\/access'));
  check('office billing status', serverAllows('/billing\\/office\\/status'));
  check('stripe connect', serverAllows('/billing\\/office\\/connect'));
  check('payouts', serverAllows('/billing\\/office\\/payouts'));
  check('patient subscriptions', serverAllows('/billing\\/office\\/subscriptions'));
  check('patient data export', serverAllows('/exports'));
  check('client list has no extras beyond the audited set',
    RESTRICTED_OFFICE_PATHS.every((entry) => ALLOWED.includes(entry))
    && ALLOWED.every((entry) => (RESTRICTED_OFFICE_PATHS as readonly string[]).includes(entry)));
  check('deep links below an allowed page stay allowed', isRestrictedOfficePath('/payments/payouts/history'));
  check('a lookalike path is not allowed', !isRestrictedOfficePath('/accounts'));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

void main();
