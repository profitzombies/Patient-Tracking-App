import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { bloodworkRecoveryEntryDecision } from '../lib/bloodwork-entry-policy';
import type { LiveEntryGateInput } from '../lib/live-patient-entry';
import {
  bloodworkEntryRecovery,
  classifyBloodworkError,
  clearAllRetainedBloodworkDrafts,
  clearBloodworkRecoveryRoute,
  getBloodworkRecoveryRoute,
  readRetainedBloodworkDraft,
  retainBloodworkDraft,
  setBloodworkRecoveryRoute,
  useBloodworkRecoveryRoute,
  type RetainedBloodworkDraft,
} from '../lib/bloodwork-recovery';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function RecoveryGate({ input, accountKey }: { input: LiveEntryGateInput; accountKey: string }) {
  const route = useBloodworkRecoveryRoute(accountKey);
  const decision = bloodworkRecoveryEntryDecision(input, route);
  return React.createElement('gate', { decision: JSON.stringify(decision) });
}

const file = {
  clientFileId: '00000000-0000-4000-8000-000000000001',
  uri: 'file:///private/report.pdf',
  mimeType: 'application/pdf',
  size: 120,
  fileName: 'report.pdf',
  appOwned: false,
} as const;

const draft = (accountKey: string): RetainedBloodworkDraft => ({
  accountKey,
  files: [file],
  title: 'Annual labs',
  reportDate: '2026-01-02',
  request: { fingerprint: 'same-draft', id: 'request-once' },
});

