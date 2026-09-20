import * as React from 'react';
import assert from 'node:assert/strict';
import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { BillingModeSettingsView } from '../src/components/billing/BillingModeSettings';
import type { BillingModeStatus } from '../src/lib/billing-types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => { throw new Error('Synthetic mode tests must not use the network'); };
const ready = { configured: true, missing: [], errors: [] };
const status: BillingModeStatus = { mode: 'test', version: 7, configuration: { test: ready, live: ready } };
const changes: Array<[string, number]> = [];
let tree: ReactTestRenderer;
const render = async (value = status, canManage = true) => {
  await act(async () => {
    tree = create(<BillingModeSettingsView status={value} canManage={canManage} busy={false}
      onSwitch={(mode, version) => changes.push([mode, version])} />);
  });
};
const button = (text: string) => tree.root.findAllByType('button').find((node) => node.children.join('') === text)!;
await render();
assert.match(JSON.stringify(tree!.toJSON()), /Test mode — no real charges/);
await act(async () => button('Switch to Live').props.onClick());
assert.equal(button('Confirm Live').props.disabled, true);
await act(async () => tree.root.findByType('input').props.onChange({ target: { value: 'live' } }));
assert.equal(button('Confirm Live').props.disabled, true);
await act(async () => tree.root.findByType('input').props.onChange({ target: { value: 'LIVE' } }));
assert.equal(button('Confirm Live').props.disabled, false);
await act(async () => button('Confirm Live').props.onClick());
assert.deepEqual(changes, [['live', 7]]);
await act(async () => tree.unmount());
await render({ ...status, configuration: { test: ready, live: { configured: false, missing: ['STRIPE_LIVE_SECRET_KEY'] } } });
assert.equal(button('Switch to Live').props.disabled, true);
assert.match(JSON.stringify(tree!.toJSON()), /STRIPE_LIVE_SECRET_KEY/);
await act(async () => tree.unmount());
await render(status, false);
assert.equal(tree!.root.findAllByType('button').length, 0);
await act(async () => tree.unmount());
await render({ ...status, mode: 'live' });
assert.match(JSON.stringify(tree!.toJSON()), /Live mode — real money/);
await act(async () => button('Switch to Test').props.onClick());
assert.equal(tree!.root.findAllByType('input').length, 0);
await act(async () => button('Confirm Test').props.onClick());
assert.deepEqual(changes[1], ['test', 7]);
await act(async () => tree.unmount());
console.log('Billing mode UI: confirmation, permissions, readiness, version and return-to-Test checks passed.');
await render({ ...status, version: null, selection_loaded: false, setup: {
  ready: false, missing: ['BILLING_DEPLOYMENT_ID'], message: 'Set BILLING_DEPLOYMENT_ID and apply the billing mode database migration.',
} });
assert.equal(button('Switch to Live').props.disabled, true);
assert.match(JSON.stringify(tree!.toJSON()), /payment setup incomplete/);
assert.match(JSON.stringify(tree!.toJSON()), /No saved mode is being assumed/);
assert.match(JSON.stringify(tree!.toJSON()), /BILLING_DEPLOYMENT_ID/);
await act(async () => tree.unmount());
console.log('Unconfigured deployment UI: explicit unknown selection and blocked switch passed.');