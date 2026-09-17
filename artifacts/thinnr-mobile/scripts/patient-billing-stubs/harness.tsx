/**
 * Shared harness for the patient billing RTR suites (orders, subscriptions).
 * Renders the real account and patient providers around a screen while the
 * HTTP boundary and browser are scripted. Import order matters: the
 * environment shims at the top run before any app module loads.
 */
process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, String(value)),
  removeItem: (key: string) => void storage.delete(key),
};

export const opened: string[] = [];
export const alerts: string[] = [];
export let confirms = 0;
export let confirmAnswer = true;
export function setConfirmAnswer(value: boolean) { confirmAnswer = value; }
(globalThis as Record<string, unknown>).window = {
  open: (url: string) => { opened.push(url); return {}; },
  alert: (message: string) => { alerts.push(message); },
  confirm: () => { confirms += 1; return confirmAnswer; },
};

import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { PatientAccountProvider } from '../../context/PatientAccountProvider';
import { PatientProvider } from '../../context/PatientContext';

let checks = 0;
let failures = 0;
export function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) { failures += 1; console.error(`  FAIL  ${label}`); }
}
export function section(label: string) { console.log(`\n· ${label}`); }
export function finish() {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

export type Call = { method: string; path: string; auth: string | null; body: Record<string, unknown> | null; idempotencyKey: string | null };
export const calls: Call[] = [];
export type Route = (call: Call, url: URL) => { status?: number; body: unknown } | undefined;
let route: Route = () => undefined;
export function setRoute(next: Route) { route = next; }

const profile = { firstName: 'Pat', lastName: 'Example', email: 'pat@example.com', phone: '+15550001010', dateOfBirth: '1985-04-03', heightInches: 66, startingWeight: 205, currentWeight: 191, goalWeight: 165, timezone: 'America/New_York', programId: 'glp1', programStartDate: '2026-08-20', setupComplete: true };
const patientState = { entries: [], water: {}, targets: {}, favorites: [], recents: [], customFoods: [], catalogFoods: [], savedRecipes: [], photos: [], checkIns: [], medications: [], doseLogs: [], flags: { nudgeOptOut: false, nudgeEngaged: false, nudgeLastSentKey: null, nudgeLastCrossingKey: null, onboardingComplete: true }, entry: { firstName: 'Pat', programStartDate: '2026-08-20', todayKey: '2026-09-07', programDay: 19 }, profile };

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.slice('/api/'.length);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const call: Call = {
    method: (init?.method ?? 'GET').toUpperCase(),
    path,
    auth: headers.Authorization ?? null,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null,
    idempotencyKey: headers['Idempotency-Key'] ?? null,
  };
  calls.push(call);
  let status = 200;
  let body: unknown;
  if (path === 'claim/whoami') body = { kind: 'patient', patientId: 'patient-1' };
  else if (path.startsWith('patient-data/state')) body = patientState;
  else if (path === 'patient-data/profile') body = { profile };
  else {
    const answer = route(call, url);
    if (!answer) throw new Error(`Unscripted request: ${call.method} ${path}`);
    status = answer.status ?? 200;
    body = answer.body;
  }
  return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}) as typeof fetch;

export async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)); });
}
export async function mount(element: React.ReactElement): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<PatientAccountProvider><PatientProvider>{element}</PatientProvider></PatientAccountProvider>);
  });
  await settle();
  return tree;
}
export async function unmount(tree: ReactTestRenderer) { await act(async () => tree.unmount()); }
export function hosts(tree: ReactTestRenderer, id: string) {
  return tree.root.findAllByProps({ testID: id }).filter(node => typeof node.type === 'string');
}
export function has(tree: ReactTestRenderer, id: string) { return hosts(tree, id).length > 0; }
export function text(tree: ReactTestRenderer, id: string): string {
  const flatten = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(flatten).join('');
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (value && typeof value === 'object' && 'children' in value) return flatten((value as { children?: unknown }).children);
    if (value && typeof value === 'object' && 'props' in value) return flatten((value as { props: { children?: unknown } }).props.children);
    return '';
  };
  return hosts(tree, id).map(node => flatten(node.children)).join('');
}
export function allText(tree: ReactTestRenderer): string {
  return text(tree, hosts(tree, 'screen-orders').length ? 'screen-orders' : hosts(tree, 'screen-order').length ? 'screen-order' : hosts(tree, 'screen-subscriptions').length ? 'screen-subscriptions' : 'screen-subscription');
}
export function button(tree: ReactTestRenderer, id: string) {
  return hosts(tree, id).find(candidate => typeof candidate.props.onPress === 'function') ?? null;
}
export function isDisabled(tree: ReactTestRenderer, id: string): boolean {
  const node = button(tree, id);
  if (!node) throw new Error(`Missing button ${id}`);
  return node.props.disabled === true || node.props.accessibilityState?.disabled === true;
}
export async function press(tree: ReactTestRenderer, id: string) {
  const node = button(tree, id);
  if (!node) throw new Error(`Missing button ${id}`);
  await act(async () => node.props.onPress());
  await settle();
}
export async function type(tree: ReactTestRenderer, id: string, value: string) {
  const node = hosts(tree, id).find(candidate => typeof candidate.props.onChangeText === 'function');
  if (!node) throw new Error(`Missing input ${id}`);
  await act(async () => node.props.onChangeText(value));
  await settle(2);
}
export const billingCalls = () => calls.filter(call => call.path.startsWith('patient-data/billing/'));
export const lastBillingCall = () => billingCalls()[billingCalls().length - 1];
