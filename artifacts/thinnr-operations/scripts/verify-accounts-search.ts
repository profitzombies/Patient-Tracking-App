/**
 * HQ provider-account directory search — matcher contract.
 *
 * Freezes the behaviors the All-accounts search field depends on:
 *
 *  - the haystack is field-complete: office, provider name and role, code,
 *    plan, status chip wording, email, phone, both address lines, city,
 *    state (abbreviation AND full name), ZIP, joined date, patient count,
 *    and monthly revenue are all searchable;
 *  - matching is case-insensitive and punctuation-tolerant — formatted and
 *    unformatted phone numbers and provider codes both match, whichever way
 *    the stored value is formatted;
 *  - multi-word queries work across fields (every token must land, tokens
 *    may land in different fields);
 *  - digit tokens can never falsely match across two adjacent fields;
 *  - the empty query matches everything.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:account-search
 */
import {
  ACCOUNT_STATUS_LABEL,
  accountMatchesQuery,
  accountSearchHaystack,
  type ProviderAccount,
} from '../src/data/hq/accounts';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${label} = ${e}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}: expected ${e}, got ${a}`);
  }
}

/** Full ProviderAccount with overridable fields — mirrors the live DTO. */
function mkAccount(overrides: Partial<ProviderAccount>): ProviderAccount {
  return {
    id: 'acct-x',
    providerId: 'prov-x',
    officeName: 'Beacon Hill Aesthetics',
    providerName: 'Dr. Maya Brooks',
    providerRole: 'Medical Director',
    providerCode: '482115',
    status: 'active',
    plan: 'Concierge',
    officeKind: 'reseller',
    resellerAgreementSignedOn: null,
    address1: '123 Main St',
    address2: 'Suite 200',
    city: 'Boston',
    state: 'MA',
    postalCode: '02108',
    email: 'frontdesk@beaconhill.example.com',
    phone: '(555) 301-4420',
    joinedKey: '2026-08-12',
    greetingName: 'Beacon Hill',
    activePatientCount: 42,
    newEnrollments: 5,
    recurringRevenue: 8000,
    enrollmentRevenue: 4345,
    activeSubscriptions: 20,
    deliveriesInWindow: 6,
    engagementRate: 0.8,
    avgPoundsLost: 9,
    goalCompletion: 0.6,
    retention: 0.9,
    ...overrides,
  };
}

const beacon = mkAccount({});
const harbor = mkAccount({
  id: 'acct-y',
  officeName: 'Harborview Medspa',
  providerName: 'Dr. Elena Rostova',
  providerRole: 'Practitioner',
  providerCode: '590-233', // stored WITH punctuation — the reverse formatting case
  status: 'needs_setup',
  plan: 'Core',
  address1: '77 Wharf Ave',
  address2: null,
  city: 'Portland',
  state: 'OR',
  postalCode: '97201',
  email: 'hello@harborview.example.com',
  phone: '555-887-2010',
  joinedKey: '2026-07-03',
  activePatientCount: 1180,
  recurringRevenue: null,
  enrollmentRevenue: null,
});
const lockedOffice = mkAccount({ id: 'acct-z', officeName: 'Cedar Grove Clinic', status: 'locked' });

const matches = (account: ProviderAccount, query: string) =>
  accountMatchesQuery(accountSearchHaystack(account), query);
const matchesLocked = (account: ProviderAccount, query: string) =>
  accountMatchesQuery(accountSearchHaystack(account, { locked: true }), query);

console.log('HQ account directory search matcher\n');

// ─── Empty and trivial queries ───────────────────────────────────────────────
check('empty query matches', matches(beacon, ''), true);
check('whitespace-only query matches', matches(beacon, '   '), true);

// ─── Field completeness (every displayed value is searchable) ────────────────
check('office name, case-insensitive', matches(beacon, 'beacon'), true);
check('provider name', matches(beacon, 'brooks'), true);
check('provider role', matches(beacon, 'medical director'), true);
check('provider code, verbatim', matches(beacon, '482115'), true);
check('plan', matches(beacon, 'concierge'), true);
check('status wording (Active)', matches(beacon, 'active'), true);
check('status wording (Needs setup)', matches(harbor, 'needs setup'), true);
check('locked status searches by its chip wording (Disabled)', matches(lockedOffice, 'disabled'), true);
// The HQ kill switch (provider_account_locks) wears its own "Locked" chip on
// top of ANY persisted status — that wording must be searchable too.
check('kill-switch lock searches by its chip wording (Locked)', matchesLocked(beacon, 'locked'), true);
check('active account without a lock does not match "locked"', matches(beacon, 'locked'), false);
check('email, partial', matches(beacon, 'frontdesk@'), true);
check('address line 1', matches(beacon, '123 main'), true);
check('address line 2', matches(beacon, 'suite 200'), true);
check('city', matches(beacon, 'boston'), true);
check('state abbreviation', matches(beacon, 'ma'), true);
check('full state name', matches(beacon, 'massachusetts'), true);
check('ZIP', matches(beacon, '02108'), true);
check('joined month + year', matches(beacon, 'aug 2026'), true);
check('patient count', matches(beacon, '42'), true);
check('patient count, comma-formatted', matches(harbor, '1,180'), true);
check('monthly revenue, raw', matches(beacon, '12345'), true);
check('monthly revenue, $-formatted', matches(beacon, '$12,345'), true);

// ─── Formatted / unformatted phones and codes, both storage shapes ───────────
check('formatted phone, verbatim', matches(beacon, '(555) 301-4420'), true);
check('unformatted phone vs formatted stored value', matches(beacon, '5553014420'), true);
check('dashed phone vs formatted stored value', matches(beacon, '555-301-4420'), true);
check('partial phone digits', matches(beacon, '(555) 301'), true);
check('dashed code vs plain stored code', matches(beacon, '482-115'), true);
check('plain code vs dashed stored code', matches(harbor, '590233'), true);
check('dashed code vs dashed stored code', matches(harbor, '590-233'), true);
check('plain phone vs dashed stored phone', matches(harbor, '5558872010'), true);

// ─── Multi-word queries across fields ────────────────────────────────────────
check('provider + city across fields', matches(beacon, 'brooks boston'), true);
check('office + plan across fields', matches(harbor, 'harborview core'), true);
check('three tokens across fields', matches(beacon, 'maya concierge 02108'), true);
check('one bad token fails the whole query', matches(beacon, 'brooks portland'), false);

// ─── Discrimination and safety ───────────────────────────────────────────────
check('non-matching text', matches(beacon, 'zzz'), false);
check('other office does not match', matches(harbor, 'beacon'), false);
check('digits never concatenate across fields', matches(beacon, '44200210'), false);
check('digit token with no digit-field hit fails', matches(beacon, '999999'), false);

// ACCOUNT_STATUS_LABEL is the single source for chip wording — a drift here
// would silently split search wording from what the table displays.
check('status label map covers every status', Object.keys(ACCOUNT_STATUS_LABEL).sort(), ['active', 'locked', 'needs_setup']);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll account search matcher checks passed.');
