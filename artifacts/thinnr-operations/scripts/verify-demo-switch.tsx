/**
 * The guided-demo switch, OFF — what a signed-out visitor of the published
 * operations app can reach.
 *
 * Run with tsconfig.demo-switch.json, which maps '@/lib/demo-entry' to a stub
 * pinning demo entry off (the real resolver is re-exported) and
 * '@/lib/supabase' to a signed-out stand-in, so the REAL SessionProvider,
 * sign-in screen and auth frames render here in Node. The demo-on behaviour
 * stays covered by the existing suites, which run with the switch on.
 */
import * as React from 'react';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setConfigured } from './demo-switch-stubs/supabase';
import { demoEntryEnabled, resolveDemoEntry } from '@/lib/demo-entry';
import { SessionProvider, useSession, type Persona } from '@/contexts/session';
import SignIn from '@/pages/SignIn';
import { BootScreen, ProfileErrorScreen } from '@/pages/AuthScreens';
import { officeLensViewers } from '@/lib/training-lens';
import type { TrainingViewer } from '@/data/hq/training';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── Minimal browser globals the session provider and sign-in screen touch ──
class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) { return this.items.has(key) ? this.items.get(key)! : null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}
const sessionStorage = new MemoryStorage();
const localStorage = new MemoryStorage();
(globalThis as any).window = {
  sessionStorage,
  localStorage,
  location: { pathname: '/', search: '', hash: '', href: 'http://localhost/', origin: 'http://localhost' },
  addEventListener() {},
  removeEventListener() {},
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
};
(globalThis as any).document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
};

let failures = 0;
const check = (name: string, condition: boolean) => condition
  ? console.log(`  ok  ${name}`)
  : (failures += 1, console.error(`  FAIL ${name}`));
const text = (node: ReactTestInstance): string => node.children
  .map((child) => typeof child === 'string' ? child : text(child as ReactTestInstance))
  .join('');
const settle = async () => {
  for (let count = 0; count < 6; count += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3)); });
  }
};
const hasTestId = (root: ReactTestInstance, id: string) =>
  root.findAll((node) => typeof node.type === 'string' && node.props['data-testid'] === id).length > 0;
const unmount = async (view: ReactTestRenderer) => {
  await act(async () => { view.unmount(); });
};
async function render(element: React.ReactElement, path = '/'): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <Router hook={memoryLocation({ path }).hook}>
        <SessionProvider>{element}</SessionProvider>
      </Router>,
    );
  });
  await settle();
  return renderer;
}

const PERSONA_KEY = 'thinnr-ops-persona';
const DEMO_ENTRY_TEST_IDS = ['button-explore-demo', 'button-signin-admin', 'button-signin-office'];

console.log('demo switch: the rule');
{
  check('suite runs with demo entry pinned off', demoEntryEnabled === false);
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
      `${JSON.stringify(raw ?? null)} in a ${productionBuild ? 'production' : 'development'} build → ${expected ? 'on' : 'off'}`,
      resolveDemoEntry(raw, productionBuild) === expected,
    );
  }
}

console.log('demo switch: a remembered persona is cleared, never restored');
{
  type Captured = { persona: Persona | null; authStatus: string; signIn: (next: Persona) => void };
  let captured: Captured | null = null;
  function Probe() {
    const value = useSession();
    captured = { persona: value.persona, authStatus: value.authStatus, signIn: value.signIn };
    return null;
  }
  for (const remembered of ['hq-admin', 'office', 'leftover']) {
    sessionStorage.setItem(PERSONA_KEY, remembered);
    const view = await render(<Probe />);
    check(`remembered "${remembered}" opens no persona`, captured!.persona === null);
    check(`remembered "${remembered}" is removed from the browser`, sessionStorage.getItem(PERSONA_KEY) === null);
    check(`remembered "${remembered}" leaves the visitor signed out`, captured!.authStatus === 'signed-out');
    await unmount(view);
  }
  const view = await render(<Probe />);
  await act(async () => { captured!.signIn('hq-admin'); });
  await settle();
  check('choosing the HQ persona does nothing', captured!.persona === null && sessionStorage.getItem(PERSONA_KEY) === null);
  await act(async () => { captured!.signIn('office'); });
  await settle();
  check('choosing the office persona does nothing', captured!.persona === null && sessionStorage.getItem(PERSONA_KEY) === null);
  await unmount(view);
}

console.log('demo switch: the sign-in screen offers sign-in only');
{
  const view = await render(<SignIn />, '/');
  const screen = text(view.root);
  check('the work-email form is there and usable', hasTestId(view.root, 'input-auth-email')
    && view.root.findByProps({ 'data-testid': 'input-auth-email' }).props.disabled === false);
  for (const id of DEMO_ENTRY_TEST_IDS) check(`no ${id}`, !hasTestId(view.root, id));
  check('no mention of the demo', !/demo/i.test(screen));
  check('no synthetic-data label', !/synthetic/i.test(screen));
  check('footer keeps the advice notice', screen.includes('Not Medical Advice'));
  await unmount(view);
}
{
  __setConfigured(false);
  const view = await render(<SignIn />);
  const screen = text(view.root);
  check('unconfigured sign-in says it is unavailable', screen.includes('Sign-in isn’t available right now. Please try again later.'));
  check('unconfigured sign-in never points at the demo', !/demo/i.test(screen));
  await unmount(view);
  __setConfigured(true);
}

console.log('demo switch: auth frames carry no demo labels');
{
  for (const [name, element] of [['boot screen', <BootScreen />], ['profile error', <ProfileErrorScreen />]] as const) {
    const view = await render(element);
    const screen = text(view.root);
    check(`${name}: no mention of the demo`, !/demo/i.test(screen));
    check(`${name}: no synthetic-data label`, !/synthetic/i.test(screen));
    check(`${name}: advice notice stays`, screen.includes('Not Medical Advice'));
    await unmount(view);
  }
}

console.log('demo switch: the HQ area admits nobody signed out');
{
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  check(
    'the signed-out Super Admin role only exists with demo entry on',
    /authStatus === 'signed-out' && demoEntryEnabled \? 'Super Admin' : hqRole/.test(app),
  );
  check('the signed-out router falls through to sign-in', /<Route component=\{SignIn\} \/>/.test(app));
}

console.log('demo switch: signed-in office lenses never fall back to the seeded network');
{
  const viewer = (id: string, accountId: string | null): TrainingViewer => ({
    id,
    name: id,
    email: `${id}@example.com`,
    phone: '',
    accountId,
    staffOfViewerId: null,
    location: '',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    sessions: 1,
  });
  const network = [viewer('v1', 'acct-a'), viewer('v2', 'acct-b'), viewer('v3', null)];
  const ids = (list: TrainingViewer[]) => list.map((item) => item.id).join(',');
  check('signed-out demo lens sees the seeded network', ids(officeLensViewers(network, { signedIn: false, accountId: null, selfViewerId: null })) === 'v1,v2,v3');
  check('signed-in office lens is left to the office filter', ids(officeLensViewers(network, { signedIn: true, accountId: 'acct-a', selfViewerId: 'v1' })) === 'v1,v2,v3');
  check('signed-in without an office sees only themself', ids(officeLensViewers(network, { signedIn: true, accountId: null, selfViewerId: 'v2' })) === 'v2');
  check('signed-in without an office or learner row sees nobody', officeLensViewers(network, { signedIn: true, accountId: null, selfViewerId: null }).length === 0);
}

if (failures > 0) {
  console.error(`\n${failures} demo-switch check(s) failed`);
  process.exit(1);
}
console.log('\nall demo-switch checks passed');
process.exit(0);
