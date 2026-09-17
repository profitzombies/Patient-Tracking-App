/**
 * Shared harness for the Payments area suites (scripts/verify-payments-*.tsx,
 * run with tsconfig.payments.json). Renders REAL screens under
 * react-test-renderer with:
 *   - a scripted Supabase session (setStubSession) to pick demo vs live,
 *   - a scripted global fetch that records every request (URL, method,
 *     bearer, headers, JSON body) so suites can assert each write's shape,
 *   - a fresh QueryClient per mount (no retries, so failures surface fast).
 */
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OperationsProvider } from '../../context/OperationsContext';
import { PaymentsRangeProvider } from '../../components/payments/range';
import { setStubSession, type StubSession } from '../leaderboard-stubs/supabase';
import { routerLog } from '../provider-training-stubs/expo-router';
import { setBillingRetryBaseMs } from '../../hooks/useOfficeBilling';

setBillingRetryBaseMs(1);

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Platform.OS is 'web' under the stub, so OperationsContext persists to localStorage.
const memory = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value); },
  removeItem: (key: string) => { memory.delete(key); },
};

export let failures = 0;
export function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
export function section(title: string) { console.log(`\n${title}`); }
export function finish(suite: string): never {
  if (failures > 0) { console.error(`\n${suite}: ${failures} failure(s)`); process.exit(1); }
  console.log(`\n${suite}: all checks passed`);
  process.exit(0);
}

export const settle = async (ticks = 8) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

export function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') { parts.push(node); return; }
    node.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(instance);
  return parts.join('');
}
export const all = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props.testID === id && typeof node.type === 'string');
export const one = (root: ReactTestInstance, id: string): ReactTestInstance | undefined => all(root, id)[0];
export const ids = (root: ReactTestInstance, prefix: string): string[] => root
  .findAll((node) => typeof node.type === 'string' && typeof node.props.testID === 'string' && node.props.testID.startsWith(prefix))
  .map((node) => node.props.testID as string);
export const text = (root: ReactTestInstance, id: string): string => { const node = one(root, id); return node ? textOf(node) : ''; };

/** Tap without awaiting the handler (a press whose handler holds a fetch must not block the suite). */
export const press = async (root: ReactTestInstance, id: string) => {
  const node = one(root, id);
  if (!node) throw new Error(`no testID=${id}`);
  const props = node.props as { onPress?: () => unknown; 'aria-disabled'?: boolean; accessibilityState?: { disabled?: boolean } };
  await act(async () => { void props.onPress?.(); });
  await settle();
};
export const isBlocked = (root: ReactTestInstance, id: string): boolean => {
  const node = one(root, id);
  if (!node) throw new Error(`no testID=${id}`);
  return node.props['aria-disabled'] === true || node.props.accessibilityState?.disabled === true;
};
export const type = async (root: ReactTestInstance, id: string, value: string) => {
  const node = one(root, id);
  if (!node) throw new Error(`no testID=${id}`);
  await act(async () => { node.props.onChangeText?.(value); });
  await settle(2);
};

// ---------------------------------------------------------------- fetch script

export interface Recorded { url: string; path: string; method: string; auth: string | undefined; headers: Record<string, string>; body: unknown }
export type Script = { status: number; body: unknown } | { delay: true; status?: number; body?: unknown } | 'network-error';
export const requests: Recorded[] = [];
export let release: (() => void) | null = null;
let handler: (req: Recorded, url: URL) => Script | undefined = () => undefined;

export function setScript(next: (req: Recorded, url: URL) => Script | undefined) { handler = next; }
export function resetRequests() { requests.length = 0; }
export const writes = () => requests.filter((r) => r.method !== 'GET');
export const paths = () => requests.map((r) => `${r.method} ${r.path}${r.url.includes('?') ? `?${r.url.split('?')[1]}` : ''}`);

(globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
  let body: unknown = undefined;
  if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  const record: Recorded = { url: href, path: url.pathname, method: (init?.method ?? 'GET').toUpperCase(), auth: headers.Authorization, headers, body };
  requests.push(record);
  const next = handler(record, url);
  if (next === undefined) throw new Error(`unexpected fetch ${record.method} ${href}`);
  if (next === 'network-error') throw new TypeError('fetch failed');
  if ('delay' in next) {
    await new Promise<void>((resolve) => { release = resolve; });
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
};

// ---------------------------------------------------------------- mounting

export const STAFF: StubSession = { access_token: 'staff-token', user: { id: 'staff-user-1' } };

export async function mount(element: React.ReactElement, session: StubSession | null): Promise<{ renderer: ReactTestRenderer; root: ReactTestInstance; unmount: () => Promise<void> }> {
  setStubSession(session);
  routerLog.length = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <OperationsProvider><PaymentsRangeProvider>{element}</PaymentsRangeProvider></OperationsProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  const r = renderer!;
  return { renderer: r, root: r.root, unmount: async () => { await act(async () => { r.unmount(); }); } };
}

export { routerLog, setStubSession };
