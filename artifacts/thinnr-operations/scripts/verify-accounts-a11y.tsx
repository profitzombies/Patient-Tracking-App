/**
 * HQ provider-account directory — row activation, search control, and
 * URL-persistence invariants.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:account-search
 *   (chained after scripts/verify-accounts-search.ts)
 *
 * Renders the REAL admin Accounts page with react-test-renderer under Node
 * (context modules remapped to stubs via tsconfig.a11y.json) and asserts:
 *
 *  - every account row follows "row with one announced link": the tr stays
 *    semantically inert (no tabIndex/role/aria-label/onKeyDown), carries a
 *    pointer-only onClick, and contains exactly one in-tab-order anchor with
 *    the account-detail href and an accessible name naming the office;
 *  - the row click navigates to the account detail page, but modified
 *    clicks and clicks bubbling from nested controls are left alone;
 *  - the header search input is labelled, its value IS the ?q= URL param,
 *    and typing replace-navigates so reloads and shared URLs restore the
 *    filtered view (proven by cold-rendering at a ?q= URL);
 *  - empty results show the no-match explanation WITHOUT hiding the search
 *    control, and its Clear search button resets the query.
 */
// Namespace import: tsx compiles this script's JSX with the classic
// React.createElement transform, so React must be in scope.
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Router } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { memoryLocation } from 'wouter/memory-location';
import type { ProviderAccount } from '../src/data/hq/accounts';
import { __setHqData } from './a11y-stubs/hq-data';
import { __setLockedAccounts } from './a11y-stubs/account-locks';
import { __setSession } from './a11y-stubs/session';
import Accounts from '../src/pages/admin/Accounts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The row click handler consults window.getSelection to leave text selection
// alone; give Node a minimal window for it.
const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function mkAccount(overrides: Partial<ProviderAccount>): ProviderAccount {
  return {
    id: 'acct-1',
    providerId: 'prov-1',
    officeName: 'Beacon Hill Aesthetics',
    providerName: 'Dr. Maya Brooks',
    providerRole: 'Medical Director',
    providerCode: '482115',
    status: 'active',
    plan: 'Concierge',
    officeKind: 'reseller',
    resellerAgreementSignedOn: null,
    address1: '123 Main St',
    address2: null,
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

const accounts = [
  mkAccount({}),
  mkAccount({
    id: 'acct-2',
    officeName: 'Harborview Medspa',
    providerName: 'Dr. Elena Rostova',
    providerRole: 'Practitioner',
    providerCode: '590233',
    status: 'needs_setup',
    plan: 'Core',
    city: 'Portland',
    state: 'OR',
    postalCode: '97201',
    email: 'hello@harborview.example.com',
    phone: '555-887-2010',
    joinedKey: '2026-07-03',
  }),
];

__setHqData({ accounts, accountsStatus: 'ready' });
// Demo bypass persona — the page treats signed-out as full HQ access.
__setSession({ authStatus: 'signed-out', hqRole: null });

// ─── Render helpers ──────────────────────────────────────────────────────────

interface Rendered {
  renderer: ReactTestRenderer;
  root: ReactTestInstance;
  loc: ReturnType<typeof memoryLocation>;
}

async function renderAt(path: string): Promise<Rendered> {
  const loc = memoryLocation({ path, record: true });
  let renderer: ReactTestRenderer | undefined;
  // The page reads the organization's reseller period through react-query
  // (for the "Billing starts" line); the app's root provider is stood in for here.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Router hook={loc.hook}>
          <Accounts />
        </Router>
      </QueryClientProvider>,
    );
  });
  return { renderer: renderer!, root: renderer!.root, loc };
}

const isHost = (node: ReactTestInstance) => typeof node.type === 'string';
const byTestId = (root: ReactTestInstance, re: RegExp) =>
  root.findAll((n) => isHost(n) && typeof n.props['data-testid'] === 'string' && re.test(n.props['data-testid']));
const anchorsIn = (node: ReactTestInstance) => node.findAll((n) => n.type === 'a');
const tabStopsIn = (node: ReactTestInstance) => anchorsIn(node).filter((a) => a.props.tabIndex !== -1);

/** Synthetic pointer event for the row's onClick guards. */
const rowClick = (overrides: Record<string, unknown> = {}) => ({
  defaultPrevented: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  target: { closest: () => null },
  ...overrides,
});

