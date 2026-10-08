/**
 * The guided-demo switch on the mobile app — what the published build lets a
 * signed-out visitor reach.
 *
 * The rules live in lib/demo-entry.ts and are checked here as truth tables.
 * The screens that use them are checked at their seams: each demo entry point
 * must consult the switch, so the published bundle (switch off) has no way
 * into the demo modes or the claim test screen. The demo-on behaviour stays
 * covered by the existing suites, which run with the switch on.
 */
import { readFileSync } from 'node:fs';
import {
  ADVICE_DISCLAIMER,
  DEMO_DISCLAIMER,
  demoEntryEnabled,
  disclaimerText,
  providerDemoRedirect,
  resolveDemoEntry,
  showsDemoLabels,
} from '../lib/demo-entry';

let failures = 0;
const check = (name: string, condition: boolean) => condition
  ? console.log(`  ok  ${name}`)
  : (failures += 1, console.error(`  FAIL ${name}`));
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

console.log('demo switch: the rule');
{
  const table: Array<[string | null | undefined, boolean, boolean]> = [
    ['on', false, true],
    ['on', true, true],
    ['off', false, false],
    ['off', true, false],
    [' OFF ', true, false],
    ['On', true, true],
    ['', false, true],
    ['', true, false],
    [undefined, true, false],
    [null, false, true],
    ['yes', true, false],
    ['yes', false, true],
  ];
  for (const [raw, productionBuild, expected] of table) {
    check(
      `${JSON.stringify(raw ?? null)} in a ${productionBuild ? 'production' : 'development'} bundle → ${expected ? 'on' : 'off'}`,
      resolveDemoEntry(raw, productionBuild) === expected,
    );
  }
  check(
    'a Node run counts as a development bundle',
    demoEntryEnabled === resolveDemoEntry(process.env.EXPO_PUBLIC_THINNR_DEMO, false),
  );
}

console.log('demo switch: demo labels only reach signed-out visitors of a demo build');
{
  check('signed out, demo on → labels', showsDemoLabels(false, true) === true);
  check('signed in, demo on → no labels', showsDemoLabels(true, true) === false);
  check('signed out, demo off → no labels', showsDemoLabels(false, false) === false);
  check('signed in, demo off → no labels', showsDemoLabels(true, false) === false);
  check('signed out, demo on → demo footer', disclaimerText(false, true) === DEMO_DISCLAIMER);
  check('signed in, demo on → advice footer', disclaimerText(true, true) === ADVICE_DISCLAIMER);
  check('signed out, demo off → advice footer', disclaimerText(false, false) === ADVICE_DISCLAIMER);
  check('signed in, demo off → advice footer', disclaimerText(true, false) === ADVICE_DISCLAIMER);
  check('the advice footer never mentions the demo', !/demo|synthetic/i.test(ADVICE_DISCLAIMER));
  check('the advice footer keeps the notice', ADVICE_DISCLAIMER.includes('NOT MEDICAL ADVICE'));
}

console.log('demo switch: signed-out visitors never reach the seeded office');
{
  type Input = Parameters<typeof providerDemoRedirect>[0];
  const base: Input = {
    enabled: false,
    modeHydrated: true,
    mode: 'staff',
    sessionLoading: false,
    signedIn: false,
    pathname: '/',
  };
  const cases: Array<[string, Partial<Input>, ReturnType<typeof providerDemoRedirect>]> = [
    ['staff dashboard, signed out → provider sign-in', {}, '/provider-login'],
    ['staff roster, signed out → provider sign-in', { pathname: '/patients' }, '/provider-login'],
    ['staff payments detail, signed out → provider sign-in', { pathname: '/payments/orders' }, '/provider-login'],
    ['seeded patient record, signed out → provider sign-in', { pathname: '/patient/pat_001' }, '/provider-login'],
    ['claim test, signed out in staff mode → provider sign-in', { pathname: '/claim-test' }, '/provider-login'],
    ['seeded patient record in patient mode → patient front door', { mode: 'patient', pathname: '/patient/pat_001' }, '/patient-welcome'],
    ['sell-to-patient with no mode yet → patient front door', { mode: null, pathname: '/sell-to-patient' }, '/patient-welcome'],
    ['claim test in patient mode → patient front door', { mode: 'patient', pathname: '/claim-test' }, '/patient-welcome'],
    ['training lesson in patient mode → patient front door', { mode: 'patient', pathname: '/training-lesson/c1/v1' }, '/patient-welcome'],
    ['staff tab outside staff mode is left to the tab layout', { mode: 'patient', pathname: '/' }, null],
    ['payments tab outside staff mode is left to the tab layout', { mode: null, pathname: '/payments/orders' }, null],
    ['claiming an account stays open', { pathname: '/claim-account' }, null],
    ['a claim link stays open', { pathname: '/claim-account/abc123' }, null],
    ['the patient front door is not a provider screen', { pathname: '/patient-welcome' }, null],
    ['provider sign-in is not a provider screen', { pathname: '/provider-login' }, null],
    ['patient screens are left to the patient gate', { mode: 'patient', pathname: '/today' }, null],
    ['signed in → the screen renders', { signedIn: true }, null],
    ['session still loading → wait', { sessionLoading: true }, null],
    ['mode not read yet → wait', { modeHydrated: false }, null],
    ['demo switched on → the demo office stays', { enabled: true }, null],
    ['demo switched on, patient record → the demo stays', { enabled: true, pathname: '/patient/pat_001' }, null],
  ];
  for (const [name, overrides, expected] of cases) {
    check(name, providerDemoRedirect({ ...base, ...overrides }) === expected);
  }
}

