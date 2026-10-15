/**
 * The narrowed-for-nonpayment office in the provider app.
 *
 *   pnpm --filter @workspace/thinnr-mobile run test:office-restricted
 *
 * The server refuses the blocked surface on its own; this suite proves the
 * app's copy of the same map agrees with it, so staff never tap into a wall:
 *
 *   1. Policy — a restricted office keeps the office account/pay screen,
 *      patient subscriptions, payouts, Stripe settings and get-paid; every
 *      other staff screen (and every deep link below one) is blocked.
 *   2. Never on a guess — patient mode is untouched, and an office whose
 *      state is not yet known (or could not be read) is never narrowed.
 *   3. Sign-in and account plumbing (persona, logins, security, claim) is
 *      never narrowed, the same way the server leaves it open.
 *   4. Wiring — the root layout runs every staff screen through the guard
 *      and covers a blocked one with the explanation; the explanation is
 *      non-punitive and puts payment one tap away; the provider launcher
 *      offers only the surviving destinations while restricted.
 *   5. Parity — the app's allowed routes line up with the operations app's
 *      allowed pages, so the two clients cannot drift apart.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  isRestrictedAllowedStaffRoute,
  OFFICE_ACCESS_ROUTE,
  OFFICE_RESTRICTED_STAFF_MESSAGE,
  staffRouteBlocked,
} from '../lib/office-restriction';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

const read = (relative: string) =>
  fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const ALLOWED = [
  OFFICE_ACCESS_ROUTE,
  '/payments/subscriptions',
  '/payments/payouts',
  '/payments/settings',
  '/payments/get-paid',
];

const BLOCKED = [
  '/',
  '/patients',
  '/patients/p-100',
  '/conversations',
  '/payments',
  '/payments/orders',
  '/payments/transactions',
  '/payments/sell',
  '/support-chat',
  '/training',
  '/alerts',
  '/settings',
];

console.log('Office restricted for nonpayment — provider app');

console.log(' the narrowed surface');
for (const pathname of ALLOWED) {
  check(`${pathname} stays open`, staffRouteBlocked({ mode: 'staff', restricted: true, pathname }) === false);
  check(`${pathname}/detail stays open`,
    staffRouteBlocked({ mode: 'staff', restricted: true, pathname: `${pathname}/detail` }) === false);
}
for (const pathname of BLOCKED) {
  check(`${pathname} is blocked`, staffRouteBlocked({ mode: 'staff', restricted: true, pathname }) === true);
}
check('a trailing slash does not smuggle a blocked route through',
  staffRouteBlocked({ mode: 'staff', restricted: true, pathname: '/patients/' }) === true);
check('a lookalike prefix is not allowed',
  staffRouteBlocked({ mode: 'staff', restricted: true, pathname: '/payments/subscriptions-export' }) === true);

console.log(' never narrowed on a guess');
for (const pathname of BLOCKED) {
  check(`${pathname} is open to a paid office`,
    staffRouteBlocked({ mode: 'staff', restricted: false, pathname }) === false);
  check(`${pathname} is open to a patient`,
    staffRouteBlocked({ mode: 'patient', restricted: true, pathname }) === false);
  check(`${pathname} is open before the mode is known`,
    staffRouteBlocked({ mode: null, restricted: true, pathname }) === false);
}

console.log(' session and account plumbing is never narrowed');
for (const pathname of ['/persona', '/provider-login', '/patient-welcome', '/patient-login', '/security',
  '/security-report', '/claim-account']) {
  check(`${pathname} stays reachable`, isRestrictedAllowedStaffRoute(pathname));
}

console.log(' wiring');
const layout = read('app/_layout.tsx');
check('every staff screen runs through the guard',
  /<StaffRestrictionGuard>\s*\n?\s*<RootLayoutNav \/>/.test(layout), 'guard does not wrap the navigator');
check('the guard reads the shared office state', layout.includes('staffRouteBlocked'));
check('a blocked screen is covered by the explanation', layout.includes('<RestrictedStaffNotice />'));
check('the covered screen cannot be reached behind the notice',
  /pointerEvents: blocked \? 'none' : 'auto'/.test(layout));
check('the office restriction state is provided app-wide', layout.includes('<OfficeRestrictionProvider>'));

const notice = read('components/provider/RestrictedStaffNotice.tsx');
check('the explanation is non-punitive',
  !/suspend|violat|penalt|delinquen|overdue/i.test(notice), 'punitive wording in the notice');
check('it promises nothing is lost', notice.includes('Nothing has been deleted'));
check('it names what still works', notice.includes('Patient subscriptions, payments and payouts'));
check('payment is one tap away', notice.includes('OFFICE_ACCESS_ROUTE') && notice.includes("label=\"Pay now\""));
check('it falls back to the shared message', notice.includes('OFFICE_RESTRICTED_STAFF_MESSAGE'));
check('the shared message says what still works',
  /Patient subscriptions, payments and patient data export stay open\./.test(OFFICE_RESTRICTED_STAFF_MESSAGE));

const launcher = read('components/provider/ProviderFabMenu.tsx');
check('the launcher narrows its destinations', launcher.includes('restricted ? RESTRICTED_ITEMS : '));
check('the launcher offers the payment first while restricted', /label: 'Pay now'/.test(launcher));

console.log(' parity with the operations app');
const webPolicy = read('../thinnr-operations/src/contexts/office-restriction.tsx');
for (const route of ['/payments/subscriptions', '/payments/payouts', '/payments/settings', '/payments/get-paid']) {
  check(`${route} is allowed on both clients`, webPolicy.includes(`'${route}'`));
}
check('both clients keep the office account page',
  webPolicy.includes("'/account'") && ALLOWED.includes(OFFICE_ACCESS_ROUTE));
const serverPolicy = read('../api-server/src/lib/office-restriction.ts');
check('the server allows the office access endpoint', serverPolicy.includes('/office\\/access'));
check('the server allows patient subscriptions', serverPolicy.includes('/billing\\/office\\/subscriptions'));
check('the server allows payouts', serverPolicy.includes('/billing\\/office\\/payouts'));
check('the clients share the server\'s wording',
  serverPolicy.includes("This part of THINNR is unavailable until your office's account is paid. "));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
