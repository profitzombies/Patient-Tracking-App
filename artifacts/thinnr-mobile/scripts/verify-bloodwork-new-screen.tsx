import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import NewBloodwork from '../app/bloodwork/new';
import {
  clearAllRetainedBloodworkDrafts,
  clearBloodworkRecoveryRoute,
  getBloodworkRecoveryRoute,
  readRetainedBloodworkDraft,
  retainBloodworkDraft,
} from '../lib/bloodwork-recovery';
import { Pressable } from 'react-native';
import { state as account, resetAccount } from './bloodwork-new-screen-stubs/account-context';
import { state as patient, resetPatient } from './bloodwork-new-screen-stubs/patient-context';
import { resetSupabase } from './bloodwork-new-screen-stubs/supabase';
import { prepareCalls, resetMedia } from './bloodwork-new-screen-stubs/media';
import { resetApi, state as api } from './bloodwork-new-screen-stubs/api-client';
import { resetQueryClient, state as queryClient } from './bloodwork-new-screen-stubs/query-client';
import { routeEvents } from './bloodwork-new-screen-stubs/router';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function textOf(node: TestRenderer.ReactTestInstance): string {
  return node.children.filter(child => typeof child === 'string').join('');
}

async function pressWithTextAndWait(renderer: TestRenderer.ReactTestRenderer, text: string): Promise<void> {
  const pressable = renderer.root.findAllByType(Pressable).find(node =>
    node.findAllByType('Text').some(child => textOf(child) === text),
  );
  assert(pressable, `mounted NewBloodwork has action "${text}"`);
  await act(async () => {
    pressable.props.onPress();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(NewBloodwork));
  });
  return renderer;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function choosePdf(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await pressWithTextAndWait(renderer, 'Choose PDF (up to 20MB)');
  assert.equal(renderer.root.findAllByType('Text').some(node => textOf(node) === 'report.pdf'), true);
}

function resetAll(): void {
  resetAccount();
  resetPatient();
  resetSupabase();
  resetMedia();
  resetApi();
  resetQueryClient();
  routeEvents.length = 0;
  clearBloodworkRecoveryRoute();
}