async function main() {
  console.log('Account directory: row activation, search, URL persistence\n');

  // ---------------------------------------------------------------------------
  console.log('1. Rows follow "row with one announced link"');
  const base = await renderAt('/admin/accounts');
  const rows = byTestId(base.root, /^row-account-/);
  check('both account rows render', rows.length === 2, `got ${rows.length}`);
  for (const tr of rows) {
    const id = String(tr.props['data-testid']).replace('row-account-', '');
    const account = accounts.find((a) => a.id === id)!;
    check(`row ${id}: tr carries no interactive fakery`,
      tr.type === 'tr' &&
        tr.props.tabIndex === undefined &&
        tr.props.role === undefined &&
        tr.props['aria-label'] === undefined &&
        tr.props.onKeyDown === undefined);
    check(`row ${id}: row click is pointer-only convenience (handler present)`, typeof tr.props.onClick === 'function');
    const anchors = anchorsIn(tr);
    const stops = tabStopsIn(tr);
    check(`row ${id}: exactly one anchor, in the tab order`, anchors.length === 1 && stops.length === 1,
      `anchors=${anchors.length} stops=${stops.length}`);
    const link = stops[0]!;
    check(`row ${id}: anchor has the account-detail href`, link.props.href === `/admin/accounts/${id}`,
      `href=${String(link.props.href)}`);
    const label = String(link.props['aria-label'] ?? '');
    check(`row ${id}: anchor announces the destination office`,
      label.startsWith('Open') && label.includes(account.officeName), `label=${label}`);
  }

  // ---------------------------------------------------------------------------
  console.log('2. Row clicks navigate; guarded clicks are left alone');
  const [firstRow] = rows;
  await act(async () => { firstRow!.props.onClick(rowClick({ metaKey: true })); });
  check('modified click (meta) does not navigate', base.loc.history.length === 1,
    `history=${JSON.stringify(base.loc.history)}`);
  await act(async () => { firstRow!.props.onClick(rowClick({ target: { closest: () => ({}) } })); });
  check('click bubbling from a nested control does not navigate', base.loc.history.length === 1,
    `history=${JSON.stringify(base.loc.history)}`);
  await act(async () => { firstRow!.props.onClick(rowClick()); });
  check('plain row click opens the account detail page',
    base.loc.history[base.loc.history.length - 1] === '/admin/accounts/acct-1',
    `history=${JSON.stringify(base.loc.history)}`);
  base.renderer.unmount();

  // ---------------------------------------------------------------------------
  console.log('3. Search is labelled, URL-backed, and filters live');
  const searchable = await renderAt('/admin/accounts');
  const input = byTestId(searchable.root, /^input-account-search$/);
  check('search input renders in the All accounts header', input.length === 1);
  check('search input is labelled for AT',
    String(input[0]!.props['aria-label'] ?? '').toLowerCase().includes('search accounts'));
  check('search input starts empty (no ?q=)', input[0]!.props.value === '');
  await act(async () => { input[0]!.props.onChange({ target: { value: 'harborview' } }); });
  check('typing replace-navigates to ?q=',
    searchable.loc.history[searchable.loc.history.length - 1] === '/admin/accounts?q=harborview',
    `history=${JSON.stringify(searchable.loc.history)}`);
  const filtered = byTestId(searchable.root, /^row-account-/);
  check('rail filters to the matching office', filtered.length === 1 &&
    filtered[0]!.props['data-testid'] === 'row-account-acct-2', `rows=${filtered.length}`);
  check('input value IS the parsed URL param',
    byTestId(searchable.root, /^input-account-search$/)[0]!.props.value === 'harborview');
  const count = byTestId(searchable.root, /^text-accounts-count$/);
  const countText = count.length === 1 ? JSON.stringify(count[0]!.children) : '(missing)';
  check('count label reports the match subset', countText.includes('1 of 2'), countText);
  searchable.renderer.unmount();

  // ---------------------------------------------------------------------------
  console.log('4. ?q= survives reload / shared URLs (cold render at a query URL)');
  const shared = await renderAt('/admin/accounts?q=482-115');
  const sharedInput = byTestId(shared.root, /^input-account-search$/);
  check('cold render restores the query into the input', sharedInput[0]!.props.value === '482-115');
  const sharedRows = byTestId(shared.root, /^row-account-/);
  check('cold render restores the filtered rows (punctuation-tolerant code)',
    sharedRows.length === 1 && sharedRows[0]!.props['data-testid'] === 'row-account-acct-1',
    `rows=${sharedRows.length}`);
  shared.renderer.unmount();

  // ---------------------------------------------------------------------------
  console.log('5. Kill-switch lock chip wording is searchable');
  // acct-2 is ACTIVE by persisted status but locked via provider_account_locks
  // — the extra "Locked" chip it wears in the table must make it findable.
  __setLockedAccounts(['acct-2']);
  const locked = await renderAt('/admin/accounts?q=locked');
  const lockedRows = byTestId(locked.root, /^row-account-/);
  check('searching "locked" surfaces the context-locked account only',
    lockedRows.length === 1 && lockedRows[0]!.props['data-testid'] === 'row-account-acct-2',
    `rows=${lockedRows.map((r) => r.props['data-testid']).join(',')}`);
  locked.renderer.unmount();
  __setLockedAccounts([]);

  // ---------------------------------------------------------------------------
  console.log('6. Empty results explain themselves without hiding the search');
  const empty = await renderAt('/admin/accounts?q=zzz-no-such-office');
  check('no rows for a non-matching query', byTestId(empty.root, /^row-account-/).length === 0);
  const noMatch = byTestId(empty.root, /^text-accounts-no-match$/);
  check('no-match explanation renders', noMatch.length === 1);
  check('search control is still present during empty results',
    byTestId(empty.root, /^input-account-search$/).length === 1);
  const clear = byTestId(empty.root, /^button-accounts-empty-clear-search$/);
  check('empty state offers Clear search', clear.length === 1 && clear[0]!.type === 'button');
  await act(async () => { clear[0]!.props.onClick(); });
  check('Clear search restores the full directory',
    byTestId(empty.root, /^row-account-/).length === 2 &&
      byTestId(empty.root, /^input-account-search$/)[0]!.props.value === '');
  empty.renderer.unmount();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll account directory invariants hold.');
}

void main();
