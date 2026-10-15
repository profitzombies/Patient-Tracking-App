/**
 * Software-only offices in the provider app.
 *
 *   pnpm --filter @workspace/thinnr-mobile run test:office-kind
 *
 * A software-only office (an office that is not a THINNR reseller) gets the
 * same app with one thing missing: Training. The server fails the training
 * reads closed on its own; this suite proves the app's copy of the rule:
 *
 *   1. Policy — a software office's staffer never reaches Training or any
 *      screen below it (course, lesson, teammate); every other staff screen
 *      is untouched.
 *   2. Never on a guess — an unknown kind (still loading, read failed),
 *      a reseller office and patient mode hide nothing.
 *   3. Independence — the rule does not depend on the setup or nonpayment
 *      gates: it is its own predicate with its own input.
 *   4. Wiring — the kind rides the office access read every staff session
 *      already makes (no new poll), the root layout covers a hidden route
 *      with the not-found card, and the launcher drops Training for a
 *      software office while a reseller keeps it.
 *   5. Parity — the reseller-only routes line up with the operations app's
 *      reseller-only pages and the server's gate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  isResellerOnlyStaffRoute,
  officeKindOf,
  staffRouteBlocked,
  staffRouteHiddenForKind,
} from '../lib/office-restriction';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}
const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');

console.log(' office kind');
check('missing reads as reseller', officeKindOf(undefined) === 'reseller');
check('null reads as reseller', officeKindOf(null) === 'reseller');
check('an unknown word reads as reseller', officeKindOf('partner') === 'reseller');
check('software is software', officeKindOf('software') === 'software');

console.log(' policy');
const HIDDEN = ['/training', '/training/', '/training-course/c-1', '/training-lesson/l-1', '/training-teammate/t-1'];
const OPEN = ['/', '/patients', '/patients/p-1', '/leaderboard', '/payments', '/payments/subscriptions',
  '/office-account', '/office-patient/p-1', '/sell-to-patient', '/support-chat', '/security', '/persona'];
for (const pathname of HIDDEN) {
  check(`${pathname} is hidden from a software office`,
    staffRouteHiddenForKind({ mode: 'staff', officeKind: 'software', pathname }) === true);
}
for (const pathname of OPEN) {
  check(`${pathname} stays open to a software office`,
    staffRouteHiddenForKind({ mode: 'staff', officeKind: 'software', pathname }) === false);
}
check('a lookalike prefix is not hidden',
  staffRouteHiddenForKind({ mode: 'staff', officeKind: 'software', pathname: '/trainings' }) === false);
check('the reseller-only list is the same one the launcher filters on',
  isResellerOnlyStaffRoute('/training') && !isResellerOnlyStaffRoute('/payments'));

console.log(' never on a guess');
for (const pathname of HIDDEN) {
  check(`${pathname} is open to a reseller`,
    staffRouteHiddenForKind({ mode: 'staff', officeKind: 'reseller', pathname }) === false);
  check(`${pathname} is open while the kind is unknown`,
    staffRouteHiddenForKind({ mode: 'staff', officeKind: null, pathname }) === false);
  check(`${pathname} is untouched in patient mode`,
    staffRouteHiddenForKind({ mode: 'patient', officeKind: 'software', pathname }) === false);
  check(`${pathname} is untouched before the mode is known`,
    staffRouteHiddenForKind({ mode: null, officeKind: 'software', pathname }) === false);
}

console.log(' independence from the other gates');
check('a paid software office still has Training hidden (the nonpayment gate does not decide this)',
  staffRouteBlocked({ mode: 'staff', restricted: false, pathname: '/training' }) === false
  && staffRouteHiddenForKind({ mode: 'staff', officeKind: 'software', pathname: '/training' }) === true);
check('the kind predicate takes no setup or payment input',
  staffRouteHiddenForKind.length === 1
  && !/restricted|complete|snapshot/.test(read('lib/office-restriction.ts').split('export function staffRouteHiddenForKind')[1]?.split('\n}')[0] ?? 'restricted'));

console.log(' wiring');
const context = read('context/OfficeRestrictionContext.tsx');
check('the kind rides the office access read (no new poll)',
  context.includes("officeKindOf(query.data.office_kind)") && (context.match(/useQuery(?:<|\()/g) ?? []).length === 1);
check('the kind is null until the read lands', context.includes('query.data ? officeKindOf(query.data.office_kind) : null'));
const accessApi = read('lib/office-access-api.ts');
check('the access payload carries office_kind', /office_kind\?: 'reseller' \| 'software'/.test(accessApi));

const layout = read('app/_layout.tsx');
check('the guard reads the kind predicate', layout.includes('staffRouteHiddenForKind({ mode, officeKind, pathname })'));
check('a hidden route is covered by the not-found card',
  layout.includes('<NotFoundCard testID="office-kind-not-found" />'));
check('the hidden check never waits on the nonpayment gate',
  /const hidden = hydrated && !narrowed && staffRouteHiddenForKind/.test(layout));
check('the covered screen cannot be reached behind the card',
  /pointerEvents: blocked \? 'none' : 'auto'/.test(layout) && /const blocked = narrowed \|\| hidden;/.test(layout));

const notFound = read('app/+not-found.tsx');
check('the unknown-route screen and the guard share one card',
  notFound.includes("from '@/components/NotFoundCard'") && layout.includes("from '@/components/NotFoundCard'"));

const launcher = read('components/provider/ProviderFabMenu.tsx');
check('the launcher drops the reseller-only rows for a software office',
  launcher.includes('const SOFTWARE_ITEMS: FabMenuItem[] = ITEMS.filter(') && launcher.includes('isResellerOnlyStaffRoute(String(item.action.href))'));
check('the launcher reads the kind from the shared office state', launcher.includes('const { restricted, officeKind } = useOfficeRestriction();'));
check('a software office chooses the narrowed list only while restricted',
  launcher.includes("restricted ? RESTRICTED_ITEMS : officeKind === 'software' ? SOFTWARE_ITEMS : ITEMS"));
check('a reseller keeps Training', /key: 'training', label: 'Training'/.test(launcher));

console.log(' parity with the operations app and the server');
const webKind = read('../thinnr-operations/src/lib/office-kind.ts');
check('the operations app hides training for the same kind', webKind.includes("'/training'") && webKind.includes("!== 'software'"));
const serverKind = read('../api-server/src/lib/office-kind.ts');
check('the server reads an unknown kind as reseller too', /=== "software" \? "software" : "reseller"/.test(serverKind));
const migration = read('../../supabase/migrations/20261210000000_office_kind.sql');
check('the database fails training reads closed for a software office',
  migration.includes('caller_office_is_software'));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll office-kind checks passed.');
