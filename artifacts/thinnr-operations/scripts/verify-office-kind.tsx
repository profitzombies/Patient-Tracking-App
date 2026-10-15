/**
 * Software-only offices in the operations app.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:office-kind
 *
 * A software-only office (an office that is not a THINNR reseller) gets the
 * same workspace with the reseller material — Training and the Marketing
 * Assets drive — left out. The server refuses the data on its own; this suite
 * proves the client's copy of the rule:
 *
 *   1. Policy — the nav helper drops exactly Training and Marketing Assets
 *      for a software office and nothing else; a reseller, an unknown kind
 *      (still loading) and a missing kind keep the full menu.
 *   2. Routes — a Switch built the way OfficeApp builds it (the reseller
 *      fragment included only for reseller content) sends a typed /training
 *      or /files URL to the not-found page for a software office and to the
 *      real page for a reseller, deep links included.
 *   3. Wiring — the Shell menu and the office route table read the kind from
 *      the shared office context; the context is fed from what the client
 *      already reads at sign-in (HQ account for a drill-in, office access
 *      payload, whoami) and never from a new poll.
 *   4. Parity — the paths match the mobile app's reseller-only routes and
 *      the server's gates.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Route, Router, Switch } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { OFFICE_NAV_ITEMS, restrictedOfficeNavItems } from '../src/components/layout/nav-config';
import {
  RESELLER_ONLY_OFFICE_PATHS,
  isResellerOnlyOfficePath,
  officeKindHasResellerContent,
  officeNavItemsForKind,
} from '../src/lib/office-kind';
import { OFFICE_KINDS, OFFICE_KIND_LABEL, officeKindOf } from '../src/data/hq/accounts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function main() {

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}
const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

console.log(' office kind');
check('the two kinds are reseller and software', OFFICE_KINDS.join(',') === 'reseller,software');
check('missing reads as reseller', officeKindOf(undefined) === 'reseller' && officeKindOf(null) === 'reseller');
check('an unknown word reads as reseller', officeKindOf('partner') === 'reseller');
check('the labels say what each kind is',
  OFFICE_KIND_LABEL.reseller === 'THINNR reseller' && OFFICE_KIND_LABEL.software === 'Software only');

console.log(' nav policy');
const labelsOf = (items: Array<{ label: string }>) => items.map((item) => item.label);
const full = labelsOf(OFFICE_NAV_ITEMS);
check('the full menu holds Training and Marketing Assets', full.includes('Training') && full.includes('Marketing Assets'));
const software = labelsOf(officeNavItemsForKind(OFFICE_NAV_ITEMS, 'software'));
check('a software office loses Training', !software.includes('Training'));
check('a software office loses Marketing Assets', !software.includes('Marketing Assets'));
check('a software office loses nothing else',
  software.join(',') === full.filter((label) => label !== 'Training' && label !== 'Marketing Assets').join(','),
  software.join(','));
check('a reseller keeps the full menu', labelsOf(officeNavItemsForKind(OFFICE_NAV_ITEMS, 'reseller')).join(',') === full.join(','));
check('an unknown kind keeps the full menu (never hide on a guess)',
  labelsOf(officeNavItemsForKind(OFFICE_NAV_ITEMS, null)).join(',') === full.join(','));
check('a missing kind keeps the full menu', labelsOf(officeNavItemsForKind(OFFICE_NAV_ITEMS, undefined)).join(',') === full.join(','));
check('the narrowed (nonpayment) menu composes with the kind',
  labelsOf(officeNavItemsForKind(restrictedOfficeNavItems(), 'software')).every((label) => label !== 'Training' && label !== 'Marketing Assets'));

console.log(' path policy');
for (const location of ['/training', '/training/c-1', '/training/c-1/videos/v-1', '/training/team/t-1', '/files', '/files/']) {
  check(`${location} is reseller-only`, isResellerOnlyOfficePath(location));
}
for (const location of ['/', '/patients', '/trainings', '/filesystem', '/payments', '/account', '/settings']) {
  check(`${location} is open to every kind`, !isResellerOnlyOfficePath(location));
}
check('the policy lists exactly /training and /files', RESELLER_ONLY_OFFICE_PATHS.join(',') === '/training,/files');
check('reseller content follows the kind', officeKindHasResellerContent('reseller') && !officeKindHasResellerContent('software') && officeKindHasResellerContent(null));

console.log(' routes (a Switch built the way OfficeApp builds it)');
const textOf = (instance: ReactTestInstance): string => {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') { parts.push(node); return; }
    node.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(instance);
  return parts.join('');
};
const Page = ({ name }: { name: string }) => <div data-testid={`page-${name}`}>{name}</div>;
const NotFound = () => <div data-testid="page-not-found">not found</div>;
function Routes({ kind }: { kind: 'reseller' | 'software' | null }) {
  return (
    <Switch>
      <Route path="/"><Page name="overview" /></Route>
      <Route path="/patients"><Page name="patients" /></Route>
      {officeKindHasResellerContent(kind) && <>
        <Route path="/training"><Page name="training" /></Route>
        <Route path="/files"><Page name="files" /></Route>
        <Route path="/training/team/:viewerId"><Page name="teammate" /></Route>
        <Route path="/training/:courseId/videos/:videoId"><Page name="lesson" /></Route>
        <Route path="/training/:courseId"><Page name="course" /></Route>
      </>}
      <Route path="/account"><Page name="account" /></Route>
      <Route component={NotFound} />
    </Switch>
  );
}
async function renderAt(location: string, kind: 'reseller' | 'software' | null) {
  const { hook } = memoryLocation({ path: location, static: true });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Router hook={hook}><Routes kind={kind} /></Router>);
  });
  return textOf(renderer.root);
}
const CASES: Array<[string, string]> = [
  ['/training', 'training'], ['/files', 'files'], ['/training/team/t-1', 'teammate'],
  ['/training/c-1/videos/v-1', 'lesson'], ['/training/c-1', 'course'],
];
for (const [location, page] of CASES) {
  check(`${location} → not found for a software office`, (await renderAt(location, 'software')) === 'not found');
  check(`${location} → ${page} for a reseller`, (await renderAt(location, 'reseller')) === page);
  check(`${location} → ${page} while the kind is unknown`, (await renderAt(location, null)) === page);
}
for (const [location, page] of [['/', 'overview'], ['/patients', 'patients'], ['/account', 'account']] as Array<[string, string]>) {
  check(`${location} → ${page} for a software office`, (await renderAt(location, 'software')) === page);
}
check('a route nobody has → not found for every kind',
  (await renderAt('/nowhere', 'software')) === 'not found' && (await renderAt('/nowhere', 'reseller')) === 'not found');

console.log(' HQ Accounts empty state');
const accountsPage = read('src/pages/admin/Accounts.tsx');
check('the no-match copy never indexes the kind labels with the "all" filter',
  !/OFFICE_KIND_LABEL\[kindFilter as /.test(accountsPage)
    && /kindFilter !== 'all'\s*\?\s*`No \$\{OFFICE_KIND_LABEL\[kindFilter\]/.test(accountsPage));
check('a status filter with no rows gets its own words', accountsPage.includes("'No offices have been offboarded'") && accountsPage.includes("'No current offices'"));
check('clearing the empty state resets the status filter too', accountsPage.includes("setQuery(''); setKindFilter('all'); setStatusFilter('all');"));

console.log(' wiring');
const officeApp = read('src/OfficeApp.tsx');
check('the office route table reads the kind from the shared context',
  officeApp.includes('const { officeKind } = useOfficeRestriction();') && officeApp.includes('{officeKindHasResellerContent(officeKind) && <>'));
check('the reseller fragment holds exactly the training and files routes',
  (officeApp.match(/path="\/training/g) ?? []).length === 4 && officeApp.includes('<Route path="/files" component={OfficeFiles} />'));
check('the kind comes from the HQ account for a drill-in', officeApp.includes('officeKindOf(scope.officeKind)'));
check('the kind comes from the office access payload for office staff', officeApp.includes('officeKindOf(access.data.office_kind)'));
check('the kind comes from whoami for a claimed login', officeApp.includes('claimedWorkspace?.officeKind ?? null'));
check('the kind is published next to the nonpayment state', officeApp.includes('message: restricted ? access.data?.message ?? null : null, officeKind }'));
const shell = read('src/components/layout/Shell.tsx');
check('the Shell menu runs through the kind helper',
  shell.includes("import { officeNavItemsForKind } from '@/lib/office-kind';") && /officeNavItemsForKind\(restricted \? restrictedOfficeNavItems\(\) : OFFICE_NAV_ITEMS, officeKind\)/.test(shell));
const session = read('src/contexts/session.tsx');
check('whoami carries the kind into the session', /officeKind/.test(session));
const useAccess = read('src/hooks/use-office-access.ts');
check('the office access payload types the kind', /office_kind\?: /.test(useAccess));
const training = read('src/contexts/training-data.tsx');
check('a software office\'s staff skip the training read',
  training.includes("claimedWorkspace?.officeKind === 'software'") && training.includes('!softwareOfficeStaff'));

console.log(' parity with the mobile app and the server');
const mobile = read('../thinnr-mobile/lib/office-restriction.ts');
check('the mobile app hides training for the same kind', mobile.includes("'/training'") && mobile.includes("!== 'software'"));
const serverFiles = read('../api-server/src/routes/office-files.ts');
check('the server refuses the files routes by kind', serverFiles.includes('reason: "office_kind"'));
const serverKind = read('../api-server/src/lib/office-kind.ts');
check('the server reads an unknown kind as reseller too', /=== "software" \? "software" : "reseller"/.test(serverKind));
const migration = read('../../supabase/migrations/20261210000000_office_kind.sql');
check('the database fails training reads closed for a software office', migration.includes('caller_office_is_software'));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll office-kind checks passed.');
}

void main();
