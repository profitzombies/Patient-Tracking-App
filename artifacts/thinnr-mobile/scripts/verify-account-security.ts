process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const localStorageBacking = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => localStorageBacking.get(key) ?? null,
  setItem: (key: string, value: string) => void localStorageBacking.set(key, String(value)),
  removeItem: (key: string) => void localStorageBacking.delete(key),
};

import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { AccountSecurity } from '../components/account/AccountSecurity';
import PatientLoginScreen from '../app/patient-login';
import { AppModeProvider } from '../context/AppModeContext';
import { completeSignup, requestPatientPasswordLogin, verifyLoginCode } from '../lib/auth-api';
import type { SecurityOverview } from '../lib/security-api';
import { routerCalls } from './onboarding-gate-stubs/expo-router';
import { setStubAccessToken, signOutCalls } from './patient-auth-stubs/supabase';

let checks = 0, failures = 0;
const assert = (label: string, ok: boolean) => { checks += 1; if (!ok) { failures += 1; console.error(`  FAIL  ${label}`); } };
const calls: { path: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
let overviewReads = 0;
const overview: SecurityOverview = {
  realm: 'staff', canChangePassword: true, contact: { phone: null, email: 'staff@example.com' }, passwordChangedAt: null, currentSessionKnown: true,
  secondFactor: { policyRequired: false, enabled: false, phone: null, verifiedAt: null },
  signIns: [
    { id: 'current', at: new Date().toISOString(), method: 'password_sms_code', methodLabel: 'Password + texted code', platform: 'ios', device: 'iPhone · THINNR app', region: 'Austin, Texas, US', newDevice: false, current: true, active: true, revokedAt: null, revokedReason: null, reportedAt: null },
    { id: 'other', at: new Date(Date.now() - 86400000).toISOString(), method: 'email_code', methodLabel: 'Emailed code', platform: 'web', device: 'Chrome on Mac', region: null, newDevice: true, current: false, active: true, revokedAt: null, revokedReason: null, reportedAt: null },
  ],
  sessions: [
    { ref: 'session-current', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), platform: 'ios', device: 'iPhone · THINNR app', region: 'Austin, Texas, US', current: true, signInId: 'current' },
    { ref: 'session-other', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), platform: 'web', device: 'Chrome on Mac', region: null, current: false, signInId: 'other' },
  ],
};

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.slice('/api/'.length);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
  calls.push({ path, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body });
  let status = 200, response: Record<string, unknown>;
  if (path === 'security/me') { overviewReads += 1; response = overview; }
  else if (path === 'security/me/password/start') {
    if (body.currentPassword === 'wrong') { status = 401; response = { error: 'Current password is incorrect.', field: 'currentPassword' }; }
    else response = { ok: true, requestId: 'change-1', channel: 'sms', destination: '•••-1010' };
  } else if (path === 'security/me/password/complete') {
    if (body.newPassword === 'weak') { status = 400; response = { error: 'Use at least 8 characters with a letter and number.', field: 'newPassword' }; }
    else if (body.code === '000000') { status = 400; response = { error: 'That code is incorrect or expired.', field: 'code' }; }
    else response = { ok: true, othersSignedOut: true };
  } else if (path === 'security/me/second-factor/phone/start') {
    response = { ok: true, requestId: 'factor-1', destination: '•••-•••-3434', devCode: '343434' };
  } else if (path === 'security/me/second-factor/phone/complete') {
    response = {
      ok: true,
      secondFactor: {
        policyRequired: false,
        enabled: true,
        phone: '•••-•••-3434',
        verifiedAt: new Date().toISOString(),
      },
    };
  } else if (path === 'security/me/second-factor') {
    response = { ok: true, secondFactor: { ...overview.secondFactor, enabled: body.enabled } };
  } else if (path === 'security/me/sign-out-others') response = { ok: true };
  else if (path === 'security/me/sign-ins/other/report') response = { ok: true, signedOut: true, forcedReset: true };
  else if (path === 'auth/patient/password/login' && body.password === 'forced') { status = 403; response = { error: 'Reset your password before signing in.', code: 'PASSWORD_RESET_REQUIRED' }; }
  else if (path === 'auth/patient/password/login') response = { ok: true, requestId: 'login-1', message: null, devCode: null };
  else if (path === 'auth/login/verify') response = { ok: true, realm: 'patient', tokenHash: 'hash', signInId: 'signin' };
  else if (path === 'auth/signup/complete') response = { ok: true, tokenHash: 'hash', signInId: 'signup-signin' };
  else throw new Error(`Unscripted ${path}`);
  return { ok: status < 300, status, json: async () => response } as Response;
}) as typeof fetch;

