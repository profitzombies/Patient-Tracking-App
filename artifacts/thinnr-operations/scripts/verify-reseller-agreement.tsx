/**
 * The reseller agreement date — HQ's anchor for when a reseller's access
 * billing starts.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:reseller-agreement
 *
 * Leadership expects a THINNR reseller's $200/month billing to begin one
 * reseller period (365 days by default) after the office signs its reseller
 * agreement, not after its owner happens to first sign in. The server owns
 * the anchoring; this suite proves the client's side of it:
 *
 *   1. Date math — the helpers that turn the recorded date into the
 *      "Billing starts" line: UTC-day based (never shifted by the browser's
 *      zone), impossible dates refused, an already-passed start said plainly.
 *   2. The organization setting — the HQ admins who can manage accounts read
 *      the live reseller period for the line; anyone else (or a read that
 *      has not landed) gets the 365-day default and the hook says it is
 *      unconfirmed.
 *   3. The wizard — the server's first-charge date drives every sentence;
 *      a date already behind us (an agreement signed more than a period ago)
 *      says the first charge follows activation instead of naming a past day.
 *   4. Wiring — Add Account and the account page's edit form carry the date
 *      only for resellers (hidden for software-only offices, which keep the
 *      first-sign-in clock), the account page shows it, and the access card
 *      reads the server's anchored start rather than counting days itself.
 */
import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __setSession } from './a11y-stubs/session';
import {
  DEFAULT_RESELLER_INCLUDED_PERIOD_DAYS,
  agreementDateAt,
  billingStartsAt,
  describeBillingStart,
  formatCalendarDate,
  formatUtcDay,
  todayIsoDate,
  useResellerIncludedPeriodDays,
} from '../src/lib/reseller-agreement';
import { chargeDay, firstCharge, firstChargeSentence, freePeriodSentence } from '../src/components/launch/wizard/steps';
import type { OfficeAccessSnapshot } from '../src/lib/billing-types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}
const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