async function main(): Promise<void> {
  resetAll();
  await clearAllRetainedBloodworkDrafts();

  // Cancellation before create resolves must settle the mounted screen even
  // when no staged report exists. This is the regression that previously
  // left the Save screen permanently busy.
  api.createBehaviors = [{ kind: 'deferred' }];
  const cancelBeforeCreate = await mount();
  await choosePdf(cancelBeforeCreate);
  await pressWithTextAndWait(cancelBeforeCreate, 'Save & Process');
  assert.equal(cancelBeforeCreate.root.findAllByType(Pressable).some(node =>
    node.findAllByType('Text').some(child => textOf(child) === 'Cancel upload'),
  ), true);
  await pressWithTextAndWait(cancelBeforeCreate, 'Cancel upload');
  await flush();
  assert.equal(cancelBeforeCreate.root.findAllByType(Pressable).some(node =>
    node.findAllByType('Text').some(child => textOf(child) === 'Cancel upload'),
  ), false, 'cancel-before-create settles busy state');
  assert.equal(cancelBeforeCreate.root.findAllByType('Text').some(node => textOf(node) === 'Save & Process'), true);
  await act(async () => cancelBeforeCreate.unmount());

  // Upload bytes stop at 90% while the commit is held. The final 10% is
  // reserved for the server transition to a committed/queued report.
  resetAll();
  await clearAllRetainedBloodworkDrafts();
  api.createBehaviors = [{ kind: 'upload' }];
  api.commitDeferred = true;
  const heldCommit = await mount();
  await act(async () => {
    heldCommit.root.findByProps({ placeholder: 'e.g. Annual Bloodwork 2026' }).props.onChangeText('Annual checkup');
  });
  await choosePdf(heldCommit);
  assert.equal(
    heldCommit.root.findByProps({ placeholder: 'e.g. Annual Bloodwork 2026' }).props.value,
    'Annual checkup',
    'choosing a source preserves an already entered report title',
  );
  await pressWithTextAndWait(heldCommit, 'Save & Process');
  const progressBar = heldCommit.root.findByProps({ accessibilityRole: 'progressbar' });
  assert.deepEqual(progressBar.props.accessibilityValue, { min: 0, max: 100, now: 90 }, 'upload progress reserves the final save segment');
  assert.equal(
    heldCommit.root.findAllByType('Text').some(node => textOf(node) === 'Saving report... 90%'),
    true,
    'saving label never claims 100% before commit succeeds',
  );
  assert.equal(
    heldCommit.root.findAllByType('Text').some(node => textOf(node) === 'Upload received'),
    true,
    'receipt is shown only after every source object is uploaded',
  );
  assert(api.commitResolve);
  await act(async () => api.commitResolve?.());
  await flush();
  assert.equal(routeEvents.at(-1)?.href, '/bloodwork/report-upload', 'commit completion reaches the queued report');
  assert.equal(
    queryClient.invalidated.some(entry => (
      entry.queryKey[0] === '/api/bloodwork/patients/patient-a/reports'
      && entry.queryKey[1] === 'user-a'
      && entry.queryKey[2] === 'retained-pages'
    )),
    true,
    'successful upload invalidates the scoped history query before returning to the report',
  );
  await act(async () => heldCommit.unmount());

  // A replayed commit (the idempotent retry path) invalidates the same
  // patient-scoped history prefix, so returning to the list cannot show the
  // pre-upload empty cache.
  resetAll();
  await clearAllRetainedBloodworkDrafts();
  api.createBehaviors = [{ kind: 'replay' }];
  const replay = await mount();
  await choosePdf(replay);
  await pressWithTextAndWait(replay, 'Save & Process');
  await flush();
  assert.equal(routeEvents.at(-1)?.href, '/bloodwork/report-replay');
  assert.equal(queryClient.invalidated.length, 1, 'replayed commit also invalidates history');
  await act(async () => replay.unmount());

  // A stale/disabled media action cannot become a newer generation while the
  // save owns the UI. The mounted camera path is exercised here rather than
  // only checking the helper guard.
  resetAll();
  await clearAllRetainedBloodworkDrafts();
  retainBloodworkDraft({
    accountKey: 'user-a:patient-a',
    files: [{
      clientFileId: 'image-a',
      uri: 'file:///image.jpg',
      mimeType: 'image/jpeg',
      size: 100,
      fileName: 'image.jpg',
      appOwned: false,
    }],
    title: 'Image report',
    reportDate: '',
    request: { fingerprint: 'image-report', id: 'image-request' },
  });
  api.createBehaviors = [{ kind: 'deferred' }];
  const interleave = await mount();
  const staleCameraAction = interleave.root.findAllByType(Pressable).find(node =>
    node.findAllByType('Feather').some(icon => icon.props.name === 'camera'),
  );
  assert(staleCameraAction);
  await pressWithTextAndWait(interleave, 'Save & Process');
  const cameraAction = interleave.root.findAllByType(Pressable).find(node =>
    node.findAllByType('Feather').some(icon => icon.props.name === 'camera'),
  );
  assert(cameraAction);
  assert.equal(cameraAction.props.disabled, true, 'camera mutation is disabled while save owns busy state');
  // Invoke the handler as a defensive check too; disabled UI is not the only
  // protection against synthetic/native late events.
  await act(async () => {
    staleCameraAction.props.onPress();
    await Promise.resolve();
  });
  const mountedCapture = interleave.root.findAllByType(Pressable).find(node => node.props.testID === 'mounted-camera-capture');
  if (mountedCapture) await pressWithTextAndWait(interleave, 'Capture');
  assert.deepEqual(prepareCalls, [], 'old save blocks a newer camera preparation');
  await pressWithTextAndWait(interleave, 'Cancel upload');
  await flush();
  assert(readRetainedBloodworkDraft('user-a:patient-a')?.files[0].clientFileId === 'image-a');
  await act(async () => interleave.unmount());

  // A recoverable first failure retains the exact request key. Cancelling its
  // same-draft retry keeps that key and private files available for another
  // mounted retry rather than disposing them.
  resetAll();
  await clearAllRetainedBloodworkDrafts();
  api.createBehaviors = [
    { kind: 'reject', error: { status: 503, data: { code: 'ACCOUNT_LOOKUP_UNAVAILABLE' } } },
    { kind: 'deferred' },
  ];
  const retainedRetry = await mount();
  await choosePdf(retainedRetry);
  await pressWithTextAndWait(retainedRetry, 'Save & Process');
  const retained = readRetainedBloodworkDraft('user-a:patient-a');
  assert(retained);
  assert.equal(retained.files.length, 1);
  assert.equal(retainedRetry.root.findAllByType('Text').some(node => textOf(node) === 'Try again'), true);
  const requestId = retained.request.id;
  await pressWithTextAndWait(retainedRetry, 'Try again');
  await pressWithTextAndWait(retainedRetry, 'Cancel upload');
  await flush();
  assert.equal(api.createCalls.length, 2);
  assert.equal(api.createCalls[0].clientRequestId, requestId);
  assert.equal(api.createCalls[1].clientRequestId, requestId, 'same-draft retry reuses idempotency key');
  assert(readRetainedBloodworkDraft('user-a:patient-a'), 'cancelled retained retry keeps its draft');
  assert.equal(retainedRetry.root.findAllByType('Text').some(node => textOf(node) === 'Save & Process'), true);
  await act(async () => retainedRetry.unmount());

  // Mounted identity transitions never promote P1's owner to an unresolved
  // key or to P2. A->unresolved->A keeps the original bound draft; P2 clears.
  resetAll();
  await clearAllRetainedBloodworkDrafts();
  api.createBehaviors = [{ kind: 'reject', error: { status: 503, data: { code: 'ACCOUNT_LOOKUP_UNAVAILABLE' } } }];
  const identity = await mount();
  await choosePdf(identity);
  await pressWithTextAndWait(identity, 'Save & Process');
  assert(readRetainedBloodworkDraft('user-a:patient-a'));
  account.account = { kind: 'unresolved' };
  await act(async () => identity.update(React.createElement(NewBloodwork)));
  assert(readRetainedBloodworkDraft('user-a:patient-a'));
  account.account = { kind: 'real', patientId: 'patient-a' };
  await act(async () => identity.update(React.createElement(NewBloodwork)));
  assert(readRetainedBloodworkDraft('user-a:patient-a'));
  account.account = { kind: 'real', patientId: 'patient-b' };
  await act(async () => identity.update(React.createElement(NewBloodwork)));
  assert.equal(readRetainedBloodworkDraft('user-a:patient-a'), null, 'identity switch disposes P1 draft');
  assert.equal(readRetainedBloodworkDraft('user-a:patient-b'), null, 'identity switch never transfers draft to P2');
  await act(async () => identity.unmount());

  // The mounted entry/save boundary offers consent before setup when both
  // are missing, and its route intent is account-scoped for the root guard.
  resetAll();
  await clearAllRetainedBloodworkDrafts();
  patient.consentSatisfied = false;
  patient.onboardingComplete = false;
  const consent = await mount();
  await choosePdf(consent);
  await pressWithTextAndWait(consent, 'Save & Process');
  assert.equal(consent.root.findAllByType('Text').some(node => textOf(node) === 'Review consent'), true);
  await pressWithTextAndWait(consent, 'Review consent');
  assert.equal(getBloodworkRecoveryRoute('user-a:patient-a'), '/consent');
  assert.equal(getBloodworkRecoveryRoute('user-b:patient-b'), null, 'route intent is scoped to original account');
  assert.equal(routeEvents.at(-1)?.href, '/consent');
  await act(async () => consent.unmount());
  clearBloodworkRecoveryRoute();

  resetAll();
  await clearAllRetainedBloodworkDrafts();
  patient.consentSatisfied = true;
  patient.onboardingComplete = false;
  const setup = await mount();
  await choosePdf(setup);
  await pressWithTextAndWait(setup, 'Save & Process');
  assert.equal(setup.root.findAllByType('Text').some(node => textOf(node) === 'Finish setup'), true);
  await pressWithTextAndWait(setup, 'Finish setup');
  assert.equal(getBloodworkRecoveryRoute('user-a:patient-a'), '/onboarding/welcome');
  assert.equal(routeEvents.at(-1)?.href, '/onboarding/welcome');
  await act(async () => setup.unmount());

  console.log('mounted NewBloodwork checks passed: cancel-before-create, retained retry cancellation/idempotency, P1 identity transitions, and scoped consent/setup actions');
}

void main();