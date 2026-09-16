/**
 * Focused Node regression/timing harness for CoachChatContext readiness.
 *
 * Run (no package script is intentionally added):
 *   pnpm --filter @workspace/thinnr-mobile exec tsx --tsconfig tsconfig.coach-readiness.json scripts/verify-coach-readiness.tsx
 *
 * Pre-change baseline, recorded against the former uncached select/refresh
 * implementation with this same held-request protocol:
 *   cold select: 1 fetch; warm reselect: +1 fetch; focus refresh: +1 fetch.
 * Every operation completed only when its held API request was released.
 * Those counts are recorded here rather than invented as a performance
 * percentage. The assertions below print the post-change counts and actual
 * controlled-delay elapsed time on every run.
 */
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import {
  CoachChatProvider,
  COACH_CONVERSATION_CACHE_TTL_MS,
  useCoachChat,
  type CoachChatContextValue,
} from '../context/CoachChatContext';
import {
  PatientAccountContext,
  type CoachConversation,
  type PatientAccountState,
  type CoachConversationSnapshot,
  type PatientDataApi,
} from '../context/PatientAccountContext';

process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Availability is deliberately outside the measured persistence transport.
let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
(globalThis as Record<string, unknown>).fetch = async url => {
  if (String(url).includes('/coach/chat')) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    return { ok: true, status: 200, body } as Response;
  }
  return { ok: true, status: 200, json: async () => ({ available: true }) } as Response;
};