async function main(): Promise<void> {
  await clearAllRetainedBloodworkDrafts();

  // A server recovery code offers a useful action and never surfaces the raw
  // generated client's "HTTP 403 ..." text.
  const setup = classifyBloodworkError({
    status: 403,
    data: {
      error: 'setup details are intentionally not copied into UI',
      code: 'PATIENT_SETUP_REQUIRED',
      recovery: 'setup',
    },
  });
  assert.equal(setup.action, 'setup');
  assert.equal(setup.actionLabel, 'Finish setup');
  assert.doesNotMatch(setup.message, /HTTP|corrupt|PDF/i);

  const consent = classifyBloodworkError({
    status: 403,
    data: { error: 'consent', code: 'CONSENT_REQUIRED', recovery: 'consent' },
  });
  assert.equal(consent.action, 'consent');
  const signIn = classifyBloodworkError({
    status: 401,
    data: { error: 'session', code: 'SESSION_REQUIRED', recovery: 'sign_in' },
  });
  assert.equal(signIn.action, 'sign_in');
  const retry = classifyBloodworkError({
    status: 503,
    data: { error: 'outage', code: 'ACCOUNT_LOOKUP_UNAVAILABLE', recovery: 'retry' },
  });
  assert.equal(retry.action, 'retry');

  const oversized = classifyBloodworkError({
    status: 413,
    data: { error: 'server document detail', code: 'FILE_TOO_LARGE' },
  });
  assert.equal(oversized.action, 'none');
  assert.match(oversized.message, /20 MB/);
  assert.doesNotMatch(oversized.message, /server document detail|HTTP/i);
  const corrupt = classifyBloodworkError({
    status: 422,
    data: { error: 'parser stack detail', code: 'CORRUPT_FILE' },
  });
  assert.equal(corrupt.action, 'none');
  assert.match(corrupt.message, /valid PDF or image/i);

  // Wrong-patient/no-access is neutral and has no offered action. It is not
  // misreported as a bad PDF and does not transfer a draft to another key.
  const denied = classifyBloodworkError({
    status: 404,
    data: { error: 'Patient record not found.' },
  });
  assert.equal(denied.neutral, true);
  assert.equal(denied.action, 'none');
  assert.doesNotMatch(denied.message, /HTTP|corrupt|PDF/i);

  const accountA = 'user-a:patient-a';
  const accountB = 'user-b:patient-b';
  retainBloodworkDraft(draft(accountA));
  const first = readRetainedBloodworkDraft(accountA);
  assert(first, 'same-account recovery retains the selected draft');
  assert.equal(first?.request.id, 'request-once');
  assert.equal(first?.title, 'Annual labs');
  assert.equal(first?.reportDate, '2026-01-02');
  assert.equal(readRetainedBloodworkDraft(accountB), null, 'a different identity cannot read the draft');

  // Re-offering recovery for the same manifest reuses the staged idempotency
  // key, so simultaneous/same-draft retries cannot create duplicates.
  retainBloodworkDraft(draft(accountA));
  assert.equal(readRetainedBloodworkDraft(accountA)?.request.id, 'request-once');
  await clearAllRetainedBloodworkDrafts();
  assert.equal(readRetainedBloodworkDraft(accountA), null, 'identity/sign-out cleanup removes retained draft');

  const setupEntry = bloodworkEntryRecovery({
    accountKind: 'real',
    accountResolving: false,
    patientHydrated: true,
    onboardingComplete: false,
    consentSatisfied: true,
  });
  assert.equal(setupEntry?.action, 'setup');
  const consentEntry = bloodworkEntryRecovery({
    accountKind: 'real',
    accountResolving: false,
    patientHydrated: true,
    onboardingComplete: true,
    consentSatisfied: false,
  });
  assert.equal(consentEntry?.action, 'consent');

  // Global entry redirection must honor an explicitly offered recovery route
  // long enough for the rehydration/consent screen to run.
  setBloodworkRecoveryRoute('/consent', 'user-a:patient-a');
  assert.equal(getBloodworkRecoveryRoute('user-a:patient-a'), '/consent');
  assert.equal(getBloodworkRecoveryRoute('user-b:patient-b'), null);
  clearBloodworkRecoveryRoute('/consent', 'user-a:patient-a');
  assert.equal(getBloodworkRecoveryRoute('user-a:patient-a'), null);

  const input: LiveEntryGateInput = {
    modeHydrated: true,
    mode: 'patient',
    accountResolving: false,
    accountKind: 'real',
    patientHydrated: true,
    onboardingComplete: true,
    consentSatisfied: true,
    deletionPending: false,
    pathname: '/onboarding/welcome',
  };
  let gate!: ReturnType<typeof create>;
  const render = (next: LiveEntryGateInput, accountKey = accountA) =>
    React.createElement(RecoveryGate, { input: next, accountKey });
  await act(async () => { gate = create(render(input)); });
  const decision = () => JSON.parse(gate.root.findByType('gate').props.decision);
  assert.deepEqual(decision(), { kind: 'redirect', href: '/today' });
  await act(async () => { setBloodworkRecoveryRoute('/onboarding/welcome', accountA); });
  assert.deepEqual(decision(), { kind: 'allow' }, 'recovery intent rerenders the mounted gate');
  await act(async () => { gate.update(render({ ...input, consentSatisfied: false })); });
  assert.deepEqual(decision(), { kind: 'redirect', href: '/consent' }, 'setup never outranks consent loss');
  await act(async () => { gate.update(render({ ...input, deletionPending: true })); });
  assert.deepEqual(decision(), { kind: 'redirect', href: '/consent' }, 'setup never outranks deletion');
  await act(async () => { gate.update(render({ ...input, patientHydrated: false })); });
  assert.deepEqual(decision(), { kind: 'hold' }, 'recovery cannot bypass hydration');
  await act(async () => { gate.update(render({ ...input, accountResolving: true })); });
  assert.deepEqual(decision(), { kind: 'hold' }, 'recovery cannot bypass identity resolution');
  await act(async () => { gate.update(render(input, accountB)); });
  assert.deepEqual(decision(), { kind: 'redirect', href: '/today' }, 'intent cannot transfer accounts');
  await act(async () => {
    gate.update(render({ ...input, pathname: '/consent' }));
    setBloodworkRecoveryRoute('/consent', accountA);
  });
  assert.deepEqual(decision(), { kind: 'allow' });
  await act(async () => { clearBloodworkRecoveryRoute('/consent', accountA); });
  assert.deepEqual(decision(), { kind: 'redirect', href: '/today' }, 'intent clearing is reactive too');
  await act(async () => { gate.unmount(); });

  console.log('bloodwork recovery checks passed: code actions, draft identity, and mounted reactive consent/deletion/hydration precedence');
}

void main();