async function settle() { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(r => setTimeout(r, 1)); }); }
async function mount(node: React.ReactElement) { let tree!: ReactTestRenderer; await act(async () => { tree = create(node); }); await settle(); return tree; }
const hosts = (t: ReactTestRenderer, id: string) => t.root.findAllByProps({ testID: id }).filter(n => typeof n.type === 'string');
const has = (t: ReactTestRenderer, id: string) => hosts(t, id).length > 0;
const collectText = (node: unknown): string => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  const el = node as { props?: { children?: unknown } };
  return el.props ? collectText(el.props.children) : '';
};
const text = (t: ReactTestRenderer, id: string) => hosts(t, id).map(n => collectText(n.props.children)).join('');
const disabled = (t: ReactTestRenderer, id: string) => t.root.findAllByProps({ testID: id }).map(n => n.props.disabled).find(v => typeof v === 'boolean');
async function press(t: ReactTestRenderer, id: string) { const n = hosts(t, id).find(x => typeof x.props.onPress === 'function'); if (!n) throw new Error(`missing ${id}`); await act(async () => { n.props.onPress(); }); await settle(); }
async function type(t: ReactTestRenderer, id: string, value: string) { const n = hosts(t, id).find(x => typeof x.props.onChangeText === 'function'); if (!n) throw new Error(`missing ${id}`); await act(async () => { n.props.onChangeText(value); }); }

async function main() {
  setStubAccessToken('security-token');
  let tree = await mount(React.createElement(AccountSecurity));
  assert('live overview and sections render', has(tree, 'account-security') && has(tree, 'security-signin-0') && has(tree, 'security-session-0'));
  assert('staff sign-in phone section renders with optional switch', has(tree, 'security-second-factor') && has(tree, 'security-second-factor-switch'));
  await type(tree, 'security-second-factor-phone', '8135553434');
  await press(tree, 'security-second-factor-start');
  assert('phone enrollment posts normalized phone', calls.some(c => c.path === 'security/me/second-factor/phone/start' && c.body.phone === '+18135553434'));
  await press(tree, 'security-second-factor-complete');
  assert('phone enrollment posts request and code', calls.some(c => c.path === 'security/me/second-factor/phone/complete' && c.body.requestId === 'factor-1' && c.body.code === '343434'));
  assert('verified phone is rendered', text(tree, 'security-second-factor').includes('•••-•••-3434'));
  await type(tree, 'security-current-password', 'wrong'); await press(tree, 'security-password-start');
  assert('wrong current password is inline', text(tree, 'security-current-password-error').includes('incorrect'));
  await type(tree, 'security-current-password', 'correct'); await press(tree, 'security-password-start');
  await type(tree, 'security-new-password', 'weak'); await type(tree, 'security-password-code', '123456'); await press(tree, 'security-password-complete');
  assert('weak password is inline', text(tree, 'security-new-password-error').includes('8 characters'));
  await type(tree, 'security-new-password', 'Strongpass1'); await type(tree, 'security-password-code', '000000'); await press(tree, 'security-password-complete');
  assert('code mismatch is inline', text(tree, 'security-password-code-error').includes('incorrect'));
  await type(tree, 'security-password-code', '123456'); await press(tree, 'security-password-complete');
  assert('password success and refresh', has(tree, 'security-password-success') && overviewReads >= 2);
  const beforeSignout = overviewReads; await press(tree, 'security-signout-others'); await press(tree, 'security-signout-others-confirm');
  assert('sign out others calls endpoint and refreshes', calls.some(c => c.path === 'security/me/sign-out-others') && overviewReads > beforeSignout);
  await press(tree, 'security-report-other'); await press(tree, 'security-report-confirm-other');
  assert('report clears local session and routes to login', calls.some(c => c.path === 'security/me/sign-ins/other/report') && signOutCalls.length === 1 && routerCalls.some(c => c.method === 'replace' && c.target.includes('patient-login')));
  tree.unmount();

  overview.secondFactor = {
    policyRequired: true,
    enabled: true,
    phone: '•••-•••-9999',
    verifiedAt: new Date().toISOString(),
  };
  setStubAccessToken('security-token');
  tree = await mount(React.createElement(AccountSecurity));
  const requiredCopy = tree.root.findAll(node =>
    node.type === 'Text' && node.children.join('').includes('Required for your role')
  );
  assert('required staff factor hides switch', has(tree, 'security-second-factor') && !has(tree, 'security-second-factor-switch') && requiredCopy.length > 0);
  tree.unmount();

  tree = await mount(React.createElement(AppModeProvider, null, React.createElement(PatientLoginScreen)));
  await type(tree, 'login-phone', '5552221212'); await type(tree, 'login-password', 'forced'); await press(tree, 'login-submit');
  assert('forced reset shows server text and routes into recovery', text(tree, 'login-error').includes('Reset your password') && has(tree, 'recovery-start'));
  tree.unmount();

  await requestPatientPasswordLogin({ identifier: 'a@example.com', password: 'ok' });
  await verifyLoginCode({ requestId: 'x', code: '123456' });
  await completeSignup({ signupToken: 'x', password: 'Strongpass1', firstName: 'Casey', lastName: 'Patient' });
  const deviceCalls = calls.filter(c => ['auth/patient/password/login', 'auth/login/verify', 'auth/signup/complete'].includes(c.path));
  assert('auth calls send stable device and platform headers', deviceCalls.length >= 3 && deviceCalls.every(c => /^inst-[a-f0-9]{24}$/.test(c.headers['x-thinnr-device']) && c.headers['x-thinnr-platform'] === 'web') && new Set(deviceCalls.map(c => c.headers['x-thinnr-device'])).size === 1);
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}
main().catch(error => { console.error(error); process.exit(1); });