import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { useIdleTimeout } from '../src/hooks/useIdleTimeout';
import { IdleTimeoutDialog } from '../src/components/layout/IdleTimeoutDialog';
import { __setSession } from './a11y-stubs/session';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let failures = 0;
const check = (name: string, ok: boolean) => {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
};
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => typeof child === 'string' ? child : text(child as ReactTestInstance)).join('');

let now = 1_000_000;
let timerId = 0;
const timers = new Map<number, { at: number; callback: () => void; interval: number | null }>();

Date.now = () => now;
(globalThis as any).setTimeout = (callback: () => void, delay = 0) => {
  const id = ++timerId;
  timers.set(id, { at: now + Number(delay), callback, interval: null });
  return id;
};
(globalThis as any).clearTimeout = (id: number) => timers.delete(id);
(globalThis as any).setInterval = (callback: () => void, delay = 0) => {
  const id = ++timerId;
  timers.set(id, { at: now + Number(delay), callback, interval: Number(delay) });
  return id;
};
(globalThis as any).clearInterval = (id: number) => timers.delete(id);

async function advance(ms: number) {
  const target = now + ms;
  await act(async () => {
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.interval === null) timers.delete(id);
      else timer.at += timer.interval;
      timer.callback();
    }
    now = target;
  });
}

class BrowserTarget extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  sessionStorage = new MapStorage();
}

class MapStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
}

const browserWindow = new BrowserTarget() as BrowserTarget & typeof globalThis;
const browserDocument = new BrowserTarget() as BrowserTarget & Document;
(globalThis as any).window = browserWindow;
(globalThis as any).document = browserDocument;

class FakeBroadcastChannel {
  static channels = new Set<FakeBroadcastChannel>();
  onmessage: ((event: MessageEvent<any>) => void) | null = null;
  constructor(public name: string) {
    FakeBroadcastChannel.channels.add(this);
  }
  postMessage(data: unknown) {
    for (const channel of FakeBroadcastChannel.channels) {
      if (channel !== this && channel.name === this.name) {
        channel.onmessage?.({ data } as MessageEvent);
      }
    }
  }
  close() {
    FakeBroadcastChannel.channels.delete(this);
  }
}
(globalThis as any).BroadcastChannel = FakeBroadcastChannel;

interface HarnessValue {
  idleState: 'active' | 'warning';
  secondsLeft: number;
  dismissIdleWarning: () => void;
}

let current: HarnessValue | null = null;
function Harness({
  enabled = true,
  signOut,
}: {
  enabled?: boolean;
  signOut: () => void;
}) {
  current = useIdleTimeout({ enabled, idleTimeoutMinutes: 5, signOut });
  return <span>{current.idleState}:{current.secondsLeft}</span>;
}

async function renderHarness(enabled = true) {
  let signOutCalls = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness enabled={enabled} signOut={() => { signOutCalls++; }} />);
  });
  return { renderer, signOutCalls: () => signOutCalls };
}

console.log('idle timeout');

let harness = await renderHarness();
await advance(4 * 60 * 1_000);
check('warning appears at timeout minus 60 seconds', current?.idleState === 'warning' && current.secondsLeft === 60);

await advance(10_000);
await act(async () => {
  browserWindow.dispatchEvent(new Event('pointerdown'));
});
check('activity during warning dismisses it', current?.idleState === 'active');
await advance(4 * 60 * 1_000 - 1);
check('activity resets the full warning deadline', current?.idleState === 'active');
harness.renderer.unmount();

browserWindow.sessionStorage.clear();
timers.clear();
harness = await renderHarness();
await advance(5 * 60 * 1_000);
check('expiry signs out exactly once', harness.signOutCalls() === 1);
check(
  'expiry stores the inactivity sign-out reason',
  browserWindow.sessionStorage.getItem('thinnr-ops-signout-reason') === 'inactivity',
);
await advance(10_000);
check('expired timer does not sign out twice', harness.signOutCalls() === 1);
harness.renderer.unmount();

timers.clear();
harness = await renderHarness();
await advance(3 * 60 * 1_000);
const otherTab = new FakeBroadcastChannel('thinnr-ops-idle');
otherTab.postMessage({ type: 'activity', at: Date.now() });
await advance(60_001);
check('cross-tab activity resets this tab deadline', current?.idleState === 'active');
otherTab.close();
harness.renderer.unmount();

timers.clear();
let inactive = await renderHarness(false);
await advance(10 * 60 * 1_000);
check('patient session starts no idle timer', inactive.signOutCalls() === 0 && current?.idleState === 'active');
inactive.renderer.unmount();
inactive = await renderHarness(false);
await advance(10 * 60 * 1_000);
check('demo session starts no idle timer', inactive.signOutCalls() === 0 && timers.size === 0);
inactive.renderer.unmount();

__setSession({
  idleState: 'warning',
  secondsLeft: 30,
  dismissIdleWarning() {},
  signOut() {},
});
let dialog!: ReactTestRenderer;
await act(async () => {
  dialog = create(<IdleTimeoutDialog />);
});
check(
  'dialog renders countdown text',
  text(dialog.root).includes('You’ll be signed out for security in 30 seconds.'),
);
check(
  'dialog renders both actions',
  dialog.root.findAll((node) => node.type === 'button' && node.props['data-testid'] === 'button-idle-stay').length >= 1 &&
    dialog.root.findAll((node) => node.type === 'button' && node.props['data-testid'] === 'button-idle-sign-out').length >= 1,
);
dialog.unmount();

console.log(failures ? `\n${failures} idle timeout check(s) failed.` : '\nAll idle timeout checks passed.');
process.exit(failures ? 1 : 0);