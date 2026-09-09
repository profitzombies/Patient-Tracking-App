import React, { act } from 'react';
import TestRenderer, { type ReactTestInstance } from 'react-test-renderer';
import CareTeamChatScreen from '../app/care-team-chat';
import {
  CareTeamChatProvider,
  type CareTeamConversation,
  useCareTeamChat,
  type CareTeamState,
} from '../context/CareTeamChatContext';
import { PatientAccountContext, type PatientAccountState } from '../context/PatientAccountContext';
import { useCareTeamUnreadCount } from '../context/CareTeamUnreadContext';
import { apiCalls, apiScripts, resetApi } from './care-team-stubs/api-client';
import { setStubSession } from './live-diary-stubs/supabase';
import { emitChatSync } from '../lib/chat-sync-events';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
let checks = 0;
let failures = 0;
let finished = false;

function assert(label: string, condition: boolean): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${label}`);
  }
}

function equal(label: string, actual: unknown, expected: unknown): void {
  assert(`${label}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, actual === expected);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const current: CareTeamConversation = {
  id: 'thread-current', providerId: 'office-a', businessName: 'North Clinic',
  current: true, canSend: true, status: 'open', unreadCount: 2,
  lastMessageSeq: 202, lastReadSeq: 200, createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};
const retained: CareTeamConversation = {
  ...current, id: 'thread-old', providerId: 'office-old', businessName: 'Previous Clinic',
  current: false, canSend: false, unreadCount: 0, lastMessageSeq: 1, lastReadSeq: 1,
};
const message = (seq: number, clientId = `server-${seq}`, text = `message ${seq}`) => ({
  seq, clientId, sender: seq % 2 ? 'care_team' as const : 'patient' as const,
  text, createdAt: '2026-01-02T12:00:00.000Z',
});
const account = (patientId: string): PatientAccountState => ({
  resolving: false,
  account: { kind: 'real', patientId, api: {} as never },
  accountNotice: null,
  retryResolve: () => {},
});

let chat: CareTeamState | null = null;
let unreadCount = 0;
function Probe() {
  chat = useCareTeamChat();
  unreadCount = useCareTeamUnreadCount();
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

async function mount(value: PatientAccountState, child: React.ReactNode = h(Probe)) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      h(PatientAccountContext.Provider, { value },
        h(CareTeamChatProvider, null, child)),
    );
  });
  return renderer;
}

function host(root: ReactTestInstance, testID: string): ReactTestInstance {
  return root.findAll(node => node.props.testID === testID && typeof node.type === 'string')[0];
}

