process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, String(value)),
  removeItem: (key: string) => void storage.delete(key),
};

import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import ClaimTestScreen from '../app/claim-test';
import ClaimAccountScreen from '../app/claim-account';
import { failures as cleanupFailures, localClearCalls, resetLocalClearCalls } from './claim-test-stubs/contexts';
import { failures as signOutFailures, resetSignOutCalls, signOutCalls, TEST_ACCESS_TOKEN } from './claim-test-stubs/supabase';
import { clearRouterCalls, routerCalls } from './onboarding-gate-stubs/expo-router';
import { clearClaimTestHandoff, getClaimTestHandoff } from '../lib/claim-test-handoff';

let checks = 0;
function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) throw new Error(`FAIL: ${label}`);
}
function hosts(tree: ReactTestRenderer, testID: string) {
  return tree.root.findAllByProps({ testID }).filter(node => typeof node.type === 'string');
}
async function press(tree: ReactTestRenderer, testID: string) {
  const node = hosts(tree, testID).find(item => typeof item.props.onPress === 'function');
  if (!node) throw new Error(`missing ${testID}`);
  await act(async () => { await node.props.onPress(); });
}
function text(tree: ReactTestRenderer) {
  const values: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') values.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(tree.toJSON());
  return values.join(' ');
}

const calls: Array<{ method: string; auth: string | null; body: unknown }> = [];
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  calls.push({
    method: init?.method ?? 'GET',
    auth: new Headers(init?.headers).get('Authorization'),
    body: init?.body ? JSON.parse(String(init.body)) : null,
  });
  if (init?.method === 'POST') {
    return {
      status: 200,
      json: async () => ({
        prepared: true,
        scenario: 'recover_email',
        identifier: 'e•••@example.com',
        mode: 'reset',
      }),
    };
  }
  return {
    status: 200,
    json: async () => ({
      patient: { name: 'Designated Patient', emailMasked: 'e•••@example.com', phoneMasked: '•••1234' },
      state: { claimed: true, hasPhone: true, hasEmail: true },
    }),
  };
}) as typeof fetch;

async function main() {
  clearRouterCalls();
  resetLocalClearCalls();
  resetSignOutCalls();
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(React.createElement(ClaimTestScreen)); });

  assert('authenticated state request', calls[0]?.method === 'GET' && calls[0]?.auth === `Bearer ${TEST_ACCESS_TOKEN}`);
  assert('shows current state', text(tree).includes('Designated Patient') && text(tree).includes('Claimed'));
  for (const scenario of ['claim_phone', 'recover_phone', 'claim_email', 'recover_email']) {
    assert(`shows ${scenario}`, hosts(tree, `claim-test-${scenario}`).length > 0);
  }
  await press(tree, 'claim-test-recover_email');
  assert(
    'shows explicit confirmation',
    hosts(tree, 'claim-test-confirmation').length > 0 &&
      text(tree).includes('phone will be removed from claim matching') &&
      text(tree).includes('login stays attached'),
  );
  await press(tree, 'claim-test-prepare');
  assert('POST carries exact scenario and auth', calls[1]?.auth === `Bearer ${TEST_ACCESS_TOKEN}` && (calls[1]?.body as { scenario?: string })?.scenario === 'recover_email');
  assert('patient and chat clear, operations untouched', localClearCalls.patient === 1 && localClearCalls.coach === 1);
  assert('signs out and routes', signOutCalls === 1 && routerCalls.some(call => call.method === 'replace' && call.target === '/claim-account'));
  tree.unmount();

  await act(async () => { tree = create(React.createElement(ClaimAccountScreen)); });
  assert(
    'handoff shown with exact path',
    hosts(tree, 'claim-test-handoff').length > 0 &&
      text(tree).includes('Password recovery by email'),
  );
  const input = hosts(tree, 'claim-identifier').find(node => 'value' in node.props);
  assert('identifier prefilled', input?.props.value === 'e•••@example.com');
  await press(tree, 'claim-test-handoff-dismiss');
  assert('handoff dismisses once', hosts(tree, 'claim-test-handoff').length === 0);
  tree.unmount();

  // The server has already committed its reset when all of these device-only
  // operations fail. Navigation and the in-memory handoff must still win.
  await clearClaimTestHandoff();
  clearRouterCalls();
  resetLocalClearCalls();
  resetSignOutCalls();
  cleanupFailures.patient = true;
  cleanupFailures.coach = true;
  cleanupFailures.mode = true;
  signOutFailures.globalReturnsError = true;
  signOutFailures.local = true;
  const originalSetItem = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('storage full'); };
  await act(async () => { tree = create(React.createElement(ClaimTestScreen)); });
  await press(tree, 'claim-test-recover_email');
  await press(tree, 'claim-test-prepare');
  const memory = await getClaimTestHandoff();
  assert('cleanup failures still navigate', routerCalls.some(call => call.method === 'replace' && call.target === '/claim-account'));
  assert('memory handoff survives persistence failure', memory?.identifier === 'e•••@example.com' && memory.cleanupWarning === true);
  assert('global failure attempts local signout', signOutCalls === 2);
  assert('post-commit shows no pre-commit failure message', !text(tree).includes('Couldn’t prepare the claim test'));
  globalThis.localStorage.setItem = originalSetItem;
  tree.unmount();
  console.log(`✓ private claim test: ${checks} checks passed`);
}

void main();