console.log('demo switch: every demo entry point consults the switch');
{
  const persona = source('app/persona.tsx');
  check(
    'persona picker sends signed-out visitors to the patient front door',
    /if \(!signedIn && !demoEntryEnabled\) return <Redirect href=\{'\/patient-welcome' as Href\} \/>;/.test(persona),
  );
  check(
    'guided patient chooser sends visitors to the patient front door',
    /if \(!demoEntryEnabled\) return <Redirect href="\/patient-welcome" \/>;/.test(source('app/patient-entry.tsx')),
  );
  const claimTest = source('app/claim-test.tsx');
  check(
    'claim test screen redirects before rendering',
    /if \(!demoEntryEnabled\) return <Redirect href="\/today" \/>;\s*if \(!hydrated \|\| sessionLoading\) return null;/.test(claimTest),
  );
  check(
    'claim test screen never asks the server',
    /if \(!demoEntryEnabled \|\| sessionLoading \|\| !session\) return;/.test(claimTest),
  );
  const claimCard = source('components/patient/ClaimTestEntryCard.tsx');
  check(
    'claim test card never asks the server',
    /if \(!demoEntryEnabled \|\| sessionLoading \|\| !session\) return;/.test(claimCard),
  );
  check(
    'claim test card never renders',
    /if \(!demoEntryEnabled \|\| !session \|\| !state\) return null;/.test(claimCard),
  );
  check(
    'patient sign-in shows the demo link only with the switch on',
    /\{demoEntryEnabled \? \(\s*<FooterLink quiet testID="login-demo"/.test(source('app/patient-login.tsx')),
  );
  check(
    'a stray demo link press stays put',
    /const openDemo = async \(\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(!demoEntryEnabled\) return;/.test(source('hooks/usePatientLogin.ts')),
  );
  check(
    'demo admission is refused outright',
    /const admitDemo = useCallback\(async \(\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(!demoEntryEnabled\) return;/.test(source('context/AppModeContext.tsx')),
  );
  const layout = source('app/_layout.tsx');
  check(
    'the provider guard reads the switch',
    /providerDemoRedirect\(\{\s*enabled: demoEntryEnabled,/.test(layout),
  );
  check(
    'the provider guard wraps every provider screen',
    /<ProviderDemoGuard>\s*<OfficeAccessGuard>\s*<StaffRestrictionGuard>\s*<RootLayoutNav \/>/.test(layout),
  );
}

console.log('demo switch: the switch reaches both bundles');
{
  const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> };
  check('the dev bundle compiles THINNR_DEMO in', pkg.scripts.dev.includes('EXPO_PUBLIC_THINNR_DEMO=$THINNR_DEMO'));
  check(
    'the published bundle compiles THINNR_DEMO in',
    /EXPO_PUBLIC_THINNR_DEMO: process\.env\.THINNR_DEMO \?\? ''/.test(source('scripts/build.js')),
  );
  check(
    'the published bundle is a production bundle (unset fails closed)',
    /'--no-dev'/.test(source('scripts/build.js')) && /searchParams\.set\('dev', 'false'\)/.test(source('scripts/build.js')),
  );
}

console.log('demo switch: the listing describes the real app');
{
  const toml = source('.replit-artifact/artifact.toml');
  const description = /^description = "(.*)"$/m.exec(toml)?.[1] ?? '';
  check('the listing has a description', description.length > 0);
  check('the listing never calls the app a demo', !/demo/i.test(description));
  check('the listing never calls the data synthetic', !/synthetic/i.test(description));
}

if (failures > 0) {
  console.error(`\n${failures} demo-switch check(s) failed`);
  process.exit(1);
}
console.log('\nall demo-switch checks passed');