async function main() {
  console.log('Care team context and screen');
  resetApi();
  setStubSession({ access_token: 'token-a', user: { id: 'auth-a' } });
  const stale = deferred<unknown>();
  apiScripts.status = [stale.promise, { current, retained: [retained] }];
  apiScripts.messages = [{ conversation: current, messages: [message(202)], nextBefore: 102 }];
  const renderer = await mount(account('patient-a'));
  equal('first account begins status request', apiCalls[0]?.name, 'status');

  await act(async () => {
    renderer.update(
      h(PatientAccountContext.Provider, { value: account('patient-b') },
        h(CareTeamChatProvider, null, h(Probe))),
    );
  });
  await flush();
  stale.resolve({ current: { ...current, id: 'stale-a' }, retained: [] });
  await flush();
  equal('late old-account status never replaces new account thread', chat?.currentConversation?.id, current.id);
  equal('account switch clears pending and draft', Object.keys(chat?.pendingMessages ?? {}).length, 0);

  const messageCall = apiCalls.find(call => call.name === 'messages');
  equal('session bearer is captured into generated message request',
    (messageCall?.args[2] as { headers?: { Authorization?: string } })?.headers?.Authorization,
    'Bearer token-a');
  equal('initial page retains server cursor', chat?.hasOlder, true);

  apiScripts.messages = [{
    conversation: current,
    messages: [message(101), message(102)],
  }];
  await act(async () => { await chat?.loadOlder(); });
  equal('older history merges without replacing newest page', chat?.messages.map(item => item.seq).join(','), '101,102,202');
  equal('older request uses before cursor',
    (apiCalls.filter(call => call.name === 'messages').at(-1)?.args[1] as { before?: number }).before, 102);

  // A focus refresh establishes a newest-page watermark and older cursor.
  apiScripts.status = [{ current, retained: [retained] }];
  apiScripts.messages = [{ conversation: current, messages: [message(202)], nextBefore: 102, nextAfter: null }];
  await act(async () => { chat?.setScreenFocused(true); });
  await flush();

  // The send acknowledgement is deliberately newer than staff messages that
  // arrive while it is in flight. Polling must start at the fetched watermark,
  // not the acknowledgement seq, and a poll confirmation clears the pending.
  const delayedAck = deferred<unknown>();
  apiScripts.send = [delayedAck.promise];
  act(() => { chat?.sendMessage('Interleaved help'); });
  await flush();
  const interleavedSend = apiCalls.filter(call => call.name === 'send').at(-1);
  const interleavedId = (interleavedSend?.args[1] as { clientId: string }).clientId;
  apiScripts.messages = [{
    conversation: current,
    messages: [
      { ...message(203), sender: 'care_team' },
      { ...message(204), sender: 'care_team' },
      { ...message(205, interleavedId, 'Interleaved help'), sender: 'patient' },
    ],
    nextBefore: null,
    nextAfter: null,
  }];
  await act(async () => { emitChatSync('care_team'); });
  await flush();
  equal('poll after send uses contiguous fetched watermark',
    (apiCalls.filter(call => call.name === 'messages').at(-1)?.args[1] as { after?: number }).after, 202);
  equal('poll recovers every intervening message', chat?.messages.slice(-3).map(item => item.seq).join(','), '203,204,205');
  assert('poll confirmation removes pending bubble', !chat?.pendingMessages[interleavedId]);
  equal('incremental tick preserves older-page cursor', chat?.hasOlder, true);
  delayedAck.resolve({
    message: { ...message(205, interleavedId, 'Interleaved help'), sender: 'patient' },
    created: true,
  });
  await flush();
  equal('late acknowledgement remains de-duplicated', chat?.messages.filter(item => item.clientId === interleavedId).length, 1);

  apiScripts.send = [new Error('Connection lost after delivery')];
  await act(async () => { chat?.sendMessage('Need help'); });
  await flush();
  const failedId = Object.keys(chat?.pendingMessages ?? {})[0];
  assert('failed delivery remains visibly pending', !!failedId && chat?.pendingMessages[failedId]?.status === 'failed');
  apiScripts.send = [{
    message: { ...message(206, failedId, 'Need help'), sender: 'patient' },
    created: false,
  }];
  await act(async () => { chat?.retryMessage(failedId); });
  await flush();
  const sends = apiCalls.filter(call => call.name === 'send');
  equal('retry reuses stable client id', (sends.at(-2)?.args[1] as { clientId: string }).clientId,
    (sends.at(-1)?.args[1] as { clientId: string }).clientId);
  equal('idempotent retry de-duplicates delivered message', chat?.messages.filter(item => item.clientId === failedId).length, 1);

  const delayedNewest = deferred<unknown>();
  apiScripts.status = [{ current, retained: [retained] }];
  apiScripts.messages = [delayedNewest.promise];
  act(() => { chat?.setScreenFocused(true); });
  await flush();
  const ackDuringRefresh = deferred<unknown>();
  apiScripts.send = [ackDuringRefresh.promise];
  act(() => { chat?.sendMessage('Ack during refresh'); });
  await flush();
  const ackClientId = (apiCalls.filter(call => call.name === 'send').at(-1)?.args[1] as { clientId: string }).clientId;
  ackDuringRefresh.resolve({
    message: { ...message(207, ackClientId, 'Ack during refresh'), sender: 'patient' },
    created: true,
  });
  await flush();
  delayedNewest.resolve({
    conversation: current,
    messages: [message(202)],
    nextBefore: null,
    nextAfter: null,
  });
  await flush();
  assert('delayed newest refresh preserves acknowledged send',
    chat?.messages.some(item => item.clientId === ackClientId) === true);
  assert('delayed newest refresh preserves already-loaded older history',
    chat?.messages.some(item => item.seq === 101) === true);
  equal('boundary-less newest refresh preserves older cursor', chat?.hasOlder, true);

  apiScripts.messages = [{ conversation: retained, messages: [message(1)], nextBefore: undefined }];
  await act(async () => { chat?.selectConversation(retained); });
  await flush();
  equal('previous office can be selected', chat?.selectedConversation?.id, retained.id);
  equal('previous office stays read only', chat?.selectedConversation?.canSend, false);

  await act(async () => { renderer.unmount(); });

  // A failed send remains immutably bound to its original office thread. If
  // bootstrap later makes that thread retained, retry must never post to the
  // replacement office conversation.
  resetApi();
  const officeB: CareTeamConversation = {
    ...current,
    id: 'thread-office-b',
    providerId: 'office-b',
    businessName: 'South Clinic',
  };
  const retiredA: CareTeamConversation = {
    ...current,
    current: false,
    canSend: false,
  };
  apiScripts.status = [
    { current, retained: [] },
    { current: officeB, retained: [retiredA] },
  ];
  apiScripts.messages = [
    { conversation: current, messages: [message(202)], nextBefore: null },
    { conversation: retiredA, messages: [message(202)], nextBefore: null },
  ];
  apiScripts.send = [new Error('Office A delivery failed')];
  const retryBindingRenderer = await mount(account('patient-b'));
  await flush();
  await act(async () => { chat?.sendMessage('Private body for office A'); });
  await flush();
  const officeAFailedId = Object.keys(chat?.pendingMessages ?? {})[0];
  const sendsBeforeOfficeChange = apiCalls.filter(call => call.name === 'send').length;
  await act(async () => { await chat?.refresh(); });
  equal('office change republishes failed thread as retained and read only',
    chat?.selectedConversation?.canSend, false);
  await act(async () => { chat?.retryMessage(officeAFailedId); });
  await flush();
  equal('retry from retained office never posts to replacement office',
    apiCalls.filter(call => call.name === 'send').length, sendsBeforeOfficeChange);
  assert('every attempted send stays addressed to original office conversation',
    apiCalls.filter(call => call.name === 'send').every(call => call.args[0] === current.id));
  equal('failed retry body remains attached to original retained thread',
    chat?.pendingMessages[officeAFailedId]?.text, 'Private body for office A');
  equal('failed retry keeps immutable original conversation id',
    chat?.pendingMessages[officeAFailedId]?.threadId, current.id);
  assert('rejected cross-office retry reports a clear local error',
    chat?.error?.includes('previous care team conversation') === true);
  await act(async () => { retryBindingRenderer.unmount(); });

  // Conversation sequence values are global/sparse and include patient sends;
  // only the server-provided unread count is authoritative.
  resetApi();
  const sparseUnread = {
    ...current,
    unreadCount: 1,
    lastMessageSeq: 1001,
    lastReadSeq: 200,
  };
  apiScripts.status = [{ current: sparseUnread, retained: [] }];
  apiScripts.messages = [{
    conversation: sparseUnread,
    messages: [message(1001)],
    nextBefore: null,
  }];
  const unreadRenderer = await mount(account('patient-b'));
  await flush();
  equal('authoritative server unread count ignores sparse global sequence gap', unreadCount, 1);
  await act(async () => { unreadRenderer.unmount(); });

  resetApi();
  apiScripts.status = [{ current: null, retained: [retained] }];
  apiScripts.start = [new Error('Current office messaging is forbidden')];
  apiScripts.messages = [{ conversation: retained, messages: [message(1)], nextBefore: null, nextAfter: null }];
  const retainedRenderer = await mount(account('patient-b'));
  await flush();
  equal('retained history remains selected when current-office start is forbidden',
    chat?.selectedConversation?.id, retained.id);
  assert('current-office start error remains visible with retained history',
    chat?.error?.includes('forbidden') === true);
  equal('retained history loaded despite current-office start failure', chat?.messages[0]?.seq, 1);
  await act(async () => { retainedRenderer.unmount(); });

  resetApi();
  apiScripts.status = [{ current, retained: [retained] }, { current, retained: [retained] }];
  apiScripts.messages = [
    { conversation: current, messages: [message(201)], nextBefore: undefined },
    { conversation: current, messages: [message(201)], nextBefore: undefined },
  ];
  const screenRenderer = await mount(account('patient-b'), h(CareTeamChatScreen));
  await flush();
  assert('screen mounts retained-history selector', !!host(screenRenderer.root, 'care-team-thread-thread-old'));
  assert('screen exposes unread business chat without AI labeling',
    screenRenderer.root.findAll(node => typeof node.type === 'string' &&
      node.children.join('').includes('FROM YOUR CARE TEAM')).length > 0);
  await act(async () => { host(screenRenderer.root, 'care-team-thread-thread-old').props.onPress(); });
  await flush();
  assert('screen explains retained selection is read only', !!host(screenRenderer.root, 'care-team-retained-notice'));
  equal('retained composer is not editable', host(screenRenderer.root, 'care-team-composer').props.editable, false);
  await act(async () => { screenRenderer.unmount(); });

  finished = true;
  if (failures) {
    console.error(`✗ care team chat: ${failures} failure(s) across ${checks} checks`);
    process.exit(1);
  }
  console.log(`✓ care team chat: ${checks} checks passed`);
  process.exit(0);
}

process.on('beforeExit', () => {
  if (!finished) {
    console.error('✗ care team chat exited before completing');
    process.exitCode = 1;
  }
});
void main().catch(error => {
  console.error(error);
  process.exit(1);
});