async function main() {
  console.log(' date math');
  check('the default period is the organization default of 365 days', DEFAULT_RESELLER_INCLUDED_PERIOD_DAYS === 365);
  check('a calendar date reads as the UTC midnight that starts it',
    agreementDateAt('2026-01-15')?.toISOString() === '2026-01-15T00:00:00.000Z');
  check('an impossible date is refused, not rolled into the next month',
    agreementDateAt('2026-02-30') === null && agreementDateAt('2026-13-01') === null);
  check('anything that is not YYYY-MM-DD is refused',
    agreementDateAt('01/15/2026') === null && agreementDateAt('') === null && agreementDateAt(null) === null && agreementDateAt(undefined) === null);
  check('billing starts the period after the agreement, in UTC days',
    billingStartsAt('2026-01-15', 365)?.toISOString() === '2027-01-15T00:00:00.000Z'
    && billingStartsAt('2024-02-28', 366)?.toISOString() === '2025-02-28T00:00:00.000Z');
  check('no date, no start', billingStartsAt(null, 365) === null && billingStartsAt('nope', 365) === null);
  check('dates are formatted on the UTC day, never shifted by the browser zone',
    formatCalendarDate('2026-01-15') === 'Jan 15, 2026' && formatUtcDay('2027-01-15T00:00:00.000Z') === 'Jan 15, 2027'
    && formatCalendarDate(null) === '—' && formatUtcDay('garbage') === '—');
  const now = new Date('2026-10-15T12:00:00.000Z');
  check('a future start is named with the day count',
    describeBillingStart('2026-01-15', 365, now) === 'Billing starts Jan 15, 2027 (365 days after the agreement).');
  check('an already-passed start says the first charge runs at the next pass once setup is complete',
    (describeBillingStart('2024-03-01', 365, now) ?? '').startsWith('Billing starts Mar 1, 2025 — already passed')
    && (describeBillingStart('2024-03-01', 365, now) ?? '').includes('next billing pass once payment setup is complete'));
  check('a start landing exactly now counts as passed (billing is due at this pass)',
    (describeBillingStart('2025-10-15', 365, new Date('2026-10-15T00:00:00.000Z')) ?? '').includes('already passed'));
  check('an empty field has no line', describeBillingStart('', 365, now) === null);
  {
    // 23:30 UTC is still the 15th in UTC but already the 16th east of UTC and
    // the 15th (afternoon) in Los Angeles: the max follows the user's own day.
    const late = new Date('2026-10-15T23:30:00.000Z');
    const expected = new Date(late.getTime() - late.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    check("today's max for the date input is the user's own calendar day",
      todayIsoDate(late) === expected && /^\d{4}-\d{2}-\d{2}$/.test(todayIsoDate()));
  }

  console.log(' the organization setting');
  {
    const g = globalThis as any;
    const calls: string[] = [];
    g.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      return new Response(JSON.stringify({ accessBilling: { includedPeriodDays: 400 }, sections: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    let seen: { days: number; confirmed: boolean } | null = null;
    function Probe() { seen = useResellerIncludedPeriodDays(); return null; }
    const mountProbe = async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      let renderer: ReactTestRenderer | undefined;
      await act(async () => { renderer = create(<QueryClientProvider client={client}><Probe /></QueryClientProvider>); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      return renderer!;
    };

    __setSession({ authStatus: 'signed-out', hqRole: null, authUser: null });
    let renderer = await mountProbe();
    check('signed out, the default is used, unconfirmed, and nothing is fetched',
      seen!.days === 365 && seen!.confirmed === false && calls.length === 0);
    await act(async () => { renderer.unmount(); });

    __setSession({ authStatus: 'signed-in', hqRole: 'Support', authUser: { id: 'hq-support' } });
    renderer = await mountProbe();
    check('an HQ role that cannot manage accounts does not read the settings either',
      seen!.days === 365 && seen!.confirmed === false && calls.length === 0);
    await act(async () => { renderer.unmount(); });

    __setSession({ authStatus: 'signed-in', hqRole: 'Admin', authUser: { id: 'hq-admin' } });
    renderer = await mountProbe();
    check('an HQ admin reads the live reseller period and the hook says it is confirmed',
      seen!.days === 400 && seen!.confirmed === true && calls.some((url) => url.includes('/api/hq/settings')), JSON.stringify({ seen, calls }));
    await act(async () => { renderer.unmount(); });

    g.fetch = async () => new Response('down', { status: 503 });
    __setSession({ authStatus: 'signed-in', hqRole: 'Super Admin', authUser: { id: 'hq-super' } });
    renderer = await mountProbe();
    check('a failed settings read falls back to the default and says so', seen!.days === 365 && seen!.confirmed === false);
    await act(async () => { renderer.unmount(); });
  }

  console.log(' the wizard');
  const access = (firstChargeAt: string | null): OfficeAccessSnapshot => ({
    office: { providerId: 'fixture', officeName: 'Sample Practice' }, complete: false, connectAlreadyDone: false,
    steps: [], connect: { state: 'not_started', sandbox: true }, instruments: [],
    plan: { selected: 'monthly', monthlyPriceCents: 20000, yearlyPriceCents: 200000, priceCents: 20000, firstChargeAt, includedPeriodDays: 365, nextPeriodEndsAt: null },
    disclosure: { text: 'terms', version: 1, acknowledgedAt: null },
    bank: { verificationPending: false, deadline: null, overdue: false, windowHours: 48, verificationUrl: null },
    balance: { state: 'included_period', outstanding: false, amountCents: 0, graceEndsAt: null },
    canManage: true, canChoosePlan: true,
  } as OfficeAccessSnapshot);
  {
    const estimate = firstCharge(access(null), now);
    check('with no anchored date yet, the estimate is today plus the period',
      estimate.estimated && !estimate.elapsed && estimate.at === '2027-10-15T12:00:00.000Z');
    check('the estimate is worded as conditional on activating today',
      firstChargeSentence(access(null), 'monthly', now) === 'Your first charge of $200 would be on October 15, 2027 if you activate today.');
    const anchored = firstCharge(access('2027-01-15T00:00:00.000Z'), now);
    check("the server's anchored date is used as-is", !anchored.estimated && !anchored.elapsed && anchored.at === '2027-01-15T00:00:00.000Z');
    check('an anchored future date is stated as fact',
      firstChargeSentence(access('2027-01-15T00:00:00.000Z'), 'monthly', now) === 'Your first charge of $200 is on January 15, 2027.');
    const elapsed = firstCharge(access('2025-03-01T00:00:00.000Z'), now);
    check('an anchored date already behind us is flagged elapsed', !elapsed.estimated && elapsed.elapsed);
    check('an elapsed period says the first charge follows payment setup, never a past day as if it were ahead',
      firstChargeSentence(access('2025-03-01T00:00:00.000Z'), 'monthly', now)
        === 'Your free access ended on March 1, 2025, so your first charge of $200 runs as soon as your payment setup is complete.');
    check('the plan step sentence carries the same wording',
      freePeriodSentence(access('2025-03-01T00:00:00.000Z'), 'yearly', now).startsWith('Free access: 365 days. Your free access ended on March 1, 2025, so your first charge of $2,000'));
    check('a date exactly now is elapsed (the charge is due at this pass)',
      firstCharge(access(now.toISOString()), now).elapsed === true);
    // Billing boundaries are UTC instants. Whatever zone this process runs in
    // (the suite is run west of UTC as well), the office must read the same
    // calendar day the HQ card and the charger use — never the evening before.
    check(`the first-charge day is the UTC day in TZ=${process.env.TZ ?? 'unset'} (offset ${new Date('2027-01-15T00:00:00.000Z').getTimezoneOffset()} min)`,
      chargeDay('2027-01-15T00:00:00.000Z') === 'January 15, 2027'
      && firstChargeSentence(access('2027-01-15T00:00:00.000Z'), 'monthly', now).includes('January 15, 2027')
      && firstChargeSentence(access('2025-03-01T00:00:00.000Z'), 'monthly', now).includes('March 1, 2025'));
    check('a west-of-UTC zone really was exercised when asked for',
      process.env.TZ !== 'America/Los_Angeles' || new Date('2027-01-15T00:00:00.000Z').getTimezoneOffset() === 480);
  }

  console.log(' wiring');
  {
    const steps = read('src/components/launch/wizard/steps.ts');
    const payment = read('src/components/launch/wizard/PaymentStep.tsx');
    const review = read('src/components/launch/wizard/ReviewStep.tsx');
    const wizard = read('src/components/launch/wizard/SetupWizard.tsx');
    const plan = read('src/components/launch/wizard/PlanStep.tsx');
    const setup = read('src/components/billing/OfficeAccessSetup.tsx');
    check('every wizard screen that names the first charge handles the elapsed case',
      payment.includes('charge.elapsed') && review.includes('charge.elapsed') && wizard.includes('charge.elapsed')
      && plan.includes('freePeriodSentence') && steps.includes('firstChargeSentence'));
    check('the office access settings card handles an already-ended period too',
      setup.includes('Your included period ended') && setup.includes('next billing pass'));
    check('every first-charge date the office sees is formatted on the UTC day',
      !/longDate\(charge\.at\)|longDate\(at\)/.test(payment + review + wizard + steps)
      && (setup.match(/chargeDay\(snapshot\.plan\.firstChargeAt\)/g) ?? []).length === 2
      && !setup.includes('date(snapshot.plan.firstChargeAt)')
      && setup.includes("timeZone: 'UTC'"));

    const accounts = read('src/pages/admin/Accounts.tsx');
    check('Add Account shows the date field only for a reseller',
      /officeKind === 'reseller' && \(\s*<label[^]*?input-account-agreement-date/.test(accounts));
    check('Add Account sends the date only for a reseller and never for a software-only office',
      accounts.includes("officeKind === 'reseller' && agreementSignedOn ? agreementSignedOn : null")
      && accounts.includes('resellerAgreementSignedOn,'));
    check('Add Account shows the computed billing start beside the date',
      accounts.includes('text-account-agreement-billing-start') && accounts.includes('describeBillingStart(agreementSignedOn, resellerPeriod.days)'));
    check('the date input cannot be set in the future', accounts.includes('max={todayIsoDate()}'));
    check('the field resets when the dialog reopens', accounts.includes("setAgreementSignedOn('')"));

    const detail = read('src/pages/admin/AccountDetail.tsx');
    check('the account page shows the recorded date for a reseller only',
      detail.includes("account.officeKind === 'reseller'") && detail.includes('text-account-agreement-date') && detail.includes("'Not recorded'"));
    check('the edit form hides the field for a software-only office and leaves its stored value alone',
      detail.includes("form.officeKind !== 'software' && (") && detail.includes("form.officeKind === 'software' ? undefined : (form.resellerAgreementSignedOn || null)"));
    check('the edit form pre-fills the date on file and can clear it',
      detail.includes('resellerAgreementSignedOn: account.resellerAgreementSignedOn') && detail.includes('event.target.value || null'));
    check('the edit form shows the computed billing start and says a paid period is never shortened',
      detail.includes('text-edit-agreement-billing-start') && detail.includes('already paid for is never shortened'));

    const lib = read('src/lib/provider-accounts.ts');
    check('the account client carries the field both ways',
      (lib.match(/resellerAgreementSignedOn/g) ?? []).length >= 3);

    const card = read('src/components/admin/office-access/AccessBillingCard.tsx');
    check("the HQ access card reads the server's anchored start rather than counting days itself",
      card.includes('data.office.agreementBillingStartsAt') && !card.includes('billingStartsAt('));
    const types = read('src/lib/billing-types.ts');
    check('the access detail type names both fields',
      types.includes('resellerAgreementSignedOn?: string | null') && types.includes('agreementBillingStartsAt?: string | null'));
  }

  if (failures) {
    console.error(`\n${failures} reseller agreement check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll reseller agreement checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