let checks = 0;
let failures = 0;
function check(label: string, condition: boolean) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${label}`);
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function row(id: string): CoachConversation {
  return {
    id,
    title: `Conversation ${id}`,
    titleState: 'ready',
    archivedAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    version: 1,
    processingState: 'ready',
  };
}
function snapshot(id: string, text: string): CoachConversationSnapshot {
  return {
    conversation: row(id),
    messages: [{ id: `${id}-message`, role: 'assistant', text, createdAt: '2025-01-01T00:00:00.000Z' }],
    patient: { firstName: 'Taylor', programDay: 1 },
    nextBefore: null,
  };
}

let chat!: CoachChatContextValue;
function Probe() {
  chat = useCoachChat();
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

/** Starts a held async context action inside React act without awaiting it. */
async function start<T>(run: () => T): Promise<{ value: T }> {
  let value!: T;
  await act(async () => {
    value = run();
    await Promise.resolve();
  });
  return { value };
}

async function main() {
  const held = new Map<string, ReturnType<typeof deferred<CoachConversationSnapshot>>>();
  const heldPages = new Map<string, ReturnType<typeof deferred<{ conversations: CoachConversation[]; total: number; nextOffset: number | null }>>>();
  let fetchCalls = 0;
  let listCalls = 0;
  let listFailure: Error | null = null;
  let appendHold: ReturnType<typeof deferred<void>> | null = null;
  const appendTexts: string[] = [];
  const renameCalls: Array<{ id: string; title: string; expectedVersion: number }> = [];
  const api = {
    async appendCoachMessages(_id: string, messages: Array<{ text?: string }>) {
      appendTexts.push(...messages.map(message => message.text ?? ''));
      const gate = appendHold;
      appendHold = null;
      if (gate) await gate.promise;
    },
    fetchCoachConversation(id: string) {
      fetchCalls += 1;
      const gate = deferred<CoachConversationSnapshot>();
      held.set(id, gate);
      return gate.promise;
    },
    async renameCoachConversation(id: string, title: string, expectedVersion: number) {
      renameCalls.push({ id, title, expectedVersion });
      return { ...row(id), title, version: expectedVersion + 1 };
    },
    async updateCoachConversation(id: string, archived: boolean, expectedVersion: number) {
      return { ...row(id), archivedAt: archived ? '2025-01-02T00:00:00.000Z' : null, version: expectedVersion + 1 };
    },
    listCoachConversations(archived: boolean, offset = 0) {
      listCalls += 1;
      if (listFailure) return Promise.reject(listFailure);
      const key = `${archived}:${offset}`;
      const gate = deferred<{ conversations: CoachConversation[]; total: number; nextOffset: number | null }>();
      heldPages.set(key, gate);
      return gate.promise;
    },
  } as unknown as PatientDataApi;
  const account: PatientAccountState = {
    resolving: false,
    account: { kind: 'real', patientId: 'patient-a', api },
    accountNotice: null,
    retryResolve: () => {},
    getAccessToken: async () => 'test-token',
  };
  const elementFor = (value: PatientAccountState) => (
    <PatientAccountContext.Provider value={value}>
      <CoachChatProvider><Probe /></CoachChatProvider>
    </PatientAccountContext.Provider>
  );
  let tree!: ReturnType<typeof create>;

  await act(async () => {
    tree = create(elementFor(account));
  });
  await flush();

  // Cold: identity/loading commit before the held transport is released.
  const coldStarted = Date.now();
  const { value: cold } = await start(() => chat.selectConversation('a'));
  check('cold select starts exactly one request', fetchCalls === 1);
  check(
    'cold select exposes pending destination synchronously',
    chat.conversationScopeKey === 'real:patient-a:epoch-0:a' &&
      chat.isConversationLoading &&
      !chat.hasConversationLoaded &&
      chat.messages.length === 0,
  );
  const { value: focusWhileHeld } = await start(() => chat.refreshThread());
  check('destination focus joins the held selection instead of fetching twice', fetchCalls === 1);
  // The delayed gate supplies a repeatable lower bound without pretending a
  // Node scheduler measurement is a production-network benchmark.
  await new Promise<void>(resolve => setTimeout(resolve, 12));
  held.get('a')!.resolve(snapshot('a', 'cached A'));
  await act(async () => { await Promise.all([cold, focusWhileHeld]); });
  const coldElapsed = Date.now() - coldStarted;
  check('cold select cannot complete before delayed API release', coldElapsed >= 10);
  check('cold completion paints the released transcript', chat.messages[0]?.text === 'cached A');

  // Pages have the same epoch cache/coalescing semantics, including
  // independent pagination keys and terminal-vs-retryable invalidation.
  const firstPage = chat.listConversations(false);
  const sameFirstPage = chat.listConversations(false);
  check('same history page coalesces while held', listCalls === 1);
  heldPages.get('false:0')!.resolve({ conversations: [row('history-1')], total: 2, nextOffset: 20 });
  await act(async () => { await Promise.all([firstPage, sameFirstPage]); });
  check('history page is synchronously exposed after load', chat.getCachedConversations(false)?.conversations[0]?.id === 'history-1');
  await chat.listConversations(false);
  check('fresh history page uses TTL cache', listCalls === 1);
  const secondPage = chat.listConversations(false, 20);
  check('pagination has an independent cache key', listCalls === 2);
  heldPages.get('false:20')!.resolve({ conversations: [row('history-2')], total: 2, nextOffset: null });
  await act(async () => { await secondPage; });
  check('cached pagination page is addressable by offset', chat.getCachedConversations(false, 20)?.conversations[0]?.id === 'history-2');
  listFailure = Object.assign(new Error('missing page'), { status: 404 });
  await chat.listConversations(false, 0, true).catch(error => {
    check('not-found history error preserves typed status', (error as { status?: number }).status === 404);
  });
  check('not-found history error evicts stale first page', chat.getCachedConversations(false) === undefined);
  listFailure = null;
  const restoredPage = chat.listConversations(false);
  heldPages.get('false:0')!.resolve({ conversations: [row('history-1')], total: 2, nextOffset: 20 });
  await act(async () => { await restoredPage; });
  listFailure = Object.assign(new Error('temporary'), { status: 503 });
  await chat.listConversations(false, 0, true).catch(error => {
    check('retryable history failure preserves typed status', (error as { status?: number }).status === 503);
  });
  check('retryable history failure retains cached page', chat.getCachedConversations(false)?.conversations[0]?.id === 'history-1');
  listFailure = null;

  // A list read that began before a rename/archive commits must not repaint
  // or re-cache the older row once it lands after the write.
  const lateList = chat.listConversations(false, 0, true);
  await act(async () => {
    await chat.renameConversation({ ...row('history-1'), version: 1 }, 'Taco night');
  });
  await act(async () => {
    await chat.setArchived({ ...row('history-2'), version: 1 }, true);
  });
  heldPages.get('false:0')!.resolve({
    conversations: [row('history-1'), row('history-2')],
    total: 2,
    nextOffset: null,
  });
  await act(async () => { await lateList; });
  const reconciled = chat.getCachedConversations(false)?.conversations ?? [];
  check('late list read keeps the committed rename', reconciled[0]?.id === 'history-1' && reconciled[0]?.title === 'Taco night' && reconciled[0]?.version === 2);
  check('late list read drops a row archived after the read began', !reconciled.some(item => item.id === 'history-2'));
  check('rename sent the cleaned title with the caller version', renameCalls[0]?.title === 'Taco night' && renameCalls[0]?.expectedVersion === 1);

  const afterCold = fetchCalls;
  await act(async () => { await chat.selectConversation('a'); });
  check('warm same-conversation select uses fresh cache', fetchCalls === afterCold);
  await chat.refreshThread();
  check('ordinary focus refresh uses freshness TTL', fetchCalls === afterCold);

  // A forced event refresh keeps the cache visible and coalesces repeated
  // focus events by account epoch + conversation.
  const { value: forced } = await start(() => chat.refreshThread(true));
  const { value: duplicateForced } = await start(() => chat.refreshThread(true));
  check(
    'forced refresh keeps cached transcript and marks refreshing',
    fetchCalls === afterCold + 1 &&
      chat.isConversationRefreshing &&
      !chat.isConversationLoading &&
      chat.messages[0]?.text === 'cached A',
  );
  await start(() => chat.send('Started after refresh began'));
  await flush();
  check('cached conversation remains sendable during refresh', chat.isStreaming);
  held.get('a')!.resolve(snapshot('a', 'refreshed A'));
  await act(async () => { await Promise.all([forced, duplicateForced]); });
  check('forced refresh coalesces duplicate focus requests', fetchCalls === afterCold + 1);
  check('forced refresh replaces cached transcript when released', chat.messages[0]?.text === 'refreshed A');
  check(
    'late refresh cannot erase a newer user turn or take ownership from the stream',
    chat.isStreaming &&
      chat.messages.some(message => message.role === 'user' && message.text === 'Started after refresh began') &&
      chat.messages.some(message => message.role === 'assistant' && message.status !== 'done'),
  );
  await start(() => chat.stop());
  streamController?.close();

  // A focus event is a no-op while the response stream owns the transcript.
  await start(() => chat.send('keep this active'));
  await flush();
  const scopeDuringStream = chat.conversationScopeKey;
  const fetchBeforeActiveFocus = fetchCalls;
  await chat.refreshThread(true);
  check(
    'active stream survives forced focus unchanged',
    chat.isStreaming && chat.conversationScopeKey === scopeDuringStream && fetchCalls === fetchBeforeActiveFocus,
  );
  await start(() => chat.stop());
  streamController?.close();
  const forcedRefreshCalls = fetchCalls - afterCold;

  // A held B followed by a warm return to A cannot paint B late.
  const { value: selectB } = await start(() => chat.selectConversation('b'));
  await act(async () => { await chat.selectConversation('a'); });
  check('A→B→A does not refetch warm A', fetchCalls === afterCold + 2);
  held.get('b')!.resolve(snapshot('b', 'late B'));
  await act(async () => { await selectB; });
  check(
    'late B completion cannot overwrite final A',
    chat.conversationScopeKey === 'real:patient-a:epoch-0:a' && chat.selectedConversation?.id === 'a' &&
      chat.messages[0]?.text === 'refreshed A' &&
      chat.messages.some(message => message.role === 'user' && message.text === 'keep this active'),
  );

  // Account-denied list access revokes every cache/transcript immediately,
  // keeps a cold pending destination for explicit Retry, and held requests
  // from before the boundary cannot refill the maps.
  const { value: lateBeforeDeny } = await start(() => chat.selectConversation('late-revoked'));
  const latePageBeforeDeny = chat.listConversations(true);
  const preDenyHistoryScope = chat.historyScopeKey;
  listFailure = Object.assign(new Error('access revoked'), { status: 403 });
  await act(async () => {
    await chat.listConversations(false, 0, true).catch(error => {
      check('account denial preserves typed status', (error as { status?: number }).status === 403);
    });
  });
  check(
    'account denial clears selected transcript and all cached pages',
    chat.messages.length === 0 &&
      chat.selectedConversation === null &&
      !chat.hasConversationLoaded &&
      chat.getCachedConversations(false) === undefined,
  );
  held.get('late-revoked')!.resolve(snapshot('late-revoked', 'must stay private'));
  heldPages.get('true:0')!.resolve({ conversations: [row('private-page')], total: 1, nextOffset: null });
  await act(async () => {
    const settled = await Promise.allSettled([lateBeforeDeny, latePageBeforeDeny]);
    check(
      'late revoked history read rejects with explicit stale code',
      settled[1]?.status === 'rejected' &&
        (settled[1].reason as { code?: string }).code === 'COACH_READ_STALE',
    );
  });
  check(
    'late transcript and history completion cannot repopulate revoked caches or UI',
    chat.messages.length === 0 && chat.getCachedConversations(true) === undefined &&
      chat.historyScopeKey === preDenyHistoryScope,
  );
  listFailure = null;
  const beforeRetry = fetchCalls;
  const { value: deniedRetry } = await start(() => chat.refreshThread(true));
  check('denied pending destination retries with a real request rather than revoked cache', fetchCalls === beforeRetry + 1);
  held.get('late-revoked')!.resolve(snapshot('late-revoked', 'access restored'));
  await act(async () => { await deniedRetry; });
  check('successful explicit retry restores the selected destination', chat.hasConversationLoaded && chat.messages[0]?.text === 'access restored');

  // Explicit local revoke clears both account-epoch caches and selection. A
  // later account change cannot reuse the former public scope identity.
  const priorHistoryScope = chat.historyScopeKey;
  await start(() => chat.clearLocalState());
  await flush();
  check(
    'clearLocalState advances history scope and purges cache',
    chat.historyScopeKey !== priorHistoryScope &&
      chat.getCachedConversations(false) === undefined &&
      chat.conversationScopeKey?.endsWith(':fresh') === true &&
      chat.hasConversationLoaded,
  );

  // Account replacement and sign-out each advance the public epoch. Returning
  // to A must not revive A's prior route identity or cached history.
  const scopeAfterClear = chat.conversationScopeKey;
  const accountB: PatientAccountState = {
    ...account,
    account: { kind: 'real', patientId: 'patient-b', api },
  };
  await act(async () => { tree.update(elementFor(accountB)); });
  await flush();
  check(
    'A→B resets selection and cannot expose A cache',
    chat.historyScopeKey?.startsWith('real:patient-b:') &&
      chat.conversationScopeKey?.endsWith(':fresh') &&
      chat.getCachedConversations(false) === undefined,
  );
  const signedOut: PatientAccountState = {
    resolving: false,
    account: { kind: 'demo' },
    accountNotice: null,
    retryResolve: () => {},
  };
  await act(async () => { tree.update(elementFor(signedOut)); });
  await flush();
  await act(async () => { tree.update(elementFor(account)); });
  await flush();
  check(
    'sign-out then A return receives a new UI scope epoch',
    chat.historyScopeKey?.startsWith('real:patient-a:') &&
      chat.conversationScopeKey?.endsWith(':fresh') &&
      chat.conversationScopeKey !== scopeAfterClear &&
      chat.getCachedConversations(false) === undefined,
  );

  // A save failure which arrives after clear must not repopulate the next
  // epoch's outbox. Then make another send to actually exercise its drain.
  const { value: writable } = await start(() => chat.selectConversation('outbox'));
  held.get('outbox')!.resolve(snapshot('outbox', 'saved'));
  await act(async () => { await writable; });
  const oldAppend = deferred<void>();
  appendHold = oldAppend;
  await start(() => chat.send('old unsaved row'));
  await flush();
  check('old append is held before local clear', appendTexts.includes('old unsaved row'));
  await start(() => chat.clearLocalState());
  await act(async () => { oldAppend.reject(new Error('late save failure')); });
  streamController?.close();
  await flush();
  check('late append rejection cannot set error on cleared scope', chat.conversationError === null);
  const { value: nextWritable } = await start(() => chat.selectConversation('next-outbox'));
  held.get('next-outbox')!.resolve(snapshot('next-outbox', 'new saved'));
  await act(async () => { await nextWritable; });
  await start(() => chat.send('new account epoch row'));
  await flush();
  check('next drain never resubmits the purged old append', appendTexts.filter(text => text === 'old unsaved row').length === 1 && appendTexts.includes('new account epoch row'));
  await start(() => chat.stop());
  streamController?.close();

  // Pagination denial shares the same revoke boundary and must release its
  // synchronous paging lock so the explicit transcript Retry can run.
  const { value: paged } = await start(() => chat.selectConversation('paged-denial'));
  held.get('paged-denial')!.resolve({ ...snapshot('paged-denial', 'private page'), nextBefore: 9 });
  await act(async () => { await paged; });
  const { value: older } = await start(() => chat.loadOlder());
  await act(async () => {
    held.get('paged-denial')!.reject(Object.assign(new Error('no access'), { status: 403 }));
    await older;
  });
  check('pagination denial clears transcript and exposes shared access error', chat.messages.length === 0 && Boolean(chat.accessDeniedError) && !chat.isLoadingOlder);
  const beforePagedRetry = fetchCalls;
  const { value: pagedRetry } = await start(() => chat.refreshThread(true));
  check('denied pagination releases the lock for explicit retry', fetchCalls === beforePagedRetry + 1);
  held.get('paged-denial')!.resolve(snapshot('paged-denial', 'restored page'));
  await act(async () => { await pagedRetry; });
  check('successful retry restores access and content', chat.accessDeniedError === null && chat.messages[0]?.text === 'restored page');

  // A former owner's denial must not revoke the current account.
  const oldOwnerList = chat.listConversations(true, 20).catch(error => error);
  await act(async () => { tree.update(elementFor(accountB)); });
  await act(async () => { heldPages.get('true:20')!.reject(Object.assign(new Error('old owner denied'), { status: 403 })); });
  const staleDenial = await oldOwnerList;
  check('late old-owner denial is stale, never a revocation of the new owner', staleDenial.code === 'COACH_READ_STALE' && chat.accessDeniedError === null);
  await act(async () => { tree.unmount(); });

  // The harness records measured elapsed time, while the held gate makes its
  // timing assertion repeatable: it can never settle before release.
  console.log(
    `baseline cold/warm/ordinary-focus requests=1/1/1; post=1/0/0; forced-refresh=${forcedRefreshCalls}; ` +
      `cold-held-ms=${coldElapsed}; ttl-ms=${COACH_CONVERSATION_CACHE_TTL_MS}`,
  );
  if (failures) process.exitCode = 1;
  else console.log(`✓ coach readiness check: ${checks} checks passed`);
}

void main();